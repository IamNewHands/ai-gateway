/**
 * packs.test.ts — Qoder 额度包的到期信息（面板「到期天数」+ 挑号「到期优先」的数据源）。
 *
 * 为什么需要它：Qoder 上游给的时间格式有三种，且**只有分项**才知道哪个包会先作废：
 *   1. quota/usage 的套餐到期是 **ms 时间戳**（顶层 expiresAt）；
 *   2. claim 响应里新领积分的到期是 **ISO 串**（"2026-11-01T10:52:18.531379Z"，领取 + 30 天）；
 *   3. addOnQuota（签到积分落在这里）**根本不返回到期时间**，只能靠 (2) 或池里已存的值兜底。
 * 三者都要落成面板与挑号共用的 CST 墙钟串，否则会出现「面板显示长期、挑号也不优先」的静默降级
 * ——积分照常过期作废，而界面上看不出任何异常。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  QODER_PACK_ADDON,
  QODER_PACK_BASE,
  buildQoderPacks,
  fetchQoderUserResource,
  performQoderCheckin,
} from './billing'
import { formatCstWallClock, parseCstWallClock } from '../credit-expiry'
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

describe('buildQoderPacks：两个包各有自己的到期来源', () => {
  const split = { size: 300, used: 0, remain: 300 }
  const addon = { size: 100, used: 0, remain: 100 }

  it('套餐额度取 planExpiresAt；签到/赠送额度取本次新领 grant 的到期', () => {
    const planMs = Date.UTC(2026, 9, 15, 0, 0, 0)
    const rewardMs = Date.UTC(2026, 10, 1, 2, 52, 18)
    const packs = buildQoderPacks({ baseQuota: split, addonQuota: addon, planExpiresAt: planMs }, rewardMs, null)
    expect(packs.map((p) => p.name)).toEqual([QODER_PACK_BASE, QODER_PACK_ADDON])
    expect(packs[0].expireAt).toBe('2026-10-15 08:00:00')
    expect(packs[1].expireAt).toBe('2026-11-01 10:52:18')
    // 分项额度原样落进各自的包（面板据此算「已用/总额度」）
    expect(packs[0]).toMatchObject({ size: 300, used: 0, unit: 'credits' })
    expect(packs[1]).toMatchObject({ size: 100, used: 0, unit: 'credits' })
  })

  it('本次没有新领（已签到/replayed）→ 用池里已存的到期时间兜底，不擦成长期', () => {
    const prevMs = Date.UTC(2026, 10, 1, 2, 52, 18)
    const prev: PackageInfo[] = [
      { name: QODER_PACK_BASE, expireAt: '2026-10-15 08:00:00', size: 300, used: 0 },
      { name: QODER_PACK_ADDON, expireAt: formatCstWallClock(prevMs), size: 100, used: 0 },
    ]
    const packs = buildQoderPacks({ baseQuota: split, addonQuota: addon, planExpiresAt: 0 }, undefined, prev)
    expect(packs[1].expireAt).toBe('2026-11-01 10:52:18')
    // 套餐到期上游没给 → 长期（空串），面板显示「长期」而不是编造一个时间
    expect(packs[0].expireAt).toBe('')
  })

  it('既没有新 grant 也没有历史包 → 空串（长期），不编造到期时间', () => {
    const packs = buildQoderPacks({ baseQuota: split, addonQuota: addon, planExpiresAt: 0 }, undefined, undefined)
    expect(packs.map((p) => p.expireAt)).toEqual(['', ''])
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

describe('与挑号口径对齐：面板的 7 天窗口就是挑号的 7 天窗口', () => {
  it('签到的两个包落在窗口内的时刻，等于后端 soonestExpiringAt 的输入', () => {
    const now = Date.UTC(2026, 9, 2, 10, 52, 18)
    const planMs = now + 3 * DAY_MS // 套餐 3 天后到期
    const rewardMs = now + 30 * DAY_MS // 签到额度 30 天后到期
    const packs = buildQoderPacks(
      { baseQuota: { size: 300, used: 0, remain: 300 }, addonQuota: { size: 100, used: 0, remain: 100 }, planExpiresAt: planMs },
      rewardMs,
      null
    )
    // 套餐包在窗口内 → 是「待救积分」；签到包在窗口外 → 不参与
    const inWindow = packs.filter((p) => {
      const ms = parseCstWallClock(p.expireAt)!
      return ms > now && ms <= now + 7 * DAY_MS
    })
    expect(inWindow.map((p) => p.name)).toEqual([QODER_PACK_BASE])
  })
})
