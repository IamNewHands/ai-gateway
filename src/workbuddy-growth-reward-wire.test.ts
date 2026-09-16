import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkinOneAccount } from './checkin'
import { writeOauthPool, __resetOauthPoolRuntimeForTests } from './oauth-pool'
import { clearCache } from './storage'
import { REDEEM_TRIED_KV_PREFIX, cstDay } from './workbuddy-billing'
import type { Env, OAuthTokenState, Provider } from './types'

/**
 * 连登奖励接线测试（移植 workbuddy2api 91418c5 → checkin.ts）。
 *
 * 单元测试已覆盖 `runWorkbuddyGrowthRewards` 自身；本文件证明它**真的接进了签到路径**：
 *  1. CN 账号签到后确实调用了 growth 域端点；
 *  2. 结果写进 CheckinResult.growthReward；
 *  3. global 账号**不**调用 growth 端点（门控）；
 *  4. 幂等闸跨调用生效（KV 日键）。
 */

const PID = 'wb-growth-wire'

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
    name: 'WB Growth Wire',
    authType: 'oauth-device',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiKeys: [],
    models: [],
    enabled: true,
    oauth: {
      flowType: 'browser',
      deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state',
      deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
      refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
      tokenHeader: 'Authorization',
      tokenHeaderPrefix: 'Bearer ',
      maxInFlight: 3,
    },
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

/** 记录所有出站请求 URL，并按需给出 growth 域响应。 */
function installFetchMock(calls: string[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push(u)
    if (u.includes('/activity/growth/streak')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'ok',
        data: { streak: { days: 20 }, redemption_status: { tier_14d_status: 'available' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('/activity/growth/redeem')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'ok',
        data: { credit_granted: 200, chances_granted: 1, energy_granted: 5, cards_granted: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('/activity/growth/lottery/draw')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'ok', data: { prize_name: '10 积分', credit_amount: 10 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('连登奖励接线（checkinOneAccount → runWorkbuddyGrowthRewards）', () => {
  let calls: string[]

  beforeEach(() => {
    __resetOauthPoolRuntimeForTests()
    clearCache()
    calls = []
    vi.stubGlobal('fetch', installFetchMock(calls))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('CN 账号签到后调用 growth 端点并把结果写进 growthReward', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    const result = await checkinOneAccount(env, makeProvider(), { interactive: true })

    // 接线证明：growth 域端点被调用
    expect(calls.some((u) => u.includes('/activity/growth/streak'))).toBe(true)
    expect(calls.some((u) => u.includes('/activity/growth/redeem'))).toBe(true)

    // 结果写进池账号结果（池化路径 accounts[]）
    const acct = result.accounts?.[0]
    expect(acct).toBeDefined()
    expect(acct!.growthReward).toBeDefined()
    expect(acct!.growthReward!.acted).toBe(true)
    expect(acct!.growthReward!.tier).toBe('14d')
    expect(acct!.growthReward!.credit).toBe(200)
  })

  it('growth 端点打到 CN 域（copilot.tencent.com / codebuddy.cn）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await checkinOneAccount(env, makeProvider(), { interactive: true })

    const growthCalls = calls.filter((u) => u.includes('/activity/growth/streak'))
    expect(growthCalls.length).toBeGreaterThan(0)
    expect(growthCalls[0]).not.toContain('workbuddy.ai')
  })

  it('global 账号不调用兑换/抽奖端点（门控跳过），也不写 growthReward', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'global-user', token: makeToken(GLOBAL_JWT) }])

    const result = await checkinOneAccount(env, makeProvider(), { interactive: true })

    // global 门控：兑换与抽奖链一次都不该被调用。
    // 注意 `/activity/growth/streak` 是**既有**行为——global 路径一直读连登天数用于面板展示
    // （checkin.ts 的 global 分支），本移植没有改动它，故这里不断言该端点。
    expect(calls.some((u) => u.includes('/activity/growth/redeem'))).toBe(false)
    expect(calls.some((u) => u.includes('/activity/growth/lottery'))).toBe(false)
    // 也不该写 growthReward 字段
    expect(result.accounts?.[0]?.growthReward).toBeUndefined()
  })

  it('幂等闸生效：签到两次，第二次不再打兑换/抽奖端点', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await checkinOneAccount(env, makeProvider(), { interactive: true })
    const redeemsAfterFirst = calls.filter((u) => u.includes('/activity/growth/redeem')).length
    const drawsAfterFirst = calls.filter((u) => u.includes('/activity/growth/lottery/draw')).length
    expect(redeemsAfterFirst).toBe(1)
    expect(drawsAfterFirst).toBe(1)

    await checkinOneAccount(env, makeProvider(), { interactive: true })
    const redeemsAfterSecond = calls.filter((u) => u.includes('/activity/growth/redeem')).length
    const drawsAfterSecond = calls.filter((u) => u.includes('/activity/growth/lottery/draw')).length
    // KV 日键命中 → 第二次的**写链**整链跳过（兑换/抽奖都不再发）
    expect(redeemsAfterSecond).toBe(1)
    expect(drawsAfterSecond).toBe(1)
    // 而 `/activity/growth/streak` 是**只读展示 oracle**，每次签到都应读最新连登天数
    // （幂等闸只挡写操作，不挡读）——故它的调用次数会随签到次数增长。
    expect(calls.filter((u) => u.includes('/activity/growth/streak')).length).toBe(2)
  })

  it('一次签到只读一次 /activity/growth/streak（展示与兑换复用同一次读取）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await checkinOneAccount(env, makeProvider(), { interactive: true })

    // 上游 GrowthRewardState 设计为"一次 GET 读完 days + redemption_status，免二次请求"。
    // 若兑换链自己再读一次，这里会是 2。
    expect(calls.filter((u) => u.includes('/activity/growth/streak')).length).toBe(1)
  })

  it('幂等闸写的是 KV 日键（key 含 providerId:uid，值为 CST 日期）', async () => {
    const { env, store } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    await checkinOneAccount(env, makeProvider(), { interactive: true })

    const key = `${REDEEM_TRIED_KV_PREFIX}${PID}:cn-user`
    expect(store.get(key)).toBe(cstDay())
  })

  it('growth 端点全挂也不影响签到成功语义（失败隔离）', async () => {
    const { env } = makeEnv([makeProvider()])
    await seed(env, [{ uid: 'cn-user', token: makeToken(CN_JWT) }])

    // growth 域返回 500，其他照常
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      calls.push(u)
      if (u.includes('/activity/growth/')) return new Response('down', { status: 500 })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))

    const result = await checkinOneAccount(env, makeProvider(), { interactive: true })
    const acct = result.accounts?.[0]
    // 签到本身仍成功（growth 失败不改 base.success，与 catTravel 同口径）
    expect(acct!.success).toBe(true)
    expect(acct!.growthReward).toBeDefined()
    expect(acct!.growthReward!.acted).toBe(false)
  })
})
