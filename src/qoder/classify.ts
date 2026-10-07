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
export type QoderErrorKind = 'quota' | 'rate_limit' | 'auth' | 'not_ready' | 'unavailable' | 'content_policy'

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

/**
 * 内容安全审核标记（移植 qoder2api internal/bridge/errors.go:62-68 contentPolicyMarkers）。
 * 上游日志实证形态：`InternalError.Algo.DataInspectionFailed: Input text data may contain
 * inappropriate content.`——这是**确定性拒绝**（用户输入侧问题），重试必然再失败。
 */
const CONTENT_POLICY_MARKERS = [
  'datainspectionfailed',
  'inappropriate content',
  'input text data may contain',
  'contentfilter',
  'sensitivecontent',
]

function contentPolicyLike(lower: string): boolean {
  return CONTENT_POLICY_MARKERS.some((m) => lower.includes(m))
}

/**
 * 上游排队已满（qoder2api-hub v1.1.9 PR#7 实测形态，线上复现）：
 *   信封 statusCodeValue=403 + body
 *   `{"code":"10605","message":"{\"isQueued\":true,\"queueCount\":0,\"queueType\":\"p3\",
 *     \"retryAfterSeconds\":30,\"serviceAvailable\":false,\"waitTime\":30}"}`
 *
 * 语义是**上游容量/优先级**：免费号进 p3 队列被拒，不是凭证故障。
 * 必须与 auth 分开——落到 auth 会被 pool 当成「token 失效」**永久禁用账号**
 * （pool.ts disableQoderAccount），一次排队就把好账号打死，且签到不会解冻。
 */
function queueFullLike(lower: string): boolean {
  return lower.includes('10605') || lower.includes('isqueued')
}

/**
 * 从错误体解析上游给出的排队重试秒数。
 * 信封层没有 Retry-After 头，重试时长只在 body 的 retryAfterSeconds 里
 * （hub qoder_proxy.py:2630-2636 同口径）；上限对齐 MAX_RETRY_AFTER_MS。
 */
function parseQueueRetrySeconds(body: string): number | null {
  const m = /retryafterseconds\D{0,6}(\d+)/i.exec(body)
  if (!m) return null
  const sec = Number(m[1])
  if (!Number.isFinite(sec) || sec <= 0) return null
  return Math.min(sec, MAX_RETRY_AFTER_MS / 1000)
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
  const queueFull = queueFullLike(lower)

  let k: QoderErrorKind
  if (kindFromBody) {
    k = (['quota', 'rate_limit', 'auth', 'not_ready', 'unavailable', 'content_policy'] as QoderErrorKind[]).includes(
      kindFromBody as QoderErrorKind
    )
      ? (kindFromBody as QoderErrorKind)
      : 'unavailable'
  } else if (contentPolicyLike(lower)) {
    // 内容审核先于瞬时判断：它是确定性拒绝，误判为 unavailable 会让客户端收到 502 + 重试指引，
    // 而重试必然再被拒（源 errors.go:167-173 显式把该分支放在瞬时判断之前）
    k = 'content_policy'
  } else if (queueFull) {
    // 排队已满（10605）必须排在 authLike/`status === 403` 之前：
    // 它的信封状态也是 403，落到 auth 会让 pool 永久禁用账号（本分支即为此而设）
    k = 'rate_limit'
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
      if (queueFull) {
        // 冷却时长优先取 body 里的 retryAfterSeconds（信封层没有 Retry-After 头）
        out.cooldownSeconds = parseQueueRetrySeconds(body) ?? parseRetryAfter(retryAfter, 60 * 1000) / 1000
        out.code = firstNonEmpty(code, '10605')
        out.type = 'upstream_queue_full'
      } else {
        out.cooldownSeconds = parseRetryAfter(retryAfter, 60 * 1000) / 1000
      }
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
    case 'content_policy':
      // 400 = 用户输入问题，客户端应改输入而非重试；不换账号（换号也会被同样拒绝）
      out.status = 400
      out.failover = false
      out.cooldownSeconds = 0
      out.code = firstNonEmpty(code, 'content_policy_rejected')
      out.type = 'content_policy_rejected'
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
  if (k === 'content_policy') {
    // 无条件用中文解释覆盖上游原文，但把上游详情附在尾部（源 FriendlyUpstreamError 同形）
    const detail = out.message.slice(0, 300)
    out.message =
      '上游内容安全审核未通过 (DataInspectionFailed)：输入可能含不当内容，属确定性拒绝、重试无效。' +
      '请检查/缩短输入（系统提示词、超长历史、工具定义或粘贴的代码/文本）后重试。' +
      (detail ? '上游详情：' + detail : '')
  }
  if (queueFull) {
    // 原样回显上游嵌套 JSON 时面板读不出「该做什么」，且会被误当账号坏了。
    // 明示三件事：是上游排队（非账号/鉴权故障）、已冷却多久、稍后重试即可。
    const detail = out.message.slice(0, 200)
    out.message =
      '上游排队已满（10605 / isQueued）：本次请求被上游放入低优先级队列并拒绝，' +
      '属上游容量与优先级问题，不是账号或鉴权故障。' +
      `已按上游要求冷却 ${out.cooldownSeconds}s 并轮换账号，稍后重试即可。` +
      (detail ? '上游详情：' + detail : '')
  }
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

// ===== 信封内层错误可观测性（hub qoder_proxy.py task-34 / v1.2.6 563346c） =====

/**
 * 内层错误的归类标签（用于首次告警去重与计数）。
 *
 * 与 `QoderErrorKind` 分开：后者是**面向客户端**的错误语义（决定 HTTP 状态码与是否换号），
 * 这里是**面向排障**的形态标签，只进日志。两者刻意不合并——内层错误的外层信封是 200，
 * 直接套用 QoderErrorKind 会把「上游藏在 200 里的失败」说成正常响应。
 */
export type QoderInnerErrorKind = 'content_policy' | 'rate_limit' | 'invalid_request' | 'auth' | 'other'

/**
 * 内层错误里「请求本身有问题」的标记。
 *
 * `must be a response` 是实测原文（hub task-34）：
 * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`
 * ——上游对畸形工具历史的拒绝形态，正是 body.ts 丢弃 tool_call_id 时触发的报错。
 */
const INVALID_REQUEST_MARKERS = [
  'invalid_request',
  'invalid-parameter',
  'invalid_parameter',
  'provider_error',
  'must be a response',
  'unsupported',
  'not found',
  'bad request',
]

/**
 * 把内层错误归类。返回 '' 表示「不是错误形态」（正常 chunk）。
 *
 * 判定顺序对齐 hub `_inner_error_kind`：内容审核 → 限流 → 请求畸形 → 鉴权 → 其它。
 * 顺序有意义：内容审核文案里常同时出现别的关键词，放最后会被误判成 invalid_request。
 */
export function classifyQoderInnerError(code: string, message: string): QoderInnerErrorKind | '' {
  const lower = `${code} ${message}`.toLowerCase().trim()
  if (!lower) return ''
  if (contentPolicyLike(lower)) return 'content_policy'
  if (queueFullLike(lower) || rateLike(lower)) return 'rate_limit'
  if (INVALID_REQUEST_MARKERS.some((m) => lower.includes(m))) return 'invalid_request'
  if (authLike(lower)) return 'auth'
  return 'other'
}

/**
 * 从内层 chunk 的 JSON 文本里读出错误指示。返回 null = 正常 chunk。
 *
 * 兼容三种形态（hub `note_inner_upstream_error`）：
 *   - `{"error":{"code":..,"message":..}}`（标准 OpenAI 错误体）
 *   - `{"error":"<纯文本>"}`
 *   - 无 error 字段 → 正常
 */
export function qoderInnerErrorDetail(rawChunk: string): { kind: QoderInnerErrorKind; code: string; message: string } | null {
  let obj: any
  try {
    obj = JSON.parse(rawChunk)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const err = obj.error
  let code = ''
  let msg = ''
  if (err && typeof err === 'object') {
    code = String(err.code || err.type || '')
    msg = String(err.message || '')
  } else if (typeof err === 'string') {
    msg = err
  } else {
    return null
  }
  const kind = classifyQoderInnerError(code, msg)
  if (!kind) return null
  return { kind, code, message: msg }
}

/**
 * 内层错误 → 结构化分类（供**非流式**路径把「被 200 信封藏住的失败」如实报给客户端）。
 *
 * 为什么不直接 `classifyQoderError({ status: 200, body })`：那条路径按**信封**语义分类，
 * 对 `invalid_request_error` 会落到 `unavailable` → 502 且 `failover=true`，于是池循环会
 * 为一个**请求形状**问题去冷却并轮换其它账号，白烧它们的配额（这正是 content_policy
 * 分支存在的原因）。内层错误的 kind 已知，直接按它定状态码与是否换号，不猜。
 *
 * 映射：
 *   - content_policy / invalid_request → 400 且**不换号**（换号必然被同样拒绝）
 *   - rate_limit / auth                → 沿用既有语义（429 / 403）并允许换号
 *   - other                            → 502，允许换号
 */
export function qoderInnerErrorClassified(
  kind: QoderInnerErrorKind,
  code: string,
  message: string
): QoderClassified {
  const detail = message.trim().slice(0, 300)
  const base = {
    failover: true,
    cooldownSeconds: 0,
    code: firstNonEmpty(code, 'upstream_error'),
    type: 'upstream_error',
  }
  switch (kind) {
    case 'content_policy':
      return {
        ...base,
        status: 400,
        kind: 'content_policy',
        failover: false,
        code: firstNonEmpty(code, 'content_policy_rejected'),
        type: 'content_policy_rejected',
        message:
          '上游内容安全审核未通过（错误被藏在 HTTP 200 信封内层）：输入可能含不当内容，属确定性拒绝、重试无效。' +
          (detail ? '上游详情：' + detail : ''),
      }
    case 'invalid_request':
      // 请求形状问题（如工具历史缺配对 id）。换号无用，且会把畸形请求重放到别的账号上。
      return {
        ...base,
        status: 400,
        kind: 'unavailable',
        failover: false,
        code: firstNonEmpty(code, 'invalid_request_error'),
        type: 'invalid_request_error',
        message:
          '上游拒绝了本次请求（错误被藏在 HTTP 200 信封内层，非账号故障、重试无效）：' +
          (detail || '请求体不被上游接受'),
      }
    case 'rate_limit':
      return {
        ...base,
        status: 429,
        kind: 'rate_limit',
        cooldownSeconds: 60,
        code: firstNonEmpty(code, 'rate_limit_exceeded'),
        type: 'rate_limit_exceeded',
        message: '上游限流（错误被藏在 HTTP 200 信封内层）：' + (detail || '稍后重试'),
      }
    case 'auth':
      return {
        ...base,
        status: 403,
        kind: 'auth',
        code: firstNonEmpty(code, 'unauthorized'),
        message: '上游鉴权失败（错误被藏在 HTTP 200 信封内层）：' + (detail || '请重新登录该账号'),
      }
    default:
      return {
        ...base,
        status: 502,
        kind: 'unavailable',
        message: '上游返回错误（被藏在 HTTP 200 信封内层）：' + (detail || '上游未给出详情'),
      }
  }
}

/**
 * 内层错误计数快照（总数 + 按类别 + 已告警类别）。
 *
 * 为什么用模块级状态：Workers 每个 isolate 一份，只作**排障计数**用，不做跨 isolate 聚合
 * （那需要 KV/DO，属另一件事）。这与 hub 的进程内计数语义等价。
 */
export interface QoderInnerErrorSnapshot {
  total: number
  kinds: Partial<Record<QoderInnerErrorKind, number>>
  warned: QoderInnerErrorKind[]
}

const innerErrorStats: { total: number; kinds: Partial<Record<QoderInnerErrorKind, number>>; warned: Set<QoderInnerErrorKind> } = {
  total: 0,
  kinds: {},
  warned: new Set(),
}

export function qoderInnerErrorSnapshot(): QoderInnerErrorSnapshot {
  return { total: innerErrorStats.total, kinds: { ...innerErrorStats.kinds }, warned: [...innerErrorStats.warned] }
}

/** 仅测试用：清空计数，避免用例之间互相污染。 */
export function resetQoderInnerErrorStats(): void {
  innerErrorStats.total = 0
  innerErrorStats.kinds = {}
  innerErrorStats.warned.clear()
}

/**
 * 观测一个内层 chunk 里的错误：计数 + **按类别首次**告警，返回命中类别（未命中返回 ''）。
 *
 * 为什么必须按类别只告警一次：这类错误是**每帧重复**的（上游把同一错误塞进多帧），
 * 逐帧打日志会把日志刷爆，反而让真正的首因被埋掉。计数继续累加，只压日志。
 *
 * 只观测、不改行为：调用方照常走清洗/透传/聚合分支。是否把内层错误升级成可见错误
 * 由调用点按路径决定（流式已原样透传给客户端，非流式会聚合掉，见 proxy.ts）。
 */
export function noteQoderInnerError(rawChunk: string, context?: string): QoderInnerErrorKind | '' {
  const detail = qoderInnerErrorDetail(rawChunk)
  if (!detail) return ''
  const kind = detail.kind
  innerErrorStats.total++
  innerErrorStats.kinds[kind] = (innerErrorStats.kinds[kind] || 0) + 1
  if (!innerErrorStats.warned.has(kind)) {
    innerErrorStats.warned.add(kind)
    // 截断到 300 字符：够定位，且不把内层正文（可能含用户内容）整段写进日志
    console.warn(
      `[qoder-inner-error] kind=${kind}${context ? ` ctx=${context}` : ''} total=${innerErrorStats.total} | ${rawChunk.slice(0, 300)}`
    )
  }
  return kind
}