import { describe, it, expect, beforeEach } from 'vitest'
import {
  STICKY_KV_PREFIX,
  DEFAULT_STICKY_TTL_MS,
  hashIndex,
  pruneExpired,
  readStickyTable,
  writeStickyTable,
  resolveSticky,
  bindSticky,
  unbindSticky,
  allocateSticky,
  resolveOrAllocateSticky,
  __resetStickyCacheForTests,
  type StickyTable,
} from './workbuddy-sticky'
import type { Env } from './types'

const PID = 'wb-sticky-test'

function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV: kv } as unknown as Env, store }
}

/** 写入绑定表（绕过内存缓存，直接落 KV）。 */
function seed(store: Map<string, string>, table: StickyTable) {
  store.set(STICKY_KV_PREFIX + PID, JSON.stringify(table))
}

function readKV(store: Map<string, string>): StickyTable {
  const raw = store.get(STICKY_KV_PREFIX + PID)
  return raw ? JSON.parse(raw) : {}
}

describe('hashIndex（FNV-1a 32 位确定性哈希）', () => {
  it('同 key 同 n 恒同值（粘性确定性的前提）', () => {
    expect(hashIndex('sess-1', 10)).toBe(hashIndex('sess-1', 10))
    expect(hashIndex('sess-1', 100)).toBe(hashIndex('sess-1', 100))
  })

  it('结果恒在 [0, n) 内（含负数取模防护）', () => {
    for (const key of ['a', 'b', 'conversation-长中文-1', '', 'x'.repeat(200)]) {
      for (const n of [1, 2, 7, 100]) {
        const idx = hashIndex(key, n)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(n)
        expect(Number.isInteger(idx)).toBe(true)
      }
    }
  })

  it('n <= 0 → 0（不抛错、不返回负索引）', () => {
    expect(hashIndex('k', 0)).toBe(0)
    expect(hashIndex('k', -5)).toBe(0)
  })

  it('不同 key 会分散到不同索引（非恒等映射）', () => {
    const idxs = new Set(Array.from({ length: 50 }, (_, i) => hashIndex(`sess-${i}`, 50)))
    // 50 个键散到 50 个槽：期望大部分不同（FNV-1a 分布良好）
    expect(idxs.size).toBeGreaterThan(20)
  })
})

describe('pruneExpired（惰性清理过期绑定）', () => {
  it('删除超 TTL 的条目，保留未过期', () => {
    const now = Date.now()
    const table: StickyTable = {
      fresh: { uid: 'u1', lastActive: now },
      stale: { uid: 'u2', lastActive: now - DEFAULT_STICKY_TTL_MS - 1000 },
    }
    expect(pruneExpired(table, now)).toBe(true)
    expect(table['fresh']).toBeDefined()
    expect(table['stale']).toBeUndefined()
  })

  it('无过期项 → 返回 false（不产生无谓 KV 写）', () => {
    const now = Date.now()
    const table: StickyTable = { fresh: { uid: 'u1', lastActive: now } }
    expect(pruneExpired(table, now)).toBe(false)
  })

  it('lastActive 缺失/非法 → 视为过期删除', () => {
    const now = Date.now()
    const table = {
      bad: { uid: 'u1' } as unknown as { uid: string; lastActive: number },
    }
    expect(pruneExpired(table as StickyTable, now)).toBe(true)
    expect(table['bad']).toBeUndefined()
  })
})

describe('readStickyTable / writeStickyTable', () => {
  beforeEach(() => { __resetStickyCacheForTests() })

  it('KV 为空 → 空表', async () => {
    const { env } = makeEnv()
    expect(await readStickyTable(env, PID)).toEqual({})
  })

  it('KV 损坏（非 JSON / 数组）→ 空表（不抛错）', async () => {
    const { env, store } = makeEnv()
    store.set(STICKY_KV_PREFIX + PID, '{ not json')
    expect(await readStickyTable(env, PID)).toEqual({})

    __resetStickyCacheForTests()
    store.set(STICKY_KV_PREFIX + PID, '[1,2,3]')
    expect(await readStickyTable(env, PID)).toEqual({})
  })

  it('写入后可读回', async () => {
    const { env, store } = makeEnv()
    await writeStickyTable(env, PID, { s1: { uid: 'u1', lastActive: 123 } })
    expect(readKV(store)).toEqual({ s1: { uid: 'u1', lastActive: 123 } })
  })
})

describe('resolveSticky（命中判定 + 模型维度校验）', () => {
  beforeEach(() => { __resetStickyCacheForTests() })

  it('空会话键 → 未命中', async () => {
    const { env } = makeEnv()
    const r = await resolveSticky(env, PID, '', () => true)
    expect(r).toEqual({ uid: '', hit: false })
  })

  it('无绑定 → 未命中', async () => {
    const { env } = makeEnv()
    const r = await resolveSticky(env, PID, 'sess-1', () => true)
    expect(r).toEqual({ uid: '', hit: false })
  })

  it('命中且可用 → 返回绑定 uid 并滚动 lastActive', async () => {
    const { env, store } = makeEnv()
    const old = Date.now() - 60_000
    seed(store, { 'sess-1': { uid: 'u1', lastActive: old } })
    __resetStickyCacheForTests()

    const r = await resolveSticky(env, PID, 'sess-1', (uid) => uid === 'u1')
    expect(r).toEqual({ uid: 'u1', hit: true })
    // lastActive 已滚动（内存态）
    const table = await readStickyTable(env, PID)
    expect(table['sess-1'].lastActive).toBeGreaterThan(old)
  })

  it('命中但绑定号不可用（冷却/禁用/被该模型限额）→ 失效并解绑', async () => {
    const { env, store } = makeEnv()
    seed(store, { 'sess-1': { uid: 'u1', lastActive: Date.now() } })
    __resetStickyCacheForTests()

    // 该 uid 不可用（模拟被当前模型 6004 限额）
    const r = await resolveSticky(env, PID, 'sess-1', () => false)
    expect(r).toEqual({ uid: '', hit: false })
    // 已从 KV 解绑，避免下次再查
    expect(readKV(store)['sess-1']).toBeUndefined()
  })

  it('绑定已过期 → 失效并解绑', async () => {
    const { env, store } = makeEnv()
    seed(store, { 'sess-1': { uid: 'u1', lastActive: Date.now() - DEFAULT_STICKY_TTL_MS - 1000 } })
    __resetStickyCacheForTests()

    const r = await resolveSticky(env, PID, 'sess-1', () => true)
    expect(r).toEqual({ uid: '', hit: false })
    expect(readKV(store)['sess-1']).toBeUndefined()
  })

  it('自定义 TTL 生效', async () => {
    const { env, store } = makeEnv()
    seed(store, { 'sess-1': { uid: 'u1', lastActive: Date.now() - 5000 } })
    __resetStickyCacheForTests()

    // TTL 1000ms → 5s 前的绑定已过期
    const r = await resolveSticky(env, PID, 'sess-1', () => true, 1000)
    expect(r.hit).toBe(false)
  })
})

describe('bindSticky / unbindSticky', () => {
  beforeEach(() => { __resetStickyCacheForTests() })

  it('绑定后可命中', async () => {
    const { env } = makeEnv()
    await bindSticky(env, PID, 'sess-1', 'u1')
    const r = await resolveSticky(env, PID, 'sess-1', () => true)
    expect(r).toEqual({ uid: 'u1', hit: true })
  })

  it('绑定幂等覆盖旧值', async () => {
    const { env, store } = makeEnv()
    await bindSticky(env, PID, 'sess-1', 'u1')
    await bindSticky(env, PID, 'sess-1', 'u2')
    expect(readKV(store)['sess-1'].uid).toBe('u2')
  })

  it('空 key / 空 uid 不写入', async () => {
    const { env, store } = makeEnv()
    await bindSticky(env, PID, '', 'u1')
    await bindSticky(env, PID, 'sess-1', '')
    expect(readKV(store)).toEqual({})
  })

  it('解绑返回是否确有变更', async () => {
    const { env } = makeEnv()
    await bindSticky(env, PID, 'sess-1', 'u1')
    expect(await unbindSticky(env, PID, 'sess-1')).toBe(true)
    expect(await unbindSticky(env, PID, 'sess-1')).toBe(false)
    expect(await unbindSticky(env, PID, '')).toBe(false)
  })
})

describe('allocateSticky（双段策略）', () => {
  it('候选为空 → 空串', () => {
    expect(allocateSticky({}, 'sess-1', [])).toBe('')
  })

  it('无任何绑定时从全候选哈希取（确定性）', () => {
    const cands = ['u1', 'u2', 'u3', 'u4']
    const a = allocateSticky({}, 'sess-1', cands)
    const b = allocateSticky({}, 'sess-1', cands)
    expect(a).toBe(b)
    expect(cands).toContain(a)
  })

  it('优先「空闲号」：已被其他会话绑定的 uid 排除在首选池外', () => {
    // u1/u2 已被占用，u3 空闲 → 即便哈希本会命中 u1，也应落 u3
    const table: StickyTable = {
      other1: { uid: 'u1', lastActive: Date.now() },
      other2: { uid: 'u2', lastActive: Date.now() },
    }
    const uid = allocateSticky(table, 'new-sess', ['u1', 'u2', 'u3'])
    expect(uid).toBe('u3')
  })

  it('空闲耗尽 → 回落全候选集（不返回空）', () => {
    const table: StickyTable = {
      other1: { uid: 'u1', lastActive: Date.now() },
      other2: { uid: 'u2', lastActive: Date.now() },
    }
    const uid = allocateSticky(table, 'new-sess', ['u1', 'u2'])
    expect(['u1', 'u2']).toContain(uid)
  })
})

describe('resolveOrAllocateSticky（完整两段流程）', () => {
  beforeEach(() => { __resetStickyCacheForTests() })

  it('无会话键 → 空串（不做粘性）', async () => {
    const { env } = makeEnv()
    expect(await resolveOrAllocateSticky(env, PID, '', () => true, ['u1'])).toBe('')
  })

  it('首次分配后写入绑定，二次调用命中同号', async () => {
    const { env } = makeEnv()
    const cands = ['u1', 'u2', 'u3']
    const first = await resolveOrAllocateSticky(env, PID, 'sess-1', () => true, cands)
    expect(cands).toContain(first)
    const second = await resolveOrAllocateSticky(env, PID, 'sess-1', () => true, cands)
    expect(second).toBe(first)
  })

  it('候选为空 → 空串（不写入空绑定）', async () => {
    const { env, store } = makeEnv()
    expect(await resolveOrAllocateSticky(env, PID, 'sess-1', () => true, [])).toBe('')
    expect(readKV(store)).toEqual({})
  })

  it('绑定号失效后重新分配（可能换号）', async () => {
    const { env } = makeEnv()
    await bindSticky(env, PID, 'sess-1', 'u1')
    // u1 不可用 → 重分配
    const uid = await resolveOrAllocateSticky(env, PID, 'sess-1', (u) => u !== 'u1', ['u1', 'u2'])
    expect(uid).toBe('u2')
  })

  it('分配时惰性清理过期项（防表膨胀）', async () => {
    const { env, store } = makeEnv()
    seed(store, {
      old: { uid: 'u9', lastActive: Date.now() - DEFAULT_STICKY_TTL_MS - 1000 },
    })
    __resetStickyCacheForTests()

    await resolveOrAllocateSticky(env, PID, 'sess-new', () => true, ['u1', 'u2'])
    expect(readKV(store)['old']).toBeUndefined()
  })
})
