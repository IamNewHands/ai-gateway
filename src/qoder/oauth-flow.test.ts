import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeQoderPKCE, startOauthQoderFlow, pollOauthQoderFlow, qoderExpiryUnix } from '../oauth'
import { KV_KEYS } from '../config'
import type { Env, OAuthDeviceConfig, DeviceFlowState } from '../types'

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
    refreshTokenUrl: 'https://openapi.qoder.com.cn/api/v1/refreshToken',
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

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('makeQoderPKCE（对齐 keirouter：32 字节 base64url verifier + S256 challenge）', () => {
  it('verifier 是 base64url 无填充；challenge = S256(verifier) 的 base64url', async () => {
    const { verifier, challenge } = await makeQoderPKCE()
    // base64url 字符集
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 字节 → base64 长度 43（无填充），接近 43 或 44
    expect(verifier.length).toBe(43)
    // challenge 长度：sha256(base64url verifier) → 43
    expect(challenge.length).toBe(43)
    expect(challenge).not.toContain('+')
    expect(challenge).not.toContain('/')
    expect(challenge).not.toContain('=')
    // 校验 challenge 确实 = base64url(sha256(verifier))
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const db = new Uint8Array(digest)
    let bin = ''
    for (const b of db) bin += String.fromCharCode(b)
    const expectChallenge = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expectChallenge)
  })

  it('两次生成的 verifier 不同（随机性）', async () => {
    const a = await makeQoderPKCE()
    const b = await makeQoderPKCE()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('startOauthQoderFlow（登录 URL 参数与双域分域）', () => {
  it('默认 CN 域：授权链接为 qoder.com.cn，仅携带 challenge/challenge_method/machine_id/nonce', async () => {
    const { env, store } = makeKV()
    const res = await startOauthQoderFlow(env, 'q', cfg({ loginRealm: 'cn' }))
    expect(res.success).toBe(true)
    const url = new URL(res.device!.verification_uri)
    expect(url.origin).toBe('https://qoder.com.cn')
    expect(url.pathname).toBe('/device/selectAccounts')
    expect([...url.searchParams.keys()].sort()).toEqual(['challenge', 'challenge_method', 'machine_id', 'nonce'].sort())
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBeNull()
    expect(url.searchParams.get('redirect_uri')).toBeNull()
    expect(url.searchParams.get('verifier')).toBeNull()
    // device 状态固化了 machine_id 与后面参数一致
    expect(res.device!.machine_id).toBe(url.searchParams.get('machine_id'))
    // 持久化到 KV
    expect(store.get(KV_KEYS.OAUTH_DEVICE_PREFIX + 'q')).toBe(JSON.stringify(res.device))
  })

  it('global 域：授权链接为 qoder.com', async () => {
    const { env } = makeKV()
    const res = await startOauthQoderFlow(env, 'q', cfg({ loginRealm: 'global' }))
    expect(res.success).toBe(true)
    const url = new URL(res.device!.verification_uri)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.searchParams.get('machine_id')).toBe(res.device!.machine_id)
  })

  it('start 写 device 含 machine_id 字段（DeviceFlowState 已含该字段）', async () => {
    const { env, store } = makeKV()
    await startOauthQoderFlow(env, 'q', cfg({ loginRealm: 'cn' }))
    const saved = JSON.parse(store.get(KV_KEYS.OAUTH_DEVICE_PREFIX + 'q')!)
    expect(typeof saved.machine_id).toBe('string')
    expect(saved.machine_id.length).toBeGreaterThan(0)
  })
})

describe('pollOauthQoderFlow（对齐 keirouter QoderPollToken 行为）', () => {
  it('202 = 等待授权（pending）', async () => {
    mockFetchOnce(202, {})
    const { env } = makeKV()
    const res = await pollOauthQoderFlow(env, 'q', cfg(), vdevice())
    expect(res.status).toBe('pending')
  })

  it('404 = 等待授权（pending）', async () => {
    mockFetchOnce(404, {})
    const { env } = makeKV()
    const res = await pollOauthQoderFlow(env, 'q', cfg(), vdevice())
    expect(res.status).toBe('pending')
  })

  it('200 但 token 为空 = error（对齐 keirouter "poll returned 200 but no token"）', async () => {
    mockFetchOnce(200, { refresh_token: 'drt-xx' })
    const { env } = makeKV()
    const res = await pollOauthQoderFlow(env, 'q', cfg(), vdevice())
    expect(res.status).toBe('error')
    expect(res.message).toContain('no token')
  })

  it('200 且 token 非空 = success，并把 token 写入 KV + 池', async () => {
    mockFetchOnce(200, { token: 'dt-abc', refresh_token: 'drt-abc', user_id: 'u-1', expires_in: 2592000 })
    const { env, store } = makeKV()
    const res = await pollOauthQoderFlow(env, 'q', cfg(), vdevice())
    expect(res.status).toBe('success')
    expect(store.get(KV_KEYS.OAUTH_DEVICE_PREFIX + 'q')).toBeUndefined()
    const savedToken = JSON.parse(store.get(KV_KEYS.OAUTH_TOKEN_PREFIX + 'q')!)
    expect(savedToken.access_token).toBe('dt-abc')
    // 池内 upsert
    const pool = JSON.parse(store.get(KV_KEYS.QODER_POOL_PREFIX + 'q')!)
    expect(pool[0].uid).toBe('u-1')
  })

  it('200 但 JSON 解析失败 = error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const { env } = makeKV()
    const res = await pollOauthQoderFlow(env, 'q', cfg(), vdevice())
    expect(res.status).toBe('error')
  })
})

describe('t5 与 t3 衔接：poll 成功后的过期时间）,', () => {
  it('expires_in 以秒计（2592000s → now + 2592000*1000ms）', () => {
    const before = Date.now()
    const e = qoderExpiryUnix({ expires_in: 2592000 })
    expect(e - before).toBeGreaterThanOrEqual(2592000 * 1000)
    expect(e - before).toBeLessThan(2592000 * 1000 + 5)
  })
})