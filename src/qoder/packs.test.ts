/**
 * packs.test.ts — Qoder 额度包的到期信息（面板「到期天数」+ 挑号「到期优先」的数据源）。
 *
 * 为什么需要它：Qoder 上游 `/api/v2/quota/usage` 只给**两个聚合桶**，其中 addOnQuota
 * （签到/赠送额度）**连到期时间都不给**。所以逐笔到期时间只能自己攒（qoder/grants.ts 的账本），
 * 而 claim 响应里的 `expiresAt` 是唯一能观测到「这一笔何时作废」的地方。
 *
 * 本文件锁两件事：
 *   1. 账本 → 包：一个包 = 一笔，各有各的到期时间（不是整桶标一个）；
 *   2. 落到挑号口径上：面板与挑号看到的都是**最早那笔**——旧实现（整桶标最后一笔）
 *      会让这个账号永远进不了 7 天窗口，最早那笔作废了也不会被优先消耗。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  QODER_EXPIRE_UNKNOWN,
  QODER_PACK_ADDON,
  QODER_PACK_BASE,
  QODER_UNBOOKED_PACK_NAME,
  buildQoderPacks,
  fetchQoderUserResource,
  legacyQoderAddonExpireAt,
  performQoderCheckin,
} from './billing'
import { formatCstWallClock, packageExpiryEntry, parseCstWallClock, soonestPackageExpiryAt, summarizeExpiringAt } from '../credit-expiry'
import type { PackageInfo } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

/** 复刻线上真实响应（2026-10-02 用户账号实测，数值原样保留，token 无关）。 */
const QUOTA_JSON = {
  userId: '01a0fb50-84b9-7848-a8d1-240c89950b79',
  userType: 'personal_professional_trial',
  usageType: 'credits',
  isQuotaExceeded: false,
  expiresAt: 1792146789293,
  userQuota: { total: 300, used: 0, remaining: 300, unit: 'credits' },
  addOnQuota: { total: 100, used: 0, remaining: 100, unit: 'credits' },
}

afterEach(() => { vi.unstubAllGlobals() })

describe('formatCstWallClock：与 parseCstWallClock 互为逆运算（同一 +08:00 口径）', () => {
  it('整秒时间戳往返一致', () => {
    const ms = Date.UTC(2026, 10, 1, 2, 52, 18)
    expect(formatCstWallClock(ms)).toBe('2026-11-01 10:52:18')
    expect(parseCstWallClock(formatCstWallClock(ms))).toBe(ms)
  })

  it('非有限 / 0 / 负数 → 空串（语义 = 长期有效或未知，不参与到期优先）', () => {
    expect(formatCstWallClock(0)).toBe('')
    expect(formatCstWallClock(-1)).toBe('')
    expect(formatCstWallClock(Number.NaN)).toBe('')
    expect(formatCstWallClock(undefined)).toBe('')
    expect(formatCstWallClock(null)).toBe('')
  })
})

describe('buildQoderPacks：一个包 = 一笔（套餐 + 账本里每笔签到各自到期）', () => {
  const split = { size: 300, used: 0, remain: 300 }
  /** 6 笔签到：10-02 ~ 10-07 各 100，到期 11-01 ~ 11-06（用户 2026-10-07 报的那个账号）。 */
  const sixGrants = [2, 3, 4, 5, 6, 7].map((d) => ({
    at: Date.UTC(2026, 9, d, 2, 6, 16), // 10-0d 10:06:16 CST
    size: 100,
    used: 0,
    expireAt: Date.UTC(2026, 10, d - 1, 2, 6, 16), // 领取 + 30 天 = 11-0(d-1) 10:06:16 CST
  }))

  it('套餐额度取 planExpiresAt；每笔签到各占一个包、各带自己的到期时间', () => {
    const planMs = Date.UTC(2026, 9, 15, 0, 0, 0)
    const packs = buildQoderPacks({ baseQuota: split, planExpiresAt: planMs }, sixGrants)
    expect(packs[0]).toMatchObject({ name: QODER_PACK_BASE, expireAt: '2026-10-15 08:00:00', size: 300, used: 0, unit: 'credits' })
    // 一屏 7 行：1 个套餐 + 6 笔签到（**不再**是「整桶 600 标一个到期时间」）
    expect(packs).toHaveLength(7)
    expect(packs.slice(1).map((p) => p.name)).toEqual([
      '签到额度 10-02', '签到额度 10-03', '签到额度 10-04', '签到额度 10-05', '签到额度 10-06', '签到额度 10-07',
    ])
    expect(packs.slice(1).map((p) => p.expireAt)).toEqual([
      '2026-11-01 10:06:16', '2026-11-02 10:06:16', '2026-11-03 10:06:16',
      '2026-11-04 10:06:16', '2026-11-05 10:06:16', '2026-11-06 10:06:16',
    ])
    expect(packs.slice(1).every((p) => p.size === 100 && p.used === 0)).toBe(true)
  })

  it('消耗落在最早那笔上（面板「已用/总额度」按笔显示，不再是一个聚合数）', () => {
    const packs = buildQoderPacks({ baseQuota: split, planExpiresAt: 0 }, [
      { ...sixGrants[0], used: 100 },
      sixGrants[1],
    ])
    expect(packs[1]).toMatchObject({ name: '签到额度 10-02', size: 100, used: 100 })
    expect(packs[2]).toMatchObject({ name: '签到额度 10-03', size: 100, used: 0 })
  })

  it('未记账余额 → 单独一个包；到期未知时给明确的未知标记，而不是「长期」', () => {
    const packs = buildQoderPacks({ baseQuota: split, planExpiresAt: 0 }, [{ at: 0, size: 600, used: 0, expireAt: 0 }])
    expect(packs[1].name).toBe(QODER_UNBOOKED_PACK_NAME)
    expect(packs[1].expireAt).toBe(QODER_EXPIRE_UNKNOWN)
    // 必须**非空**：空串会被面板渲染成「长期」，而这些分确实会过期（那才是骗人）
    expect(packs[1].expireAt).not.toBe('')
    // 同时不能被解析成时间：否则会拿一个假日期去驱动「到期优先」挑号
    expect(parseCstWallClock(packs[1].expireAt)).toBeNull()
    // 套餐到期上游没给 → 长期（空串），同样不编造
    expect(packs[0].expireAt).toBe('')
  })

  it('没有账本 → 只有套餐包（不编造签到包）', () => {
    const packs = buildQoderPacks({ baseQuota: split, planExpiresAt: 0 }, [])
    expect(packs.map((p) => p.name)).toEqual([QODER_PACK_BASE])
  })
})

describe('legacyQoderAddonExpireAt：首次迁移时把旧聚合包的上界读回来', () => {
  const prevMs = Date.UTC(2026, 10, 6, 2, 6, 16)

  it('旧聚合包（签到/赠送额度）的到期时间 → epoch ms', () => {
    const prev: PackageInfo[] = [
      { name: QODER_PACK_BASE, expireAt: '2026-10-15 08:00:00', size: 300, used: 0 },
      { name: QODER_PACK_ADDON, expireAt: formatCstWallClock(prevMs), size: 600, used: 0 },
    ]
    expect(legacyQoderAddonExpireAt(prev)).toBe(prevMs)
  })

  it('没有旧包 / 到期为空串 / 传 undefined → 0（= 未知，不编造）', () => {
    expect(legacyQoderAddonExpireAt([{ name: QODER_PACK_BASE, expireAt: '2026-10-15 08:00:00', size: 300, used: 0 }])).toBe(0)
    expect(legacyQoderAddonExpireAt([{ name: QODER_PACK_ADDON, expireAt: '', size: 600, used: 0 }])).toBe(0)
    expect(legacyQoderAddonExpireAt(undefined)).toBe(0)
  })
})

describe('fetchQoderUserResource：除聚合值外还要给出分项与套餐到期', () => {
  it('解析真实响应：totalRemain/Size 聚合、baseQuota/addonQuota 分项、planExpiresAt 为 ms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))
    const r = await fetchQoderUserResource('dt-test', 'global')
    expect(r).not.toBeNull()
    expect(r!.totalRemain).toBe(400)
    expect(r!.totalSize).toBe(400)
    expect(r!.packCount).toBe(2)
    expect(r!.planExpiresAt).toBe(1792146789293)
    expect(r!.baseQuota).toEqual({ size: 300, used: 0, remain: 300 })
    expect(r!.addonQuota).toEqual({ size: 100, used: 0, remain: 100 })
  })

  it('HTTP 非 2xx 抛错（调用方按「拉取失败」记日志，不静默当 0 额度）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(fetchQoderUserResource('dt-test', 'cn')).rejects.toThrow(/quota\/usage http 500/)
  })
})

describe('performQoderCheckin：把 claim 响应的 expiresAt 带出来', () => {
  const campaigns = {
    showCampaign: true,
    claimable: true,
    campaigns: [{ campaignId: 'c-1', campaignKey: 'act-20260930-593', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } }],
  }
  const claim = {
    grantId: 'g-1',
    status: 'CLAIMED',
    replayed: false,
    benefit: { kind: 'CREDITS', amount: 100 },
    campaignKey: 'act-20260930-593',
    expiresAt: '2026-11-01T10:52:18.531379Z',
  }

  it('新领成功 → rewardExpiresAt 为 ISO 串解析出的 epoch ms', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      return new Response(JSON.stringify(url.includes('/claim') ? claim : campaigns), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-test', 'global', 'uid-1')
    expect(r.success).toBe(true)
    expect(r.rewardCredits).toBe(100)
    expect(r.rewardExpiresAt).toBe(Date.parse('2026-11-01T10:52:18.531379Z'))
  })

  it('replayed（今日已领）→ 没有新 grant，不给 rewardExpiresAt（到期时间由池里已存的兜底）', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      return new Response(JSON.stringify(url.includes('/claim') ? { ...claim, replayed: true } : campaigns), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-test', 'global', 'uid-1')
    expect(r.success).toBe(true)
    expect(r.already).toBe(true)
    expect(r.rewardExpiresAt).toBeUndefined()
  })

  it('claim 响应缺 expiresAt / 非法 → undefined，不编造（面板回退池里已存的值）', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      return new Response(JSON.stringify(url.includes('/claim') ? { ...claim, expiresAt: 'not-a-date' } : campaigns), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-test', 'global', 'uid-1')
    expect(r.success).toBe(true)
    expect(r.rewardExpiresAt).toBeUndefined()
  })
})

describe('与挑号口径对齐：面板与挑号看到的都是**最早那笔**，不是最后一笔', () => {
  /**
   * 2026-10-07 用户报的那个账号：6 笔签到（10-02 ~ 10-07 各 100），到期 11-01 ~ 11-06。
   *
   * 旧实现把整桶 600 的到期时间标成**最后一笔**（11-06 10:06），于是在 10-28 这一刻：
   * 面板显示「剩 9 天」（窗口外）、挑号也返回 null —— 而最早那 100 分其实 4 天后就作废了。
   * 下面两条断言分别锁住新行为与旧行为的差别。
   */
  const now = Date.UTC(2026, 9, 25, 4, 0, 0) // 2026-10-25 12:00 CST（窗口右界 11-01 12:00）
  const grants = [2, 3, 4, 5, 6, 7].map((d) => ({
    at: Date.UTC(2026, 9, d, 2, 6, 16),
    size: 100,
    used: 0,
    expireAt: Date.UTC(2026, 10, d - 1, 2, 6, 16),
  }))

  it('最早那笔进 7 天窗口 → 挑号拿到的是它（旧实现拿不到，整桶看最后一笔）', () => {
    const packs = buildQoderPacks({ baseQuota: { size: 0, used: 0, remain: 0 }, planExpiresAt: 0 }, grants)
    expect(soonestPackageExpiryAt(packs, now)).toBe(Date.UTC(2026, 10, 1, 2, 6, 16))
  })

  it('旧形态（整桶标最后一笔的到期时间）在同一时刻返回 null —— 这就是"永远进不了窗口"的机制', () => {
    const legacyPack: PackageInfo[] = [
      { name: QODER_PACK_ADDON, expireAt: formatCstWallClock(Date.UTC(2026, 10, 5, 2, 6, 16)), size: 600, used: 0 },
    ]
    expect(soonestPackageExpiryAt(legacyPack, now)).toBeNull()
  })

  it('窗口内到期的金额只算真正到期的那几笔（旧形态会把整桶 600 都算成待救积分）', () => {
    const packs = buildQoderPacks({ baseQuota: { size: 0, used: 0, remain: 0 }, planExpiresAt: 0 }, grants)
    const s = summarizeExpiringAt(packs.map(packageExpiryEntry), now, 7 * DAY_MS)
    // 这一刻窗口右界 = 11-01 12:00 CST：只有 11-01 10:06 那笔在窗口内，其余 5 笔都在窗口外
    expect(s.amount).toBe(100)
    expect(s.packs).toBe(1)
    expect(s.soonestAt).toBe(Date.UTC(2026, 10, 1, 2, 6, 16))
    // 对照：旧形态把整桶 600 都当成"7 天内会作废"，金额虚高 6 倍（且窗口还是错的）
    const legacy = summarizeExpiringAt(
      [{ name: QODER_PACK_ADDON, expireAt: formatCstWallClock(Date.UTC(2026, 10, 1, 2, 6, 16)), size: 600, used: 0 }].map(packageExpiryEntry),
      now,
      7 * DAY_MS
    )
    expect(legacy.amount).toBe(600)
  })
})
