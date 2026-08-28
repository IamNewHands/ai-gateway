/**
 * upstream.ts — SOLO 上游 HTTP 客户端（移植自 traework2api/internal/upstream/client.go + headers.go）。
 * llm_utils_chat / get_detail_param / ExchangeToken / checkin_credits / ide_user_ent_usage + 错误分类。
 */
import { TRAE_CHAT_CONNECT_TIMEOUT_MS, TRAE_CONSTANTS, TRAE_UA } from './constants'
import { prepareBody } from './payload'
import type { TraeAccount, TraeErrKind, TraeModelInfo } from './types'

// ===== 错误分类（SPEC §4.3） =====

const sessionDeadMarkers = ['login', 'token 失效', 'token invalid', 'session', 'unauthorized', '401']

/** 按 HTTP 状态码 + body 判定错误类别。 */
export function classifyTraeError(status: number, body: string): TraeErrKind {
  const lower = body.toLowerCase()
  // 1005 plan 权益不足
  if (body.includes('"code":1005') || (body.includes('1005') && lower.includes('plan'))) return 'plan_limit'
  if (status === 401) {
    for (const m of sessionDeadMarkers) {
      if (lower.includes(m.toLowerCase())) return 'session_dead'
    }
    return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/** ExchangeToken 的 TokenExpireAt 归一化为 Unix 秒（上游毫秒 ~1.7e12，秒 ~1.7e9）。 */
export function normalizeExpiresAt(v: number): number {
  if (v > 1e12) return Math.floor(v / 1000)
  return v
}

// ===== 请求头（headers.go） =====

export function soloHeaders(account: TraeAccount, stream: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': TRAE_UA,
    Authorization: `Cloud-IDE-JWT ${account.accessToken}`,
    'X-Cloudide-Token': account.accessToken,
    'X-Ide-Token': account.accessToken,
    'X-App-Id': TRAE_CONSTANTS.AppID,
    'X-App-Version': 'default',
    'X-Ide-Version': TRAE_CONSTANTS.IdeVersion,
    'X-Ide-Version-Code': TRAE_CONSTANTS.IdeVersionCode,
    'X-App-Version-Code': TRAE_CONSTANTS.IdeVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': TRAE_CONSTANTS.OSVersion,
    'X-Device-Brand': TRAE_CONSTANTS.DeviceBrand,
    'Request-Traffic-Type': 'prod',
  }
  if (account.uid) h['X-Uid'] = account.uid
  if (account.machineId) h['X-Machine-Id'] = account.machineId
  if (account.deviceId) h['X-Device-Id'] = account.deviceId
  return h
}

export function ugHeaders(account: TraeAccount): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': TRAE_UA,
    Authorization: `Cloud-IDE-JWT ${account.accessToken}`,
    'X-User-Region': 'CN',
  }
  // 设备指纹头（checkin_credits/* 与积分接口必需）：官方客户端 bb() 注入。
  // 缺失或与账号绑定的 device_id 不一致会被上游以 9074 拒绝。
  if (account.deviceId) h['x-device-id'] = account.deviceId
  h['x-device-brand'] = TRAE_CONSTANTS.DeviceBrand
  h['x-device-type'] = 'windows'
  h['x-os-version'] = TRAE_CONSTANTS.OSVersion
  h['x-app-version'] = TRAE_CONSTANTS.IdeVersion
  return h
}

export function oauthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': TRAE_UA,
  }
}

// ===== 凭证解析 / 序列化（auth.go + login.sh 落盘格式） =====

/** 解码 JWT payload（不验签），用于缺 uid 时兜底。 */
function decodeJwtClaims(token: string): Record<string, any> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  switch (payload.length % 4) {
    case 0: break
    case 2: payload += '=='; break
    case 3: payload += '='; break
    default: return null
  }
  try {
    return JSON.parse(atob(payload))
  } catch {
    return null
  }
}

function pickStr(obj: Record<string, any> | null | undefined, keys: string[]): string {
  if (!obj) return ''
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

/**
 * 解析账号 JSON（兼容三种形态）：
 *  ① 嵌套形 {"auth":{accessToken,...},"account":{uid,...}}（登录脚本产出的 trae-*.json，camelCase）
 *  ② 扁平形 {"accessToken":...,"uid":...}（camelCase 或 snake_case）
 *  ③ 极简形 {"token":...,"machine_id":...,"device_id":...}
 * uid/nickname 缺失时从 accessToken JWT 兜底。
 */
export function parseAuth(jsonText: string): TraeAccount {
  let obj: Record<string, any>
  try {
    obj = JSON.parse(jsonText)
  } catch {
    throw new Error('不是合法的 JSON')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON 结构不正确')

  const a: Record<string, any> = {}
  if (obj['auth'] && typeof obj['auth'] === 'object' && !Array.isArray(obj['auth'])) {
    // 嵌套形
    const auth = obj['auth']
    const account = obj['account'] && typeof obj['account'] === 'object' ? obj['account'] : {}
    a.accessToken = pickStr(auth, ['accessToken', 'access_token'])
    a.refreshToken = pickStr(auth, ['refreshToken', 'refresh_token'])
    a.expiresAt = auth['expiresAt'] ?? auth['expires_at'] ?? 0
    a.domain = pickStr(auth, ['domain'])
    a.apiHost = pickStr(auth, ['apiHost', 'api_host'])
    a.machineId = pickStr(auth, ['machineId', 'machine_id'])
    a.deviceId = pickStr(auth, ['deviceId', 'device_id'])
    a.uid = pickStr(account, ['uid', 'user_id', 'userId'])
    a.enterpriseId = pickStr(account, ['enterpriseId', 'enterprise_id'])
    a.nickname = pickStr(account, ['nickname'])
  } else {
    // 扁平形 / 极简形
    a.accessToken = pickStr(obj, ['accessToken', 'access_token', 'token'])
    a.refreshToken = pickStr(obj, ['refreshToken', 'refresh_token'])
    a.expiresAt = obj['expiresAt'] ?? obj['expires_at'] ?? 0
    a.domain = pickStr(obj, ['domain'])
    a.apiHost = pickStr(obj, ['apiHost', 'api_host'])
    a.machineId = pickStr(obj, ['machineId', 'machine_id'])
    a.deviceId = pickStr(obj, ['deviceId', 'device_id'])
    a.uid = pickStr(obj, ['uid', 'user_id', 'userId'])
    a.enterpriseId = pickStr(obj, ['enterpriseId', 'enterprise_id'])
    a.nickname = pickStr(obj, ['nickname'])
  }

  const account: TraeAccount = {
    accessToken: a.accessToken || '',
    refreshToken: a.refreshToken || '',
    expiresAt: typeof a.expiresAt === 'number' && Number.isFinite(a.expiresAt) ? a.expiresAt : 0,
    uid: a.uid || '',
  }
  if (a.apiHost) account.apiHost = a.apiHost
  if (a.domain) account.domain = a.domain
  if (a.machineId) account.machineId = a.machineId
  if (a.deviceId) account.deviceId = a.deviceId
  if (a.enterpriseId) account.enterpriseId = a.enterpriseId
  if (a.nickname) account.nickname = a.nickname

  if (!account.accessToken) throw new Error('缺少 accessToken')
  // JWT 兜底 uid/nickname/enterpriseId
  if (!account.uid || !account.nickname || !account.enterpriseId) {
    const claims = decodeJwtClaims(account.accessToken)
    if (claims) {
      if (!account.uid) account.uid = pickStr(claims, ['uid', 'user_id', 'userId', 'sub', 'UserID'])
      if (!account.nickname) account.nickname = pickStr(claims, ['nickname', 'name', 'ScreenName'])
      if (!account.enterpriseId) account.enterpriseId = pickStr(claims, ['enterprise_id', 'enterpriseId', 'tenant_id', 'EnterpriseID'])
    }
  }
  return account
}

/** 序列化为存储用的规范化 JSON（扁平形，camelCase）。 */
export function serializeAccount(a: TraeAccount): string {
  const obj: Record<string, any> = {
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: a.expiresAt,
    uid: a.uid,
  }
  if (a.nickname) obj.nickname = a.nickname
  if (a.enterpriseId) obj.enterpriseId = a.enterpriseId
  if (a.apiHost) obj.apiHost = a.apiHost
  if (a.domain) obj.domain = a.domain
  if (a.machineId) obj.machineId = a.machineId
  if (a.deviceId) obj.deviceId = a.deviceId
  return JSON.stringify(obj)
}

// ===== HTTP 辅助 =====

/** 短 JSON 请求（ExchangeToken/模型/签到/积分）；非 2xx 抛 {kind,status,msg}。 */
async function doJson(
  url: string,
  headers: Record<string, string>,
  bodyObj: Record<string, any>,
  timeoutMs = 30000
): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`request failed: ${(e as Error).message || String(e)}`)
  }
  const raw = await response.text()
  if (response.status >= 400) {
    const kind = classifyTraeError(response.status, raw)
    const err = new Error(`upstream ${kind} (http ${response.status}): ${raw.substring(0, 200)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string }
    ;(err as any).kind = kind
    ;(err as any).status = response.status
    ;(err as any).msg = raw.substring(0, 200)
    throw err
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error(`parse failed ${url}: ${raw.substring(0, 200)}`)
  }
}

/** 同 doJson 但返回原始响应文本（诊断/需要保留 JSON 原始结构时用）。 */
async function doJsonText(
  url: string,
  headers: Record<string, string>,
  bodyObj: Record<string, any>,
  timeoutMs = 30000
): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`request failed: ${(e as Error).message || String(e)}`)
  }
  const raw = await response.text()
  if (response.status >= 400) {
    const kind = classifyTraeError(response.status, raw)
    const err = new Error(`upstream ${kind} (http ${response.status}): ${raw.substring(0, 200)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string }
    ;(err as any).kind = kind
    ;(err as any).status = response.status
    ;(err as any).msg = raw.substring(0, 200)
    throw err
  }
  return raw
}

// ===== ExchangeToken / 用户信息 =====

export interface TokenExchangeResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/**
 * 通过 ExchangeToken 刷新 access token（refreshToken 轮换）。
 * 失败时抛错且不返回部分结果（旧 refreshToken 可重试）。
 */
export async function exchangeToken(account: TraeAccount): Promise<TokenExchangeResult> {
  if (!account.refreshToken || !account.refreshToken.trim()) throw new Error('no refreshToken')
  const host = account.apiHost || TRAE_CONSTANTS.OAuthHost
  const data = await doJson(
    host + TRAE_CONSTANTS.EpExchange,
    oauthHeaders(),
    {
      ClientID: TRAE_CONSTANTS.ClientID,
      RefreshToken: account.refreshToken,
      ClientSecret: '-',
      UserID: '',
    }
  )
  const result = data?.Result
  if (!result || !result.Token) throw new Error('refresh_failed: no token in response — re-login required')
  let expiresAt = 0
  if (Number(result.TokenExpireAt) > 0) {
    expiresAt = normalizeExpiresAt(Number(result.TokenExpireAt))
  } else if (Number(result.TokenExpireDuration) > 0) {
    expiresAt = Math.floor(Date.now() / 1000) + Number(result.TokenExpireDuration)
  }
  return {
    accessToken: result.Token,
    refreshToken: result.RefreshToken || account.refreshToken,
    expiresAt,
  }
}

/** 判断 token 是否将在 withinSec 内过期（或已过期/无 expiry）。 */
export function needsTraeRefresh(account: TraeAccount, withinSec = 24 * 60 * 60): boolean {
  if (account.expiresAt <= 0) return true
  return Math.floor(Date.now() / 1000) + withinSec >= account.expiresAt
}

/** 查询账号信息（登录/校验用）。失败抛错。 */
export async function getUserInfo(account: TraeAccount): Promise<{ uid: string; nickname: string; enterpriseId: string }> {
  const host = account.apiHost || TRAE_CONSTANTS.OAuthHost
  const headers = oauthHeaders()
  headers['X-Cloudide-Token'] = account.accessToken
  const data = await doJson(host + TRAE_CONSTANTS.EpUserInfo, headers, {
    ReqSource: 'IDE',
    IDEVersion: TRAE_CONSTANTS.IdeVersion,
  })
  const r = data?.Result || data
  return {
    uid: pickStr(r, ['UserID', 'uid', 'user_id']),
    nickname: pickStr(r, ['ScreenName', 'nickname', 'name']),
    enterpriseId: pickStr(r, ['EnterpriseID', 'enterprise_id', 'TenantID']),
  }
}

// ===== 模型 =====

/** 拉 SOLO 模型表（get_detail_param，32 配置）。 */
export async function fetchTraeModels(account: TraeAccount): Promise<TraeModelInfo[]> {
  const data = await doJson(
    TRAE_CONSTANTS.AgentHost + TRAE_CONSTANTS.EpModels,
    soloHeaders(account, false),
    {
      function: TRAE_CONSTANTS.Function,
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    },
    30000
  )
  const list = data?.config_info_list
  if (!Array.isArray(list)) throw new Error('models api parse: missing config_info_list')
  const out: TraeModelInfo[] = []
  for (const cfg of list) {
    const id = typeof cfg?.config_name === 'string' ? cfg.config_name : ''
    if (!id) continue
    out.push({
      id,
      name: cfg?.display_config?.display_name || '',
      contextWindow: Number(cfg?.max_input_tokens) || 0,
      maxTokens: Number(cfg?.max_output_tokens) || 0,
    })
  }
  if (out.length === 0) throw new Error('models api returned empty list')
  return out
}

// ===== 签到 / 积分（api.trae.cn） =====

export interface TraeCheckinStatus {
  checkedIn: boolean
  credits: number
  enable: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从签到/积分响应里取业务 code（可能顶层也可能在 data 里）。 */
function checkinCode(data: any): number {
  if (data && typeof data === 'object') {
    if (typeof data.code === 'number') return data.code
    if (data.data && typeof data.data === 'object' && typeof data.data.code === 'number') return data.data.code
  }
  return 0
}

/** success 字段显式为 false 视为业务失败。 */
function checkinRejected(data: any): boolean {
  return !!(data && typeof data === 'object' && data.success === false)
}

function checkinMessage(message?: string, msg?: string): string {
  const m = (message || '').trim()
  return m || (msg || '').trim()
}

/** 把业务 code 转成可读错误；9074 是设备指纹失败（需重新登录换合法 device_id）。 */
function checkinBizError(code: number, msg: string): string {
  if (code === 9074 || /9074/.test(msg)) {
    return `设备指纹校验失败（9074）：账号绑定的 device_id 无效，请重新登录该账号以更新设备标识（${msg || ''}）`.trim()
  }
  const trimmed = msg || `code=${code}`
  return code !== 0 ? `code=${code} msg=${trimmed}` : trimmed
}

export async function fetchCheckinStatus(account: TraeAccount): Promise<TraeCheckinStatus> {
  const data = await doJson(TRAE_CONSTANTS.UgHost + TRAE_CONSTANTS.EpCheckinStatus, ugHeaders(account), {})
  const code = checkinCode(data)
  if (code !== 0 || checkinRejected(data)) {
    throw new Error(checkinBizError(code, checkinMessage(data?.message, data?.msg)))
  }
  return {
    checkedIn: data?.checked_in === true,
    credits: Number(data?.credits) || 0,
    enable: data?.enable === true,
  }
}

/** 9074 限流/指纹失败后的重试等待（对齐 workbuddy-wild 生产默认 8s）。 */
const CHECKIN_RETRY_DELAY_MS = 8000

export async function performCheckinClaim(account: TraeAccount): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await doJson(TRAE_CONSTANTS.UgHost + TRAE_CONSTANTS.EpCheckinClaim, ugHeaders(account), {})
    const code = checkinCode(data)
    const rejected = checkinRejected(data)
    // 9074 → 稍候重试一次（幂等，重试后仍失败再抛错）
    if (code === 9074 && attempt === 0) {
      await sleep(CHECKIN_RETRY_DELAY_MS)
      continue
    }
    // 9095 = 当前设备今日已签到（幂等，视为成功，交由后置 status 校验最终状态）
    if (code === 9095) return
    if (code !== 0 || rejected) {
      const msg = checkinMessage(data?.message, data?.msg)
      throw new Error(checkinBizError(code, msg) + (rejected && code === 0 ? ' (success=false)' : ''))
    }
    return
  }
  throw new Error('checkin claim failed: code=9074 持续限流/指纹失败')
}

/** 聚合剩余积分（ide_user_ent_usage）：每包 credits_limit（总量）− credits_amount（已用），负值按 0。 */
export async function fetchUserEntUsage(account: TraeAccount): Promise<number> {
  const raw = await doJsonText(TRAE_CONSTANTS.UgHost + TRAE_CONSTANTS.EpEntUsage, ugHeaders(account), {})
  let data: any
  try { data = JSON.parse(raw) } catch { data = null }
  const packs = data?.user_entitlement_pack_list
  if (!Array.isArray(packs)) throw new Error('ent usage parse: missing user_entitlement_pack_list')
  let remain = 0
  for (const p of packs) {
    const quota: Record<string, any> = p?.entitlement_base_info?.quota || {}
    const used = Number(p?.usage?.credits_amount) || 0
    const limit = Number(quota?.credits_limit) || 0
    remain += Math.max(0, limit - used)
  }
  return remain
}

// ===== 对话（llm_utils_chat） =====

/**
 * 发 llm_utils_chat 请求（body 为已改写对象，内部再 prepareBody 序列化）。
 * 非 2xx 时抛带 kind/status/msg 的错误；成功返回 Response（stream=true 时为 SSE 流）。
 */
export async function chatStream(account: TraeAccount, bodyObj: Record<string, any>): Promise<Response> {
  const payload = prepareBody(JSON.stringify(bodyObj))
  // 流式响应不能设总超时：思考模型（glm-5.2/DeepSeek-V4-Pro 等）可能思考数十秒
  // 才出首字节，AbortSignal.timeout(30s) 会从 fetch 开始计时、在思考期间把整个流
  // 掐断（用户实测思考 ~25s 后输出被截断）。只对"建立连接 + 响应头"设超时，
  // 响应头到达后取消计时，body 流交给上层 withSSEKeepAlive（180s idle 兜底）自然结束。
  const controller = new AbortController()
  const connectTimer = setTimeout(() => controller.abort(), TRAE_CHAT_CONNECT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(TRAE_CONSTANTS.AgentHost + TRAE_CONSTANTS.EpChat, {
      method: 'POST',
      headers: soloHeaders(account, true),
      body: payload,
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(connectTimer)
    // 网络/连接中断（建立连接超时、客户端掐断、DNS/网络异常等）→ 标记为 transport。
    // 这类错误与账号健康无关（token/权益没问题），不能计入账号错误冷却，否则
    // 一次网络抖动会把整个账号池刷成 no_healthy_account。
    const err = new Error(`chat transport error: ${(e as Error).message || String(e)}`) as Error & { kind?: TraeErrKind }
    ;(err as any).kind = 'transport'
    throw err
  }
  clearTimeout(connectTimer)
  if (response.status >= 400) {
    const raw = await response.text().catch(() => '')
    const kind = classifyTraeError(response.status, raw)
    const err = new Error(`upstream ${kind} (http ${response.status}): ${raw.substring(0, 200)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string }
    ;(err as any).kind = kind
    ;(err as any).status = response.status
    ;(err as any).msg = raw.substring(0, 200)
    throw err
  }
  return response
}
