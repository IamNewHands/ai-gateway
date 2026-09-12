import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshM365AccountIfNeeded, refreshM365Token, type PooledAccount } from './oauth'
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
})
