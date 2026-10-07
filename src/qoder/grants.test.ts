/**
 * grants.test.ts — Qoder 加购额度账本（上游只给聚合桶，逐笔明细是这里攒出来的）。
 *
 * 锁住五件事（每一条都对应一个会真实退化的失效模式）：
 *   1. 首次迁移：把迁移前观测到的余额记成**一笔**未记账余额，沿用旧聚合包的上界；
 *   2. 新领按笔追加：连续 6 天签到 → 6 笔、6 个不同的到期时间（用户 2026-10-07 报的场景）；
 *   3. FIFO 结算：上游说少了就扣最早到期那笔，扣完即出账；上游说多了并进同一笔，不新增条目
 *      （否则每次探测都长一条，KV 会无限膨胀）；
 *   4. 没探到额度（addon 缺省）→ 账本原样保留，不让一次失败的探测把明细擦掉；
 *   5. 到期未知 = 0，不编造日期（编了就会用假数据驱动「到期优先」挑号）。
 */
import { describe, it, expect } from 'vitest'
import {
  QODER_GRANT_MAX,
  isQoderUnbookedGrant,
  reconcileQoderAddonGrants,
  sumQoderGrantOutstanding,
  type QoderAddonGrant,
} from './grants'

const DAY = 24 * 60 * 60 * 1000
/** 2026-10-02 10:06:16 CST（用户首次签到的时刻，与线上一致）。 */
const BASE = Date.UTC(2026, 9, 2, 2, 6, 16)
const DAY_MS = DAY

/** 第 i 天签到发出的那一笔（到期 = 领取 + 30 天）。 */
function claimOnDay(i: number, size = 100): QoderAddonGrant {
  const at = BASE + i * DAY_MS
  return { at, size, used: 0, expireAt: at + 30 * DAY_MS }
}

describe('reconcileQoderAddonGrants：新领按笔追加', () => {
  it('连续 6 天签到 → 6 笔、6 个不同的到期时间（不再是一个聚合到期）', () => {
    let ledger: QoderAddonGrant[] = []
    for (let i = 0; i < 6; i++) {
      ledger = reconcileQoderAddonGrants({
        prevGrants: ledger,
        addon: { size: (i + 1) * 100, used: 0, remain: (i + 1) * 100 },
        claim: claimOnDay(i),
        now: BASE + i * DAY_MS,
      })
    }
    expect(ledger).toHaveLength(6)
    // 到期各不相同，且是「领取 + 30 天」——这正是旧实现丢掉的信息
    expect(ledger.map((g) => g.expireAt)).toEqual([0, 1, 2, 3, 4, 5].map((i) => BASE + (i + 30) * DAY_MS))
    expect(ledger.map((g) => g.size)).toEqual([100, 100, 100, 100, 100, 100])
    expect(ledger.every((g) => g.used === 0)).toBe(true)
    expect(sumQoderGrantOutstanding(ledger)).toBe(600)
    // 最早那笔比最后一笔早 5 天作废（旧实现把整桶标成最后一笔）
    expect(ledger[0].expireAt).toBe(ledger[5].expireAt - 5 * DAY_MS)
  })

  it('同一笔被重复上报（签到重试）→ 不重复记账', () => {
    const first = reconcileQoderAddonGrants({ prevGrants: [], addon: { remain: 100 }, claim: claimOnDay(0) })
    const again = reconcileQoderAddonGrants({ prevGrants: first, addon: { remain: 100 }, claim: claimOnDay(0) })
    expect(again).toHaveLength(1)
    expect(sumQoderGrantOutstanding(again)).toBe(100)
  })

  it('金额拿不到（claim.size 缺失/0）→ 不追加，交给未记账余额兜底；到期时间拿不到 → 记 0 而不是编造', () => {
    const noSize = reconcileQoderAddonGrants({ prevGrants: [], addon: { remain: 100 }, claim: { at: BASE, size: 0 } })
    expect(noSize).toHaveLength(1)
    expect(isQoderUnbookedGrant(noSize[0])).toBe(true)
    expect(noSize[0].expireAt).toBe(0)

    const noExpiry = reconcileQoderAddonGrants({ prevGrants: [], addon: { remain: 100 }, claim: { at: BASE, size: 100 } })
    expect(noExpiry).toHaveLength(1)
    expect(noExpiry[0]).toMatchObject({ at: BASE, size: 100, used: 0, expireAt: 0 })
    expect(isQoderUnbookedGrant(noExpiry[0])).toBe(false)
  })
})

describe('reconcileQoderAddonGrants：首次迁移', () => {
  it('没有账本 → 把上游当前余额记成一笔未记账余额，沿用旧聚合包的上界', () => {
    const legacy = BASE + 34 * DAY_MS
    const ledger = reconcileQoderAddonGrants({
      prevGrants: undefined,
      addon: { size: 600, used: 0, remain: 600 },
      legacyExpireAt: legacy,
      now: BASE + 5 * DAY_MS,
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ at: 0, size: 600, used: 0, expireAt: legacy })
    expect(isQoderUnbookedGrant(ledger[0])).toBe(true)
  })

  it('迁移幂等：再跑一次不会新增第二笔', () => {
    const input = { addon: { size: 600, used: 0, remain: 600 }, legacyExpireAt: BASE + 30 * DAY_MS }
    const once = reconcileQoderAddonGrants({ prevGrants: undefined, ...input })
    const twice = reconcileQoderAddonGrants({ prevGrants: once, ...input })
    expect(twice).toHaveLength(1)
    expect(sumQoderGrantOutstanding(twice)).toBe(600)
  })

  it('没有旧包可沿用（legacyExpireAt 缺省）→ 到期记 0（未知），不编造日期', () => {
    const ledger = reconcileQoderAddonGrants({ prevGrants: null, addon: { size: 600, used: 0, remain: 600 } })
    expect(ledger[0].expireAt).toBe(0)
  })

  it('首次观测就带着新领的那一笔 → 只记新领那一笔，不多出一份「未记账余额」', () => {
    // 全新账号第一次签到：上游报 100，其中 100 就是这次领的 → 迁移余额 = 100 − 100 = 0。
    // 不减的话会凭空多出 100 额度，随后 FIFO 结算会去扣掉那笔真实的新领
    // （未记账余额到期未知、排在最后，先被扣的是有新领的那笔），表现为「刚签到的分不见了」。
    const ledger = reconcileQoderAddonGrants({
      prevGrants: undefined,
      addon: { size: 100, used: 0, remain: 100 },
      claim: claimOnDay(0),
      now: BASE,
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ at: claimOnDay(0).at, size: 100, used: 0, expireAt: claimOnDay(0).expireAt })
    expect(isQoderUnbookedGrant(ledger[0])).toBe(false)
  })

  it('首次观测既有历史余额又有新领 → 历史余额只算「领取之前」那部分', () => {
    const ledger = reconcileQoderAddonGrants({
      prevGrants: undefined,
      addon: { size: 300, used: 0, remain: 300 }, // 200 历史 + 本次 100
      claim: claimOnDay(0),
      legacyExpireAt: BASE + 20 * DAY_MS,
      now: BASE,
    })
    expect(ledger).toHaveLength(2)
    expect(ledger[0]).toMatchObject({ at: 0, size: 200, expireAt: BASE + 20 * DAY_MS })
    expect(ledger[1]).toMatchObject({ at: claimOnDay(0).at, size: 100 })
    expect(sumQoderGrantOutstanding(ledger)).toBe(300)
  })

  it('上游余额为 0 → 不建任何笔（空账本也是有效账本，不能和"没有账本"混为一谈）', () => {
    const ledger = reconcileQoderAddonGrants({ prevGrants: undefined, addon: { size: 0, used: 0, remain: 0 }, legacyExpireAt: BASE })
    expect(ledger).toEqual([])
  })
})

describe('reconcileQoderAddonGrants：FIFO 结算', () => {
  const build = () => [claimOnDay(0), claimOnDay(1), claimOnDay(2)]

  it('上游说少了 → 扣最早到期那笔；扣完即出账（不再占一行）', () => {
    const ledger = reconcileQoderAddonGrants({
      prevGrants: build(),
      addon: { size: 300, used: 100, remain: 200 },
      now: BASE + 2 * DAY_MS,
    })
    // 最早那笔（第 0 天）恰好扣完 → 出账；后两笔原样
    expect(ledger.map((g) => g.at)).toEqual([claimOnDay(1).at, claimOnDay(2).at])
    expect(sumQoderGrantOutstanding(ledger)).toBe(200)
  })

  it('只扣了一部分 → 保留该笔并记下已用额度（面板显示「已用/总额度」）', () => {
    const ledger = reconcileQoderAddonGrants({
      prevGrants: build(),
      addon: { size: 300, used: 50, remain: 250 },
      now: BASE + 2 * DAY_MS,
    })
    expect(ledger).toHaveLength(3)
    expect(ledger[0]).toMatchObject({ at: claimOnDay(0).at, size: 100, used: 50 })
    expect(ledger[1].used).toBe(0)
    expect(sumQoderGrantOutstanding(ledger)).toBe(250)
  })

  it('上游说 0 → 全部出账（账本清空，不回退成"聚合桶还有 600"）', () => {
    const ledger = reconcileQoderAddonGrants({ prevGrants: build(), addon: { size: 300, used: 300, remain: 0 }, now: BASE })
    expect(ledger).toEqual([])
  })

  it('上游说多了（记账后新增、来源未知的赠送分）→ 并进同一笔未记账余额，不新增条目', () => {
    const first = reconcileQoderAddonGrants({ prevGrants: build(), addon: { remain: 900 }, now: BASE + 2 * DAY_MS })
    expect(first).toHaveLength(4)
    expect(first.filter(isQoderUnbookedGrant)).toHaveLength(1)
    expect(sumQoderGrantOutstanding(first)).toBe(900)
    // 再探一次同样的数：还是同一笔，不增长
    const second = reconcileQoderAddonGrants({ prevGrants: first, addon: { remain: 900 }, now: BASE + 3 * DAY_MS })
    expect(second).toHaveLength(4)
    expect(sumQoderGrantOutstanding(second)).toBe(900)
  })

  it('已过期但未用完的笔照常按「最早到期先扣」参与结算（少了 100 的原因就是它作废了）', () => {
    const now = BASE + 40 * DAY_MS // 三笔都已过 30 天有效期
    const ledger = reconcileQoderAddonGrants({
      prevGrants: build(),
      addon: { size: 300, used: 100, remain: 200 },
      now,
    })
    // 结算按"最早到期先扣"扣掉第 0 天那笔（扣完出账），剩下两笔仍留着
    // （已过期但没用完的笔保留在结果里：它记录着"多少分在何时作废"，面板会标红显示）
    expect(ledger.map((g) => g.at)).toEqual([claimOnDay(1).at, claimOnDay(2).at])
  })

  it('addon 缺省（本次没探到额度）→ 账本原样保留，新领仍然入账', () => {
    const kept = reconcileQoderAddonGrants({ prevGrants: build(), addon: null, now: BASE + 2 * DAY_MS })
    expect(kept).toHaveLength(3)
    const appended = reconcileQoderAddonGrants({ prevGrants: build(), addon: undefined, claim: claimOnDay(3), now: BASE + 3 * DAY_MS })
    expect(appended).toHaveLength(4)
  })

  it('上游剩余量非法/缺失 → 不结算（不当成 0 把账本清空）', () => {
    const ledger = reconcileQoderAddonGrants({
      prevGrants: build(),
      addon: { size: 300, used: 0, remain: Number.NaN },
      now: BASE + 2 * DAY_MS,
    })
    expect(ledger).toHaveLength(3)
  })
})

describe('reconcileQoderAddonGrants：出账与安全阀', () => {
  it('完全用尽的笔不出现在结果里；非法条目（size<=0）被丢掉', () => {
    const ledger = reconcileQoderAddonGrants({
      prevGrants: [
        { at: BASE, size: 100, used: 100, expireAt: BASE + 10 * DAY_MS },
        { at: BASE, size: 0, used: 0, expireAt: 0 },
        { at: BASE, size: 100, used: 0, expireAt: 0 },
      ],
      now: BASE,
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0].used).toBe(0)
  })

  it(`超过 ${QODER_GRANT_MAX} 笔时先裁掉「已过期且未用完」的（安全阀，正常账户碰不到）`, () => {
    const many: QoderAddonGrant[] = []
    for (let i = 0; i < QODER_GRANT_MAX + 10; i++) {
      // 全部已过期（now 远大于到期时间），且都还有剩余
      many.push({ at: BASE + i * 60_000, size: 10, used: 0, expireAt: BASE + i * 60_000 + 1000 })
    }
    const ledger = reconcileQoderAddonGrants({ prevGrants: many, now: BASE + 365 * DAY_MS })
    expect(ledger).toHaveLength(QODER_GRANT_MAX)
    // 丢掉的是最早到期的那些，保留的是最后 90 笔
    expect(ledger[ledger.length - 1].at).toBe(many[many.length - 1].at)
  })

  it('未过期且未用完的笔永不被安全阀裁掉（裁的是明细，不是还有效的额度）', () => {
    const live: QoderAddonGrant[] = []
    for (let i = 0; i < QODER_GRANT_MAX + 10; i++) {
      live.push({ at: BASE + i * 60_000, size: 10, used: 0, expireAt: BASE + 365 * DAY_MS })
    }
    const ledger = reconcileQoderAddonGrants({ prevGrants: live, now: BASE })
    expect(ledger).toHaveLength(QODER_GRANT_MAX + 10)
  })
})
