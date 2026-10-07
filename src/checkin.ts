/**
 * checkin.ts — WorkBuddy/CodeBuddy 每日签到（移植自 cpa-plugin/workbuddy）。
 *
 * 协议（来源 cpa-plugin/workbuddy/billing.go）：
 *   状态：POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status（fallback .../checkin-status）
 *   签到：POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
 *   认证：Authorization: Bearer <access_token>
 *   信封：{ code, msg, data }，code=0 成功
 *
 * 流程（对齐 checkin.go/checkinOneAccount）：
 *   Global 账号跳过 → 调状态 → today_checked_in 则跳过 → 否则调 daily-checkin
 *   → code=0 成功；业务错误 msg 含「已签/already/今日」视为已签到
 *
 * 仅 CN 账号（JWT iss 含 codebuddy.cn）可签到；Global（workbuddy.ai）无签到。
 * 多账号：遍历所有 oauth-device provider，各自签到。
 */
import { Context } from 'hono'
import type { Env, Provider, CheckinResult, ApiResponse, PackageInfo } from './types'
import { KV_KEYS, CHECKIN_RESULT_TTL_SEC, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import { getProviders } from './storage'
import { getOauthAccessToken, detectTokenRealm, refreshQoderTokenPair } from './oauth'
import { writeLog } from './admin'
import { isQoderFlow } from './qoder/proxy'
import { fetchQoderCheckinStatus, performQoderCheckin, fetchQoderUserResource, fetchQoderPaymentType, buildQoderPacks, normalizeQoderRealm, realmHasLegacyCheckin, type QoderRealm } from './qoder/billing'
import { getQoderDevice } from './qoder/device'
import {
  readQoderPool,
  seedQoderPoolFromSingle,
  refreshQoderPoolAccountIfNeeded,
  reenableQoderIfCredits,
  setQoderPoolAccountNickname,
  type QoderPoolAccount,
} from './qoder/pool'
import { isTraeProvider } from './trae/proxy'
import { runTraeCheckins, readTraeCheckinResults } from './trae/admin'
import { listTraeStatus } from './trae/pool'
import type { TraeCheckinResult } from './trae/types'
import {
  isOAuthPoolProvider,
  readOauthPool,
  refreshOauthPoolAccount,
  reenableOauthIfCredits,
  seedOauthPoolFromSingle,
  setOauthPoolAccountNickname,
} from './oauth-pool'
import type { OAuthPoolAccount } from './oauth-pool'
import {
  billingCall,
  pickBool,
  pickNum,
  decodeWorkbuddyClaims,
  fetchWorkbuddyCredits,
  fetchWorkbuddyPaymentType,
  reportWorkbuddyChatActivity,
  fetchWorkbuddyStreak,
  runWorkbuddyCatTravel,
  runWorkbuddyGrowthRewards,
  fetchWorkbuddyRewardState,
  type WorkbuddyRewardState,
  isAlreadyCheckin,
  billingMeterPaths,
  claimGlobalTrial,
  delayMs,
  completeGlobalRegionFlow,
  fetchIntlCountries,
  type RegionCountry,
  ACTIVITY_ACCOUNT_DELAY_MS,
} from './workbuddy-billing'
import { queryUsageOverview } from './analytics/query'
import { MAX_ADMIN_REQUEST_BYTES, readOptionalJSONLimited } from './request-body'

/**
 * 国际版注册地区默认兜底（取不到白名单时用，region 完善提交所需）。
 * 与源实现 global_region.py 的默认选择对齐（新加坡）。
 */
const FALLBACK_GLOBAL_REGION: RegionCountry = {
  EnName: 'Singapore',
  Name: 'Singapore',
  IOS2: 'SG',
  IOS3: 'SGP',
  Code: '65',
}

/**
 * 取国际版注册地区：优先 `/billing/area/get-country-code` 白名单第一条
 * （顺序 = web 展示顺序，HK 起），拉取失败回退默认地区。
 */
async function pickGlobalRegion(): Promise<RegionCountry> {
  try {
    const r = await fetchIntlCountries(true)
    if (r.ok && r.list.length > 0) return r.list[0]
  } catch { /* 回退默认 */ }
  return FALLBACK_GLOBAL_REGION
}

/**
 * global 账号注册激活自愈（移植 workbuddy2api activate_region / complete_flow）。
 *
 * 上游对「未完成注册激活」的试用账号，所有 chat/completions 请求都会返回
 * 429 code 14017（"trial version is not yet activated"），换号/重试/退避均无效。
 * 这里先补齐 register + 注册地区完善（幂等：已激活时仅一次 register 查询即返回），
 * 再配合调用方领取一次性 trial 加油包，打通试用通道。
 *
 * 失败只返回结果、不抛出，由调用方记录面板展示；不影响 global 签到语义。
 */
async function ensureGlobalActivation(token: string, uid: string): Promise<{ ok: boolean; message: string }> {
  const res = await completeGlobalRegionFlow(token, uid, await pickGlobalRegion())
  return { ok: res.ok, message: res.msg }
}

/** 查询签到状态。依次试两个端点（CPA fallback 模式）。 */
async function fetchCheckinStatus(
  token: string,
  realm: 'cn' | 'global'
): Promise<{ active: boolean; todayCheckedIn: boolean; streakDays?: number; totalCredits?: number; dailyCredit?: number } | null> {
  // 状态端点候选序列：CN 用带 /v2 的两种拼写；global 另加无 /v2 前缀形态（源实现 R9：
  // 国际版无 /v2 前缀，路径族按 realm 切）。仅 404 会换下一条（billingCall 的 paths 语义）。
  const paths = realm === 'global'
    ? [
        '/billing/meter/checkin-activity-status', '/billing/meter/checkin-status',
        '/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status',
      ]
    : ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  let lastErr: Error | null = null
  for (const path of paths) {
    try {
      const data = await billingCall(token, path, realm, { paths: [path] })
      const m = (data || {}) as Record<string, any>
      return {
        active: pickBool(m, 'active', 'Active'),
        todayCheckedIn: pickBool(m, 'today_checked_in', 'todayCheckedIn'),
        streakDays: pickNum(m, 'streak_days', 'streakDays'),
        totalCredits: pickNum(m, 'total_credits', 'totalCredits'),
        dailyCredit: pickNum(m, 'daily_credit', 'dailyCredit'),
      }
    } catch (e) {
      lastErr = e as Error
    }
  }
  // 状态查询失败不致命（签到调用本身幂等），返回 null 让调用方决定
  console.warn(`[checkin] status fetch failed: ${lastErr?.message}`)
  return null
}

/** 执行签到。返回 { success, message, reward?, already? }。 */
export async function performCheckin(
  token: string,
  realm: 'cn' | 'global',
  env?: Env
): Promise<{ success: boolean; message: string; reward?: any; already?: boolean }> {
  try {
    // 路径按 realm 切（global 无 /v2 前缀优先，404 时 fallback），对齐 workbuddy2api checkinMeterPaths。
    // 当前 global 账号在上层已提前 return（不签到），此处保持按 realm 正确以便未来放开即生效。
    const paths = billingMeterPaths('daily-checkin', realm)
    const data = await billingCall(token, paths[0], realm, { paths })
    return { success: true, message: '签到成功', reward: data }
  } catch (e) {
    // 幂等判定走三段式（移植 workbuddy2api cmd/signin/main.go）：
    // 结构化业务错误（BillingError）认业务码 10001/14001（带边界）+ 全量文案；
    // 传输层/解析层裸错误只认中文文案，避免 "address already in use" 这类文本被误判为已签到。
    if (isAlreadyCheckin(e)) {
      return { success: true, message: '今日已签到', already: true }
    }
    return { success: false, message: (e as Error).message }
  }
}

// JWT 解码 / 额度拉取已抽到 src/workbuddy-billing.ts（decodeWorkbuddyClaims / fetchWorkbuddyCredits / fetchWorkbuddyPaymentType）

/**
 * 拉取额度 + 套餐类型并填充到 base。额度拉取抛错时写日志（含 uid/eid 诊断）。
 * 在所有 return 前调用，确保"今日已签"也能拿到额度。
 */
async function fillCredits(env: Env, base: CheckinResult, token: string, realm: 'cn' | 'global', uid: string, enterpriseId: string, deviceToken?: string) {
  try {
    const credits = await fetchWorkbuddyCredits(token, realm, uid, enterpriseId, deviceToken)
    base.totalRemain = credits.totalRemain
    base.totalUsed = credits.totalUsed
    base.totalSize = credits.totalSize
    base.packCount = credits.packCount
    if (credits.packages && credits.packages.length > 0) {
      base.packages = credits.packages
    }
  } catch (e) {
    try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度拉取失败: ${(e as Error).message}`, `uid=${uid || '(空)'} eid=${enterpriseId || '(空)'}`) } catch { /* ignore */ }
  }
  try {
    const pt = await fetchWorkbuddyPaymentType(token, realm, uid, enterpriseId)
    if (pt) base.paymentType = pt
  } catch { /* ignore */ }
}

// ===== QoderWork 签到（flowType=qoder，dt- token） =====

/** 拉取 Qoder 额度 + 套餐填充到 base（失败只写日志，不影响签到结果）。
 *  返回额度接口的原始响应体（截断），供签到日志区分「真没额度」与「解析成 0」。
 *
 *  同时把额度拆成两个带到期时间的包（buildQoderPacks）落进 base.packages：
 *  面板据此显示「到期时间 + 剩 N 天」，挑号据此优先消耗快过期的积分。
 *  `rewardExpiresAt` = 本次新领积分的到期时刻（claim 响应），已签到路径没有新 grant，
 *  由 `prevPackages`（池里已存的包）兜底，避免每日「已签到」把到期时间擦掉。 */
async function fillQoderCredits(
  env: Env,
  base: CheckinResult,
  token: string,
  realm: QoderRealm,
  opts?: { rewardExpiresAt?: number; prevPackages?: readonly PackageInfo[] }
): Promise<string | undefined> {
  let quotaRaw: string | undefined
  try {
    const credits = await fetchQoderUserResource(token, realm)
    if (credits) {
      base.totalRemain = credits.totalRemain
      base.totalUsed = credits.totalUsed
      base.totalSize = credits.totalSize
      base.packCount = credits.packCount
      base.packages = buildQoderPacks(credits, opts?.rewardExpiresAt, opts?.prevPackages)
      quotaRaw = credits.raw
    } else {
      try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度无数据（quota/usage 响应为空）`, '') } catch { /* ignore */ }
    }
  } catch (e) {
    try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度拉取失败: ${(e as Error).message}`, '') } catch { /* ignore */ }
  }
  try {
    const pt = await fetchQoderPaymentType(token, realm)
    if (pt) base.paymentType = pt
  } catch { /* ignore */ }
  return quotaRaw
}

/**
 * QoderWork 池内单账号签到：状态探测 → 已签跳过 → 否则签到 → 拉额度 → 回写池（积分/解冻/昵称）。
 */
async function checkinQoderPoolAccount(env: Env, provider: Provider, account: QoderPoolAccount): Promise<CheckinResult> {
  const now = Date.now()
  // 账号域：签到端点与 legacy 能力都按域区分（国际版 legacy 接口不存在）
  const realm = normalizeQoderRealm(account.realm)
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    uid: account.uid || undefined,
    realm,
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
    nickname: account.nickname || account.uid,
  }

  let token = account.token?.access_token || ''
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = '无 access token'
    return base
  }
  // 临近过期先刷新（写回池）
  if (account.token.refresh_token && account.token.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS) {
    try {
      const refreshed = await refreshQoderPoolAccountIfNeeded(env, provider.id, account.uid, provider.oauth!, refreshQoderTokenPair)
      if (refreshed) token = refreshed.token.access_token
    } catch { /* 刷新失败继续用旧 token */ }
  }
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = 'token 刷新失败，无可用 access token'
    return base
  }

  // 状态探测（legacy daily-check-in/status）。
  // 国际版该接口**不存在**（openapi.qoder.sh 返回 404，qoder2api-hub 实测），
  // 故先按域跳过，避免把「接口不存在」误报成签到失败。活动平台双区域通用，
  // 跳过状态探测不影响下面的 campaigns 领取。
  let status: Awaited<ReturnType<typeof fetchQoderCheckinStatus>> = null
  if (realmHasLegacyCheckin(realm)) {
    try {
      status = await fetchQoderCheckinStatus(token, realm, account.uid)
    } catch (e) {
      console.warn(`[checkin] ${provider.name} qoder status fetch failed: ${(e as Error).message}`)
    }
  }
  if (status) {
    base.todayCheckedIn = status.todayCheckedIn
    base.streakDays = status.streakDays
    base.totalCredits = status.totalCredits
    base.dailyCredit = status.dailyCredit
    if (status.todayCheckedIn) {
      base.success = true
      base.reason = 'already'
      base.message = '今日已签到'
      base.lastCheckinAt = Date.now()
      await fillQoderCredits(env, base, token, realm, { prevPackages: account.state?.packages })
      await syncQoderPoolCredits(env, provider.id, account, base)
      return base
    }
  }

  // 执行签到（campaigns 流程；legacy daily-check-in/claim 已 DISABLED，不再使用）
  // 真机设备身份优先（管理后台「Qoder 设备身份」配置，存 KV）：官方 2026-09-26 起要求带
  // 设备标识才下发每日活动；未配置时回退 uid 派生值——派生值拿不到「每日领取 100 Credits」，
  // 日志里标出是哪一种。
  const device = await getQoderDevice(env)
  const res = await performQoderCheckin(token, realm, account.uid, undefined, device)
  base.success = res.success
  base.message = res.message
  // already = 今日已领取（replayed / 列表 CLAIMED），与「本次新领」区分开：
  // 面板按 reason 聚合「成功/已签」，混在一起会让当日实际领取数虚高。
  base.reason = res.success ? (res.already ? 'already' : 'ok') : 'fail'
  base.lastCheckinAt = Date.now()
  if (res.success) base.todayCheckedIn = true
  if (!res.already && typeof res.rewardCredits === 'number' && res.rewardCredits > 0) {
    base.checkinCredit = res.rewardCredits
  }

  // 签到成功后额度已变化，拉最新额度（本次新领的到期时刻来自 claim 响应）
  const quotaRaw = await fillQoderCredits(env, base, token, realm, {
    rewardExpiresAt: res.rewardExpiresAt,
    prevPackages: account.state?.packages,
  })
  await syncQoderPoolCredits(env, provider.id, account, base)

  // ===== 签到日志（落系统日志，供「提示成功但积分没增加」定位） =====
  // 关键是把**前后额度差**与**上游原始字段**一起留档：只有 message 时无法区分
  // 「服务端 replayed=true（本就已领，不会加分）」「claim 返回 CLAIMED 但
  // benefit.amount 缺失」「活动不可领」三种情况，只能靠猜。
  const creditsBefore = typeof account.state?.credits === 'number' ? account.state.credits : null
  const creditsAfter = typeof base.totalRemain === 'number' ? base.totalRemain : null
  const creditsDelta = creditsBefore !== null && creditsAfter !== null ? creditsAfter - creditsBefore : null
  if (res.success && !res.already && creditsDelta === 0) {
    // 真正可疑的状态：服务端说领到了，但额度没动。直接写进面板文案，不必翻日志。
    base.message = `${base.message}（注意：额度未变化 可用 ${creditsBefore} → ${creditsAfter}）`
  }
  try {
    await writeLog(
      env,
      res.success ? 'request' : 'warn',
      `[qoder-checkin] ${account.nickname || account.uid} → ${res.success ? (res.already ? 'already' : 'claimed') : 'fail'}` +
        (creditsDelta !== null ? ` 额度 ${creditsBefore} → ${creditsAfter}（Δ${creditsDelta >= 0 ? '+' : ''}${creditsDelta}）` : ''),
      JSON.stringify({
        providerId: provider.id,
        uid: account.uid,
        realm,
        outcome: { success: res.success, already: res.already, rewardCredits: res.rewardCredits, campaignKey: res.campaignKey },
        credits: { before: creditsBefore, after: creditsAfter, delta: creditsDelta },
        debug: res.debug,
        quotaRaw,
        // native = 已在管理后台配置真机身份；derived = 回退 uid 派生值（拿不到设备定向活动）
        deviceIdentity: device ? 'native' : 'derived',
      }).substring(0, 4000)
    )
  } catch { /* 日志失败不影响签到结果 */ }
  return base
}

/**
 * 签到后把额度/额度包/昵称回写 Qoder 池：积分>0 的冷却账号自动解冻（对齐 WorkBuddy 池）。
 *
 * `totalRemain === 0`（额度真用尽）也要回写：那不是失败，`state.credits` 与额度包明细
 * （面板到期展示 + 「到期优先」挑号的数据源）都必须更新；解冻只在 remain > 0 时发生，
 * 由 reenableQoderIfCredits 内部把关。
 */
async function syncQoderPoolCredits(env: Env, providerId: string, account: QoderPoolAccount, base: CheckinResult): Promise<void> {
  try {
    if (typeof base.totalRemain === 'number') {
      await reenableQoderIfCredits(env, providerId, account.uid, base.totalRemain, base.packages)
    }
    if (base.nickname && base.nickname !== account.nickname) {
      await setQoderPoolAccountNickname(env, providerId, account.uid, base.nickname)
    }
  } catch { /* 回写失败不影响签到结果 */ }
}

/**
 * QoderWork 多账号池签到：遍历池内所有账号各自签到，返回带 accounts 的汇总结果。
 */
async function checkinQoderPoolAccounts(env: Env, provider: Provider): Promise<CheckinResult> {
  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    realm: 'cn',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
  }
  // 兼容迁移：池空时把既有单 token 种子进池
  try { await seedQoderPoolFromSingle(env, provider.id) } catch { /* ignore */ }
  const pool = await readQoderPool(env, provider.id)
  if (pool.length === 0) {
    base.reason = 'skipped_no_token'
    base.message = '账号池为空（未登录任何账号）'
    return base
  }

  const accounts: CheckinResult[] = []
  let success = 0, already = 0, fail = 0, skipped = 0
  for (const acc of pool) {
    try {
      const r = await checkinQoderPoolAccount(env, provider, acc)
      accounts.push(r)
      if (r.success) {
        if (r.reason === 'already') already++
        else if (r.reason === 'ok') success++
        else skipped++
      } else {
        fail++
      }
    } catch (e) {
      accounts.push({
        providerId: provider.id, name: provider.name, uid: acc.uid || undefined,
        realm: normalizeQoderRealm(acc.realm),
        success: false, reason: 'fail', message: (e as Error).message || String(e),
        todayCheckedIn: false, updatedAt: Date.now(), nickname: acc.nickname || acc.uid,
      })
      fail++
    }
  }

  base.accounts = accounts
  base.todayCheckedIn = accounts.some((a) => a.todayCheckedIn)
  base.success = success > 0 || already > 0
  base.reason = success > 0 ? 'ok' : (already > 0 ? 'already' : (fail > 0 ? 'fail' : 'skipped_no_token'))
  base.message = `共 ${accounts.length} 个账号：成功 ${success} / 已签 ${already} / 失败 ${fail} / 跳过 ${skipped}`
  // 汇总：额度取剩余最多的账号（挑号依据）
  let bestAcc: CheckinResult | null = null
  for (const a of accounts) {
    if (a.reason === 'ok' || a.reason === 'already') {
      if (!bestAcc || (a.totalRemain || 0) > (bestAcc.totalRemain || 0)) bestAcc = a
    }
  }
  if (bestAcc) {
    base.totalRemain = bestAcc.totalRemain
    base.totalUsed = bestAcc.totalUsed
    base.totalSize = bestAcc.totalSize
    base.packCount = bestAcc.packCount
    base.paymentType = bestAcc.paymentType
    base.nickname = bestAcc.nickname
    base.streakDays = bestAcc.streakDays
    base.totalCredits = bestAcc.totalCredits
  }
  await writeCheckinResult(env, provider.id, base)
  return base
}

// ===== KV 结果读写 =====

const resultKey = (providerId: string) => KV_KEYS.CHECKIN_RESULT_PREFIX + providerId

export async function readCheckinResult(env: Env, providerId: string): Promise<CheckinResult | null> {
  const raw = await env.KV.get(resultKey(providerId))
  // R9：损坏的 JSON 视为无结果，不能让 JSON.parse 抛错打断签到列表渲染
  if (!raw) return null
  try {
    return JSON.parse(raw) as CheckinResult
  } catch {
    return null
  }
}

async function writeCheckinResult(env: Env, providerId: string, result: CheckinResult): Promise<void> {
  try {
    await env.KV.put(resultKey(providerId), JSON.stringify(result), {
      expirationTtl: CHECKIN_RESULT_TTL_SEC,
    })
  } catch (e) {
    console.warn(`[checkin] write result failed: ${(e as Error).message}`)
  }
}

// ===== 单账号签到 =====

/**
 * 把刚拉到的额度写回池账号 state.credits（对齐 workbuddy-wild ReenableIfCredits）：
 * 所有拿到额度的路径（成功/已签/global）都调用，否则池面板"积分"会一直显示 0。
 *
 * 同时落盘本次探测的权益包明细（含到期时间）：这是「7 天内到期积分优先」挑号的数据源。
 * 走到这里即代表额度探测成功，故传 `[]` 也有语义（探测成功但无包）——会清掉旧明细，
 * 避免已消失的包继续把挑号钉在某个账号上。
 */
async function syncPoolCredits(env: Env, provider: Provider, account: OAuthPoolAccount, base: CheckinResult) {
  try {
    if (typeof base.totalRemain === 'number') {
      await reenableOauthIfCredits(env, provider.id, account.uid, base.totalRemain, base.packages ?? [])
    }
  } catch { /* ignore */ }
  // 回写昵称到池账号：池侧 nickname 常为空（登录时未解出 JWT），签到时从
  // token 解出后写回，保证账号池列表与签到结果可用 nickname 对齐
  try {
    if (base.nickname && base.nickname !== account.nickname) {
      await setOauthPoolAccountNickname(env, provider.id, account.uid, base.nickname)
    }
  } catch { /* ignore */ }
}

/**
 * WorkBuddy 池内单账号签到 + 额度刷新 + 解冻。
 * 账号 credentials 来自池（oauth:pool:<id>），token 临近过期先刷新（写回池）。
 *
 * opts.interactive：交互式端点（用户等待）→ 活跃上报不做条间间隔。
 */
async function checkinOauthPoolAccount(
  env: Env,
  provider: Provider,
  account: OAuthPoolAccount,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    uid: account.uid || undefined,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
    nickname: account.nickname || undefined,
  }

  let token = account.token?.access_token || ''
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = '无 access token'
    return base
  }
  // 临近过期先刷新（写回池）
  if (account.token.refresh_token && account.token.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS) {
    try {
      const refreshed = await refreshOauthPoolAccount(env, provider.id, account.uid, provider.oauth!)
      if (refreshed) token = refreshed.token.access_token
    } catch { /* 刷新失败继续用旧 token */ }
  }
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = 'token 刷新失败，无可用 access token'
    return base
  }

  const claims = decodeWorkbuddyClaims(token)
  const uid = account.uid || claims.uid
  const enterpriseId = claims.enterpriseId
  // JWT 是昵称的**唯一权威来源**，必须无条件覆盖池内存储值：
  // 池里的旧值可能是历史版本按 Latin-1 写坏的乱码（å¦¹ / å¿«å¿«ä¹ä¹）。
  // 若沿用「仅在为空时补」的写法，base.nickname 会一直等于乱码旧值，
  // 下面 syncPoolCredits 的回写判定（base.nickname !== account.nickname）恒为 false，
  // 乱码将永久留在 KV 里——这正是「部署了修复但面板仍乱码」的原因。
  if (claims.nickname) {
    base.nickname = claims.nickname
  }

  const realm = detectTokenRealm(token)
  if (realm === 'global') {
    base.realm = 'global'
    base.reason = 'skipped_global'
    base.message = '国际版账号无签到功能'
    base.success = true
    const devTokenGlobalEarly = account.token?.device_token || provider.oauth?.deviceToken
    await fillCredits(env, base, token, 'global', uid, enterpriseId, devTokenGlobalEarly)

    // 国际版**活跃上报**放开（移植 workbuddy2api a190252 / PR #45 实测）：
    // global 账号无签到/任务中心体系（D4 门控，下面 checkin/travel 仍跳过），
    // 但 `/v2/report` 在 workbuddy.ai 上可用（code=0），**同样点亮连登**。
    // billingCall 已按 realm 切 base（workbuddy.ai/v2/report）与 Origin/UA，无需额外改动。
    // 失败只记入结果，不改变 base.success（签到语义上 global 仍算"跳过"）。
    const devTokenGlobal = account.token?.device_token || provider.oauth?.deviceToken
    try {
      const act = await reportWorkbuddyChatActivity(token, 'global', uid, { enterpriseId, deviceToken: devTokenGlobal, count: 5, gapMs: opts?.interactive ? 0 : undefined })
      base.activityReport = { success: act.success, message: act.message }
    } catch (e) {
      base.activityReport = { success: false, message: (e as Error).message }
    }
    try {
      const streak = await fetchWorkbuddyStreak(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
      if (typeof streak === 'number') base.streakDays = streak
    } catch { /* ignore */ }

    // 国际版注册激活自愈（移植 workbuddy2api activate_region / complete_flow）：
    // 补齐 register + 地区，解决上游 chat 429 code 14017「trial not activated」。
    // 失败只记录，不改 base.success（global 签到语义仍算"跳过"）。uid 缺失则跳过。
    if (uid) {
      try {
        base.globalActivation = await ensureGlobalActivation(token, uid)
      } catch (e) {
        base.globalActivation = { ok: false, message: (e as Error).message }
      }
    }
    // 国际版一次性 trial 加油包（移植 workbuddy2api trial.go）：global 无签到/任务中心，
    // trial 是其唯一天然积分增益动作。幂等（14051 = 已领过，视为正常）。
    // 失败不影响 base.success（签到语义上 global 仍算"跳过"），只记录结果供面板展示。
    try {
      const tr = await claimGlobalTrial(token)
      base.trialClaim = { success: tr.ok, already: tr.already, message: tr.msg }
    } catch (e) {
      base.trialClaim = { success: false, already: false, message: (e as Error).message }
    }

    // 注意：**不**做猫猫旅行（runWorkbuddyCatTravel）——global 无猫猫旅行体系
    //（对齐 workbuddy2api travel.go:56-58 的 D4 门控）。

    await syncPoolCredits(env, provider, account, base)
    return base
  }
  if (realm !== 'cn') {
    base.realm = 'unknown'
    base.reason = 'fail'
    base.message = '无法判断账号领域（非 WorkBuddy token）'
    return base
  }
  base.realm = 'cn'

  // 状态探测
  const status = await fetchCheckinStatus(token, 'cn')
  if (status) {
    base.todayCheckedIn = status.todayCheckedIn
    base.streakDays = status.streakDays
    base.totalCredits = status.totalCredits
    base.dailyCredit = status.dailyCredit
    if (status.todayCheckedIn) {
      base.success = true
      base.reason = 'already'
      base.message = '今日已签到'
      base.lastCheckinAt = now
    }
  }

  // 未签到则执行签到
  if (!base.todayCheckedIn) {
    const res = await performCheckin(token, 'cn', env)
    base.success = res.success
    base.message = res.message
    base.reason = res.success ? (res.already ? 'already' : 'ok') : 'fail'
    base.lastCheckinAt = now
    if (res.success) base.todayCheckedIn = true
  }

  // 生态增值与自动化任务（P2）：活跃上报（点亮连登/领猫门槛） + 回读 streak + 猫猫旅行
  const devToken = account.token?.device_token || provider.oauth?.deviceToken
  let activityReportedOk = false
  try {
    // gapMs：交互式端点跳过条间间隔（5×1.5s 会让手动操作卡 6s+）
    const act = await reportWorkbuddyChatActivity(token, 'cn', uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: opts?.interactive ? 0 : undefined })
    base.activityReport = { success: act.success, message: act.message }
    activityReportedOk = act.success
  } catch (e) {
    base.activityReport = { success: false, message: (e as Error).message }
  }

  // 连登奖励 + 兑换状态**一次读完**（移植 workbuddy2api 91418c5 GrowthRewardState）：
  // 上游设计该端点为"一次 GET 同时给出 streak.days 与 redemption_status（各档状态），免二次请求"。
  // 故这里读一次，既回填面板展示的连登天数，又供下面的连登奖励兑换复用（避免同端点打两遍）。
  let rewardState: WorkbuddyRewardState | null = null
  try {
    rewardState = await fetchWorkbuddyRewardState(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (rewardState) base.streakDays = rewardState.days
  } catch { /* ignore */ }

  try {
    // 传 env/providerId 启用领养当日防抖（对齐 workbuddy2api adoptTriedToday）：
    // 门槛未达时同日不再重试领养，避免对上游重试轰炸。
    // forceAdopt：本流程刚完成 5 条活跃上报 → 对话量可能刚好补满（"门槛刚达成"的新状态，
    // 不算对上游重试轰炸）→ 豁免当日防抖，就地闭环（对齐源实现 travelAdoptForce）。
    const travel = await runWorkbuddyCatTravel(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      forceAdopt: activityReportedOk,
    })
    base.catTravel = travel
  } catch (e) {
    base.catTravel = { state: 'error', message: (e as Error).message }
  }

  // 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5）：在活跃上报 + streak 自检之后执行，
  // 与源实现 scheduler.runActivity 的末段同序（活跃上报点亮连登 → 才有可领档位）。
  // 幂等闸用 KV 日键（`redeemTriedToday`），多 isolate 一致；正常态（已领/未达标/无次数）静默，
  // 失败只记录不改 base.success（与 catTravel 的失败口径一致）。
  // state=rewardState：复用上面那次读取，不再打一遍 /activity/growth/streak。
  try {
    base.growthReward = await runWorkbuddyGrowthRewards(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      state: rewardState,
    })
  } catch (e) {
    base.growthReward = { acted: false, message: (e as Error).message }
  }

  // 额度信息 + 解冻（签到就是为了解冻冷却账号，对齐 workbuddy-wild ReenableIfCredits）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId, devToken)
  await syncPoolCredits(env, provider, account, base)
  return base
}

/** WorkBuddy 池全账号签到，返回带 accounts 的汇总 CheckinResult（存 KV 供面板展示）。 */
/**
 * WorkBuddy 池全账号签到。
 *
 * opts.interactive：调用方是否为**用户等待的交互式端点**（管理后台手动触发）。
 * true 时跳过账号间限速与条间间隔——否则一次手动操作会因
 * "N 账号 × (5 条 × 1.5s + 0.8s)" 而卡住数十秒（且接近 Workers 请求时限）。
 * cron 后台路径保持 false（无客户端等待，防风控优先，对齐源实现后台调度语义）。
 */
async function checkinOauthPoolAccounts(
  env: Env,
  provider: Provider,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  const now = Date.now()
  const interactive = opts?.interactive === true
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
  }
  // 兼容迁移：池空时把既有单 token 种子进池
  try { await seedOauthPoolFromSingle(env, provider.id) } catch { /* ignore */ }
  const pool = await readOauthPool(env, provider.id)
  if (pool.length === 0) {
    base.reason = 'skipped_no_token'
    base.message = '账号池为空（未登录任何账号）'
    return base
  }

  const accounts: CheckinResult[] = []
  let success = 0, already = 0, fail = 0, skipped = 0
  let firstAccount = true
  for (const acc of pool) {
    // 账号间限速（对齐 workbuddy2api activityAccountDelay/travelAccountDelay = 800ms）：
    // 每账号签到内含 5 条活跃上报 + 旅行巡检（多个上游请求），
    // 池内账号连续无间隔处理会对上游形成突发压力。交互式端点跳过（用户等待）。
    if (!firstAccount && !interactive) await delayMs(ACTIVITY_ACCOUNT_DELAY_MS)
    firstAccount = false
    try {
      const r = await checkinOauthPoolAccount(env, provider, acc, { interactive })
      accounts.push(r)
      if (r.success) {
        if (r.reason === 'already') already++
        else if (r.reason === 'ok') success++
        else skipped++
      } else {
        fail++
      }
    } catch (e) {
      accounts.push({
        providerId: provider.id, name: provider.name, uid: acc.uid || undefined, realm: 'unknown',
        success: false, reason: 'fail', message: (e as Error).message || String(e),
        todayCheckedIn: false, updatedAt: Date.now(), nickname: acc.nickname || acc.uid,
      })
      fail++
    }
  }

  base.accounts = accounts
  base.todayCheckedIn = accounts.some((a) => a.todayCheckedIn)
  base.success = success > 0 || already > 0
  base.reason = success > 0 ? 'ok' : (already > 0 ? 'already' : (fail > 0 ? 'fail' : 'skipped_no_token'))
  base.message = `共 ${accounts.length} 个账号：成功 ${success} / 已签 ${already} / 失败 ${fail} / 跳过 ${skipped}`
  // 汇总额度：取任一成功账号
  const okOne = accounts.find((a) => a.reason === 'ok' || a.reason === 'already')
  if (okOne) {
    base.totalRemain = okOne.totalRemain
    base.totalUsed = okOne.totalUsed
    base.totalSize = okOne.totalSize
    base.packCount = okOne.packCount
    base.paymentType = okOne.paymentType
    base.nickname = okOne.nickname
    base.streakDays = okOne.streakDays
    base.totalCredits = okOne.totalCredits
  }
  await writeCheckinResult(env, provider.id, base)
  return base
}

/**
 * 单 provider 签到。
 * opts.interactive：交互式端点（管理后台手动触发，用户等待 HTTP 响应）→ 跳过防风控延时；
 * cron 后台路径保持缺省（false）。
 */
export async function checkinOneAccount(
  env: Env,
  provider: Provider,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  // WorkBuddy 多账号池：browser 登录流提供商遍历池内所有账号各自签到，返回带 accounts 的汇总结果
  if (isOAuthPoolProvider(provider)) {
    return checkinOauthPoolAccounts(env, provider, opts)
  }

  // QoderWork 多账号池：遍历池内所有账号各自签到，返回带 accounts 的汇总结果
  if (isQoderFlow(provider)) {
    return checkinQoderPoolAccounts(env, provider)
  }

  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
  }

  // 取 access token（自动刷新）
  const token = provider.oauth
    ? await getOauthAccessToken(env, provider.id, provider.oauth)
    : null
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = '无可用 token（未登录或刷新失败）'
    return base
  }

  // 从 JWT 解出 uid / enterpriseId / nickname（额度接口与面板展示用）
  const claims = decodeWorkbuddyClaims(token)
  const uid = claims.uid
  const enterpriseId = claims.enterpriseId
  if (claims.nickname) base.nickname = claims.nickname

  const realm = detectTokenRealm(token)
  if (realm === 'global') {
    base.realm = 'global'
    base.reason = 'skipped_global'
    base.message = '国际版账号无签到功能'
    base.success = true
    // 国际版也拉额度信息（对齐 CPA 面板展示）
    const devTokenGlobal = provider.oauth?.deviceToken
    await fillCredits(env, base, token, 'global', uid, enterpriseId, devTokenGlobal)
    // 国际版活跃上报放开（同池化路径，移植 workbuddy2api a190252 / PR #45）
    try {
      const act = await reportWorkbuddyChatActivity(token, 'global', uid, { enterpriseId, deviceToken: devTokenGlobal, count: 5, gapMs: opts?.interactive ? 0 : undefined })
      base.activityReport = { success: act.success, message: act.message }
    } catch (e) {
      base.activityReport = { success: false, message: (e as Error).message }
    }
    try {
      const streak = await fetchWorkbuddyStreak(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
      if (typeof streak === 'number') base.streakDays = streak
    } catch { /* ignore */ }
    // 国际版注册激活自愈（同池化路径，移植 workbuddy2api activate_region / complete_flow）：
    // 补齐 register + 地区，解决上游 chat 429 code 14017「trial not activated」。
    if (uid) {
      try {
        base.globalActivation = await ensureGlobalActivation(token, uid)
      } catch (e) {
        base.globalActivation = { ok: false, message: (e as Error).message }
      }
    }
    // 国际版一次性 trial 加油包（同池化路径，移植 workbuddy2api trial.go）
    try {
      const tr = await claimGlobalTrial(token)
      base.trialClaim = { success: tr.ok, already: tr.already, message: tr.msg }
    } catch (e) {
      base.trialClaim = { success: false, already: false, message: (e as Error).message }
    }
    // 不做猫猫旅行：global 无该体系（对齐 workbuddy2api travel.go:56-58 D4 门控）
    await writeCheckinResult(env, provider.id, base)
    return base
  }
  if (realm !== 'cn') {
    base.realm = 'unknown'
    base.reason = 'fail'
    base.message = '无法判断账号领域（非 WorkBuddy token）'
    return base
  }
  base.realm = 'cn'

  // 状态探测
  const status = await fetchCheckinStatus(token, 'cn')
  if (status) {
    base.todayCheckedIn = status.todayCheckedIn
    base.streakDays = status.streakDays
    base.totalCredits = status.totalCredits
    base.dailyCredit = status.dailyCredit
    if (status.todayCheckedIn) {
      base.success = true
      base.reason = 'already'
      base.message = '今日已签到'
      base.lastCheckinAt = now
    }
  }

  // 执行签到
  if (!base.todayCheckedIn) {
    const res = await performCheckin(token, 'cn', env)
    base.success = res.success
    base.message = res.message
    base.reason = res.success ? (res.already ? 'already' : 'ok') : 'fail'
    base.lastCheckinAt = now
    if (res.success) base.todayCheckedIn = true
    if (res.success && !res.already && res.reward && typeof (res.reward as any).credit === 'number') {
      base.checkinCredit = (res.reward as any).credit
    }
  }

  // 生态增值与自动化任务（P2）：活跃上报 + streak 回读 + 猫猫旅行
  const devToken = provider.oauth?.deviceToken
  let activityReportedOk = false
  try {
    const act = await reportWorkbuddyChatActivity(token, 'cn', uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: opts?.interactive ? 0 : undefined })
    base.activityReport = { success: act.success, message: act.message }
    activityReportedOk = act.success
  } catch (e) {
    base.activityReport = { success: false, message: (e as Error).message }
  }

  // 连登奖励 + 兑换状态**一次读完**（移植 workbuddy2api 91418c5 GrowthRewardState）：
  // 上游设计该端点为"一次 GET 同时给出 streak.days 与 redemption_status（各档状态），免二次请求"。
  // 故这里读一次，既回填面板展示的连登天数，又供下面的连登奖励兑换复用（避免同端点打两遍）。
  let rewardState: WorkbuddyRewardState | null = null
  try {
    rewardState = await fetchWorkbuddyRewardState(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (rewardState) base.streakDays = rewardState.days
  } catch { /* ignore */ }

  try {
    // 同池化路径：启用领养当日防抖 + 上报成功后豁免（对话量刚补满，就地闭环）
    const travel = await runWorkbuddyCatTravel(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      forceAdopt: activityReportedOk,
    })
    base.catTravel = travel
  } catch (e) {
    base.catTravel = { state: 'error', message: (e as Error).message }
  }

  // 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5，同池化路径）
  // state=rewardState：复用上面那次读取，不再打一遍 /activity/growth/streak。
  try {
    base.growthReward = await runWorkbuddyGrowthRewards(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      state: rewardState,
    })
  } catch (e) {
    base.growthReward = { acted: false, message: (e as Error).message }
  }

  // 额度信息（可用/已用/额度池/包数 + 套餐类型）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId, provider.oauth?.deviceToken)

  await writeCheckinResult(env, provider.id, base)
  return base
}

// ===== 全量签到 =====

// 签到仅支持 WorkBuddy（CN）和 QoderWork 账号。M365 Copilot / Gemini CLI 不含签到功能，
// 通过 flowType 排除（m365-pkce / m365-ropc / gemini）；TRAE SOLO 由 runTraeCheckins 单独处理。
const CHECKIN_EXCLUDED_FLOWS = ['m365-pkce', 'm365-ropc', 'gemini'] as const

/** 是否参与签到扫全量（WorkBuddy / QoderWork；排除 M365 / Gemini / TRAE）。 */
function participatesInCheckin(p: Provider): boolean {
  return p.authType === 'oauth-device' && !!p.oauth && !CHECKIN_EXCLUDED_FLOWS.includes(p.oauth.flowType as never) && !isTraeProvider(p)
}

/**
 * 结构上不参与签到的账号（skip 语义，**不是**「待签」）：
 * - skipped_global：国际版 WorkBuddy 无签到体系（`checkin.ts` realm==='global' 分支只做活跃上报）
 * - skipped_no_token：账号没有可用 access token，本轮不可能签成
 * 面板 KPI 若把它们计入分母，会长期显示「N 个待签」——用户已全部签到也无法清零。
 */
const CHECKIN_SKIPPED_REASONS = ['skipped_global', 'skipped_no_token'] as const

/** 是否为 skip（非「待签」）账号。KPI 分母与 runAllCheckins 的 skipped 口径共用此判定。 */
function isCheckinSkipped(r: Pick<CheckinResult, 'reason'>): boolean {
  return (CHECKIN_SKIPPED_REASONS as readonly string[]).includes(r.reason)
}

/**
 * 全量签到（遍历所有参与签到的 provider）。
 *
 * opts.interactive：交互式端点（用户等待）→ 跳过防风控延时。
 * 缺省 false（cron 后台路径，防风控优先）。
 */
export async function runAllCheckins(env: Env, silent = false, opts?: { interactive?: boolean }): Promise<{
  total: number
  success: number
  already: number
  fail: number
  skipped: number
  results: CheckinResult[]
}> {
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter(participatesInCheckin)

  const results: CheckinResult[] = []
  // 简单串行（账号数量通常很少，且避免并发刷新 token 冲突）
  for (const p of oauthProviders) {
    try {
      const r = await checkinOneAccount(env, p, { interactive: opts?.interactive })
      results.push(r)
      // 写日志（silent 模式跳过，用于面板后台静默刷新，避免日志噪音）
      if (!silent) {
        try {
          await writeLog(env, 'info', `[checkin] ${p.name} → ${r.reason}`, JSON.stringify(r))
        } catch { /* ignore */ }
      }
    } catch (e) {
      const r: CheckinResult = {
        providerId: p.id, name: p.name, realm: 'unknown',
        success: false, reason: 'fail', message: (e as Error).message,
        todayCheckedIn: false, updatedAt: Date.now(),
      }
      results.push(r)
    }
  }

  const success = results.filter((r) => r.reason === 'ok').length
  const already = results.filter((r) => r.reason === 'already').length
  const fail = results.filter((r) => r.reason === 'fail').length
  const skipped = results.filter((r) => isCheckinSkipped(r)).length

  return { total: results.length, success, already, fail, skipped, results }
}

// ===== Hono handlers（放此处避免与 admin.ts 循环依赖） =====

/** POST /admin/api/checkin 或 /api/manage/checkin：手动触发签到。body 可选 {id} 单个。 */
export async function handleCheckinTrigger(c: Context<{ Bindings: Env }>) {
  // 有界读取：body 可选（空 → 全量签到），容错语义与原 try/catch 一致；超限仍 413。
  const body = await readOptionalJSONLimited<{ id?: string; silent?: boolean }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const id = body.id?.trim()

  if (id) {
    const providers = (await getProviders(c.env)) as Provider[]
    const p = providers.find((x) => x.id === id)
    if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
    if (p.oauth?.flowType === 'm365-pkce' || p.oauth?.flowType === 'm365-ropc')
      return c.json<ApiResponse>({ success: false, message: 'M365 账号不参与签到' }, 400)
    if (p.oauth?.flowType === 'gemini')
      return c.json<ApiResponse>({ success: false, message: 'Gemini 账号无签到功能' }, 400)
    // interactive: true —— 管理后台手动触发，用户等待 HTTP 响应，
    // 跳过防风控延时（否则多账号 × 6s+ 会让操作明显卡顿）
    const result = await checkinOneAccount(c.env, p, { interactive: true })
    if (!body.silent) {
      try { await writeLog(c.env, 'info', `[checkin] ${p.name} → ${result.reason}（手动）`, JSON.stringify(result)) } catch { /* ignore */ }
    }
    return c.json<ApiResponse<CheckinResult>>({ success: true, data: result })
  }

  // interactive: true —— 手动全量签到（用户等待）
  const summary = await runAllCheckins(c.env, !!body.silent, { interactive: true })
  // 统一调度入口：全量签到同时覆盖 TRAE SOLO，返回合并摘要
  let traeSummary: Awaited<ReturnType<typeof runTraeCheckins>> | null = null
  try {
    traeSummary = await runTraeCheckins(c.env, !!body.silent)
  } catch { /* trae 签到失败不影响 workbuddy 结果 */ }
  return c.json<ApiResponse>({ success: true, data: { summary, trae: traeSummary } })
}

/** GET /admin/api/checkin/status：返回所有 provider 的签到结果（面板展示）。
 *  聚合两类：workbuddy（每 provider 一条 CheckinResult）+ trae（每 provider 一组账号结果）。 */
export async function handleCheckinStatus(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)) as Provider[]

  // WorkBuddy / QoderWork：oauth-device 家族（排除 M365 / Gemini / TRAE）
  const oauthProviders = providers.filter(participatesInCheckin)

  const workbuddy: CheckinResult[] = []
  for (const p of oauthProviders) {
    const r = await readCheckinResult(c.env, p.id)
    if (r) {
      workbuddy.push(r)
    } else {
      // 无结果占位，让面板知道有此 WorkBuddy 账号但未签到
      workbuddy.push({
        providerId: p.id, name: p.name, realm: 'unknown',
        success: false, reason: 'skipped_no_token', message: '尚未签到',
        todayCheckedIn: false, updatedAt: 0,
      })
    }
  }

  // TRAE SOLO：多账号池，每个 provider 读独立 KV，返回账号级结果
  const trae = await Promise.all(
    providers.filter((p) => isTraeProvider(p)).map(async (p) => {
      const raw = await c.env.KV.get(`${KV_KEYS.TRAE_CHECKIN_PREFIX}${p.id}`)
      let results: TraeCheckinResult[] = []
      try { results = raw ? JSON.parse(raw) : [] } catch { results = [] }
      return { providerId: p.id, name: p.name, results }
    })
  )

  return c.json<ApiResponse>({ success: true, data: { workbuddy, trae } })
}

/**
 * GET /admin/api/overview：概览驾驶舱聚合数据（P2）。
 * 聚合三类来源：WorkBuddy/QoderWork 签到 KV（额度/签到进度）+ TRAE SOLO 账号池与签到 KV
 * + Analytics Engine 24h 调用概况。任一来源失败不阻塞其它来源（analytics 不可用时 usage 为 null）。
 */
export async function handleAdminOverview(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)) as Provider[]

  // WorkBuddy/QoderWork 签到结果聚合：池账号逐个累加，单账号直接取。
  // skip 账号（国际版 / 无 token）不计入签到分子分母——它们结构上签不成，
  // 计入会让「今日签到」永不达标；但额度仍要累加（国际版账号照样消耗额度池）。
  const oauthProviders = providers.filter(participatesInCheckin)
  let checkedIn = 0, totalAccounts = 0, remain = 0, size = 0
  for (const p of oauthProviders) {
    const r = await readCheckinResult(c.env, p.id)
    if (!r) continue
    const accounts = r.accounts && r.accounts.length > 0 ? r.accounts : [r]
    for (const a of accounts) {
      if (!isCheckinSkipped(a)) {
        totalAccounts++
        if (a.todayCheckedIn) checkedIn++
      }
      if (typeof a.totalRemain === 'number') remain += a.totalRemain
      if (typeof a.totalSize === 'number') size += a.totalSize
    }
  }

  // TRAE SOLO：账号级签到结果与面板「今日签到」列同源；额度取账号池双通道合计
  // （SOLO 通用 + Work 专属）。只看 Work 会在没有 Work 权益包的账号上恒显 0——
  // 账号池里 credits/workCredits 由积分探测写入，两者互不替代。
  let traeRemain = 0, traeSize = 0, traeAccounts = 0, traeSoloRemain = 0, traeWorkRemain = 0
  for (const p of providers.filter((x) => isTraeProvider(x))) {
    const results = await readTraeCheckinResults(c.env, p.id)
    const doneUids = new Set(results.filter((r) => r.checkedIn).map((r) => r.uid))
    const accounts = await listTraeStatus(c.env, p)
    for (const a of accounts) {
      traeAccounts++
      totalAccounts++
      if (doneUids.has(a.uid)) checkedIn++
      const solo = typeof a.credits === 'number' ? a.credits : 0
      const work = typeof a.workCredits === 'number' ? a.workCredits : 0
      traeSoloRemain += solo
      traeWorkRemain += work
      traeRemain += solo + work
      for (const pack of a.packs || []) traeSize += pack.limit
    }
  }

  // 24h 调用概况（Analytics Engine 可能未启用/失败，降级为 null）
  let usage: { requests: number; successRate: number } | null = null
  try {
    const ov = await queryUsageOverview(c as unknown as Parameters<typeof queryUsageOverview>[0], '24h')
    usage = { requests: ov.requests, successRate: ov.successRate }
  } catch { /* analytics 不可用 */ }

  return c.json<ApiResponse>({
    success: true,
    data: {
      checkin: { checkedIn, totalAccounts, remain, size },
      trae: {
        remain: traeRemain, size: traeSize, accounts: traeAccounts,
        soloRemain: traeSoloRemain, workRemain: traeWorkRemain,
      },
      usage,
    },
  })
}

/** POST /admin/api/oauth/:id/activity：手动触发活跃上报。 */
export async function handleOAuthActivity(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const pool = await readOauthPool(c.env, p.id)
  if (pool.length === 0) return c.json<ApiResponse>({ success: false, message: '账号池为空' }, 400)

  const results: any[] = []
  let ok = 0
  for (const acc of pool) {
    if (acc.state?.disabled) continue
    const token = acc.token?.access_token || ''
    if (!token) continue
    const claims = decodeWorkbuddyClaims(token)
    const uid = acc.uid || claims.uid
    const enterpriseId = acc.token?.enterprise_id || claims.enterpriseId
    const devToken = acc.token?.device_token || p.oauth?.deviceToken
    // 按 token realm 决定上报域（global → workbuddy.ai/v2/report）：
    // 国际版 /v2/report 可用并点亮连登（移植 workbuddy2api a190252 / PR #45）。
    const accRealm = detectTokenRealm(token) === 'global' ? 'global' : 'cn'
    // gapMs=0：这是**管理后台手动端点**，用户会等待 HTTP 响应；5 条 × 1.5s = 6s 会让
    // 操作明显卡顿（且接近 Workers 请求时限）。防风控间隔仅在 cron 后台路径保留
    //（那里没有客户端等待，且源实现本身就是后台调度）。
    const res = await reportWorkbuddyChatActivity(token, accRealm, uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: 0 })
    if (res.success) ok++
    results.push({ uid, nickname: acc.nickname, realm: accRealm, ...res })
  }
  return c.json<ApiResponse>({ success: true, message: `已完成活跃上报（成功 ${ok}/${pool.length}）`, data: results })
}

/** POST /admin/api/oauth/:id/travel：手动触发猫猫旅行巡检。 */
export async function handleOAuthTravel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const pool = await readOauthPool(c.env, p.id)
  if (pool.length === 0) return c.json<ApiResponse>({ success: false, message: '账号池为空' }, 400)

  const results: any[] = []
  for (const acc of pool) {
    if (acc.state?.disabled) continue
    const token = acc.token?.access_token || ''
    if (!token) continue
    // global 账号无猫猫旅行体系（对齐 workbuddy2api travel.go:56-58 D4 门控），跳过不发请求
    if (detectTokenRealm(token) === 'global') continue
    const claims = decodeWorkbuddyClaims(token)
    const uid = acc.uid || claims.uid
    const enterpriseId = acc.token?.enterprise_id || claims.enterpriseId
    const devToken = acc.token?.device_token || p.oauth?.deviceToken
    // 传 env/providerId 启用领养当日防抖
    const res = await runWorkbuddyCatTravel(token, 'cn', uid, { enterpriseId, deviceToken: devToken, env: c.env, providerId: p.id })
    results.push({ uid, nickname: acc.nickname, ...res })
  }
  return c.json<ApiResponse>({ success: true, message: `已完成猫猫旅行巡检（共 ${results.length} 个账号）`, data: results })
}

/** POST /admin/api/oauth/:id/daily：一键日常任务（签到 + 活跃上报 + 猫猫旅行）。 */
export async function handleOAuthDaily(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  // interactive: true —— 一键日常是用户等待的交互式操作
  const result = await checkinOneAccount(c.env, p, { interactive: true })
  return c.json<ApiResponse<CheckinResult>>({ success: true, message: '已完成一键日常任务', data: result })
}

