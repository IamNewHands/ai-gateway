import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshM365AccountIfNeeded, refreshM365Token, refreshM365TokenDetail, type PooledAccount } from './oauth'
import { readHealth } from './account-health'
import type { Env, OAuthDeviceConfig } from '../types'

class MemoryKV {
  private readonly store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  seed(providerId: string, accounts: PooledAccount[]): void {
    this.store.set(`oauth:token:${providerId}:pool`, JSON.stringify(accounts))
  }

  accounts(providerId: string): PooledAccount[] {
    return JSON.parse(this.store.get(`oauth:token:${providerId}:pool`) || '[]') as PooledAccount[]
  }
}

function envWithKv(kv: MemoryKV): Env {
  return { KV: kv } as unknown as Env
}

function account(overrides: Partial<PooledAccount> = {}): PooledAccount {
  return {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Date.now() - 60_000,
    updated_at: Date.now() - 60_000,
    email: 'user@example.com',
    tid: 'tenant-1',
    lastUsedAt: 1,
    ...overrides,
  } as PooledAccount
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const oauthConfig = {} as OAuthDeviceConfig

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('M365 token refresh account identity', () => {
  it('refreshes an expired account without oid by normalized email and does not duplicate it', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-email', [
      account({ email: 'First@Example.com', refresh_token: 'refresh-first' }),
      account({ email: 'Second@Example.com', refresh_token: 'refresh-second', access_token: 'second-old', lastUsedAt: 2 }),
    ])
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain('refresh_token=refresh-second')
      return tokenResponse('second-new', 'refresh-second-rotated')
    })
    vi.stubGlobal('fetch', fetchMock)

    const refreshed = await refreshM365AccountIfNeeded(
      envWithKv(kv),
      'm365-email',
      undefined,
      ' second@example.COM ',
    )

    expect(refreshed?.accessToken).toBe('second-new')
    expect(refreshed?.refreshToken).toBe('refresh-second-rotated')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const saved = kv.accounts('m365-email')
    expect(saved).toHaveLength(2)
    expect(saved.find((item) => item.email === 'First@Example.com')?.access_token).toBe('old-access')
    expect(saved.find((item) => item.email === 'Second@Example.com')?.access_token).toBe('second-new')
  })

  it('deduplicates concurrent refreshes of the same email account', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-dedupe', [account({ email: 'same@example.com' })])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return tokenResponse('new-access')
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = refreshM365Token(envWithKv(kv), 'm365-dedupe', oauthConfig, undefined, 'same@example.com')
    const second = refreshM365Token(envWithKv(kv), 'm365-dedupe', oauthConfig, undefined, 'SAME@example.com')
    release()

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps different oid-less email accounts isolated during concurrent refresh', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-isolation', [
      account({ email: 'a@example.com', refresh_token: 'refresh-a' }),
      account({ email: 'b@example.com', refresh_token: 'refresh-b', access_token: 'old-b', lastUsedAt: 2 }),
    ])
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body)
      return body.includes('refresh_token=refresh-a')
        ? tokenResponse('new-a')
        : tokenResponse('new-b')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await Promise.all([
      refreshM365Token(envWithKv(kv), 'm365-isolation', oauthConfig, undefined, 'a@example.com'),
      refreshM365Token(envWithKv(kv), 'm365-isolation', oauthConfig, undefined, 'b@example.com'),
    ])

    expect(result).toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const saved = kv.accounts('m365-isolation')
    expect(saved.find((item) => item.email === 'a@example.com')?.access_token).toBe('new-a')
    expect(saved.find((item) => item.email === 'b@example.com')?.access_token).toBe('new-b')
  })

  it('refuses unidentified fallback in a multi-account pool', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-unidentified', [
      account({ email: undefined, refresh_token: 'refresh-a' }),
      account({ email: undefined, refresh_token: 'refresh-b', access_token: 'old-b', lastUsedAt: 2 }),
    ])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshM365Token(envWithKv(kv), 'm365-unidentified', oauthConfig)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows unidentified fallback only for a single-account legacy pool', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-legacy', [account({ email: undefined, oid: undefined })])
    const fetchMock = vi.fn(async () => tokenResponse('legacy-new'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshM365Token(envWithKv(kv), 'm365-legacy', oauthConfig)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(kv.accounts('m365-legacy')).toHaveLength(1)
    expect(kv.accounts('m365-legacy')[0]?.access_token).toBe('legacy-new')
  })

  it('clears the inflight entry after a failed refresh so a retry can run', async () => {
    const kv = new MemoryKV()
    kv.seed('m365-retry', [account({ email: 'retry@example.com' })])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(tokenResponse('retry-new'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshM365Token(envWithKv(kv), 'm365-retry', oauthConfig, undefined, 'retry@example.com')).resolves.toBe(false)
    await expect(refreshM365Token(envWithKv(kv), 'm365-retry', oauthConfig, undefined, 'retry@example.com')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('marks account as authFailed with error message when upstream returns AADSTS700082 expired refresh token', async () => {
    const kv = new MemoryKV()
    const testOid = 'oid-expired-1'
    kv.seed('m365-exp', [account({ oid: testOid, email: 'expired@example.com', refresh_token: 'dead-rt' })])
    const errorBody = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'AADSTS700082: The refresh token has expired due to inactivity. The token was issued on 2026-10-01 and was inactive for 90.00:00:00.',
    })
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(errorBody, {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const detail = await refreshM365TokenDetail(envWithKv(kv), 'm365-exp', oauthConfig, testOid)
    expect(detail.success).toBe(false)
    expect(detail.errorCode).toBe('invalid_grant')
    expect(detail.error).toContain('AADSTS700082')

    // 检查 KV 中的账号健康记录
    const health = await readHealth(envWithKv(kv), testOid)
    expect(health.authFailed).toBe(true)
    expect(health.authError).toContain('AADSTS700082')
    expect(health.authFailedAt).toBeGreaterThan(0)
  })

  it('clears authFailed status in health when token refresh succeeds', async () => {
    const kv = new MemoryKV()
    const testOid = 'oid-success-1'
    kv.seed('m365-ok', [account({ oid: testOid, email: 'ok@example.com', refresh_token: 'valid-rt' })])
    // 预置已失效的健康状态
    const deadHealth = {
      cooldownUntil: Date.now() + 86400000,
      authFailed: true,
      authError: 'invalid_grant: previous token expired',
      authFailedAt: Date.now() - 3600000,
      imageLimitedUntil: 0,
      updatedAt: Date.now() - 3600000,
    }
    await kv.put(`m365:health:${testOid}`, JSON.stringify(deadHealth))

    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse('fresh-access', 'fresh-refresh'))
    vi.stubGlobal('fetch', fetchMock)

    const detail = await refreshM365TokenDetail(envWithKv(kv), 'm365-ok', oauthConfig, testOid)
    expect(detail.success).toBe(true)
    expect(detail.expiresAt).toBeGreaterThan(Date.now())

    const health = await readHealth(envWithKv(kv), testOid)
    expect(health.authFailed).toBe(false)
    expect(health.authError).toBeUndefined()
    expect(health.authFailedAt).toBe(0)
  })
})

