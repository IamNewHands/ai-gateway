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
vi.mock('./analytics/query', () => ({
  queryUsageOverview: async () => ({ requests: 42, successRate: 90 }),
}))

import { handleAdminOverview } from './checkin'

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
    checkin: { checkedIn: number; totalAccounts: number; remain: number; size: number }
    trae: { remain: number; size: number; accounts: number; soloRemain: number; workRemain: number }
    usage: { requests: number; successRate: number } | null
  }
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
    expect(d.checkin.remain).toBe(140)
    expect(d.checkin.size).toBe(310)
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
