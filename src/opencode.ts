import type { ApiKeyEntry, Env } from './types'

export const OPENCODE_PROVIDER_ID = 'opencode'

const OPENCODE_VERSION = '1.17.8'
// POST 连接/首字节超时：思考模型首字节前可能长时间无输出，放宽到 90s。
// 连接建立后（流式）不再受整体超时限制，改由 withSSEKeepAlive 的 idle 兜底，
// 避免长思考中途被 5 分钟整体超时掐断（"思考到一半停住"）。
const OPENCODE_CONNECT_TIMEOUT_MS = 90000
// 流式期间上游完全无数据的最长容忍时间（防止挂死），正常思考持续输出不会触发
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 240000
// 向客户端注入 SSE 心跳注释行的空闲阈值：距上次输出超过该值即发 `: keep-alive`，
// 防止客户端因长时间无事件触发 idle 超时
const OPENCODE_KEEPALIVE_MS = 15000
// GET（模型列表/连通性测试）保持整体超时，数据量小无需放宽
const OPENCODE_GET_TIMEOUT_MS = 20000

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

function isSSEResponse(response: Response): boolean {
  const ct = (response.headers.get('content-type') || '').toLowerCase()
  return ct.includes('text/event-stream') || ct.includes('application/x-ndjson')
}

/**
 * 包装上游 SSE 流：
 * 1. 心跳：距上次输出超过 keepAliveMs 时向客户端注入 `: keep-alive\n\n` 注释行。
 *    SSE 注释行客户端会忽略但能重置 idle 计时器——思考模型长时间只吐 reasoning
 *    或完全静默时，防止客户端（如 Trae）判定超时而中断流。
 * 2. idle 兜底：上游超过 idleTimeoutMs 无任何数据时主动结束流，防止无限挂起。
 */
function withSSEKeepAlive(
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
    // 流式 SSE：包装 idle 超时 + 心跳；非 SSE（JSON 错误/普通响应）原样透传，避免污染
    if (isStreamRequest && response.body && isSSEResponse(response)) {
      const body = withSSEKeepAlive(response.body, OPENCODE_KEEPALIVE_MS, OPENCODE_STREAM_IDLE_TIMEOUT_MS)
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

  for (const entry of enabledKeys) {
    try {
      const response = await requestUpstream(
        fetcher,
        officialUrl,
        entry.key,
        options,
        requestId,
        sessionId
      )
      if (response.ok) return response

      officialFailure = await storeFailure(response)
      if (response.status !== 401 && response.status !== 403 && response.status !== 429) break
    } catch (error) {
      lastTransportError = error
      break
    }
  }

  for (const mirror of getMirrorOrder(options.mirrorUrls, random)) {
    try {
      const response = await requestUpstream(
        fetcher,
        buildUrl(mirror, options.subPath, options.search),
        'public',
        options,
        requestId,
        sessionId
      )
      if (response.ok) return response
      mirrorFailure = await storeFailure(response)
    } catch (error) {
      lastTransportError = error
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
