/**
 * pick-expiry.test.ts — Trae 池「7 天内到期积分优先」挑号规则。
 *
 * 需求（2026-09-28）：多账号登录时，积分带到期时间，挑号需优先消耗 7 天内到期的积分，
 * 窗口内没有才回落到原本的「积分/work积分最高者优先」。
 */
import { describe, it, expect } from 'vitest'
import {
  cooldownTraeAccount,
  packExpireAtMs,
  pickTraeAccount,
  pickTraeWorkAccount,
  setTraeCredits,
  setTraePacks,
  setTraeWorkCredits,
  soonestTraePackExpiryAt,
} from './pool'
import type { TraeAccount, TraeAccountState, TraeEntPackInfo } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

function fakeEnv() {
  return {
    KV: {
      data: new Map<string, string>(),
      async get(key: string) { return this.data.get(key) || null },
      async put(key: string, val: string) { this.data.set(key, val) },
      async delete(key: string) { this.data.delete(key) },
    },
  } as any
}

const account = (uid: string): TraeAccount => ({
  uid,
  accessToken: `tok_${uid}`,
  refreshToken: `ref_${uid}`,
  expiresAt: Date.now() + 3600_000,
})

/** 权益包：expireAt 按 **Unix 秒** 口径（上游口径），传入 epoch ms 自行换算。 */
const pack = (over: Partial<TraeEntPackInfo> = {}): TraeEntPackInfo => ({
  name: 'p', limit: 100, used: 0, rem: 100, isWork: false, ...over,
})

describe('soonestTraePackExpiryAt：按通道分别取窗口内最早到期包', () => {
  const now = Date.UTC(2026, 8, 1)
  const state = (packs: TraeEntPackInfo[]): TraeAccountState => ({
    credits: 1, disabled: false, until: 0, errCount: 0, packs,
  })

  it('按 isWork 过滤：SOLO 查询不看 Work 包，Work 查询不看 SOLO 包', () => {
    const st = state([
      pack({ name: 'solo', isWork: false, expireAt: (now + DAY_MS) / 1000 }),
      pack({ name: 'work', isWork: true, expireAt: (now + 2 * DAY_MS) / 1000 }),
    ])
    expect(soonestTraePackExpiryAt(st, now, false)).toBe(now + DAY_MS)
    expect(soonestTraePackExpiryAt(st, now, true)).toBe(now + 2 * DAY_MS)
  })

  it('rem <= 0 的到期包不参与（已用尽的包不是待救积分）', () => {
    const st = state([pack({ rem: 0, expireAt: (now + DAY_MS) / 1000 })])
    expect(soonestTraePackExpiryAt(st, now, false)).toBeNull()
  })

  it('expireAt 为 0 / 缺省（长期有效）→ null', () => {
    expect(soonestTraePackExpiryAt(state([pack({ expireAt: 0 })]), now, false)).toBeNull()
    expect(soonestTraePackExpiryAt(state([pack()]), now, false)).toBeNull()
  })

  it('无 packs（从未探测）→ null，回落积分规则', () => {
    expect(soonestTraePackExpiryAt(undefined, now, false)).toBeNull()
    expect(soonestTraePackExpiryAt(state([]), now, false)).toBeNull()
  })

  it('packExpireAtMs：秒 → 毫秒；0/非法 → null', () => {
    expect(packExpireAtMs(pack({ expireAt: 1763038285 }))).toBe(1763038285000)
    expect(packExpireAtMs(pack({ expireAt: 0 }))).toBeNull()
    expect(packExpireAtMs(undefined)).toBeNull()
  })
})

describe('pickTraeAccount：SOLO 通道 7 天内到期积分优先', () => {
  it('到期在前（即使积分远低于另一号）→ 优先挑即将到期的号', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-1'
    // A：积分高但长期有效；B：积分低但 2 天后到期
    await setTraeCredits(env, pid, 'a', 1000)
    await setTraePacks(env, pid, 'a', [pack({ name: 'long', rem: 1000, expireAt: 0 })])
    await setTraeCredits(env, pid, 'b', 10)
    await setTraePacks(env, pid, 'b', [pack({ name: 'soon', rem: 10, expireAt: Math.floor((Date.now() + 2 * DAY_MS) / 1000) })])

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('b')

    // B 已尝试过（失败轮转）→ 回到积分规则挑 A
    const next = await pickTraeAccount(env, pid, [account('a'), account('b')], new Set(['b']))
    expect(next?.uid).toBe('a')
  })

  it('两个号都在窗口内 → 到期更早者优先（比积分优先更靠前）', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-2'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeCredits(env, pid, 'a', 5000)
    await setTraePacks(env, pid, 'a', [pack({ rem: 5000, expireAt: nowSec + 5 * 24 * 3600 })])
    await setTraeCredits(env, pid, 'b', 1)
    await setTraePacks(env, pid, 'b', [pack({ rem: 1, expireAt: nowSec + 24 * 3600 })])

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('b')
  })

  it('窗口外（8 天后到期）→ 回落原规则：积分最高者', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-3'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeCredits(env, pid, 'a', 1000)
    await setTraePacks(env, pid, 'a', [pack({ rem: 1000, expireAt: 0 })])
    await setTraeCredits(env, pid, 'b', 10)
    await setTraePacks(env, pid, 'b', [pack({ rem: 10, expireAt: nowSec + 8 * 24 * 3600 })])

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('a')
  })

  it('Work 包的到期时间不影响 SOLO 挑号（通道隔离）', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-4'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeCredits(env, pid, 'a', 1000)
    await setTraeCredits(env, pid, 'b', 10)
    // B 只有 Work 包即将到期：SOLO 通道不该被它吸引
    await setTraePacks(env, pid, 'b', [pack({ isWork: true, rem: 10, expireAt: nowSec + 3600 })])

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('a')
  })

  it('preferUid 仍最优先（手工指定不被到期规则覆盖）', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-5'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeCredits(env, pid, 'a', 1000)
    await setTraeCredits(env, pid, 'b', 10)
    await setTraePacks(env, pid, 'b', [pack({ rem: 10, expireAt: nowSec + 3600 })])

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')], new Set(), 'a')
    expect(picked?.uid).toBe('a')
  })

  it('冷却账号不参与到期优先（healthy 过滤仍在最前）', async () => {
    const env = fakeEnv()
    const pid = 'trae-solo-expiry-6'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeCredits(env, pid, 'a', 1000)
    await setTraeCredits(env, pid, 'b', 10)
    await setTraePacks(env, pid, 'b', [pack({ rem: 10, expireAt: nowSec + 3600 })])
    // B 进入冷却（走池 helper，保证内存缓存与 KV 同步）
    await cooldownTraeAccount(env, pid, 'b', 60_000, 'cooling')

    const picked = await pickTraeAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('a')
  })
})

describe('pickTraeWorkAccount：Work 通道 7 天内到期积分优先', () => {
  it('Work 包即将到期 → 优先于 Work 积分更高的号', async () => {
    const env = fakeEnv()
    const pid = 'trae-work-expiry-1'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeWorkCredits(env, pid, 'a', 100)
    await setTraePacks(env, pid, 'a', [pack({ isWork: true, rem: 100, expireAt: 0 })])
    await setTraeWorkCredits(env, pid, 'b', 5)
    await setTraePacks(env, pid, 'b', [pack({ isWork: true, rem: 5, expireAt: nowSec + 24 * 3600 })])

    const picked = await pickTraeWorkAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('b')
  })

  it('SOLO 包即将到期不影响 Work 挑号（通道隔离）', async () => {
    const env = fakeEnv()
    const pid = 'trae-work-expiry-2'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeWorkCredits(env, pid, 'a', 100)
    await setTraeWorkCredits(env, pid, 'b', 5)
    await setTraePacks(env, pid, 'b', [pack({ isWork: false, rem: 5, expireAt: nowSec + 3600 })])

    const picked = await pickTraeWorkAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('a')
  })

  it('窗口内无到期 Work 包 → 原规则：workCredits 最高者', async () => {
    const env = fakeEnv()
    const pid = 'trae-work-expiry-3'
    const nowSec = Math.floor(Date.now() / 1000)
    await setTraeWorkCredits(env, pid, 'a', 100)
    await setTraeWorkCredits(env, pid, 'b', 5)
    await setTraePacks(env, pid, 'b', [pack({ isWork: true, rem: 5, expireAt: nowSec + 20 * 24 * 3600 })])

    const picked = await pickTraeWorkAccount(env, pid, [account('a'), account('b')])
    expect(picked?.uid).toBe('a')
  })
})
