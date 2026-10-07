/**
 * identity.test.ts — Qoder 池 uid 的归正（把「token 切片」这种兜底 uid 换成上游权威 uid）。
 *
 * 为什么需要它：uid 是池的主键，「首选账号」与客户端 `X-Qoder-Account` 记的都是它。
 * 而兜底 uid 是 `access_token.slice(0,16)`——token 一刷新它就变了，于是同一账号重新登录后
 * 会以新 uid 再进一次池：面板裂成两条，旧那条的首选指定永远匹配不上（静默退化成自动挑选）。
 *
 * 两个最危险的边界必须钉死：
 *   1. **只归正兜底 uid**。真 uid 之间的差异属于上游侧变化，擅自改写等于给用户账号重新编号；
 *   2. **主键改了，preferOauthUid 必须跟着改**。不改的话面板显示「已指定」而挑号实际走自动，
 *      这种错在页面上完全看不出来。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isFallbackQoderUid, repairQoderPoolUid } from './identity'
import { readQoderPool, writeQoderPool, type QoderPoolAccount } from './pool'
import { setProviders, getProvider, clearCache } from '../storage'
import type { Env, Provider } from '../types'

const REAL_UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'
const FALLBACK_UID = 'dt-OlN11abcdefghij'

function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { env: { KV: kv } as unknown as Env, store }
}

function provider(id: string, over: Partial<Provider> = {}): Provider {
  return {
    id,
    name: 'QoderWork',
    authType: 'oauth-device',
    baseUrl: 'https://gateway.qoder.com.cn',
    oauth: { flowType: 'qoder' },
    apiKeys: [],
    models: [],
    enabled: true,
    ...over,
  } as unknown as Provider
}

function account(uid: string, over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid,
    token: { access_token: 'dt-' + uid, refresh_token: 'drt-' + uid, expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: 1000,
    realm: 'cn',
    ...over,
  }
}

beforeEach(() => { clearCache() })

describe('isFallbackQoderUid：只认「access_token 切片」这一种兜底形状', () => {
  it('dt- / jt- 前缀（我们唯一的兜底写法）→ 是', () => {
    expect(isFallbackQoderUid('dt-OlN11abcdefghij')).toBe(true)
    expect(isFallbackQoderUid('jt-AbCdEf1234567890')).toBe(true)
    expect(isFallbackQoderUid('  dt-padded  ')).toBe(true)
  })

  it('权威 uid（UUID）/ 空值 / 其它形状 → 不是（不猜「不像 UUID 就是脏值」）', () => {
    expect(isFallbackQoderUid(REAL_UID)).toBe(false)
    expect(isFallbackQoderUid('')).toBe(false)
    expect(isFallbackQoderUid('   ')).toBe(false)
    expect(isFallbackQoderUid(undefined)).toBe(false)
    expect(isFallbackQoderUid(null)).toBe(false)
    expect(isFallbackQoderUid('dt')).toBe(false)
    expect(isFallbackQoderUid('user-1234')).toBe(false)
  })
})

describe('repairQoderPoolUid：兜底 uid → 权威 uid', () => {
  it('池里只有兜底那条 → 原地改名，凭证/状态/冷却/域全部保留', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-1'
    await writeQoderPool(env, pid, [account(FALLBACK_UID, {
      nickname: 'Shiro',
      enabled: false,
      updatedAt: 42,
      state: { credits: 895, disabled: true, until: 999999, errCount: 3, reason: '限流（429）' },
    })])

    const mig = await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)
    expect(mig).toEqual({ fromUid: FALLBACK_UID, toUid: REAL_UID, merged: false, pinMoved: false })

    const pool = await readQoderPool(env, pid)
    expect(pool).toHaveLength(1)
    expect(pool[0].uid).toBe(REAL_UID)
    // 改名不是「新建一条」：账号自身的状态必须原样跟着走，否则冷却/额度会凭空清零
    expect(pool[0]).toMatchObject({ nickname: 'Shiro', enabled: false, updatedAt: 42 })
    expect(pool[0].state).toMatchObject({ credits: 895, disabled: true, until: 999999, errCount: 3 })
  })

  it('真 uid 传入 → 拒绝归正（绝不擅自给账号重新编号）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-2'
    const other = '7f3c1c2e-0000-4444-8888-999999999999'
    await writeQoderPool(env, pid, [account(other)])

    expect(await repairQoderPoolUid(env, provider(pid), other, REAL_UID)).toBeNull()
    expect((await readQoderPool(env, pid))[0].uid).toBe(other)
  })

  it('空值 / 相同 / 池内不存在 → null 且不动池', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-3'
    await writeQoderPool(env, pid, [account(FALLBACK_UID)])
    const p = provider(pid)

    expect(await repairQoderPoolUid(env, p, '', REAL_UID)).toBeNull()
    expect(await repairQoderPoolUid(env, p, FALLBACK_UID, '')).toBeNull()
    expect(await repairQoderPoolUid(env, p, FALLBACK_UID, FALLBACK_UID)).toBeNull()
    expect(await repairQoderPoolUid(env, p, 'dt-not-in-pool', REAL_UID)).toBeNull()
    expect((await readQoderPool(env, pid))[0].uid).toBe(FALLBACK_UID)
  })

  it('面板首选账号指向旧 uid → 一并迁移（否则指定静默失效、下拉框悄悄弹回自动）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-4'
    await setProviders(env, [provider(pid, { preferOauthUid: FALLBACK_UID })])
    await writeQoderPool(env, pid, [account(FALLBACK_UID)])

    const mig = await repairQoderPoolUid(env, await getProvider(env, pid) as Provider, FALLBACK_UID, REAL_UID)

    expect(mig!.pinMoved).toBe(true)
    expect((await getProvider(env, pid))!.preferOauthUid).toBe(REAL_UID)
  })

  it('面板首选账号指向别的账号 → 不动它（只迁移真正指向被改名那条的指定）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-5'
    const other = '7f3c1c2e-0000-4444-8888-999999999999'
    await setProviders(env, [provider(pid, { preferOauthUid: other })])
    await writeQoderPool(env, pid, [account(FALLBACK_UID)])

    const mig = await repairQoderPoolUid(env, await getProvider(env, pid) as Provider, FALLBACK_UID, REAL_UID)

    expect(mig!.pinMoved).toBe(false)
    expect((await getProvider(env, pid))!.preferOauthUid).toBe(other)
  })
})

/**
 * 合并：同一个 Qoder 账号已经有权威 uid 那条（来自后来那次 `user_id` 正常的登录）。
 * 面板上本来就是两条重复行，归正后必须只剩一条，且不能把有价值的字段丢掉。
 */
describe('repairQoderPoolUid：权威 uid 那条已存在时按「同一账号只留一条」合并', () => {
  function twoAccounts(over: { src?: Partial<QoderPoolAccount>; dst?: Partial<QoderPoolAccount> } = {}) {
    return [
      account(FALLBACK_UID, { updatedAt: 10, ...over.src }),
      account(REAL_UID, { updatedAt: 20, ...over.dst }),
    ]
  }

  it('只剩权威 uid 一条，索引位置不影响结果', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m1'
    await writeQoderPool(env, pid, twoAccounts())
    const mig = await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)

    expect(mig).toMatchObject({ merged: true })
    const pool = await readQoderPool(env, pid)
    expect(pool.map((a) => a.uid)).toEqual([REAL_UID])
  })

  it('额度状态取「信息更多」的那份：有额度包明细的胜出（哪怕积分少）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m2'
    const packs = [{ name: '套餐额度', expireAt: '2026-11-01 10:00:00', size: 300, used: 0 }]
    await writeQoderPool(env, pid, twoAccounts({
      // dst 积分更高但没有包明细（新建登录留下的空状态）；src 有明细 → 应胜出
      src: { state: { credits: 100, disabled: false, until: 0, errCount: 0, packages: packs } },
      dst: { state: { credits: 900, disabled: false, until: 0, errCount: 0 } },
    }))

    await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)

    const kept = (await readQoderPool(env, pid))[0]
    expect(kept.state.credits).toBe(100)
    expect(kept.state.packages).toEqual(packs)
  })

  it('两边都没包明细时比积分（没有包明细的那份是空状态，会凭空抹掉额度）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m3'
    await writeQoderPool(env, pid, twoAccounts({
      src: { state: { credits: 120, disabled: false, until: 0, errCount: 0 } },
      dst: { state: { credits: 0, disabled: false, until: 0, errCount: 0 } },
    }))

    await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)
    expect((await readQoderPool(env, pid))[0].state.credits).toBe(120)
  })

  it('凭证取更晚过期的那份（两边同一账号，取新的少一次刷新）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m4'
    const farFuture = Date.now() + 10 * 86400000
    await writeQoderPool(env, pid, twoAccounts({
      src: { token: { access_token: 'dt-fresh', refresh_token: 'r', expires_at: farFuture, updated_at: 0 } },
      dst: { token: { access_token: 'dt-stale', refresh_token: 'r', expires_at: Date.now() - 1000, updated_at: 0 } },
    }))

    await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)
    expect((await readQoderPool(env, pid))[0].token.access_token).toBe('dt-fresh')
  })

  it('昵称：dst 没有真昵称时用 src 的；但 src 的脏昵称（等于自己 uid）绝不被搬过去', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m5'
    await writeQoderPool(env, pid, twoAccounts({ src: { nickname: 'Shiro' }, dst: { nickname: undefined } }))
    await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)
    expect((await readQoderPool(env, pid))[0].nickname).toBe('Shiro')

    const pid2 = 'qoder-id-m6'
    await writeQoderPool(env, pid2, twoAccounts({ src: { nickname: FALLBACK_UID }, dst: { nickname: undefined } }))
    await repairQoderPoolUid(env, provider(pid2), FALLBACK_UID, REAL_UID)
    // 旧 uid 冒充昵称的脏值搬过去只会让面板显示一个已经不存在的 uid
    expect((await readQoderPool(env, pid2))[0].nickname).toBeUndefined()
  })

  it('只要有一条未禁用，合并后即未禁用（禁用多是鉴权误判残留，另一条健康就是可用证据）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m7'
    await writeQoderPool(env, pid, twoAccounts({ src: { enabled: false }, dst: { enabled: true } }))
    await repairQoderPoolUid(env, provider(pid), FALLBACK_UID, REAL_UID)
    expect((await readQoderPool(env, pid))[0].enabled).toBe(true)
  })

  it('合并时首选账号同样迁移', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-id-m8'
    await setProviders(env, [provider(pid, { preferOauthUid: FALLBACK_UID })])
    await writeQoderPool(env, pid, twoAccounts())

    const mig = await repairQoderPoolUid(env, await getProvider(env, pid) as Provider, FALLBACK_UID, REAL_UID)
    expect(mig!.pinMoved).toBe(true)
    expect((await getProvider(env, pid))!.preferOauthUid).toBe(REAL_UID)
  })
})
