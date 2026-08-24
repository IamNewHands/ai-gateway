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
import { getOauthAccessToken, detectTokenRealm, readOauthToken } from './oauth'
import { writeLog } from './admin'
import { isQoderProvider } from './qoder/proxy'
import { fetchQoderCheckinStatus, performQoderCheckin, fetchQoderUserResource, fetchQoderPaymentType } from './qoder/billing'
import { isTraeProvider } from './trae/proxy'
import { runTraeCheckins } from './trae/admin'
import type { TraeCheckinResult } from './trae/types'
import {
  isOAuthPoolProvider,
  readOauthPool,
  refreshOauthPoolAccount,
  reenableOauthIfCredits,
  seedOauthPoolFromSingle,
} from './oauth-pool'
import type { OAuthPoolAccount } from './oauth-pool'
import {
  billingCall,
  pickBool,
  pickNum,
  decodeWorkbuddyClaims,
  fetchWorkbuddyCredits,
  fetchWorkbuddyPaymentType,
} from './workbuddy-billing'
import { queryUsageOverview } from './analytics/query'

/** 查询签到状态。依次试两个端点（CPA fallback 模式）。 */
async function fetchCheckinStatus(
  token: string,
  realm: 'cn' | 'global'
): Promise<{ active: boolean; todayCheckedIn: boolean; streakDays?: number; totalCredits?: number; dailyCredit?: number } | null> {
  const paths = ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  let lastErr: Error | null = null
  for (const path of paths) {
    try {
      const data = await billingCall(token, path, realm)
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
    const data = await billingCall(token, '/v2/billing/meter/daily-checkin', realm)
    return { success: true, message: '签到成功', reward: data }
  } catch (e) {
    const msg = (e as Error).message
    // 业务软失败（已签到类）→ 视为成功已签
    const low = msg.toLowerCase()
    if (low.includes('already') || msg.includes('已签') || msg.includes('今日')) {
      return { success: true, message: '今日已签到' }
    }
    return { success: false, message: msg }
  }
}

// JWT 解码 / 额度拉取已抽到 src/workbuddy-billing.ts（decodeWorkbuddyClaims / fetchWorkbuddyCredits / fetchWorkbuddyPaymentType）

/**
 * 拉取额度 + 套餐类型并填充到 base。额度拉取抛错时写日志（含 uid/eid 诊断）。
 * 在所有 return 前调用，确保"今日已签"也能拿到额度。
 */
async function fillCredits(env: Env, base: CheckinResult, token: string, realm: 'cn' | 'global', uid: string, enterpriseId: string) {
  try {
    const credits = await fetchWorkbuddyCredits(token, realm, uid, enterpriseId)
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
 * QoderWork 单账号签到：GET status → 已签则跳过 → 否则 POST claim → 刷新额度。
 * dt- token 非 JWT，昵称从 OAuthTokenState.nickname 取。
 */
async function checkinQoderAccount(env: Env, provider: Provider, base: CheckinResult, token: string): Promise<CheckinResult> {
  base.realm = 'cn'
  try {
    const st = await readOauthToken(env, provider.id)
    if (st?.nickname) base.nickname = st.nickname
  } catch { /* ignore */ }

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
      await writeCheckinResult(env, provider.id, base)
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
}

/**
 * WorkBuddy 池内单账号签到 + 额度刷新 + 解冻。
 * 账号 credentials 来自池（oauth:pool:<id>），token 临近过期先刷新（写回池）。
 */
async function checkinOauthPoolAccount(
  env: Env,
  provider: Provider,
  account: OAuthPoolAccount
): Promise<CheckinResult> {
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
    await fillCredits(env, base, token, 'global', uid, enterpriseId)
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
      await fillCredits(env, base, token, 'cn', uid, enterpriseId)
      await syncPoolCredits(env, provider, account, base)
      return base
    }
  }

  // 执行签到
  const res = await performCheckin(token, 'cn', env)
  base.success = res.success
  base.message = res.message
  base.reason = res.success ? 'ok' : 'fail'
  base.lastCheckinAt = now
  if (res.success) base.todayCheckedIn = true

  // 额度信息 + 解冻（签到就是为了解冻冷却账号，对齐 workbuddy-wild ReenableIfCredits）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId)
  await syncPoolCredits(env, provider, account, base)
  return base
}

/** WorkBuddy 池全账号签到，返回带 accounts 的汇总 CheckinResult（存 KV 供面板展示）。 */
async function checkinOauthPoolAccounts(env: Env, provider: Provider): Promise<CheckinResult> {
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
  for (const acc of pool) {
    try {
      const r = await checkinOauthPoolAccount(env, provider, acc)
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
        providerId: provider.id, name: provider.name, realm: 'unknown',
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

export async function checkinOneAccount(env: Env, provider: Provider): Promise<CheckinResult> {
  // WorkBuddy 多账号池：browser 登录流提供商遍历池内所有账号各自签到，返回带 accounts 的汇总结果
  if (isOAuthPoolProvider(provider)) {
    return checkinOauthPoolAccounts(env, provider)
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

  // QoderWork：dt- token 非 JWT，走独立的签到/额度协议
  if (provider.oauth?.flowType === 'qoder' || isQoderProvider(provider.id)) {
    return await checkinQoderAccount(env, provider, base, token)
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
    await fillCredits(env, base, token, 'global', uid, enterpriseId)
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
      await fillCredits(env, base, token, 'cn', uid, enterpriseId)
      await writeCheckinResult(env, provider.id, base)
      return base
    }
  }

  // 执行签到
  const res = await performCheckin(token, 'cn', env)
  base.success = res.success
  base.message = res.message
  base.reason = res.success ? 'ok' : 'fail'
  base.lastCheckinAt = now
  if (res.success) base.todayCheckedIn = true
  // 本次签到获得积分（daily-checkin 返回 data.credit）
  if (res.success && res.reward && typeof (res.reward as any).credit === 'number') {
    base.checkinCredit = (res.reward as any).credit
  }

  // 签到后刷新一次状态拿最新积分
  const status2 = await fetchCheckinStatus(token, 'cn')
  if (status2) {
    base.todayCheckedIn = status2.todayCheckedIn
    base.streakDays = status2.streakDays
    base.totalCredits = status2.totalCredits
    base.dailyCredit = status2.dailyCredit
  }

  // 额度信息（可用/已用/额度池/包数 + 套餐类型）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId)

  await writeCheckinResult(env, provider.id, base)
  return base
}

// ===== 全量签到 =====

// 签到仅支持 WorkBuddy（CN）和 QoderWork 账号。M365 Copilot 等不含签到功能，
// 通过 `p.oauth.flowType !== 'm365-pkce' && p.oauth.flowType !== 'm365-ropc'` 排除。

export async function runAllCheckins(env: Env, silent = false): Promise<{
  total: number
  success: number
  already: number
  fail: number
  skipped: number
  results: CheckinResult[]
}> {
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth && p.oauth.flowType !== 'm365-pkce' && p.oauth.flowType !== 'm365-ropc')

  const results: CheckinResult[] = []
  // 简单串行（账号数量通常很少，且避免并发刷新 token 冲突）
  for (const p of oauthProviders) {
    try {
      const r = await checkinOneAccount(env, p)
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
    const result = await checkinOneAccount(c.env, p)
    if (!body.silent) {
      try { await writeLog(c.env, 'info', `[checkin] ${p.name} → ${result.reason}（手动）`, JSON.stringify(result)) } catch { /* ignore */ }
    }
    return c.json<ApiResponse<CheckinResult>>({ success: true, data: result })
  }

  const summary = await runAllCheckins(c.env, !!body.silent)
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

  // WorkBuddy / QoderWork：oauth-device 家族
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth && p.oauth.flowType !== 'm365-pkce' && p.oauth.flowType !== 'm365-ropc' && !isTraeProvider(p))

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
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth && p.oauth.flowType !== 'm365-pkce' && p.oauth.flowType !== 'm365-ropc' && !isTraeProvider(p))
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
