import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentRouterDate, deleteAgentRouterAccount, readAgentRouterAccounts,
  runAgentRouterCheckins, saveAgentRouterAccount,
} from './agentrouter'
import { KV_KEYS } from './config'
import type { Env } from './types'

const NOW = new Date('2026-10-22T10:05:00+08:00').getTime()
const PASSWORD = '  site#password+"with spaces"  '
const EMAIL = 'checkin@example.com'

function harness() {
  const store = new Map<string, string>()
  const writes: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = []
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null, cacheStatus: null }),
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      store.set(key, value)
      writes.push({ key, value, options })
    },
    delete: async (key: string) => { store.delete(key) },
    list: vi.fn(async (options?: KVNamespaceListOptions) => ({
      keys: Array.from(store.keys()).filter((key) => key.startsWith(options?.prefix || '')).map((name) => ({ name })),
      list_complete: true, cursor: '',
    })),
  }
  // The module uses only text KV operations; the fake deliberately omits other platform overloads.
  const env = { KV: kv, ADMIN_PASSWORD: 'test-only-admin-key-not-a-site-password' } as unknown as Env
  return { env, store, writes, kv }
}

function login(data: Record<string, unknown> = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  headers.append('Set-Cookie', 'session=test-session-secret; Path=/; HttpOnly; Secure')
  headers.append('Set-Cookie', 'acw_tc=waf-first; Expires=Wed, 30 Dec 2026 12:00:00 GMT; Path=/')
  return Response.json({ success: true, data: { id: 42, checked_in: true, ...data } }, { headers })
}

function logResponse(items: unknown[] = [checkinLog(NOW)]) {
  return Response.json({ success: true, data: { items } })
}

function checkinLog(at: number, content = '签到成功，获得每日额度', type = 4) {
  return { type, content, created_at: Math.floor(at / 1000) }
}

function upstream(options: {
  login?: () => Response
  logs?: () => Response
  quota?: () => Response
  redirect?: boolean
} = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, init })
    if (url.pathname === '/api/user/login') return options.login?.() || login()
    if (url.pathname === '/api/log/self') {
      if (options.redirect) return new Response(null, {
        status: 301, headers: { Location: '/api/log/self/?p=1&page_size=20', 'Set-Cookie': 'acw_tc=waf-updated; Path=/' },
      })
      return options.logs?.() || logResponse()
    }
    if (url.pathname === '/api/log/self/') return options.logs?.() || logResponse()
    if (url.pathname === '/api/user/self') return options.quota?.() ||
      Response.json({ success: true, data: { quota: 1_500_000, used_quota: 500_000 } })
    throw new Error('unexpected upstream URL')
  })
  vi.stubGlobal('fetch', mock)
  return { calls, mock }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AgentRouter credentials and independent storage', () => {
  it('encrypts the password and never exposes it or Cookies in read views/results', async () => {
    const { env, store } = harness()
    const id = await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD, name: '主账号' })
    const { calls } = upstream()
    const result = await runAgentRouterCheckins(env)
    const views = await readAgentRouterAccounts(env)
    expect(result.ok).toBe(1)
    expect(views[0]).toMatchObject({ id, email: EMAIL, credentialsReady: true, hasPassword: true, checkedInToday: true })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: EMAIL, password: PASSWORD })
    for (const output of [JSON.stringify(views), JSON.stringify(result), ...store.values()]) {
      expect(output).not.toContain(PASSWORD)
      expect(output).not.toContain('test-session-secret')
    }
    expect(JSON.parse(store.get(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)!)).toHaveProperty('encryptedPassword')
    expect(store.has('providers')).toBe(false)
  })

  it('normalizes email identity, rejects duplicates, and keeps an omitted/empty password on edit', async () => {
    const { env, store } = harness()
    const id = await saveAgentRouterAccount(env, { email: ' CheckIn@Example.COM ', password: PASSWORD })
    const ciphertext = JSON.parse(store.get(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)!).encryptedPassword
    await expect(saveAgentRouterAccount(env, { email: EMAIL, password: 'another' })).rejects.toThrow('ACCOUNT_EXISTS')
    await saveAgentRouterAccount(env, { password: '', name: '更新备注', enabled: false }, id)
    expect(JSON.parse(store.get(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)!).encryptedPassword).toBe(ciphertext)
    expect((await readAgentRouterAccounts(env))[0]).toMatchObject({ name: '更新备注', enabled: false, credentialsReady: true })
    await expect(saveAgentRouterAccount(env, { email: 'other@example.com' }, id)).rejects.toThrow('EMAIL_IMMUTABLE')
  })

  it('shows locked credentials after admin-secret rotation and allows password replacement', async () => {
    const { env } = harness()
    const id = await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    env.ADMIN_PASSWORD = 'rotated-test-only-admin-key'
    expect((await readAgentRouterAccounts(env))[0].credentialsReady).toBe(false)
    const { mock } = upstream()
    const summary = await runAgentRouterCheckins(env)
    expect(summary.results[0].errorCode).toBe('CREDENTIALS_LOCKED')
    expect(mock).not.toHaveBeenCalled()
    expect((await readAgentRouterAccounts(env))[0].result?.errorCode).toBe('CREDENTIALS_LOCKED')
    await saveAgentRouterAccount(env, { password: 'replacement-site-password' }, id)
    expect((await readAgentRouterAccounts(env))[0].credentialsReady).toBe(true)
  })

  it('requires a key for saving credentials, validates input types, and preserves disabled accounts', async () => {
    const { env, store } = harness()
    await expect(saveAgentRouterAccount(env, null)).rejects.toThrow('INVALID_ACCOUNT')
    await expect(saveAgentRouterAccount(env, { email: EMAIL, password: 42 })).rejects.toThrow('INVALID_PASSWORD')
    await expect(saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD, enabled: 'yes' })).rejects.toThrow('INVALID_ENABLED')
    delete env.ADMIN_PASSWORD
    await expect(saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })).rejects.toThrow('CREDENTIAL_KEY_MISSING')
    expect(store.size).toBe(0)
    env.ADMIN_PASSWORD = 'restored-test-only-key'
    const id = await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD, enabled: false })
    const { mock } = upstream()
    expect((await runAgentRouterCheckins(env)).skipped).toBe(1)
    expect(mock).not.toHaveBeenCalled()
    expect((await readAgentRouterAccounts(env))[0].hasPassword).toBe(true)
    await deleteAgentRouterAccount(env, id)
    expect(await readAgentRouterAccounts(env)).toEqual([])
    expect(store.has(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id)).toBe(false)
  })

  it('caps configured accounts and walks paginated account keys', async () => {
    const { env, kv } = harness()
    for (let i = 0; i < 20; i++) {
      await saveAgentRouterAccount(env, { email: 'account' + i + '@example.com', password: PASSWORD })
    }
    await expect(saveAgentRouterAccount(env, { email: 'overflow@example.com', password: PASSWORD })).rejects.toThrow('ACCOUNT_LIMIT')
    const all = await readAgentRouterAccounts(env)
    const keys = all.map((account) => ({ name: KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + account.id }))
    kv.list.mockImplementation(async (options) => options?.cursor === 'page-two'
      ? { keys: keys.slice(10), list_complete: true, cursor: '' }
      : { keys: keys.slice(0, 10), list_complete: false, cursor: 'page-two' })
    expect(await readAgentRouterAccounts(env)).toHaveLength(20)
    expect(kv.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'page-two' }))
  })
})

describe('AgentRouter check-in evidence and HTTP boundaries', () => {
  it('merges multiple Set-Cookies and same-origin redirect cookies before verification/quota reads', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const { calls } = upstream({ redirect: true })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.ok).toBe(1)
    expect(summary.results[0]).toMatchObject({ quota: 3, usedQuota: 1, totalQuota: 4, checkedInDate: '2026-10-22' })
    expect(calls).toHaveLength(4)
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init.headers)
      expect(headers.get('New-API-User')).toBe('42')
      expect(headers.get('Cookie')).toContain('session=test-session-secret')
      expect(call.init.redirect).toBe('manual')
    }
    expect(new Headers(calls[3].init.headers).get('Cookie')).toContain('acw_tc=waf-updated')
  })

  it.each([
    { name: 'checked_in=true but no log', data: { checked_in: true }, items: [] },
    { name: 'generic type=4 system log', data: { checked_in: true }, items: [checkinLog(NOW, '管理员调整额度')] },
    { name: 'success content with wrong log type', data: { checked_in: true }, items: [checkinLog(NOW, '签到成功', 1)] },
    { name: 'negative success text', data: { checked_in: true }, items: [checkinLog(NOW, '未签到成功')] },
    { name: 'future timestamp', data: { checked_in: true }, items: [checkinLog(NOW + 60_000)] },
  ])('does not report success for $name', async ({ data, items }) => {
    const { env, store } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    upstream({ login: () => login(data), logs: () => logResponse(items) })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.ok).toBe(0)
    expect(summary.fail).toBe(1)
    expect(summary.results[0].status).toBe('unverified')
    expect((await readAgentRouterAccounts(env))[0].checkedInToday).toBe(false)
    expect(Array.from(store.keys()).some((key) => key.startsWith(KV_KEYS.AGENTROUTER_DAY_PREFIX))).toBe(false)
  })

  it('accepts a same-day confirmed log when repeat login reports checked_in=false', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    upstream({ login: () => login({ checked_in: false }), logs: () => logResponse([checkinLog(NOW - 3600_000)]) })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.already).toBe(1)
    expect(summary.fail).toBe(0)
    expect((await readAgentRouterAccounts(env))[0].checkedInToday).toBe(true)
  })

  it('does not mistake yesterday within 24h for today and resets at Shanghai midnight', async () => {
    const midnight = new Date('2026-10-22T00:05:00+08:00').getTime()
    vi.setSystemTime(midnight)
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    upstream({ logs: () => logResponse([checkinLog(midnight - 10 * 60_000)]) })
    expect((await runAgentRouterCheckins(env)).fail).toBe(1)
    expect(agentRouterDate(midnight - 10 * 60_000)).toBe('2026-10-21')
    expect(agentRouterDate(midnight)).toBe('2026-10-22')
  })

  it('skips the second scheduled run, while a new day or manual force performs login', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const { mock } = upstream({ logs: () => logResponse([checkinLog(Date.now())]) })
    expect((await runAgentRouterCheckins(env)).ok).toBe(1)
    mock.mockClear()
    expect((await runAgentRouterCheckins(env)).already).toBe(1)
    expect(mock).not.toHaveBeenCalled()
    expect((await runAgentRouterCheckins(env, { force: true })).ok).toBe(1)
    mock.mockClear()
    vi.setSystemTime(NOW + 86400_000)
    expect((await readAgentRouterAccounts(env))[0].checkedInToday).toBe(false)
    expect((await runAgentRouterCheckins(env)).ok).toBe(1)
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('a later forced-login failure cannot erase the already-confirmed daily marker', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    upstream()
    await runAgentRouterCheckins(env)
    upstream({ login: () => Response.json({ success: false, message: PASSWORD + '; session=test-session-secret' }) })
    const summary = await runAgentRouterCheckins(env, { force: true })
    expect(summary.results[0].errorCode).toBe('LOGIN_FAILED')
    expect(JSON.stringify(summary)).not.toContain(PASSWORD)
    expect((await readAgentRouterAccounts(env))[0]).toMatchObject({ checkedInToday: true, result: { status: 'fail' } })
  })

  it('rejects foreign redirects without sending credentials there', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const { calls } = upstream({ logs: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } }) })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.results[0].errorCode).toBe('UNSAFE_REDIRECT')
    expect(summary.fail).toBe(1)
    expect(calls.every((call) => call.url.origin === 'https://agentrouter.org')).toBe(true)
  })

  it('does not retry business failures, HTML/WAF blocks, or rate limits', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    for (const response of [
      () => Response.json({ success: false, message: PASSWORD }),
      () => new Response('<html>captcha</html>', { headers: { 'Content-Type': 'text/html' } }),
      () => new Response('blocked', { status: 403 }),
      () => new Response('limited', { status: 429 }),
    ]) {
      const { mock } = upstream({ login: response })
      expect((await runAgentRouterCheckins(env)).fail).toBe(1)
      expect(mock).toHaveBeenCalledTimes(1)
    }
  })

  it('retries a transient login failure only once and then verifies the same account', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    let attempts = 0
    const { mock } = upstream({ login: () => ++attempts === 1 ? new Response(null, { status: 503 }) : login() })
    const pending = runAgentRouterCheckins(env)
    await vi.waitFor(() => expect(mock).toHaveBeenCalled())
    await vi.runAllTimersAsync()
    const summary = await pending
    expect(summary.ok).toBe(1)
    expect(attempts).toBe(2)
    expect(mock).toHaveBeenCalledTimes(4)
  })

  it('bounds response size and cancels an oversized stream', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const cancel = vi.fn()
    upstream({ login: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) },
      cancel,
    })) })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.results[0].errorCode).toBe('RESPONSE_TOO_LARGE')
    expect(cancel).toHaveBeenCalled()
  })

  it('times out a stalled response body, not only the initial fetch', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const cancel = vi.fn()
    const { mock } = upstream({ login: () => new Response(new ReadableStream({ cancel })) })
    const pending = runAgentRouterCheckins(env)
    await vi.waitFor(() => expect(mock).toHaveBeenCalled())
    await vi.runAllTimersAsync()
    const summary = await pending
    expect(summary.results[0].errorCode).toBe('REQUEST_TIMEOUT')
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('keeps verified success and login quota when the optional quota read fails', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    upstream({
      login: () => login({ quota: 500_000, used_quota: 250_000 }),
      quota: () => Response.json({ success: true, data: {} }),
    })
    const summary = await runAgentRouterCheckins(env)
    expect(summary.ok).toBe(1)
    expect(summary.results[0]).toMatchObject({ quota: 1, totalQuota: 1.5, warningCode: 'QUOTA_UNAVAILABLE' })
  })

  it('isolates account failures and retains per-account results', async () => {
    const { env } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    await saveAgentRouterAccount(env, { email: 'second@example.com', password: PASSWORD })
    let attempt = 0
    upstream({ login: () => ++attempt === 1 ? Response.json({ success: false }) : login() })
    const summary = await runAgentRouterCheckins(env)
    expect(summary).toMatchObject({ total: 2, ok: 1, fail: 1 })
    expect((await readAgentRouterAccounts(env)).map((a) => Boolean(a.result))).toEqual([true, true])
  })

  it('limits simultaneous account logins to three and preserves account order', async () => {
    const { env } = harness()
    for (let i = 0; i < 5; i++) await saveAgentRouterAccount(env, { email: 'batch' + i + '@example.com', password: PASSWORD })
    const views = await readAgentRouterAccounts(env)
    let inFlight = 0, maximum = 0
    const blocked: Array<() => void> = []
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/user/login') {
        maximum = Math.max(maximum, ++inFlight)
        await new Promise<void>((resolve) => { blocked.push(resolve) })
        inFlight--
        return login()
      }
      if (url.pathname === '/api/log/self') return logResponse()
      return Response.json({ success: true, data: { quota: 0 } })
    })
    vi.stubGlobal('fetch', mock)
    const pending = runAgentRouterCheckins(env)
    await vi.waitFor(() => expect(blocked).toHaveLength(3))
    for (const release of blocked.splice(0)) release()
    await vi.waitFor(() => expect(blocked).toHaveLength(2))
    for (const release of blocked.splice(0)) release()
    const summary = await pending
    expect(maximum).toBe(3)
    expect(summary.ok).toBe(5)
    expect(summary.results.map((result) => result.accountId)).toEqual(views.map((view) => view.id))
  })

  it('keeps the daily evidence when result storage fails, and reports the storage failure', async () => {
    const { env, kv } = harness()
    await saveAgentRouterAccount(env, { email: EMAIL, password: PASSWORD })
    const original = kv.put
    kv.put = async (key, value, options) => {
      if (key.startsWith(KV_KEYS.AGENTROUTER_RESULT_PREFIX)) throw new Error('storage detail must not be returned')
      await original(key, value, options)
    }
    upstream()
    const summary = await runAgentRouterCheckins(env)
    expect(summary.fail).toBe(1)
    expect(summary.results[0].errorCode).toBe('RESULT_STORAGE_FAILED')
    expect(JSON.stringify(summary)).not.toContain('storage detail')
    expect((await readAgentRouterAccounts(env))[0]).toMatchObject({ checkedInToday: true, result: null })
  })
})
