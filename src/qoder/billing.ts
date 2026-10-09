import { cosySessionFor, type CosySession } from './cosy'
import { formatCstWallClock, parseCstWallClock } from '../credit-expiry'
import { isQoderUnbookedGrant, type QoderAddonGrant } from './grants'
import { md5Hex } from './md5'
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

/**
 * 按账号域取官网基地址（hub REALM_CONFIGS 的 `website`，qoder_accounts.py:42/64）。
 * 用作 Pro 升级包端点的 `Origin` / `Referer`——与签到端点同源要求。
 */
export const QODER_WEBSITE: Record<'cn' | 'global', string> = {
  cn: 'https://qoder.com.cn',
  global: 'https://qoder.com',
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

/**
 * Qoder 每日活动的刷新点：**CST（UTC+8）每日 10:00** 放量新一轮
 * （hub `_diag_campaign.py:34-35`「每日 10:00（UTC+8）刷新，错过不补」，
 * `qoder_tasks.py:670` / `qoder_accounts.py:294` 同口径）。
 *
 * 为什么签到判定必须知道这个点：列表里的 `claimStatus=CLAIMED` 只表示
 * **当前轮**已领，而轮次要到 10:00 才滚动。10:00 之前看到的 CLAIMED 属于
 * **上一轮**，把它当「今天已领」就会假报 already、当天积分一直不落账
 * （2026-10-03 实例：09:01 自动签到报「今日已领取」、额度 395 未动；
 * 10:23 手工再领才 +100 → 495，反向证明 09:01 那次没拿到当轮额度）。
 *
 * 纯函数、显式收 now（不读 Date.now），便于单测固定时刻、不随 CI 挂钟漂移。
 */
export function qoderDailyRoundOpen(nowMs: number): boolean {
  return new Date(nowMs + 8 * 60 * 60 * 1000).getUTCHours() >= 10
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
 * 机器身份头的发送状态：`native` = 有真机 machineToken、按官方客户端同款发全套六头；
 * `omitted` = 无真机身份、**一个 cosy-machine* 都不发**。
 *
 * 这不是「降级」，而是 hub issue #10 实测出的**唯一正确形态**（见 checkinHeaders）。
 */
export type QoderMachineHeadersState = 'native' | 'omitted'

/**
 * 是否发六个 `cosy-machine*` 头。
 *
 * 判据**只有** `device.machineToken` 一个：hub 的逐头隔离实验里，服务端认的是
 * 「真机 token」这一项能力，而不是六个字段凑齐。仅凭 machineId/machineType 等
 * 其它字段无法构成真机身份，反而会落进「全套派生六头」这个被过滤的形态。
 */
export function qoderMachineHeadersState(device?: QoderDeviceIdentity): QoderMachineHeadersState {
  return device?.machineToken ? 'native' : 'omitted'
}

/**
 * 签到专用头 = 官方桌面端 0.4.3 同款出站头（qoder2api-hub qoder_accounts.py:655-686）。
 *
 * 这是**功能必需**，不是可选装饰。hub 实测记录的三层坑：
 *   1. 缺 UA / `cosy-clienttype` / `cosy-version` → 服务端**不报错**但返回
 *      **空活动列表**（表现为「无可用签到活动」）——这三个头**无条件发**；
 *   2. 机器身份用派生假值 → 列表里**静默少掉设备定向活动**（「每日领取 100 Credits」）；
 *   3. **六个 cosy-machine\* 全发但全是派生值 → 整条 CLAIMABLE 活动被过滤**
 *      （hub issue #10，Linux/Docker 实测；见下）。
 *
 * ## 为什么无真机身份时一个机器头都不发（hub issue #10 / v1.2.1 330cf23）
 *
 * hub 的逐头隔离实验结论：
 *   - 六头**任一个单独**出现 → 活动可见；
 *   - 六头**全发**（派生值） → CLAIMABLE 的「每日领取 100 Credits」被**整条过滤**，
 *     列表只剩 VIEW_DETAILS 类；
 *   - 去掉 `machinetoken` 或 `machineid` → 可见。
 * 即服务端把「全套派生六头」判定为非官方客户端。hub 的修法是：原生桥给出真身份
 * （machineToken 非空）才发全套六头，否则**一个都不发**，只留 UA / clienttype / version。
 *
 * 旧实现（本文件此前）在无 `device` 时发 uid 派生的六个值——**正是被过滤的那个形态**，
 * 于是「没配设备身份」的部署会稳定拿不到每日活动，且服务端不报错。现在按 hub 同口径门控。
 *
 * 注：hub 优先用官方 runtime-info.exe 取**真**身份，Workers 跑不了原生二进制，
 * 故真机身份只能由用户在装了桌面端的机器上一次性提取后填进管理后台（qoder/device.ts）。
 * 未配置时不再伪造机器头——伪造比缺失更糟（缺失只是拿不到设备定向活动，伪造会让
 * 整条活动列表被过滤）。
 *
 * 有真机身份时，缺的字段仍回退 uid 派生值/内置默认（与 hub 原生分支逐字同构：
 * `ident.get(x) or derive_x(...)`）——真机 token 已证明客户端身份，其余字段只是凑形状。
 *
 * User-Agent 保持 `Qoder`（**不跟随**那四个项目的 `Qoder/claim`）：`Qoder/claim` 是脚本
 * 自己起的名字（"claim" 即脚本名），不是抓包值；`Qoder` 有两个独立来源（本文件早前的
 * 抓包记录 + hub qoder_accounts.py:645 CLIENT_UA）。且那四个项目在「无真机身份」时同样
 * 发 `Qoder/claim` 却拿到空列表，说明 UA 不是活动是否下发的判别项——改它属于无据变更。
 */
function checkinHeaders(token: string, sess: CosySession, device?: QoderDeviceIdentity): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN',
    'user-agent': 'Qoder',
    'cosy-clienttype': device?.clientType || QODER_DESKTOP_DEFAULTS.clientType,
    'cosy-version': device?.version || QODER_DESKTOP_DEFAULTS.version,
  }
  // 六个 cosy-machine* 只在真机身份可用时发送（hub issue #10）：全套派生值会被
  // 服务端判定为非官方客户端并过滤掉 CLAIMABLE 活动，缺头反而可见。
  if (qoderMachineHeadersState(device) === 'native') {
    h['cosy-machineid'] = device?.machineId || sess.machineId
    h['cosy-machinetoken'] = device?.machineToken || sess.machineToken
    h['cosy-machinetype'] = device?.machineType || sess.machineType
    // 真机 machineCode 与 machineType 同为 18 位十六进制（wallechfox 提交的真机 config.json）；
    // hub 与那四个项目都发这个头，缺它会让本客户端比真机少一个身份字段。
    h['cosy-machinecode'] = device?.machineCode || sess.machineCode
    h['cosy-machineos'] = device?.machineOS || QODER_DESKTOP_DEFAULTS.machineOS
    h['cosy-machinehostname'] = device?.machineHostname || QODER_DESKTOP_DEFAULTS.machineHostname
  }
  return h
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
  /**
   * 兑换码类奖励的码（hub qoder_accounts.py:1072）。
   *
   * 旧实现**连字段都没定义** → 服务端回了码也接不住、直接丢。这是本模块唯一涉及
   * **不可恢复用户资产**的字段：积分丢了还能再攒，兑换码只回一次，错过永久丢失。
   *
   * 官方客户端语义（hub `claim_campaign` 同款）：`status=CLAIMED` **且** `redemptionCode`
   * 非空才算真拿到；仅 CLAIMED 无码 = 发放确认中（`confirming`）。
   */
  redemptionCode?: string
  /** 上游失败码（如 SAME_PERSON_ALREADY_CLAIMED / REDEMPTION_CODE_OUT_OF_STOCK）。 */
  failureCode?: string
  /** 部分响应把金额放在顶层而非 benefit 里（hub `r.get("amount")` 兜底）。 */
  amount?: number
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
   * 命中的活动 id（campaignId）。
   *
   * 兑换码与同人去重冷却都按 **campaignId** 落盘（hub `campaign_codes[campaign_id]` /
   * `campaign_blocked_until[cid]`）——key 是活动的可读名（含日期），会随轮次变化，
   * 拿它当持久化键会让下一轮的码认不回同一个活动。
   */
  campaignId?: string
  /**
   * 本次领取到的**兑换码**（券类活动的 `redemptionCode`，hub qoder_accounts.py:1072-1074）。
   *
   * 只回一次、错过永久丢失，故必须一路带出到调用方落盘（QoderPoolState.campaignCodes）。
   * 非券类活动与「发放确认中」都没有值。
   */
  redemptionCode?: string
  /**
   * 逐条券类活动的兑换码（含 campaignId，供调用方**按活动**落盘）。
   *
   * 为什么不能只给一个 `redemptionCode`：码按 campaignId 持久化（hub 同款），
   * 一轮可能领到多张券，只带最后一个会让前面的码在落盘前丢掉。
   */
  couponCodes?: Array<{ campaignId: string; campaign: string; code: string }>
  /**
   * 本次被服务端按「人」判重的券类活动 id：调用方据此记 6h 冷却
   * （hub `campaign_blocked_until`），避免每轮重复 POST 同一活动。
   */
  couponBlocked?: string[]
  /**
   * `status=CLAIMED` 但 `redemptionCode` 为空 = **发放确认中**（hub 同名字段，
   * qoder_accounts.py:1089）。与「已拿到码」是两种状态，不能混报成成功领取。
   */
  confirming?: boolean
  /**
   * 上游按「人」去重：同一设备/身份下其他账号本轮已领（hub `SAME_PERSON_ALREADY_CLAIMED`）。
   *
   * 这不是「失败」——账号本身没问题、请求也合法，只是服务端按人去重。旧实现把它塌缩成
   * 「领取失败 http N」，让人以为账号坏了。调用方据此记 6h 活动冷却，避免每轮重复 POST。
   */
  blocked?: boolean
  /**
   * 本次新领积分的到期时刻（epoch ms，来自 claim 响应的 expiresAt，30 天相对有效期）。
   *
   * 它是**这一笔**的到期时间（上游对加购桶只给聚合余额，逐笔到期只能靠它一笔笔攒，
   * 见 qoder/grants.ts）：落进账本后，面板按笔显示各自到期、挑号据此优先消耗最早那笔。
   * 仅在**本次新领**时有值：replayed（今日已领）没有新 grant，账本里已有那一笔的记录。
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
 * 活动领取失败码 → 中文说明（hub `_CAMPAIGN_FAILURE_CN`，qoder_accounts.py:293-299，
 * 与官方 growth-page/activity-iframe 前端一致）。
 *
 * 旧实现只处理前两条（名额发完 / 成就未完成），其余塌缩成「未知状态: X」——
 * 风控拦截与活动结束被报成含糊状态，用户无从判断下一步该做什么。
 */
const QODER_CAMPAIGN_FAILURE_CN: Record<string, string> = {
  REDEMPTION_CODE_OUT_OF_STOCK: '今日名额已发完（每日 10:00 刷新，次日再来）',
  ACHIEVEMENT_NOT_COMPLETED: '需先完成新人任务（成就未完成）',
  CAMPAIGN_NOT_ACTIVE: '活动已结束/未开始',
  RISK_BLOCKED: '风控拦截（当前设备/账号不可领取）',
  RISK_DEPENDENCY_UNAVAILABLE: '风控服务不可用，稍后重试',
}

/**
 * 服务端按「人」去重的失败码/状态（hub qoder_accounts.py:1059）：
 * `failureCode == "SAME_PERSON_ALREADY_CLAIMED"` 或 `status == "BLOCKED"`。
 */
const QODER_SAME_PERSON_MARKERS = ['SAME_PERSON_ALREADY_CLAIMED', 'BLOCKED']

/** 券类奖励（非积分）：这些活动的 claim 会回 `redemptionCode`。 */
export function isQoderCouponKind(kind: unknown): boolean {
  const k = String(kind || '').toUpperCase()
  // 空 kind 视为积分类（hub 的 only_kinds=("", "CREDITS") 把 "" 与 CREDITS 并列）
  if (k === '' || k === 'CREDITS') return false
  return true
}

/** 券类活动的中文名（hub `_extra_campaign_rows` 的 kind 映射，qoder_tasks.py:349）。 */
export function qoderCouponKindLabel(kind: unknown): string {
  const k = String(kind || '').toUpperCase()
  if (k === 'REDEMPTION_CODE') return '兑换码'
  if (k === 'REDEMPTION_COUPON') return '兑换券'
  if (k === 'COUPON') return '优惠券'
  return k || '奖励'
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
 *
 * `opts.includeCoupons`（缺省 false，= 旧行为）：是否**同时领取券类活动**
 * （REDEMPTION_CODE 等非 Credits 奖励，见 qoderCouponKindLabel）。
 *
 * 为什么默认不领（与源 `run_checkin(only_daily=True)` 同口径，qoder_tasks.py:635）：
 * 「每日签到」按钮的语义是领积分；券类福利涉及不可恢复资产，应由用户显式触发
 * （面板「领取福利/兑换码」入口传 true），而不是每天自动替他领掉。
 *
 * `opts.couponsOnly`（缺省 false）：**只领券、完全不碰每日签到判定**。
 *
 * 为什么必须单独一个模式（2026-10-09 实测缺陷）：每日签到在「本轮未刷新」（CST 10:00 前）
 * 时会**提前 return**（`!target` 分支），而券类领取写在那个 return 之后 —— 于是 10:00 前点
 * 「领兑换码」拿到的是**每日签到的报错**（「签到活动尚未刷新，请在 10:00 后重试」），
 * 券类那段代码根本没被执行。券类与每日活动是**互相独立**的两件事，不能共用一个前置判定。
 */
export async function performQoderCheckin(
  token: string,
  realm: QoderRealm = 'cn',
  uid = '',
  sess?: CosySession,
  device?: QoderDeviceIdentity,
  opts?: { includeCoupons?: boolean; couponsOnly?: boolean }
): Promise<QoderCheckinOutcome> {
  const couponsOnly = opts?.couponsOnly === true
  // couponsOnly 隐含 includeCoupons：只领券的调用方显然要券
  const includeCoupons = opts?.includeCoupons === true || couponsOnly
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
  /** 奖励类（Credits）活动：只有这些参与每日签到判定 */
  const daily: QoderCampaign[] = []
  /** 券类活动（非 Credits）：只有 includeCoupons 时才进入领取流程 */
  const coupons: QoderCampaign[] = []
  /** 非 CLAIMABLE/CLAIMED 的奖励类活动：带原因码，用于把「领不到」讲清楚 */
  const notClaimable: QoderCampaign[] = []
  for (const c of raw) {
    if (!c) continue
    // 空 actionType 也算奖励类：hub qoder_accounts.py:1127/1150 与 qoder_tasks.py:275
    // 都把 "" 与 CLAIM_BENEFIT 并列（`action_type in ("", "CLAIM_BENEFIT")`）。
    // 旧实现只认字面量 CLAIM_BENEFIT，会把「每日领取 Credits」这类未回填
    // actionType 的活动整条丢掉 → 误报「无可用签到活动」。
    const action = String(c.actionType || '')
    if (action !== '' && action !== 'CLAIM_BENEFIT') continue

    // 只认 Credits 积分奖励（对齐 hub campaign_checkin 的 only_kinds=("", "CREDITS")，
    // qoder_accounts.py:1123-1126）：兑换券/周边类活动（REDEMPTION_CODE 等）与每日签到
    // 无关，混进来会让「已领过一张券」被当成「今天积分已领」→ 假 already、当天 0 积分。
    //
    // 但**不是丢弃**：券类是唯一涉及不可恢复资产的活动（码只回一次），
    // 故单独收进 coupons，由 includeCoupons 决定是否领取——旧实现直接 continue 掉，
    // 等于连「丢」都无从察觉。
    const kind = String(c.benefit?.kind || '').toUpperCase()
    if (isQoderCouponKind(kind)) {
      if (c.claimStatus === 'CLAIMABLE') coupons.push(c)
      continue
    }

    daily.push(c)
    if (c.claimStatus !== 'CLAIMABLE' && c.claimStatus !== 'CLAIMED') notClaimable.push(c)
  }
  // 目标：优先真正可领的每日活动。
  // ⚠️ 不能因为列表里存在任意 CLAIMED 就断言「今天已领」：同一个活动（如
  // act-20260930-894，key 里的日期是**活动起始日**、不是当天）的 claimStatus 会
  // 按轮次滚动，而每轮要等 **CST 10:00** 才刷新放量（见 qoderDailyRoundOpen）。
  // 刷新前列表里残留的 CLAIMED 属于**上一轮**，据此短路就会「自动签到报 already、
  // 积分一整天不动」（2026-10-03 实例：09:01 报 already、额度 395 未动；
  // 10:23 手工才 +100 → 495）。
  const target = daily.find((c) => c.claimStatus === 'CLAIMABLE') || null
  const alreadyClaimedList = daily.filter((c) => c.claimStatus === 'CLAIMED')
  // 轮次是否已滚动到「今天这一轮」：未滚动时，列表里的 CLAIMED 是上一轮残留，
  // 不能当作「今日已领」的证据。
  const roundOpen = qoderDailyRoundOpen(Date.now())

  /**
   * 领券（含逐条码回传与同人去重冷却回报）。
   *
   * 抽成闭包的原因（2026-10-09 实测缺陷）：券类领取原先只写在「每日签到成功」那条路径的
   * 末尾，而每日签到有多条**提前 return**（未刷新 / 名额发完 / 无活动）。10:00 前点
   * 「领兑换码」拿到的就是每日签到的报错，券类那段代码压根没执行。
   * 券类与每日签到是**互相独立**的两件事，必须在所有分支上都能走到。
   */
  const claimCoupons = async () => {
    const notes: string[] = []
    const codes: Array<{ campaignId: string; campaign: string; code: string }> = []
    const blocked: string[] = []
    /** 真正失败的条目数（同人去重与「发放确认中」都不算失败） */
    let failed = 0
    if (!includeCoupons || coupons.length === 0) return { notes, codes, blocked, failed }
    for (const c of coupons) {
      const cid = c.campaignId
      if (!cid) continue
      const label = c.campaignKey || cid
      const kindLabel = qoderCouponKindLabel(c.benefit?.kind)
      const r = await claimQoderCampaign(token, realm, s, device, cid, label, dbg)
      if (r.outcome?.blocked) {
        blocked.push(cid)
        notes.push(`${label}（${kindLabel}）：同人已领取，本轮跳过`)
        continue
      }
      if (r.outcome && !r.outcome.success) {
        failed++
        notes.push(`${label}（${kindLabel}）：${r.outcome.message}`)
        continue
      }
      if (r.code) {
        // 码只回一次：回传给调用方落盘（KV），并在 message 里明示，避免用户以为没领到
        codes.push({ campaignId: cid, campaign: label, code: r.code })
        notes.push(`${label}（${kindLabel}）：兑换码 ${r.code}`)
      } else if (r.confirming) {
        notes.push(`${label}（${kindLabel}）：已领取，兑换码发放确认中`)
      } else {
        notes.push(`${label}（${kindLabel}）：已领取`)
      }
    }
    return { notes, codes, blocked, failed }
  }

  /**
   * 券类结果的统一出口（只领券模式下，它就是整个操作的结果）。
   *
   * `success` 用**显式失败计数**判定，不靠文案匹配：只有「一条都没成功且确实有失败」
   * 才算失败（部分成功也如实算成功，并把失败项写在 message 里）。
   */
  const couponOutcome = (r: Awaited<ReturnType<typeof claimCoupons>>, fallbackMessage: string): QoderCheckinOutcome => {
    const attempted = r.notes.length + r.blocked.length
    return {
      success: !(r.failed > 0 && attempted === r.failed),
      message: r.notes.length > 0 ? `券类福利：${r.notes.join('；')}` : fallbackMessage,
      couponCodes: r.codes.length > 0 ? r.codes : undefined,
      couponBlocked: r.blocked.length > 0 ? r.blocked : undefined,
      redemptionCode: r.codes[0]?.code,
      debug: dbg,
    }
  }

  // 只领券模式：完全不参与每日签到判定（它有自己的前置条件，与本操作无关）
  if (couponsOnly) {
    if (coupons.length === 0) {
      return {
        success: true,
        already: true,
        message: raw.length === 0
          ? '当前没有可领取的活动（活动列表为空）'
          : '当前没有可领取的兑换码/券类活动（可能已领过，或本轮未开放）',
        debug: dbg,
      }
    }
    return couponOutcome(await claimCoupons(), '当前没有可领取的兑换码/券类活动')
  }

  if (!target) {
    // 每日签到本身没有可领项 —— 但**券类仍然要领**（若调用方要求）。
    // 2026-10-09 实测缺陷：旧实现直接 return，于是 10:00 前点「领兑换码」拿到的
    // 是每日签到的报错，券类那段代码根本没执行。两者是独立的事，不能共用一个前置判定。
    const couponRes = await claimCoupons()
    const couponSuffix = couponRes.notes.length > 0 ? `；券类福利：${couponRes.notes.join('；')}` : ''
    const withCoupons = (out: QoderCheckinOutcome): QoderCheckinOutcome => ({
      ...out,
      message: out.message + couponSuffix,
      couponCodes: couponRes.codes.length > 0 ? couponRes.codes : undefined,
      couponBlocked: couponRes.blocked.length > 0 ? couponRes.blocked : undefined,
      redemptionCode: couponRes.codes[0]?.code,
      // 每日签到没领到、但券领到了：整体仍算成功（券是独立收益），否则面板会报「失败」
      // 而用户明明拿到了码 —— 那正是「码只回一次却显示失败」的误导。
      success: out.success || couponRes.codes.length > 0,
    })

    // 区分两种「没活动」：真的没有活动 vs 服务端把本客户端判定为非官方身份而过滤掉全部活动。
    // hub qoder_accounts.py:929-1005 用 showCampaign 标记这一点，并靠刷新机器身份重试；
    // 不区分就会把「身份被过滤」误报成「今天没活动」，让人以为签到正常。
    const showCampaign = list.showCampaign
    if (showCampaign === false) {
      return withCoupons({
        success: false,
        message:
          '活动列表被上游按机器身份过滤（showCampaign=false）：服务端未认可本客户端的设备身份，' +
          '故「每日领取 Credits」等设备定向活动未下发。这不是「今天没有活动」。',
        debug: dbg,
      })
    }

    const formatNotClaimable = (items: QoderCampaign[]) => items
      .map((c) => {
        const reason = String(c.unavailableReason || '').toUpperCase()
        const key = c.campaignKey || c.campaignId || '(无 key)'
        const why =
          reason === 'REDEMPTION_CODE_OUT_OF_STOCK'
            ? '名额已发完（每日 10:00 刷新，次日或 10:00 后可再领）'
            : reason === 'ACHIEVEMENT_NOT_COMPLETED' || c.achievementCompleted === false
              ? `需先在官方桌面端完成新人任务${c.requiredAchievementKey ? `（成就 ${c.requiredAchievementKey}）` : ''}`
              : reason || `状态 ${c.claimStatus || '(空)'}`
        return `${key}: ${why}`
      })
      .join('；')

    if (alreadyClaimedList.length > 0) {
      // 避免历史其它已领活动掩盖今日签到名额发完：
      // 若已领列表里全无 Credits 额度包，且存在名额已发完活动，则按名额发完报错
      const outOfStockItems = notClaimable.filter((c) => String(c.unavailableReason || '').toUpperCase() === 'REDEMPTION_CODE_OUT_OF_STOCK')
      const hasClaimedCredits = alreadyClaimedList.some((c) => (c.benefit?.amount || 0) > 0)
      if (!hasClaimedCredits && outOfStockItems.length > 0) {
        return withCoupons({
          success: false,
          message: `签到活动名额已发完（${formatNotClaimable(outOfStockItems)}）`,
          debug: dbg,
        })
      }

      const keys = alreadyClaimedList.map((c) => c.campaignKey || c.campaignId).filter(Boolean).join('、')

      // 轮次未滚动（今天 10:00 之前）：这里的 CLAIMED 是**上一轮**残留，不是今天的。
      // 若照旧报 already，就会重演「自动签到假成功、积分一整天不落账」——宁可如实
      // 报「本轮未刷新、10:00 后重试」，也不要给一个会误导人的绿勾。
      if (!roundOpen) {
        return withCoupons({
          success: false,
          message:
            `每日签到活动尚未刷新（Qoder 每轮 CST 10:00 放量）：列表里的已领取记录` +
            `${keys ? `（${keys}）` : ''}属于上一轮，不能证明今天已领。请在 10:00 后重试。`,
          debug: dbg,
        })
      }

      let msg = keys ? `今日已领取（${keys}）` : '今日已领取'
      if (notClaimable.length > 0) {
        msg += `；另有活动暂不可领：${formatNotClaimable(notClaimable)}`
      }
      return withCoupons({
        success: true,
        already: true,
        message: msg,
        campaignKey: alreadyClaimedList[0]?.campaignKey,
        debug: dbg,
      })
    }

    // 有活动但都不可领：把上游原因码如实带出来（hub qoder_accounts.py:1145-1148 同样分类：
    // REDEMPTION_CODE_OUT_OF_STOCK=名额发完、ACHIEVEMENT_NOT_COMPLETED=需先完成新人任务）。
    // 全部塌缩成一句「没有 CLAIMABLE 的 CLAIM_BENEFIT」会让人无从判断下一步。
    if (notClaimable.length > 0) {
      return withCoupons({
        success: false,
        message: `签到活动暂不可领取（共 ${raw.length} 个活动，${notClaimable.length} 个奖励类活动均不可领）—— ${formatNotClaimable(notClaimable)}`,
        debug: dbg,
      })
    }
    return withCoupons({
      success: false,
      message: `无可用签到活动（${raw.length} 个活动里没有可领取的 Credits 奖励活动）`,
      debug: dbg,
    })
  }
  const campaignId = target.campaignId
  if (!campaignId) return { success: false, message: '签到活动缺少 campaignId', debug: dbg }

  const claimed = await claimQoderCampaign(token, realm, s, device, campaignId, target.campaignKey, dbg)
  if (claimed.outcome) return claimed.outcome

  const amount = claimed.amount
  // 券类活动一并领取（仅在调用方显式要求时；见 includeCoupons 说明）。
  // 走 claimCoupons 闭包：与「只领券」模式共用同一段实现，避免两处漂移。
  const couponRes = await claimCoupons()

  let message = amount ? `领取成功 +${amount} ${target.campaignKey || ''}`.trim() : '签到成功'
  if (claimed.code) message += `，兑换码：${claimed.code}`
  if (couponRes.notes.length > 0) message += `；福利：${couponRes.notes.join('；')}`
  return {
    success: true,
    message,
    rewardCredits: amount,
    campaignKey: target.campaignKey,
    campaignId,
    // 积分活动本身也可能带码（券类活动的积分变体），一并带出
    redemptionCode: claimed.code || couponRes.codes[0]?.code,
    couponCodes: couponRes.codes.length > 0 ? couponRes.codes : undefined,
    couponBlocked: couponRes.blocked.length > 0 ? couponRes.blocked : undefined,
    confirming: claimed.confirming || undefined,
    // claim 响应的 expiresAt 是 ISO 串（如 "2026-11-01T10:52:18.531379Z"，= 领取时刻 + 30 天）
    rewardExpiresAt: parseCstWallClock(claimed.expiresAt) ?? undefined,
    debug: dbg,
  }
}

/** 单次活动领取的解析结果（供每日积分活动与券类活动共用）。 */
interface QoderClaimOutcome {
  /** 非 null = 该结果应直接作为整个签到结果返回（失败/已领/同人已领） */
  outcome: QoderCheckinOutcome | null
  amount?: number
  code?: string
  confirming?: boolean
  expiresAt?: string
}

/**
 * POST 一次活动领取并解析响应（hub `claim_campaign`，qoder_accounts.py:1050-1096）。
 *
 * 抽出来的原因：每日积分活动与券类活动走的是**同一个端点、同一套响应语义**
 * （hub 也是同一个 `claim_campaign`），各写一遍必然漂移——而这里每一条分支都对应
 * 一种用户可见的结论（已领 / 同人去重 / 风控拦截 / 发放确认中 / 拿到码）。
 */
async function claimQoderCampaign(
  token: string,
  realm: QoderRealm,
  s: CosySession,
  device: QoderDeviceIdentity | undefined,
  campaignId: string,
  campaignKey: string | undefined,
  dbg: QoderCheckinDebug
): Promise<QoderClaimOutcome> {
  const label = campaignKey || campaignId
  let claimRes: Response
  try {
    claimRes = await checkinRequest('POST', `/sash/api/v1/me/campaigns/${campaignId}/claim`, token, realm, s, device)
  } catch (e) {
    return { outcome: { success: false, message: (e as Error).message || '网络请求失败', debug: dbg } }
  }
  const claimText = await claimRes.text().catch(() => '')
  dbg.claimHttp = claimRes.status
  dbg.claimBody = claimText.substring(0, 500)

  const upperBody = claimText.toUpperCase()
  if (!claimRes.ok) {
    // 409 或 body 含 ALREADY = 幂等命中（服务端说「已经领过了」），不是失败。
    // hub pro_claim 同口径（qoder_accounts.py:1316）；签到路径同理：把「已领」报成
    // 「领取失败 http 409」会让人以为账号坏了，实际是重复请求的正常结果。
    if (claimRes.status === 409 || upperBody.includes('ALREADY')) {
      return { outcome: { success: true, already: true, message: `今日已领取（${label}）`, campaignKey, debug: dbg } }
    }
    // 上游失败码优先于 HTTP 状态码：`_CAMPAIGN_FAILURE_CN` 的文案比「http 4xx」有用得多
    const failure = matchQoderFailureCode(upperBody)
    if (failure) {
      return { outcome: { success: false, message: `${label}：${QODER_CAMPAIGN_FAILURE_CN[failure]}`, campaignKey, debug: dbg } }
    }
    return { outcome: { success: false, message: `领取失败 http ${claimRes.status}: ${claimText.substring(0, 200)}`, debug: dbg } }
  }

  let cr: QoderClaimResponse
  try {
    cr = claimText ? JSON.parse(claimText) : {}
  } catch {
    return { outcome: { success: false, message: `领取响应格式异常: ${claimText.substring(0, 200)}`, debug: dbg } }
  }

  const status = String(cr.status || '').toUpperCase()
  const failure = String(cr.failureCode || '').toUpperCase()

  // 服务端按「人」去重：同设备/身份下其他账号本轮已领（hub qoder_accounts.py:1059）。
  // 账号本身没问题，请求也合法——旧实现把它塌缩成「未知状态: BLOCKED」，
  // 用户只看到一句含糊状态，无从知道「换个号也没用、要等下一轮」。
  if (QODER_SAME_PERSON_MARKERS.includes(failure) || status === 'BLOCKED') {
    return {
      outcome: {
        success: false,
        blocked: true,
        message: `${label}：同人已领取（同一设备/身份下其他账号本轮已领，服务端按人去重）`,
        campaignKey,
        debug: dbg,
      },
    }
  }

  if (!status && cr.replayed !== undefined && cr.status === undefined) {
    // 响应既无 status 也无明确成功标记 → 交由下面统一按未知状态处理
  }

  // 兑换码类奖励：官方客户端语义 = CLAIMED 且 redemptionCode 非空才算拿到；
  // 仅 CLAIMED 无码 = 发放确认中（hub qoder_accounts.py:1070-1072/1089）。
  const code = String(cr.redemptionCode || '').trim()

  if (failure && QODER_CAMPAIGN_FAILURE_CN[failure]) {
    return {
      outcome: { success: false, message: `${label}：${QODER_CAMPAIGN_FAILURE_CN[failure]}`, campaignKey, redemptionCode: code || undefined, debug: dbg },
    }
  }

  if (status === 'CLAIMED' || status === 'GRANTED' || status === 'SUCCESS') {
    if (cr.replayed) {
      return { outcome: { success: true, already: true, message: `今日已领取（${label}）`, campaignKey, redemptionCode: code || undefined, debug: dbg } }
    }
    return {
      outcome: null,
      amount: typeof cr.benefit?.amount === 'number' ? cr.benefit.amount : (typeof cr.amount === 'number' ? cr.amount : undefined),
      code: code || undefined,
      confirming: status === 'CLAIMED' && !code,
      expiresAt: cr.expiresAt,
    }
  }
  return { outcome: { success: false, message: `${label}：未知状态 ${cr.status || '(空)'}`, campaignKey, debug: dbg } }
}

/**
 * 从响应文本里认出官方失败码（hub `_CAMPAIGN_FAILURE_CN` 的键）。
 *
 * 为什么要扫文本而不是只读结构化字段：`failureCode` 有时只出现在**嵌套的错误体字符串**里
 * （HTTP 4xx 的 body 就是原始 JSON 文本），只读字段会漏掉「风控拦截」这类关键结论。
 */
function matchQoderFailureCode(upperText: string): string | null {
  for (const code of Object.keys(QODER_CAMPAIGN_FAILURE_CN)) {
    if (upperText.includes(code)) return code
  }
  if (upperText.includes('SAME_PERSON_ALREADY_CLAIMED')) return 'SAME_PERSON_ALREADY_CLAIMED'
  return null
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

/** 面板与池状态里的权益包名——唯一定义处（checkin 写路径与测试都引用它）。 */
export const QODER_PACK_BASE = '套餐额度'
/**
 * 旧版**聚合**包名（把整个加购桶当成一个包）。
 *
 * 2026-10-07 起不再写入：它把「最后一笔签到的到期时间」当成整桶的到期时间，导致面板日期
 * 每天往后跳、且挑号永远进不了 7 天窗口（详见 qoder/grants.ts 文件头）。
 * 保留常量只为一件事：**首次迁移**时从池里读回那份历史到期时间当上界
 * （legacyQoderAddonExpireAt），别把已经观测到的信息丢掉。
 */
export const QODER_PACK_ADDON = '签到/赠送额度'
/** 每笔签到各占一行的包名前缀（与 WorkBuddy / TRAE 的按包明细同构）。 */
export const QODER_GRANT_PACK_PREFIX = '签到额度'
/** 未记账余额（记账前的历史余额 / 非签到发放的赠送分）的包名。 */
export const QODER_UNBOOKED_PACK_NAME = '签到额度（未记账余额）'
/**
 * 到期时间未知时的展示值。
 *
 * 必须是**非空且不可解析**：空串会被面板渲染成「长期」（那是谎——这些分确实会过期），
 * 不可解析的串会原样灰字显示（见 pages.ts wbPackExpireHtml），
 * 且 credit-expiry 的判定只认有限正数 → 自动不参与「7 天内到期优先」。
 */
export const QODER_EXPIRE_UNKNOWN = '到期未知'

/** 旧聚合包（QODER_PACK_ADDON）里记录的历史到期时间（epoch ms）；没有 → 0。仅首次迁移用。 */
export function legacyQoderAddonExpireAt(prev: readonly PackageInfo[] | null | undefined): number {
  if (!Array.isArray(prev)) return 0
  const p = prev.find((x) => x && x.name === QODER_PACK_ADDON)
  return parseCstWallClock(p?.expireAt) ?? 0
}

/** 账本里的一笔 → 一个权益包（面板一行），与 WorkBuddy 的包同形态。 */
export function qoderGrantPack(g: QoderAddonGrant): PackageInfo {
  const unbooked = isQoderUnbookedGrant(g)
  // 包名带领取日期（CST），否则一屏「签到额度」无法区分哪笔是哪笔
  const day = unbooked ? '' : formatCstWallClock(g.at).slice(5, 10)
  return {
    name: unbooked ? QODER_UNBOOKED_PACK_NAME : `${QODER_GRANT_PACK_PREFIX} ${day}`.trim(),
    expireAt: g.expireAt > 0 ? formatCstWallClock(g.expireAt) : QODER_EXPIRE_UNKNOWN,
    size: g.size,
    used: g.used,
    unit: 'credits',
  }
}

/**
 * 组装权益包列表（`PackageInfo` 形态，`expireAt` 统一为 CST 墙钟串）。
 *
 * 为什么要把 Qoder 的额度也装成 PackageInfo：这样面板的到期渲染/排序/「⏳ N 个包 7 天内到期」
 * 徽章、以及 credit-expiry 的到期优先判定，全部与 workbuddy 共用同一套实现（零新渲染逻辑）。
 *
 * **一个包 = 一笔**（套餐额度 + 账本里每一笔签到/赠送）：上游只给聚合桶，逐笔明细由
 * qoder/grants.ts 记账得来。这样「7 天内到期」的徽章与挑号依据、以及概览里
 * 「N 天内到期 余 X」的金额，都自动按笔算准——旧实现把整桶标成一个到期时间时，
 * 概览会把整桶都算成"即将作废"，挑号则永远看不到真正最早那笔。
 */
export function buildQoderPacks(
  quota: { baseQuota: QoderQuotaSplit; planExpiresAt: number },
  grants: readonly QoderAddonGrant[]
): PackageInfo[] {
  return [
    {
      name: QODER_PACK_BASE,
      expireAt: formatCstWallClock(quota.planExpiresAt),
      size: quota.baseQuota.size,
      used: quota.baseQuota.used,
      unit: 'credits',
    },
    ...(grants || []).map(qoderGrantPack),
  ]
}

/**
 * 拉取额度：上游只有 userQuota（基础额度）+ addOnQuota（赠送/签到额度）两个聚合桶。
 * 返回 null 表示数据缺失（非耗尽）。
 *
 * 除聚合值外还返回**分项**与套餐到期时间：套餐到期来自顶层 `expiresAt`（基础额度作废时刻）；
 * `addonQuota` 没有到期时间，它的**剩余量**是 qoder/grants.ts 逐笔记账的 FIFO 结算依据
 * （明细由 claim 响应的 expiresAt 一笔笔攒，上游不给）。
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

/** GET /api/v1/userinfo 响应里用到的字段（其余字段与本网关无关，忽略）。 */
export interface QoderUserInfo {
  /** 上游权威 uid（userinfo.id）；上游没给则空串 */
  uid: string
  /** 账号昵称（userinfo.name）。**这是 Qoder 唯一可得的展示名来源**，可能为空 */
  name: string
  /** 用户类型（如 personal_professional_trial） */
  userType: string
  organizationId: string
  organizationName: string
}

/**
 * 拉取账号身份：昵称 / 用户类型 / 组织。
 *
 * 为什么必须有它（2026-10-07 用户报「qoder 只显示一长串 id，能不能像 workbuddy 那样显示昵称」）：
 * Qoder 的**设备授权响应与 token 刷新响应都不带任何名字**（只有 token/refresh_token/user_id，
 * 见 oauth.ts pollOauthQoderFlow 的响应类型与 qoder 的 `dt-` token 不是 JWT、无法解 claims），
 * 所以池里 nickname 一直是空的，面板只能退化成 36 位 UUID——这正是用户看到的那一行。
 * `/api/v1/userinfo` 是唯一来源，两份参考实现都用它取名：
 *   - qoder2api-hub qoder_accounts.py:1729-1743（`ui.get("name")` → nickname，`ui.get("id")` → uid）；
 *   - qoder2api account/oauth.go:221-233（同端点、同 `Bearer` 明文鉴权）。
 * 端点路径由 hub README:150 与 region.go:26/37 交叉确认（双域均存在）。
 *
 * 失败一律返回 null（**不抛**）：这是纯展示增强，绝不能让它把签到/登录流程带崩。
 */
export async function fetchQoderUserInfo(token: string, realm: QoderRealm = 'cn'): Promise<QoderUserInfo | null> {
  if (!token) return null
  try {
    const res = await fetch(QODER_OPENAPI[realm] + '/api/v1/userinfo', {
      method: 'GET',
      headers: billingHeaders(token),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const ui = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!ui || typeof ui !== 'object') return null
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      uid: str(ui.id),
      name: str(ui.name),
      userType: str(ui.user_type),
      organizationId: str(ui.organization_id),
      organizationName: str(ui.organization_name),
    }
  } catch {
    return null
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

// ===== Pro 升级包（一次性 +1800 积分，hub qoder_accounts.py:1289-1323） =====

/** Pro 升级包端点（hub PATH_PRO_ELIGIBILITY / PATH_PRO_CLAIM，qoder_accounts.py:96-97）。 */
export const QODER_PATH_PRO_ELIGIBILITY = '/sash/api/v1/me/pro-upgrade/eligibility'
export const QODER_PATH_PRO_CLAIM = '/sash/api/v1/me/pro-upgrade/claim'

/**
 * 上游不回传金额时的兜底（hub `PRO_REWARD_CREDIT`，qoder_tasks.py:739）。
 *
 * 1800 = **18 天签到量**（每日 100）。这是每个账号一次性的白拿额度，旧实现完全没做。
 */
export const QODER_PRO_REWARD_CREDIT = 1800

/**
 * 派生一个 36 位设备/会话标识（hub `derive_id`，qoder_fingerprint.py:20-26）。
 *
 * `md5(salt + ":" + uid)` 的十六进制；md5 本身就是 32 位，故 `[:36]` 即全量
 * （与 cosy.ts 的 `md5Hex('machine:' + seed)` 逐字节同值）。
 * 幂等：同一账号每次调用产生相同值，避免随机机器码触发上游风控。
 */
function qoderDeriveId(uid: string, salt: string): string {
  return md5Hex(`${salt}:${uid || 'anonymous'}`)
}

/**
 * 带稳定前缀 + 微秒后缀的防风控请求 ID（hub `generate_request_id`，
 * qoder_fingerprint.py:29-33）。
 *
 * 前缀按 uid 派生（可溯源到账号），后缀取当前微秒的低 6 位（防重放）。
 */
function qoderGenerateRequestId(uid: string): string {
  const prefix = qoderDeriveId(uid, 'req')
  const suffix = String(Date.now() % 1000000).padStart(6, '0')
  return `${prefix}-${suffix}`
}

/**
 * Pro 升级包端点专用头（hub `Account.headers()`，qoder_accounts.py:640-652）。
 *
 * ## 为什么不能复用 checkinHeaders
 *
 * 两者是**两套不同口径**，混用会把错误的身份形态发给上游：
 *   - 本函数（hub `headers()`）：纯 Bearer + `X-Machine-ID`/`X-Session-ID`/`X-Request-ID`
 *     + Origin/Referer，**没有任何 cosy-machine\*** 头；
 *   - `checkinHeaders`（hub `desktop_headers()`，qoder_accounts.py:654-686）：桌面端
 *     活动平台口径，带六个 `cosy-machine*`。
 *
 * Pro 端点走前者（hub 的 `pro_eligibility`/`pro_claim` 都调 `self.headers()`）。
 * 这不是「少发几个头」——hub 的逐头隔离实验（issue #10）证明机器头形态本身就是
 * 服务端的判别信号，发错形态会被按非官方客户端处理。
 */
function proHeaders(token: string, uid: string, realm: QoderRealm): Record<string, string> {
  const site = QODER_WEBSITE[realm]
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Go-http-client/2.0',
    'Authorization': `Bearer ${token}`,
    'X-Request-ID': qoderGenerateRequestId(uid),
    'X-Machine-ID': qoderDeriveId(uid, 'machine'),
    'X-Session-ID': qoderDeriveId(uid, 'session'),
    'Origin': site,
    'Referer': site + '/',
  }
}

/** Pro 升级包资格查询结果。 */
export interface QoderProEligibility {
  /** 查询本身是否成功（**不代表可领取**） */
  ok: boolean
  /** 是否可领取 */
  eligible: boolean
  /** 查询失败时的原因 */
  error?: string
}

/**
 * 查询 Pro 升级包资格（GET，hub `pro_eligibility`，qoder_accounts.py:1290-1303）。
 *
 * `404/403/410` 一律按「**查询成功但不可领取**」处理（`ok:true, eligible:false`）：
 * 端点不存在 / 活动已下线时，账号侧的正确结论就是「没得领」，报成查询失败会让批量汇总
 * 每次都多一条假告警。
 */
export async function proEligibility(token: string, realm: QoderRealm = 'cn', uid = ''): Promise<QoderProEligibility> {
  let res: Response
  try {
    res = await fetch(QODER_OPENAPI[realm] + QODER_PATH_PRO_ELIGIBILITY, {
      method: 'GET',
      headers: proHeaders(token, uid, realm),
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    return { ok: false, eligible: false, error: (e as Error).message || '网络请求失败' }
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 403 || res.status === 410) {
      return { ok: true, eligible: false }
    }
    return { ok: false, eligible: false, error: `HTTP ${res.status}` }
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: true, eligible: body?.eligible === true }
}

/** Pro 升级包领取结果。 */
export interface QoderProClaimResult {
  ok: boolean
  /** true = 之前已经领过（幂等命中，不是失败） */
  already?: boolean
  message: string
  /** 领取成功时的积分（上游不回传金额则用 QODER_PRO_REWARD_CREDIT 兜底） */
  rewardCredits?: number
  error?: string
}

/**
 * 领取 Pro 升级包（POST 空 JSON body，hub `pro_claim`，qoder_accounts.py:1305-1323）。
 *
 * ## 必须区分 `claimed_now` 与 `already`（源明确记载的历史缺陷）
 *
 * hub `run_pro_claim` 的注释（qoder_tasks.py:745-752）写着：不区分会让批量汇总的
 * `credit_added` **每次虚增 +1800**。故这里 `already` 时**不给** `rewardCredits`，
 * 由调用方据此决定是否记账。
 *
 * 幂等判据与源逐字同构：`HTTP 409` 或 body 含 `ALREADY` → 已领取过（成功语义）。
 */
export async function proClaim(token: string, realm: QoderRealm = 'cn', uid = ''): Promise<QoderProClaimResult> {
  let res: Response
  try {
    res = await fetch(QODER_OPENAPI[realm] + QODER_PATH_PRO_CLAIM, {
      method: 'POST',
      headers: proHeaders(token, uid, realm),
      body: '{}',
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    return { ok: false, message: (e as Error).message || '网络请求失败', error: (e as Error).message }
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    if (res.status === 409 || text.toUpperCase().includes('ALREADY')) {
      return { ok: true, already: true, message: 'Pro 升级包已领取过' }
    }
    return { ok: false, message: `领取失败 http ${res.status}: ${text.substring(0, 160)}`, error: `HTTP ${res.status}` }
  }
  let body: Record<string, unknown> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    return { ok: false, message: `领取响应格式异常: ${text.substring(0, 160)}`, error: 'parse' }
  }
  // `ALREADY` 出现在**任何**位置都按「已领过」处理（不限于 HTTP 409 与 success:false）。
  // 为什么比源更宽一格：源只在 HTTPError 分支扫这个字样，而 200 信封里同样可能带它。
  // 把它误判成「本次新领」会让批量汇总的积分虚增 +1800 —— 这正是源明确记载的历史缺陷，
  // 故宁可多认一层，也不冒虚增的风险（判错的代价不对称：少算一次 vs 多算一次）。
  if (text.toUpperCase().includes('ALREADY')) {
    return { ok: true, already: true, message: 'Pro 升级包已领取过' }
  }
  if (body?.success === false) {
    const msg = String(body?.message || text).substring(0, 160)
    return { ok: false, message: `领取失败: ${msg}`, error: msg }
  }
  // 上游可能回传真实金额；没有则用源同款兜底 1800
  const amount = typeof body?.amount === 'number' ? (body.amount as number) : QODER_PRO_REWARD_CREDIT
  return { ok: true, message: `Pro 升级包领取成功 +${amount}`, rewardCredits: amount }
}
