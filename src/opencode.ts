import type { ApiKeyEntry, Env } from './types'

export const OPENCODE_PROVIDER_ID = 'opencode'

const OPENCODE_VERSION = '1.17.8'
// POST 连接/首字节超时：思考模型首字节前可能长时间无输出，放宽到 90s。
// 连接建立后（流式）不再受整体超时限制，改由 withSSEKeepAlive 的 idle 兜底，
// 避免长思考中途被 5 分钟整体超时掐断（"思考到一半停住"）。
export const OPENCODE_CONNECT_TIMEOUT_MS = 90000
// 流式期间上游完全无数据的最长容忍时间（防止挂死），正常思考持续输出不会触发
export const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 240000
// 向客户端注入 SSE 心跳注释行的空闲阈值：距上次输出超过该值即发 `: keep-alive`，
// 防止客户端因长时间无事件触发 idle 超时
export const OPENCODE_KEEPALIVE_MS = 15000
// GET（模型列表/连通性测试）保持整体超时，数据量小无需放宽
const OPENCODE_GET_TIMEOUT_MS = 20000
// 429 限流重试：FreeUsageLimitError 多为短时限流（用户手动重发即恢复），
// 碰到 429 时对同一 key 短暂等待后重试若干次，避免直接返回失败。
const OPENCODE_RATE_LIMIT_RETRIES = 2
const OPENCODE_RATE_LIMIT_RETRY_BASE_MS = 1200
// 不同 key 之间 429 切换前的最小等待（避免并发触发同一限流窗口）
const OPENCODE_RATE_LIMIT_KEY_GAP_MS = 800

// 瞬时错误自动重试：上游偶发 502/503/504 或网络抖动时对同一 key 重试，
// 消除"偶发 500，客户端重试一次又正常"的体验问题。
const TRANSIENT_RETRY_MAX = 1
const TRANSIENT_RETRY_DELAY_MS = 400
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 日志回调：level 与 LogEntry.type 对齐（'info' 会在 proxy.ts 中映射为 'request'）。
 * 用于把 opencode 内部的 key 选择 / 失败切换 / 走 public 镜像等关键事件透传到系统日志。
 */
export type OpenCodeLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: string,
) => void

/** API key 脱敏：保留前 4 + 后 4，中间用 *** 替代；空值返回 '(empty)' */
function maskApiKey(key: string): string {
  if (!key) return '(empty)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}***${key.slice(-4)}`
}

interface OpenCodeRequestOptions {
  baseUrl: string
  apiKeys: ApiKeyEntry[]
  method: string
  subPath: string
  mirrorUrls: string[]
  search?: string
  body?: string
  fetcher?: typeof fetch
  random?: () => number
  /** 日志回调：传入后会在 key 切换、走 public 等关键节点记录日志 */
  logger?: OpenCodeLogger
  /** 提供商名称，用于日志前缀（如 `[opencode]`） */
  providerName?: string
}

interface StoredFailure {
  status: number
  statusText: string
  headers: Headers
  body: ArrayBuffer
}

export interface OpenCodeTestResult {
  success: boolean
  message: string
  statusCode?: number
  data?: unknown
}

export function isOpenCodeProvider(providerId: string): boolean {
  return providerId === OPENCODE_PROVIDER_ID
}

export function filterOpenCodeModels<T extends { id?: unknown }>(models: T[]): T[] {
  return models.filter((model) => (
    typeof model.id === 'string'
    && /^[A-Za-z0-9._:/-]+$/.test(model.id)
    && (model.id === 'big-pickle' || model.id.endsWith('-free'))
  ))
}

export function resolveOpenCodeUrls(env: Env): string[] {
  const raw = env.OPENCODE_MIRRORS_URL || ''
  // 兼容换行符、逗号、空格分隔；过滤空白；全局去重
  const parts = raw.split('\n').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  return [...new Set(parts)]
}

function getMirrorOrder(urls: string[], random: () => number): string[] {
  if (urls.length === 0) return []
  const start = Math.floor(random() * urls.length)
  return [
    ...urls.slice(start),
    ...urls.slice(0, start),
  ]
}

function buildUrl(baseUrl: string, subPath: string, search = ''): string {
  return `${baseUrl.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}${search}`
}

function createOpenCodeId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const random = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 16)
  return `${prefix}_${Date.now().toString(16)}${random}`
}

function createRequestHeaders(apiKey: string, requestId: string, sessionId: string): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': requestId,
    'x-opencode-session': sessionId,
  })
}

async function storeFailure(response: Response): Promise<StoredFailure> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body: await response.arrayBuffer(),
  }
}

function restoreFailure(failure: StoredFailure): Response {
  return new Response(failure.body, {
    status: failure.status,
    statusText: failure.statusText,
    headers: failure.headers,
  })
}

function transportErrorResponse(error: unknown): Response {
  const message = error instanceof Error && error.message ? error.message : 'OpenCode 上游请求失败'
  return new Response(JSON.stringify({
    error: { message, type: 'proxy_error' },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function isSSEResponse(response: Response): boolean {
  const ct = (response.headers.get('content-type') || '').toLowerCase()
  return ct.includes('text/event-stream') || ct.includes('application/x-ndjson')
}

/**
 * 严格 SSE：仅 text/event-stream。`: keep-alive` 心跳注释行只对这种格式安全——
 * NDJSON 等逐行 JSON 流里注入注释行会破坏客户端解析，只配 idle 兜底不配心跳。
 */
export function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
}

/**
 * 包装上游 SSE 流：
 * 1. 心跳（keepAliveMs > 0 时启用）：距上次输出超过 keepAliveMs 时向客户端注入
 *    `: keep-alive\n\n` 注释行。SSE 注释行客户端会忽略但能重置 idle 计时器。
 * 2. idle 兜底：上游超过 idleTimeoutMs 无任何数据时主动结束流，防止无限挂起。
 */
export function withSSEKeepAlive(
  body: ReadableStream<Uint8Array>,
  keepAliveMs: number,
  idleTimeoutMs: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const encoder = new TextEncoder()
  let closed = false
  let lastOutputAt = Date.now()

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return
    closed = true
    try { controller.close() } catch { /* ignore */ }
    reader.cancel().catch(() => { /* ignore */ })
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => finish(controller), idleTimeoutMs)
      }
      const armHeartbeat = () => {
        if (keepAliveMs <= 0) return
        if (heartbeatTimer) clearTimeout(heartbeatTimer)
        heartbeatTimer = setTimeout(() => {
          if (closed) return
          const now = Date.now()
          if (now - lastOutputAt >= keepAliveMs) {
            try { controller.enqueue(encoder.encode(': keep-alive\n\n')) } catch { /* ignore */ }
            lastOutputAt = Date.now()
          }
          armHeartbeat()
        }, keepAliveMs)
      }

      armIdle()
      armHeartbeat()

      try {
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          lastOutputAt = Date.now()
          armIdle()
          controller.enqueue(value)
        }
      } catch { /* abort / 读错误：结束流 */ }
      finish(controller)
    },
    cancel() {
      closed = true
      reader.cancel().catch(() => { /* ignore */ })
    },
  })
}

/**
 * 通用流式上游 fetch：连接/首字节超时（默认 90s），拿到 response 后解除整体超时；
 * body 包 withSSEKeepAlive（idle 兜底 + 可选心跳）。keepAliveMs 默认 0（不注入心跳注释行，
 * 避免干扰各私有 SSE 解析器）；需要防客户端 idle 断流的路径显式传 OPENCODE_KEEPALIVE_MS。
 */
export async function streamFetchWithTimeout(
  url: string,
  init: RequestInit,
  opts?: { connectTimeoutMs?: number; idleTimeoutMs?: number; keepAliveMs?: number },
): Promise<Response> {
  const connectTimeoutMs = opts?.connectTimeoutMs ?? OPENCODE_CONNECT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
  clearTimeout(timer)
  if (response.body) {
    // 心跳注释行只对严格 SSE（text/event-stream）注入；NDJSON 等格式注入会破坏逐行解析
    const body = withSSEKeepAlive(
      response.body,
      isEventStreamResponse(response) ? (opts?.keepAliveMs ?? 0) : 0,
      opts?.idleTimeoutMs ?? OPENCODE_STREAM_IDLE_TIMEOUT_MS,
    )
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return response
}

async function requestUpstream(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  options: OpenCodeRequestOptions,
  requestId: string,
  sessionId: string
): Promise<Response> {
  const isStreamRequest = options.method !== 'GET' && options.method !== 'HEAD'
  // POST：连接/首字节超时（见 OPENCODE_CONNECT_TIMEOUT_MS），拿到响应后超时不再作用于流式 body；
  // GET：保持整体短超时。
  const controller = new AbortController()
  const timeoutMs = isStreamRequest ? OPENCODE_CONNECT_TIMEOUT_MS : OPENCODE_GET_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, {
      method: options.method,
      headers: createRequestHeaders(apiKey, requestId, sessionId),
      body: options.method === 'GET' || options.method === 'HEAD' ? undefined : options.body,
      signal: controller.signal,
    })
    clearTimeout(timer)
    // 流式 SSE：包装 idle 超时 + 心跳；非 SSE（JSON 错误/普通响应）原样透传，避免污染。
    // 心跳仅对严格 text/event-stream 注入，NDJSON 只配 idle 兜底。
    if (isStreamRequest && response.body && isSSEResponse(response)) {
      const body = withSSEKeepAlive(response.body, isEventStreamResponse(response) ? OPENCODE_KEEPALIVE_MS : 0, OPENCODE_STREAM_IDLE_TIMEOUT_MS)
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    return response
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
}

export async function proxyOpenCodeRequest(options: OpenCodeRequestOptions): Promise<Response> {
  const fetcher = options.fetcher ?? fetch
  const random = options.random ?? Math.random
  const requestId = createOpenCodeId('msg')
  const sessionId = createOpenCodeId('ses')
  let officialFailure: StoredFailure | null = null
  let mirrorFailure: StoredFailure | null = null
  let lastTransportError: unknown = null

  const enabledKeys = options.apiKeys.filter((entry) => entry.enabled && entry.key)
  const officialUrl = buildUrl(options.baseUrl, options.subPath, options.search)

  // 日志回调：未传入时静默；tag 形如 `[opencode]` 或 `[提供商名]`
  const log = options.logger ?? (() => {})
  const tag = options.providerName ? `[${options.providerName}]` : '[opencode]'

  if (enabledKeys.length === 0) {
    log('warn', `${tag} 未配置启用的 API key，将直接走 public 镜像`)
  } else {
    log('info', `${tag} 启用的 key 数量=${enabledKeys.length}，优先走官方地址（带 key）`)
  }

  for (let ki = 0; ki < enabledKeys.length; ki++) {
    const entry = enabledKeys[ki]
    const keyMask = maskApiKey(entry.key)
    try {
      log('info', `${tag} key#${ki + 1} ${keyMask} → 官方地址`)
      // 瞬时错误自动重试：对同一 key 的瞬时 5xx / 网络抖动重试 1 次，
      // 消除"偶发 500，客户端重试一次又正常"的体验问题。
      let response = await requestUpstream(
        fetcher,
        officialUrl,
        entry.key,
        options,
        requestId,
        sessionId
      )
      let transientRetries = 0
      while (isTransientStatus(response.status) && transientRetries < TRANSIENT_RETRY_MAX) {
        transientRetries++
        log('warn', `${tag} key#${ki + 1} ${keyMask} 瞬时 ${response.status}，重试 ${transientRetries}/${TRANSIENT_RETRY_MAX}`)
        await sleep(TRANSIENT_RETRY_DELAY_MS * transientRetries)
        response = await requestUpstream(
          fetcher,
          officialUrl,
          entry.key,
          options,
          requestId,
          sessionId
        )
      }
      if (response.ok) {
        log('info', `${tag} key#${ki + 1} ${keyMask} → 200 成功`)
        return response
      }

      officialFailure = await storeFailure(response)
      // 429 短时限流：对同一 key 短暂等待后重试，几次后仍失败再切换下一个 key
      if (response.status === 429) {
        log('warn', `${tag} key#${ki + 1} ${keyMask} 触发 429，开始限流重试（最多 ${OPENCODE_RATE_LIMIT_RETRIES} 次）`)
        let lastStatus = 429
        for (let i = 1; i <= OPENCODE_RATE_LIMIT_RETRIES; i++) {
          await sleep(OPENCODE_RATE_LIMIT_RETRY_BASE_MS * i)
          const retry = await requestUpstream(
            fetcher,
            officialUrl,
            entry.key,
            options,
            requestId,
            sessionId
          )
          if (retry.ok) {
            log('info', `${tag} key#${ki + 1} ${keyMask} 限流重试 ${i} → 200 成功`)
            return retry
          }
          officialFailure = await storeFailure(retry)
          lastStatus = retry.status
          if (retry.status !== 429) break
        }
        // 重试后仍 429：等待后再尝试下一个 key（或镜像）
        if (lastStatus === 429) {
          log('warn', `${tag} key#${ki + 1} ${keyMask} 重试后仍 429，切换下一个 key`)
          await sleep(OPENCODE_RATE_LIMIT_KEY_GAP_MS)
          continue
        }
        // 重试返回了其他错误：按该错误决定是否继续尝试下一个 key
        // - 5xx 服务器错误：可能是上游对当前 key 的偶发问题，继续尝试下一个 key
        // - 401/403：key 无效，继续尝试下一个 key
        // - 其他 4xx（400/422 等）：请求本身的问题，所有 key 都会失败，跳出
        if (lastStatus >= 400 && lastStatus < 500 && lastStatus !== 401 && lastStatus !== 403) {
          log('warn', `${tag} key#${ki + 1} ${keyMask} 重试后返回 ${lastStatus}（4xx 请求错误），停止尝试后续 key`)
          break
        }
        log('warn', `${tag} key#${ki + 1} ${keyMask} 重试后返回 ${lastStatus}，切换下一个 key`)
        continue
      }
      // 非 429 的首次失败：
      // - 5xx 服务器错误：可能是上游对当前 key 的偶发问题，继续尝试下一个 key
      // - 401/403：key 无效，继续尝试下一个 key
      // - 其他 4xx（400/422 等）：请求本身的问题，所有 key 都会失败，跳出
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) {
        log('warn', `${tag} key#${ki + 1} ${keyMask} → ${response.status}（4xx 请求错误），停止尝试后续 key`)
        break
      }
      log('warn', `${tag} key#${ki + 1} ${keyMask} → ${response.status}，切换下一个 key`)
    } catch (error) {
      // 网络异常/连接被重置等瞬时错误：对同一 key 重试 1 次后仍失败再放弃
      lastTransportError = error
      log('warn', `${tag} key#${ki + 1} ${keyMask} 网络异常：${(error instanceof Error && error.message) ? error.message.substring(0, 200) : String(error).substring(0, 200)}，开始重试`)
      let netRetries = 0
      let netRecovered = false
      while (netRetries < TRANSIENT_RETRY_MAX) {
        netRetries++
        await sleep(TRANSIENT_RETRY_DELAY_MS * netRetries)
        try {
          const retry = await requestUpstream(
            fetcher,
            officialUrl,
            entry.key,
            options,
            requestId,
            sessionId
          )
          if (retry.ok) {
            log('info', `${tag} key#${ki + 1} ${keyMask} 网络重试 ${netRetries} → 200 成功`)
            return retry
          }
          if (isTransientStatus(retry.status)) {
            officialFailure = await storeFailure(retry)
            log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试 ${netRetries} → ${retry.status}（瞬时），继续重试`)
            continue
          }
          // 重试返回确定性错误，按原逻辑处理
          officialFailure = await storeFailure(retry)
          if (retry.status === 429) {
            log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试后 → 429，切换下一个 key`)
            await sleep(OPENCODE_RATE_LIMIT_KEY_GAP_MS)
            netRecovered = true
            break
          }
          if (retry.status === 401 || retry.status === 403) {
            log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试后 → ${retry.status}（key 无效），切换下一个 key`)
            netRecovered = true
            break
          }
          // 5xx：可能是上游对当前 key 的偶发问题，继续尝试下一个 key
          // 其他 4xx（400/422 等）：请求本身的问题，所有 key 都会失败，跳出
          if (retry.status >= 400 && retry.status < 500) {
            log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试后 → ${retry.status}（4xx 请求错误），停止尝试后续 key`)
            break
          }
          log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试后 → ${retry.status}（5xx），切换下一个 key`)
          netRecovered = true
          break
        } catch (retryErr) {
          lastTransportError = retryErr
        }
      }
      if (netRecovered) continue
      break
    }
  }

  // 所有 key 都失败，回退到镜像 public 模式
  const mirrors = getMirrorOrder(options.mirrorUrls, random)
  if (mirrors.length > 0) {
    log('warn', `${tag} 所有 key 均失败，回退到 public 镜像（共 ${mirrors.length} 个）`)
  }
  for (const mirror of mirrors) {
    try {
      log('info', `${tag} public 镜像 → ${mirror}`)
      const response = await requestUpstream(
        fetcher,
        buildUrl(mirror, options.subPath, options.search),
        'public',
        options,
        requestId,
        sessionId
      )
      if (response.ok) {
        log('info', `${tag} public 镜像 ${mirror} → 200 成功`)
        return response
      }
      log('warn', `${tag} public 镜像 ${mirror} → ${response.status}`)
      mirrorFailure = await storeFailure(response)
    } catch (error) {
      lastTransportError = error
      log('warn', `${tag} public 镜像 ${mirror} 网络异常：${(error instanceof Error && error.message) ? error.message.substring(0, 200) : String(error).substring(0, 200)}`)
    }
  }

  if (officialFailure) return restoreFailure(officialFailure)
  if (mirrorFailure) return restoreFailure(mirrorFailure)
  return transportErrorResponse(lastTransportError)
}

export async function testOpenCodeModel(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  modelId: string,
  mirrorUrls: string[],
  fetcher?: typeof fetch
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'POST',
    subPath: 'chat/completions',
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }),
    fetcher,
  })

  if (response.ok) {
    return { success: true, message: '连接成功', statusCode: response.status }
  }

  const body = await response.text()
  return {
    success: false,
    message: `HTTP ${response.status}: ${body.substring(0, 200)}`,
    statusCode: response.status,
  }
}

export async function fetchOpenCodeModels(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  mirrorUrls: string[],
  fetcher?: typeof fetch
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'GET',
    subPath: 'models',
    fetcher,
  })

  if (!response.ok) {
    return {
      success: false,
      message: `HTTP ${response.status}: ${(await response.text()).substring(0, 200)}`,
      statusCode: response.status,
    }
  }

  const data = await response.json() as { data?: Array<{ id?: unknown }> }
  return {
    success: true,
    message: '连接成功',
    statusCode: response.status,
    data: {
      ...data,
      data: Array.isArray(data.data) ? filterOpenCodeModels(data.data) : [],
    },
  }
}
