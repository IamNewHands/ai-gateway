import { describe, expect, it } from 'vitest'
import { createEmptySessionSnapshot } from './session-state'
import { M365SessionStore } from './session-store'
import { FaithfulSqlStorage, createFaithfulSqlState } from './test-sql-storage'

function asDurableStorage(sql: FaithfulSqlStorage): DurableObjectStorage {
  return {
    sql,
    transactionSync: sql.transactionSync.bind(sql),
  } as unknown as DurableObjectStorage
}

describe('M365 SQL session contention', () => {
  it('allows only one SQL writer to commit the same expected generation', () => {
    const state = createFaithfulSqlState()
    const first = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    const second = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    const firstSnapshot = first.loadOrCreate('shared-session')
    const secondSnapshot = second.loadOrCreate('shared-session')

    firstSnapshot.taskAnchors = [{ kind: 'windows_path', value: 'D:\\first' }]
    secondSnapshot.taskAnchors = [{ kind: 'windows_path', value: 'D:\\second' }]

    expect(first.compareAndSwap(firstSnapshot, 0)).toEqual({ ok: true, generation: 1 })
    expect(second.compareAndSwap(secondSnapshot, 0)).toEqual({
      ok: false,
      reason: 'generation_conflict',
      generation: 1,
    })

    const restarted = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    expect(restarted.loadOrCreate('shared-session').taskAnchors).toEqual([
      { kind: 'windows_path', value: 'D:\\first' },
    ])
  })

  it('does not report lease acquisition success when the generation-bound SQL update writes zero rows', () => {
    const state = createFaithfulSqlState()
    const first = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    const stale = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    const committed = first.loadOrCreate('lease-stale-generation')
    stale.loadOrCreate('lease-stale-generation')

    expect(first.compareAndSwap(committed, 0)).toEqual({ ok: true, generation: 1 })

    expect(stale.acquireLease({
      sessionId: 'lease-stale-generation',
      accountId: 'account-1',
      token: 'lease-stale',
      expectedGeneration: 0,
      now: 100,
      ttlMs: 100,
    })).not.toEqual({ ok: true, expiresAt: 200 })
  })

  it('owns no cross-session account lock: account serialization belongs to AccountFlux', () => {
    // 回归护栏（log3）：账号级独占曾以 SQLite 表形式实现在"按会话分片"的 store 里，
    // 天然无法跨会话协调，只会在同一会话内自锁 → 首次发起的会话也可能报 account_locked。
    // 账号级串行现由 AccountFlux（M365_FLUX 共享 DO）统一负责，store 不得再暴露任何账号锁 API/表。
    const sql = new FaithfulSqlStorage(createFaithfulSqlState())
    const store = new M365SessionStore(asDurableStorage(sql)) as unknown as Record<string, unknown>
    for (const name of ['acquireAccountLock', 'heartbeatAccountLock', 'releaseAccountLock']) {
      expect(store[name]).toBeUndefined()
    }
    const schema = sql.statements.map((s) => s.query).join('\n')
    expect(schema).not.toMatch(/m365_account_locks/i)
    // 会话租约本身仍在（它是"会话↔账号"归属绑定，与账号锁是两件事）
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS m365_sessions/i)
  })

  it('resolves a response index through a fresh SQL storage instance', () => {
    const state = createFaithfulSqlState()
    const first = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    first.indexPreviousResponse('resp-1', 'session-1', 4)

    const restarted = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    expect(restarted.resolvePreviousResponse('resp-1')).toEqual({
      sessionId: 'session-1',
      generation: 4,
    })
  })
})
