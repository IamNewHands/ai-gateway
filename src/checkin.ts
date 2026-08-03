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
import { KV_KEYS, CHECKIN_RESULT_TTL_SEC } from './config'
import { getProviders } from './storage'
import { getOauthAccessToken, detectTokenRealm } from './oauth'
import { writeLog } from './admin'

const CHECKIN_BASE_CN = 'https://www.codebuddy.cn'

/** CPA billing 信封 */
interface BillingEnvelope {
  code: number
  msg: string
  data?: any
}

/** 兼容下划线 / 驼峰两种字段命名（参考 CPA jsonBool/jsonI64） */
function pickField(obj: Record<string, any>, ...keys: string[]): any {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}
function pickBool(obj: Record<string, any>, ...keys: string[]): boolean {
  const v = pickField(obj, ...keys)
  return v === true || v === 'true' || v === 1 || v === '1'
}
function pickNum(obj: Record<string, any>, ...keys: string[]): number | undefined {
  const v = pickField(obj, ...keys)
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 发起一次 billing 请求。POST {}，带 Bearer + X-Domain。
 * code!==0 抛业务错误（含 msg）；5xx/网络错误抛 Error。
 */
async function billingCall(
  token: string,
  path: string,
  realm: 'cn' | 'global'
): Promise<any> {
  const base = realm === 'global' ? 'https://www.workbuddy.ai' : CHECKIN_BASE_CN
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Domain': realm === 'global' ? 'workbuddy.ai' : 'codebuddy.cn',
    },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`http ${res.status} ${path}: ${text.substring(0, 200)}`)
  }
  let env: BillingEnvelope
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`parse failed ${path}: ${text.substring(0, 200)}`)
  }
  if (env.code !== 0) {
    throw new Error(`code=${env.code} msg=${env.msg || ''}`)
  }
  return env.data
}

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
  realm: 'cn' | 'global'
): Promise<{ success: boolean; message: string }> {
  try {
    await billingCall(token, '/v2/billing/meter/daily-checkin', realm)
    return { success: true, message: '签到成功' }
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

// ===== KV 结果读写 =====

const resultKey = (providerId: string) => KV_KEYS.CHECKIN_RESULT_PREFIX + providerId

export async function readCheckinResult(env: Env, providerId: string): Promise<CheckinResult | null> {
  const raw = await env.KV.get(resultKey(providerId))
  return raw ? (JSON.parse(raw) as CheckinResult) : null
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

export async function checkinOneAccount(env: Env, provider: Provider): Promise<CheckinResult> {
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

  const realm = detectTokenRealm(token)
  if (realm === 'global') {
    base.realm = 'global'
    base.reason = 'skipped_global'
    base.message = '国际版账号无签到功能'
    base.success = true
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
      await writeCheckinResult(env, provider.id, base)
      return base
    }
  }

  // 执行签到
  const res = await performCheckin(token, 'cn')
  base.success = res.success
  base.message = res.message
  base.reason = res.success ? 'ok' : 'fail'
  base.lastCheckinAt = now
  if (res.success) base.todayCheckedIn = true

  // 签到后刷新一次状态拿最新积分
  const status2 = await fetchCheckinStatus(token, 'cn')
  if (status2) {
    base.todayCheckedIn = status2.todayCheckedIn
    base.streakDays = status2.streakDays
    base.totalCredits = status2.totalCredits
    base.dailyCredit = status2.dailyCredit
  }

  await writeCheckinResult(env, provider.id, base)
  return base
}

// ===== 全量签到 =====

export async function runAllCheckins(env: Env): Promise<{
  total: number
  success: number
  already: number
  fail: number
  skipped: number
  results: CheckinResult[]
}> {
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth)

  const results: CheckinResult[] = []
  // 简单串行（账号数量通常很少，且避免并发刷新 token 冲突）
  for (const p of oauthProviders) {
    try {
      const r = await checkinOneAccount(env, p)
      results.push(r)
      // 写日志
      try {
        await writeLog(env, 'info', `[checkin] ${p.name} → ${r.reason}`, JSON.stringify(r))
      } catch { /* ignore */ }
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
  let body: { id?: string } = {}
  try { body = await c.req.json() } catch { /* 空 body，全量 */ }
  const id = body.id?.trim()

  if (id) {
    const providers = (await getProviders(c.env)) as Provider[]
    const p = providers.find((x) => x.id === id)
    if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
    const result = await checkinOneAccount(c.env, p)
    try { await writeLog(c.env, 'info', `[checkin] ${p.name} → ${result.reason}（手动）`, JSON.stringify(result)) } catch { /* ignore */ }
    return c.json<ApiResponse<CheckinResult>>({ success: true, data: result })
  }

  const summary = await runAllCheckins(c.env)
  return c.json<ApiResponse>({ success: true, data: summary })
}

/** GET /admin/api/checkin/status：返回所有 provider 的签到结果（面板展示）。 */
export async function handleCheckinStatus(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)) as Provider[]
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth)

  const list: CheckinResult[] = []
  for (const p of oauthProviders) {
    const r = await readCheckinResult(c.env, p.id)
    if (r) {
      list.push(r)
    } else {
      // 无结果占位，让面板知道有此 WorkBuddy 账号但未签到
      list.push({
        providerId: p.id, name: p.name, realm: 'unknown',
        success: false, reason: 'skipped_no_token', message: '尚未签到',
        todayCheckedIn: false, updatedAt: 0,
      })
    }
  }
  return c.json<ApiResponse<CheckinResult[]>>({ success: true, data: list })
}
