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
