import { cosySessionFor, type CosySession } from './cosy'
import { formatCstWallClock, parseCstWallClock } from '../credit-expiry'
import type { PackageInfo } from '../types'

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

/**
 * 桌面端出站身份的内置默认值——管理后台「Qoder 设备身份」面板里留空的字段回退到这些值。
 * 来源：hub qoder_sign.py:502-505（cosy-version）+ qoder_accounts.py:650-653（其余）。
 *
 * 注意 machineOS 的默认是 hub 实测的 `x86_64_win32`；而提取脚本（chevy222 的 01_extract.py）
 * 给出的是 `x86_64_windows`。两者都能用，真机身份会覆盖默认值。
 */
export const QODER_DESKTOP_DEFAULTS = {
  clientType: '10',
  version: '1.1.64',
  machineOS: 'x86_64_win32',
  machineHostname: 'DESKTOP-QODER',
} as const

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
 * 真机设备身份。Cloudflare Workers **跑不了** Qoder 桌面端自带的原生风控桥
 * `runtime-info.exe`，所以真机身份只能由用户在装了桌面端的 Windows 机上一次性提取后
 * 填进管理后台——存储、归一与读取在 qoder/device.ts（KV key `qoder:device`）。
 *
 * 为什么必须支持它（2026-10-02 调研四个同类项目 + hub 源码，结论一致）：
 *   1. 官方 **2026-09-26 起要求请求携带设备标识才下发每日活动**。缺 `Cosy-ClientType: 10`
 *      时服务端返回 `{"showCampaign":false,"campaigns":[]}`（sunp-1 历史 README 抓包原文）；
 *   2. 身份是**抄来的常量、不是算出来的**：wallechfox/qoder-checkin、sunp-1/qoder-checkin、
 *      chevy222/qoder-cf-checkin、chevy222/app-cf-checkin 四个项目全部在本机跑
 *      `runtime-info.exe --account-stdin` 取 machineToken/machineCode/machineType、读
 *      `auth.machine-id` 取 machineId、读 `build-manifest.json` 取 version，然后当固定值
 *      长期回放；**没有一个是随机或派生的**；
 *   3. hub 做过对照实验（qoder_accounts.py:128-130）：「派生的假身份不会报错，但活动列表里
 *      会**静默少掉**『每日领取 100 Credits』这类条目（实测：换用原生身份后立刻出现
 *      CLAIMABLE 活动）」——这正是我们「无可用签到活动」的根因。
 *
 * 未配置时回退 uid 派生值（行为与旧版一致），但派生值拿不到设备定向活动。
 */
export interface QoderDeviceIdentity {
  /** Cosy-ClientType：桌面端 10、CLI 5、QoderWork 6 */
  clientType?: string
  machineId?: string
  machineToken?: string
  machineType?: string
  machineCode?: string
  machineOS?: string
  machineHostname?: string
  version?: string
}

/**
 * 签到专用头 = 官方桌面端 0.4.3 同款出站头（qoder2api-hub qoder_accounts.py:655-686）。
 *
 * 这是**功能必需**，不是可选装饰。hub 实测记录的两层坑：
 *   1. 缺这些头 → 服务端**不报错**但返回**空活动列表**（表现为「无可用签到活动」）；
 *   2. 机器身份用派生假值 → 列表里**静默少掉设备定向活动**（「每日领取 100 Credits」）。
 *
 * 官方桌面端调用 /sash/api/v1/me/campaigns 时携带：
 *   Authorization / User-Agent: Qoder / Cosy-ClientType: 10 /
 *   Cosy-Version / Cosy-MachineOS / MachineHostname / MachineId / MachineToken /
 *   MachineType / MachineCode
 *
 * 机器身份优先级：真机身份（`device`，管理后台「Qoder 设备身份」配置，见 qoder/device.ts）
 * > uid 派生值（`sess`）；两者都没有的字段再回退 QODER_DESKTOP_DEFAULTS。
 * 注：hub 优先用官方 runtime-info.exe 取**真**身份，Workers 跑不了原生二进制，
 * 故只能用调用方注入的 `device` 或派生值——派生值拿不到每日活动，这是已知上限。
 *
 * User-Agent 保持 `Qoder`（**不跟随**那四个项目的 `Qoder/claim`）：`Qoder/claim` 是脚本
 * 自己起的名字（"claim" 即脚本名），不是抓包值；`Qoder` 有两个独立来源（本文件早前的
 * 抓包记录 + hub qoder_accounts.py:645 CLIENT_UA）。且那四个项目在「无真机身份」时同样
 * 发 `Qoder/claim` 却拿到空列表，说明 UA 不是活动是否下发的判别项——改它属于无据变更。
 */
function checkinHeaders(token: string, sess: CosySession, device?: QoderDeviceIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN',
    'user-agent': 'Qoder',
    'cosy-clienttype': device?.clientType || QODER_DESKTOP_DEFAULTS.clientType,
    'cosy-version': device?.version || QODER_DESKTOP_DEFAULTS.version,
    'cosy-machineid': device?.machineId || sess.machineId,
    'cosy-machinetoken': device?.machineToken || sess.machineToken,
    'cosy-machinetype': device?.machineType || sess.machineType,
    // 真机 machineCode 与 machineType 同为 18 位十六进制（wallechfox 提交的真机 config.json）；
    // hub 与那四个项目都发这个头，缺它会让本客户端比真机少一个身份字段。
    'cosy-machinecode': device?.machineCode || sess.machineCode,
    'cosy-machineos': device?.machineOS || QODER_DESKTOP_DEFAULTS.machineOS,
    'cosy-machinehostname': device?.machineHostname || QODER_DESKTOP_DEFAULTS.machineHostname,
  }
}

/**
 * 签到相关请求：POST 无 body（抓包确认 campaigns/claim 为空 body），并补 origin。
 *
 * 需要 COSY 会话（机器身份头）：billing 端点自身不校验签名，但活动平台按
 * 机器身份过滤活动，故仍要带。会话按 uid+token 缓存，无额外网络开销。
 */
async function checkinRequest(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  realm: QoderRealm,
  sess: CosySession,
  device?: QoderDeviceIdentity
): Promise<Response> {
  const base = QODER_OPENAPI[realm]
  const headers = checkinHeaders(token, sess, device)
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
/**
 * 取签到用的 COSY 会话：优先用调用方注入的会话，否则按 uid 建（缓存复用）。
 * uid 决定机器指纹种子——必须与推理路径用同一个 uid，否则签到与推理
 * 会呈现成两台不同设备，反而更容易被判定为非官方客户端。
 */
async function checkinSession(token: string, uid: string, sess?: CosySession): Promise<CosySession> {
  if (sess) return sess
  return cosySessionFor(token, '', uid, '')
}

export async function fetchQoderCheckinStatus(token: string, realm: QoderRealm = 'cn', uid = '', sess?: CosySession): Promise<{
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  totalCredits: number
  dailyCredit: number
} | null> {
  const s = await checkinSession(token, uid, sess)
  const res = await checkinRequest('GET', '/sash/api/v1/me/daily-check-in/status', token, realm, s)
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
  /** 不可领取的原因码（qoder2api-hub qoder_accounts.py:999 同名归一化字段）。 */
  unavailableReason?: string
  /** 成就门控活动是否已达成（hub qoder_accounts.py:998）。 */
  achievementCompleted?: boolean
  /** 成就门控活动的任务 key（hub qoder_accounts.py:996）。 */
  requiredAchievementKey?: string
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
  /**
   * 本次新领积分的到期时刻（epoch ms，来自 claim 响应的 expiresAt，30 天相对有效期）。
   * 落进池状态的「签到/赠送额度」包，面板据此显示到期天数、挑号据此优先消耗快过期的积分。
   * 仅在**本次新领**时有值：replayed（今日已领）没有新 grant，用池里已存的到期时间。
   */
  rewardExpiresAt?: number
  /**
   * 诊断详情（供签到日志落盘；**绝不含 token 原文**）。
   *
   * 为什么必须带出来：线上出现「提示签到成功但积分没增加」，而面板只显示一句
   * message —— 无法区分「服务端返回 replayed=true（本就已领，不会再加分）」、
   * 「claim 返回 CLAIMED 但 benefit.amount 缺失」、「活动其实不可领」这三种情况。
   * 把上游原始字段原样落进日志，下一次反馈就能直接定位，不必再靠猜。
   */
  debug?: QoderCheckinDebug
}

/** 一次签到的上游诊断快照（写入系统日志）。 */
export interface QoderCheckinDebug {
  realm: QoderRealm
  /** campaigns 列表 HTTP 状态码 */
  campaignsHttp: number
  /** 上游 showCampaign（false = 本客户端设备身份未被认可，活动被过滤） */
  showCampaign: unknown
  /** 上游 claimable 汇总标记 */
  claimable: unknown
  campaignCount: number
  /** 每个活动的关键字段（原样，便于人工比对） */
  campaigns: Array<{
    key: string
    action: string
    status: string
    kind: string
    amount: number
    reason: string
    achievement?: string
  }>
  /** claim 请求的 HTTP 状态码（未发起领取时缺省） */
  claimHttp?: number
  /** claim 响应原始体（截断，便于看 replayed/benefit 到底有没有值） */
  claimBody?: string
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
export async function performQoderCheckin(
  token: string,
  realm: QoderRealm = 'cn',
  uid = '',
  sess?: CosySession,
  device?: QoderDeviceIdentity
): Promise<QoderCheckinOutcome> {
  const s = await checkinSession(token, uid, sess)
  let res: Response
  try {
    res = await checkinRequest('GET', '/sash/api/v1/me/campaigns', token, realm, s, device)
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
  // 诊断快照：上游原始字段原样留档，供「签到成功但积分没增加」这类问题定位
  const dbg: QoderCheckinDebug = {
    realm,
    campaignsHttp: res.status,
    showCampaign: list.showCampaign,
    claimable: list.claimable,
    campaignCount: raw.length,
    campaigns: raw.map((c) => ({
      key: String(c?.campaignKey || c?.campaignId || ''),
      action: String(c?.actionType || ''),
      status: String(c?.claimStatus || ''),
      kind: String(c?.benefit?.kind || ''),
      amount: typeof c?.benefit?.amount === 'number' ? c.benefit.amount : 0,
      reason: String(c?.unavailableReason || ''),
      achievement: c?.requiredAchievementKey ? String(c.requiredAchievementKey) : undefined,
    })),
  }
  let target: QoderCampaign | null = null
  let alreadyClaimed = false
  /** 非 CLAIMABLE/CLAIMED 的活动：带原因码，用于把「领不到」讲清楚 */
  const notClaimable: QoderCampaign[] = []
  for (const c of raw) {
    if (!c) continue
    // 空 actionType 也算奖励类：hub qoder_accounts.py:1127/1150 与 qoder_tasks.py:275
    // 都把 "" 与 CLAIM_BENEFIT 并列（`action_type in ("", "CLAIM_BENEFIT")`）。
    // 旧实现只认字面量 CLAIM_BENEFIT，会把「每日领取 Credits」这类未回填
    // actionType 的活动整条丢掉 → 误报「无可用签到活动」。
    const action = String(c.actionType || '')
    if (action !== '' && action !== 'CLAIM_BENEFIT') continue
    if (c.claimStatus === 'CLAIMABLE') target = c
    else if (c.claimStatus === 'CLAIMED') alreadyClaimed = true
    else notClaimable.push(c)
  }

  if (!target) {
    if (alreadyClaimed) return { success: true, already: true, message: '今日已领取', debug: dbg }
    // 区分两种「没活动」：真的没有活动 vs 服务端把本客户端判定为非官方身份而过滤掉全部活动。
    // hub qoder_accounts.py:929-1005 用 showCampaign 标记这一点，并靠刷新机器身份重试；
    // 不区分就会把「身份被过滤」误报成「今天没活动」，让人以为签到正常。
    const showCampaign = list.showCampaign
    if (showCampaign === false) {
      return {
        success: false,
        message:
          '活动列表被上游按机器身份过滤（showCampaign=false）：服务端未认可本客户端的设备身份，' +
          '故「每日领取 Credits」等设备定向活动未下发。这不是「今天没有活动」。',
        debug: dbg,
      }
    }
    // 有活动但都不可领：把上游原因码如实带出来（hub qoder_accounts.py:1145-1148 同样分类：
    // REDEMPTION_CODE_OUT_OF_STOCK=名额发完、ACHIEVEMENT_NOT_COMPLETED=需先完成新人任务）。
    // 全部塌缩成一句「没有 CLAIMABLE 的 CLAIM_BENEFIT」会让人无从判断下一步。
    if (notClaimable.length > 0) {
      const detail = notClaimable
        .map((c) => {
          const reason = String(c.unavailableReason || '').toUpperCase()
          const key = c.campaignKey || c.campaignId || '(无 key)'
          const why =
            reason === 'REDEMPTION_CODE_OUT_OF_STOCK'
              ? '名额已发完（次日 10:00 后可再领）'
              : reason === 'ACHIEVEMENT_NOT_COMPLETED' || c.achievementCompleted === false
                ? `需先在官方桌面端完成新人任务${c.requiredAchievementKey ? `（成就 ${c.requiredAchievementKey}）` : ''}`
                : reason || `状态 ${c.claimStatus || '(空)'}`
          return `${key}: ${why}`
        })
        .join('；')
      return {
        success: false,
        message: `签到活动暂不可领取（共 ${raw.length} 个活动，${notClaimable.length} 个奖励类活动均不可领）—— ${detail}`,
        debug: dbg,
      }
    }
    return {
      success: false,
      message: `无可用签到活动（${raw.length} 个活动里没有 CLAIMABLE 的 CLAIM_BENEFIT）`,
      debug: dbg,
    }
  }
  const campaignId = target.campaignId
  if (!campaignId) return { success: false, message: '签到活动缺少 campaignId', debug: dbg }

  let claimRes: Response
  try {
    claimRes = await checkinRequest('POST', `/sash/api/v1/me/campaigns/${campaignId}/claim`, token, realm, s, device)
  } catch (e) {
    return { success: false, message: (e as Error).message || '网络请求失败', debug: dbg }
  }
  const claimText = await claimRes.text().catch(() => '')
  dbg.claimHttp = claimRes.status
  dbg.claimBody = claimText.substring(0, 500)
  if (!claimRes.ok) {
    return { success: false, message: `领取失败 http ${claimRes.status}: ${claimText.substring(0, 200)}`, debug: dbg }
  }
  let cr: QoderClaimResponse
  try {
    cr = claimText ? JSON.parse(claimText) : {}
  } catch {
    return { success: false, message: `领取响应格式异常: ${claimText.substring(0, 200)}`, debug: dbg }
  }

  if (cr.status === 'CLAIMED') {
    if (cr.replayed) {
      return { success: true, already: true, message: '今日已领取', campaignKey: target.campaignKey, debug: dbg }
    }
    const amount = typeof cr.benefit?.amount === 'number' ? cr.benefit.amount : undefined
    return {
      success: true,
      message: amount ? `领取成功 +${amount} ${target.campaignKey || ''}`.trim() : '签到成功',
      rewardCredits: amount,
      campaignKey: target.campaignKey,
      // claim 响应的 expiresAt 是 ISO 串（如 "2026-11-01T10:52:18.531379Z"，= 领取时刻 + 30 天）
      rewardExpiresAt: parseCstWallClock(cr.expiresAt) ?? undefined,
      debug: dbg,
    }
  }
  return { success: false, message: `未知状态: ${cr.status || '(空)'}`, debug: dbg }
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

/** 一个额度分项（基础 / 加购）。 */
export interface QoderQuotaSplit {
  size: number
  used: number
  remain: number
}

/** 面板与池状态里的两个额度包名——唯一定义处（checkin 写路径与测试都引用它）。 */
export const QODER_PACK_BASE = '套餐额度'
export const QODER_PACK_ADDON = '签到/赠送额度'

/**
 * 组装权益包列表（`PackageInfo` 形态，`expireAt` 统一为 CST 墙钟串）。
 *
 * 为什么要把 Qoder 的额度也装成 PackageInfo：这样面板的到期渲染/排序/「⏳ N 个包 7 天内到期」
 * 徽章、以及 credit-expiry 的到期优先判定，全部与 workbuddy 共用同一套实现（零新渲染逻辑）。
 *
 * 两个包的到期来源不同，必须分开对待：
 *   - 套餐额度（userQuota）：到期 = quota/usage 的顶层 `expiresAt`（套餐到期即基础额度作废）；
 *   - 签到/赠送额度（addOnQuota）：quota/usage **不返回**它的到期时间，只能取「最近一次领取
 *     的那笔 grant」的 expiresAt（claim 响应的 30 天相对有效期）。已领过的账号用池里已存的
 *     到期时间兜底（`prev`），避免每日「已签到」路径把到期时间擦掉。
 */
export function buildQoderPacks(
  quota: { baseQuota: QoderQuotaSplit; addonQuota: QoderQuotaSplit; planExpiresAt: number },
  rewardExpiresAtMs: number | undefined,
  prev?: readonly PackageInfo[] | null
): PackageInfo[] {
  const prevAddon = Array.isArray(prev) ? prev.find((p) => p && p.name === QODER_PACK_ADDON) : undefined
  const addonExpireAt =
    typeof rewardExpiresAtMs === 'number' && Number.isFinite(rewardExpiresAtMs) && rewardExpiresAtMs > 0
      ? rewardExpiresAtMs
      : (parseCstWallClock(prevAddon?.expireAt) ?? 0)
  return [
    {
      name: QODER_PACK_BASE,
      expireAt: formatCstWallClock(quota.planExpiresAt),
      size: quota.baseQuota.size,
      used: quota.baseQuota.used,
      unit: 'credits',
    },
    {
      name: QODER_PACK_ADDON,
      expireAt: formatCstWallClock(addonExpireAt),
      size: quota.addonQuota.size,
      used: quota.addonQuota.used,
      unit: 'credits',
    },
  ]
}

/**
 * 拉取额度：聚合 userQuota（基础额度）+ addOnQuota（赠送/签到额度）为两个包。
 * 返回 null 表示数据缺失（非耗尽）。
 *
 * 除聚合值外还返回**分项**与套餐到期时间：签到积分落在 addOnQuota 里，而它的到期时间
 * 决定「哪些积分会先作废」，只有拿到分项才能把两个包分别标上到期时间（buildQoderPacks）。
 */
export async function fetchQoderUserResource(token: string, realm: QoderRealm = 'cn'): Promise<{
  totalRemain: number
  totalUsed: number
  totalSize: number
  packCount: number
  /** 套餐（基础额度）到期 epoch ms；0 = 上游未给或不可解析 */
  planExpiresAt: number
  /** 基础额度（userQuota） */
  baseQuota: QoderQuotaSplit
  /** 加购/赠送额度（addOnQuota）——签到发的 100 Credits 落在这里 */
  addonQuota: QoderQuotaSplit
  /** 上游原始响应体（截断）。面板出现「可用 0 · 已用 0」时，需要它来区分
   *  「账号确实没额度」与「字段名/结构变了导致解析成 0」。 */
  raw?: string
} | null> {
  const res = await fetch(QODER_OPENAPI[realm] + '/api/v2/quota/usage', {
    method: 'GET',
    headers: billingHeaders(token),
    signal: AbortSignal.timeout(10000),
  })
  const bodyText = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`quota/usage http ${res.status} body=${bodyText.substring(0, 200)}`)
  }
  let q: QoderQuotaUsage | null = null
  try { q = bodyText ? (JSON.parse(bodyText) as QoderQuotaUsage) : null } catch { q = null }
  if (!q) return null
  const uq = q.userQuota || {}
  const aq = q.addOnQuota || {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
  const baseQuota: QoderQuotaSplit = { remain: num(uq.remaining), used: num(uq.used), size: num(uq.total) }
  const addonQuota: QoderQuotaSplit = { remain: num(aq.remaining), used: num(aq.used), size: num(aq.total) }
  return {
    totalRemain: baseQuota.remain + addonQuota.remain,
    totalUsed: baseQuota.used + addonQuota.used,
    totalSize: baseQuota.size + addonQuota.size,
    packCount: 2,
    planExpiresAt: num(q.expiresAt),
    baseQuota,
    addonQuota,
    raw: bodyText.substring(0, 500),
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
