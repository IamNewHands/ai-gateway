/**
 * upstream-user-agent.ts — 提供商级出站 User-Agent 覆写。
 *
 * 背景：部分中转/聚合上游按**客户端指纹**鉴权，而不是只看 API Key。UA 不在其
 * 白名单时直接回 401（例如 agentrouter 的 `unauthorized_client_error`：未带 key
 * 与带正确 key 的响应逐字相同，因为拒绝发生在密钥校验之前）。这类上游只能靠
 * 改写 UA 通过，而客户端（如 DeepSeek Harness）的 UA 反而会被固定的
 * `attributionHeaders()` 强制写回，客户端侧无解。
 *
 * 本模块只提供两件纯函数能力，供 provider 配置与出站转发共用：
 *  1. `normalizeUpstreamUserAgent` —— 落库前校验，拒绝无法作为单行 HTTP 头值的输入；
 *  2. `setHeaderCaseInsensitive` —— 大小写无关地**替换**同名头。
 *
 * 第 2 点是关键：`buildPassthroughHeaders` 会把客户端发来的 `user-agent`
 * （小写，来自 `PASSTHROUGH_HEADER_PREFIXES` 的 `user-` 前缀）原样带进出站头字典，
 * 若直接 `headers['User-Agent'] = x` 会与 `user-agent` 并存，最终取哪个由
 * fetch 实现决定。先删后写保证覆写生效。
 */

/** 上游 User-Agent 覆写的字节上限（HTTP 头值远小于此，留足自定义注释空间）。 */
export const UPSTREAM_USER_AGENT_MAX_BYTES = 512

/**
 * 校验并规整一个上游 User-Agent 覆写值。
 *
 * - 空串/纯空白 → `''`（调用方据此清除已有配置）
 * - 含 CR / LF / NUL 或其他不可打印 ASCII（保留可打印 ASCII 0x20–0x7E）
 *   → `null`（非法），防止头注入与无法预测的上游行为
 * - UTF-8 字节数超过 {@link UPSTREAM_USER_AGENT_MAX_BYTES} → `null`
 */
export function normalizeUpstreamUserAgent(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return ''
  if (!/^[\x20-\x7E]+$/.test(value)) return null
  if (new TextEncoder().encode(value).length > UPSTREAM_USER_AGENT_MAX_BYTES) return null
  return value
}

/**
 * 在出站头字典里按**大小写无关**方式替换同名头：先删除所有同名键（任意大小写），
 * 再以 `name` 原样写入。这样既覆盖透传来的客户端 UA，也不留下重复头。
 */
export function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const target = name.toLowerCase()
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === target) delete headers[existing]
  }
  headers[name] = value
}

/**
 * 出站请求头覆写表里**禁止**出现的头名（小写比较）。
 *
 * 这些头改了只会把请求弄坏，或把凭据/连接语义搞乱，因此落库前直接拒绝，
 * 而不是等上游回一个莫名其妙的 400：
 * - `host` / `content-length` / `content-encoding`：由 fetch 按实际请求体生成，写死必错；
 * - `connection` / `transfer-encoding` / `upgrade` / `te` / `trailer` / `keep-alive` /
 *   `proxy-*`：逐跳头，网关改写没有意义；
 * - `authorization` / `x-api-key` / `cookie` / `proxy-authorization`：鉴权头由凭据池管理，
 *   手写会覆盖真实密钥或泄露凭据；
 * - `accept-encoding`：**显式设置会关闭 Workers 的自动解压**，上游压缩响应将解析失败。
 */
export const FORBIDDEN_UPSTREAM_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-encoding',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'proxy-authenticate',
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'expect',
  'accept-encoding',
])

/** RFC 7230 token：头名允许的字符集。 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export type NormalizeHeadersResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string }

/**
 * 校验并规整一张出站请求头覆写表。
 *
 * - 头名必须是合法 token 且不在 {@link FORBIDDEN_UPSTREAM_HEADERS} 内；
 * - 值必须是单行可打印 ASCII（0x20–0x7E），UTF-8 ≤ 512 字节；
 * - 值为空串 → **跳过**（用来在界面上把某个头「留空即不覆写」，不必删行）；
 * - 同名头（大小写不同）后者覆盖前者。
 *
 * 返回的字典保留调用方书写的原始大小写。
 */
export function normalizeUpstreamHeaders(raw: unknown): NormalizeHeadersResult {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '出站请求头必须是对象（{ "头名": "值" }）' }
  }
  const value: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(rawName).trim()
    if (name === '') return { ok: false, message: '出站请求头的头名不能为空' }
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, message: `出站请求头「${name}」含非法字符（头名只允许 RFC 7230 token 字符）` }
    }
    const lower = name.toLowerCase()
    if (FORBIDDEN_UPSTREAM_HEADERS.has(lower)) {
      return {
        ok: false,
        message: `出站请求头「${name}」不允许覆写（由运行时或凭据池管理，改写会破坏请求）`,
      }
    }
    const text = String(rawValue ?? '').trim()
    if (text === '') continue
    if (!/^[\x20-\x7E]+$/.test(text)) {
      return { ok: false, message: `出站请求头「${name}」的值必须是单行可打印 ASCII（不含换行/控制字符）` }
    }
    if (new TextEncoder().encode(text).length > UPSTREAM_USER_AGENT_MAX_BYTES) {
      return { ok: false, message: `出站请求头「${name}」的值超过 ${UPSTREAM_USER_AGENT_MAX_BYTES} 字节` }
    }
    // 同名（大小写不同）只留最后一个，避免出站出现重复头
    const previous = seen.get(lower)
    if (previous !== undefined) delete value[previous]
    seen.set(lower, name)
    value[name] = text
  }
  return { ok: true, value }
}

/**
 * 把 provider 级出站头配置写进请求头字典（就地修改并返回）。
 *
 * 顺序固定为「先 UA、后覆写表」：表里若也写了 `user-agent`，以表为准（更具体者胜）。
 * 每一项都是大小写无关替换，因此能覆盖掉客户端透传来的同名头。
 */
export function applyUpstreamHeaders(
  headers: Record<string, string>,
  cfg: { upstreamUserAgent?: string; upstreamHeaders?: Record<string, string> },
): Record<string, string> {
  if (cfg.upstreamUserAgent) setHeaderCaseInsensitive(headers, 'User-Agent', cfg.upstreamUserAgent)
  for (const [name, value] of Object.entries(cfg.upstreamHeaders || {})) {
    if (value === '') continue
    setHeaderCaseInsensitive(headers, name, value)
  }
  return headers
}
