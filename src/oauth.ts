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
  // token 有效期最长 1 年，KV 到期自清理（避免残留）
  const ttlSeconds = Math.min(Math.max(Math.floor((state.expires_at - Date.now()) / 1000), 60), 86400 * 30)
  await env.KV.put(tokenKey(providerId), JSON.stringify(state), { expirationTtl: ttlSeconds })
}

export async function deleteOauthToken(env: Env, providerId: string): Promise<void> {
  await env.KV.delete(tokenKey(providerId))
}

// ===== 设备码流程（RFC 8628） =====

export interface DeviceFlowResult {
  success: boolean
  message: string
  device?: DeviceFlowState
}

/**
 * 发起设备码申请，返回用户在浏览器打开的授权信息（verification_uri + user_code）。
 * 流程状态以 providerId 为 key 存入 KV，供轮询阶段使用。
 */
export async function startOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
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
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '设备码已生成', device }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

export type PollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/**
 * 轮询设备码授权结果。成功时将 access_token 存入 KV。
 */
export async function pollOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<PollResult> {
  const device = await readJson<DeviceFlowState>(env, deviceKey(providerId))
  if (!device) return { status: 'error', message: '没有进行中的设备码流程，请重新发起' }
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

// ===== Token 刷新 =====

/**
 * 使用 refresh_token 刷新 access_token。成功返回 true 并写回 KV。
 */
export async function refreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
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
