import {
  createEmptySessionSnapshot,
  decodeSessionSnapshot,
  encodeSessionSnapshot,
} from './session-state'
import type { SessionSnapshotV1 } from './session-state'

export type CompareAndSwapResult =
  | { ok: true; generation: number }
  | { ok: false; reason: 'generation_conflict'; generation: number }

export type LeaseCommitResult =
  | { ok: true; generation: number }
  | { ok: false; reason: 'generation_conflict' | 'lease_conflict'; generation: number }

export type LeaseResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: 'generation_conflict' | 'lease_conflict'; generation?: number; expiresAt?: number }

export type ReleaseResult =
  | { ok: true }
  | { ok: false; reason: 'lease_conflict' }

export type AccountLockResult =
  | { ok: true; expiresAt: number }
  | {
      ok: false
      reason: 'account_locked'
      ownerSessionId: string
      expiresAt: number
    }

function cloneSnapshot(snapshot: SessionSnapshotV1): SessionSnapshotV1 {
  return decodeSessionSnapshot(encodeSessionSnapshot(snapshot))
}

type TransactionalSqlStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>

export class M365SessionStore {
  private readonly sql: SqlStorage

  constructor(private readonly storage: TransactionalSqlStorage) {
    this.sql = storage.sql
    this.initializeSchema()
  }

  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS m365_sessions (
        session_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        lease_token TEXT,
        lease_account_id TEXT,
        lease_expires_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS m365_account_locks (
        account_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS m365_response_index (
        response_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL
      )
    `)
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS m365_sessions_lease_expiry_idx
      ON m365_sessions (lease_expires_at)
    `)
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS m365_response_session_idx
      ON m365_response_index (session_id, generation)
    `)
  }

  loadOrCreate(sessionId: string): SessionSnapshotV1 {
    const emptySnapshot = createEmptySessionSnapshot(sessionId)
    this.sql.exec(
      `INSERT OR IGNORE INTO m365_sessions
       (session_id, generation, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      sessionId,
      emptySnapshot.generation,
      encodeSessionSnapshot(emptySnapshot),
      Date.now(),
    )

    const rows = this.sql.exec<{
      snapshot_json: string
      generation: number
      lease_token: string | null
      lease_account_id: string | null
      lease_expires_at: number | null
    }>(
      `SELECT snapshot_json, generation, lease_token, lease_account_id, lease_expires_at
       FROM m365_sessions
       WHERE session_id = ?`,
      sessionId,
    ).toArray()
    if (rows.length !== 1) throw new Error('M365_SESSION_ROW_MISSING_AFTER_INSERT')

    const snapshot = decodeSessionSnapshot(rows[0].snapshot_json)
    snapshot.generation = rows[0].generation
    snapshot.lease = rows[0].lease_token && rows[0].lease_account_id && rows[0].lease_expires_at !== null
      ? {
          token: rows[0].lease_token,
          generation: rows[0].generation,
          accountId: rows[0].lease_account_id,
          expiresAt: rows[0].lease_expires_at,
        }
      : null
    return snapshot
  }

  compareAndSwap(snapshot: SessionSnapshotV1, expectedGeneration: number): CompareAndSwapResult {
    const current = this.loadOrCreate(snapshot.sessionId)
    if (current.generation !== expectedGeneration) {
      return {
        ok: false,
        reason: 'generation_conflict',
        generation: current.generation,
      }
    }

    const next = cloneSnapshot(snapshot)
    next.generation = expectedGeneration + 1
    const cursor = this.sql.exec(
      `UPDATE m365_sessions
       SET generation = ?, snapshot_json = ?, updated_at = ?
       WHERE session_id = ? AND generation = ?`,
      next.generation,
      encodeSessionSnapshot(next),
      Date.now(),
      next.sessionId,
      expectedGeneration,
    )
    if (cursor.rowsWritten !== 1) {
      const rows = this.sql.exec<{ generation: number }>(
        'SELECT generation FROM m365_sessions WHERE session_id = ?',
        next.sessionId,
      ).toArray()
      return {
        ok: false,
        reason: 'generation_conflict',
        generation: rows[0]?.generation ?? current.generation,
      }
    }

    return { ok: true, generation: next.generation }
  }

  commitWithLease(input: {
    snapshot: SessionSnapshotV1
    expectedGeneration: number
    leaseToken: string
    responseId?: string
  }): LeaseCommitResult {
    const current = this.loadOrCreate(input.snapshot.sessionId)
    if (current.generation !== input.expectedGeneration) {
      return {
        ok: false,
        reason: 'generation_conflict',
        generation: current.generation,
      }
    }
    if (!current.lease || current.lease.token !== input.leaseToken) {
      return {
        ok: false,
        reason: 'lease_conflict',
        generation: current.generation,
      }
    }

    const next = cloneSnapshot(input.snapshot)
    next.generation = input.expectedGeneration + 1
    return this.storage.transactionSync(() => {
      const cursor = this.sql.exec(
        `UPDATE m365_sessions
         SET generation = ?, snapshot_json = ?, updated_at = ?
         WHERE session_id = ? AND generation = ? AND lease_token = ?`,
        next.generation,
        encodeSessionSnapshot(next),
        Date.now(),
        next.sessionId,
        input.expectedGeneration,
        input.leaseToken,
      )
      if (cursor.rowsWritten !== 1) {
        const authoritative = this.loadOrCreate(next.sessionId)
        return {
          ok: false,
          reason: authoritative.generation !== input.expectedGeneration
            ? 'generation_conflict' as const
            : 'lease_conflict' as const,
          generation: authoritative.generation,
        }
      }

      if (input.responseId) {
        this.indexPreviousResponse(input.responseId, next.sessionId, next.generation)
      }
      return { ok: true, generation: next.generation }
    })
  }

  acquireLease(input: {
    sessionId: string
    accountId: string
    token: string
    expectedGeneration: number
    now: number
    ttlMs: number
  }): LeaseResult {
    const snapshot = this.loadOrCreate(input.sessionId)
    if (snapshot.generation !== input.expectedGeneration) {
      return {
        ok: false,
        reason: 'generation_conflict',
        generation: snapshot.generation,
      }
    }
    if (snapshot.lease && snapshot.lease.token !== input.token && snapshot.lease.expiresAt > input.now) {
      return {
        ok: false,
        reason: 'lease_conflict',
        expiresAt: snapshot.lease.expiresAt,
      }
    }

    const expiresAt = input.now + input.ttlMs
    const cursor = this.sql.exec(
      `UPDATE m365_sessions
       SET lease_token = ?, lease_account_id = ?, lease_expires_at = ?
       WHERE session_id = ? AND generation = ?`,
      input.token,
      input.accountId,
      expiresAt,
      input.sessionId,
      input.expectedGeneration,
    )
    if (cursor.rowsWritten !== 1) {
      const authoritative = this.loadOrCreate(input.sessionId)
      if (authoritative.generation !== input.expectedGeneration) {
        return {
          ok: false,
          reason: 'generation_conflict',
          generation: authoritative.generation,
        }
      }
      return {
        ok: false,
        reason: 'lease_conflict',
        ...(authoritative.lease ? { expiresAt: authoritative.lease.expiresAt } : {}),
      }
    }
    return { ok: true, expiresAt }
  }

  heartbeatLease(sessionId: string, token: string, now: number, ttlMs: number): LeaseResult {
    const snapshot = this.loadOrCreate(sessionId)
    if (!snapshot.lease || snapshot.lease.token !== token) {
      return { ok: false, reason: 'lease_conflict' }
    }

    const expiresAt = now + ttlMs
    const cursor = this.sql.exec(
      `UPDATE m365_sessions SET lease_expires_at = ?
       WHERE session_id = ? AND lease_token = ?`,
      expiresAt,
      sessionId,
      token,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true, expiresAt }
  }

  migrateLeaseAccount(
    sessionId: string,
    token: string,
    currentAccountId: string,
    nextAccountId: string,
  ): ReleaseResult {
    const cursor = this.sql.exec(
      `UPDATE m365_sessions
       SET lease_account_id = ?
       WHERE session_id = ? AND lease_token = ? AND lease_account_id = ?`,
      nextAccountId,
      sessionId,
      token,
      currentAccountId,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true }
  }

  releaseLease(sessionId: string, token: string): ReleaseResult {
    const snapshot = this.loadOrCreate(sessionId)
    if (!snapshot.lease || snapshot.lease.token !== token) {
      return { ok: false, reason: 'lease_conflict' }
    }

    const cursor = this.sql.exec(
      `UPDATE m365_sessions
       SET lease_token = NULL, lease_account_id = NULL, lease_expires_at = NULL
       WHERE session_id = ? AND lease_token = ?`,
      sessionId,
      token,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true }
  }

  acquireAccountLock(
    accountId: string,
    sessionId: string,
    token: string,
    now: number,
    ttlMs: number,
  ): AccountLockResult {
    const expiresAt = now + ttlMs
    const cursor = this.sql.exec(
      `INSERT INTO m365_account_locks (account_id, session_id, lease_token, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         session_id = excluded.session_id,
         lease_token = excluded.lease_token,
         expires_at = excluded.expires_at
       WHERE m365_account_locks.expires_at <= ?
          OR (m365_account_locks.session_id = ? AND m365_account_locks.lease_token = ?)`,
      accountId,
      sessionId,
      token,
      expiresAt,
      now,
      sessionId,
      token,
    )
    if (cursor.rowsWritten === 1) return { ok: true, expiresAt }

    const rows = this.sql.exec<{ session_id: string; expires_at: number }>(
      `SELECT session_id, expires_at
       FROM m365_account_locks
       WHERE account_id = ?`,
      accountId,
    ).toArray()
    if (rows.length !== 1) throw new Error('M365_ACCOUNT_LOCK_ROW_MISSING_AFTER_CONFLICT')
    return {
      ok: false,
      reason: 'account_locked',
      ownerSessionId: rows[0].session_id,
      expiresAt: rows[0].expires_at,
    }
  }

  heartbeatAccountLock(
    accountId: string,
    sessionId: string,
    token: string,
    now: number,
    ttlMs: number,
  ): LeaseResult {
    const expiresAt = now + ttlMs
    const cursor = this.sql.exec(
      `UPDATE m365_account_locks
       SET expires_at = ?
       WHERE account_id = ? AND session_id = ? AND lease_token = ?`,
      expiresAt,
      accountId,
      sessionId,
      token,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true, expiresAt }
  }

  releaseAccountLock(accountId: string, sessionId: string, token: string): ReleaseResult {
    const cursor = this.sql.exec(
      `DELETE FROM m365_account_locks
       WHERE account_id = ? AND session_id = ? AND lease_token = ?`,
      accountId,
      sessionId,
      token,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true }
  }

  indexPreviousResponse(responseId: string, sessionId: string, generation: number): void {
    this.sql.exec(
      `INSERT INTO m365_response_index (response_id, session_id, generation)
       VALUES (?, ?, ?)
       ON CONFLICT(response_id) DO NOTHING`,
      responseId,
      sessionId,
      generation,
    )
  }

  resolvePreviousResponse(responseId: string): { sessionId: string; generation: number } | null {
    const rows = this.sql.exec<{ session_id: string; generation: number }>(
      `SELECT session_id, generation
       FROM m365_response_index
       WHERE response_id = ?`,
      responseId,
    ).toArray()
    if (rows.length === 0) return null

    return {
      sessionId: rows[0].session_id,
      generation: rows[0].generation,
    }
  }
}
