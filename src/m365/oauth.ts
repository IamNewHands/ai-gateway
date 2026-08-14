/**
 * M365 Copilot 账号认证（移植自 M365-Copilot2API internal/auth/*）。
 *
 * 支持两种授权方式（provider.oauth.flowType）：
 * - m365-pkce：标准授权码 + PKCE(S256)（推荐）。网关无法监听本地回调端口，
 *   用户在浏览器完成授权后把回调 URL（含 code）粘贴回后台完成换 token（同 gemini 模式）。
 * - m365-ropc：资源所有者密码凭据（企业订阅账号，需账号密码直接换 token）。
 *
 * token 存储复用现有 KV key（oauth:token:{providerId}，OAuthTokenState），
 * 附带 oid/tid/email（从 access_token JWT 解出），供 ChatHub 建立 WS 使用。
 */
import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from '../config'
import type { Env, OAuthDeviceConfig, OAuthTokenState, DeviceFlowState } from '../types'

/** M365 Copilot 商业版 OAuth 端点（与官方桌面客户端一致） */
export const M365_OAUTH = {
  clientId: 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1',
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
  scope: 'openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite',
}

export interface M365Account {
  accessToken: string
  refreshToken?: string
  oid: string
  tid: string
  email?: string
  displayName?: string
  expiresAt: number
}

function tokenKey(providerId: string): string {
  return KV_KEYS.OAUTH_TOKEN_PREFIX + providerId
}
function deviceKey(providerId: string): string {
  return KV_KEYS.OAUTH_DEVICE_PREFIX + providerId
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.KV.get(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

async function writeToken(env: Env, providerId: string, state: OAuthTokenState): Promise<void> {
  const ttlSeconds = state.refresh_token
    ? 86400 * 30
    : Math.min(Math.max(Math.ceil((state.expires_at - Date.now()) / 1000), 60), 86400 * 30)
  await env.KV.put(tokenKey(providerId), JSON.stringify(state), { expirationTtl: ttlSeconds })
}

/** 解析 JWT 载荷（不校验签名，仅读取账号标识字段） */
function decodeJWTClaims(token: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const parts = token.split('.')
    if (parts.length < 2) return out
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string') out[k] = v
    }
  } catch { /* ignore */ }
  return out
}

function buildTokenState(data: { access_token: string; refresh_token?: string; expires_in?: number }): OAuthTokenState {
  const claims = decodeJWTClaims(data.access_token)
  const email = firstNonEmpty(claims['email'], claims['unique_name'], claims['upn'], claims['preferred_username'])
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    updated_at: Date.now(),
    email: email || undefined,
    // M365 特有：ChatHub WS 需要 oid/tid
    oid: claims['oid'] || claims['sub'] || undefined,
    tid: claims['tid'] || claims['tenant_id'] || undefined,
    nickname: firstNonEmpty(claims['name'], email) || undefined,
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (v && v.trim() !== '') return v.trim()
  }
  return ''
}

function m365ClientConfig(cfg: OAuthDeviceConfig): { clientId: string; authority?: string; scope: string; redirectUri: string } {
  return {
    clientId: cfg.clientId || M365_OAUTH.clientId,
    authority: cfg.deviceCodeUrl, // 授权端点（authorize）；留空用默认
    scope: cfg.scope || M365_OAUTH.scope,
    redirectUri: cfg.redirectUri || M365_OAUTH.redirectUri,
  }
}

async function makePKCE(): Promise<{ verifier: string; challenge: string }> {
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

function randomState(): string {
  const raw = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ===== PKCE 授权码流程 =====

export interface M365AuthStartResult {
  success: boolean
  message: string
  authUrl?: string
}

/** 发起 PKCE 授权：生成授权链接，保存 verifier/state 到 KV */
export async function startM365PKCE(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<M365AuthStartResult> {
  try {
    const conf = m365ClientConfig(cfg)
    const { verifier, challenge } = await makePKCE()
    const state = randomState()
    const params = new URLSearchParams({
      client_id: conf.clientId,
      redirect_uri: conf.redirectUri,
      response_type: 'code',
      scope: conf.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    const authUrl = `${conf.authority || M365_OAUTH.authorizeUrl}?${params.toString()}`

    const device: DeviceFlowState = {
      device_code: state,
      user_code: '',
      verification_uri: authUrl,
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 10 * 60 * 1000,
      flowType: 'm365-pkce',
      verifier,
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '授权链接已生成', authUrl }
  } catch (err) {
    return { success: false, message: `发起授权异常: ${(err as Error).message || '未知错误'}` }
  }
}

export interface M365CallbackResult {
  success: boolean
  message: string
  email?: string
}

/**
 * 提交 M365 授权回调：解析回调 URL 中的 code/state → 校验 state →
 * code 换 token（PKCE）→ 从 JWT 提取 oid/tid/email → 写入 KV。
 */
export async function submitM365PKCECallback(env: Env, providerId: string, cfg: OAuthDeviceConfig, callbackUrl: string): Promise<M365CallbackResult> {
  const device = await readJson<DeviceFlowState>(env, deviceKey(providerId))
  if (!device || device.flowType !== 'm365-pkce') {
    return { success: false, message: '没有进行中的 M365 授权流程，请先点击「发起连接」' }
  }
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { success: false, message: '授权流程已超时（10 分钟），请重新发起' }
  }

  const parsed = parseCallbackUrl(callbackUrl)
  if (!parsed) {
    return { success: false, message: '无法从回调 URL 解析出 code，请核对粘贴内容（应包含 ?code=...）' }
  }
  if (parsed.error) {
    return { success: false, message: `授权被拒绝：${parsed.error}` }
  }
  if (!parsed.state || parsed.state !== device.device_code) {
    return { success: false, message: 'OAuth state 校验失败，请确认粘贴的是本次发起的授权回调 URL' }
  }

  try {
    const conf = m365ClientConfig(cfg)
    const params = new URLSearchParams({
      client_id: conf.clientId,
      code: parsed.code,
      grant_type: 'authorization_code',
      redirect_uri: conf.redirectUri,
      code_verifier: device.verifier || '',
    })
    const res = await fetch(conf.authority ? M365_OAUTH.tokenUrl : M365_OAUTH.tokenUrl, {
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
    const state = buildTokenState(data)
    if (!state.oid || !state.tid) {
      return { success: false, message: 'token 中缺少 oid/tid（可能非 M365 Copilot 订阅账号）' }
    }
    await writeToken(env, providerId, state)
    await env.KV.delete(deviceKey(providerId))
    return { success: true, message: 'M365 授权成功' + (state.email ? `（${state.email}）` : ''), email: state.email }
  } catch (err) {
    return { success: false, message: `换 token 异常: ${(err as Error).message || '未知错误'}` }
  }
}

interface CallbackPayload {
  code: string
  state: string
  error: string
}

function parseCallbackUrl(input: string): CallbackPayload | null {
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
  if (!code && !error) return null
  return { code, state, error }
}

// ===== ROPC 账号密码流程 =====

export interface M365ROPCResult {
  success: boolean
  message: string
  email?: string
}

/** ROPC：直接用账号密码换 token（企业订阅账号） */
export async function m365ROPC(env: Env, providerId: string, cfg: OAuthDeviceConfig, username: string, password: string): Promise<M365ROPCResult> {
  if (!username || !password) {
    return { success: false, message: '请输入账号与密码' }
  }
  try {
    const conf = m365ClientConfig(cfg)
    const params = new URLSearchParams({
      client_id: conf.clientId,
      grant_type: 'password',
      username,
      password,
      scope: conf.scope,
    })
    const res = await fetch(M365_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try {
        const e = JSON.parse(text) as { error?: string; error_description?: string }
        errMsg = `${e.error || errMsg}: ${e.error_description || ''}`
      } catch { /* keep */ }
      return { success: false, message: `登录失败 ${errMsg}` }
    }
    const data = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) {
      return { success: false, message: '登录响应缺少 access_token' }
    }
    const state = buildTokenState(data)
    await writeToken(env, providerId, state)
    return { success: true, message: 'M365 登录成功' + (state.email ? `（${state.email}）` : ''), email: state.email }
  } catch (err) {
    return { success: false, message: `登录异常: ${(err as Error).message || '未知错误'}` }
  }
}

// ===== token 刷新 =====

const refreshInflight = new Map<string, Promise<boolean>>()

export function refreshM365Token(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const existing = refreshInflight.get(providerId)
  if (existing) return existing
  const task = doRefreshM365Token(env, providerId, cfg).finally(() => {
    refreshInflight.delete(providerId)
  })
  refreshInflight.set(providerId, task)
  return task
}

async function doRefreshM365Token(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readJson<OAuthTokenState>(env, tokenKey(providerId))
  if (!state?.refresh_token) return false
  try {
    const conf = m365ClientConfig(cfg)
    const params = new URLSearchParams({
      client_id: conf.clientId,
      refresh_token: state.refresh_token,
      grant_type: 'refresh_token',
      scope: conf.scope,
    })
    const res = await fetch(M365_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) return false
    const fresh = buildTokenState(data)
    // 刷新响应一般不带账号信息，保留原值
    await writeToken(env, providerId, {
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token || state.refresh_token,
      expires_at: fresh.expires_at,
      updated_at: Date.now(),
      oid: state.oid || fresh.oid,
      tid: state.tid || fresh.tid,
      email: state.email || fresh.email,
      nickname: state.nickname || fresh.nickname,
    })
    return true
  } catch {
    return false
  }
}

// ===== 账号读取（供 ChatHub 调用） =====

/**
 * 读取 M365 账号：返回可用的 access_token + oid/tid。
 * 临近过期自动刷新；无 token 或刷新失败返回 null。
 */
export async function getM365Account(env: Env, providerId: string): Promise<M365Account | null> {
  const state = await readJson<OAuthTokenState>(env, tokenKey(providerId))
  if (!state?.access_token) return null

  let accessToken = state.access_token
  let expiresAt = state.expires_at
  if (state.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS && state.refresh_token) {
    const ok = await refreshM365Token(env, providerId, {} as OAuthDeviceConfig)
    if (ok) {
      const fresh = await readJson<OAuthTokenState>(env, tokenKey(providerId))
      if (fresh?.access_token) {
        accessToken = fresh.access_token
        expiresAt = fresh.expires_at
      }
    }
  }
  if (Date.now() >= expiresAt) return null
  if (!state.oid || !state.tid) {
    const claims = decodeJWTClaims(accessToken)
    if (claims['oid'] || claims['tid']) {
      // 动态补全 oid/tid 并回写
      const enriched = {
        ...state,
        oid: state.oid || claims['oid'] || claims['sub'],
        tid: state.tid || claims['tid'] || claims['tenant_id'],
        access_token: accessToken,
      }
      await writeToken(env, providerId, enriched as OAuthTokenState)
      return {
        accessToken,
        refreshToken: enriched.refresh_token,
        oid: String(enriched.oid || ''),
        tid: String(enriched.tid || ''),
        email: enriched.email,
        displayName: enriched.nickname,
        expiresAt,
      }
    }
  }
  return {
    accessToken,
    refreshToken: state.refresh_token,
    oid: String(state.oid || ''),
    tid: String(state.tid || ''),
    email: state.email,
    displayName: state.nickname,
    expiresAt,
  }
}

/** 管理后台展示用：读取账号概要 */
export async function getM365AccountInfo(env: Env, providerId: string): Promise<{ connected: boolean; email?: string; oid?: string; tid?: string; expiresAt?: number } | null> {
  const state = await readJson<OAuthTokenState>(env, tokenKey(providerId))
  if (!state) return null
  return {
    connected: !!state.access_token,
    email: state.email,
    oid: state.oid,
    tid: state.tid,
    expiresAt: state.expires_at,
  }
}

/** 断开 M365 授权 */
export async function deleteM365Account(env: Env, providerId: string): Promise<void> {
  await env.KV.delete(tokenKey(providerId))
}