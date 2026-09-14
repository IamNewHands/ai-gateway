import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleOAuthActivity, handleOAuthTravel } from './checkin'
import { writeOauthPool, __resetOauthPoolRuntimeForTests } from './oauth-pool'
import type { AppEnv, Env, OAuthTokenState, Provider } from './types'

/**
 * 国际版（global）账号在**手动触发端点**上的 realm 门控测试
 * （移植 workbuddy2api a190252 / PR #45：活跃上报放开 global，旅行仍跳过）。
 */

const PID = 'wb-global-gate'

function makeJwt(iss: string, uid: string): string {
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return `${b64url({ alg: 'HS256' })}.${b64url({ iss, uid })}.sig`
}

const CN_JWT = makeJwt('https://www.codebuddy.cn', 'cn-user')
const GLOBAL_JWT = makeJwt('https://www.workbuddy.ai', 'global-user')

function makeToken(accessToken: string): OAuthTokenState {
  return {
    access_token: accessToken,
    refresh_token: 'rt',
    expires_at: Date.now() + 2 * 60 * 60 * 1000,
    updated_at: Date.now(),
  } as OAuthTokenState
}

function makeProvider(): Provider {
  return {
    id: PID,
    name: 'WB Global Gate',
    authType: 'oauth-device',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiKeys: [],
    models: [],
    enabled: true,
    oauth: { flowType: 'browser' } as Provider['oauth'],
  } as unknown as Provider
}

function makeEnv(providers: Provider[]) {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(providers))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { env: { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env, store }
}

/** 最小 Context 替身（仅用到 c.req.param / c.json / c.env）。 */
function makeContext(env: Env, id: string) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
  return {
    env,
    req: { param: () => id },
    json,
  } as unknown as Parameters<typeof handleOAuthActivity>[0]
}

interface Call { url: string; body: string }

function installFetchMock(calls: Call[], ok = true) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: u, body: typeof init?.body === 'string' ? init.body : '' })
    if (!ok) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

async function seed(env: Env, accounts: Array<{ uid: string; token: OAuthTokenState }>) {
  await writeOauthPool(env, PID, accounts.map((a) => ({
    uid: a.uid,
    nickname: a.uid,
    token: a.token,
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
  })))
}

describe('handleOAuthActivity（活跃上报：CN + global 都上报）', () => {
  let calls: Call[]
  beforeEach(() => {
    __resetOauthPoolRuntimeForTests()
    calls = []
    vi.stubGlobal('fetch', installFetchMock(calls))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('global 账号走 workbuddy.ai 域上报（不再硬编码 cn）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'global-user', token: makeToken(GLOBAL_JWT) }])

    await handleOAuthActivity(makeContext(env, PID))

    expect(calls.length).toBeGreaterThan(0)
    // 5 条上报全部打到 global 域
    for (const c of calls) {
      expect(c.url).toContain('www.workbuddy.ai')
      expect(c.url).toContain('/v2/report')
    }
    expect(calls.length).toBe(5)
  })

  it('CN 账号仍走 codebuddy.cn 域（零回归）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await handleOAuthActivity(makeContext(env, PID))

    expect(calls.length).toBe(5)
    for (const c of calls) {
      expect(c.url).toContain('www.codebuddy.cn')
    }
  })

  it('混池：CN 与 global 各自路由到对应域', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [
      { uid: 'cn-user', token: makeToken(CN_JWT) },
      { uid: 'global-user', token: makeToken(GLOBAL_JWT) },
    ])

    await handleOAuthActivity(makeContext(env, PID))

    const cnCalls = calls.filter((c) => c.url.includes('www.codebuddy.cn'))
    const globalCalls = calls.filter((c) => c.url.includes('www.workbuddy.ai'))
    expect(cnCalls.length).toBe(5)
    expect(globalCalls.length).toBe(5)
  })

  it('上报事件带 userId（缺失会被上游静默丢弃）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'global-user', token: makeToken(GLOBAL_JWT) }])

    await handleOAuthActivity(makeContext(env, PID))

    const body = JSON.parse(calls[0].body)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].userId).toBe('global-user')
    expect(body[0].eventCode).toBe('chat_request_send')
  })

  it('禁用账号跳过', async () => {
    const { env, store } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'global-user', token: makeToken(GLOBAL_JWT) }])
    const pool = JSON.parse(store.get('oauth:pool:' + PID)!)
    pool[0].state.disabled = true
    store.set('oauth:pool:' + PID, JSON.stringify(pool))
    // 清池缓存（readOauthPool 有 1s 内存缓存）
    const { readOauthPool, writeOauthPool: write } = await import('./oauth-pool')
    const fresh = await readOauthPool(env, PID)
    fresh[0].state.disabled = true
    await write(env, PID, fresh)

    await handleOAuthActivity(makeContext(env, PID))

    expect(calls.length).toBe(0)
  })
})

describe('handleOAuthTravel（猫猫旅行：global 跳过）', () => {
  let calls: Call[]
  beforeEach(() => {
    __resetOauthPoolRuntimeForTests()
    calls = []
    vi.stubGlobal('fetch', installFetchMock(calls))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('global 账号跳过旅行（不发任何上游请求）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'global-user', token: makeToken(GLOBAL_JWT) }])

    await handleOAuthTravel(makeContext(env, PID))

    // global 无猫猫旅行体系（D4 门控）→ 零上游调用
    expect(calls.length).toBe(0)
  })

  it('CN 账号照常巡检旅行', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await handleOAuthTravel(makeContext(env, PID))

    // 至少发出 buddy/info 查询
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].url).toContain('/activity/growth/buddy/info')
  })

  it('混池：仅 CN 账号被巡检', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [
      { uid: 'cn-user', token: makeToken(CN_JWT) },
      { uid: 'global-user', token: makeToken(GLOBAL_JWT) },
    ])

    await handleOAuthTravel(makeContext(env, PID))

    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url).toContain('copilot.tencent.com')
    }
  })
})
