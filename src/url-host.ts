/**
 * url-host.ts — baseUrl → 主机判定（唯一实现）。
 *
 * 为什么必须解析后精确比对：`baseUrl.includes('chat.deepseek.com')` 这种子串判定
 * 会把 `https://evil.com/?u=chat.deepseek.com`、`https://chat.deepseek.com.evil.com`
 * 一并认成自家上游（CWE-20），CodeQL `js/incomplete-url-substring-sanitization`
 * 报的就是它。解析失败（空串 / 非 URL / 相对路径）一律返回 false，绝不猜测。
 *
 * 只做 hostname 精确比对：调用方要的是「这个 baseUrl 是不是指向某固定主机」，
 * 子域/路径/端口差异都不算命中（端口不影响 hostname 比较）。
 */
export function baseUrlHostIs(baseUrl: unknown, host: string): boolean {
  if (typeof baseUrl !== 'string' || baseUrl === '') return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() === host
  } catch {
    return false
  }
}