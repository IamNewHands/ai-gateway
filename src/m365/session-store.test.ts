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
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS m365_account_locks/i)
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS m365_response_index/i)
    expect(schema).toMatch(/CREATE INDEX IF NOT EXISTS/i)
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

  it('rejects account-lock contention until the current lock expires', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    expect(store.acquireAccountLock('account-1', 'session-a', 'lease-a', 100, 50)).toEqual({
      ok: true,
      expiresAt: 150,
    })
    expect(store.acquireAccountLock('account-1', 'session-b', 'lease-b', 120, 50)).toEqual({
      ok: false,
      reason: 'account_locked',
      ownerSessionId: 'session-a',
      expiresAt: 150,
    })
    expect(store.acquireAccountLock('account-1', 'session-b', 'lease-b', 151, 50)).toEqual({
      ok: true,
      expiresAt: 201,
    })
  })

  it('heartbeats an account lock only for its exact session and lease owner', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    expect(store.acquireAccountLock('account-1', 'session-owner', 'lease-owner', 100, 50)).toEqual({
      ok: true,
      expiresAt: 150,
    })
    expect(store.heartbeatAccountLock('account-1', 'session-owner', 'lease-owner', 120, 50)).toEqual({
      ok: true,
      expiresAt: 170,
    })
    expect(store.heartbeatAccountLock('account-1', 'session-other', 'lease-owner', 130, 50)).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
    expect(store.heartbeatAccountLock('account-1', 'session-owner', 'lease-other', 130, 50)).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
    expect(store.heartbeatAccountLock('account-2', 'session-owner', 'lease-owner', 130, 50)).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
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
    expect(restartedSql.statements.some(({ query }) => /SELECT\s+snapshot_json,\s*generation,\s*lease_token,\s*lease_account_id,\s*lease_expires_at\s+FROM\s+m365_sessions/i.test(query))).toBe(true)
  })

  it('releases an account lock only for its owning session and lease token', () => {
    const sql = new MemorySqlStorage()
    const store = new M365SessionStore(({ sql, transactionSync: sql.transactionSync.bind(sql) } as unknown as DurableObjectStorage))

    expect(store.acquireAccountLock('account-1', 'session-owner', 'lease-owner', 100, 50)).toEqual({
      ok: true,
      expiresAt: 150,
    })

    expect(store.releaseAccountLock('account-1', 'session-owner', 'wrong-lease')).toEqual({
      ok: false,
      reason: 'lease_conflict',
    })
    expect(store.acquireAccountLock('account-1', 'session-other', 'lease-other', 120, 50)).toMatchObject({
      ok: false,
      reason: 'account_locked',
      ownerSessionId: 'session-owner',
    })

    expect(store.releaseAccountLock('account-1', 'session-owner', 'lease-owner')).toEqual({ ok: true })
    expect(store.acquireAccountLock('account-1', 'session-other', 'lease-other', 120, 50)).toEqual({
      ok: true,
      expiresAt: 170,
    })
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
})
