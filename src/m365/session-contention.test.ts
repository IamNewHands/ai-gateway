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

  it('does not report account-lock acquisition success when the conditional upsert writes zero rows', () => {
    const state = createFaithfulSqlState()
    const first = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))
    const second = new M365SessionStore(asDurableStorage(new FaithfulSqlStorage(state)))

    expect(first.acquireAccountLock('account-1', 'session-a', 'lease-a', 100, 100)).toEqual({
      ok: true,
      expiresAt: 200,
    })
    expect(second.acquireAccountLock('account-1', 'session-b', 'lease-b', 150, 100)).toEqual({
      ok: false,
      reason: 'account_locked',
      ownerSessionId: 'session-a',
      expiresAt: 200,
    })
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
