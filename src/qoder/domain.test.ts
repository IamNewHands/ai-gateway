import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { qoderChatUrl, qoderModelsUrl } from './proxy'
import { pollOauthQoderFlow, refreshQoderTokenPair } from '../oauth'
import type { Env, OAuthDeviceConfig, DeviceFlowState, OAuthTokenState } from '../types'

function makeKV(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}))
  const KV = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV } as unknown as Env, store }
}

function cfg(over: Partial<OAuthDeviceConfig> = {}): OAuthDeviceConfig {
  return {
    flowType: 'qoder',
    deviceTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
    refreshTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh',
    pollInterval: 5,
    ...over,
  }
}

function vdevice(over: Partial<DeviceFlowState> = {}): DeviceFlowState {
  return {
    device_code: '',
    user_code: '',
    verification_uri: 'https://qoder.com.cn/device/selectAccounts?x=1',
    interval: 5,
    expires_at: Date.now() + 600000,
    flowType: 'qoder',
    verifier: 'verifier-test-0123456789abcdef',
    nonce: 'nonce-1234',
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.restoreAllMocks()
})

// ===== 推理/模型端点：CN=gateway.qoder.com.cn，INT(global)=api3.qoder.sh（keirouter ChatURLEncoded/ModelListURL） =====
describe('qoderChatUrl / qoderModelsUrl（按域分端点，含 Encode=1）', () => {
  it('CN 域 chat 端点 → gateway.qoder.com.cn 且带 Encode=1', () => {
    const url = qoderChatUrl('cn')
    expect(url.startsWith('https://gateway.qoder.com.cn')).toBe(true)
    expect(url).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation')
    expect(url).toContain('Encode=1')
  })
  it('global 域 chat 端点 → api3.qoder.sh（keirouter ChatURLEncoded）', () => {
    const url = qoderChatUrl('global')
    expect(url.startsWith('https://api3.qoder.sh')).toBe(true)
    expect(url).toContain('Encode=1')
  })
  it('CN 域模型端点 → gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1', () => {
    expect(qoderModelsUrl('cn')).toBe('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1')
  })
  it('global 域模型端点 → api3.qoder.sh/algo/api/v2/model/list?Encode=1（keirouter ModelListURL）', () => {
    expect(qoderModelsUrl('global')).toBe('https://api3.qoder.sh/algo/api/v2/model/list?Encode=1')
  })
})

// ===== poll/refresh 按登录域选端点 =====
describe('Qoder OAuth 域路由（poll/refresh）', () => {
  it('poll 缺省走 CN 轮询端点 openapi.qoder.com.cn', async () => {
    const { env } = makeKV()
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ token: 'dt-1', refresh_token: 'drt-1', user_id: 'u1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)
    const r = await pollOauthQoderFlow(env, 'qoder', cfg(), vdevice())
    expect(r.status).toBe('success')
    const called = String(fetchMock.mock.calls[0][0])
    expect(called.startsWith('https://openapi.qoder.com.cn/api/v1/deviceToken/poll?')).toBe(true)
  })

  it('poll 按 device.loginRealm=global 走 global 轮询端点 openapi.qoder.sh', async () => {
    const { env } = makeKV()
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ token: 'dt-1', refresh_token: 'drt-1', user_id: 'u1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)
    const c = cfg({
      loginRealm: 'global',
      globalDeviceTokenUrl: 'https://openapi.qoder.sh/api/v1/deviceToken/poll',
      globalRefreshTokenUrl: 'https://openapi.qoder.sh/api/v1/deviceToken/refresh',
    })
    const r = await pollOauthQoderFlow(env, 'qoder', c, vdevice({ loginRealm: 'global' }))
    expect(r.status).toBe('success')
    const called = String(fetchMock.mock.calls[0][0])
    expect(called.startsWith('https://openapi.qoder.sh/api/v1/deviceToken/poll?')).toBe(true)
    // 成功登录写入的 token/池账号带 realm=global，供后续推理路由
    expect((fetchMock.mock.calls).length).toBe(1)
  })

  it('refresh 按 prev.realm=global 走 global 刷新端点 openapi.qoder.sh', async () => {
    const c = cfg({ globalRefreshTokenUrl: 'https://openapi.qoder.sh/api/v1/deviceToken/refresh' })
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ token: 'dt-2', refresh_token: 'drt-2' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)
    const prev: OAuthTokenState = { access_token: 'old', refresh_token: 'old-drt', expires_at: 0, updated_at: 0, user_id: 'u1', realm: 'global' }
    const fresh = await refreshQoderTokenPair(c, 'old-drt', prev)
    expect(fresh).not.toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
    expect(fresh!.realm).toBe('global')
  })

  it('refresh 缺省走 CN 刷新端点 openapi.qoder.com.cn', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ token: 'dt-3', refresh_token: 'drt-3' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)
    const prev: OAuthTokenState = { access_token: 'old', refresh_token: 'old-drt', expires_at: 0, updated_at: 0, user_id: 'u1' }
    const fresh = await refreshQoderTokenPair(cfg(), 'old-drt', prev)
    expect(fresh).not.toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openapi.qoder.com.cn/api/v1/deviceToken/refresh')
    expect(fresh!.realm).toBe('cn')
  })
})