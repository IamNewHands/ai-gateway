/**
 * classify.ts — Qoder 上游错误分类（移植自 caigee-cmd/cli2api internal/accounts/classify.go）。
 *
 * 把上游的错误体分类为 quota / rate_limit / auth / not_ready / unavailable，
 * 并据此推导：
 *   - 对客户端返回的 HTTP 状态码（quota→429，auth→401/403，not_ready→503，其余沿用上游或 502）
 *   - 是否应 failover（切换/重试其他账号）
 *   - 推荐的冷却时长（优先上游 Retry-After，封顶 10 分钟）
 *   - 结构化的 OpenAI 错误类型（error.code / error.type / error.kind）
 *
 * 与 WorkBuddy / TRAE / M365 的"错误分类 + 冷却"能力对齐，让 Qoder 也能给客户端
 * 返回可识别、可重试的标准 OpenAI 错误，而不是笼统的 upstream_error。
 */

/** 错误分类种类（对应 cli2api accounts.Kind*）。 */
export type QoderErrorKind = 'quota' | 'rate_limit' | 'auth' | 'not_ready' | 'unavailable'

export interface QoderClassified {
  /** 对客户端返回的 HTTP 状态码 */
  status: number
  kind: QoderErrorKind
  /** 是否应由上层做故障转移（换账号 / 重试） */
  failover: boolean
  /** 推荐冷却秒数（含 Retry-After，封顶 600s） */
  cooldownSeconds: number
  message: string
  code: string
  type: string
}

const MAX_RETRY_AFTER_MS = 10 * 60 * 1000

/** 解析 Retry-After：支持秒数或 RFC1123 时间；封顶 10 分钟；fallback<0 返回 0。 */
function parseRetryAfter(raw: string | undefined, fallbackMs: number): number {
  const text = (raw || '').trim()
  if (text) {
    const sec = Number(text)
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(sec * 1000, MAX_RETRY_AFTER_MS)
    }
    const t = new Date(text).getTime()
    if (!Number.isNaN(t)) {
      const d = t - Date.now()
      if (d > 0) return Math.min(d, MAX_RETRY_AFTER_MS)
    }
  }
  if (fallbackMs < 0) return 0
  return Math.min(fallbackMs, MAX_RETRY_AFTER_MS)
}

/** 从错误体提取 {msg, code, type, kind}。兼容嵌套 error 对象或平铺字段。 */
function extractError(body: string): { msg: string; code: string; type: string; kind: string } {
  const text = body.trim()
  if (!text) return { msg: '', code: '', type: '', kind: '' }
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(text)
  } catch {
    return { msg: text, code: '', type: '', kind: '' }
  }
  if (parsed && typeof parsed === 'object') {
    const errObj = parsed.error
    if (errObj && typeof errObj === 'object') {
      return {
        msg: String(errObj.message || ''),
        code: String(errObj.code || ''),
        type: String(errObj.type || ''),
        kind: String(errObj.kind || ''),
      }
    }
    const msg = typeof parsed.message === 'string' ? parsed.message : ''
    const code = typeof parsed.code === 'string' ? parsed.code : ''
    const type = typeof parsed.type === 'string' ? parsed.type : ''
    const kind = typeof parsed.kind === 'string' ? parsed.kind : ''
    if (msg || code) return { msg, code, type, kind }
  }
  return { msg: text, code: '', type: '', kind: '' }
}

function quotaLike(lower: string, code: string, type: string): boolean {
  if (code === 'insufficient_quota' || type === 'insufficient_quota') return true
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('token-limit') ||
    lower.includes('#token-limit') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('oversized prompt') ||
    lower.includes('local precheck rejected')
  )
}

function rateLike(lower: string): boolean {
  return (
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('response code=429') ||
    lower.includes('account busy') ||
    lower.includes('in-flight')
  )
}

function authLike(lower: string): boolean {
  return (
    lower.includes('null pointer') ||
    lower.includes('forbidden') ||
    lower.includes('duplicate request') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('credential') ||
    lower.includes('refresh token') ||
    lower.includes('access token')
  )
}

function notReadyLike(lower: string): boolean {
  return (
    lower.includes('hot context not ready') ||
    lower.includes('auth manager not captured') ||
    lower.includes('not ready')
  )
}

function firstNonEmpty(...values: string[]): string {
  for (const v of values) {
    const t = v.trim()
    if (t) return t
  }
  return ''
}

/**
 * classifyQoderError：把上游原始错误分类为结构化 QoderClassified。
 * @param status 上游 HTTP 状态码
 * @param body 上游错误体（JSON 或纯文本）
 * @param retryAfter 上游 Retry-After 头（可选）
 * @param kindHint 上游/网关提供的明确分类（可选，优先于此）
 * @param failoverHint '0'=禁止 failover；'1'=强制 failover；其余自动
 */
export function classifyQoderError(opts: {
  status: number
  body: string
  retryAfter?: string
  kindHint?: string
  failoverHint?: string
}): QoderClassified {
  const { status, body, retryAfter, kindHint, failoverHint } = opts
  const { msg, code, type, kind } = extractError(body)
  const kindFromBody = kindHint || kind
  const lower = (msg + ' ' + code + ' ' + type).toLowerCase()

  let k: QoderErrorKind
  if (kindFromBody) {
    k = (['quota', 'rate_limit', 'auth', 'not_ready', 'unavailable'] as QoderErrorKind[]).includes(
      kindFromBody as QoderErrorKind
    )
      ? (kindFromBody as QoderErrorKind)
      : 'unavailable'
  } else if (quotaLike(lower, code, type)) {
    k = 'quota'
  } else if (notReadyLike(lower)) {
    k = 'not_ready'
  } else if (authLike(lower) && !quotaLike(lower, code, type) && !rateLike(lower)) {
    k = 'auth'
  } else if (rateLike(lower) || status === 429) {
    k = 'rate_limit'
  } else if (status === 401 || status === 403) {
    k = 'auth'
  } else {
    k = 'unavailable'
  }
  // auth / rate_limit 但命中配额信号 → 优先判为配额
  if ((k === 'auth' || k === 'rate_limit') && quotaLike(lower, code, type)) k = 'quota'

  const out: QoderClassified = {
    status: 502,
    kind: k,
    failover: true,
    cooldownSeconds: 0,
    message: msg.trim(),
    code: firstNonEmpty(code, k),
    type: firstNonEmpty(type, 'api_error'),
  }

  switch (k) {
    case 'quota':
      out.status = 429
      out.failover = false
      out.cooldownSeconds = 0
      out.code = firstNonEmpty(code, 'insufficient_quota')
      out.type = 'insufficient_quota'
      break
    case 'rate_limit':
      out.status = 429
      out.failover = true
      out.cooldownSeconds = parseRetryAfter(retryAfter, 60 * 1000) / 1000
      break
    case 'auth':
      out.status = status === 401 ? 401 : 403
      out.failover = true
      out.cooldownSeconds = parseRetryAfter(retryAfter, 30 * 1000) / 1000
      out.code = firstNonEmpty(code, 'unauthorized')
      break
    case 'not_ready':
      out.status = 503
      out.failover = true
      out.cooldownSeconds = parseRetryAfter(retryAfter, 10 * 1000) / 1000
      out.code = firstNonEmpty(code, 'not_ready')
      break
    default:
      out.status = status >= 400 ? status : 502
      out.failover = true
      out.cooldownSeconds = parseRetryAfter(retryAfter, 15 * 1000) / 1000
      out.code = firstNonEmpty(code, 'upstream_error')
  }

  if (failoverHint === '0') out.failover = false
  else if (failoverHint === '1') out.failover = true

  out.cooldownSeconds = Math.round(out.cooldownSeconds)
  if (!out.message) out.message = out.code
  return out
}

/** 生成面向客户端的结构化 OpenAI 错误 JSON。 */
export function qoderOpenAIErrorBody(c: QoderClassified): string {
  const err: Record<string, unknown> = { message: c.message, type: c.type, code: c.code }
  if (c.kind) err.kind = c.kind
  if (c.failover) err.failover = c.failover
  if (c.cooldownSeconds > 0) {
    err.cooldown_seconds = c.cooldownSeconds
    err.retry_after_seconds = c.cooldownSeconds
  }
  return JSON.stringify({ error: err })
}