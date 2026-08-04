/**
 * billing.ts — QoderWork 额度 / 签到 / 套餐（移植自 cpa-plugin/qoderwork/billing.go + checkin.go）。
 *
 * 协议：
 *   状态：GET  https://openapi.qoder.com.cn/sash/api/v1/me/daily-check-in/status
 *   签到：POST https://openapi.qoder.com.cn/sash/api/v1/me/daily-check-in/claim（body {}）
 *   额度：GET  https://openapi.qoder.com.cn/api/v2/quota/usage
 *   套餐：GET  https://openapi.qoder.com.cn/api/v2/user/plan
 *   认证：Authorization: Bearer <token>（dt- / jt- 均可），无 COSY 签名（KNOWLEDGE §2）
 *   响应：普通 JSON，无信封
 */

const QODER_API_BASE = 'https://openapi.qoder.com.cn'

/** 统一认证头（billing 端点用明文 Bearer，不需要 COSY）。 */
function billingHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Go-http-client/2.0',
  }
}

/** GET /sash/api/v1/me/daily-check-in/status 响应（普通 JSON）。 */
export interface QoderCheckinStatus {
  status: string // CLAIMABLE | CLAIMED
  rewardCredits?: number
  nextClaimAt?: number // s epoch
  currentStreakDays?: number
  totalClaimDays?: number
  totalRewardCredits?: number
  lastClaimedAt?: number // s epoch
  rewardExpiresAt?: number // s epoch
}

/**
 * 查询签到状态。
 * status=CLAIMED 且 lastClaimedAt 落在今天 → 今日已签到。
 */
export async function fetchQoderCheckinStatus(token: string): Promise<{
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  totalCredits: number
  dailyCredit: number
} | null> {
  const res = await fetch(QODER_API_BASE + '/sash/api/v1/me/daily-check-in/status', {
    method: 'GET',
    headers: billingHeaders(token),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    throw new Error(`checkin status http ${res.status} body=${(await res.text().catch(() => '')).substring(0, 200)}`)
  }
  const q = (await res.json().catch(() => null)) as QoderCheckinStatus | null
  if (!q) throw new Error('checkin status parse failed')

  const today = new Date()
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const lastClaimed = q.lastClaimedAt && q.lastClaimedAt > 0 ? fmt(new Date(q.lastClaimedAt * 1000)) : ''
  const todayCheckedIn = q.status === 'CLAIMED' && lastClaimed === fmt(today)

  return {
    active: q.status === 'CLAIMABLE' || q.status === 'CLAIMED',
    todayCheckedIn,
    streakDays: q.currentStreakDays || 0,
    totalCredits: q.totalRewardCredits || 0,
    dailyCredit: todayCheckedIn ? q.rewardCredits || 0 : 0,
  }
}

/**
 * 执行签到（POST claim）。成功 → { success, rewardCredits? }；
 * HTTP 409 / result=ALREADY_CLAIMED → 视为今日已签到。
 */
export async function performQoderCheckin(token: string): Promise<{ success: boolean; message: string; rewardCredits?: number }> {
  let res: Response
  try {
    res = await fetch(QODER_API_BASE + '/sash/api/v1/me/daily-check-in/claim', {
      method: 'POST',
      headers: billingHeaders(token),
      body: '{}',
      signal: AbortSignal.timeout(10000),
    })
  } catch (e) {
    return { success: false, message: (e as Error).message || '网络请求失败' }
  }
  const text = await res.text().catch(() => '')
  let m: Record<string, any> = {}
  try {
    m = text ? JSON.parse(text) : {}
  } catch {
    /* 非 JSON，走下方错误路径 */
  }
  if (res.status === 409 || m.result === 'ALREADY_CLAIMED') {
    return { success: true, message: '今日已签到', rewardCredits: typeof m.rewardCredits === 'number' ? m.rewardCredits : undefined }
  }
  if (!res.ok) {
    return { success: false, message: `http ${res.status}: ${text.substring(0, 200)}` }
  }
  if (m.success === true || !('success' in m)) {
    return { success: true, message: '签到成功', rewardCredits: typeof m.rewardCredits === 'number' ? m.rewardCredits : undefined }
  }
  return { success: false, message: JSON.stringify(m).substring(0, 200) }
}

/** GET /api/v2/quota/usage 响应。 */
interface QoderQuotaUsage {
  userId?: string
  userType?: string
  usageType?: string
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number // ms epoch
  upgradeUrl?: string
  userQuota?: { total?: number; used?: number; remaining?: number; unit?: string }
  addOnQuota?: { total?: number; used?: number; remaining?: number }
}

/**
 * 拉取额度：聚合 userQuota（基础额度）+ addOnQuota（赠送/签到额度）为两个包。
 * 返回 null 表示数据缺失（非耗尽）。
 */
export async function fetchQoderUserResource(token: string): Promise<{
  totalRemain: number
  totalUsed: number
  totalSize: number
  packCount: number
} | null> {
  const res = await fetch(QODER_API_BASE + '/api/v2/quota/usage', {
    method: 'GET',
    headers: billingHeaders(token),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    throw new Error(`quota/usage http ${res.status} body=${(await res.text().catch(() => '')).substring(0, 200)}`)
  }
  const q = (await res.json().catch(() => null)) as QoderQuotaUsage | null
  if (!q) return null
  const uq = q.userQuota || {}
  const aq = q.addOnQuota || {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
  const base = { remain: num(uq.remaining), used: num(uq.used), size: num(uq.total) }
  const addon = { remain: num(aq.remaining), used: num(aq.used), size: num(aq.total) }
  return {
    totalRemain: base.remain + addon.remain,
    totalUsed: base.used + addon.used,
    totalSize: base.size + addon.size,
    packCount: 2,
  }
}

/** GET /api/v2/user/plan 响应。 */
interface QoderPlan {
  user_type?: string
  plan_tier_name?: string
  is_personal_version?: boolean
  is_paid_plan?: boolean
  is_highest_tier?: boolean
  feature_allowed?: Record<string, boolean>
  start_date?: number // ms epoch
  end_date?: number // ms epoch
}

/** 拉取套餐名：优先 plan_tier_name（如 "Pro Trial"），回退 user_type。失败返回 ''。 */
export async function fetchQoderPaymentType(token: string): Promise<string> {
  try {
    const res = await fetch(QODER_API_BASE + '/api/v2/user/plan', {
      method: 'GET',
      headers: billingHeaders(token),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return ''
    const p = (await res.json().catch(() => null)) as QoderPlan | null
    if (!p) return ''
    if (p.plan_tier_name) return p.plan_tier_name
    return p.user_type || ''
  } catch {
    return ''
  }
}

/** 额度耗尽判定（与 CPA isCreditsExhausted 一致）：有使用信号且无剩余才算耗尽。 */
export function isQoderCreditsExhausted(cr: { totalRemain: number; totalUsed: number; totalSize: number } | null): boolean {
  if (!cr) return false
  if (cr.totalRemain > 0) return false
  return cr.totalUsed > 0 || cr.totalSize > 0
}
