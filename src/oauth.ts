import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import type { Env, OAuthDeviceConfig, OAuthTokenState, DeviceFlowState } from './types'
import { startM365PKCE, submitM365PKCECallback, m365ROPC, refreshM365Token, getM365AccountInfos } from './m365/oauth'

// ===== KV 读写 =====

const deviceKey = (providerId: string) => KV_KEYS.OAUTH_DEVICE_PREFIX + providerId
const tokenKey = (providerId: string) => KV_KEYS.OAUTH_TOKEN_PREFIX + providerId

/** WorkBuddy 多账号池 KV 前缀（oauth-pool.ts 复用，避免循环依赖）。 */
export const OAUTH_POOL_KV_PREFIX = 'oauth:pool:'

/** 从 JWT payload 提取 uid（不验签；非 JWT 或无法解析返回空串）。 */
export function decodeJwtUid(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return ''
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(atob(b64)) as Record<string, any>
    if (!payload || typeof payload !== 'object') return ''
    for (const k of ['uid', 'user_id', 'userId', 'sub', 'UserID']) {
      const v = payload[k]
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
    }
    return ''
  } catch {
    return ''
  }
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.KV.get(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export async function readOauthToken(env: Env, providerId: string): Promise<OAuthTokenState | null> {
  return readJson<OAuthTokenState>(env, tokenKey(providerId))
}

async function writeOauthToken(env: Env, providerId: string, state: OAuthTokenState): Promise<void> {
  // R4：有 refresh_token 时 TTL 放宽到 30 天——access_token 2h 过期不能连带删除
  // 刷新凭据，否则离线续期功能失效；只有无 refresh_token（一次性 token）才随
  // access 过期清理，KV 到期自动回收避免残留。
  const ttlSeconds = state.refresh_token
    ? 86400 * 30
    : Math.min(Math.max(Math.ceil((state.expires_at - Date.now()) / 1000), 60), 86400 * 30)
  await env.KV.put(tokenKey(providerId), JSON.stringify(state), { expirationTtl: ttlSeconds })
}

export async function deleteOauthToken(env: Env, providerId: string): Promise<void> {
  await env.KV.delete(tokenKey(providerId))
}

/**
 * 构造转发到上游时使用的认证头：注入 tokenHeader + prefix + extraHeaders + cookies。
 * 供 proxy 转发、模型列表拉取、模型连通性测试复用，保证三者一致。
 * opts.origin 可覆盖 Origin/Referer（用于 Global 域路由）。
 */
export function buildOauthHeaders(
  cfg: OAuthDeviceConfig,
  token: string,
  opts?: { contentType?: string; origin?: string; apiType?: string; cookies?: string }
): Record<string, string> {
  const tokenHeader = cfg.tokenHeader || 'x-api-key'
  const prefix = cfg.tokenHeaderPrefix || ''
  // 自动补全：如果 prefix 非空且不以空格结尾，补一个空格（常见错误：Bearer 漏了空格）
  const safePrefix = prefix && !prefix.endsWith(' ') ? prefix + ' ' : prefix
  const headers: Record<string, string> = {
    'Content-Type': opts?.contentType ?? 'application/json',
    'Accept': 'application/json',
    [tokenHeader]: safePrefix + token,
    ...(cfg.extraHeaders || {}),
  }
  if (opts?.origin) {
    headers['Origin'] = opts.origin
    headers['Referer'] = opts.origin + '/'
  }
  if (opts?.cookies) {
    headers['Cookie'] = opts.cookies
  }
  if (opts?.apiType === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  return headers
}

/**
 * 解析 access_token (JWT) 的 iss 判断账户领域。
 * WorkBuddy: Global (iss 含 workbuddy.ai) 必须走 www.workbuddy.ai，
 *            否则 copilot.tencent.com 的 APISIX 会返回 401；
 *            CN (iss 含 codebuddy.cn) 走 copilot.tencent.com。
 * 非 JWT 或无法解析时返回 null，调用方按 CN 默认处理。
 */
export function detectTokenRealm(token: string): 'global' | 'cn' | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(atob(b64)) as { iss?: string }
    const iss = String(payload?.iss || '').toLowerCase()
    if (iss.includes('workbuddy.ai')) return 'global'
    if (iss.includes('codebuddy.cn')) return 'cn'
    return null
  } catch {
    return null
  }
}

/** 是否为 Global 域 token（便捷封装） */
export function isGlobalToken(token: string): boolean {
  return detectTokenRealm(token) === 'global'
}

// ===== OAuth 流程入口（根据 flowType 分发） =====

export interface DeviceFlowResult {
  success: boolean
  message: string
  device?: DeviceFlowState
}

/**
 * 发起 OAuth 登录流程。根据 cfg.flowType 分发到设备码或浏览器登录模式。
 */
export async function startOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  if (cfg.flowType === 'gemini') {
    return startOauthGeminiFlow(env, providerId, cfg)
  }
  if (cfg.flowType === 'qoder') {
    return startOauthQoderFlow(env, providerId, cfg)
  }
  if (cfg.flowType === 'browser') {
    return startOauthBrowserFlow(env, providerId, cfg)
  }
  if (cfg.flowType === 'm365-pkce') {
    const r = await startM365PKCE(env, providerId, cfg)
    return { success: r.success, message: r.message, device: r.authUrl ? { device_code: '', user_code: '', verification_uri: r.authUrl, interval: cfg.pollInterval || 5, expires_at: 0, flowType: 'm365-pkce' } : undefined }
  }
  if (cfg.flowType === 'm365-ropc') {
    // ROPC 需要账号密码，走后台表单单独提交，不经过此处
    return { success: false, message: 'm365-ropc 请使用账号密码直接登录（见后台表单）' }
  }
  return startOauthDeviceCodeFlow(env, providerId, cfg)
}

export type PollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/**
 * 轮询 OAuth 授权结果。根据 KV 中存储的 flowType 分发。
 */
export async function pollOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<PollResult> {
  const device = await readJson<DeviceFlowState>(env, deviceKey(providerId))
  if (!device) return { status: 'error', message: '没有进行中的登录流程，请重新发起' }

  // KV 中有 flowType 就按它走；没有则按 cfg 走（兼容旧数据）
  const flowType = device.flowType || cfg.flowType || 'device'
  if (flowType === 'gemini') {
    return pollOauthGeminiFlow(env, providerId, cfg, device)
  }
  if (flowType === 'qoder') {
    return pollOauthQoderFlow(env, providerId, cfg, device)
  }
  if (flowType === 'browser') {
    return pollOauthBrowserFlow(env, providerId, cfg, device)
  }
  if (flowType === 'm365-pkce') {
    // PKCE 回调由后台「提交回调 URL」完成换 token；轮询只兜底检测 token 是否已写入
    const token = await readOauthToken(env, providerId)
    if (token) return { status: 'success', message: 'OAuth 连接成功' }
    return { status: 'pending', message: '请授权后把回调 URL 粘贴回后台' }
  }
  return pollOauthDeviceCodeFlow(env, providerId, cfg, device)
}

// ===== 设备码流程（RFC 8628） =====

async function startOauthDeviceCodeFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    const params = new URLSearchParams({ client_id: cfg.clientId })
    if (cfg.scope) params.set('scope', cfg.scope)

    const res = await fetch(cfg.deviceCodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `申请设备码失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }

    const data = (await res.json()) as {
      device_code: string
      user_code: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }

    if (!data.device_code || !data.user_code) {
      return { success: false, message: '设备码接口返回格式异常' }
    }

    const device: DeviceFlowState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri || cfg.deviceCodeUrl,
      interval: data.interval || 5,
      expires_at: Date.now() + (data.expires_in || 600) * 1000,
      flowType: 'device',
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '设备码已生成', device }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthDeviceCodeFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '设备码已过期，请重新发起' }
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: cfg.clientId,
    })
    const res = await fetch(cfg.deviceTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (res.ok) {
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
      if (!data.access_token) return { status: 'error', message: '轮询接口返回异常：缺少 access_token' }
      const expiresInSec = data.expires_in || 3600
      await writeOauthToken(env, providerId, {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + expiresInSec * 1000,
        updated_at: Date.now(),
      })
      await env.KV.delete(deviceKey(providerId))
      return { status: 'success', message: 'OAuth 连接成功' }
    }

    const errorData = (await res.json().catch(() => ({ error: 'unknown' }))) as { error?: string; error_description?: string }
    switch (errorData.error) {
      case 'authorization_pending':
        return { status: 'pending', message: '等待用户授权…' }
      case 'slow_down':
        return { status: 'pending', message: '轮询过快，请稍候重试' }
      case 'expired_token':
        await env.KV.delete(deviceKey(providerId))
        return { status: 'failed', message: '设备码已过期，请重新发起' }
      case 'access_denied':
        await env.KV.delete(deviceKey(providerId))
        return { status: 'failed', message: '用户拒绝了授权' }
      default:
        return { status: 'error', message: `轮询异常: ${errorData.error_description || errorData.error || res.status}` }
    }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

// ===== 浏览器登录流程（WorkBuddy/CodeBuddy 自定义 OAuth） =====
//
// 流程参考 cpa-plugin/workbuddy：
//   1. POST {deviceCodeUrl} body={}  → {code:0, data:{state, authUrl}}
//   2. 用户在浏览器打开 authUrl 完成登录
//   3. GET  {deviceTokenUrl}?state=xxx  → {code:0, data:{accessToken, refreshToken, expiresIn, domain}}
//   4. 刷新 POST {refreshTokenUrl} header X-Refresh-Token  → 同上

/** 构造 browser 模式的公共请求头；realm='global' 时用 globalOrigin 覆盖 Origin/Referer */
function browserCommonHeaders(cfg: OAuthDeviceConfig, realm?: 'cn' | 'global'): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    ...cfg.extraHeaders,
  }
  if (realm === 'global' && cfg.globalOrigin) {
    headers['Origin'] = cfg.globalOrigin
    headers['Referer'] = cfg.globalOrigin + '/'
  }
  return headers
}

/** browser 模式：解析本次登录使用的域（device 优先，其次 cfg，默认 cn） */
function browserRealm(cfg: OAuthDeviceConfig, device?: DeviceFlowState): 'cn' | 'global' {
  return (device?.loginRealm || cfg.loginRealm) === 'global' ? 'global' : 'cn'
}

/** browser 模式：按域解析发起/轮询/刷新端点；Global 端点缺失时返回空串（由调用方报错，不再静默回退国内端点） */
function browserCodeUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? (cfg.globalDeviceCodeUrl || '') : cfg.deviceCodeUrl
}
function browserTokenUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? (cfg.globalDeviceTokenUrl || '') : cfg.deviceTokenUrl
}
function browserRefreshUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? (cfg.globalRefreshTokenUrl || '') : cfg.refreshTokenUrl
}

/** CodeBuddy/WorkBuddy 的响应信封：{code, msg, data} */
interface CodeBuddyEnvelope<T = unknown> {
  code: number
  msg: string
  data?: T
}

interface CodeBuddyTokenData {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  domain?: string
}

interface CodeBuddyAuthStateData {
  state: string
  authUrl: string
}

async function startOauthBrowserFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    // 发起登录前先确定域：WorkBuddy 国际版账号必须走 www.workbuddy.ai 端点
    const realm = browserRealm(cfg)
    const codeUrl = browserCodeUrl(cfg, realm)
    if (!codeUrl) {
      return { success: false, message: '登录域为国际版但未配置 Global 域发起端点（globalDeviceCodeUrl），请在 OAuth 配置中补全或改回国内版' }
    }
    const res = await fetch(codeUrl, {
      method: 'POST',
      headers: browserCommonHeaders(cfg, realm),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `发起登录失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }

    const env_resp = (await res.json()) as CodeBuddyEnvelope<CodeBuddyAuthStateData>
    if (env_resp.code !== 0 || !env_resp.data?.state || !env_resp.data?.authUrl) {
      return { success: false, message: `登录发起返回异常: code=${env_resp.code} msg=${env_resp.msg}` }
    }

    // cpa-plugin 核心要求：保存 Set-Cookie，轮询时必须复用同一个 cookie jar
    const setCookie = res.headers.get('Set-Cookie') || ''
    const allSetCookies: string[] = []
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') allSetCookies.push(value)
    })
    // 只记录数量，绝不打印 Cookie 原文（上游 Cookie 属账号会话凭据）
    console.log(`[oauth-start] provider=${providerId} Set-Cookie count: ${allSetCookies.length}`)
    const { state, authUrl } = env_resp.data
    const device: DeviceFlowState = {
      device_code: state,        // browser 模式下 device_code 字段存 state
      user_code: '',             // browser 模式无用户码
      verification_uri: authUrl, // 存登录页 URL
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 5 * 60 * 1000, // 5 分钟超时（参考插件 loginTTL）
      flowType: 'browser',
      cookies: setCookie || undefined,
      loginRealm: realm,
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '登录链接已生成', device }
  } catch (err) {
    return { success: false, message: `发起登录异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthBrowserFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '登录已超时（5 分钟），请重新发起' }
  }

  const state = device.device_code // browser 模式下存的是 state
  try {
    // 轮询必须与发起登录同域（device.loginRealm 固化），否则 state 在另一域无效
    const realm = browserRealm(cfg, device)
    const tokenUrl = browserTokenUrl(cfg, realm)
    if (!tokenUrl) {
      return { status: 'error', message: '登录域为国际版但未配置 Global 域轮询端点（globalDeviceTokenUrl），请在 OAuth 配置中补全或改回国内版' }
    }
    const sep = tokenUrl.includes('?') ? '&' : '?'
    const pollUrl = `${tokenUrl}${sep}state=${encodeURIComponent(state)}`
    const pollHeaders: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...cfg.extraHeaders,
    }
    // Global 域用 workbuddy.ai Origin/Referer 覆盖（extraHeaders 里是 codebuddy.cn）
    if (realm === 'global' && cfg.globalOrigin) {
      pollHeaders['Origin'] = cfg.globalOrigin
      pollHeaders['Referer'] = cfg.globalOrigin + '/'
    }
    // cpa-plugin 核心要求：轮询必须复用同一个 cookie jar，否则 token 无效导致 401
    if (device.cookies) {
      pollHeaders['Cookie'] = device.cookies
    }
    const res = await fetch(pollUrl, {
      method: 'GET',
      headers: pollHeaders,
      signal: AbortSignal.timeout(15000),
    })

    // 4xx 或业务码非 0 = 还在等待用户登录
    if (!res.ok) {
      return { status: 'pending', message: '等待用户在浏览器完成登录…' }
    }

    const env_resp = (await res.json().catch(() => null)) as CodeBuddyEnvelope<CodeBuddyTokenData> | null
    if (!env_resp || env_resp.code !== 0 || !env_resp.data?.accessToken) {
      return { status: 'pending', message: '等待用户在浏览器完成登录…' }
    }

    const tok = env_resp.data
    const expiresInSec = tok.expiresIn || 7200
    // 保存 cookies 到 token 状态，后续模型拉取和 API 转发需要复用
    const newCookies = res.headers.get('Set-Cookie') || device.cookies || undefined
    // 只记录是否有 Cookie（长度），绝不打印原文
    console.log(`[oauth-poll] provider=${providerId} set-cookie from poll response: ${newCookies ? `yes (${newCookies.length} chars)` : '(none)'}`)
    console.log(`[oauth-poll] provider=${providerId} device.cookies from login: ${device.cookies ? `yes (${device.cookies.length} chars)` : '(none)'}`)
    const tokenState: OAuthTokenState = {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken,
      expires_at: Date.now() + expiresInSec * 1000,
      updated_at: Date.now(),
      cookies: newCookies,
    }
    await writeOauthToken(env, providerId, tokenState)
    // WorkBuddy 多账号池：每次成功登录把一个账号 upsert 进池（按 JWT uid 去重），
    // 池内多个账号按剩余积分自动挑选、错误冷却轮换。
    await browserPoolUpsert(env, providerId, tokenState)
    await env.KV.delete(deviceKey(providerId))
    return { status: 'success', message: 'OAuth 连接成功' }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

/** 池内账号的最小结构（与 src/oauth-pool.ts 的 OAuthPoolAccount 保持字段兼容）。 */
interface BrowserPoolAccount {
  uid: string
  nickname?: string
  token: OAuthTokenState
  enabled: boolean
  state: { credits: number; disabled: boolean; reason?: string; until: number; errCount: number }
  updatedAt: number
}

/** 把一次成功登录的 browser token upsert 进 WorkBuddy 账号池（按 uid）。 */
async function browserPoolUpsert(env: Env, providerId: string, token: OAuthTokenState): Promise<void> {
  const uid = decodeJwtUid(token.access_token)
  if (!uid) return // 非 JWT（无法确定账号身份）不进池
  try {
    const key = OAUTH_POOL_KV_PREFIX + providerId
    const raw = await env.KV.get(key)
    let pool: BrowserPoolAccount[] = []
    try { pool = raw ? JSON.parse(raw) : [] } catch { pool = [] }
    if (!Array.isArray(pool)) pool = []
    const existing = pool.find((a) => a.uid === uid)
    if (existing) {
      existing.token = token
      existing.enabled = true
      existing.updatedAt = Date.now()
    } else {
      pool.push({
        uid,
        token,
        enabled: true,
        state: { credits: 0, disabled: false, until: 0, errCount: 0 },
        updatedAt: Date.now(),
      })
    }
    await env.KV.put(key, JSON.stringify(pool))
  } catch (e) {
    console.warn(`[oauth-pool] upsert failed: ${(e as Error).message}`)
  }
}

// ===== QoderWork 设备授权流程（PKCE，参考 cpa-plugin/qoderwork/oauth.go） =====
//
// 流程（无需 PAT）：
//   1. 本地生成 PKCE verifier/challenge (S256) + nonce + machine_id，
//      构造授权链接 https://qoder.com.cn/device/selectAccounts?challenge=...&client_id=...&redirect_uri=qoder-work-cn://
//   2. 用户在浏览器打开链接完成授权
//   3. GET  {deviceTokenUrl}?nonce&verifier&challenge_method=S256  → 404/202=待授权；200 返回 {token:dt-, refresh_token:drt-, user_id}
//   4. 刷新 POST {refreshTokenUrl} body {refresh_token: drt-}  → 新的 dt-/drt- 对
//
// 常量与桌面客户端一致：client_id=1c5e33e1-364d-4ce6-b02c-acaa81274a5c、redirect_uri=qoder-work-cn://

const QODER_WEBSITE_CN = 'https://qoder.com.cn'
const QODER_REDIRECT_URI = 'qoder-work-cn://'

/** 生成 PKCE verifier/challenge（RFC 7636 S256）。 */
async function makeQoderPKCE(): Promise<{ verifier: string; challenge: string }> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const raw = crypto.getRandomValues(new Uint8Array(64))
  let verifier = ''
  for (let i = 0; i < 64; i++) verifier += alphabet[raw[i] % alphabet.length]
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const bytes = new Uint8Array(digest)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const challenge = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { verifier, challenge }
}

/** 解析 deviceToken 响应中的过期时间（expires_in 为毫秒，或 expires_at RFC3339）。默认 30 天。 */
function qoderExpiryUnix(data: { expires_in?: number; expires_at?: string }): number {
  if (data.expires_in && data.expires_in > 0) {
    return Date.now() + data.expires_in
  }
  if (data.expires_at) {
    const t = Date.parse(data.expires_at)
    if (!Number.isNaN(t)) return t
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000
}

async function startOauthQoderFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    const { verifier, challenge } = await makeQoderPKCE()
    const nonce = crypto.randomUUID()
    const machineId = crypto.randomUUID()

    const params = new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      nonce,
      machine_id: machineId,
      client_id: cfg.clientId || '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
      redirect_uri: QODER_REDIRECT_URI,
    })
    const authUrl = `${QODER_WEBSITE_CN}/device/selectAccounts?${params.toString()}`

    const device: DeviceFlowState = {
      device_code: '',
      user_code: '',
      verification_uri: authUrl,
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 10 * 60 * 1000, // 10 分钟超时（参考插件 loginTTL）
      flowType: 'qoder',
      verifier,
      nonce,
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '登录链接已生成', device }
  } catch (err) {
    return { success: false, message: `发起登录异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthQoderFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '登录已超时（10 分钟），请重新发起' }
  }

  try {
    const params = new URLSearchParams({
      nonce: device.nonce || '',
      verifier: device.verifier || '',
      challenge_method: 'S256',
    })
    const sep = cfg.deviceTokenUrl.includes('?') ? '&' : '?'
    const pollUrl = `${cfg.deviceTokenUrl}${sep}${params.toString()}`
    const res = await fetch(pollUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'QoderWork' },
      signal: AbortSignal.timeout(15000),
    })

    // 404 / 202 = 用户尚未完成授权
    if (res.status === 404 || res.status === 202) {
      return { status: 'pending', message: '等待用户完成 QoderWork 设备授权…' }
    }
    if (!res.ok) {
      return { status: 'error', message: `轮询异常 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }

    const data = (await res.json().catch(() => null)) as {
      token?: string
      device_token?: string
      refresh_token?: string
      user_id?: string
      expires_in?: number
      expires_at?: string
    } | null
    const token = data?.token || data?.device_token
    if (!token) {
      return { status: 'pending', message: '等待用户完成 QoderWork 设备授权…' }
    }

    await writeOauthToken(env, providerId, {
      access_token: token,
      refresh_token: data.refresh_token,
      expires_at: qoderExpiryUnix(data),
      updated_at: Date.now(),
      user_id: data.user_id || undefined,
    })
    // Qoder 多账号池：每次成功登录把一个账号 upsert 进池（按 user_id 去重），
    // 池内多个账号按剩余积分自动挑选、错误冷却轮换。多登一个 = 多个账号。
    await qoderPoolUpsert(env, providerId, {
      access_token: token,
      refresh_token: data.refresh_token,
      expires_at: qoderExpiryUnix(data),
      updated_at: Date.now(),
      user_id: data.user_id || undefined,
    })
    await env.KV.delete(deviceKey(providerId))
    return { status: 'success', message: 'OAuth 连接成功' }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

/** Qoder 设备 token 刷新的公共请求（POST JSON: {refresh_token: drt-}），返回新 token 状态或 null。 */
export async function refreshQoderTokenPair(
  cfg: OAuthDeviceConfig,
  refreshToken: string,
  prev?: OAuthTokenState
): Promise<OAuthTokenState | null> {
  try {
    const res = await fetch(cfg.refreshTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null

    const data = (await res.json().catch(() => null)) as {
      token?: string
      device_token?: string
      refresh_token?: string
      user_id?: string
      expires_in?: number
      expires_at?: string
    } | null
    const token = data?.token || data?.device_token
    if (!token || !data?.refresh_token) return null

    return {
      access_token: token,
      refresh_token: data.refresh_token,
      expires_at: qoderExpiryUnix(data),
      updated_at: Date.now(),
      // 刷新响应一般不带 user_id，保留原值
      user_id: data.user_id || prev?.user_id,
      nickname: prev?.nickname,
    }
  } catch {
    return null
  }
}

/** Qoder 设备 token 刷新（单 token 路径；池账号由 qoder/pool.ts 按账号刷新）。 */
async function refreshOauthTokenQoder(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false
  const fresh = await refreshQoderTokenPair(cfg, state.refresh_token, state)
  if (!fresh) return false
  await writeOauthToken(env, providerId, fresh)
  // 同步池内同 uid 账号（池为主用时保持一致）
  try { await qoderPoolSyncToken(env, providerId, fresh) } catch { /* ignore */ }
  return true
}

/** 把一次成功登录的 Qoder token upsert 进账号池（按 user_id 去重）。 */
async function qoderPoolUpsert(env: Env, providerId: string, token: OAuthTokenState): Promise<void> {
  const uid = token.user_id || token.access_token.slice(0, 16)
  if (!uid) return
  try {
    const key = KV_KEYS.QODER_POOL_PREFIX + providerId
    const raw = await env.KV.get(key)
    let pool: Array<Record<string, any>> = []
    try { pool = raw ? JSON.parse(raw) : [] } catch { pool = [] }
    if (!Array.isArray(pool)) pool = []
    const existing = pool.find((a) => a && a.uid === uid)
    if (existing) {
      existing.token = token
      existing.enabled = true
      existing.updatedAt = Date.now()
    } else {
      pool.push({
        uid,
        nickname: token.nickname,
        token,
        enabled: true,
        state: { credits: 0, disabled: false, until: 0, errCount: 0 },
        updatedAt: Date.now(),
      })
    }
    await env.KV.put(key, JSON.stringify(pool))
  } catch (e) {
    console.warn(`[qoder-pool] upsert failed: ${(e as Error).message}`)
  }
}

/** 把一份新 token 同步进 Qoder 池（按 uid 匹配更新凭证；池不存在该账号时不新增）。 */
async function qoderPoolSyncToken(env: Env, providerId: string, token: OAuthTokenState): Promise<void> {
  const uid = token.user_id || token.access_token.slice(0, 16)
  const key = KV_KEYS.QODER_POOL_PREFIX + providerId
  let pool: Array<Record<string, any>> = []
  try {
    const raw = await env.KV.get(key)
    pool = raw ? JSON.parse(raw) : []
    if (!Array.isArray(pool)) pool = []
  } catch { pool = [] }
  const existing = pool.find((a) => a && a.uid === uid)
  if (!existing) return
  existing.token = token
  existing.updatedAt = Date.now()
  await env.KV.put(key, JSON.stringify(pool))
}

// ===== Gemini CLI 授权流程（Google OAuth，参考 cpa-plugin-gemini-cli/auth/oauth.go） =====
//
// 网关（Cloudflare Worker）无法监听本地端口，采用"手动粘贴回调 URL"模式：
//   1. startOauthGeminiFlow 生成 PKCE verifier/challenge(S256) + state，
//      构造 Google 授权链接（access_type=offline & prompt=consent）
//   2. 用户在浏览器打开链接授权，Google 重定向到 http://127.0.0.1:<port>/oauth2callback?code=...&state=...
//      （本地无监听服务，浏览器显示连接失败，但地址栏保留完整回调 URL）
//   3. 用户把回调 URL 粘贴回管理后台，submitOauthGeminiCallback 校验 state 后换 token
//   4. 换 token 成功后拉取账号邮箱 / CodeAssist 项目 ID（cloudcode-pa 请求需要 project），
//      一并存入 KV token 状态
//   5. 临近过期由 refreshOauthTokenGemini 自动刷新（POST oauth2.googleapis.com/token）

export const GEMINI_OAUTH = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
  projectsUrl: 'https://cloudresourcemanager.googleapis.com/v1/projects',
  codeAssistBaseUrl: 'https://cloudcode-pa.googleapis.com',
  codeAssistVersion: 'v1internal',
  redirectUri: 'http://127.0.0.1:8089/oauth2callback',
  scope: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ].join(' '),
}

/**
 * gemini-cli 公开发布的 installed-app OAuth Client（已在 Google Cloud 公开，无需自建）。
 * Antigravity-Manager / gemini-cli 均硬编码此凭据实现「登录谷歌账号即可完成认证」。
 */
const GEMINI_PUBLIC_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const GEMINI_PUBLIC_CLIENT_SECRET = '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'

/**
 * Gemini OAuth 客户端凭据：优先取提供商表单（KV），其次取环境变量，
 * 最后兜底使用 gemini-cli 公开凭据（无需用户填写即可直接登录谷歌账号）。
 */
function geminiClientCreds(env: Env, cfg: OAuthDeviceConfig): { clientId: string; clientSecret: string } {
  return {
    clientId: cfg.clientId || env.GEMINI_OAUTH_CLIENT_ID || GEMINI_PUBLIC_CLIENT_ID,
    clientSecret: cfg.clientSecret || env.GEMINI_OAUTH_CLIENT_SECRET || GEMINI_PUBLIC_CLIENT_SECRET,
  }
}

/** Gemini CLI 指纹请求头（上游校验存在性，缺失会 403 preconditions failed） */
export const GEMINI_API_CLIENT_HEADER = 'google-genai-sdk/1.41.0 gl-node/v22.19.0'
export function geminiUserAgent(model = ''): string {
  return `GeminiCLI/0.34.0/${model || 'unknown'} (win32; x64; terminal)`
}

function geminiRandomState(): string {
  const raw = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function startOauthGeminiFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    const { verifier, challenge } = await makeQoderPKCE()
    const state = geminiRandomState()
    const creds = geminiClientCreds(env, cfg)
    // 过滤掉该客户端不支持的无效 scope（cclog/experimentsandconfigs），
    // 避免历史 KV 中保存的旧配置导致 invalid_scope 400
    const scope = (cfg.scope || GEMINI_OAUTH.scope)
      .split(/\s+/)
      .filter((s) => s && s !== 'cclog' && s !== 'experimentsandconfigs')
      .join(' ')
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: GEMINI_OAUTH.redirectUri,
      response_type: 'code',
      scope,
      state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    const authUrl = `${GEMINI_OAUTH.authUrl}?${params.toString()}`

    const device: DeviceFlowState = {
      device_code: state, // 复用字段存 state（与 browser 模式一致）
      user_code: '',
      verification_uri: authUrl, // 授权链接
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 10 * 60 * 1000, // 10 分钟超时（参考插件 loginTimeout）
      flowType: 'gemini',
      verifier,
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '授权链接已生成', device }
  } catch (err) {
    return { success: false, message: `发起授权异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthGeminiFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '授权已超时（10 分钟），请重新发起' }
  }
  // 回调提交成功后 token 已写入且 device 已删除；此处仅兜底判断
  const token = await readOauthToken(env, providerId)
  if (token) return { status: 'success', message: 'OAuth 连接成功' }
  return { status: 'pending', message: '请授权后把回调 URL 粘贴回后台' }
}

export interface GeminiCallbackResult {
  success: boolean
  message: string
  email?: string
  projectId?: string
}

/**
 * 提交 Gemini 授权回调：解析回调 URL 中的 code/state → 校验 state →
 * code 换 token（PKCE）→ 拉取邮箱与项目 ID → 写入 KV。
 */
export async function submitOauthGeminiCallback(
  env: Env,
  providerId: string,
  cfg: OAuthDeviceConfig,
  callbackUrl: string
): Promise<GeminiCallbackResult> {
  const device = await readJson<DeviceFlowState>(env, deviceKey(providerId))
  if (!device || device.flowType !== 'gemini') {
    return { success: false, message: '没有进行中的授权流程，请先点击「发起连接」' }
  }
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { success: false, message: '授权流程已超时（10 分钟），请重新发起' }
  }

  const parsed = parseGeminiCallbackUrl(callbackUrl)
  if (!parsed) {
    return { success: false, message: '无法从回调 URL 解析出 code，请核对粘贴内容（应包含 ?code=...）' }
  }
  if (parsed.error) {
    return { success: false, message: `授权被拒绝：${parsed.error}` }
  }
  // S7：state 校验不可跳过——发起授权时已把 state 写入 device.device_code，
  // 回调缺少 state 或与本次流程不一致一律拒绝（防账号劫持/跨流程复用）
  if (!parsed.state || parsed.state !== device.device_code) {
    return { success: false, message: 'OAuth state 校验失败，请确认粘贴的是本次发起的授权回调 URL' }
  }

  try {
    const creds = geminiClientCreds(env, cfg)
    const params = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code: parsed.code,
      grant_type: 'authorization_code',
      redirect_uri: GEMINI_OAUTH.redirectUri,
      code_verifier: device.verifier || '',
    })
    const res = await fetch(GEMINI_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      const text = await res.text()
      return { success: false, message: `换 token 失败 HTTP ${res.status}: ${text.substring(0, 300)}` }
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) {
      return { success: false, message: '换取 token 的响应缺少 access_token' }
    }

    const tokenState: OAuthTokenState = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      updated_at: Date.now(),
    }

    // 以 userinfo 邮箱作为账号标识（可选，失败不阻塞）
    const email = await geminiFetchEmail(data.access_token)
    if (email) tokenState.email = email

    // CodeAssist 项目 ID：loadCodeAssist → onboardUser，失败回退到项目列表首个
    const projects = await geminiFetchProjectIDs(data.access_token)
    if (projects.length > 0) tokenState.projectIds = projects
    const projectId = await geminiResolveProjectId(data.access_token, projects)
    if (projectId) tokenState.projectId = projectId

    await writeOauthToken(env, providerId, tokenState)
    await env.KV.delete(deviceKey(providerId))
    return {
      success: true,
      message: 'OAuth 连接成功' + (email ? `（${email}）` : ''),
      email: email || undefined,
      projectId: projectId || undefined,
    }
  } catch (err) {
    return { success: false, message: `换 token 异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function refreshOauthTokenGemini(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false

  try {
    const creds = geminiClientCreds(env, cfg)
    const params = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: state.refresh_token,
      grant_type: 'refresh_token',
    })
    const res = await fetch(GEMINI_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) return false

    await writeOauthToken(env, providerId, {
      access_token: data.access_token,
      refresh_token: data.refresh_token || state.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      updated_at: Date.now(),
      // 刷新响应不带账号信息，保留原值
      email: state.email,
      projectId: state.projectId,
      projectIds: state.projectIds,
    })
    return true
  } catch {
    return false
  }
}

/** 解析用户粘贴的回调 URL，兼容 ?query 与 #fragment 两种携带形式。 */
interface GeminiCallbackPayload {
  code: string
  state: string
  error: string
}
function parseGeminiCallbackUrl(input: string): GeminiCallbackPayload | null {
  let trimmed = (input || '').trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (!candidate.includes('://')) {
    if (candidate.startsWith('?')) {
      candidate = 'http://localhost' + candidate
    } else if (/[/?#:]/.test(candidate)) {
      candidate = 'http://' + candidate
    } else if (candidate.includes('=')) {
      candidate = 'http://localhost/?' + candidate
    } else {
      return null
    }
  }

  let url: URL
  try { url = new URL(candidate) } catch { return null }

  let code = url.searchParams.get('code') || ''
  let state = url.searchParams.get('state') || ''
  let error = url.searchParams.get('error') || ''
  const errDesc = url.searchParams.get('error_description') || ''
  if (!error && errDesc) error = errDesc

  if (url.hash) {
    const frag = new URLSearchParams(url.hash.replace(/^#/, ''))
    if (!code) code = frag.get('code') || ''
    if (!state) state = frag.get('state') || ''
    if (!error) error = frag.get('error') || frag.get('error_description') || ''
  }
  // 个别场景 code 带 #state 粘在一起
  if (code && !state && code.includes('#')) {
    const parts = code.split('#')
    code = parts[0]
    state = parts[1] || ''
  }
  if (!code && !error) return null
  return { code, state, error }
}

/** 拉取账号邮箱（userinfo）。失败返回 null。 */
async function geminiFetchEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GEMINI_OAUTH.userInfoUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': geminiUserAgent(),
        'X-Goog-Api-Client': GEMINI_API_CLIENT_HEADER,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { email?: string }
    return data.email || null
  } catch {
    return null
  }
}

/** 拉取账号可用项目 ID 列表（cloudresourcemanager）。失败返回空数组。 */
async function geminiFetchProjectIDs(accessToken: string): Promise<string[]> {
  try {
    const res = await fetch(GEMINI_OAUTH.projectsUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': geminiUserAgent(),
        'X-Goog-Api-Client': GEMINI_API_CLIENT_HEADER,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { projects?: Array<{ projectId?: string }> }
    const ids = (data.projects || [])
      .map((p) => (p.projectId || '').trim())
      .filter((id) => id.length > 0)
    return [...new Set(ids)]
  } catch {
    return []
  }
}

/**
 * 解析 CodeAssist 项目 ID（参考插件 auth/oauth.go setupCodeAssist）：
 * loadCodeAssist 拿默认 tier 与已绑定项目 → 未绑定则 onboardUser 自动发现 →
 * 仍失败回退到项目列表第一个。全部失败返回 null（不阻塞登录）。
 */
async function geminiResolveProjectId(accessToken: string, fallbackProjects: string[]): Promise<string> {
  const base = `${GEMINI_OAUTH.codeAssistBaseUrl}/${GEMINI_OAUTH.codeAssistVersion}`
  const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': geminiUserAgent(),
    'X-Goog-Api-Client': GEMINI_API_CLIENT_HEADER,
  }

  const call = async (endpoint: string, body: unknown): Promise<any> => {
    const res = await fetch(`${base}:${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`)
    }
    return res.json()
  }

  try {
    // 1. loadCodeAssist：老账号直接带出已绑定的 cloudaicompanionProject
    const loadResp = await call('loadCodeAssist', { metadata }) as {
      allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
      cloudaicompanionProject?: unknown
    }
    let projectId = geminiProjectFromValue(loadResp?.cloudaicompanionProject)
    if (projectId) return projectId

    // 2. onboardUser 自动发现项目（新账号需先绑定项目）
    const tierId = geminiDefaultTierId(loadResp?.allowedTiers)
    const onboardResp = await call('onboardUser', { tierId, metadata }) as { done?: boolean; response?: { cloudaicompanionProject?: unknown } }
    if (onboardResp?.done) {
      projectId = geminiProjectFromValue(onboardResp?.response?.cloudaicompanionProject)
      if (projectId) return projectId
    }
  } catch { /* fall through to project list */ }

  // 3. 回退：项目列表首个
  if (fallbackProjects.length > 0) {
    const first = fallbackProjects.find((id) => id.trim() !== '')
    if (first) return first
  }
  return ''
}

function geminiDefaultTierId(tiers: unknown): string {
  if (Array.isArray(tiers)) {
    for (const t of tiers) {
      if (t && typeof t === 'object' && (t as { isDefault?: boolean }).isDefault && (t as { id?: string }).id) {
        return String((t as { id: string }).id).trim() || 'legacy-tier'
      }
    }
  }
  return 'legacy-tier'
}

function geminiProjectFromValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string') return id.trim()
  }
  return ''
}

// ===== Token 刷新 =====

// R1：同一 provider 并发刷新去重。多个请求同时 401 → 同时 refresh 时，
// 会各自读到旧 state、并发打上游，上游 rotate refresh_token 后后写覆盖先写。
// 在 isolate 内存中合并同一 provider 的刷新任务，只打一次上游。
const refreshInflight = new Map<string, Promise<boolean>>()

/**
 * 使用 refresh_token 刷新 access_token。根据 flowType 分发。
 */
export function refreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const existing = refreshInflight.get(providerId)
  if (existing) return existing
  const task = doRefreshOauthToken(env, providerId, cfg).finally(() => {
    refreshInflight.delete(providerId)
  })
  refreshInflight.set(providerId, task)
  return task
}

async function doRefreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  if (cfg.flowType === 'gemini') {
    return refreshOauthTokenGemini(env, providerId, cfg)
  }
  if (cfg.flowType === 'qoder') {
    return refreshOauthTokenQoder(env, providerId, cfg)
  }
  if (cfg.flowType === 'browser') {
    return refreshOauthTokenBrowser(env, providerId, cfg)
  }
  if (cfg.flowType === 'm365-pkce' || cfg.flowType === 'm365-ropc') {
    return refreshM365Token(env, providerId, cfg)
  }
  return refreshOauthTokenDevice(env, providerId, cfg)
}

/** 设备码模式的 token 刷新（POST JSON: {refresh_token, client_id}） */
async function refreshOauthTokenDevice(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false

  try {
    const res = await fetch(cfg.refreshTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refresh_token, client_id: cfg.clientId }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return false

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) return false

    await writeOauthToken(env, providerId, {
      access_token: data.access_token,
      refresh_token: data.refresh_token || state.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      updated_at: Date.now(),
    })
    return true
  } catch {
    return false
  }
}

/** 浏览器登录模式的 token 刷新（POST header X-Refresh-Token）。 */
async function refreshOauthTokenBrowser(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false
  const fresh = await refreshBrowserTokenState(env, providerId, cfg, state)
  if (!fresh) return false
  await writeOauthToken(env, providerId, fresh)
  return true
}

/**
 * 对指定的 browser token state 执行刷新，返回新 state（供单 token 与 WorkBuddy 多账号池共用）。
 * 失败返回 null（调用方决定禁用/冷却账号）。
 */
export async function refreshBrowserTokenState(
  env: Env,
  providerId: string,
  cfg: OAuthDeviceConfig,
  state: OAuthTokenState
): Promise<OAuthTokenState | null> {
  if (!state?.refresh_token) return null
  try {
    // 按 token 的 JWT iss 判断域：Global 账号必须用 workbuddy.ai 刷新端点，否则 401
    const realm = detectTokenRealm(state.access_token) === 'global' ? 'global' : 'cn'
    const refreshUrl = browserRefreshUrl(cfg, realm)
    if (!refreshUrl) {
      console.warn(`[oauth-refresh] provider=${providerId} 国际版 token 但未配置 globalRefreshTokenUrl，跳过刷新`)
      return null
    }
    const res = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        ...browserCommonHeaders(cfg, realm),
        'X-Refresh-Token': state.refresh_token,
      },
      body: '',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null

    const env_resp = (await res.json().catch(() => null)) as CodeBuddyEnvelope<CodeBuddyTokenData> | null
    if (!env_resp || env_resp.code !== 0 || !env_resp.data?.accessToken) return null

    const tok = env_resp.data
    return {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken || state.refresh_token,
      expires_at: Date.now() + (tok.expiresIn || 7200) * 1000,
      updated_at: Date.now(),
      // R5：刷新后必须保留/更新 cookie jar——browser 模式上游 API 依赖 cookie 会话
      cookies: res.headers.get('Set-Cookie') || state.cookies,
    }
  } catch {
    return null
  }
}

/**
 * 读取当前可用的 access_token。若缺失则返回 null；若即将过期则先刷新。
 */
export async function getOauthAccessToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<string | null> {
  const state = await readOauthToken(env, providerId)
  if (!state?.access_token) return null

  const soon = state.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS
  if (soon && state.refresh_token) {
    const ok = await refreshOauthToken(env, providerId, cfg)
    if (ok) {
      const fresh = await readOauthToken(env, providerId)
      return fresh?.access_token ?? null
    }
  }
  return Date.now() < state.expires_at ? state.access_token : null
}

/**
 * 供 Cron 定时任务调用：刷新所有已配置 OAuth 提供商中即将过期/已过期的 token。
 */
export async function refreshAllOauthTokens(env: Env, providers: ProviderLike[]): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  for (const p of providers) {
    if (p.authType !== 'oauth-device' || !p.oauth) continue
    const flow = p.oauth.flowType
    // M365：token 存于账号池（oauth:token:{id}:pool）。旧实现只读单 token key，
    // 从不刷新账号池，导致闲置账号 access_token 过期后 refresh_token 被上游撤销。
    // 这里遍历池内每个账号逐个刷新（写回池会重置 30 天 KV TTL，隐藏保活），
    // 刷新失败记录日志告警，便于发现需重新登录的账号。
    if (flow === 'm365-pkce' || flow === 'm365-ropc') {
      const r = await refreshAllM365PoolTokens(env, p)
      ok += r.ok
      fail += r.fail
      continue
    }
    const state = await readOauthToken(env, p.id)
    if (!state?.refresh_token) continue
    if (state.expires_at - Date.now() > 5 * 60 * 1000) continue // 未临近过期，跳过
    const success = await refreshOauthToken(env, p.id, p.oauth)
    if (success) ok++
    else fail++
  }
  return { ok, fail }
}

/**
 * 刷新某 M365 provider 账号池内的账号（Cron 专用，对上游请求更少）：
 * 只刷「临期（expiresAt 临近，需换新 access_token）」或「闲置过久（30 天池 TTL 将到期，需保活重置）」的账号，
 * 避免像原实现那样遍历池内每个账号无条件刷新、对上游请求过多。
 */
async function refreshAllM365PoolTokens(env: Env, p: ProviderLike): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  let infos
  try {
    infos = await getM365AccountInfos(env, p.id)
  } catch {
    return { ok: 0, fail: 0 }
  }
  const now = Date.now()
  // 临期阈值：access_token 过期前 10 分钟刷新（同原版临期刷新语义）
  const NEAR_EXPIRY_MS = 10 * 60 * 1000
  // 闲置阈值：账号超过 20 天未被使用则刷新一次，重置 30 天池 KV TTL 保活
  const IDLE_MS = 20 * 24 * 60 * 60 * 1000
  for (const info of infos) {
    if (!info.connected || !info.oid) continue
    const nearExpiry = typeof info.expiresAt === 'number' && info.expiresAt - now <= NEAR_EXPIRY_MS
    const idle = typeof info.lastUsedAt === 'number' && now - info.lastUsedAt >= IDLE_MS
    if (!nearExpiry && !idle) continue
    const success = await refreshM365Token(env, p.id, p.oauth!, info.oid)
    if (success) {
      ok++
    } else {
      fail++
      console.error(`[oauth] M365 账号刷新失败，可能需要重新登录 provider=${p.id} oid=${info.oid} email=${info.email || '无'} ${new Date().toISOString()}`)
    }
  }
  return { ok, fail }
}

// ProviderLike 避免循环依赖：仅用 OAuth 相关字段
export interface ProviderLike {
  id: string
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
}

// ===== M365 Copilot（flowType=m365-pkce / m365-ropc）=====
// 认证逻辑实现在 src/m365/oauth.ts；此处仅做网关统一出口分发。

export interface M365CallbackSubmitResult {
  success: boolean
  message: string
  email?: string
}

/** 提交 M365 PKCE 授权回调（把浏览器地址栏 URL 粘贴回后台） */
export async function submitOauthM365Callback(
  env: Env,
  providerId: string,
  cfg: OAuthDeviceConfig,
  callbackUrl: string
): Promise<M365CallbackSubmitResult> {
  return submitM365PKCECallback(env, providerId, cfg, callbackUrl)
}

/** M365 ROPC：账号密码直接登录换 token */
export async function submitOauthM365ROPC(
  env: Env,
  providerId: string,
  cfg: OAuthDeviceConfig,
  username: string,
  password: string
): Promise<M365CallbackSubmitResult> {
  return m365ROPC(env, providerId, cfg, username, password)
}
