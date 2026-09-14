import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshAllOauthTokens, OAUTH_POOL_KV_PREFIX, type ProviderLike } from './oauth'
import type { Env, OAuthTokenState } from './types'

/**
 * WorkBuddy（flowType=browser）账号池保活刷新测试。
 *
 * 背景（本次移植的缺陷）：refreshAllOauthTokens 原实现只读单 token key
 * （oauth:token:<id>），而 browser 流账号存在池里（oauth:pool:<id>）→ 池内账号
 * 永不参与 Cron 刷新。请求路径只对「被选中的账号」做临期刷新，低权重/长期冷却的
 * 账号可能数周不被选中。
 */

const PID = 'workbuddy-test'
const POOL_KEY = OAUTH_POOL_KV_PREFIX + PID

/** 一个 CN 域的最小合法 JWT（仅需 payload 可解出 iss，用于 realm 判定）。 */
function jwtWithIss(iss: string): string {
  // 用 btoa（Workers 与 Node 均可用）替代 Buffer，避免引入 @types/node 依赖。
  // base64url 需把 +/ 换成 -_ 并去掉尾部 =（JWT 规范）。
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss, uid: 'u1', exp: 9999999999 })}.sig`
}

const CN_TOKEN = jwtWithIss('https://www.codebuddy.cn')

function makeMockEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  const env = { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env
  return { env, store }
}

function makeProvider(): ProviderLike {
  return {
    id: PID,
    authType: 'oauth-device',
    oauth: {
      flowType: 'browser',
      deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state',
      deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
      refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
      tokenHeader: 'Authorization',
      tokenHeaderPrefix: 'Bearer ',
    } as ProviderLike['oauth'],
  }
}

function seedPool(store: Map<string, string>, accounts: unknown[]) {
  store.set(POOL_KEY, JSON.stringify(accounts))
}

function readPool(store: Map<string, string>): any[] {
  const raw = store.get(POOL_KEY)
  return raw ? JSON.parse(raw) : []
}

/** 构造一个池账号。expiresAt/updatedAt 相对 now 偏移。 */
function acct(opts: {
  uid: string
  accessToken?: string
  refreshToken?: string | null
  expiresInMs?: number
  updatedAgoMs?: number
  enabled?: boolean
  disabled?: boolean
  sessionDeadFails?: number
}) {
  const now = Date.now()
  const token: OAuthTokenState = {
    access_token: opts.accessToken ?? CN_TOKEN,
    expires_at: now + (opts.expiresInMs ?? 2 * 60 * 60 * 1000),
    updated_at: now,
  }
  if (opts.refreshToken !== null) token.refresh_token = opts.refreshToken ?? 'rt-1'
  return {
    uid: opts.uid,
    token,
    enabled: opts.enabled ?? true,
    state: {
      credits: 100,
      disabled: opts.disabled ?? false,
      until: 0,
      errCount: 0,
      ...(opts.sessionDeadFails !== undefined ? { sessionDeadFails: opts.sessionDeadFails } : {}),
    },
    updatedAt: now - (opts.updatedAgoMs ?? 0),
  }
}

/** 统一的刷新端点成功响应。 */
function okRefreshResponse(accessToken = 'new-access-token') {
  return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken, refreshToken: 'new-rt', expiresIn: 3600 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('refreshAllOauthTokens — WorkBuddy（browser）池保活', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('临期账号被刷新（旧实现只读单 token key，池内账号永不刷新）', async () => {
    const { env, store } = makeMockEnv()
    // 已过期（expiresInMs 为负）→ 临期
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000 })])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(1)
    expect(r.fail).toBe(0)
    // 新 token 已写回池
    expect(readPool(store)[0].token.access_token).toBe('new-access-token')
  })

  it('闲置超 20 天的账号被保活刷新（即便 token 未临期）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: 2 * 60 * 60 * 1000, updatedAgoMs: 21 * 24 * 60 * 60 * 1000 })])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(1)
  })

  it('既未临期也未闲置 → 不刷新（避免每 2 小时无条件全池打上游）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: 2 * 60 * 60 * 1000, updatedAgoMs: 60 * 1000 })])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(0)
    expect(r.fail).toBe(0)
  })

  it('禁用账号跳过刷新（需人工重登，刷新必然失败，白打上游）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [
      acct({ uid: 'u1', expiresInMs: -1000, enabled: false }),
      acct({ uid: 'u2', expiresInMs: -1000, disabled: true }),
    ])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(0)
    expect(r.fail).toBe(0)
  })

  it('无 refresh_token 的账号跳过（无法刷新）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000, refreshToken: null })])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(0)
  })

  it('刷新失败计入 fail 且不改写池（保留原 token 供重登）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000 })])
    const before = readPool(store)[0].token.access_token
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(r.ok).toBe(0)
    expect(r.fail).toBe(1)
    expect(readPool(store)[0].token.access_token).toBe(before)
  })

  it('刷新成功清零 12153 连续失败计数（对齐 workbuddy2api ClearSessionDead）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000, sessionDeadFails: 2 })])
    vi.stubGlobal('fetch', vi.fn(async () => okRefreshResponse()))

    await refreshAllOauthTokens(env, [makeProvider()])

    expect(readPool(store)[0].state.sessionDeadFails).toBe(0)
  })

  it('多账号：仅刷临期者，未临期者保持不变', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [
      acct({ uid: 'expired', expiresInMs: -1000 }),
      acct({ uid: 'fresh', expiresInMs: 2 * 60 * 60 * 1000 }),
    ])
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(1)
    const pool = readPool(store)
    expect(pool.find((a: any) => a.uid === 'expired').token.access_token).toBe('new-access-token')
    expect(pool.find((a: any) => a.uid === 'fresh').token.access_token).toBe(CN_TOKEN)
  })

  it('池为空/池损坏 → 不抛错，返回 0/0（不阻断其他 provider）', async () => {
    const { env, store } = makeMockEnv()
    const r1 = await refreshAllOauthTokens(env, [makeProvider()])
    expect(r1).toEqual({ ok: 0, fail: 0 })

    store.set(POOL_KEY, '{ not json')
    const r2 = await refreshAllOauthTokens(env, [makeProvider()])
    expect(r2).toEqual({ ok: 0, fail: 0 })
  })

  it('m365 provider 不走 browser 分支（保持既有 M365 池刷新语义）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000 })])
    const p = makeProvider()
    p.oauth = { ...p.oauth!, flowType: 'm365-pkce' }
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    // M365 分支依赖 getM365AccountInfos（不同 KV key），此处池 key 不匹配 → 不刷新
    await refreshAllOauthTokens(env, [p])
    // 关键断言：没有按 browser 池 key 去刷（M365 用 oauth:token:<id>:pool）
    expect(readPool(store)[0].token.access_token).toBe(CN_TOKEN)
  })

  it('非 oauth-device provider 直接跳过', async () => {
    const { env } = makeMockEnv()
    const fetchMock = vi.fn(async () => okRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)
    const p: ProviderLike = { id: 'plain', authType: 'api-key' }

    const r = await refreshAllOauthTokens(env, [p])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: 0, fail: 0 })
  })
})
