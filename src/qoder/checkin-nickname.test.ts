/**
 * checkin-nickname.test.ts — 签到路径把 Qoder 账号昵称补进池里（面板「uid=…（昵称）」的数据来源）。
 *
 * 用户报的现象（2026-10-07）：「qoder 现在只显示 01a0fb50-84b9-7848-a8d1-240c89950b79 一长串的 id，
 * 能不能像 workbuddy 或者 traework 那样展示昵称」。
 *
 * 为什么光加一个 fetch 不够、必须回到签到路径测：Qoder 授权/刷新响应都不带名字，
 * **已经在池里的老账号永远不会因为重新登录而补上名字**，唯一会周期性重访每个账号的地方就是签到。
 * 而这个回填必须放在「今日已签」早退（status.todayCheckedIn 分支）**之前** ——
 * 放后面的话，日常最常走的「已签到」路径永远补不上名字，功能等于没做。
 *
 * 反向边界同样钉住：
 *   - 已有真昵称的账号不再白发一次上游请求；
 *   - 上游失败/没名字时昵称保持为空（面板回退 `uid=xxx`），且**不能**退回拿 uid 冒充昵称。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkinOneAccount } from '../checkin'
import { clearCache } from '../storage'
import { readQoderPool, writeQoderPool, type QoderPoolAccount } from './pool'
import type { Env, Provider } from '../types'

/** 线上真实账号的 uid（来自用户报的那一行），专测「长 UUID 冒充昵称」这条历史脏数据。 */
const REAL_UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'

const QUOTA_JSON = {
  userId: REAL_UID,
  userType: 'personal_professional_trial',
  usageType: 'credits',
  isQuotaExceeded: false,
  expiresAt: 1792146789293,
  userQuota: { total: 300, used: 0, remaining: 300, unit: 'credits' },
  addOnQuota: { total: 100, used: 0, remaining: 100, unit: 'credits' },
}

function qoderProvider(id: string): Provider {
  return {
    id,
    name: 'QoderWork 昵称回填',
    authType: 'oauth-device',
    baseUrl: 'https://gateway.qoder.com.cn',
    apiKeys: [],
    models: [],
    enabled: true,
    oauth: {
      flowType: 'qoder',
      deviceCodeUrl: 'https://qoder.com.cn/device/selectAccounts',
      deviceTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
      refreshTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh',
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

/** 池账号：realm=global 是为了跳过 legacy 状态探测，少一处无关 stub。 */
function account(uid: string, nickname?: string): QoderPoolAccount {
  return {
    uid,
    nickname,
    token: { access_token: 'dt-' + uid, refresh_token: 'drt-' + uid, expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'global',
  }
}

interface StubOpts {
  /** userinfo 返回体；null 表示模拟失败（500） */
  userInfo?: Record<string, unknown> | null
}

function stubFetch(opts: StubOpts = {}) {
  const urls: string[] = []
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/api/v1/userinfo')) {
      if (opts.userInfo === null) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify(opts.userInfo ?? { id: REAL_UID, name: 'Shiro' }), { status: 200 })
    }
    // 活动列表：没有可领活动（本测试不关心签到结果，只关心昵称回填是否发生）
    if (url.includes('/sash/api/v1/me/campaigns')) {
      return new Response(JSON.stringify({ showCampaign: true, claimable: false, campaigns: [] }), { status: 200 })
    }
    if (url.includes('/api/v2/quota/usage')) {
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    }
    if (url.includes('/api/v2/user/plan')) {
      return new Response(JSON.stringify({ plan_tier_name: 'Pro Trial' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return { mock, urls }
}

beforeEach(() => { clearCache() })
afterEach(() => { vi.unstubAllGlobals(); clearCache() })

describe('签到回填昵称：没有名字的池账号在签到后拿到 /api/v1/userinfo 的 name', () => {
  it('空昵称 → 签到后池里是上游真名，且签到结果里的 nickname 不再是 uid', async () => {
    const pid = 'qoder-nick-c1'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account(REAL_UID)])

    const { urls } = stubFetch()
    const r = await checkinOneAccount(env, provider)

    expect(urls.some((u) => u.includes('/api/v1/userinfo'))).toBe(true)
    expect((await readQoderPool(env, pid))[0].nickname).toBe('Shiro')
    expect(r.accounts?.[0].nickname).toBe('Shiro')
  })

  it('历史脏数据（nickname === uid）→ 被真名覆盖，面板不再显示一长串 UUID', async () => {
    const pid = 'qoder-nick-c2'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account(REAL_UID, REAL_UID)])

    stubFetch()
    await checkinOneAccount(env, provider)

    expect((await readQoderPool(env, pid))[0].nickname).toBe('Shiro')
  })

  it('已有真昵称 → 不再请求 userinfo（避免每天每账号白跑一次上游）', async () => {
    const pid = 'qoder-nick-c3'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account(REAL_UID, 'Shiro')])

    const { urls } = stubFetch({ userInfo: { id: REAL_UID, name: '改了名' } })
    await checkinOneAccount(env, provider)

    expect(urls.some((u) => u.includes('/api/v1/userinfo'))).toBe(false)
    expect((await readQoderPool(env, pid))[0].nickname).toBe('Shiro')
  })

  it('userinfo 失败 → 昵称保持为空（面板回退 uid=xxx），且签到流程不受影响', async () => {
    const pid = 'qoder-nick-c4'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account(REAL_UID)])

    stubFetch({ userInfo: null })
    const r = await checkinOneAccount(env, provider)

    expect((await readQoderPool(env, pid))[0].nickname).toBeFalsy()
    // 不能拿 uid 冒充昵称（否则面板又回到「显示一长串 id」）
    expect(r.accounts?.[0].nickname).not.toBe(REAL_UID)
    // 签到本身照常跑完（额度写回说明走到了 syncQoderPoolCredits）
    expect((await readQoderPool(env, pid))[0].state.credits).toBe(400)
  })

  it('上游返回空 name → 不写空值，池里保持无昵称（不清掉、也不编造）', async () => {
    const pid = 'qoder-nick-c5'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account(REAL_UID)])

    stubFetch({ userInfo: { id: REAL_UID, name: '' } })
    await checkinOneAccount(env, provider)

    expect((await readQoderPool(env, pid))[0].nickname).toBeFalsy()
  })
})

describe('多账号：每个账号各自回填自己的名字', () => {
  it('两个账号 → 各自拿到 userinfo 里对应 uid 的 name，不串号', async () => {
    const pid = 'qoder-nick-c6'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account('uid-a'), account('uid-b')])

    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v1/userinfo')) {
        // 按 Bearer 里的 token 分辨是哪个账号的请求
        const auth = String(((init?.headers || {}) as Record<string, string>)['Authorization'] || '')
        const name = auth.endsWith('uid-a') ? '甲' : '乙'
        return new Response(JSON.stringify({ id: auth.slice(-5), name }), { status: 200 })
      }
      if (url.includes('/sash/api/v1/me/campaigns')) {
        return new Response(JSON.stringify({ showCampaign: true, campaigns: [] }), { status: 200 })
      }
      if (url.includes('/api/v2/quota/usage')) return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
      return new Response('{}', { status: 200 })
    }))

    await checkinOneAccount(env, provider)

    const pool = await readQoderPool(env, pid)
    expect(pool.find((a) => a.uid === 'uid-a')!.nickname).toBe('甲')
    expect(pool.find((a) => a.uid === 'uid-b')!.nickname).toBe('乙')
  })
})
