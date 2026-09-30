/**
 * credit-expiry.ts — 「优先消耗快到期的积分」共享判定（workbuddy / trae 账号池共用）。
 *
 * 需求背景（2026-09-28）：多账号登录时挑号原按「积分高低」决定，但积分带到期时间，
 * 高分号若排在低分号之后才被消耗，可能整包过期作废。现改为两段式：
 *   1) 若存在「窗口期内（默认 7 天）有积分到期且仍有剩余」的账号 → 只在其中挑，
 *      且到期越早越优先；
 *   2) 否则回落到原有「积分高低」规则（池侧行为完全不变）。
 *
 * 本模块只做**纯计算**（不碰 KV / 网络 / 上游），两个池各自提供自己的到期数据源：
 *   - trae：state.packs（expireAt 为 Unix 秒，rem 为剩余额度）
 *   - workbuddy：state.packages（expireAt 为 CST 墙钟字符串，remain = size − used）
 */

/** 优先窗口：7 天。窗口内的到期积分优先消耗，窗口外按原规则。 */
export const CREDIT_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 解析上游 `"YYYY-MM-DD HH:mm:ss"`（**CST 墙钟**，无时区后缀）为 epoch ms。
 * 为什么必须显式按 +08:00 解释：Cloudflare Workers 运行时本地时区恒为 UTC，
 * `Date.parse('2026-09-30 23:59:59')` 会被当成 UTC，整整错 8 小时（跨窗口边界会误判）。
 * 与 workbuddy-upstream.parseSoftRateReset 同一口径（CST 固定 +8，中国无夏令时）。
 *
 * 兼容两种额外形态：带 `UTC+8` 后缀的同一格式；带显式时区/`Z` 的 ISO 串（交给 Date.parse）。
 * 空串 / 非法 / 非字符串 → null（语义 = 长期有效或未知，不参与优先）。
 */
export function parseCstWallClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*UTC\+8)?$/)
  if (m) {
    const ms = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]) - 8,
      Number(m[5]),
      m[6] ? Number(m[6]) : 0
    )
    return Number.isFinite(ms) ? ms : null
  }
  // 带显式偏移/Z 的 ISO 串：本地时区不参与解释，直接交给 Date.parse
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** 一条「带到期时间的积分」记录。 */
export interface CreditExpiryEntry {
  /** 到期时刻 epoch ms；null / 0 / 非法 = 长期有效或未知（不参与优先） */
  expireAt: number | null
  /** 剩余可用额度；<= 0 视为无剩余（不参与优先） */
  remain: number
}

/**
 * 「窗口期内到期且仍有剩余」的最早到期时刻（epoch ms）；没有则 null。
 *
 * 排除口径（四条都必须满足才计入）：
 *  - expireAt 为有限正数（长期/未知不参与——它们本来就不过期，无需救）；
 *  - expireAt **大于** now（已过期包不可再用，不参与）；
 *  - expireAt **不晚于** now + windowMs（窗口边界含等号：正好 7 天后到期算窗口内）；
 *  - remain > 0（已用尽的包不参与，避免把空包当成"即将作废的积分"）。
 */
export function soonestExpiringAt(
  entries: readonly CreditExpiryEntry[] | null | undefined,
  now: number,
  windowMs: number = CREDIT_EXPIRY_WINDOW_MS
): number | null {
  if (!entries || entries.length === 0) return null
  const limit = now + windowMs
  let best: number | null = null
  for (const e of entries) {
    if (!e) continue
    const at = e.expireAt
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    if (at <= now || at > limit) continue
    if (!(e.remain > 0)) continue
    if (best === null || at < best) best = at
  }
  return best
}
