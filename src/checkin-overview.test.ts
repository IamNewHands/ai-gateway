/**
 * checkin-overview.test.ts — 概览驾驶舱 KPI（/admin/api/overview）聚合口径回归。
 *
 * 覆盖两点真实缺陷：
 * 1. `skipped_global`（国际版无签到体系）/ `skipped_no_token` 曾被计入「今日签到」分母，
 *    用户全部签完后顶部仍显示「N 个待签」。
 * 2. TRAE SOLO 账号完全不在该 KPI 内（participatesInCheckin 显式排除），漏计签到进度与额度。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'hono'
import type { Env, Provider } from './types'

const { getProvidersMock } = vi.hoisted(() => ({ getProvidersMock: vi.fn() }))

vi.mock('./storage', () => ({
  getProviders: getProvidersMock,
  getProvider: vi.fn(),
  updateProvider: vi.fn(),
}))

import { handleAdminOverview } from './checkin'
import { formatCstWallClock } from './credit-expiry'

const DAY = 24 * 60 * 60 * 1000
const TRAE_BASE_URL = 'https://trae-api-cn.mchost.guru'

function workbuddyProvider(id: string): Provider {
  return {
    id,
    name: id,
    authType: 'oauth-device',
    baseUrl: 'https://api.workbuddy.cn',
    oauth: { flowType: 'oauth-device' },
    apiKeys: [],
    models: [],
    enabled: true,
  } as unknown as Provider
}

function qoderProvider(id: string): Provider {
  return {
    id,
    name: id,
    authType: 'oauth-device',
    baseUrl: 'https://gateway.qoder.com.cn',
    oauth: { flowType: 'qoder' },
    apiKeys: [],
    models: [],
    enabled: true,
  } as unknown as Provider
}

function traeProvider(id: string, uids: string[]): Provider {
  return {
    id,
    name: 'TRAE SOLO',
    authType: 'oauth-device',
    baseUrl: TRAE_BASE_URL,
    apiKeys: uids.map((uid) => ({
      key: JSON.stringify({ accessToken: 'tok_' + uid, refreshToken: 'ref_' + uid, expiresAt: Date.now() + 3600_000, uid }),
      enabled: true,
    })),
    models: [],
    enabled: true,
  } as unknown as Provider
}

function makeEnv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    },
  } as unknown as Env
}

async function overview(env: Env) {
  const c = { env, json: (body: unknown) => body } as unknown as Context<{ Bindings: Env }>
  const res = (await handleAdminOverview(c)) as unknown as { data: any }
  return res.data as {
    checkin: { checkedIn: number; totalAccounts: number }
    workbuddy: { remain: number; size: number; accounts: number }
    qoder: { remain: number; size: number; accounts: number }
    trae: { remain: number; size: number; accounts: number; soloRemain: number; workRemain: number }
    expiring: {
      windowDays: number
      total: number
      soonestAt: number | null
      channels: {
        key: string; label: string; amount: number; soonestAt: number; packs: number; dataAt: number | null
      }[]
    }
  }
}

/** WorkBuddy/Qoder 权益包：expireAt 为 CST 墙钟字符串（上游口径），daysFromNow 为到期倒计时 */
function pkg(daysFromNow: number, size: number, used: number, name = '包') {
  return { name, expireAt: formatCstWallClock(Date.now() + daysFromNow * DAY)!, size, used }
}

/** WorkBuddy 池账号签到结果条目 */
function acc(uid: string, reason: string, todayCheckedIn: boolean, totalRemain?: number, totalSize?: number) {
  return {
    providerId: 'wb', name: 'wb', uid, realm: reason === 'skipped_global' ? 'global' : 'cn',
    success: reason !== 'fail', reason, message: '', todayCheckedIn, updatedAt: Date.now(),
    ...(typeof totalRemain === 'number' ? { totalRemain } : {}),
    ...(typeof totalSize === 'number' ? { totalSize } : {}),
  }
}

beforeEach(() => {
  getProvidersMock.mockReset()
})

describe('handleAdminOverview：今日签到分母口径', () => {
  it('国际版（skipped_global）与无 token 账号不计入分母：已签满显示全部完成', async () => {
    const env = makeEnv({
      'checkin:result:wb1': JSON.stringify({
        providerId: 'wb1', name: 'wb1', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [
          acc('u_cn_1', 'ok', true, 100, 200),
          acc('u_cn_2', 'already', true, 10, 50),
          // 国际版：success=true 但今日无签到体系，曾经被算成「待签」
          acc('u_global', 'skipped_global', false, 30, 60),
          // 无 token：结构上签不成，同样不是「待签」
          acc('u_notoken', 'skipped_no_token', false),
        ],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb1')])

    const d = await overview(env)
    expect(d.checkin.checkedIn).toBe(2)
    expect(d.checkin.totalAccounts).toBe(2)
    // 额度仍要累加国际版账号（它照样消耗额度池），仅签到分母排除
    expect(d.workbuddy.remain).toBe(140)
    expect(d.workbuddy.size).toBe(310)
    // 账号数用全量口径（含 skip），否则只有国际版账号的产品族会被额度卡误判成「无账号」
    expect(d.workbuddy.accounts).toBe(4)
  })

  it('只有国际版账号的产品族仍要显示出额度卡（不能被当成「暂无账号」）', async () => {
    const env = makeEnv({
      'checkin:result:wb_global_only': JSON.stringify({
        providerId: 'wb_global_only', name: 'wb', realm: 'global', success: true, reason: 'skipped_global',
        message: '国际版账号无签到功能', todayCheckedIn: false, updatedAt: Date.now(),
        accounts: [acc('u_g1', 'skipped_global', false, 300, 900)],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_global_only')])

    const d = await overview(env)
    expect(d.workbuddy).toEqual({ remain: 300, size: 900, accounts: 1 })
    // 签到分母为空（该族没有可签到账号），不显示 0/0 这种误导进度
    expect(d.checkin.totalAccounts).toBe(0)
    expect(d.checkin.checkedIn).toBe(0)
  })

  it('未签到账号仍计入分母（真实待签不能被吞掉）', async () => {
    const env = makeEnv({
      'checkin:result:wb2': JSON.stringify({
        providerId: 'wb2', name: 'wb2', realm: 'cn', success: false, reason: 'fail',
        message: '签到失败', todayCheckedIn: false, updatedAt: Date.now(),
        accounts: [acc('u_ok', 'ok', true), acc('u_fail', 'fail', false)],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb2')])

    const d = await overview(env)
    expect(d.checkin.checkedIn).toBe(1)
    expect(d.checkin.totalAccounts).toBe(2)
  })
})

describe('handleAdminOverview：TRAE SOLO 聚合', () => {
  it('TRAE 签到结果并入今日签到，SOLO + Work 双通道额度与权益包上限分别聚合', async () => {
    const env = makeEnv({
      'trae:pool:trae_agg': JSON.stringify({
        u_a: {
          credits: 100, workCredits: 50, disabled: false, until: 0, errCount: 0,
          packs: [
            { name: 'Work 包', limit: 200, used: 150, rem: 50, isWork: true },
            { name: 'SOLO 包', limit: 999, used: 899, rem: 100, isWork: false },
          ],
        },
        u_b: { credits: 7, workCredits: 30, disabled: false, until: 0, errCount: 0 },
      }),
      'trae:checkin:trae_agg': JSON.stringify([
        { uid: 'u_a', success: true, message: '签到成功', checkedIn: true, updatedAt: Date.now() },
        { uid: 'u_b', success: false, message: '签到失败', checkedIn: false, updatedAt: Date.now() },
      ]),
    })
    getProvidersMock.mockResolvedValue([traeProvider('trae_agg', ['u_a', 'u_b'])])

    const d = await overview(env)
    expect(d.checkin.checkedIn).toBe(1)
    expect(d.checkin.totalAccounts).toBe(2)
    expect(d.trae.accounts).toBe(2)
    expect(d.trae.soloRemain).toBe(107)
    expect(d.trae.workRemain).toBe(80)
    expect(d.trae.remain).toBe(187)
    // 额度池上限累加全部权益包（SOLO 999 + Work 200）
    expect(d.trae.size).toBe(1199)
  })

  it('只有 SOLO 包的账号不能显示 0（Work 通道为空时仍要给出可用额度）', async () => {
    const env = makeEnv({
      'trae:pool:trae_solo': JSON.stringify({
        u_a: {
          credits: 3487.3464, workCredits: 0, disabled: false, until: 0, errCount: 0,
          packs: [{ name: '每日签到包(500)', limit: 500, used: 100, rem: 400, isWork: false }],
        },
      }),
    })
    getProvidersMock.mockResolvedValue([traeProvider('trae_solo', ['u_a'])])

    const d = await overview(env)
    expect(d.trae.workRemain).toBe(0)
    expect(d.trae.soloRemain).toBe(3487.3464)
    expect(d.trae.remain).toBe(3487.3464)
  })

  it('无 TRAE 账号时额度为 0 且不进分母', async () => {
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb3')])
    const d = await overview(makeEnv())
    expect(d.trae).toEqual({ remain: 0, size: 0, accounts: 0, soloRemain: 0, workRemain: 0 })
    expect(d.checkin.totalAccounts).toBe(0)
  })
})

describe('handleAdminOverview：额度按产品族分开', () => {
  it('QoderWork 账号的额度不进 WorkBuddy 卡（标签与数字必须对得上）', async () => {
    const env = makeEnv({
      'checkin:result:wb_fam': JSON.stringify({
        providerId: 'wb_fam', name: 'wb_fam', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [acc('wb_cn', 'ok', true, 5000, 9000), acc('wb_global', 'skipped_global', false, 3151, 9747)],
      }),
      'checkin:result:qoder_fam': JSON.stringify({
        providerId: 'qoder_fam', name: 'qoder_fam', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [
          { ...acc('q_cn', 'ok', true, 895, 1200), realm: 'cn' },
          { ...acc('q_global', 'skipped_global', false, 40, 100), realm: 'global' },
        ],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_fam'), qoderProvider('qoder_fam')])

    const d = await overview(env)
    // WorkBuddy 卡只含 WorkBuddy 族（国内 5000 + 国际 3151），账号数含国际版
    expect(d.workbuddy).toEqual({ remain: 8151, size: 18747, accounts: 2 })
    // QoderWork 卡单独一份（含其国际版账号额度）
    expect(d.qoder).toEqual({ remain: 935, size: 1300, accounts: 2 })
    // 今日签到是跨族总口径：wb 1 + qoder 1（两族的 skipped_global 都不计分母）
    expect(d.checkin.checkedIn).toBe(2)
    expect(d.checkin.totalAccounts).toBe(2)
  })

  it('没有某个产品族的账号时该族额度为 0 且 accounts=0', async () => {
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_only')])
    const d = await overview(makeEnv())
    expect(d.qoder).toEqual({ remain: 0, size: 0, accounts: 0 })
  })
})

describe('handleAdminOverview：7 天内到期积分明细', () => {
  it('WorkBuddy 只算窗口内、仍有剩余的包（窗口外与已用尽都不进明细）', async () => {
    const now = Date.now()
    const env = makeEnv({
      'checkin:result:wb_exp': JSON.stringify({
        providerId: 'wb_exp', name: 'wb_exp', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: now,
        accounts: [{
          ...acc('u1', 'ok', true, 500, 900),
          packages: [
            pkg(3, 200, 100),        // 窗口内，剩 100 → 计入
            pkg(6, 300, 250),        // 窗口内，剩 50 → 计入
            pkg(9, 800, 0),          // 窗口外 → 不计
            pkg(2, 400, 400),        // 已用尽 → 不计
            { name: '长期', expireAt: '', size: 999, used: 0 },  // 无到期时间 → 不计
          ],
        }],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_exp')])

    const d = await overview(env)
    expect(d.expiring.windowDays).toBe(7)
    expect(d.expiring.total).toBe(150)
    expect(d.expiring.channels).toHaveLength(1)
    expect(d.expiring.channels[0].key).toBe('workbuddy')
    expect(d.expiring.channels[0].label).toBe('WorkBuddy')
    expect(d.expiring.channels[0].amount).toBe(150)
    expect(d.expiring.channels[0].packs).toBe(2)
    // 最早到期取窗口内那两条里更早的（3 天）
    expect(d.expiring.channels[0].soonestAt).toBeGreaterThan(now + 2.5 * DAY)
    expect(d.expiring.channels[0].soonestAt).toBeLessThan(now + 3.5 * DAY)
    expect(d.expiring.soonestAt).toBe(d.expiring.channels[0].soonestAt)
  })

  it('QoderWork 的到期包归 qoder 行，不混进 WorkBuddy 行', async () => {
    const env = makeEnv({
      'checkin:result:wb_mix': JSON.stringify({
        providerId: 'wb_mix', name: 'wb_mix', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [{ ...acc('wb1', 'ok', true, 100, 200), packages: [pkg(2, 100, 0)] }],
      }),
      'checkin:result:q_mix': JSON.stringify({
        providerId: 'q_mix', name: 'q_mix', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [{ ...acc('q1', 'ok', true, 60, 160), packages: [pkg(4, 60, 0)] }],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_mix'), qoderProvider('q_mix')])

    const d = await overview(env)
    expect(d.expiring.total).toBe(160)
    // 排在前面的是更早到期的 WorkBuddy（2 天 < 4 天）
    expect(d.expiring.channels.map((c) => c.key)).toEqual(['workbuddy', 'qoder'])
    expect(d.expiring.channels[0].amount).toBe(100)
    expect(d.expiring.channels[1].amount).toBe(60)
    expect(d.expiring.channels[1].label).toBe('QoderWork')
  })

  it('TRAE 按 SOLO / Work 双通道分行（各自烧各自的包）', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const env = makeEnv({
      'trae:pool:trae_exp': JSON.stringify({
        u_a: {
          credits: 100, workCredits: 20, disabled: false, until: 0, errCount: 0,
          packs: [
            // SOLO 包 5 天后到期，剩 50
            { name: 'SOLO', limit: 500, used: 450, rem: 50, isWork: false, expireAt: nowSec + 5 * 86400 },
            // Work 包 1 天后到期，剩 20
            { name: 'Work', limit: 100, used: 80, rem: 20, isWork: true, expireAt: nowSec + 86400 },
            // 窗口外（30 天）不计
            { name: 'SOLO 长期', limit: 900, used: 0, rem: 900, isWork: false, expireAt: nowSec + 30 * 86400 },
          ],
        },
      }),
    })
    getProvidersMock.mockResolvedValue([traeProvider('trae_exp', ['u_a'])])

    const d = await overview(env)
    // Work 通道 1 天后到期 → 排在 SOLO 之前
    expect(d.expiring.channels.map((c) => c.key)).toEqual(['trae-work', 'trae-solo'])
    expect(d.expiring.channels[0].label).toBe('TRAE Work')
    expect(d.expiring.channels[0].amount).toBe(20)
    expect(d.expiring.channels[1].label).toBe('TRAE SOLO')
    expect(d.expiring.channels[1].amount).toBe(50)
    expect(d.expiring.total).toBe(70)
  })

  it('国内版与国际版是两套账号池 → 各自一行，不合并成一个数', async () => {
    const env = makeEnv({
      'checkin:result:wb_pool': JSON.stringify({
        providerId: 'wb_pool', name: 'wb_pool', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [
          { ...acc('u_cn', 'ok', true, 500, 900), packages: [pkg(6, 300, 100)] },        // 国内剩 200
          { ...acc('u_g', 'skipped_global', false, 80, 300), packages: [pkg(1, 200, 120)] }, // 国际版剩 80
        ],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_pool')])

    const d = await overview(env)
    // 国际版先到期（1 天 < 6 天）→ 排前面
    expect(d.expiring.channels.map((c) => c.key)).toEqual(['workbuddy-global', 'workbuddy'])
    expect(d.expiring.channels[0].label).toBe('WorkBuddy 国际版')
    expect(d.expiring.channels[0].amount).toBe(80)
    expect(d.expiring.channels[1].amount).toBe(200)
    expect(d.expiring.total).toBe(280)
  })

  it('窗口内没有到期积分 → 明细为空且 total=0（面板据此显示空态而非消失）', async () => {
    const env = makeEnv({
      'checkin:result:wb_none': JSON.stringify({
        providerId: 'wb_none', name: 'wb_none', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: Date.now(),
        accounts: [{ ...acc('u1', 'ok', true, 100, 200), packages: [pkg(20, 100, 0)] }],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_none')])

    const d = await overview(env)
    expect(d.expiring).toEqual({ windowDays: 7, total: 0, soonestAt: null, channels: [] })
  })
})

describe('handleAdminOverview：到期明细的数据时点（快照值不能装成实时值）', () => {
  it('时点取「真正计入的条目」里最旧的一次探测；包在窗口外的陈旧账号不污染标注', async () => {
    const now = Date.now()
    const fresh = now - 60 * 60 * 1000            // 1 小时前
    const stale = now - 3 * 24 * 60 * 60 * 1000   // 3 天前
    const env = makeEnv({
      'checkin:result:wb_at': JSON.stringify({
        providerId: 'wb_at', name: 'wb_at', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: fresh,
        accounts: [
          // 有 3 天内的待救包 → 参与，时点 = fresh
          { ...acc('u_fresh', 'ok', true, 500, 900), updatedAt: fresh, packages: [pkg(3, 200, 100)] },
          // 陈旧账号，但它的包 30 天后才到期（不计入）→ 不能把整行标成「3 天前」
          { ...acc('u_stale', 'ok', true, 100, 200), updatedAt: stale, packages: [pkg(30, 100, 0)] },
        ],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_at')])

    const d = await overview(env)
    expect(d.expiring.channels).toHaveLength(1)
    expect(d.expiring.channels[0].dataAt).toBe(fresh)
  })

  it('多个账号都有待救积分 → 取最旧的那个（用最新的一次会掩盖陈旧数据）', async () => {
    const now = Date.now()
    const older = now - 2 * 24 * 60 * 60 * 1000
    const newer = now - 30 * 60 * 1000
    const env = makeEnv({
      'checkin:result:wb_at2': JSON.stringify({
        providerId: 'wb_at2', name: 'wb_at2', realm: 'cn', success: true, reason: 'ok',
        message: '', todayCheckedIn: true, updatedAt: newer,
        accounts: [
          { ...acc('u_a', 'ok', true, 50, 100), updatedAt: older, packages: [pkg(4, 50, 0)] },
          { ...acc('u_b', 'ok', true, 60, 100), updatedAt: newer, packages: [pkg(2, 60, 0)] },
        ],
      }),
    })
    getProvidersMock.mockResolvedValue([workbuddyProvider('wb_at2')])

    const d = await overview(env)
    expect(d.expiring.total).toBe(110)
    expect(d.expiring.channels[0].dataAt).toBe(older)
  })

  it('TRAE 时点取账号池 packsAt（未探测过权益包的账号不参与）', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const packsAt = Date.now() - 5 * 60 * 60 * 1000
    const env = makeEnv({
      'trae:pool:trae_at': JSON.stringify({
        u_a: {
          credits: 10, workCredits: 0, disabled: false, until: 0, errCount: 0, packsAt,
          packs: [{ name: 'SOLO', limit: 100, used: 40, rem: 60, isWork: false, expireAt: nowSec + 2 * 86400 }],
        },
        u_b: {
          credits: 10, workCredits: 0, disabled: false, until: 0, errCount: 0,
          packs: [{ name: 'SOLO2', limit: 100, used: 50, rem: 50, isWork: false, expireAt: nowSec + 3 * 86400 }],
        },
      }),
    })
    getProvidersMock.mockResolvedValue([traeProvider('trae_at', ['u_a', 'u_b'])])

    const d = await overview(env)
    expect(d.expiring.channels.map((c) => c.key)).toEqual(['trae-solo'])
    expect(d.expiring.channels[0].amount).toBe(110)
    // 只有 u_a 带 packsAt → 时点 = 它（u_b 未知不该把标注抹成 null）
    expect(d.expiring.channels[0].dataAt).toBe(packsAt)
  })

  it('TRAE 账号池从未探测过权益包（无 packsAt）→ 时点 null，面板显示「未知」而不是编一个时间', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    // 用独立 providerId：trae/pool 有 1s 内存缓存，复用 id 会读到上一个用例的池
    const env = makeEnv({
      'trae:pool:trae_at2': JSON.stringify({
        u_a: {
          credits: 1, workCredits: 0, disabled: false, until: 0, errCount: 0,
          packs: [{ name: 'p', limit: 9, used: 0, rem: 9, isWork: false, expireAt: nowSec + 86400 }],
        },
      }),
    })
    getProvidersMock.mockResolvedValue([traeProvider('trae_at2', ['u_a'])])

    const d = await overview(env)
    expect(d.expiring.channels[0].amount).toBe(9)
    expect(d.expiring.channels[0].dataAt).toBeNull()
  })
})
