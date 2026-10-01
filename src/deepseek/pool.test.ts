/**
 * deepseek/pool.test.ts — token 池：KV 往返、注入去重、失效标记、轮转与并发上限、
 * 上游处罚 park（移植自 simple-chat `internal/upstream/pool_test.go` 的 TASK_MUTE 案例）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Env } from '../types'
import {
  DEEPSEEK_DEFAULT_MAX_INFLIGHT,
  DEEPSEEK_MUTE_PARK_DEFAULT_MS,
  DEEPSEEK_RISK_COOLDOWN_MS,
  acquireDeepseekToken,
  addDeepseekToken,
  clearExpiredDeepseekParks,
  computeDeepseekPark,
  countReady,
  isDeepseekTokenParked,
  markDeepseekToken,
  parkDeepseekToken,
  readDeepseekPool,
  removeDeepseekToken,
  resetDeepseekRotatorForTest,
  toTokenView,
  unparkDeepseekToken,
  writeDeepseekPool,
  type DeepseekTokenRecord,
} from './pool'

function mockKV() {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const mockEnv = (kv: ReturnType<typeof mockKV>) => ({ KV: kv } as unknown as Env)

const rec = (id: string, state: DeepseekTokenRecord['state'] = 'ready'): DeepseekTokenRecord => ({
  id,
  token: `tok-${id}`,
  headerDeviceId: `dev-${id}`,
  userAgent: 'UA',
  state,
  addedAt: 1,
})

beforeEach(() => resetDeepseekRotatorForTest())

describe('kv round trip', () => {
  it('treats a missing or corrupt key as an empty pool', async () => {
    const kv = mockKV()
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
    kv.map.set('deepseek:pool', 'not json')
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
    kv.map.set('deepseek:pool', JSON.stringify({ tokens: 'nope' }))
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
  })

  it('persists and reads back', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('a')])
    expect((await readDeepseekPool(env)).map((t) => t.id)).toEqual(['a'])
  })
})

describe('add / remove', () => {
  it('adds a token, rejects duplicates without overwriting, and never stores blanks', async () => {
    const env = mockEnv(mockKV())
    const first = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })
    expect(first.ok).toBe(true)
    expect(first.record?.id).toBeTruthy()
    expect(first.record?.state).toBe('ready')

    const dup = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })
    expect(dup.ok).toBe(false)
    expect(dup.duplicate?.id).toBe(first.record?.id)

    expect((await addDeepseekToken(env, { token: '  ', headerDeviceId: 'd', userAgent: 'UA' })).ok).toBe(false)
    expect((await addDeepseekToken(env, { token: 't2', headerDeviceId: '', userAgent: 'UA' })).ok).toBe(false)
    expect(await readDeepseekPool(env)).toHaveLength(1)
  })

  it('removes by panel id and reports misses', async () => {
    const env = mockEnv(mockKV())
    const added = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA', label: '主号' })
    const id = added.record!.id
    expect((await removeDeepseekToken(env, id))?.id).toBe(id)
    expect(await removeDeepseekToken(env, id)).toBeNull()
    expect(await readDeepseekPool(env)).toEqual([])
  })
})

describe('state transitions', () => {
  it('marks expired with a reason, and ok clears it', async () => {
    const env = mockEnv(mockKV())
    const id = (await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })).record!.id

    await markDeepseekToken(env, id, { state: 'expired', error: 'token expired' })
    let list = await readDeepseekPool(env)
    expect(list[0].state).toBe('expired')
    expect(list[0].lastError).toBe('token expired')
    expect(countReady(list)).toBe(0)

    await markDeepseekToken(env, id, { ok: true })
    list = await readDeepseekPool(env)
    expect(list[0].state).toBe('ready')
    expect(list[0].lastError).toBeUndefined()
    expect(list[0].lastOkAt).toBeGreaterThan(0)
  })

  it('reports misses for unknown ids', async () => {
    const env = mockEnv(mockKV())
    expect(await markDeepseekToken(env, 'nope', { ok: true })).toBeNull()
  })

  it('never exposes the full token in the panel view', async () => {
    const view = toTokenView({ ...rec('a'), token: 'abcdef123456' })
    expect(view.tokenTail).toBe('123456')
    expect(JSON.stringify(view)).not.toContain('abcdef123456')
  })
})

describe('rotation', () => {
  it('round-robins across ready tokens', () => {
    const tokens = [rec('a'), rec('b'), rec('c')]
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      const acq = acquireDeepseekToken('p', tokens)!
      picks.push(acq.record.id)
      acq.release()
    }
    expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('skips expired tokens entirely', () => {
    const tokens = [rec('a', 'expired'), rec('b'), rec('c', 'expired')]
    const acq = acquireDeepseekToken('p', tokens)!
    expect(acq.record.id).toBe('b')
    acq.release()
  })

  it('enforces the per-token in-flight cap and returns null when everything is busy', () => {
    const tokens = [rec('a')]
    const held = []
    for (let i = 0; i < DEEPSEEK_DEFAULT_MAX_INFLIGHT; i++) {
      const acq = acquireDeepseekToken('p', tokens)
      expect(acq).not.toBeNull()
      held.push(acq!)
    }
    expect(acquireDeepseekToken('p', tokens)).toBeNull()
    held[0].release()
    expect(acquireDeepseekToken('p', tokens)?.record.id).toBe('a')
  })

  it('returns null for an empty pool or an all-expired pool', () => {
    expect(acquireDeepseekToken('p', [])).toBeNull()
    expect(acquireDeepseekToken('p', [rec('a', 'expired')])).toBeNull()
  })

  it('keeps independent state per pool key', () => {
    const tokens = [rec('a'), rec('b')]
    expect(acquireDeepseekToken('p1', tokens)!.record.id).toBe('a')
    expect(acquireDeepseekToken('p2', tokens)!.record.id).toBe('a')
  })
})

/**
 * park 语义。为什么这套行为值得逐条钉住：不 park 时被禁言的账号会在下一次请求里
 * 继续打上游，上游看到同一账号再次违规会**续期窗口甚至升级处罚**
 * （Go 版注释里的实测：6h 禁言 → 3 天封禁）。
 */
describe('park（上游处罚）', () => {
  const parked = (id: string, park: DeepseekTokenRecord['park']): DeepseekTokenRecord => ({ ...rec(id), park })

  it('封禁是永久 park；禁言/风险按窗口判定', () => {
    const now = 1_000_000
    expect(isDeepseekTokenParked(parked('a', { kind: 'banned', reason: 'r', at: now }), now)).toBe(true)
    // 永久 park 即使过了很久也仍然 park
    expect(isDeepseekTokenParked(parked('a', { kind: 'banned', reason: 'r', at: now }), now + 1e12)).toBe(true)

    expect(isDeepseekTokenParked(parked('a', { kind: 'muted', until: now + 1000, reason: 'r', at: now }), now)).toBe(true)
    expect(isDeepseekTokenParked(parked('a', { kind: 'muted', until: now + 1000, reason: 'r', at: now }), now + 1001)).toBe(false)
  })

  it('无 park 字段 = 未 park；禁言缺 until 视为已过期（不永久锁死账号）', () => {
    expect(isDeepseekTokenParked(rec('a'))).toBe(false)
    expect(isDeepseekTokenParked(parked('a', { kind: 'muted', reason: 'r', at: 1 }))).toBe(false)
  })

  it('computeDeepseekPark：封禁无窗口，风险固定冷却，禁言用上游窗口', () => {
    const now = 5_000_000
    const banned = computeDeepseekPark('banned', { reason: 'USER_IS_BANNED', now })
    expect(banned.kind).toBe('banned')
    expect(banned.until).toBeUndefined()

    const risk = computeDeepseekPark('risk', { reason: 'RISK_DEVICE_DETECTED', now })
    expect(risk.until).toBe(now + DEEPSEEK_RISK_COOLDOWN_MS)

    const until = new Date(now + 3600_000)
    const muted = computeDeepseekPark('muted', { until, reason: 'user is muted', now })
    expect(muted.until).toBe(until.getTime())
  })

  it('computeDeepseekPark：mute_until 缺失/已过期 → 退化为 6h 兜底', () => {
    const now = 5_000_000
    expect(computeDeepseekPark('muted', { reason: 'muted', now }).until).toBe(now + DEEPSEEK_MUTE_PARK_DEFAULT_MS)
    // 已经过去的窗口没有意义，兜底而不是「立刻解禁」
    const past = new Date(now - 1000)
    expect(computeDeepseekPark('muted', { until: past, reason: 'muted', now }).until).toBe(
      now + DEEPSEEK_MUTE_PARK_DEFAULT_MS,
    )
    expect(computeDeepseekPark('muted', { until: null, reason: 'muted', now }).until).toBe(
      now + DEEPSEEK_MUTE_PARK_DEFAULT_MS,
    )
  })

  it('park 的 token 不参与轮转（其它 token 继续服务）', () => {
    const now = 1_000_000
    const tokens = [parked('a', { kind: 'muted', until: now + 1000, reason: 'r', at: now }), rec('b')]
    expect(acquireDeepseekToken('p', tokens, DEEPSEEK_DEFAULT_MAX_INFLIGHT, now)?.record.id).toBe('b')
  })

  it('park 到期后自动回到轮转（自然解禁，无需人工）', () => {
    const now = 1_000_000
    const tokens = [parked('a', { kind: 'muted', until: now + 1000, reason: 'r', at: now })]
    expect(acquireDeepseekToken('p', tokens, DEEPSEEK_DEFAULT_MAX_INFLIGHT, now)).toBeNull()
    expect(acquireDeepseekToken('p', tokens, DEEPSEEK_DEFAULT_MAX_INFLIGHT, now + 1001)?.record.id).toBe('a')
  })

  it('全部 park 时返回 null（调用方据此给出处罚专属错误）', () => {
    const now = 1_000_000
    const tokens = [
      parked('a', { kind: 'banned', reason: 'r', at: now }),
      parked('b', { kind: 'risk', until: now + 1000, reason: 'r', at: now }),
    ]
    expect(acquireDeepseekToken('p', tokens, DEEPSEEK_DEFAULT_MAX_INFLIGHT, now)).toBeNull()
  })

  it('park 与 expired 叠加时都不参与轮转', () => {
    const now = 1_000_000
    const tokens = [{ ...parked('a', { kind: 'banned', reason: 'r', at: now }), state: 'expired' as const }]
    expect(acquireDeepseekToken('p', tokens, DEEPSEEK_DEFAULT_MAX_INFLIGHT, now)).toBeNull()
    expect(countReady(tokens, now)).toBe(0)
  })

  it('countReady 把 park 中的 token 排除在外', () => {
    const now = 1_000_000
    const tokens = [rec('a'), parked('b', { kind: 'muted', until: now + 1000, reason: 'r', at: now }), rec('c', 'expired')]
    expect(countReady(tokens, now)).toBe(1)
    expect(countReady(tokens, now + 1001)).toBe(2)
  })

  it('park 写进 KV 并可从面板视图读出（脱敏且带到期时刻）', async () => {
    const env = mockEnv(mockKV())
    // token 必须长于尾部长度，否则 tokenTail 会把整条 token 露出来（脱敏断言才有意义）
    const secret = 'secret-token-value-1234567890'
    const id = (await addDeepseekToken(env, { token: secret, headerDeviceId: 'd1', userAgent: 'UA' })).record!.id
    const until = Date.now() + 3600_000
    await parkDeepseekToken(env, id, { kind: 'muted', until, reason: 'user is muted', at: Date.now() })

    const stored = (await readDeepseekPool(env))[0]
    expect(stored.park?.kind).toBe('muted')
    expect(stored.park?.until).toBe(until)

    const view = toTokenView(stored)
    expect(view.parked).toBe(true)
    expect(view.park?.reason).toBe('user is muted')
    // 脱敏仍然成立：视图里只有尾 6 位，没有整条 token
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(view.tokenTail).toBe(secret.slice(-6))
  })

  it('park 未知 id 返回 null（不静默创建记录）', async () => {
    const env = mockEnv(mockKV())
    expect(await parkDeepseekToken(env, 'nope', { kind: 'banned', reason: 'r', at: 1 })).toBeNull()
  })

  it('unpark 清掉处罚，之后立刻可被选中', async () => {
    const env = mockEnv(mockKV())
    const id = (await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })).record!.id
    await parkDeepseekToken(env, id, { kind: 'banned', reason: 'USER_IS_BANNED', at: Date.now() })
    expect(isDeepseekTokenParked((await readDeepseekPool(env))[0])).toBe(true)

    await unparkDeepseekToken(env, id)
    const after = (await readDeepseekPool(env))[0]
    expect(after.park).toBeUndefined()
    expect(isDeepseekTokenParked(after)).toBe(false)
    expect(acquireDeepseekToken('p', [after])?.record.id).toBe(id)
  })

  it('unpark 幂等：本来没有 park 也成功', async () => {
    const env = mockEnv(mockKV())
    const id = (await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })).record!.id
    expect((await unparkDeepseekToken(env, id))?.id).toBe(id)
    expect(await unparkDeepseekToken(env, 'nope')).toBeNull()
  })

  /**
   * 为什么必须回写 KV：过期 park 留在存储里，重启后会被当成「仍在 park」重新装载
   * （Go 版 `TestRestartExpiredParkRotatesNormally` 测的正是这条）。
   */
  it('clearExpiredDeepseekParks 清掉过期 park 并落盘，保留未过期与永久封禁', async () => {
    const env = mockEnv(mockKV())
    const now = 1_000_000
    await writeDeepseekPool(env, [
      { ...rec('past'), park: { kind: 'muted', until: now - 1, reason: 'stale', at: now - 100 } },
      { ...rec('live'), park: { kind: 'muted', until: now + 1000, reason: 'live', at: now } },
      { ...rec('forever'), park: { kind: 'banned', reason: 'USER_IS_BANNED', at: now } },
    ])

    expect(await clearExpiredDeepseekParks(env, await readDeepseekPool(env), now)).toBe(1)
    const stored = await readDeepseekPool(env)
    expect(stored.find((t) => t.id === 'past')!.park).toBeUndefined()
    expect(stored.find((t) => t.id === 'live')!.park?.kind).toBe('muted')
    expect(stored.find((t) => t.id === 'forever')!.park?.kind).toBe('banned')
  })

  it('clearExpiredDeepseekParks 无过期项时不写 KV（避免无谓写入）', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    const now = 1_000_000
    await writeDeepseekPool(env, [{ ...rec('live'), park: { kind: 'muted', until: now + 1000, reason: 'r', at: now } }])
    let writes = 0
    const counting = {
      ...kv,
      put: async (k: string, v: string) => {
        writes++
        kv.map.set(k, v)
      },
    }
    expect(await clearExpiredDeepseekParks(mockEnv(counting as never), await readDeepseekPool(env), now)).toBe(0)
    expect(writes).toBe(0)
  })

  /** 成功即意味着处罚窗口已经过去：顺带清 park，等价于 Go 版「自然解禁要回写」。 */
  it('markDeepseekToken({ok:true}) 清掉 park 字段', async () => {
    const env = mockEnv(mockKV())
    const id = (await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })).record!.id
    await parkDeepseekToken(env, id, { kind: 'muted', until: Date.now() - 1, reason: 'stale', at: 1 })

    await markDeepseekToken(env, id, { ok: true })
    const stored = (await readDeepseekPool(env))[0]
    expect(stored.park).toBeUndefined()
    expect(stored.state).toBe('ready')
  })
})
