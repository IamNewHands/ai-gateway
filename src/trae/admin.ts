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
import { contextWindowListing, maxOutputTokensListing } from '../model-context-catalog'
import {
  exchangeToken,
  fetchCheckinStatus,
  fetchTraeModels,
  fetchUserEntUsage,
  fetchUserEntUsageDetails,
  getUserInfo,
  inspectTraeAuthKeys,
  isAlreadyTraeCheckin,
  needsTraeRefresh,
  performCheckinClaim,
  probeTraeCredits,
  TRAE_REMOTE_REQUIRED_FIELD_NAMES,
} from './upstream'
import {
  disableTraeAccount,
  getTraeAccounts,
  listTraeStatus,
  pickTraeAccount,
  readTraePool,
  reenableTraeIfCredits,
  removeTraeAccount,
  setTraeAccountEnabled,
  saveTraeAccount,
  setTraeCredits,
  setTraePacks,
  setTraeWorkCredits,
} from './pool'
import { isTraeProvider } from './proxy'
import type { TraeAccount, TraeCheckinResult, TraeLoginState, TraeModelInfo, TraeAccountStatus, TraeEntPackInfo } from './types'
import { writeLog } from '../admin'
import { MAX_ADMIN_REQUEST_BYTES, readOptionalJSONLimited } from '../request-body'

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

  // 有界读取：readOptionalJSONLimited 已内含"空/非法 body → {}"容错（等价于原 try/catch），
  // 但超限仍抛 REQUEST_TOO_LARGE 交给全局 onError → 413，不被这里吞掉。
  const body = await readOptionalJSONLimited<{ callbackUrl?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
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
      console.warn(`[trae-login] GetUserInfo failed (fallback to callback userInfo): ${(e as Error).message}`) // codeql-disable: 错误消息诊断日志
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
  let workCredits = 0
  try {
    const details = await fetchUserEntUsageDetails(account)
    credits = details.ideCredits
    workCredits = details.workCredits
    const probe = await probeTraeCredits(account)
    if (probe && typeof probe.workCredits === 'number' && probe.workCredits > 0) {
      workCredits = probe.workCredits
    }
    await setTraeCredits(c.env, id, uid, credits)
    await setTraeWorkCredits(c.env, id, uid, workCredits)
    await setTraePacks(c.env, id, uid, details.packs)
  } catch (e) {
    console.warn(`[trae-login] ent usage failed: ${(e as Error).message}`)
  }
  try { await c.env.KV.delete(loginKey(id)) } catch { /* ignore */ }
  try {
    await writeLog(c.env, 'info', `[trae] 登录成功 uid=${uid}（${nickname || '无昵称'}）`, `provider=${id} ideCredits=${credits} workCredits=${workCredits}`)
  } catch { /* ignore */ }

  return c.json<ApiResponse>({
    success: true,
    data: { uid, nickname, credits, workCredits, expiresAt: account.expiresAt, domain: 'trae.cn' },
  })
}

// ===== 签到 =====

const checkinKey = (providerId: string) => `${KV_KEYS.TRAE_CHECKIN_PREFIX}${providerId}`
const CHECKIN_TTL_SEC = 2 * 24 * 60 * 60

/** 读取 TRAE 账号级签到结果（KV）。概览 KPI 与面板「今日签到」列同源。 */
export async function readTraeCheckinResults(env: Env, providerId: string): Promise<TraeCheckinResult[]> {
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
export async function checkinTraeAccount(env: Env, provider: Provider, account: TraeAccount): Promise<TraeCheckinResult> {
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
        const claimRes = await performCheckinClaim(account)
        // 后置校验：claim 业务码不为 0 也可能幂等成功（如 9095 今日已签），以 status 实测为准
        const st2 = await fetchCheckinStatus(account)
        if (st2.checkedIn) {
          base.success = true
          base.checkedIn = true
          base.message = claimRes?.already ? '今日已签到' : '签到成功'
        } else {
          base.message = '签到校验失败: claim 后 checked_in 仍为 false（请稍后重试）'
        }
      } catch (e) {
        const msg = (e as Error).message || String(e)
        // 软失败候选：只有错误文本明确包含签到幂等业务特征时，才尝试后置 status 复核（绝不单凭裸错误报成功）
        if (isAlreadyTraeCheckin(e)) {
          try {
            const st2 = await fetchCheckinStatus(account)
            if (st2.checkedIn) {
              base.success = true
              base.checkedIn = true
              base.message = '今日已签到'
            } else {
              base.message = '签到失败: ' + msg.substring(0, 200)
            }
          } catch {
            base.message = '签到失败: ' + msg.substring(0, 200)
          }
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
    const details = await fetchUserEntUsageDetails(account)
    const ideRemain = details.ideCredits
    let workRemain = details.workCredits
    // 签到不额外发送对话 ping，完全免扣费；若账号池已有 workCredits 记录且大于 0 则保持
    const pool = await readTraePool(env, provider.id)
    const prevWorkCredits = pool[account.uid]?.workCredits
    if (typeof prevWorkCredits === 'number' && prevWorkCredits > 0 && workRemain === 0) {
      workRemain = prevWorkCredits
    }
    await reenableTraeIfCredits(env, provider.id, account.uid, ideRemain, workRemain, true)
    base.credits = ideRemain
    base.workCredits = workRemain
    await setTraePacks(env, provider.id, account.uid, details.packs)
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

/** 全量签到（cron「5 2,14 * * *」与 /api/manage/trae/checkin 用）。 */
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
      // 上游这次给了空目录：**不是失败**，不写负缓存，下次请求立刻重试。
      // 写负缓存会把一次空响应放大成 MODELS_FAIL_COOLDOWN_MS 内所有请求都退回静态表
      // （对齐 Trae2api-cn `get_models`：Not cached, so the next request retries the upstream list）。
      return { entries: TRAE_STATIC_MODELS as unknown as Array<Record<string, any>>, from: 'static' }
    } catch { /* 真失败（网络/解析/非 200）→ 落到下面的负缓存 */ }
  }
  try {
    await env.KV.put(modelsKey(provider.id), JSON.stringify({ failAt: now }))
  } catch { /* ignore */ }
  return { entries: TRAE_STATIC_MODELS as unknown as Array<Record<string, any>>, from: 'static' }
}

/**
 * TraeModelInfo[] → OpenAI /models 条目。
 * context_length / max_output_tokens 三级查找（../model-context-catalog，上游
 * workbuddy2api 32a3c13 同口径）：远端实测值（max_input_tokens/max_output_tokens）
 * 权威 → 知识表 → context_length 1M 兜底 / max_output_tokens 省略。
 * 上游零值不再透出假 131072（会误导 Codex/ZCode 等按 context_length 提前截断丢上下文）。
 */
export function toOpenAIModelEntries(infos: TraeModelInfo[]): Array<Record<string, any>> {
  return infos.map((mi) => {
    const entry: Record<string, any> = {
      id: mi.id,
      object: 'model',
      created: 1753600000,
      owned_by: 'trae-solo',
      context_length: contextWindowListing(mi.id, mi.contextWindow),
    }
    const maxOut = maxOutputTokensListing(mi.id, mi.maxTokens)
    if (maxOut !== null) entry.max_output_tokens = maxOut
    return entry
  })
}

/** POST /admin/api/trae/:id/models：拉取模型清单（仅返回，不自动入库）。 */
export async function handleTraeModels(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isTraeProvider(provider)) return c.json<ApiResponse>({ success: false, message: '不是 TRAE 提供商' }, 400)
  const { entries, from } = await fetchTraeModelsCached(c.env, provider)
  // 仅返回模型清单（含来源 dynamic/static），由用户在面板手工「+」选择并点保存才正式入库；
  // 拉取本身不写 provider.models，避免未保存就随刷新自动全部写入。
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
  const checkin = await readTraeCheckinResults(c.env, id)
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
  const body = await readOptionalJSONLimited<{ uid?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
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
  const body = await readOptionalJSONLimited<{ uid?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const uid = (body.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid' }, 400)
  const removed = await removeTraeAccount(c.env, id, uid)
  if (!removed) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: '已删除账号 ' + uid })
}

/**
 * POST /admin/api/trae/:id/account/toggle：人工启用/禁用单个 TRAE 账号。
 *
 * 禁用写 provider.apiKeys 行的 enabled=false（getTraeAccounts 立刻跳过 → 不再挑号、不再签到），
 * 但保留凭证行，因此是可逆暂停、不是删除；「启用」顺带清自动禁用与两通道冷却（见
 * setTraeAccountEnabled）。这也是唯一能让「上游判死的号」重新参与挑号的人工入口——
 * 除了它只有「重新登录」一条路。
 */
export async function handleTraeAccountToggle(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const body = await readOptionalJSONLimited<{ uid?: string; enabled?: boolean }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const uid = (body.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid' }, 400)
  // 同 WorkBuddy/Qoder 端点：enabled 必须显式给，缺失不允许被当成「启用」
  if (typeof body.enabled !== 'boolean') {
    return c.json<ApiResponse>({ success: false, message: '缺少 enabled 参数（true=启用 / false=禁用）' }, 400)
  }
  const ok = await setTraeAccountEnabled(c.env, id, uid, body.enabled)
  if (!ok) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: (body.enabled ? '已启用 ' : '已禁用 ') + uid })
}

/** POST /admin/api/trae/:id/credits/refresh：主动探测并刷新所有账号的双通道积分（通用与 Work 积分）。 */
export async function handleTraeCreditsRefresh(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const accounts = getTraeAccounts(provider)
  const results: Array<{
    uid: string
    ideRemain?: number
    workRemain?: number
    entPacks?: TraeEntPackInfo[]
    workProbe?: { host?: string; status?: number; info?: string; workCredits?: number } | null
    success: boolean
    error?: string
  }> = []
  for (const a of accounts) {
    try {
      const details = await fetchUserEntUsageDetails(a)
      let ideRemain = details.ideCredits
      let workRemain = details.workCredits

      let workProbe: { host?: string; status?: number; info?: string; workCredits?: number } | null = null
      const probe = await probeTraeCredits(a)
      if (probe) {
        workProbe = {
          host: probe.host,
          status: probe.status,
          info: probe.info,
          workCredits: probe.workCredits,
        }
        if (typeof probe.workCredits === 'number' && probe.workCredits > 0) {
          workRemain = probe.workCredits
        }
        if (typeof probe.ideCredits === 'number' && probe.ideCredits > 0) {
          ideRemain = probe.ideCredits
        }
      }

      // 面板批量刷新：只读额度，不解冻（unfreeze=false）——把限流冷却中的号放出来等于绕过限流保护
      await reenableTraeIfCredits(c.env, id, a.uid, ideRemain, workRemain, false)
      // 权益包明细（含到期时间）落盘，面板「积分明细」折叠表据此展示
      await setTraePacks(c.env, id, a.uid, details.packs)
      results.push({
        uid: a.uid,
        ideRemain,
        workRemain,
        entPacks: details.packs,
        workProbe,
        success: true,
      })
    } catch (e) {
      results.push({ uid: a.uid, success: false, error: (e as Error).message })
    }
  }
  try {
    await writeLog(c.env, 'info', `[trae] ${provider.name} 积分刷新完成: ${results.length} 个账号`, JSON.stringify(results))
  } catch { /* ignore */ }
  return c.json<ApiResponse>({
    success: true,
    message: `已刷新 ${results.length} 个账号的通用与 Work 积分`,
    data: results,
  })
}

/**
 * GET /admin/api/trae/:id/auth-keys：诊断每行凭据里有没有 Remote 传输会读取的字段。
 *
 * ⚠️ **这三个字段不是 Remote 的前置条件**（2026-10-09 实测：本机 storage.json 里
 * `webId`/`bizUserId`/`userUniqueId` 全缺，纯 OAuth token 直打 `/api/remote/v1`
 * 仍返 200）。本端点是**可观测性**用途，不是立项门槛。
 *
 * 保留理由：源侧 `common_params` 确实会读这三个值（`web_id`/`biz_user_id`/`user_unique_id`），
 * 为空时上游按空值处理。若日后出现「Remote 行为与 web 端不一致」，第一个要看的变量就是它们。
 * 另外这三个键不在 `parseAuth` 的读取白名单里 ⇒ 凭据 JSON 里**即便有**也读不出来，
 * 面板也看不到（`handleGetProviders` 只回掩码），只能靠本端点直接读原始 JSON 键名。
 *
 * 安全约束：只回**字段名与长度**，不回任何凭据值。`key` 一律以掩码形式出现在响应里。
 */
export async function handleTraeAuthKeys(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isTraeProvider(provider)) return c.json<ApiResponse>({ success: false, message: '不是 TRAE 提供商' }, 400)

  const rows = (provider.apiKeys || []).map((k, index) => {
    const raw = (k.key || '').trim()
    const mask = raw.length > 4 ? `****${raw.slice(-4)}` : '****'
    if (!raw) {
      return { index, enabled: k.enabled, label: k.label || '', mask, empty: true, report: null }
    }
    let report: ReturnType<typeof inspectTraeAuthKeys> | null = null
    let error: string | undefined
    try {
      report = inspectTraeAuthKeys(raw)
    } catch (e) {
      error = (e as Error).message
    }
    return { index, enabled: k.enabled, label: k.label || '', mask, empty: false, report, error }
  })

  // 汇总：三个必需字段在多少行凭据里出现过（决定 Remote 是否有希望直接跑通）
  const withRequired = rows.filter((r) => r.report && r.report.requiredFields.every((f) => f.found)).length
  const withRequiredInJwt = rows.filter(
    (r) => r.report && r.report.jwtRequiredFields.length > 0 && r.report.jwtRequiredFields.every((f) => f.found)
  ).length
  const nonEmpty = rows.filter((r) => !r.empty).length

  return c.json<ApiResponse>({
    success: true,
    data: {
      rows,
      summary: {
        total: rows.length,
        nonEmpty,
        /** 凭据 JSON 里三个字段齐全的行数 */
        withRequiredFields: withRequired,
        /** JSON 里没有、但 accessToken JWT claims 里齐全的行数 */
        withRequiredInJwt,
      },
      requiredFields: TRAE_REMOTE_REQUIRED_FIELD_NAMES,
    },
  })
}

/** 静态模型 id 表（面板预设下拉用，避免 UI 硬编码）。 */
export const TRAE_UI_MODEL_IDS = TRAE_STATIC_MODEL_IDS
