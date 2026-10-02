/**
 * billing.ts — QoderWork 额度 / 签到 / 套餐（移植自 cpa-plugin/qoderwork/billing.go + checkin.go）。
 *
 * 协议：
 *   状态：GET  https://openapi.qoder.com.cn/sash/api/v1/me/daily-check-in/status（只读统计）
 *   活动：GET  https://openapi.qoder.com.cn/sash/api/v1/me/campaigns
 *   领取：POST https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/{campaignId}/claim（空 body）
 *   额度：GET  https://openapi.qoder.com.cn/api/v2/quota/usage
 *   套餐：GET  https://openapi.qoder.com.cn/api/v2/user/plan
 *   认证：Authorization: Bearer <token>（dt- / jt- 均可），无 COSY 签名（KNOWLEDGE §2）
 *   响应：普通 JSON，无信封
 *
 * 签到走 campaigns 而非 legacy daily-check-in/claim（移植 qoder2api checkin.go:305-314，commit 99ab022）：
 * legacy 端点已 DISABLED，却对「未领取日」也恒返回 409，把它当「已签到」会永久跳过真实领取
 * （源实测 2026-09-21：不发积分）。真实发放积分的系统是 campaigns。
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

/**
 * 签到专用头（qoder2api checkin.go:59-67 抓包确认的必需头）。
 * 与 billingHeaders 的差异是实测结论，不是风格选择：签到端点认 `user-agent: Qoder` 与
 * `cosy-clienttype: 10`，且不接受小写以外的 Content-Type 语义（POST claim 无 body）。
 */
function checkinHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'accept-language': 'zh-CN',
    'user-agent': 'Qoder',
    'cosy-clienttype': '10',
  }
}

/** 签到相关请求：POST 无 body（抓包确认 campaigns/claim 为空 body），并补 origin。 */
async function checkinRequest(method: 'GET' | 'POST', path: string, token: string): Promise<Response> {
  const headers = checkinHeaders(token)
  if (method === 'POST') headers.origin = QODER_API_BASE
  return fetch(QODER_API_BASE + path, {
    method,
    headers,
    signal: AbortSignal.timeout(10000),
  })
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
 * 查询签到状态（legacy daily-check-in/status，只读）。
 * 注意：legacy 活动已 DISABLED（streak 恒 0），故这里只用于「今日是否已领」的快速判断；
 * 真实领取必须走 campaigns（performQoderCheckin）。
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
    headers: checkinHeaders(token),
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

/** campaigns 列表条目（qoder2api checkin.go:110-122）。 */
interface QoderCampaign {
  campaignId?: string
  campaignKey?: string
  actionType?: string
  claimStatus?: string
  startAt?: number
  endAt?: number
  benefit?: { kind?: string; amount?: number }
}

/** claim 响应（qoder2api checkin.go:124-138）。 */
interface QoderClaimResponse {
  grantId?: string
  status?: string
  replayed?: boolean
  benefit?: { kind?: string; amount?: number }
  expiresAt?: string
}

export interface QoderCheckinOutcome {
  success: boolean
  message: string
  rewardCredits?: number
  /** true = 今日已领取（replayed 或列表显示 CLAIMED），非本次新领 */
  already?: boolean
  /** 命中的活动 key，便于排查是哪个活动发的积分 */
  campaignKey?: string
}

/**
 * 执行签到：走 campaigns 流程（qoder2api checkin.go:408-504，commit 99ab022）。
 *
 *   1. GET  /sash/api/v1/me/campaigns
 *   2. 取 actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE 的活动
 *   3. POST /sash/api/v1/me/campaigns/{campaignId}/claim（空 body）
 *   4. status=CLAIMED → replayed=true 记「已领取」，否则记新领取并取 benefit.amount
 *
 * 不再调用 legacy /daily-check-in/claim：该端点已 DISABLED，对未领取日恒返回 409，
 * 旧实现把 409 当成功 → 假签到、0 积分。
 */
export async function performQoderCheckin(token: string): Promise<QoderCheckinOutcome> {
  let res: Response
  try {
    res = await checkinRequest('GET', '/sash/api/v1/me/campaigns', token)
  } catch (e) {
    return { success: false, message: (e as Error).message || '网络请求失败' }
  }
  const listText = await res.text().catch(() => '')
  if (!res.ok) {
    return { success: false, message: `查询活动失败 http ${res.status}: ${listText.substring(0, 200)}` }
  }
  let list: Record<string, any>
  try {
    list = listText ? JSON.parse(listText) : {}
  } catch {
    return { success: false, message: `活动列表格式异常: ${listText.substring(0, 200)}` }
  }

  const raw = Array.isArray(list.campaigns) ? (list.campaigns as QoderCampaign[]) : []
  let target: QoderCampaign | null = null
  let alreadyClaimed = false
  for (const c of raw) {
    if (!c || c.actionType !== 'CLAIM_BENEFIT') continue
    if (c.claimStatus === 'CLAIMABLE') target = c
    else if (c.claimStatus === 'CLAIMED') alreadyClaimed = true
  }

  if (!target) {
    if (alreadyClaimed) return { success: true, already: true, message: '今日已领取' }
    return { success: false, message: '无可用签到活动（无 CLAIMABLE 的 CLAIM_BENEFIT 活动）' }
  }
  const campaignId = target.campaignId
  if (!campaignId) return { success: false, message: '签到活动缺少 campaignId' }

  let claimRes: Response
  try {
    claimRes = await checkinRequest('POST', `/sash/api/v1/me/campaigns/${campaignId}/claim`, token)
  } catch (e) {
    return { success: false, message: (e as Error).message || '网络请求失败' }
  }
  const claimText = await claimRes.text().catch(() => '')
  if (!claimRes.ok) {
    return { success: false, message: `领取失败 http ${claimRes.status}: ${claimText.substring(0, 200)}` }
  }
  let cr: QoderClaimResponse
  try {
    cr = claimText ? JSON.parse(claimText) : {}
  } catch {
    return { success: false, message: `领取响应格式异常: ${claimText.substring(0, 200)}` }
  }

  if (cr.status === 'CLAIMED') {
    if (cr.replayed) {
      return { success: true, already: true, message: '今日已领取', campaignKey: target.campaignKey }
    }
    const amount = typeof cr.benefit?.amount === 'number' ? cr.benefit.amount : undefined
    return {
      success: true,
      message: amount ? `领取成功 +${amount} ${target.campaignKey || ''}`.trim() : '签到成功',
      rewardCredits: amount,
      campaignKey: target.campaignKey,
    }
  }
  return { success: false, message: `未知状态: ${cr.status || '(空)'}` }
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
