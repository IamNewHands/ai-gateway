/**
 * credit-expiry.ts — 「优先消耗快到期的积分」共享判定（workbuddy / trae 账号池共用）。
 *
 * 需求背景（2026-09-28）：多账号登录时挑号原按「积分高低」决定，但积分带到期时间，
 * 高分号若排在低分号之后才被消耗，可能整包过期作废。现改为两段式：
 *   1) 若存在「窗口期内（默认 7 天）有积分到期且仍有剩余」的账号 → 只在其中挑，
 *      且到期越早越优先；
 *   2) 否则回落到原有「积分高低」规则（池侧行为完全不变）。
 *
 * 本模块只做**纯计算**（不碰 KV / 网络 / 上游），三个池各自提供自己的到期数据源：
 *   - trae：state.packs（expireAt 为 Unix 秒，rem 为剩余额度）
 *   - workbuddy：state.packages（expireAt 为 CST 墙钟字符串，remain = size − used）
 *   - qoder：state.packages（同 workbuddy 形态；上游给的是 ms 时间戳/ISO 串，
 *     由 billing.buildQoderPacks 用 formatCstWallClock 统一落成同一形态）
 */
import type { PackageInfo } from './types'

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
 * epoch ms → 上游同款 `"YYYY-MM-DD HH:mm:ss"`（**CST 墙钟**，无时区后缀）。
 * `parseCstWallClock` 的逆运算（同一 +08:00 口径），供只拿到 ms 时间戳的池
 * （Qoder：quota/usage 的套餐 expiresAt 是 ms、claim 响应的 expiresAt 是 ISO 串）
 * 落成 `PackageInfo.expireAt`，从而与 workbuddy 共用同一套面板渲染与到期优先判定。
 *
 * 非有限 / <= 0 → 空串（语义 = 长期有效或未知，面板显示「长期」，不参与到期优先）。
 */
export function formatCstWallClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms + 8 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  )
}

/**
 * 单个权益包 → 到期条目：expireAt 为上游 CST 墙钟字符串（按 +08:00 解释），
 * remain = max(0, size − used)。size/used 都缺省（探测不到容量）→ remain 0，不参与优先
 * ——宁可回落积分规则，也不把"包还在但额度未知"当成待救积分去抢占挑号。
 */
export function packageExpiryEntry(p: PackageInfo): CreditExpiryEntry {
  const size = typeof p?.size === 'number' && Number.isFinite(p.size) ? p.size : 0
  const used = typeof p?.used === 'number' && Number.isFinite(p.used) ? p.used : 0
  return { expireAt: parseCstWallClock(p?.expireAt), remain: size - used }
}

/**
 * 一组权益包里「窗口期内到期且仍有剩余」的最早到期时刻（epoch ms）；没有 → null。
 * 数据来自池状态里的 `packages`（签到/刷新时落盘），未探测过 → null，回落积分高低规则。
 */
export function soonestPackageExpiryAt(
  packages: readonly PackageInfo[] | null | undefined,
  now: number,
  windowMs: number = CREDIT_EXPIRY_WINDOW_MS
): number | null {
  if (!packages || packages.length === 0) return null
  const entries: CreditExpiryEntry[] = []
  for (const p of packages) {
    if (!p) continue
    entries.push(packageExpiryEntry(p))
  }
  return soonestExpiringAt(entries, now, windowMs)
}

/**
 * 单条是否属于「窗口期内到期且仍有剩余」——**四条排除口径的唯一定义处**。
 *
 *  - expireAt 为有限正数（长期/未知不参与——它们本来就不过期，无需救）；
 *  - expireAt **大于** now（已过期包不可再用，不参与）；
 *  - expireAt **不晚于** now + windowMs（窗口边界含等号：正好 7 天后到期算窗口内）；
 *  - remain > 0（已用尽的包不参与，避免把空包当成"即将作废的积分"）。
 *
 * `soonestExpiringAt`（挑号用）与 `summarizeExpiringAt`（明细面板用）共用本函数，
 * 否则两处各写一遍判定，任一处改动都会静默漂移成「面板说 3 天后到期、挑号却不理它」。
 */
function isExpiringEntry(e: CreditExpiryEntry | null | undefined, now: number, limit: number): boolean {
  if (!e) return false
  const at = e.expireAt
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
  if (at <= now || at > limit) return false
  return e.remain > 0
}

/**
 * 「窗口期内到期且仍有剩余」的最早到期时刻（epoch ms）；没有则 null。
 * 排除口径见 `isExpiringEntry`。
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
    if (!isExpiringEntry(e, now, limit)) continue
    const at = e.expireAt as number
    if (best === null || at < best) best = at
  }
  return best
}

/** 窗口期内到期积分的汇总（概览「7 天内到期积分」明细一行）。 */
export interface ExpiringCreditSummary {
  /** 窗口内到期且仍有剩余的积分合计；0 = 本渠道窗口内没有待救积分 */
  amount: number
  /** 其中最早到期时刻 epoch ms；无 → null */
  soonestAt: number | null
  /** 计入的权益包条数 */
  packs: number
}

/**
 * 汇总「窗口期内到期且仍有剩余」的积分：合计额度 + 最早到期时刻 + 包数。
 *
 * 与 `soonestExpiringAt` 同源同口径（共用 `isExpiringEntry`），区别只是它把额度加总，
 * 供概览面板回答「哪些渠道有多少积分快作废了」；挑号仍只需要最早时刻。
 */
export function summarizeExpiringAt(
  entries: readonly CreditExpiryEntry[] | null | undefined,
  now: number,
  windowMs: number = CREDIT_EXPIRY_WINDOW_MS
): ExpiringCreditSummary {
  const out: ExpiringCreditSummary = { amount: 0, soonestAt: null, packs: 0 }
  if (!entries || entries.length === 0) return out
  const limit = now + windowMs
  for (const e of entries) {
    if (!isExpiringEntry(e, now, limit)) continue
    const at = e.expireAt as number
    out.amount += e.remain
    out.packs++
    if (out.soonestAt === null || at < out.soonestAt) out.soonestAt = at
  }
  return out
}
