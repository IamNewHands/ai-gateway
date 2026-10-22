import { describe, it, expect, beforeEach, vi } from 'vitest'
import gateway from './index'
import { clearCache } from './storage'
import type { Env, Provider } from './types'

const SESSION_ID = 'sess-admin-wb-test'

function makeJwt(realm: 'global' | 'cn'): string {
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const iss = realm === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  return `${b64url({ alg: 'HS256' })}.${b64url({ iss, uid: 'u1' })}.sig`
}

function makeEnv(providers: Provider[]): { env: Env } {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(providers))
  store.set(`admin:session:${SESSION_ID}`, JSON.stringify({ username: 'admin', expiresAt: Date.now() + 600_000 }))
  store.set('oauth:token:workbuddy', JSON.stringify({
    access_token: makeJwt('global'),
    refresh_token: 'rt-1',
    expires_at: Date.now() + 3600_000,
  }))
  store.set('oauth:token:other-oauth', JSON.stringify({
    access_token: makeJwt('cn'),
    refresh_token: 'rt-2',
    expires_at: Date.now() + 3600_000,
  }))

  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }

  const env = {
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
  } as unknown as Env

  return { env }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

describe('handleTestModel: WorkBuddy 连通性测试 max_tokens 参数保护', () => {
  beforeEach(() => {
    clearCache()
    vi.restoreAllMocks()
  })

  it('WorkBuddy 提供商测试 gpt-6-sol 时发送 max_tokens: 100（避免 11133 integer_below_min_value）', async () => {
    const wbProvider: Provider = {
      id: 'workbuddy',
      name: 'WorkBuddy Global',
      authType: 'oauth-device',
      baseUrl: 'https://copilot.tencent.com/v2',
      apiKeys: [],
      models: [{ id: 'gpt-6-sol', enabled: true }],
      enabled: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      oauth: {
        flowType: 'browser',
        clientId: 'wb-client',
        deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state',
        deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
        refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
        globalBaseUrl: 'https://www.workbuddy.ai/console',
      },
    }

    const { env } = makeEnv([wbProvider])

    let interceptedBody: Record<string, unknown> | null = null
    let interceptedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      interceptedHeaders = (init?.headers || {}) as Record<string, string>
      if (init?.body && typeof init.body === 'string') {
        try {
          interceptedBody = JSON.parse(init.body) as Record<string, unknown>
        } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ id: 'test', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const req = new Request('https://gw.test/admin/api/providers/workbuddy/test-model', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session_id=${SESSION_ID}`,
      },
      body: JSON.stringify({ modelId: 'gpt-6-sol' }),
    })

    const res = await gateway.fetch(req, env, ctx)
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { success: boolean } }
    expect(json.success).toBe(true)
    expect(json.data.success).toBe(true)

    expect(interceptedBody).not.toBeNull()
    expect(interceptedBody!['max_tokens']).toBe(100)
    expect(interceptedBody!['model']).toBe('gpt-6-sol')
    expect(interceptedBody!['stream']).toBe(true)

    // 会话头族：真实 chat 路径必带，缺失会被上游判 400 / code 11128（conversation id missing）
    expect(interceptedHeaders['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(interceptedHeaders['X-Conversation-Message-ID']).toMatch(/^[0-9a-f]{32}$/)
    // X-Conversation-ID 是 11-128 那条判定的**唯一依据**，必须是带连字符的 UUID（非 32 hex）
    expect(interceptedHeaders['X-Conversation-ID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(interceptedHeaders['X-Root-Request-ID']).toBe(interceptedHeaders['X-Conversation-Request-ID'])
    // trace 族随会话头族一起注入（W3C traceparent + B3 单头）
    expect(interceptedHeaders['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(interceptedHeaders['b3']).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1$/)
    expect(interceptedHeaders['X-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('非 WorkBuddy 的普通 oauth-device 提供商仍保持最小 max_tokens: 1', async () => {
    const otherProvider: Provider = {
      id: 'other-oauth',
      name: 'Other OAuth',
      authType: 'oauth-device',
      baseUrl: 'https://api.example.com',
      apiKeys: [],
      models: [{ id: 'some-model', enabled: true }],
      enabled: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      oauth: {
        flowType: 'device',
        clientId: 'other-client',
        deviceCodeUrl: 'https://api.example.com/oauth/device',
        deviceTokenUrl: 'https://api.example.com/oauth/token',
        refreshTokenUrl: 'https://api.example.com/oauth/token/refresh',
      },
    }

    const { env } = makeEnv([otherProvider])

    let interceptedBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          interceptedBody = JSON.parse(init.body) as Record<string, unknown>
        } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ id: 'test', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const req = new Request('https://gw.test/admin/api/providers/other-oauth/test-model', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session_id=${SESSION_ID}`,
      },
      body: JSON.stringify({ modelId: 'some-model' }),
    })

    const res = await gateway.fetch(req, env, ctx)
    expect(res.status).toBe(200)

    expect(interceptedBody).not.toBeNull()
    expect(interceptedBody!['max_tokens']).toBe(1)
  })
})
