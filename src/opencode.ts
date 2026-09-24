import type { ApiKeyEntry, Env } from './types'

export const OPENCODE_PROVIDER_ID = 'opencode'

const OPENCODE_VERSION = '1.18.31'
// 上游免费档要求 UA 里的 opencode 版本 ≥ 1.18.0（2026-09-26 实测：1.17.8 → 426
// UpgradeRequired "OpenCode 1.18.0 or newer is required to use the free tier"）。
// provider-utils / runtime 段不参与判定，仅为保持与真实 CLI 出站指纹一致。
const OPENCODE_AI_SDK_VERSION = '4.0.40'
const OPENCODE_RUNTIME = 'bun/1.3.14'
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
// 官方地址 429 短时熔断：所有 key 连续 429 后，在熔断期内跳过官方地址直接走镜像，
// 避免每次请求都白等 N 个 key × 重试次 数的延迟。熔断期内仍会用第一个 key 探测 1 次
// （不重试），成功则解除熔断。模块级内存状态，Worker isolate 回收后丢失，对 60s 足够。
const OPENCODE_OFFICIAL_429_COOLDOWN_MS = 60000
let official429Until = 0

// ===== per-key 冷却与健康度（移植 opencode2api internal/gateway/pool.go:475-487）=====
// 源实现：网络错误 / 401 / 403 / 429 / ≥500 触发冷却，时长 = base × 2^min(failures-1, 3)，
// 与上游 Retry-After 取大，成功清零；全部冷却时选最早到期者顶班。
// 本仓为 isolate 内存版（与 official429Until 同级语义）：Worker isolate 回收后丢失，
// 可接受——坏 key 的最坏后果只是被重新尝试一次。
const OPENCODE_KEY_COOLDOWN_BASE_MS = 15000
const OPENCODE_KEY_COOLDOWN_MAX_SHIFT = 3

interface OpenCodeKeyHealth {
  failures: number
  cooldownUntil: number
}

const keyHealth = new Map<string, OpenCodeKeyHealth>()

/** 仅供测试：清空模块级 key 健康度状态 */
export function __resetOpenCodeKeyHealthForTests(): void {
  keyHealth.clear()
  official429Until = 0
}

function markKeySuccess(key: string): void {
  keyHealth.delete(key)
}

/** 记一次 key 级失败并推进冷却窗口；retryAfterMs 存在时取较大值 */
function markKeyFailure(key: string, retryAfterMs?: number): number {
  const entry = keyHealth.get(key) ?? { failures: 0, cooldownUntil: 0 }
  entry.failures += 1
  const shift = Math.min(entry.failures - 1, OPENCODE_KEY_COOLDOWN_MAX_SHIFT)
  const base = OPENCODE_KEY_COOLDOWN_BASE_MS * 2 ** shift
  const cooldown = Math.max(base, retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0)
  entry.cooldownUntil = Date.now() + cooldown
  keyHealth.set(key, entry)
  return cooldown
}

function keyCooldownUntil(key: string): number {
  const entry = keyHealth.get(key)
  if (!entry) return 0
  if (entry.cooldownUntil <= Date.now()) return 0
  return entry.cooldownUntil
}

/** 解析上游 Retry-After：支持秒数与 HTTP 日期两种形式 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/** FNV-1a 32 位：用于会话哈希定 key 起点（同步、确定性，对齐源实现的 FNV-64a 用法） */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 从 startIndex 起环形遍历 [0, count) */
function orderKeyIndices(count: number, startIndex: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push((startIndex + i) % count)
  return out
}

/** 上游 reasoning_effort 合法档位（2026-09-26 从上游 400 报文实测提取） */
export const OPENCODE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// 瞬时错误自动重试：上游偶发 500（过载/限流网关常见）/502/503/504 或网络抖动时对同一 key 重试，
// 消除"偶发 500，客户端报 ConnectionReset/Network IO error，重试一次又正常"的体验问题。
const TRANSIENT_RETRY_MAX = 1
const TRANSIENT_RETRY_DELAY_MS = 400
function isTransientStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
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
  /** 会话亲和信号（请求头族里的显式会话 ID）；缺省时由 body 派生 */
  affinityKey?: string
  /** 提供商级默认 reasoning 档位；客户端已显式声明时忽略 */
  reasoningEffort?: string
  /** 已生效的整形结果（由 proxyOpenCodeRequest 计算并回传，响应侧据此过滤/折叠） */
  shape?: OpenCodeShape
  /** 懒整形兜底用的强制整形结果：收到 403 FreeTierError 时对同一 key 原地重试 */
  reshape?: OpenCodeShape
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

/**
 * opencode CLI 的 ID 字符表：base62（数字 + 大写 + 小写）
 */
const OPENCODE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * 生成 opencode CLI 规范的 request / session ID：
 * 6 字节时间戳（`Date.now() * 4096 + 1` 的高 48 位，十六进制 12 字符）+ 14 位 base62 随机串。
 * session 的时间戳按位取反（对齐 opencode 源码 gen(true)）。
 *
 * 上游免费档会校验该格式——2026-09-26 实测：自造的 `msg_<hex><base64url>` 一律
 * 403 FreeTierError，换成规范格式即通过（同一 key、同一 body）。
 */
function createOpenCodeId(prefix: 'msg' | 'ses'): string {
  let value = BigInt(Date.now()) * 0x1000n + 1n
  if (prefix === 'ses') value = ~value
  let time = ''
  for (let i = 0; i < 6; i++) {
    time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  let random = ''
  for (const byte of bytes) random += OPENCODE_ID_CHARS[byte % 62]
  return `${prefix}_${time}${random}`
}

/** 上游认可的 canonical session 形状：ses_ + 12 位小写十六进制 + 14 位 base62 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * 把任意会话信号确定性映射成 canonical `ses_` 形状（移植 opencode2api
 * internal/identity/request.go:90-107）。
 *
 * 已是 canonical 形状的信号**原样保留**——那是真实 opencode 客户端的会话 ID，
 * 保留它才能命中上游 prompt cache 亲和；其余信号（UUID、第三方客户端会话、
 * 网关自造 ID、内容种子）用 sha256 确定性哈希成同一形状，使同一会话每次请求
 * 都拿到同一个 session ID。
 */
export async function canonicalOpenCodeSessionId(signal: string): Promise<string> {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const bytes = new TextEncoder().encode('ses\u0000' + signal)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let time = ''
  for (let i = 0; i < 6; i++) time += digest[i].toString(16).padStart(2, '0')
  let random = ''
  for (let i = 6; i < 20; i++) random += OPENCODE_ID_CHARS[digest[i] % 62]
  return `ses_${time}${random}`
}

/**
 * 从请求体派生会话信号（移植 opencode2api identity/request.go:62-79 的 conversationSeed）：
 * 优先 `previous_response_id`，其次首条 user 消息内容，再退到 Responses 的字符串 input。
 * 调用方应优先传入请求头族里的显式会话 ID（见 proxy.ts），本函数只是兜底。
 */
export function openCodeAffinitySignal(body: string | undefined): string {
  if (!body) return ''
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    payload = parsed as Record<string, unknown>
  } catch {
    return ''
  }
  const previous = payload['previous_response_id']
  if (typeof previous === 'string' && previous) return previous
  const input = payload['input']
  if (typeof input === 'string' && input) return input
  for (const field of ['messages', 'input']) {
    const list = payload[field]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (item['role'] !== 'user') continue
      const content = item['content']
      if (content === undefined || content === null) continue
      const encoded = typeof content === 'string' ? content : JSON.stringify(content)
      if (encoded && encoded !== 'null') return encoded
    }
  }
  return ''
}

/**
 * 把提供商级默认 reasoning 档位写入请求体（移植 opencode2api config.reasoning.effort）。
 * 客户端已显式声明（reasoning_effort / reasoningEffort / reasoning.effort）时一律不动；
 * `none` 表示显式关闭思考。非法档位不写入，避免上游 400。
 */
export function applyOpenCodeReasoningEffort(body: string | undefined, effort: string | undefined): string | undefined {
  if (!body || !effort) return body
  if (!(OPENCODE_REASONING_EFFORTS as readonly string[]).includes(effort)) return body
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    payload = parsed as Record<string, unknown>
  } catch {
    return body
  }
  if (payload['reasoning_effort'] !== undefined || payload['reasoningEffort'] !== undefined) return body
  const nested = payload['reasoning']
  if (nested && typeof nested === 'object' && (nested as Record<string, unknown>)['effort'] !== undefined) return body
  payload['reasoning_effort'] = effort
  return JSON.stringify(payload)
}

function createRequestHeaders(apiKey: string, requestId: string, sessionId: string, streamAccept: boolean): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/${OPENCODE_AI_SDK_VERSION} runtime/${OPENCODE_RUNTIME}`,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': requestId,
    'x-opencode-session': sessionId,
  })
  // 推理请求声明可接受 event-stream，与真实 opencode CLI 的出站指纹一致。
  // 实测（2026-09-26）该头本身不参与免费档判定，但缺它会让出站请求与 CLI 有明显差异，
  // 保留以降低后续追加风控规则命中的概率。GET（/models 等）保持 application/json，
  // 避免上游按 Accept 协商成 SSE。
  if (streamAccept) headers.set('Accept', 'application/json, text/event-stream')
  return headers
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
/** 流式结束态：complete=上游自然读完 / idle=空闲超时结束 / cancel=客户端断开 / error=读 body 异常 */
export type StreamCloseReason = 'complete' | 'idle' | 'cancel' | 'error'

export function withSSEKeepAlive(
  body: ReadableStream<Uint8Array>,
  keepAliveMs: number,
  idleTimeoutMs: number,
  onClose?: (reason: StreamCloseReason) => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const encoder = new TextEncoder()
  let closed = false
  let lastOutputAt = Date.now()

  const notify = (reason: StreamCloseReason) => {
    if (!onClose) return
    try { onClose(reason) } catch { /* 回调异常不影响流收尾 */ }
  }

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, reason: StreamCloseReason) => {
    if (closed) return
    closed = true
    try { controller.close() } catch { /* ignore */ }
    reader.cancel().catch(() => { /* ignore */ })
    notify(reason)
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => finish(controller, 'idle'), idleTimeoutMs)
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

      let readError = false
      try {
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          lastOutputAt = Date.now()
          armIdle()
          controller.enqueue(value)
        }
      } catch { /* abort / 读错误：结束流 */ readError = true }
      // 自然 EOF 为 complete；读 body 抛错为 error
      finish(controller, readError ? 'error' : 'complete')
    },
    cancel() {
      if (closed) return
      closed = true
      reader.cancel().catch(() => { /* ignore */ })
      notify('cancel')
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
  method: string,
  body: string | undefined,
  requestId: string,
  sessionId: string
): Promise<Response> {
  const isStreamRequest = method !== 'GET' && method !== 'HEAD'
  // POST：连接/首字节超时（见 OPENCODE_CONNECT_TIMEOUT_MS），拿到响应后超时不再作用于流式 body；
  // GET：保持整体短超时。
  const controller = new AbortController()
  const timeoutMs = isStreamRequest ? OPENCODE_CONNECT_TIMEOUT_MS : OPENCODE_GET_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, {
      method,
      headers: createRequestHeaders(apiKey, requestId, sessionId, isStreamRequest),
      body: isStreamRequest ? body : undefined,
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

// ===== 免费档 agent 形状整形（2026-09-26 实测锁定） =====
// 上游对免费档模型强制校验请求体是否为「agent 形状」，不满足即
// 403 {"type":"error","error":{"type":"FreeTierError", ...}}。
// 实测矩阵（真 key，big-pickle / mimo-v2.6-flash-free 双模型一致）：
//   stream:true + tools[bash,read]        → 200
//   stream:true + tools[bash,write]       → 403（read 不可被其他工具名替代）
//   stream:true + tools[bash]             → 403（数量不足）
//   stream:true + tools[read,edit]        → 403（缺 bash）
//   stream:true + tools[bash,read,zzz]    → 200（多余工具名不影响）
//   stream:false + tools[bash,read]       → 403（必须流式）
//   stream:true + tools[bash,read] 无 Accept 头 → 200（Accept 不参与判定）
// 即：stream:true + tools 里同时存在 name=bash 与 name=read，二者缺一不可。

/** 上游免费档校验强制要求的工具名（缺一即 403 FreeTierError） */
export const OPENCODE_REQUIRED_TOOLS = ['bash', 'read'] as const

/** 免费档模型 id 口径，与 filterOpenCodeModels 保持一致 */
export function isOpenCodeFreeModel(modelId: string): boolean {
  return modelId === 'big-pickle' || modelId.endsWith('-free')
}

export interface OpenCodeShape {
  /** 整形后的请求体；无需整形时原样返回入参 */
  body: string | undefined
  /** 客户端原本要非流式：上游被强制流式，响应需折回单个 JSON */
  collapseStream: boolean
  /** 为过校验而合成的工具名；响应中这些 name 的 tool_calls 必须丢弃 */
  syntheticTools: string[]
}

/** 兼容 chat（function.name）与 responses（name）两种工具形状，取工具名 */
function openCodeToolName(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const entry = item as Record<string, unknown>
  const fn = entry['function']
  if (fn && typeof fn === 'object') {
    const name = (fn as Record<string, unknown>)['name']
    if (typeof name === 'string') return name
  }
  const name = entry['name']
  return typeof name === 'string' ? name : ''
}

/** 合成最小工具定义：上游只校验名字，schema 内容不校验 */
function minimalToolDef(name: string, protocol: 'chat' | 'responses'): Record<string, unknown> {
  const parameters = { type: 'object', properties: {}, required: [] }
  if (protocol === 'responses') {
    return { type: 'function', name, description: 'x', parameters, strict: false }
  }
  return { type: 'function', function: { name, description: 'x', parameters } }
}

/**
 * 把免费档模型的请求体整形成 agent 形状：强制 stream:true，并补齐 bash / read。
 * 付费模型、非 JSON 体、GET 路径一律原样返回（对齐 opencode2api 的 shapeKeyBody）。
 */
export function shapeOpenCodeFreeBody(rawBody: string | undefined, subPath: string): OpenCodeShape {
  return shapeOpenCodeBody(rawBody, subPath, false)
}

/**
 * 懒整形兜底（P1-2a）：无视模型名一律整形。用于「按名字没判出免费、但上游回了
 * 403 FreeTierError」的模型——上游新增不带 `free` 名字的免费模型时靠它救回。
 */
export function shapeOpenCodeForcedBody(rawBody: string | undefined, subPath: string): OpenCodeShape {
  return shapeOpenCodeBody(rawBody, subPath, true)
}

function shapeOpenCodeBody(rawBody: string | undefined, subPath: string, force: boolean): OpenCodeShape {
  const unchanged: OpenCodeShape = { body: rawBody, collapseStream: false, syntheticTools: [] }
  if (!rawBody) return unchanged
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unchanged
    payload = parsed as Record<string, unknown>
  } catch {
    return unchanged
  }
  if (!force) {
    const model = typeof payload['model'] === 'string' ? payload['model'] : ''
    if (!isOpenCodeFreeModel(model)) return unchanged
  }

  const protocol: 'chat' | 'responses' = subPath.includes('responses') ? 'responses' : 'chat'
  let changed = false

  const collapseStream = payload['stream'] !== true
  if (collapseStream) {
    payload['stream'] = true
    changed = true
  }

  const rawTools = payload['tools']
  const items = Array.isArray(rawTools) ? rawTools : null
  const present = new Set<string>()
  if (items) for (const item of items) {
    const name = openCodeToolName(item)
    if (name) present.add(name)
  }
  const missing = OPENCODE_REQUIRED_TOOLS.filter((name) => !present.has(name))
  if (missing.length > 0) {
    const next = items ? [...items] : []
    for (const name of missing) next.push(minimalToolDef(name, protocol))
    payload['tools'] = next
    changed = true
  }

  if (!changed) return unchanged
  return { body: JSON.stringify(payload), collapseStream, syntheticTools: [...missing] }
}

/**
 * SSE 逐行过滤：丢弃 synthetic 工具名的 tool_calls（含该 index 的后续 arguments 增量）。
 * 整段流没有任何真实 tool_call 时，把 finish_reason=tool_calls 降级为 stop，
 * 避免客户端收到「以工具调用收尾但没有任何工具调用」的空转响应。
 */
export function filterSyntheticToolCalls(
  body: ReadableStream<Uint8Array>,
  syntheticTools: string[],
): ReadableStream<Uint8Array> {
  const synthetic = new Set(syntheticTools)
  if (synthetic.size === 0) return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const droppedIndices = new Set<number>()
  let sawRealToolCall = false
  let buffer = ''

  const rewrite = (line: string): string => {
    if (!line.startsWith('data:')) return line
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return line
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return line
    }
    const choices = obj['choices']
    if (!Array.isArray(choices) || choices.length === 0) return line
    const choice = choices[0] as Record<string, unknown>
    const delta = choice['delta'] as Record<string, unknown> | undefined
    if (delta && Array.isArray(delta['tool_calls'])) {
      const kept: unknown[] = []
      for (const raw of delta['tool_calls'] as unknown[]) {
        const entry = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
        const index = Number(entry['index'] ?? 0)
        const name = openCodeToolName(entry)
        if (name && synthetic.has(name)) {
          droppedIndices.add(index)
          continue
        }
        if (name && !synthetic.has(name)) sawRealToolCall = true
        if (!name && droppedIndices.has(index)) continue
        kept.push(raw)
      }
      if (kept.length === 0) delete delta['tool_calls']
      else delta['tool_calls'] = kept
    }
    if (choice['finish_reason'] === 'tool_calls' && !sawRealToolCall) {
      choice['finish_reason'] = 'stop'
    }
    return 'data: ' + JSON.stringify(obj)
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            controller.enqueue(encoder.encode(rewrite(line) + '\n'))
          }
        }
        buffer += decoder.decode()
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)))
      } catch { /* 读错误：结束流 */ }
      try { controller.close() } catch { /* ignore */ }
    },
    cancel() {
      reader.cancel().catch(() => { /* ignore */ })
    },
  })
}

/** 折叠结果：只有上游正常收尾才产出文档，否则按上游错误对外报错 */
type OpenCodeCollapseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * 读取整段 SSE，聚合成 OpenAI 非流式 chat.completion（客户端原本要非流式时使用）。
 *
 * 终止语义对齐 opencode2api internal/protocol/collapse.go:38-62：只有见到 `[DONE]`
 * 或 `finish_reason` 才算正常收尾；流内 error 事件或直接断流一律返回失败——
 * 否则客户端会拿到「HTTP 200 + 空回复」，把上游故障伪装成正常应答。
 */
async function aggregateOpenCodeStream(body: ReadableStream<Uint8Array>): Promise<OpenCodeCollapseResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const toolIndex = new Map<number, number>()
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let id = '', model = '', finishReason = '', content = '', reasoning = ''
  let created = 0
  let usage: unknown = null
  let buffer = ''
  let sawDone = false
  let streamError = ''
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '') return
    if (payload === '[DONE]') {
      sawDone = true
      return
    }
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    const error = obj['error']
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message']
      streamError = typeof message === 'string' && message ? message : 'upstream stream error'
      return
    }
    if (obj['id']) id = String(obj['id'])
    if (obj['model']) model = String(obj['model'])
    if (obj['created']) created = Number(obj['created'])
    if (obj['usage']) usage = obj['usage']
    const choices = obj['choices']
    if (!Array.isArray(choices) || choices.length === 0) return
    const choice = choices[0] as Record<string, unknown>
    if (choice['finish_reason']) finishReason = String(choice['finish_reason'])
    const delta = (choice['delta'] || choice['message']) as Record<string, unknown> | undefined
    if (!delta) return
    if (delta['content']) content += String(delta['content'])
    if (delta['reasoning_content']) reasoning += String(delta['reasoning_content'])
    else if (delta['reasoning']) reasoning += String(delta['reasoning'])
    const tcs = delta['tool_calls']
    if (Array.isArray(tcs)) {
      for (const raw of tcs) {
        const tc = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
        const index = Number(tc['index'] ?? 0)
        const fn = tc['function'] as Record<string, unknown> | undefined
        if (tc['id'] && fn) {
          toolIndex.set(index, toolCalls.length)
          toolCalls.push({ id: String(tc['id']), name: String(fn['name'] || ''), arguments: String(fn['arguments'] || '') })
        } else if (fn && fn['arguments'] !== undefined) {
          const target = toolIndex.get(index)
          if (target !== undefined) toolCalls[target].arguments += String(fn['arguments'])
        }
      }
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      consume(line)
    }
  }
  buffer += decoder.decode()
  if (buffer) consume(buffer)

  if (streamError) return { ok: false, message: streamError }
  if (!sawDone && !finishReason) return { ok: false, message: 'upstream stream ended before completion' }

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning) message['reasoning_content'] = reasoning
  if (toolCalls.length > 0) {
    message['tool_calls'] = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
  }
  return {
    ok: true,
    payload: {
      id: id || 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: created || Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  }
}

/**
 * 对外入口。
 *
 * 请求侧：提供商级 reasoning 档位 → 按模型名整形免费档 body → 预生成「强制整形」
 * 备用体（按名字没判出免费、但上游回 403 FreeTierError 时，raw 层对同一 key 原地重试一次）。
 * 响应侧：丢弃合成工具的 tool_calls；客户端原本要非流式时把强制流式的 SSE 折回单个
 * chat.completion，且只有上游正常收尾才产出文档，否则回 502 upstream_error。
 */
export async function proxyOpenCodeRequest(options: OpenCodeRequestOptions): Promise<Response> {
  const isPost = options.method === 'POST'
  const withEffort = isPost ? applyOpenCodeReasoningEffort(options.body, options.reasoningEffort) : options.body
  const shape: OpenCodeShape = isPost
    ? shapeOpenCodeFreeBody(withEffort, options.subPath)
    : { body: withEffort, collapseStream: false, syntheticTools: [] }

  // 本次没做任何改动（按名字不是免费模型）时才需要懒整形兜底；
  // 且兜底体必须真的与原始体不同，否则重试没有意义。
  const lazy = isPost && shape.syntheticTools.length === 0 && !shape.collapseStream
    ? shapeOpenCodeForcedBody(withEffort, options.subPath)
    : null
  const reshape = lazy && (lazy.syntheticTools.length > 0 || lazy.collapseStream) ? lazy : undefined

  const { response, shape: used } = await proxyOpenCodeRequestRaw({ ...options, body: shape.body, shape, reshape })

  if (used.syntheticTools.length === 0 && !used.collapseStream) return response
  if (!response.ok || !response.body || !isSSEResponse(response)) return response

  const filtered = filterSyntheticToolCalls(response.body, used.syntheticTools)
  if (!used.collapseStream) {
    return new Response(filtered, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.delete('Content-Length')
  const result = await aggregateOpenCodeStream(filtered)
  if (!result.ok) {
    // 流被截断或流内报错：不能伪装成 200 空回复（对齐 opencode2api collapse.go:51-62）
    return new Response(JSON.stringify({ error: { message: result.message, type: 'upstream_error' } }), {
      status: 502,
      headers,
    })
  }
  return new Response(JSON.stringify(result.payload), { status: 200, headers })
}

/** 403 且响应体为 FreeTierError：属于「免费档形状校验」，不是 key 的问题，不能冷却 key */
function isFreeTierFailure(failure: StoredFailure): boolean {
  if (failure.status !== 403) return false
  if (failure.body.byteLength === 0 || failure.body.byteLength > 4096) return false
  try {
    return new TextDecoder().decode(failure.body).includes('FreeTierError')
  } catch {
    return false
  }
}

async function proxyOpenCodeRequestRaw(
  options: OpenCodeRequestOptions,
): Promise<{ response: Response; shape: OpenCodeShape }> {
  const fetcher = options.fetcher ?? fetch
  const random = options.random ?? Math.random
  const requestId = createOpenCodeId('msg')

  // 会话亲和（P0-2，移植 opencode2api identity/request.go:24-59 + pool.go:425-443）：
  // 显式会话头族优先，其次从 body 派生（previous_response_id / 首条 user 内容）；
  // 都没有才退回每次随机的 session ID（此时也没有亲和可言）。
  const affinitySignal = options.affinityKey || openCodeAffinitySignal(options.body)
  const sessionId = affinitySignal ? await canonicalOpenCodeSessionId(affinitySignal) : createOpenCodeId('ses')

  // 懒整形兜底（P1-2a）：body/shape 在收到 403 FreeTierError 时会被换成强制整形体，
  // 最终以实际生效的 shape 回传给调用方做响应侧处理。
  let shape: OpenCodeShape = options.shape ?? { body: options.body, collapseStream: false, syntheticTools: [] }
  let body = shape.body
  let reshaped = false
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

  // key 起点由会话哈希决定：同一会话固定从同一个 key 开始（对齐 pool.go:436-443 的 CursorFor）；
  // 无会话信号时保持原有顺序（key#1 优先）。
  const startIndex = enabledKeys.length > 0 && affinitySignal ? fnv1a(sessionId) % enabledKeys.length : 0
  const orderedIndices = orderKeyIndices(enabledKeys.length, startIndex)
  // per-key 冷却（P1-1，对齐 pool.go:445-468）：跳过冷却中的 key；全部冷却时按最早到期顶班。
  const coolingIndices = orderedIndices.filter((i) => keyCooldownUntil(enabledKeys[i].key) > 0)
  const usableIndices = orderedIndices.filter((i) => keyCooldownUntil(enabledKeys[i].key) === 0)
  const attemptIndices = usableIndices.length > 0
    ? usableIndices
    : [...coolingIndices].sort((a, b) => keyCooldownUntil(enabledKeys[a].key) - keyCooldownUntil(enabledKeys[b].key))
  if (coolingIndices.length > 0) {
    log('warn', `${tag} ${coolingIndices.length}/${enabledKeys.length} 个 key 处于冷却中${usableIndices.length === 0 ? '（全部冷却，按最早到期顺序顶班）' : '，已跳过'}`)
  }

  /** 单次出站尝试：403 FreeTierError 且有兜底整形体时，对同一 key 原地重试一次 */
  const sendTo = async (url: string, key: string): Promise<Response> => {
    let response = await requestUpstream(fetcher, url, key, options.method, body, requestId, sessionId)
    if (!reshaped && options.reshape && response.status === 403) {
      const failure = await storeFailure(response)
      if (isFreeTierFailure(failure)) {
        reshaped = true
        shape = options.reshape
        body = options.reshape.body
        log('warn', `${tag} 上游 403 FreeTierError，改用强制整形 body 原地重试一次`)
        response = await requestUpstream(fetcher, url, key, options.method, body, requestId, sessionId)
      } else {
        response = restoreFailure(failure)
      }
    }
    return response
  }

  // 官方地址 429 短时熔断：熔断期内用首个可用 key 探测 1 次（不重试），
  // 成功则解除熔断；仍 429 则保持熔断直接走镜像，避免每次请求都白等 key 重试。
  const now = Date.now()
  let skipOfficial = false
  if (enabledKeys.length > 0 && now < official429Until) {
    const remainSec = Math.ceil((official429Until - now) / 1000)
    const probeIndex = attemptIndices[0] ?? 0
    const probeKey = enabledKeys[probeIndex]
    const probeMask = maskApiKey(probeKey.key)
    const probeLabel = `key#${probeIndex + 1}`
    log('warn', `${tag} 官方地址 429 熔断中（剩余 ${remainSec}s），用 ${probeLabel} ${probeMask} 探测 1 次`)
    try {
      const probe = await sendTo(officialUrl, probeKey.key)
      if (probe.ok) {
        official429Until = 0
        markKeySuccess(probeKey.key)
        log('info', `${tag} ${probeLabel} ${probeMask} 探测 → 200 成功，解除熔断`)
        return { response: probe, shape }
      }
      officialFailure = await storeFailure(probe)
      if (probe.status === 429) {
        markKeyFailure(probeKey.key, parseRetryAfterMs(probe.headers))
        log('warn', `${tag} ${probeLabel} ${probeMask} 探测仍 429，保持熔断，走镜像`)
      } else {
        // 非 429：解除熔断（官方地址可能恢复，或有其他确定性错误）
        official429Until = 0
        log('warn', `${tag} ${probeLabel} ${probeMask} 探测 → ${probe.status}，解除熔断，走镜像`)
      }
      skipOfficial = true
    } catch (error) {
      lastTransportError = error
      markKeyFailure(probeKey.key)
      log('warn', `${tag} ${probeLabel} ${probeMask} 探测网络异常，保持熔断，走镜像`)
      skipOfficial = true
    }
  }

  let keysExhaustedBy429 = 0
  let attemptedKeys = 0
  if (!skipOfficial) {
  for (const ki of attemptIndices) {
    const entry = enabledKeys[ki]
    const keyMask = maskApiKey(entry.key)
    attemptedKeys++
    try {
      log('info', `${tag} key#${ki + 1} ${keyMask} → 官方地址`)
      // 瞬时错误自动重试：对同一 key 的瞬时 5xx / 网络抖动重试 1 次，
      // 消除"偶发 500，客户端重试一次又正常"的体验问题。
      let response = await sendTo(officialUrl, entry.key)
      let transientRetries = 0
      while (isTransientStatus(response.status) && transientRetries < TRANSIENT_RETRY_MAX) {
        transientRetries++
        log('warn', `${tag} key#${ki + 1} ${keyMask} 瞬时 ${response.status}，重试 ${transientRetries}/${TRANSIENT_RETRY_MAX}`)
        await sleep(TRANSIENT_RETRY_DELAY_MS * transientRetries)
        response = await sendTo(officialUrl, entry.key)
      }
      if (response.ok) {
        markKeySuccess(entry.key)
        log('info', `${tag} key#${ki + 1} ${keyMask} → 200 成功`)
        return { response, shape }
      }

      officialFailure = await storeFailure(response)
      // per-key 冷却（P1-1）：401 / ≥500 记冷却；403 需区分——FreeTierError 是免费档
      // 形状校验，给 key 记冷却会把整个提供商打死，故只对「非免费档拒绝」的 403 冷却。
      if (response.status === 401 || response.status >= 500) {
        const cooldown = markKeyFailure(entry.key, parseRetryAfterMs(response.headers))
        log('warn', `${tag} key#${ki + 1} ${keyMask} → ${response.status}，冷却 ${Math.round(cooldown / 1000)}s`)
      } else if (response.status === 403 && !isFreeTierFailure(officialFailure)) {
        const cooldown = markKeyFailure(entry.key, parseRetryAfterMs(response.headers))
        log('warn', `${tag} key#${ki + 1} ${keyMask} → 403（非免费档拒绝），冷却 ${Math.round(cooldown / 1000)}s`)
      }
      // 429 短时限流：记 key 冷却，对同一 key 短暂等待后重试，几次后仍失败再切换下一个 key
      if (response.status === 429) {
        const cooldown = markKeyFailure(entry.key, parseRetryAfterMs(response.headers))
        log('warn', `${tag} key#${ki + 1} ${keyMask} 触发 429，冷却 ${Math.round(cooldown / 1000)}s，开始限流重试（最多 ${OPENCODE_RATE_LIMIT_RETRIES} 次）`)
        let lastStatus = 429
        for (let i = 1; i <= OPENCODE_RATE_LIMIT_RETRIES; i++) {
          await sleep(OPENCODE_RATE_LIMIT_RETRY_BASE_MS * i)
          const retry = await sendTo(officialUrl, entry.key)
          if (retry.ok) {
            markKeySuccess(entry.key)
            log('info', `${tag} key#${ki + 1} ${keyMask} 限流重试 ${i} → 200 成功`)
            return { response: retry, shape }
          }
          officialFailure = await storeFailure(retry)
          lastStatus = retry.status
          if (retry.status !== 429) break
        }
        // 重试后仍 429：等待后再尝试下一个 key（或镜像）
        if (lastStatus === 429) {
          keysExhaustedBy429++
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
        if (lastStatus === 401 || lastStatus >= 500 || (lastStatus === 403 && officialFailure && !isFreeTierFailure(officialFailure))) {
          markKeyFailure(entry.key)
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
      const cooldown = markKeyFailure(entry.key)
      log('warn', `${tag} key#${ki + 1} ${keyMask} 网络异常：${(error instanceof Error && error.message) ? error.message.substring(0, 200) : String(error).substring(0, 200)}，冷却 ${Math.round(cooldown / 1000)}s 并重试`)
      let netRetries = 0
      let netRecovered = false
      while (netRetries < TRANSIENT_RETRY_MAX) {
        netRetries++
        await sleep(TRANSIENT_RETRY_DELAY_MS * netRetries)
        try {
          const retry = await sendTo(officialUrl, entry.key)
          if (retry.ok) {
            markKeySuccess(entry.key)
            log('info', `${tag} key#${ki + 1} ${keyMask} 网络重试 ${netRetries} → 200 成功`)
            return { response: retry, shape }
          }
          if (isTransientStatus(retry.status)) {
            officialFailure = await storeFailure(retry)
            log('warn', `${tag} key#${ki + 1} ${keyMask} 网络重试 ${netRetries} → ${retry.status}（瞬时），继续重试`)
            continue
          }
          // 重试返回确定性错误，按原逻辑处理
          officialFailure = await storeFailure(retry)
          if (retry.status === 429) {
            keysExhaustedBy429++
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

  // 本轮尝试过的 key 全部因 429 失败 → 触发官方地址熔断，避免后续请求白等 key 重试
  if (attemptedKeys > 0 && keysExhaustedBy429 === attemptedKeys) {
    official429Until = Date.now() + OPENCODE_OFFICIAL_429_COOLDOWN_MS
    log('warn', `${tag} 尝试的 ${attemptedKeys} 个 key 均因 429 失败，触发官方地址熔断 ${OPENCODE_OFFICIAL_429_COOLDOWN_MS / 1000}s`)
  }
  } // end if (!skipOfficial)

  // 所有 key 都失败，回退到镜像 public 模式
  const mirrors = getMirrorOrder(options.mirrorUrls, random)
  if (mirrors.length > 0) {
    log('warn', `${tag} 所有 key 均失败，回退到 public 镜像（共 ${mirrors.length} 个）`)
  }
  for (const mirror of mirrors) {
    try {
      log('info', `${tag} public 镜像 → ${mirror}`)
      const response = await sendTo(buildUrl(mirror, options.subPath, options.search), 'public')
      if (response.ok) {
        log('info', `${tag} public 镜像 ${mirror} → 200 成功`)
        return { response, shape }
      }
      log('warn', `${tag} public 镜像 ${mirror} → ${response.status}`)
      mirrorFailure = await storeFailure(response)
    } catch (error) {
      lastTransportError = error
      log('warn', `${tag} public 镜像 ${mirror} 网络异常：${(error instanceof Error && error.message) ? error.message.substring(0, 200) : String(error).substring(0, 200)}`)
    }
  }

  if (officialFailure) return { response: restoreFailure(officialFailure), shape }
  if (mirrorFailure) return { response: restoreFailure(mirrorFailure), shape }
  return { response: transportErrorResponse(lastTransportError), shape }
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

/** 单 key 诊断结论（对齐 opencode2api internal/admin/debug.go:241-258 的 key_test 分类） */
export type OpenCodeKeyStatus =
  | 'usable'
  | 'rejected'
  | 'rate_limited'
  | 'transport_error'
  | 'upstream_error'
  | 'request_error'
  | 'unavailable'

export interface OpenCodeKeyTestResult {
  status: OpenCodeKeyStatus
  message: string
  httpStatus?: number
  latencyMs: number
}

/**
 * 单 key 诊断：钉住指定 key 发一次整形后的最小推理请求——不轮换、不走镜像、不重试，
 * 因此结论只反映这一个 key（移植 opencode2api debug.go 的 selected-key 判定）。
 * 与 fetchOpenCodeModels 的区别：后者只能判「key 能不能拉模型列表」，
 * 无法区分「key 无效」与「被限流 / 被免费档拒 / 模型不可用」。
 */
export async function testOpenCodeKey(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  fetcher?: typeof fetch,
): Promise<OpenCodeKeyTestResult> {
  if (!modelId) {
    return { status: 'unavailable', message: '未指定模型，无法发起诊断请求', latencyMs: 0 }
  }
  const f = fetcher ?? fetch
  const shaped = shapeOpenCodeForcedBody(
    JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    'chat/completions',
  )
  const startedAt = Date.now()
  let response: Response
  try {
    response = await requestUpstream(
      f,
      buildUrl(baseUrl, 'chat/completions'),
      apiKey,
      'POST',
      shaped.body,
      createOpenCodeId('msg'),
      createOpenCodeId('ses'),
    )
  } catch (error) {
    return {
      status: 'transport_error',
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    }
  }
  const latencyMs = Date.now() - startedAt
  if (response.ok) {
    // 上游必回 SSE；判定可用即可，立刻取消，避免白烧上游 token
    try { await response.body?.cancel() } catch { /* ignore */ }
    return { status: 'usable', message: '连接成功', httpStatus: response.status, latencyMs }
  }
  const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
  const base = { message: `HTTP ${response.status}: ${text}`, httpStatus: response.status, latencyMs }
  if (response.status === 401) return { status: 'rejected', ...base }
  if (response.status === 429) return { status: 'rate_limited', ...base }
  if (response.status >= 500) return { status: 'upstream_error', ...base }
  // 400 / 403 / 404 / 422：请求侧问题（模型不可用、免费档形状、地区限制），与 key 有效性无关
  return { status: 'request_error', ...base }
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
