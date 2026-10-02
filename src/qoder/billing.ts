/**
 * billing.ts — QoderWork 额度 / 签到 / 套餐（移植自 cpa-plugin/qoderwork/billing.go + checkin.go，
 * 分域端点与活动平台流程对齐 qoder2api-hub qoder_accounts.py:37-106）。
 *
 * 协议（端点按账号域取，见 QODER_OPENAPI）：
 *   CN     → https://openapi.qoder.com.cn
 *   global → https://openapi.qoder.sh
 *   状态：GET  {base}/sash/api/v1/me/daily-check-in/status（只读统计）
 *   活动：GET  {base}/sash/api/v1/me/campaigns
 *   领取：POST {base}/sash/api/v1/me/campaigns/{campaignId}/claim（空 body）
 *   额度：GET  {base}/api/v2/quota/usage
 *   套餐：GET  {base}/api/v2/user/plan
 *   认证：Authorization: Bearer <token>（dt- / jt- 均可），无 COSY 签名（KNOWLEDGE §2）
 *   响应：普通 JSON，无信封
 *
 * 签到走 campaigns 而非 legacy daily-check-in/claim（移植 qoder2api checkin.go:305-314，commit 99ab022）：
 * legacy 端点已 DISABLED，却对「未领取日」也恒返回 409，把它当「已签到」会永久跳过真实领取
 * （源实测 2026-09-21：不发积分）。真实发放积分的系统是 campaigns。
 *
 * 国际版（qoder2api-hub 实测结论，qoder_accounts.py:57-71）：
 *   - legacy `/sash/api/v1/me/daily-check-in/*` 在 openapi.qoder.sh 上返回 **404**（接口不存在）；
 *   - 但活动平台 `/sash/api/v1/me/campaigns` **双区域通用**，国际版活动页同样挂
 *     「每日领取 100 Credits」。
 *   所以国际版不能「整个跳过签到」，只能「跳过 legacy 状态探测、照常走 campaigns」。
 *   hub 的做法也是运行时探测能力（`checkin_capability`），不按区域硬编码。
 */

/** 按账号域取 openapi 基地址（qoder2api-hub REALM_CONFIGS）。 */
export const QODER_OPENAPI: Record<'cn' | 'global', string> = {
  cn: 'https://openapi.qoder.com.cn',
  global: 'https://openapi.qoder.sh',
}

/** 账号域类型（缺省 cn）。 */
export type QoderRealm = 'cn' | 'global'

/** 桌面端 cosy-version（qoder2api-hub qoder_sign.py:502-505 实测可用于模型列表与推理）。 */
const DESKTOP_COSY_VERSION = '1.1.64'

/** 规范化账号域：只认 'global'，其余一律 cn。 */
export function normalizeQoderRealm(realm: unknown): QoderRealm {
  return realm === 'global' ? 'global' : 'cn'
}

/**
 * legacy daily-check-in 接口在**国际版不存在**（openapi.qoder.sh 实测 404）。
 * 国际版账号跳过状态探测，直接进 campaigns 领取流程。
 */
export function realmHasLegacyCheckin(realm: QoderRealm): boolean {
  return realm === 'cn'
}

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
 * 签到专用头。合并两个来源的实测结论：
 *   - qoder2api checkin.go:59-67：`user-agent: Qoder`、`cosy-clienttype: 10`、`accept-language`
 *   - qoder2api-hub qoder_accounts.py:655-680（桌面端 0.4.3 同款出站头）：
 *     缺这些头服务端**不报错但返回空活动列表**，这正是「领不到」的根因；
 *     `Cosy-ClientType: 10` 是桌面端（CLI 是 5、QoderWork 是 6）。
 * 故桌面端身份头是**功能必需**，不是可选装饰。
 */
function checkinHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'accept-language': 'zh-CN',
    'user-agent': 'Qoder',
    'cosy-clienttype': '10',
    'cosy-version': DESKTOP_COSY_VERSION,
  }
}

/** 签到相关请求：POST 无 body（抓包确认 campaigns/claim 为空 body），并补 origin。 */
async function checkinRequest(method: 'GET' | 'POST', path: string, token: string, realm: QoderRealm): Promise<Response> {
  const base = QODER_OPENAPI[realm]
  const headers = checkinHeaders(token)
  if (method === 'POST') headers.origin = base
  return fetch(base + path, {
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
 *
 * 国际版该接口不存在（404）→ 调用方应先用 realmHasLegacyCheckin() 跳过，
 * 否则会把「接口不存在」误报成签到失败。
 */
export async function fetchQoderCheckinStatus(token: string, realm: QoderRealm = 'cn'): Promise<{
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  totalCredits: number
  dailyCredit: number
} | null> {
  const res = await checkinRequest('GET', '/sash/api/v1/me/daily-check-in/status', token, realm)
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
 *
 * 活动平台**双区域通用**（qoder2api-hub qoder_accounts.py:929「双区域通用」）：
 * 国际版账号同样走这里，只是 openapi 基地址换成 openapi.qoder.sh。
 */
export async function performQoderCheckin(token: string, realm: QoderRealm = 'cn'): Promise<QoderCheckinOutcome> {
  let res: Response
  try {
    res = await checkinRequest('GET', '/sash/api/v1/me/campaigns', token, realm)
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
    claimRes = await checkinRequest('POST', `/sash/api/v1/me/campaigns/${campaignId}/claim`, token, realm)
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
export async function fetchQoderUserResource(token: string, realm: QoderRealm = 'cn'): Promise<{
  totalRemain: number
  totalUsed: number
  totalSize: number
  packCount: number
} | null> {
  const res = await fetch(QODER_OPENAPI[realm] + '/api/v2/quota/usage', {
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
export async function fetchQoderPaymentType(token: string, realm: QoderRealm = 'cn'): Promise<string> {
  try {
    const res = await fetch(QODER_OPENAPI[realm] + '/api/v2/user/plan', {
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
