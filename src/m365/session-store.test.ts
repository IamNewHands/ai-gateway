import { describe, expect, it } from 'vitest'
import { createEmptySessionSnapshot } from './session-state'
import { M365SessionStore } from './session-store'
import { FaithfulSqlStorage, createFaithfulSqlState } from './test-sql-storage'

class MemorySqlStorage extends FaithfulSqlStorage {
  constructor(private readonly conditionalUpdateRowsWritten?: number) {
    super()
  }

  override exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ) {
    const result = super.exec<T>(query, ...bindings)
    const isGenerationCas = /UPDATE\s+m365_sessions[\s\S]*SET\s+generation[\s\S]*WHERE\s+session_id\s*=\s*\?\s+AND\s+generation\s*=\s*\?/i.test(query)
    if (isGenerationCas && this.conditionalUpdateRowsWritten !== undefined) {
      return { ...result, rowsWritten: this.conditionalUpdateRowsWritten }
    }
    return result
  }
}

class FailingResponseIndexSqlStorage extends FaithfulSqlStorage {
  override exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ) {
    if (/INSERT\s+INTO\s+m365_response_index/i.test(query)) {
      throw new Error('SIMULATED_RESPONSE_INDEX_FAILURE')
    }
    return super.exec<T>(query, ...bindings)
  }
}

describe('M365 Durable Object SQL session store', () => {
  it('initializes only additive versioned schema objects', () => {
    const sql = new MemorySqlStorage()

    new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    const schema = sql.statements.map((statement) => statement.query).join('\n')
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS m365_sessions/i)
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS m365_response_index/i)
    expect(schema).toMatch(/CREATE INDEX IF NOT EXISTS/i)
    // 账号级独占不在这里：本 store 按会话分片，账号锁必须由 AccountFlux 共享 DO 承担
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS m365_account_locks/i)
    expect(schema).not.toMatch(/\bDROP\b|\bDELETE\b/i)
  })

  it('creates an empty snapshot when the session does not exist', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    const snapshot = store.loadOrCreate('session-1')

    expect(snapshot).toEqual(createEmptySessionSnapshot('session-1'))
    expect(sql.statements.some(({ query }) => /INSERT/i.test(query))).toBe(true)
  })

  it('rejects a compare-and-swap when the conditional SQL update writes zero rows', () => {
    const sql = new MemorySqlStorage(0)
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
    const snapshot = createEmptySessionSnapshot('session-cas')

    expect(store.compareAndSwap(snapshot, 0)).toEqual({
      ok: false,
      reason: 'generation_conflict',
      generation: 1,
    })
  })

  it('acquires, heartbeats and releases a generation-bound lease', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
    store.loadOrCreate('session-lease')

    const acquired = store.acquireLease({
      sessionId: 'session-lease',
      accountId: 'account-1',
      token: 'lease-1',
      expectedGeneration: 0,
      now: 100,
      ttlMs: 50,
    })
    expect(acquired).toEqual({ ok: true, expiresAt: 150 })
    expect(store.heartbeatLease('session-lease', 'lease-1', 120, 50)).toEqual({
      ok: true,
      expiresAt: 170,
    })
    expect(store.releaseLease('session-lease', 'lease-1')).toEqual({ ok: true })
  })

  it('migrates lease account identity only for the exact current owner', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
    const snapshot = store.loadOrCreate('session-migrate')

    expect(store.acquireLease({
      sessionId: snapshot.sessionId,
      accountId: 'account-1',
      token: 'lease-owner',
      expectedGeneration: snapshot.generation,
      now: 100,
      ttlMs: 50,
    })).toEqual({ ok: true, expiresAt: 150 })

    expect(store.migrateLeaseAccount('session-migrate', 'lease-owner', 'account-1', 'account-2')).toEqual({ ok: true })
    expect(store.loadOrCreate('session-migrate').lease?.accountId).toBe('account-2')
    expect(store.migrateLeaseAccount('session-migrate', 'lease-owner', 'account-1', 'account-3')).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
    expect(store.migrateLeaseAccount('session-migrate', 'wrong-lease', 'account-2', 'account-3')).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
  })

  it('recovers only the committed SQL snapshot through a fresh storage instance', () => {
    const state = createFaithfulSqlState()
    const firstSql = new FaithfulSqlStorage(state)
    const first = new M365SessionStore(({ sql: firstSql, transactionSync: firstSql.transactionSync.bind(firstSql) } as unknown as DurableObjectStorage))
    const snapshot = first.loadOrCreate('session-restart')
    snapshot.protocolTail = {
      protocol: 'responses',
      previousResponseId: 'resp-committed',
      items: [{ type: 'function_call', call_id: 'call-1' }],
    }
    expect(first.compareAndSwap(snapshot, 0)).toEqual({ ok: true, generation: 1 })

    snapshot.protocolTail.previousResponseId = 'resp-uncommitted'
    const restartedSql = new FaithfulSqlStorage(state)
    const restarted = new M365SessionStore(({ sql: restartedSql, transactionSync: restartedSql.transactionSync.bind(restartedSql) } as unknown as DurableObjectStorage))

    expect(restarted.loadOrCreate('session-restart')).toMatchObject({
      sessionId: 'session-restart',
      generation: 1,
      protocolTail: {
        protocol: 'responses',
        previousResponseId: 'resp-committed',
      },
    })
    expect(restartedSql.statements.some(({ query }) => /SELECT\s+snapshot_json,\s*generation,\s*lease_token,\s*lease_account_id,\s*lease_expires_at,\s*lease_renewed_at\s+FROM\s+m365_sessions/i.test(query))).toBe(true)
  })

  it('atomically commits canonical state and response index only for the active lease token', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
    const snapshot = store.loadOrCreate('session-atomic-commit')

    expect(store.acquireLease({
      sessionId: snapshot.sessionId,
      accountId: 'account-1',
      token: 'lease-owner',
      expectedGeneration: snapshot.generation,
      now: 100,
      ttlMs: 50,
    })).toEqual({ ok: true, expiresAt: 150 })

    snapshot.protocolTail = {
      protocol: 'responses',
      previousResponseId: 'resp-atomic',
      items: [{ type: 'function_call', call_id: 'call-atomic' }],
    }

    expect(store.commitWithLease({
      snapshot,
      expectedGeneration: 0,
      leaseToken: 'wrong-lease',
      responseId: 'resp-atomic',
    })).toEqual({ ok: false, reason: 'lease_conflict', generation: 0 })
    expect(store.resolvePreviousResponse('resp-atomic')).toBeNull()

    expect(store.commitWithLease({
      snapshot,
      expectedGeneration: 0,
      leaseToken: 'lease-owner',
      responseId: 'resp-atomic',
    })).toEqual({ ok: true, generation: 1 })
    expect(store.loadOrCreate(snapshot.sessionId)).toMatchObject({
      generation: 1,
      protocolTail: {
        protocol: 'responses',
        previousResponseId: 'resp-atomic',
        items: [{ type: 'function_call', call_id: 'call-atomic' }],
      },
    })
    expect(store.resolvePreviousResponse('resp-atomic')).toEqual({
      sessionId: snapshot.sessionId,
      generation: 1,
    })
  })

  it('indexes previous response ids back to the owning session', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    store.indexPreviousResponse('resp-1', 'session-1', 4)
    store.indexPreviousResponse('resp-1', 'session-2', 5)

    expect(store.resolvePreviousResponse('resp-1')).toEqual({
      sessionId: 'session-1',
      generation: 4,
    })
  })
  it('rolls back the canonical session commit when response indexing fails', () => {
    const sql = new FailingResponseIndexSqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
    const snapshot = store.loadOrCreate('session-atomic-tx')

    expect(store.acquireLease({
      sessionId: snapshot.sessionId,
      accountId: 'account-1',
      token: 'lease-owner',
      expectedGeneration: snapshot.generation,
      now: 100,
      ttlMs: 50,
    })).toEqual({ ok: true, expiresAt: 150 })

    snapshot.protocolTail = {
      protocol: 'responses',
      previousResponseId: 'resp-tx',
      items: [{ type: 'function_call', call_id: 'call-tx' }],
    }

    expect(() => store.commitWithLease({
      snapshot,
      expectedGeneration: 0,
      leaseToken: 'lease-owner',
      responseId: 'resp-tx',
    })).toThrow('SIMULATED_RESPONSE_INDEX_FAILURE')

    expect(store.loadOrCreate(snapshot.sessionId)).toMatchObject({
      generation: 0,
      protocolTail: {
        items: [],
      },
    })
    expect(store.resolvePreviousResponse('resp-tx')).toBeNull()
  })

  it('assigns unique non-empty sessionId when loadOrCreate receives empty or whitespace string', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    const snapshot1 = store.loadOrCreate('')
    const snapshot2 = store.loadOrCreate('   ')

    expect(snapshot1.sessionId).toBeTruthy()
    expect(snapshot2.sessionId).toBeTruthy()
    expect(snapshot1.sessionId).not.toBe('')
    expect(snapshot2.sessionId).not.toBe('')
    expect(snapshot1.sessionId).not.toBe(snapshot2.sessionId)
  })

  // 回归：log2 会话中"首次请求失败后 3 秒重试仍拿到 409 lease_conflict"的形态。
  // 根因是孤儿租约（持有者崩溃/isolate 回收/客户端断连未走 finally）把会话行一直占到 TTL 结束。
  describe('orphaned lease supersede (log2 regression)', () => {
    function acquiredLease(store: M365SessionStore, sessionId: string, now: number, ttlMs: number) {
      const snapshot = store.loadOrCreate(sessionId)
      const acquired = store.acquireLease({
        sessionId,
        accountId: 'account-1',
        token: 'lease-owner',
        expectedGeneration: snapshot.generation,
        now,
        ttlMs,
      })
      expect(acquired.ok).toBe(true)
      return snapshot
    }

    it('refuses to steal a lease whose owner is still heartbeating', () => {
      const sql = new MemorySqlStorage()
      const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
      acquiredLease(store, 's-live', 1_000, 60_000)

      // 持有者在 40s 处续约（心跳新鲜），此时租约远未过期
      expect(store.heartbeatLease('s-live', 'lease-owner', 41_000, 60_000).ok).toBe(true)

      const stolen = store.supersedeLease({
        sessionId: 's-live',
        accountId: 'account-1',
        token: 'lease-retry',
        expectedGeneration: store.loadOrCreate('s-live').generation,
        now: 50_000,
        ttlMs: 60_000,
        staleMs: 45_000,
      })
      expect(stolen).toEqual({ ok: false, reason: 'lease_conflict', expiresAt: 101_000 })
    })

    it('steals a lease whose owner stopped heartbeating even before TTL expiry', () => {
      const sql = new MemorySqlStorage()
      const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
      acquiredLease(store, 's-dead', 1_000, 60_000)

      // 持有者在 1s 处取得租约后再无心跳（进程死亡）；租约要到 61_000 才过期
      const stolen = store.supersedeLease({
        sessionId: 's-dead',
        accountId: 'account-1',
        token: 'lease-retry',
        expectedGeneration: store.loadOrCreate('s-dead').generation,
        now: 50_000,
        ttlMs: 60_000,
        staleMs: 45_000,
      })

      expect(stolen).toEqual({ ok: true, expiresAt: 110_000 })
      // 抢占后新持有者可正常续约与释放
      expect(store.loadOrCreate('s-dead').lease?.token).toBe('lease-retry')
      expect(store.releaseLease('s-dead', 'lease-retry')).toEqual({ ok: true })
    })

    it('steals a lease that already expired regardless of heartbeat age', () => {
      const sql = new MemorySqlStorage()
      const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
      acquiredLease(store, 's-expired', 1_000, 5_000)

      const stolen = store.supersedeLease({
        sessionId: 's-expired',
        accountId: 'account-1',
        token: 'lease-retry',
        expectedGeneration: store.loadOrCreate('s-expired').generation,
        now: 10_000,
        ttlMs: 60_000,
        staleMs: 45_000,
      })
      expect(stolen).toEqual({ ok: true, expiresAt: 70_000 })
    })

    it('does not steal when the original owner released the lease first', () => {
      const sql = new MemorySqlStorage()
      const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
      acquiredLease(store, 's-released', 1_000, 60_000)
      expect(store.releaseLease('s-released', 'lease-owner')).toEqual({ ok: true })

      // 已释放：走普通获取路径，直接成功而非"抢占"
      const next = store.supersedeLease({
        sessionId: 's-released',
        accountId: 'account-1',
        token: 'lease-retry',
        expectedGeneration: store.loadOrCreate('s-released').generation,
        now: 2_000,
        ttlMs: 60_000,
        staleMs: 45_000,
      })
      expect(next).toEqual({ ok: true, expiresAt: 62_000 })
    })

    it('reports renewedAt through the snapshot lease after acquire and heartbeat', () => {
      const sql = new MemorySqlStorage()
      const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))
      acquiredLease(store, 's-renewed', 1_000, 60_000)
      expect(store.loadOrCreate('s-renewed').lease?.renewedAt).toBe(1_000)

      store.heartbeatLease('s-renewed', 'lease-owner', 20_000, 60_000)
      expect(store.loadOrCreate('s-renewed').lease?.renewedAt).toBe(20_000)
    })
  })
})
