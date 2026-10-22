import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import gateway from './index'
import { saveAgentRouterAccount } from './agentrouter'
import type { AgentRouterAccountView, AgentRouterSummary } from './agentrouter'
import { KV_KEYS } from './config'
import { clearCache } from './storage'
import type { ApiResponse, Env, Provider } from './types'

const NOW = new Date('2026-10-22T10:05:00+08:00').getTime()
const SESSION = 'agentrouter-route-test-session'
const TOKEN = 'agentrouter-test-management-token'
const PASSWORD = ' route-test site#password with spaces '
const EMAIL = 'route-test@example.com'
const ctx: ExecutionContext = {
  waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, tracing: {} as Tracing,
}

function harness() {
  const store = new Map<string, string>()
  const providers: Provider[] = ['agentrouter', 'agentrouter-responses'].map((id) => ({
    id, name: id, baseUrl: 'https://agentrouter.org/v1', authType: 'api-key',
    apiType: id === 'agentrouter' ? 'openai' : 'openai-responses',
    apiKeys: [{ key: 'test-only-api-key', enabled: true }], models: [], enabled: true,
    createdAt: '2026-10-22', updatedAt: '2026-10-22',
  }))
  store.set(KV_KEYS.PROVIDERS, JSON.stringify(providers))
  store.set(KV_KEYS.PROXY_KEYS, '[]')
  store.set(KV_KEYS.DEFAULT_PROVIDERS_MIGRATION, '1')
  store.set(KV_KEYS.SESSION_PREFIX + SESSION, JSON.stringify({ username: 'admin', expiresAt: NOW + 3600_000 }))
  const writes = vi.fn(async (key: string, value: string) => { store.set(key, value) })
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null, cacheStatus: null }),
    put: writes,
    delete: async (key: string) => { store.delete(key) },
    list: async (options?: KVNamespaceListOptions) => ({
      keys: Array.from(store.keys()).filter((key) => key.startsWith(options?.prefix || '')).map((name) => ({ name })),
      list_complete: true, cursor: '',
    }),
  }
  // These routes use only text KV operations, not DO bindings or the binary/batch KV overloads.
  const env = { KV: kv, ADMIN_PASSWORD: 'test-only-encryption-key', MANAGEMENT_TOKEN: TOKEN } as unknown as Env
  return { env, store, writes }
}

function request(path: string, options: {
  method?: string; body?: string; session?: boolean; token?: string; origin?: string
} = {}) {
  const headers = new Headers({ Host: 'gw.test' })
  if (options.session) headers.set('Cookie', 'session_id=' + SESSION)
  if (options.token !== undefined) headers.set('Authorization', 'Bearer ' + options.token)
  if (options.origin) headers.set('Origin', options.origin)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  return new Request('https://gw.test' + path, {
    method: options.method || 'GET', headers, ...(options.body !== undefined ? { body: options.body } : {}),
  })
}

function upstream() {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/api/user/login') {
      return Response.json({ success: true, data: { id: 9, checked_in: true } }, {
        headers: { 'Set-Cookie': 'session=route-upstream-cookie; Path=/; HttpOnly; Secure' },
      })
    }
    if (url.pathname === '/api/log/self') return Response.json({
      success: true, data: { items: [{ type: 4, content: '签到成功', created_at: NOW / 1000 }] },
    })
    if (url.pathname === '/api/user/self') return Response.json({
      success: true, data: { quota: 750_000, used_quota: 250_000 },
    })
    throw new Error('unexpected upstream request')
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  clearCache()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AgentRouter real Hono route authentication', () => {
  it.each([
    ['GET', '/admin/api/agentrouter/accounts'],
    ['POST', '/admin/api/agentrouter/accounts'],
    ['PUT', '/admin/api/agentrouter/accounts/' + 'a'.repeat(43)],
    ['DELETE', '/admin/api/agentrouter/accounts/' + 'a'.repeat(43)],
    ['POST', '/admin/api/agentrouter/checkin'],
    ['POST', '/admin/api/agentrouter/checkin/' + 'a'.repeat(43)],
  ])('%s %s requires a session before reading credentials or calling upstream', async (method, path) => {
    const { env, writes } = harness()
    const mock = upstream()
    const response = await gateway.fetch(request(path, { method, token: TOKEN }), env, ctx)
    expect(response.status).toBe(401)
    expect(writes).not.toHaveBeenCalled()
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects an expired session', async () => {
    const { env, store } = harness()
    store.set(KV_KEYS.SESSION_PREFIX + SESSION, JSON.stringify({ username: 'admin', expiresAt: NOW - 1 }))
    const response = await gateway.fetch(request('/admin/api/agentrouter/accounts', { session: true }), env, ctx)
    expect(response.status).toBe(401)
  })

  it('management routes require their own token, not a session or proxy key', async () => {
    const { env } = harness()
    for (const options of [{ session: true }, { token: 'wrong' }, { token: 'sk_cf_test_only' }]) {
      const response = await gateway.fetch(request('/api/manage/agentrouter/accounts', options), env, ctx)
      expect(response.status).toBe(401)
    }
    delete env.MANAGEMENT_TOKEN
    expect((await gateway.fetch(request('/api/manage/agentrouter/accounts', { token: TOKEN }), env, ctx)).status).toBe(503)
  })

  it.each(['POST', 'PUT', 'DELETE'])('rejects cross-site %s credential writes', async (method) => {
    const { env, writes } = harness()
    const id = await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    writes.mockClear()
    const path = '/admin/api/agentrouter/accounts' + (method === 'POST' ? '' : '/' + id)
    const response = await gateway.fetch(request(path, {
      method, session: true, origin: 'https://evil.example',
      ...(method === 'DELETE' ? {} : { body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }),
    }), env, ctx)
    expect(response.status).toBe(403)
    expect(writes).not.toHaveBeenCalled()
  })

  it('does not expose credential CRUD via management-token routes', async () => {
    const { env, writes } = harness()
    for (const [method, path] of [
      ['POST', '/api/manage/agentrouter/accounts'],
      ['PUT', '/api/manage/agentrouter/accounts/' + 'a'.repeat(43)],
      ['DELETE', '/api/manage/agentrouter/accounts/' + 'a'.repeat(43)],
    ]) {
      expect((await gateway.fetch(request(path, { method, token: TOKEN }), env, ctx)).status).toBe(404)
    }
    expect(writes).not.toHaveBeenCalled()
  })
})

describe('AgentRouter credential request validation and CRUD', () => {
  it.each(['', ' ', '{oops', 'null', '[]'])('rejects invalid credential JSON %j without writes', async (body) => {
    const { env, writes } = harness()
    const response = await gateway.fetch(request('/admin/api/agentrouter/accounts', {
      method: 'POST', session: true, body,
    }), env, ctx)
    expect(response.status).toBe(400)
    expect(writes).not.toHaveBeenCalled()
  })

  it('rejects writes over 16 KiB before saving or calling upstream', async () => {
    const { env, writes } = harness()
    const mock = upstream()
    const response = await gateway.fetch(request('/admin/api/agentrouter/accounts', {
      method: 'POST', session: true, body: JSON.stringify({ email: EMAIL, password: PASSWORD, pad: 'x'.repeat(16 * 1024) }),
    }), env, ctx)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } })
    expect(writes).not.toHaveBeenCalled()
    expect(mock).not.toHaveBeenCalled()
  })

  it('creates, edits, pauses and deletes independently of provider API keys', async () => {
    const { env, store } = harness()
    const originalProviders = store.get(KV_KEYS.PROVIDERS)
    const originalProxyKeys = store.get(KV_KEYS.PROXY_KEYS)
    const created = await gateway.fetch(request('/admin/api/agentrouter/accounts', {
      method: 'POST', session: true, origin: 'https://gw.test',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Main' }),
    }), env, ctx)
    expect(created.status).toBe(200)
    const { data } = await created.json() as ApiResponse<{ id: string }>
    const id = data!.id
    const encrypted = JSON.parse(store.get(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)!).encryptedPassword
    const edited = await gateway.fetch(request('/admin/api/agentrouter/accounts/' + id, {
      method: 'PUT', session: true, origin: 'https://gw.test', body: JSON.stringify({ name: 'Renamed', enabled: false }),
    }), env, ctx)
    expect(edited.status).toBe(200)
    expect(JSON.parse(store.get(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)!).encryptedPassword).toBe(encrypted)
    const listed = await gateway.fetch(request('/admin/api/agentrouter/accounts', { session: true }), env, ctx)
    const views = await listed.json() as ApiResponse<AgentRouterAccountView[]>
    expect(views.data).toHaveLength(1)
    expect(views.data![0]).toMatchObject({ name: 'Renamed', enabled: false, hasPassword: true, credentialsReady: true })
    expect(listed.headers.get('Cache-Control')).toBe('no-store')
    const duplicate = await gateway.fetch(request('/admin/api/agentrouter/accounts', {
      method: 'POST', session: true, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }), env, ctx)
    expect(duplicate.status).toBe(409)
    const mock = upstream()
    const paused = await gateway.fetch(request('/admin/api/agentrouter/checkin/' + id, {
      method: 'POST', session: true,
    }), env, ctx)
    expect(await paused.json()).toMatchObject({ data: { total: 1, skipped: 1 } })
    expect(mock).not.toHaveBeenCalled()
    const deleted = await gateway.fetch(request('/admin/api/agentrouter/accounts/' + id, {
      method: 'DELETE', session: true, origin: 'https://gw.test',
    }), env, ctx)
    expect(deleted.status).toBe(200)
    expect(store.has(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)).toBe(false)
    expect(store.get(KV_KEYS.PROVIDERS)).toBe(originalProviders)
    expect(store.get(KV_KEYS.PROXY_KEYS)).toBe(originalProxyKeys)
  })

  it('maps nonexistent and malformed account IDs without leaking storage errors', async () => {
    const { env } = harness()
    for (const [id, status, code] of [
      ['a'.repeat(43), 404, 'ACCOUNT_NOT_FOUND'],
      ['not-a-valid-id', 400, 'INVALID_ACCOUNT_ID'],
    ] as const) {
      const response = await gateway.fetch(request('/admin/api/agentrouter/accounts/' + id, {
        method: 'DELETE', session: true,
      }), env, ctx)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ success: false, code })
    }
  })
})

describe('AgentRouter manual route, shared accounts and read redaction', () => {
  it('forces verification through either auth route, and counts shared providers only once', async () => {
    const { env } = harness()
    const id = await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const mock = upstream()
    for (const [path, options] of [
      ['/admin/api/agentrouter/checkin/' + id, { session: true }],
      ['/api/manage/agentrouter/checkin/' + id, { token: TOKEN }],
    ] as const) {
      const response = await gateway.fetch(request(path, { method: 'POST', ...options }), env, ctx)
      expect(response.status).toBe(200)
      expect((await response.json() as ApiResponse<AgentRouterSummary>).data).toMatchObject({ total: 1, ok: 1, fail: 0 })
    }
    expect(mock).toHaveBeenCalledTimes(6)
    mock.mockClear()
    const overview = await gateway.fetch(request('/admin/api/overview', { session: true }), env, ctx)
    expect(await overview.json()).toMatchObject({
      data: {
        checkin: { totalAccounts: 1, checkedIn: 1 },
        agentrouter: { accounts: 1, checkedIn: 1, remain: 1.5, currency: 'USD' },
        workbuddy: { remain: 0 }, qoder: { remain: 0 }, trae: { remain: 0 },
      },
    })
    for (const [path, options] of [
      ['/admin/api/agentrouter/accounts', { session: true }],
      ['/api/manage/agentrouter/accounts', { token: TOKEN }],
      ['/admin/api/checkin/status', { session: true }],
      ['/admin', { session: true }],
    ] as const) {
      const response = await gateway.fetch(request(path, options), env, ctx)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('route-upstream-cookie')
      expect(text).not.toContain('encryptedPassword')
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('the existing full manual trigger includes AgentRouter only once', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const mock = upstream()
    const response = await gateway.fetch(request('/admin/api/checkin', { method: 'POST', session: true }), env, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: {
      summary: { total: 0 }, agentrouter: { total: 1, ok: 1 },
    } })
    expect(mock).toHaveBeenCalledTimes(3)
  })
})
