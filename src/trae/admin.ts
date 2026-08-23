/**
 * admin.ts — TRAE SOLO 管理处理器（移植自 traework2api login.sh + scheduler.go + handler.go models/status）。
 *
 * 包含：
 *  1. 登录闭环：生成登录链接（machine_id/device_id/trace_id）→ 用户浏览器登录 →
 *     粘贴回调链接 → 解析 refreshToken → ExchangeToken → GetUserInfo → 凭证落盘。
 *  2. 签到：每日 checkin_credits status/claim + 积分刷新 + 冷却账号自动解冻。
 *  3. Token 预刷新：ExchangeToken 轮换（cron 每 2 小时），session 失效自动禁用。
 *  4. 模型发现：get_detail_param 动态拉取（KV 缓存 1h / 失败负缓存 5min），回退静态表。
 *  5. 账号状态：池状态 + 签到结果（脱敏，供面板展示）。
 */
import { Context } from 'hono'
import type { ApiResponse, AppEnv, Env, Provider } from '../types'
import { getProvider, getProviders, updateProvider } from '../storage'
import { KV_KEYS } from '../config'
import { TRAE_CONSTANTS, TRAE_STATIC_MODEL_IDS, TRAE_STATIC_MODELS } from './constants'
import {
  exchangeToken,
  fetchCheckinStatus,
  fetchTraeModels,
  fetchUserEntUsage,
  getUserInfo,
  needsTraeRefresh,
  performCheckinClaim,
} from './upstream'
import {
  disableTraeAccount,
  getTraeAccounts,
  listTraeStatus,
  pickTraeAccount,
  reenableTraeIfCredits,
  removeTraeAccount,
  saveTraeAccount,
  setTraeCredits,
} from './pool'
import { isTraeProvider } from './proxy'
import type { TraeAccount, TraeCheckinResult, TraeLoginState, TraeModelInfo, TraeAccountStatus } from './types'
import { writeLog } from '../admin'

// ===== 工具 =====

/** 生成 n 字节 hex 字符串（机器/登录 trace id）。 */
function randomHex(n: number): string {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  let s = ''
  for (let i = 0; i < n; i++) s += buf[i].toString(16).padStart(2, '0')
  return s
}

/** 生成 15 位数字 device_id（TraeWork 签到/积分接口要求，服务端绑定账号；随机 hex 会被以 9074 拒绝）。 */
function randomDeviceId(): string {
  const b = new Uint8Array(15)
  crypto.getRandomValues(b)
  let s = String((b[0] % 9) + 1) // 首位 1-9，避免前导 0
  for (let i = 1; i < 15; i++) s += String(b[i] % 10)
  return s
}

/** 解回调里 URL 编码的 JSON 参数（parse_qs 已解一层，再容错解一层 decodeURIComponent）。 */
function parseJsonParam(raw: string): Record<string, any> | null {
  if (!raw) return null
  for (const val of [raw, decodeURIComponent(raw)]) {
    try {
      const obj = JSON.parse(val)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    } catch { /* continue */ }
  }
  return null
}

// ===== 登录闭环 =====

const loginKey = (providerId: string) => `${KV_KEYS.TRAE_LOGIN_PREFIX}${providerId}`
const LOGIN_TTL_SEC = 10 * 60

/** POST /admin/api/trae/:id/login/connect：生成登录链接 + 保存中间状态。 */
export async function handleTraeLoginConnect(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isTraeProvider(provider)) return c.json<ApiResponse>({ success: false, message: '不是 TRAE 提供商' }, 400)

  const machineId = randomHex(16)
  const deviceId = randomDeviceId()
  const loginTraceId = randomHex(8)
  const state: TraeLoginState = { machineId, deviceId, loginTraceId, createdAt: Date.now() }
  try {
    await c.env.KV.put(loginKey(id), JSON.stringify(state), { expirationTtl: LOGIN_TTL_SEC })
  } catch (e) {
    console.warn(`[trae-login] state save failed: ${(e as Error).message}`)
  }

  const params: Record<string, string> = {
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: TRAE_CONSTANTS.ClientID,
    redirect: '0',
    login_trace_id: loginTraceId,
    auth_callback_url: 'http://127.0.0.1:18080/authorize',
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: TRAE_CONSTANTS.DeviceBrand,
    x_device_type: 'windows',
    x_os_version: TRAE_CONSTANTS.OSVersion,
    x_app_version: TRAE_CONSTANTS.IdeVersion,
    x_app_type: 'stable',
  }
  const loginUrl = TRAE_CONSTANTS.ConsoleHost + '/authorization?' + new URLSearchParams(params).toString()
  return c.json<ApiResponse>({
    success: true,
    data: { loginUrl, machineId, deviceId, traceId: loginTraceId },
  })
}

/** POST /admin/api/trae/:id/login/callback：解析回调链接 → 换 token → 落盘。 */
export async function handleTraeLoginCallback(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  let body: { callbackUrl?: string } = {}
  try { body = await c.req.json() } catch { /* 空 body */ }
  const callbackUrl = (body.callbackUrl || '').trim()
  if (!callbackUrl) return c.json<ApiResponse>({ success: false, message: '缺少 callbackUrl' }, 400)

  let qs: URLSearchParams
  try {
    qs = new URL(callbackUrl).searchParams
  } catch {
    return c.json<ApiResponse>({ success: false, message: '回调链接不是合法 URL，请复制浏览器地址栏完整链接' }, 400)
  }

  const refreshToken = (qs.get('refreshToken') || '').trim()
  const userInfo = parseJsonParam(qs.get('userInfo') || '') || {}
  const userJwt = parseJsonParam(qs.get('userJwt') || '') || {}
  const jwtToken = String(userJwt['Token'] || '')
  const jwtRefresh = String(userJwt['RefreshToken'] || '')
  const rt = refreshToken || jwtRefresh

  // 读登录中间状态（可能过期/丢失 → 重新生成 id 对）
  let state: TraeLoginState | null = null
  try {
    const raw = await c.env.KV.get(loginKey(id))
    if (raw) state = JSON.parse(raw) as TraeLoginState
  } catch { /* ignore */ }
  const machineId = state?.machineId || randomHex(16)
  const deviceId = state?.deviceId || randomDeviceId()

  let uid = String(userInfo['UserID'] || '')
  let nickname = String(userInfo['ScreenName'] || '')
  let enterpriseId = String(userInfo['TenantID'] || '')

  let account: TraeAccount
  try {
    if (rt) {
      // a. ExchangeToken（access token + refreshToken 轮换）
      const tokenResult = await exchangeToken({
        accessToken: '',
        refreshToken: rt,
        expiresAt: 0,
        uid: '',
        apiHost: TRAE_CONSTANTS.OAuthHost,
        machineId,
        deviceId,
      } as TraeAccount)
      account = {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresAt: tokenResult.expiresAt,
        uid: '',
        apiHost: TRAE_CONSTANTS.OAuthHost,
        domain: 'trae.cn',
        machineId,
        deviceId,
      }
    } else {
      // b. 兜底：无 refreshToken 时直接用 userJwt 的 Token
      if (!jwtToken) {
        return c.json<ApiResponse>({ success: false, message: '回调链接缺少 refreshToken，且 userJwt 也没有 Token' }, 400)
      }
      const exp = Number(userJwt['TokenExpireAt']) || 0
      account = {
        accessToken: jwtToken,
        refreshToken: '',
        expiresAt: exp > 1e12 ? Math.floor(exp / 1000) : exp,
        uid: '',
        apiHost: TRAE_CONSTANTS.OAuthHost,
        domain: 'trae.cn',
        machineId,
        deviceId,
      }
    }

    // c. GetUserInfo 确认（拿 uid/EnterpriseID；失败不阻塞，回退回调 userInfo）
    try {
      const ui = await getUserInfo(account)
      uid = ui.uid || uid
      nickname = ui.nickname || nickname
      enterpriseId = ui.enterpriseId || enterpriseId
    } catch (e) {
      console.warn(`[trae-login] GetUserInfo failed (fallback to callback userInfo): ${(e as Error).message}`)
    }
    if (!uid) {
      return c.json<ApiResponse>({ success: false, message: '未能获取 uid，请检查 token 是否有效' }, 400)
    }
    account.uid = uid
    if (nickname) account.nickname = nickname
    if (enterpriseId) account.enterpriseId = enterpriseId

    // d. 凭证落盘（provider.apiKeys）
    await saveTraeAccount(c.env, id, account)
  } catch (e) {
    return c.json<ApiResponse>({ success: false, message: '换 token 失败: ' + ((e as Error).message || String(e)).substring(0, 300) }, 502)
  }

  // e. 初始积分（失败不阻塞登录）
  let credits = 0
  try {
    credits = await fetchUserEntUsage(account, c.env)
    await setTraeCredits(c.env, id, uid, credits)
  } catch (e) {
    console.warn(`[trae-login] ent usage failed: ${(e as Error).message}`)
  }
  try { await c.env.KV.delete(loginKey(id)) } catch { /* ignore */ }
  try {
    await writeLog(c.env, 'info', `[trae] 登录成功 uid=${uid}（${nickname || '无昵称'}）`, `provider=${id} credits=${credits}`)
  } catch { /* ignore */ }

  return c.json<ApiResponse>({
    success: true,
    data: { uid, nickname, credits, expiresAt: account.expiresAt, domain: 'trae.cn' },
  })
}

// ===== 签到 =====

const checkinKey = (providerId: string) => `${KV_KEYS.TRAE_CHECKIN_PREFIX}${providerId}`
const CHECKIN_TTL_SEC = 2 * 24 * 60 * 60

async function readCheckinResults(env: Env, providerId: string): Promise<TraeCheckinResult[]> {
  try {
    const raw = await env.KV.get(checkinKey(providerId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as TraeCheckinResult[]) : []
  } catch {
    return []
  }
}

/** 单个账号签到 + 积分刷新 + 解冻（对齐 scheduler.RunCheckinNow）。 */
async function checkinTraeAccount(env: Env, provider: Provider, account: TraeAccount): Promise<TraeCheckinResult> {
  const base: TraeCheckinResult = {
    uid: account.uid,
    nickname: account.nickname,
    success: false,
    message: '',
    checkedIn: false,
    updatedAt: Date.now(),
  }
  try {
    const st = await fetchCheckinStatus(account)
    if (st.checkedIn) {
      base.success = true
      base.checkedIn = true
      base.message = '今日已签到'
    } else if (st.enable) {
      try {
        await performCheckinClaim(account)
        // 后置校验：claim 业务码不为 0 也可能幂等成功（如 9095 今日已签），以 status 实测为准
        const st2 = await fetchCheckinStatus(account)
        if (st2.checkedIn) {
          base.success = true
          base.checkedIn = true
          base.message = '签到成功'
        } else {
          base.message = '签到校验失败: claim 后 checked_in 仍为 false（请稍后重试）'
        }
      } catch (e) {
        const msg = (e as Error).message || String(e)
        // 业务软失败（已签到类）→ 视为成功已签
        const low = msg.toLowerCase()
        if (low.includes('already') || msg.includes('已签') || msg.includes('今日')) {
          base.success = true
          base.checkedIn = true
          base.message = '今日已签到'
        } else {
          base.message = '签到失败: ' + msg.substring(0, 200)
        }
      }
    } else {
      base.message = '签到未开启（enable=false）'
    }
  } catch (e) {
    base.message = '状态查询失败: ' + ((e as Error).message || String(e)).substring(0, 200)
  }
  // 查积分 + 解冻（签到就是为了解冻冷却账号）
  try {
    const remain = await fetchUserEntUsage(account, env)
    await reenableTraeIfCredits(env, provider.id, account.uid, remain)
    base.credits = remain
  } catch (e) {
    base.message += '；积分查询失败: ' + ((e as Error).message || String(e)).substring(0, 120)
  }
  return base
}

/** 对单个 TRAE 提供商执行全账号签到，结果写 KV。 */
async function runTraeCheckinForProvider(env: Env, provider: Provider, silent = false): Promise<TraeCheckinResult[]> {
  const accounts = getTraeAccounts(provider)
  const results: TraeCheckinResult[] = []
  for (const a of accounts) {
    try {
      const r = await checkinTraeAccount(env, provider, a)
      results.push(r)
    } catch (e) {
      results.push({
        uid: a.uid,
        nickname: a.nickname,
        success: false,
        message: (e as Error).message || String(e),
        checkedIn: false,
        updatedAt: Date.now(),
      })
    }
  }
  try {
    await env.KV.put(checkinKey(provider.id), JSON.stringify(results), { expirationTtl: CHECKIN_TTL_SEC })
  } catch { /* ignore */ }
  if (!silent) {
    try {
      await writeLog(env, 'info', `[trae] ${provider.name} 签到完成: ${results.length} 个账号`, JSON.stringify(results))
    } catch { /* ignore */ }
  }
  return results
}

/** POST /admin/api/trae/:id/checkin：手动触发单个 TRAE 提供商签到。 */
export async function handleTraeCheckin(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isTraeProvider(provider)) return c.json<ApiResponse>({ success: false, message: '不是 TRAE 提供商' }, 400)
  const results = await runTraeCheckinForProvider(c.env, provider)
  return c.json<ApiResponse<TraeCheckinResult[]>>({ success: true, data: results })
}

/** 全量签到（cron「0 1,13 * * *」与 /api/manage/trae/checkin 用）。 */
export async function runTraeCheckins(env: Env, silent = false): Promise<{ total: number; ok: number; already: number; fail: number }> {
  const providers = (await getProviders(env)).filter((p) => isTraeProvider(p))
  const summary = { total: 0, ok: 0, already: 0, fail: 0 }
  for (const p of providers) {
    const results = await runTraeCheckinForProvider(env, p, silent)
    summary.total += results.length
    for (const r of results) {
      if (r.message === '签到成功') summary.ok++
      else if (r.checkedIn) summary.already++
      else summary.fail++
    }
  }
  return summary
}

/** Token 预刷新（cron 刷新分支用）：临近过期的账号 ExchangeToken 轮换，session 失效禁用。 */
export async function refreshTraeTokens(env: Env): Promise<{ ok: number; fail: number }> {
  const providers = (await getProviders(env)).filter((p) => isTraeProvider(p))
  let ok = 0
  let fail = 0
  for (const p of providers) {
    for (const a of getTraeAccounts(p)) {
      if (!a.refreshToken || !needsTraeRefresh(a)) continue
      try {
        const res = await exchangeToken(a)
        a.accessToken = res.accessToken
        a.refreshToken = res.refreshToken
        a.expiresAt = res.expiresAt
        await saveTraeAccount(env, p.id, a)
        ok++
      } catch (e) {
        fail++
        if ((e as any).kind === 'session_dead') {
          await disableTraeAccount(env, p.id, a.uid, 'refresh session dead')
        }
      }
    }
  }
  return { ok, fail }
}

// ===== 模型发现 =====

const modelsKey = (providerId: string) => `${KV_KEYS.TRAE_MODELS_PREFIX}${providerId}`
const MODELS_TTL_MS = 60 * 60 * 1000 // 成功缓存 1h
const MODELS_FAIL_COOLDOWN_MS = 5 * 60 * 1000 // 失败负缓存 5min

/** 动态拉取模型（get_detail_param），带 KV 缓存；失败/无账号回退静态表。 */
async function fetchTraeModelsCached(env: Env, provider: Provider): Promise<{ entries: Array<Record<string, any>>; from: 'dynamic' | 'static' }> {
  const now = Date.now()
  try {
    const raw = await env.KV.get(modelsKey(provider.id))
    if (raw) {
      const cache = JSON.parse(raw) as { fetchedAt?: number; failAt?: number; models?: TraeModelInfo[] }
      if (Array.isArray(cache.models) && cache.models.length > 0 && cache.fetchedAt && now - cache.fetchedAt < MODELS_TTL_MS) {
        return { entries: toOpenAIModelEntries(cache.models), from: 'dynamic' }
      }
      if (cache.failAt && now - cache.failAt < MODELS_FAIL_COOLDOWN_MS) {
        return { entries: TRAE_STATIC_MODELS as unknown as Array<Record<string, any>>, from: 'static' }
      }
    }
  } catch { /* cache 损坏当作无缓存 */ }

  const accounts = getTraeAccounts(provider)
  const account = accounts.length > 0 ? await pickTraeAccount(env, provider.id, accounts, new Set()) : null
  if (account) {
    try {
      const infos = await fetchTraeModels(account)
      if (infos.length > 0) {
        try {
          await env.KV.put(modelsKey(provider.id), JSON.stringify({ models: infos, fetchedAt: now }))
        } catch { /* ignore */ }
        return { entries: toOpenAIModelEntries(infos), from: 'dynamic' }
      }
    } catch { /* fall through to static */ }
  }
  try {
    await env.KV.put(modelsKey(provider.id), JSON.stringify({ failAt: now }))
  } catch { /* ignore */ }
  return { entries: TRAE_STATIC_MODELS as unknown as Array<Record<string, any>>, from: 'static' }
}

/** TraeModelInfo[] → OpenAI /models 条目。 */
function toOpenAIModelEntries(infos: TraeModelInfo[]): Array<Record<string, any>> {
  return infos.map((mi) => ({
    id: mi.id,
    object: 'model',
    created: 1753600000,
    owned_by: 'trae-solo',
    context_length: mi.contextWindow > 0 ? mi.contextWindow : 131072,
  }))
}

/** POST /admin/api/trae/:id/models：拉取模型并自动合并保存到 provider.models。 */
export async function handleTraeModels(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isTraeProvider(provider)) return c.json<ApiResponse>({ success: false, message: '不是 TRAE 提供商' }, 400)
  const { entries, from } = await fetchTraeModelsCached(c.env, provider)
  // 自动合并（按 id 去重追加，保留已有 enabled 状态）
  try {
    const existing = provider.models || []
    const existingIds = new Set(existing.map((m) => m.id))
    const merged = [...existing]
    for (const e of entries) {
      const mid = String(e['id'])
      if (!existingIds.has(mid)) {
        merged.push({ id: mid, enabled: true })
        existingIds.add(mid)
      }
    }
    if (merged.length !== existing.length) {
      await updateProvider(c.env, id, { models: merged })
    }
  } catch (e) {
    console.warn(`[trae-models] auto-save failed: ${(e as Error).message}`)
  }
  return c.json<ApiResponse>({
    success: true,
    data: { data: entries, from },
  })
}

// ===== 状态 =====

/** GET /admin/api/trae/:id/status：账号池状态 + 签到结果（脱敏）。 */
export async function handleTraeStatus(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const accounts: TraeAccountStatus[] = await listTraeStatus(c.env, provider)
  const checkin = await readCheckinResults(c.env, id)
  return c.json<ApiResponse>({
    success: true,
    data: { accounts, checkin, accountCount: getTraeAccounts(provider).length, preferTraeUid: provider.preferTraeUid || '' },
  })
}

/** POST /admin/api/trae/:id/account/prefer：设置首选账号（面板下拉框指定，留空则恢复自动挑选）。 */
export async function handleTraeSetPrefer(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  let body: { uid?: string } = {}
  try { body = await c.req.json() } catch { /* 空 body */ }
  const uid = (body.uid || '').trim()
  // 校验 uid 必须是已配置账号，防止乱填
  const uids = getTraeAccounts(provider).map(a => a.uid)
  if (uid && !uids.includes(uid)) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 400)
  await updateProvider(c.env, id, { preferTraeUid: uid || undefined })
  return c.json<ApiResponse>({ success: true, message: uid ? '已指定首选账号 ' + uid : '已恢复自动挑选' })
}

/** POST /admin/api/trae/:id/account/remove：删除指定 uid 账号。 */
export async function handleTraeAccountRemove(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  let body: { uid?: string } = {}
  try { body = await c.req.json() } catch { /* 空 body */ }
  const uid = (body.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid' }, 400)
  const removed = await removeTraeAccount(c.env, id, uid)
  if (!removed) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: '已删除账号 ' + uid })
}

/** 静态模型 id 表（面板预设下拉用，避免 UI 硬编码）。 */
export const TRAE_UI_MODEL_IDS = TRAE_STATIC_MODEL_IDS
