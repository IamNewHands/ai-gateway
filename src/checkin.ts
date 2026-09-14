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
import type { Env, Provider, CheckinResult, ApiResponse } from './types'
import { KV_KEYS, CHECKIN_RESULT_TTL_SEC, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import { getProviders } from './storage'
import { getOauthAccessToken, detectTokenRealm, refreshQoderTokenPair } from './oauth'
import { writeLog } from './admin'
import { isQoderProvider } from './qoder/proxy'
import { fetchQoderCheckinStatus, performQoderCheckin, fetchQoderUserResource, fetchQoderPaymentType } from './qoder/billing'
import {
  readQoderPool,
  seedQoderPoolFromSingle,
  refreshQoderPoolAccountIfNeeded,
  reenableQoderIfCredits,
  setQoderPoolAccountNickname,
  type QoderPoolAccount,
} from './qoder/pool'
import { isTraeProvider } from './trae/proxy'
import { runTraeCheckins } from './trae/admin'
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
  isAlreadyCheckin,
  billingMeterPaths,
  claimGlobalTrial,
  delayMs,
  ACTIVITY_ACCOUNT_DELAY_MS,
} from './workbuddy-billing'
import { queryUsageOverview } from './analytics/query'

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

/** 执行签到。返回 { success, message }。 */
async function performCheckin(
  token: string,
  realm: 'cn' | 'global',
  env?: Env
): Promise<{ success: boolean; message: string; reward?: any }> {
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
      return { success: true, message: '今日已签到' }
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

/** 拉取 Qoder 额度 + 套餐填充到 base（失败只写日志，不影响签到结果）。 */
async function fillQoderCredits(env: Env, base: CheckinResult, token: string) {
  try {
    const credits = await fetchQoderUserResource(token)
    if (credits) {
      base.totalRemain = credits.totalRemain
      base.totalUsed = credits.totalUsed
      base.totalSize = credits.totalSize
      base.packCount = credits.packCount
    } else {
      try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度无数据（quota/usage 响应为空）`, '') } catch { /* ignore */ }
    }
  } catch (e) {
    try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度拉取失败: ${(e as Error).message}`, '') } catch { /* ignore */ }
  }
  try {
    const pt = await fetchQoderPaymentType(token)
    if (pt) base.paymentType = pt
  } catch { /* ignore */ }
}

/**
 * QoderWork 池内单账号签到：状态探测 → 已签跳过 → 否则签到 → 拉额度 → 回写池（积分/解冻/昵称）。
 */
async function checkinQoderPoolAccount(env: Env, provider: Provider, account: QoderPoolAccount): Promise<CheckinResult> {
  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    uid: account.uid || undefined,
    realm: 'cn',
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

  // 状态探测
  let status: Awaited<ReturnType<typeof fetchQoderCheckinStatus>> = null
  try {
    status = await fetchQoderCheckinStatus(token)
  } catch (e) {
    console.warn(`[checkin] ${provider.name} qoder status fetch failed: ${(e as Error).message}`)
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
      await fillQoderCredits(env, base, token)
      await syncQoderPoolCredits(env, provider.id, account, base)
      return base
    }
  }

  // 执行签到
  const res = await performQoderCheckin(token)
  base.success = res.success
  base.message = res.message
  base.reason = res.success ? 'ok' : 'fail'
  base.lastCheckinAt = Date.now()
  if (res.success) base.todayCheckedIn = true

  // 签到成功后额度已变化，拉最新额度
  await fillQoderCredits(env, base, token)
  await syncQoderPoolCredits(env, provider.id, account, base)
  return base
}

/** 签到后把额度/昵称回写 Qoder 池：积分>0 的冷却账号自动解冻（对齐 WorkBuddy 池）。 */
async function syncQoderPoolCredits(env: Env, providerId: string, account: QoderPoolAccount, base: CheckinResult): Promise<void> {
  try {
    if (typeof base.totalRemain === 'number' && base.totalRemain > 0) {
      await reenableQoderIfCredits(env, providerId, account.uid, base.totalRemain)
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
        providerId: provider.id, name: provider.name, uid: acc.uid || undefined, realm: 'cn',
        success: false, reason: 'fail', message: (e as Error).message || String(e),
        todayCheckedIn: false, updatedAt: Date.now(), nickname: acc.nickname || acc.uid,
      })
      fail++
    }
  }

  base.accounts = accounts
  base.todayCheckedIn = accounts.some((a) => a.todayCheckedIn)
  base.success = success > 0 || already > 0
  base.reason = base.success ? 'ok' : (fail > 0 ? 'fail' : 'skipped_no_token')
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
 */
async function syncPoolCredits(env: Env, provider: Provider, account: OAuthPoolAccount, base: CheckinResult) {
  try {
    if (typeof base.totalRemain === 'number') {
      await reenableOauthIfCredits(env, provider.id, account.uid, base.totalRemain)
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
  if (!base.nickname && claims.nickname) {
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
    base.reason = res.success ? 'ok' : 'fail'
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

  try {
    const streak = await fetchWorkbuddyStreak(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (typeof streak === 'number') base.streakDays = streak
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
  base.reason = base.success ? 'ok' : (fail > 0 ? 'fail' : 'skipped_no_token')
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
  if (provider.oauth?.flowType === 'qoder' || isQoderProvider(provider.id)) {
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
    base.reason = res.success ? 'ok' : 'fail'
    base.lastCheckinAt = now
    if (res.success) base.todayCheckedIn = true
    if (res.success && res.reward && typeof (res.reward as any).credit === 'number') {
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

  try {
    const streak = await fetchWorkbuddyStreak(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (typeof streak === 'number') base.streakDays = streak
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
  const skipped = results.filter((r) => r.reason === 'skipped_global' || r.reason === 'skipped_no_token').length

  return { total: results.length, success, already, fail, skipped, results }
}

// ===== Hono handlers（放此处避免与 admin.ts 循环依赖） =====

/** POST /admin/api/checkin 或 /api/manage/checkin：手动触发签到。body 可选 {id} 单个。 */
export async function handleCheckinTrigger(c: Context<{ Bindings: Env }>) {
  let body: { id?: string; silent?: boolean } = {}
  try { body = await c.req.json() } catch { /* 空 body，全量 */ }
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
 * 聚合两类来源：签到 KV（额度/签到进度）+ Analytics Engine 24h 调用概况。
 * 任一来源失败不阻塞另一来源（analytics 不可用时 usage 为 null，前端降级显示占位）。
 */
export async function handleAdminOverview(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)) as Provider[]

  // WorkBuddy/QoderWork 签到结果聚合：池账号逐个累加，单账号直接取
  const oauthProviders = providers.filter(participatesInCheckin)
  let checkedIn = 0, totalAccounts = 0, remain = 0, size = 0
  for (const p of oauthProviders) {
    const r = await readCheckinResult(c.env, p.id)
    if (!r) continue
    if (r.accounts && r.accounts.length > 0) {
      for (const a of r.accounts) {
        totalAccounts++
        if (a.todayCheckedIn) checkedIn++
        if (typeof a.totalRemain === 'number') remain += a.totalRemain
        if (typeof a.totalSize === 'number') size += a.totalSize
      }
    } else {
      totalAccounts++
      if (r.todayCheckedIn) checkedIn++
      if (typeof r.totalRemain === 'number') remain += r.totalRemain
      if (typeof r.totalSize === 'number') size += r.totalSize
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

