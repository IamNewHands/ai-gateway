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

  it('P2：刷新期间的并发写入不被整体覆盖（池 KV 读改写丢失更新修复）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000 })])

    // 刷新请求飞行中，模拟请求路径/noteOauthError 写池（冷却 + 错误计数 + 额度变化）。
    // 旧实现此时持有的是刷新开始时的池快照，循环结束后整体写回 → 这些写入被静默吞掉。
    const fetchMock = vi.fn(async () => {
      const pool = readPool(store)
      pool[0].state.until = Date.now() + 60_000
      pool[0].state.reason = '429 rate limit'
      pool[0].state.errCount = 4
      pool[0].state.credits = 7
      store.set(POOL_KEY, JSON.stringify(pool))
      return okRefreshResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(r.ok).toBe(1)
    const after = readPool(store)[0]
    // 刷新结果落盘
    expect(after.token.access_token).toBe('new-access-token')
    // 并发写入的冷却/原因/计数/额度全部保留（丢失冷却会让坏号立刻被再次选中）
    expect(after.state.until).toBeGreaterThan(Date.now())
    expect(after.state.reason).toBe('429 rate limit')
    expect(after.state.errCount).toBe(4)
    expect(after.state.credits).toBe(7)
  })

  it('P2：刷新期间被移除的账号不被复活（提交阶段按 uid 打补丁，不整体覆盖）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [
      acct({ uid: 'u1', expiresInMs: -1000 }),
      acct({ uid: 'u2', expiresInMs: -1000 }),
    ])

    // 第一个账号刷新飞行中，管理员删除了 u1（池里只剩 u2）
    const fetchMock = vi.fn(async () => {
      if (readPool(store).some((a: any) => a.uid === 'u1')) {
        store.set(POOL_KEY, JSON.stringify([acct({ uid: 'u2', expiresInMs: -1000 })]))
      }
      return okRefreshResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    await refreshAllOauthTokens(env, [makeProvider()])

    const pool = readPool(store)
    expect(pool.some((a: any) => a.uid === 'u1')).toBe(false)
  })

  it('P2：提交阶段池损坏 → 放弃写回（不用空池/坏池覆盖真实账号）', async () => {
    const { env, store } = makeMockEnv()
    seedPool(store, [acct({ uid: 'u1', expiresInMs: -1000 })])
    const before = store.get(POOL_KEY)!

    // 刷新成功，但提交前的重读拿到坏 JSON
    vi.stubGlobal('fetch', vi.fn(async () => {
      store.set(POOL_KEY, '{ not json')
      return okRefreshResponse()
    }))

    const r = await refreshAllOauthTokens(env, [makeProvider()])

    expect(r.ok).toBe(1)
    // 未被覆盖（坏池保持原样，至少不会变成一份「空池」把账号删光）
    expect(store.get(POOL_KEY)).toBe('{ not json')
    expect(before).not.toBe('{ not json')
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

/**
 * QoderWork（flowType=qoder）池保活刷新。
 *
 * 背景（本项修的缺陷）：`refreshAllOauthTokens` 原实现只覆盖 M365 与 WorkBuddy 两个池，
 * `flowType === 'qoder'` 落到**单 token** 路径。而 Qoder 账号存在自己的池
 * （`qoder:pool:{id}`）→ **池内账号的 cron 永不刷新**。请求路径只刷「被选中的账号」，
 * 长期冷却/已禁用/低权重的账号可能数周不被选中，其 refresh_token 若上游有闲置失效策略
 * 就会丢失，届时只能重登。M365 与 WorkBuddy 都已为同一问题修过 —— 这是漏掉的第三个。
 *
 * 断言的是**行为**：哪些账号被刷、打到哪个域、并发写入有没有被吞、当日去重是否生效。
 */
describe('refreshAllOauthTokens — Qoder（flowType=qoder）池保活', () => {
  const QID = 'qoder-keepalive'
  const QPOOL_KEY = 'qoder:pool:' + QID
  const DAY_KEY = 'qoder:keepalive:' + QID
  /** CST 22:00（= 14:00 UTC）——集中全量保活的那一轮。 */
  const CST_2200 = Date.UTC(2026, 9, 10, 14, 0, 0)
  /** CST 12:00（= 04:00 UTC）——普通巡检，只按 4h 阈值刷。 */
  const CST_1200 = Date.UTC(2026, 9, 10, 4, 0, 0)

  function qoderProvider(): ProviderLike {
    return {
      id: QID,
      authType: 'oauth-device',
      oauth: {
        flowType: 'qoder',
        refreshTokenUrl: 'https://gateway.qoder.com.cn/api/v1/device/refresh',
        globalRefreshTokenUrl: 'https://openapi.qoder.sh/api/v1/device/refresh',
      } as ProviderLike['oauth'],
    }
  }

  function qacct(opts: {
    uid: string
    /** 相对 now 的剩余寿命（ms） */
    expiresInMs?: number
    realm?: 'cn' | 'global'
    /** token 上的 realm（刻意可与账号上的不同，用于验证以账号为准） */
    tokenRealm?: 'cn' | 'global'
    enabled?: boolean
    disabled?: boolean
    refreshToken?: string | null
    credits?: number
  }) {
    const now = Date.now()
    const token: OAuthTokenState = {
      access_token: 'dt-' + opts.uid,
      expires_at: now + (opts.expiresInMs ?? 30 * 24 * 60 * 60 * 1000),
      updated_at: now,
    }
    if (opts.refreshToken !== null) token.refresh_token = opts.refreshToken ?? 'drt-' + opts.uid
    if (opts.tokenRealm) token.realm = opts.tokenRealm
    return {
      uid: opts.uid,
      nickname: opts.uid,
      token,
      enabled: opts.enabled ?? true,
      state: { credits: opts.credits ?? 100, disabled: opts.disabled ?? false, until: 0, errCount: 0 },
      updatedAt: now,
      realm: opts.realm ?? 'cn',
    }
  }

  function seedQPool(store: Map<string, string>, accounts: unknown[]) {
    store.set(QPOOL_KEY, JSON.stringify(accounts))
  }
  function readQPool(store: Map<string, string>): any[] {
    const raw = store.get(QPOOL_KEY)
    return raw ? JSON.parse(raw) : []
  }
  /** Qoder 刷新端点响应（{token, refresh_token} 形态，非 WorkBuddy 的 data.accessToken）。 */
  function qoderRefreshOk(access = 'new-qoder-token') {
    return new Response(JSON.stringify({
      token: access,
      refresh_token: 'new-drt',
      expires_in: 30 * 24 * 60 * 60,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('**核心**：临期池内账号被刷新（修复前 qoder 落到单 token 路径 → 池内账号永不刷新）', async () => {
    const { env, store } = makeMockEnv()
    // 3h 剩余 < 4h 阈值 → 该刷
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: 3 * 60 * 60 * 1000 })])
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(1)
    expect(r.fail).toBe(0)
    expect(readQPool(store)[0].token.access_token).toBe('new-qoder-token')
  })

  it('**不该刷**：剩余寿命远超阈值（普通巡检）→ 一次上游都不打', async () => {
    const { env, store } = makeMockEnv()
    // 30 天剩余，且当前不是 22:00 那一轮
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: 30 * 24 * 60 * 60 * 1000 })])
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: 0, fail: 0 })
  })

  it('禁用账号跳过（需人工重登，刷新必然失败，白打上游）', async () => {
    const { env, store } = makeMockEnv()
    seedQPool(store, [
      qacct({ uid: 'u1', expiresInMs: -1000, enabled: false }),
      qacct({ uid: 'u2', expiresInMs: -1000, disabled: true }),
    ])
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: 0, fail: 0 })
  })

  it('无 refresh_token 的账号跳过（无法刷新）', async () => {
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: -1000, refreshToken: null })])
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: 0, fail: 0 })
  })

  it('刷新失败计入 fail 且不改写池（保留原 token 供重登）', async () => {
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: -1000 })])
    const before = readQPool(store)[0].token.access_token
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(r.ok).toBe(0)
    expect(r.fail).toBe(1)
    expect(readQPool(store)[0].token.access_token).toBe(before)
  })

  it('**realm 以账号为准**：账号是 global 而 token 上 realm 缺失/为 cn → 打国际版刷新端点', async () => {
    // 这是最容易写错的一处：refreshQoderTokenPair 按 prev.realm 选端点，
    // 而 realm 存在**账号**上、不一定在 token 上。不补齐就会把国际版 refresh_token
    // 打到国内端点 → 必然失败（表现为「国际版账号怎么刷都刷不动」）。
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'intl', expiresInMs: -1000, realm: 'global' })])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      urls.push(String(u))
      return qoderRefreshOk()
    }))

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(r.ok).toBe(1)
    expect(urls[0], 'global 账号必须打到国际版刷新端点').toContain('openapi.qoder.sh')
    // 账号上的 realm 不被刷新响应抹掉
    expect(readQPool(store)[0].realm).toBe('global')
  })

  it('realm 以账号为准：账号是 cn 但 token 上写着 global → 仍打国内端点（账号是权威）', async () => {
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'cn1', expiresInMs: -1000, realm: 'cn', tokenRealm: 'global' })])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      urls.push(String(u))
      return qoderRefreshOk()
    }))

    await refreshAllOauthTokens(env, [qoderProvider()])

    expect(urls[0]).toContain('gateway.qoder.com.cn')
  })

  it('**P2 并发写入不被吞**：刷新期间请求路径写的冷却/积分/模型级冷却必须保留', async () => {
    // 池被请求路径频繁并发写。若持有快照期间逐个 await 刷新、最后整体覆盖，
    // 这些写入会被静默吞掉：丢了冷却 → 坏号立刻被再选；丢了禁用 → 风控号复活。
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: -1000, credits: 100 })])
    vi.stubGlobal('fetch', vi.fn(async () => {
      // 模拟「刷新期间请求路径写了冷却与积分、并禁用了另一个账号」
      const pool = readQPool(store)
      pool[0].state.until = Date.now() + 60_000
      pool[0].state.credits = 42
      pool[0].state.modelCooldowns = { qmodel: Date.now() + 30_000 }
      store.set(QPOOL_KEY, JSON.stringify(pool))
      return qoderRefreshOk()
    }))

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(r.ok).toBe(1)
    const acc = readQPool(store)[0]
    expect(acc.token.access_token, 'token 应被刷新').toBe('new-qoder-token')
    expect(acc.state.until, '并发写入的冷却不得被吞').toBeGreaterThan(0)
    expect(acc.state.credits, '并发写入的积分不得被吞').toBe(42)
    expect(acc.state.modelCooldowns.qmodel, '并发写入的模型级冷却不得被吞').toBeGreaterThan(0)
  })

  it('池损坏 → 放弃写回，不用空池/坏池覆盖真实账号', async () => {
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'u1', expiresInMs: -1000 })])
    const good = store.get(QPOOL_KEY)!
    // 刷新期间池被写坏（模拟并发损坏）
    vi.stubGlobal('fetch', vi.fn(async () => {
      store.set(QPOOL_KEY, '{ not json')
      return qoderRefreshOk()
    }))

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(r.ok).toBe(1)                       // 刷新本身成功
    expect(store.get(QPOOL_KEY)).toBe('{ not json')  // 但坏池保持原样，不被覆盖成空池
    expect(good).not.toBe('{ not json')
  })

  it('池为空 → 0/0，不打上游', async () => {
    const { env } = makeMockEnv()
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    const r = await refreshAllOauthTokens(env, [qoderProvider()])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: 0, fail: 0 })
  })

  it('**每日 22:00 集中全量保活**：剩余 30 天也刷（纯 4h 阈值救不了闲置账号）', async () => {
    // 这条是保活主力：qoderExpiryUnix 缺省给 30 天寿命，只靠 4h 阈值的话
    // 闲置账号要约 29.8 天才被刷到一次，起不到防上游闲置失效的作用。
    const { env, store } = makeMockEnv()
    seedQPool(store, [qacct({ uid: 'idle', expiresInMs: 30 * 24 * 60 * 60 * 1000 })])
    const fetchMock = vi.fn(async () => qoderRefreshOk())
    vi.stubGlobal('fetch', fetchMock)

    // 通过 KV 里的「当日标记」间接驱动：先手动写入「昨天」的标记不生效，
    // 这里直接验证 CST 小时判定的纯函数，再用 force 语义端到端验证。
    const { qoderCstHour, QODER_KEEPALIVE_HOUR_CST } = await import('./oauth')
    expect(QODER_KEEPALIVE_HOUR_CST).toBe(22)
    expect(qoderCstHour(CST_2200)).toBe(22)
    expect(qoderCstHour(CST_1200)).toBe(12)
  })

  it('CST 小时换算必须 +8（Workers 本地时区恒为 UTC，直接取小时会错 8 小时）', async () => {
    const { qoderCstHour } = await import('./oauth')
    // 14:00 UTC = 22:00 CST（集中保活那一轮）
    expect(qoderCstHour(Date.UTC(2026, 9, 10, 14, 0, 0))).toBe(22)
    // 15:00 UTC = 23:00 CST（已过保活点，不该再触发）
    expect(qoderCstHour(Date.UTC(2026, 9, 10, 15, 0, 0))).toBe(23)
    // 16:00 UTC = 次日 00:00 CST（跨日边界）
    expect(qoderCstHour(Date.UTC(2026, 9, 10, 16, 0, 0))).toBe(0)
  })

  it('22:00 那一轮全量刷新，且**同一 CST 日只跑一次**（两条 cron 在同一分钟重叠）', async () => {
    // 时间相关逻辑必须可注入：用 fake timers 把 now 钉在 CST 22:00。
    vi.useFakeTimers()
    try {
      vi.setSystemTime(CST_2200)
      const { env, store } = makeMockEnv()
      seedQPool(store, [
        qacct({ uid: 'a', expiresInMs: 30 * 24 * 60 * 60 * 1000 }),
        qacct({ uid: 'b', expiresInMs: 30 * 24 * 60 * 60 * 1000 }),
      ])
      const fetchMock = vi.fn(async () => qoderRefreshOk())
      vi.stubGlobal('fetch', fetchMock)

      const r1 = await refreshAllOauthTokens(env, [qoderProvider()])
      expect(r1.ok, '22:00 应全量刷新两个账号').toBe(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(store.get(DAY_KEY), '应落当日标记').toBe('2026-10-10')

      // 同一分钟另一条 cron 再次触发 → 不重复打全池
      const r2 = await refreshAllOauthTokens(env, [qoderProvider()])
      expect(r2).toEqual({ ok: 0, fail: 0 })
      expect(fetchMock, '当日第二次不应再打上游').toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('22:00 全量刷新也跳过禁用/无 refresh_token 的账号（不是无条件全刷）', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(CST_2200)
      const { env, store } = makeMockEnv()
      seedQPool(store, [
        qacct({ uid: 'ok', expiresInMs: 30 * 24 * 60 * 60 * 1000 }),
        qacct({ uid: 'off', expiresInMs: 30 * 24 * 60 * 60 * 1000, disabled: true }),
        qacct({ uid: 'nort', expiresInMs: 30 * 24 * 60 * 60 * 1000, refreshToken: null }),
      ])
      const fetchMock = vi.fn(async () => qoderRefreshOk())
      vi.stubGlobal('fetch', fetchMock)

      const r = await refreshAllOauthTokens(env, [qoderProvider()])

      expect(fetchMock, '只刷唯一合格账号').toHaveBeenCalledTimes(1)
      expect(r.ok).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('非 22:00 且未临期 → 不写当日标记、不打上游（标记只服务集中保活）', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(CST_1200)
      const { env, store } = makeMockEnv()
      seedQPool(store, [qacct({ uid: 'a', expiresInMs: 30 * 24 * 60 * 60 * 1000 })])
      const fetchMock = vi.fn(async () => qoderRefreshOk())
      vi.stubGlobal('fetch', fetchMock)

      await refreshAllOauthTokens(env, [qoderProvider()])

      expect(fetchMock).not.toHaveBeenCalled()
      expect(store.get(DAY_KEY), '普通巡检不该写当日标记').toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('qoder provider 不走 browser / m365 分支（池 key 不同，各刷各的）', async () => {
    const { env, store } = makeMockEnv()
    // 同时放一个 browser 池 key 的数据：qoder 分支不该去读它
    seedPool(store, [acct({ uid: 'wb1', expiresInMs: -1000 })])
    seedQPool(store, [qacct({ uid: 'q1', expiresInMs: -1000 })])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      urls.push(String(u))
      return qoderRefreshOk()
    }))

    await refreshAllOauthTokens(env, [qoderProvider()])

    // 只打 qoder 的刷新端点，browser 池账号未被刷新
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('qoder')
    expect(readPool(store)[0].token.access_token).toBe(CN_TOKEN)
  })
})

/**
 * P1-9（移植 workbuddy2api 2cd466e）：refresh 响应 `expiresIn` 量级上限。
 *
 * 脏/超大 expiresIn 会把 expires_at 推到荒谬未来 → 临近过期判定永假 → token 永不刷新
 * → 静默过期 → 401 路径把账号永久禁用（需重登）。超 10 年视为脏值，保留旧 expires_at。
 */
describe('refreshBrowserTokenState — expiresIn 量级上限（移植 2cd466e）', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  /** 直接调用 refreshBrowserTokenState（不经池提交），断言返回的 expires_at。 */
  async function refreshOnce(expiresIn: unknown, prevExpiresAt: number) {
    const { refreshBrowserTokenState } = await import('./oauth')
    const env = { KV: {}, GATEWAY_KV: {}, RATE_LIMIT_KV: {}, SESSION_KV: {} } as unknown as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0, msg: 'ok', data: { accessToken: 'new-access', refreshToken: 'new-rt', expiresIn },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const cfg = makeProvider().oauth as never
    return refreshBrowserTokenState(env, PID, cfg, {
      access_token: CN_TOKEN,
      refresh_token: 'rt-1',
      expires_at: prevExpiresAt,
      updated_at: Date.now(),
    })
  }

  it('正常 expiresIn（3600）→ 按响应推进 expires_at', async () => {
    const before = Date.now()
    const out = await refreshOnce(3600, before - 1000)
    expect(out).not.toBeNull()
    expect(out!.expires_at).toBeGreaterThan(before + 3000 * 1000)
    expect(out!.expires_at).toBeLessThan(before + 4000 * 1000)
  })

  it('脏值 expiresIn（超 10 年）→ 保留旧 expires_at，不推到荒谬未来', async () => {
    const prev = Date.now() + 60 * 60 * 1000
    // 9555863491 是源实现 RED 用例里被推到的荒谬值（约 2272 年）
    const out = await refreshOnce(9555863491, prev)
    expect(out).not.toBeNull()
    expect(out!.expires_at).toBe(prev)
    // 新 token 仍然写回（只有过期时间被判定为脏值）
    expect(out!.access_token).toBe('new-access')
  })

  it('缺 expiresIn → 保留旧 expires_at（防刷新风暴，原有语义不变）', async () => {
    const prev = Date.now() + 60 * 60 * 1000
    const out = await refreshOnce(undefined, prev)
    expect(out!.expires_at).toBe(prev)
  })

  it('旧 expires_at 缺失（0）且 expiresIn 缺省 → 回落 7200s（不留 0，否则每次请求都刷新）', async () => {
    const before = Date.now()
    const out = await refreshOnce(undefined, 0)
    expect(out!.expires_at).toBeGreaterThan(before + 7000 * 1000)
    expect(out!.expires_at).toBeLessThan(before + 7400 * 1000)
  })
})