import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import type { Env, OAuthDeviceConfig, OAuthTokenState, DeviceFlowState } from './types'

// ===== KV 读写 =====

const deviceKey = (providerId: string) => KV_KEYS.OAUTH_DEVICE_PREFIX + providerId
const tokenKey = (providerId: string) => KV_KEYS.OAUTH_TOKEN_PREFIX + providerId

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.KV.get(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export async function readOauthToken(env: Env, providerId: string): Promise<OAuthTokenState | null> {
  return readJson<OAuthTokenState>(env, tokenKey(providerId))
}

async function writeOauthToken(env: Env, providerId: string, state: OAuthTokenState): Promise<void> {
  // token 有效期最长 30 天，KV 到期自清理（避免残留）
  const ttlSeconds = Math.min(Math.max(Math.floor((state.expires_at - Date.now()) / 1000), 60), 86400 * 30)
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
  const headers: Record<string, string> = {
    'Content-Type': opts?.contentType ?? 'application/json',
    'Accept': 'application/json',
    [tokenHeader]: prefix + token,
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
  if (cfg.flowType === 'browser') {
    return startOauthBrowserFlow(env, providerId, cfg)
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
  if (flowType === 'browser') {
    return pollOauthBrowserFlow(env, providerId, cfg, device)
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

/** 构造 browser 模式的公共请求头 */
function browserCommonHeaders(cfg: OAuthDeviceConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    ...cfg.extraHeaders,
  }
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
    const res = await fetch(cfg.deviceCodeUrl, {
      method: 'POST',
      headers: browserCommonHeaders(cfg),
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
    const { state, authUrl } = env_resp.data
    const device: DeviceFlowState = {
      device_code: state,        // browser 模式下 device_code 字段存 state
      user_code: '',             // browser 模式无用户码
      verification_uri: authUrl, // 存登录页 URL
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 5 * 60 * 1000, // 5 分钟超时（参考插件 loginTTL）
      flowType: 'browser',
      cookies: setCookie || undefined,
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
    const sep = cfg.deviceTokenUrl.includes('?') ? '&' : '?'
    const pollUrl = `${cfg.deviceTokenUrl}${sep}state=${encodeURIComponent(state)}`
    const pollHeaders: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...cfg.extraHeaders,
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
    await writeOauthToken(env, providerId, {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken,
      expires_at: Date.now() + expiresInSec * 1000,
      updated_at: Date.now(),
      cookies: newCookies,
    })
    await env.KV.delete(deviceKey(providerId))
    return { status: 'success', message: 'OAuth 连接成功' }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

// ===== Token 刷新 =====

/**
 * 使用 refresh_token 刷新 access_token。根据 flowType 分发。
 */
export async function refreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  if (cfg.flowType === 'browser') {
    return refreshOauthTokenBrowser(env, providerId, cfg)
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

/** 浏览器登录模式的 token 刷新（POST header X-Refresh-Token） */
async function refreshOauthTokenBrowser(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false

  try {
    const res = await fetch(cfg.refreshTokenUrl, {
      method: 'POST',
      headers: {
        ...browserCommonHeaders(cfg),
        'X-Refresh-Token': state.refresh_token,
      },
      body: '',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return false

    const env_resp = (await res.json().catch(() => null)) as CodeBuddyEnvelope<CodeBuddyTokenData> | null
    if (!env_resp || env_resp.code !== 0 || !env_resp.data?.accessToken) return false

    const tok = env_resp.data
    await writeOauthToken(env, providerId, {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken || state.refresh_token,
      expires_at: Date.now() + (tok.expiresIn || 7200) * 1000,
      updated_at: Date.now(),
    })
    return true
  } catch {
    return false
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
    const state = await readOauthToken(env, p.id)
    if (!state?.refresh_token) continue
    if (state.expires_at - Date.now() > 5 * 60 * 1000) continue // 未临近过期，跳过
    const success = await refreshOauthToken(env, p.id, p.oauth)
    if (success) ok++
    else fail++
  }
  return { ok, fail }
}

// ProviderLike 避免循环依赖：仅用 OAuth 相关字段
export interface ProviderLike {
  id: string
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
}
