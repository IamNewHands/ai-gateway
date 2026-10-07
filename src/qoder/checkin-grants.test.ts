/**
 * checkin-grants.test.ts — 签到路径维护 Qoder 加购额度的**按笔记账**（面板逐笔到期 + 挑号依据）。
 *
 * 用户报的现象（2026-10-07）：「签到明细里 签到/赠送额度 显示 0 / 600 credits、
 * 到期 2026-11-06（剩 30 天）……正常应该每天签到获得 100，之前签到获取的 100 到期时间
 * 应该是不一样的，汇总起来导致到期时间一直在变」。
 *
 * 上游只给聚合桶，所以**只有签到路径**能观测到"这一笔的到期时间"（claim 响应的 expiresAt），
 * 本文件就钉住这条链路：新领 → 入账一笔；已领 → 不入账但照常结算；
 * 连续多天 → 多笔、各有各的到期时间（这正是旧实现丢掉的信息）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkinOneAccount } from '../checkin'
import { clearCache } from '../storage'
import { readQoderPool, writeQoderPool, type QoderPoolAccount } from './pool'
import type { Env, Provider } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000
const UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'
/** 2026-10-02 10:06:16 CST（用户首次签到的时刻）。 */
const DAY1 = Date.UTC(2026, 9, 2, 2, 6, 16)

function qoderProvider(id: string): Provider {
  return {
    id,
    name: 'QoderWork 账本',
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

/** 池账号：realm=global 跳过 legacy 状态探测，少一处无关 stub。 */
function account(over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid: UID,
    nickname: 'Shiro',
    token: { access_token: 'dt-test', refresh_token: 'drt-test', expires_at: Date.now() + 30 * DAY_MS, updated_at: 0 },
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'global',
    ...over,
  }
}

interface StubOpts {
  /** 活动列表响应体 */
  campaigns?: unknown
  /** claim 响应体（缺省 = 不返回 claim，走 already 路径） */
  claim?: unknown
  /** 加购桶（上游口径 total/used/remaining） */
  addon?: { total: number; used: number; remaining: number }
  /** 额度接口失败（模拟上游 500） */
  quotaFails?: boolean
}

/** 可领的每日活动（benefit 100）。 */
const CLAIMABLE = {
  showCampaign: true,
  claimable: true,
  campaigns: [{
    campaignId: 'c-daily',
    campaignKey: 'act-daily',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { kind: 'CREDITS', amount: 100 },
  }],
}

/** 今日已领（列表里就是 CLAIMED）。 */
const CLAIMED = {
  showCampaign: true,
  claimable: false,
  campaigns: [{ ...CLAIMABLE.campaigns[0], claimStatus: 'CLAIMED' }],
}

function stubFetch(opts: StubOpts = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    // 先判 /claim：领取是 POST .../campaigns/{id}/claim，URL 里**同样含** /campaigns 前缀，
    // 顺序反了就会把活动列表当成 claim 响应（表现为"签到永远失败"）。
    if (url.includes('/claim')) {
      return new Response(JSON.stringify(opts.claim ?? { status: 'CLAIMED', replayed: true }), { status: 200 })
    }
    if (url.includes('/sash/api/v1/me/campaigns')) {
      return new Response(JSON.stringify(opts.campaigns ?? CLAIMABLE), { status: 200 })
    }
    if (url.includes('/api/v2/quota/usage')) {
      if (opts.quotaFails) return new Response('boom', { status: 500 })
      const addon = opts.addon ?? { total: 100, used: 0, remaining: 100 }
      return new Response(JSON.stringify({
        userType: 'personal_professional_trial',
        isQuotaExceeded: false,
        expiresAt: 1792146789293,
        userQuota: { total: 300, used: 0, remaining: 300, unit: 'credits' },
        addOnQuota: { ...addon, unit: 'credits' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
}

beforeEach(() => { clearCache() })
afterEach(() => { vi.unstubAllGlobals(); clearCache() })

describe('签到新领 → 按笔入账（各自到期）', () => {
  it('连续 6 天签到 → 池里 6 笔、到期 11-01 ~ 11-06，不再是一个聚合到期', async () => {
    const pid = 'qoder-grants-c1'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account()])

    for (let i = 0; i < 6; i++) {
      const at = DAY1 + i * DAY_MS
      stubFetch({
        campaigns: CLAIMABLE,
        claim: {
          grantId: 'g-' + i,
          status: 'CLAIMED',
          replayed: false,
          benefit: { kind: 'CREDITS', amount: 100 },
          // 这一笔自己的 30 天有效期（ISO 串，与线上 claim 响应同形态）
          expiresAt: new Date(at + 30 * DAY_MS).toISOString(),
        },
        addon: { total: (i + 1) * 100, used: 0, remaining: (i + 1) * 100 },
      })
      await checkinOneAccount(env, provider)
    }

    const st = (await readQoderPool(env, pid))[0].state
    expect(st.addonGrants).toHaveLength(6)
    expect(st.addonGrants!.map((g) => g.size)).toEqual([100, 100, 100, 100, 100, 100])
    // 每笔比前一笔晚一天到期 —— 旧实现把整桶标成"最后一笔"，这 5 天的差距全丢了
    expect(st.addonGrants!.map((g) => g.expireAt)).toEqual([0, 1, 2, 3, 4, 5].map((i) => DAY1 + (i + 30) * DAY_MS))
    // 面板看的 packages 与账本同源：1 个套餐 + 6 笔签到
    const packs = st.packages!
    expect(packs).toHaveLength(7)
    expect(packs.slice(1).map((p) => p.expireAt)).toEqual([
      '2026-11-01 10:06:16', '2026-11-02 10:06:16', '2026-11-03 10:06:16',
      '2026-11-04 10:06:16', '2026-11-05 10:06:16', '2026-11-06 10:06:16',
    ])
    // 每笔的「各自到期」正是这一版的意义：面板上不再是 6 行共用一个到期时间
    expect(new Set(packs.slice(1).map((p) => p.expireAt)).size).toBe(6)
    // 行名带**领取日期**（at = 我们观测到这一笔的时刻）。本测试把 6 天压在同一次真实时间线上跑，
    // 所以这 6 行的 at 相同、名字也相同；线上每天跑一次，名字自然各不相同。
    expect(packs.slice(1).every((p) => /^签到额度 \d{2}-\d{2}$/.test(p.name))).toBe(true)
  })

  it('签到结果（面板明细）的包数与池里一致，不是固定 2', async () => {
    const pid = 'qoder-grants-c2'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    await writeQoderPool(env, pid, [account({
      state: {
        credits: 100, disabled: false, until: 0, errCount: 0,
        addonGrants: [{ at: DAY1 - DAY_MS, size: 100, used: 0, expireAt: DAY1 + 29 * DAY_MS }],
      },
    })])

    stubFetch({
      campaigns: CLAIMABLE,
      claim: { status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 }, expiresAt: new Date(DAY1 + 30 * DAY_MS).toISOString() },
      addon: { total: 200, used: 0, remaining: 200 },
    })
    const r = await checkinOneAccount(env, provider)

    expect(r.accounts?.[0].packCount).toBe(3) // 套餐 + 昨天那笔 + 今天那笔
    expect(r.accounts?.[0].packages).toHaveLength(3)
  })
})

describe('已签到（replayed）→ 不入账，但照常结算', () => {
  it('replayed / 列表已是 CLAIMED 的路径都不新增笔（响应里带着 amount 与 expiresAt 也一样）', async () => {
    const pid = 'qoder-grants-c3'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    const prev = [{ at: DAY1, size: 100, used: 0, expireAt: DAY1 + 30 * DAY_MS }]
    await writeQoderPool(env, pid, [account({ state: { credits: 100, disabled: false, until: 0, errCount: 0, addonGrants: prev } })])

    stubFetch({
      campaigns: CLAIMED,
      // 这条是**防线**而非今天可达的 bug：performQoderCheckin 的 replayed 分支本来就不带
      // rewardCredits（金额传不出来），所以下面那个带 amount 的 claim stub 其实不会被读到。
      // 之所以留着：账本是持久状态，一旦上游哪天在 replayed 里也回 amount，就会每天多记一笔
      // 幽灵条目，症状要到「挑号偏移」时才显现（那时已经错了几天）。见 checkin.ts 该处注释。
      claim: { status: 'CLAIMED', replayed: true, benefit: { kind: 'CREDITS', amount: 100 }, expiresAt: new Date(DAY1 + 30 * DAY_MS).toISOString() },
      addon: { total: 100, used: 0, remaining: 100 },
    })
    await checkinOneAccount(env, provider)

    expect((await readQoderPool(env, pid))[0].state.addonGrants).toEqual(prev)
  })

  it('已签到路径也要把 FIFO 结算写回（积分被消耗掉后挑号依据必须跟着变）', async () => {
    const pid = 'qoder-grants-c4'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    const prev = [
      { at: DAY1, size: 100, used: 0, expireAt: DAY1 + 30 * DAY_MS },
      { at: DAY1 + DAY_MS, size: 100, used: 0, expireAt: DAY1 + 31 * DAY_MS },
    ]
    await writeQoderPool(env, pid, [account({ state: { credits: 200, disabled: false, until: 0, errCount: 0, addonGrants: prev } })])

    // 上游说加购桶只剩 50：第一笔用完、第二笔用掉 50
    stubFetch({ campaigns: CLAIMED, addon: { total: 200, used: 150, remaining: 50 } })
    await checkinOneAccount(env, provider)

    const st = (await readQoderPool(env, pid))[0].state
    expect(st.addonGrants).toHaveLength(1)
    expect(st.addonGrants![0]).toMatchObject({ at: DAY1 + DAY_MS, size: 100, used: 50 })
  })
})

describe('额度拉取失败 → 账本原样保留', () => {
  it('上游 500 时不写账本、也不把明细擦成空', async () => {
    const pid = 'qoder-grants-c5'
    const provider = qoderProvider(pid)
    const { env } = makeEnv([provider])
    const prev = [{ at: DAY1, size: 100, used: 0, expireAt: DAY1 + 30 * DAY_MS }]
    await writeQoderPool(env, pid, [account({ state: { credits: 100, disabled: false, until: 0, errCount: 0, addonGrants: prev } })])

    stubFetch({ campaigns: CLAIMABLE, claim: { status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 }, expiresAt: new Date(DAY1 + 30 * DAY_MS).toISOString() }, quotaFails: true })
    const r = await checkinOneAccount(env, provider)

    // 签到本身照常成功（额度拉取失败不影响签到结论）
    expect(r.accounts?.[0].success).toBe(true)
    const st = (await readQoderPool(env, pid))[0].state
    expect(st.addonGrants).toEqual(prev)
  })
})
