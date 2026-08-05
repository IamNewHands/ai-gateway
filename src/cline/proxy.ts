/**
 * proxy.ts — Cline 上游转发（移植自 cline2api-workers worker.js）。
 *
 * 核心逻辑：
 *   1. 用 refreshToken（Cline 账号的"长期钥匙"）换 accessToken（内存缓存，过期自动刷新）。
 *   2. 把 OpenAI 请求转发到 https://api.cline.bot/api/v1/chat/completions。
 *   3. SSE 流式响应剥掉上游 {data:{...}} 包装后透传给客户端。
 *
 * 多账号：provider.apiKeys（enabled）里一行一个 refreshToken，
 *   额度用尽(空响应)/刷失败/401 时自动冷却并切换到下一个账号。
 *
 * 可用模型（2026-08 实测，见项目 README）：
 *   poolside/laguna-s-2.1:free 为当前唯一稳定可用（API 免费）；
 *   deepseek/deepseek-v4-flash 与 cline-free/* 被官方锁定(403，仅 Cline 产品界面)；
 *   cline-pass/* 需付费订阅。
 */

import type { Env, Provider } from '../types'
import { updateProvider } from '../storage'

export const CLINE_PROVIDER_ID = 'cline'
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'

export const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free'

/** 实测模型列表（poolside 免费可用；deepseek 已锁；cline-free 锁定；cline-pass 需订阅）。 */
export const CLINE_MODELS: Array<{ id: string; provider: string; cost: string }> = [
  { id: 'poolside/laguna-s-2.1:free', provider: 'poolside', cost: 'free' },
  { id: 'deepseek/deepseek-v4-flash', provider: 'deepseek', cost: 'locked' },
  { id: 'cline-free/glm-5.2', provider: 'zai', cost: 'locked' },
  { id: 'cline-pass/glm-5.2', provider: 'zai', cost: 'pass' },
  { id: 'cline-pass/deepseek-v4-flash', provider: 'deepseek', cost: 'pass' },
  { id: 'cline-pass/qwen3.7-max', provider: 'qwen', cost: 'pass' },
]

export function isClineProvider(providerId: string): boolean {
  return providerId === CLINE_PROVIDER_ID
}

/** 向上游转发超时：LLM 长响应/流式放宽到 5 分钟，避免中途被掐断 */
const CLINE_TIMEOUT_MS = 300000

// ===== 账号池状态（per isolate，按 provider.id 隔离） =====

interface Account {
  refreshToken: string
  accessToken: string | null
  expiry: number
  cooldownUntil: number
}

interface Pool {
  accounts: Account[]
  accountIndex: number
  current: Account | null
}

const pools = new Map<string, Pool>()

function getPool(providerId: string, refreshTokens: string[]): Pool {
  const tokens = refreshTokens
    .map((t) => (t || '').trim())
    .filter((t) => t.length > 8)
  let pool = pools.get(providerId)
  const changed =
    !pool ||
    pool.accounts.length !== tokens.length ||
    pool.accounts.some((a, i) => a.refreshToken !== tokens[i])
  if (changed) {
    pool = {
      accounts: tokens.map((rt) => ({ refreshToken: rt, accessToken: null, expiry: 0, cooldownUntil: 0 })),
      accountIndex: 0,
      current: null,
    }
    pools.set(providerId, pool)
  }
  return pool!
}

/** 由 provider 的启用 apiKeys（即各账号 refreshToken）构造账号池。 */
function poolFromProvider(provider: Provider): Pool {
  const tokens = (provider.apiKeys || []).filter((k) => k.enabled).map((k) => k.key)
  return getPool(provider.id, tokens)
}

async function getAccountToken(account: Account): Promise<string> {
  const now = Date.now()
  if (account.cooldownUntil > now) throw new Error('account_cooldown')
  if (account.accessToken && now < account.expiry) return account.accessToken

  const resp = await fetch(CLINE_API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: account.refreshToken, grantType: 'refresh_token' }),
  })
  if (!resp.ok) {
    account.cooldownUntil = now + 60 * 1000
    throw new Error('refresh_failed')
  }
  const data = (await resp.json()) as { data?: { accessToken?: string; expiresAt?: number | string } }
  const accessToken = data?.data?.accessToken
  if (!accessToken) {
    account.cooldownUntil = now + 60 * 1000
    throw new Error('refresh_no_token')
  }
  account.accessToken = accessToken
  // 过期时间：优先服务端，兜底 10 分钟，留 60 秒余量
  const expiresAt = data?.data?.expiresAt
  let expiry = now + 10 * 60 * 1000
  if (typeof expiresAt === 'number') expiry = expiresAt
  else if (typeof expiresAt === 'string') {
    const t = Date.parse(expiresAt)
    if (!isNaN(t)) expiry = t
  }
  account.expiry = expiry - 60000
  return accessToken
}

/** 轮询选一个可用账号，取到 accessToken。全失败则清冷却重试一次最早的。 */
async function getAccessToken(pool: Pool): Promise<string> {
  if (pool.accounts.length === 0) throw new Error('未配置 Cline RefreshToken')
  for (let attempt = 0; attempt < pool.accounts.length; attempt++) {
    const acc = pool.accounts[attempt % pool.accounts.length]
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue
    pool.current = acc
    try {
      return await getAccountToken(acc)
    } catch {
      continue // 刷新失败也切下个号
    }
  }
  const acc = pool.accounts[0]
  pool.current = acc
  acc.cooldownUntil = 0
  try {
    return await getAccountToken(acc)
  } catch {
    throw new Error('所有账号刷新 token 均失败')
  }
}

async function clineFetch(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  retried = false
): Promise<Response> {
  const token = await getAccessToken(pool)
  const headers = {
    Authorization: 'Bearer workos:' + token,
    'Content-Type': 'application/json',
    'X-Task-ID': sessionId,
  }
  const resp = await fetch(CLINE_API_BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(CLINE_TIMEOUT_MS),
  })
  // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
  if (resp.status === 401 && !retried) {
    if (pool.current) {
      pool.current.cooldownUntil = Date.now() + 60 * 1000
      pool.current.accessToken = null
      pool.current.expiry = 0
    }
    return clineFetch(pool, path, bodyObj, sessionId, true)
  }
  return resp
}

// ===== 并发限流队列：上游免费通道并发 >1 会返回空响应，强制串行 + 间隔 =====

let queueTail: Promise<unknown> = Promise.resolve()
const MIN_GAP_MS = 800

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn)
  queueTail = run.catch(() => {})
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带重试的上游转发：空响应/5xx 自动切换账号 + 指数退避。 */
async function clineFetchWithRetry(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  isStream: boolean,
  maxRetries = 4
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await enqueue(() => clineFetch(pool, path, bodyObj, sessionId))
    let hitEmpty = false
    if (resp.ok && !isStream) {
      const text = await resp.clone().text()
      if (!text.includes('empty response content')) return resp
      hitEmpty = true
    } else if (isStream) {
      // 流式：HTTP 200 直接转发，空流/错误由流式处理器判断
      return resp
    } else if (!(resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504)) {
      // 非 5xx 错误（403/400 等）不重试，直接返回
      return resp
    } else {
      const errText = await resp.clone().text()
      if (!errText.includes('empty response content')) return resp
      hitEmpty = true
    }
    if (hitEmpty) {
      // 额度用完：冷却当前账号，切到下个号
      if (pool.current) {
        pool.current.cooldownUntil = Date.now() + 60 * 1000
        pool.current.accessToken = null
        pool.current.expiry = 0
      }
      const short = 500 + Math.floor(Math.random() * 500)
      await sleep(short)
      continue
    }
    // 指数退避：约 1.5s, 3s, 6s, 12s
    const backoff = Math.min(1500 * Math.pow(2, attempt), 12000)
    await sleep(backoff)
  }
  return enqueue(() => clineFetch(pool, path, bodyObj, sessionId))
}

// ===== 请求体构造 =====

function buildUpstreamBody(
  forwardBody: Record<string, unknown>,
  isStream: boolean,
  sessionId: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: (forwardBody.model as string) || DEFAULT_MODEL,
    max_tokens: Number(forwardBody.max_tokens || forwardBody.max_completion_tokens || 128000),
    session_id: sessionId,
    reasoning_effort: String(forwardBody.reasoning_effort || forwardBody.reasoningEffort || 'high'),
    messages: Array.isArray(forwardBody.messages) ? forwardBody.messages : [],
  }
  if (isStream) body.stream = true
  const passthrough = [
    'temperature', 'top_p', 'tools', 'tool_choice', 'stop',
    'presence_penalty', 'frequency_penalty', 'response_format', 'user', 'n', 'seed',
  ] as const
  for (const k of passthrough) {
    if ((forwardBody as Record<string, unknown>)[k] !== undefined) body[k] = (forwardBody as Record<string, unknown>)[k]
  }
  return body
}

// ===== 响应处理 =====

/** 剥掉上游 {data:{...}} 包装（上游有时包一层 data）。 */
function unwrapData(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && (obj as any).data && typeof (obj as any).data === 'object') {
    const d = (obj as any).data
    if (d.choices || d.id || d.usage) return d
  }
  return obj
}

/** OpenAI SSE 流式透传（剥 data 包装）。 */
function streamSSE(upstream: Response): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim()
            if (payload === '' || payload === '[DONE]') {
              await writer.write(encoder.encode(line + '\n\n'))
              continue
            }
            try {
              const obj = JSON.parse(payload)
              const normalized = unwrapData(obj)
              await writer.write(encoder.encode('data: ' + JSON.stringify(normalized) + '\n\n'))
            } catch {
              await writer.write(encoder.encode(line + '\n'))
            }
          } else {
            await writer.write(encoder.encode(line + '\n'))
          }
        }
      }
    } catch {
      /* 流异常，忽略 */
    } finally {
      try { await writer.close() } catch { /* already closed */ }
    }
  })()
  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// ===== 对外接口 =====

export interface ClineProxyOptions {
  /** 客户端是否要求流式（false 时聚合为非流式 chat.completion） */
  stream?: boolean
}

/**
 * 转发一次 chat 请求到 Cline 上游。
 * 返回 Response：
 *   - stream=true：OpenAI SSE（剥掉 data 包装后的透传）
 *   - stream=false：剥掉 data 包装后的非流式 chat.completion JSON
 */
export async function proxyClineChatRequest(
  _env: unknown,
  provider: Provider,
  forwardBody: Record<string, unknown>,
  opts?: ClineProxyOptions
): Promise<Response> {
  const pool = poolFromProvider(provider)
  const wantStream = opts ? !!opts.stream : forwardBody.stream === true
  const sessionId = 'sess_' + Date.now()
  const body = buildUpstreamBody(forwardBody, wantStream, sessionId)
  try {
    const resp = await clineFetchWithRetry(pool, '/chat/completions', body, sessionId, wantStream)
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return jsonResponse(
        { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
        resp.status || 502
      )
    }
    if (wantStream) return streamSSE(resp)
    const raw = await resp.json().catch(() => ({}))
    return jsonResponse(unwrapData(raw), 200)
  } catch (err) {
    return jsonResponse({ error: { message: (err as Error).message || 'Cline 转发失败', type: 'api_error' } }, 500)
  }
}

/** 返回 Cline 实测可用模型列表（普通 JSON，供管理面板拉取模型）。 */
export function fetchClineModels(): { ok: true; message: string; models: Array<{ id: string }> } {
  return {
    ok: true,
    message: 'success',
    models: CLINE_MODELS.map((m) => ({ id: m.id })),
  }
}

/** 校验单个 refreshToken 是否能换取 accessToken（管理面板"测试"用）。 */
export async function testClineRefreshToken(refreshToken: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const acc: Account = { refreshToken: refreshToken.trim(), accessToken: null, expiry: 0, cooldownUntil: 0 }
  try {
    await getAccountToken(acc)
    return { success: true, message: 'RefreshToken 有效' }
  } catch (err) {
    return { success: false, message: (err as Error).message || 'RefreshToken 无效' }
  }
}

/** 用给定账号池发送一个最小 chat 请求来测试模型可用性。 */
export async function testClineChat(
  refreshTokens: string[],
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const pool = getPool('__cline_test__', refreshTokens)
  const sessionId = 'sess_test_' + Date.now()
  try {
    const resp = await clineFetchWithRetry(
      pool,
      '/chat/completions',
      { model: modelId || DEFAULT_MODEL, max_tokens: 1, session_id: sessionId, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }], stream: false },
      sessionId,
      false,
      1
    )
    if (resp.ok) return { success: true, statusCode: resp.status, message: '' }
    const t = await resp.text().catch(() => '').then((s) => s.slice(0, 300))
    // 官方锁定模型（仅 Cline 产品界面可用）与需订阅模型的 403，给出更明确的提示
    if (resp.status === 403 && /only available via Cline product surfaces|not available/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型已被 Cline 官方锁定（仅 Cline 产品界面可用），请改用 poolside/laguna-s-2.1:free' }
    }
    if (resp.status === 403 && /cline-pass/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型需要付费订阅 cline-pass 才能使用' }
    }
    return { success: false, statusCode: resp.status, message: `HTTP ${resp.status}: ${t}` }
  } catch (err) {
    return { success: false, message: (err as Error).message || '测试失败' }
  }
}

// ===== 一键授权（WorkOS 设备码流程，与原项目 cline_oauth.py 一致） =====
//
// 流程（逆向自 cline2api/auth.go 和 cline_oauth.py）：
//   1. POST api.workos.com/user_management/authorize/device（表单 client_id）
//      → 返回 device_code + user_code + 授权链接
//   2. 用户在浏览器打开链接，用 Google/GitHub/邮箱登录授权（即注册的 Cline 账号）
//   3. 轮询 POST api.workos.com/user_management/authenticate
//      → 授权成功后拿 WorkOS access_token + refresh_token
//   4. POST api.cline.bot/api/v1/auth/register（{accessToken, refreshToken}）
//      → 返回值 data.refreshToken 即 Cline 账号的"长期钥匙"
//   5. 把 refreshToken 追加进该提供商的 apiKeys（启用），完成接入

export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
const CLINE_WORKOS_DEVICE = 'https://api.workos.com/user_management/authorize/device'
const CLINE_WORKOS_AUTH = 'https://api.workos.com/user_management/authenticate'
const CLINE_REGISTER = 'https://api.cline.bot/api/v1/auth/register'
const CLINE_DEVICE_TTL_SEC = 900 // 设备码 15 分钟有效，到期自清理

const clineDeviceKey = (providerId: string) => 'cline:device:' + providerId

interface ClineDeviceState {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_at: number
}

export interface StartClineOAuthResult {
  success: boolean
  message: string
  device?: { user_code: string; verification_uri: string; interval: number; expires_at: number }
}

/** 发起 Cline 一键授权，生成 WorkOS 设备码与授权链接。 */
export async function startClineOAuth(env: Env, providerId: string): Promise<StartClineOAuthResult> {
  try {
    const body = new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID })
    const res = await fetch(CLINE_WORKOS_DEVICE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `申请设备码失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }
    const data = (await res.json()) as {
      device_code?: string
      user_code?: string
      verification_uri_complete?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }
    if (!data.device_code || !data.user_code) {
      return { success: false, message: 'WorkOS 设备码接口返回格式异常' }
    }
    const state: ClineDeviceState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri_complete || data.verification_uri || '',
      interval: Math.max(data.interval || 5, 5),
      expires_at: Date.now() + (data.expires_in || 300) * 1000,
    }
    await env.KV.put(clineDeviceKey(providerId), JSON.stringify(state), { expirationTtl: CLINE_DEVICE_TTL_SEC })
    return {
      success: true,
      message: '设备码已生成',
      device: {
        user_code: state.user_code,
        verification_uri: state.verification_uri,
        interval: state.interval,
        expires_at: state.expires_at,
      },
    }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

export type ClineOAuthPollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string; refreshToken: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/** 轮询 WorkOS 授权结果；授权成功后调 register 换 Cline refreshToken 并存入账号池。 */
export async function pollClineOAuth(env: Env, provider: Provider): Promise<ClineOAuthPollResult> {
  const raw = await env.KV.get(clineDeviceKey(provider.id))
  if (!raw) return { status: 'error', message: '没有进行中的登录流程，请重新发起' }
  let state: ClineDeviceState
  try { state = JSON.parse(raw) as ClineDeviceState } catch {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'error', message: '设备码数据异常，请重新发起' }
  }
  if (Date.now() > state.expires_at) {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'failed', message: '设备码已过期，请重新发起' }
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: state.device_code,
      client_id: CLINE_WORKOS_CLIENT_ID,
    })
    const res = await fetch(CLINE_WORKOS_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const errorData = (await res.json().catch(() => ({ error: 'unknown' }))) as { error?: string; error_description?: string }
      switch (errorData.error) {
        case 'authorization_pending':
          return { status: 'pending', message: '等待用户授权…' }
        case 'slow_down':
          return { status: 'pending', message: '轮询过快，请稍候重试' }
        case 'expired_token':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '设备码已过期，请重新发起' }
        case 'access_denied':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '用户拒绝了授权' }
        default:
          return { status: 'error', message: `轮询异常: ${errorData.error_description || errorData.error || res.status}` }
      }
    }

    const workos = (await res.json()) as { access_token?: string; refresh_token?: string }
    if (!workos.access_token) return { status: 'error', message: '轮询接口返回异常：缺少 access_token' }

    // 用 WorkOS token 在 Cline 注册，换 Cline refreshToken
    const regRes = await fetch(CLINE_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: workos.access_token, refreshToken: workos.refresh_token || '' }),
      signal: AbortSignal.timeout(20000),
    })
    const regData = (await regRes.json().catch(() => ({}))) as { data?: { refreshToken?: string } }
    const clineRefreshToken = regData?.data?.refreshToken
    if (!clineRefreshToken) {
      return { status: 'error', message: 'Cline 注册失败，未获取到 refreshToken，请重试（可能需要稍后清理重发）' }
    }

    // 存入账号池（enabled 去重追加）
    const apiKeys = [...(provider.apiKeys || [])]
    if (!apiKeys.some((k) => k.key === clineRefreshToken)) {
      apiKeys.push({ key: clineRefreshToken, enabled: true })
      await updateProvider(env, provider.id, { apiKeys })
    }

    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'success', message: '授权成功，已添加 Cline 账号', refreshToken: clineRefreshToken }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}