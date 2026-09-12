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
        lease_renewed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `)
    // 既有 DO 实例（表已存在、无 lease_renewed_at 列）的加法迁移：探测到缺列时补一次 ALTER。
    // 探测能力不可用时静默跳过：新表一定带该列；旧表在补列前 renewedAt 退化为 0，
    // 抢占判定自动回退到"仅按 expiresAt"，不会导致错误抢占。
    try {
      const columns = new Set(
        this.sql.exec(`PRAGMA table_info(m365_sessions)`).toArray().map((r) => String(r['name'])),
      )
      if (!columns.has('lease_renewed_at')) {
        this.sql.exec(`ALTER TABLE m365_sessions ADD COLUMN lease_renewed_at INTEGER NOT NULL DEFAULT 0`)
      }
    } catch { /* 探测不可用：见上 */ }
    // 注意：这里**不应**再创建任何"账号级"独占锁表。
    // 账号级串行由 AccountFlux（M365_FLUX，每 provider 一个共享 DO）统一负责；
    // 本 store 挂在"每个会话各自的 DO"上，其 SQLite 表天然无法跨会话协调，
    // 所以放在这里的账号锁只可能造成"同一会话自锁"的假冲突（log3 的 account_locked）。
    // 会话与账号的绑定关系属于会话租约（m365_sessions.lease_account_id），与此无关，保持独立。
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
    const validSessionId = sessionId && sessionId.trim() !== '' ? sessionId : crypto.randomUUID()
    const emptySnapshot = createEmptySessionSnapshot(validSessionId)
    this.sql.exec(
      `INSERT OR IGNORE INTO m365_sessions
       (session_id, generation, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      validSessionId,
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
      lease_renewed_at: number | null
    }>(
      `SELECT snapshot_json, generation, lease_token, lease_account_id, lease_expires_at, lease_renewed_at
       FROM m365_sessions
       WHERE session_id = ?`,
      validSessionId,
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
          renewedAt: rows[0].lease_renewed_at ?? 0,
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
       SET lease_token = ?, lease_account_id = ?, lease_expires_at = ?, lease_renewed_at = ?
       WHERE session_id = ? AND generation = ?`,
      input.token,
      input.accountId,
      expiresAt,
      input.now,
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
      `UPDATE m365_sessions SET lease_expires_at = ?, lease_renewed_at = ?
       WHERE session_id = ? AND lease_token = ?`,
      expiresAt,
      now,
      sessionId,
      token,
    )
    if (cursor.rowsWritten !== 1) {
      return { ok: false, reason: 'lease_conflict' }
    }
    return { ok: true, expiresAt }
  }

  /**
   * 原子抢占（supersede）一个孤儿/过期租约。
   *
   * 触发条件（保守，必须满足其一）：
   *   1) lease_expires_at <= now —— 租约已自然过期；
   *   2) lease_renewed_at <= now - staleMs —— 心跳已停摆超过 staleMs，持有者实际已死
   *      （进程崩溃 / isolate 回收 / 客户端断连未走 finally），即使 TTL 尚未到点。
   *
   * 抢占以单条条件 UPDATE 完成（WHERE 仍然校验旧 token 与 generation），
   * 因此与持有者的 heartbeatLease / releaseLease 竞争时只有一个赢家：
   * 若持有者其实还活着并刚好续约成功，本次 UPDATE 的 rowsWritten 为 0，抢占自然失败，
   * 不会出现两个请求同时持有同一会话锁的情况。
   *
   * 被抢占时旧租约的 pendingCall/protocolTail 保留在 snapshot 中（不丢检查点），
   * 新持有者继续在同一个会话行上推进，避免整段 TTL 内所有重试都拿到 409。
   */
  supersedeLease(input: {
    sessionId: string
    accountId: string
    token: string
    expectedGeneration: number
    now: number
    ttlMs: number
    staleMs: number
  }): LeaseResult {
    const snapshot = this.loadOrCreate(input.sessionId)
    if (snapshot.generation !== input.expectedGeneration) {
      return { ok: false, reason: 'generation_conflict', generation: snapshot.generation }
    }
    const current = snapshot.lease
    if (!current) {
      // 无租约（已被释放）：按普通获取处理
      return this.acquireLease({
        sessionId: input.sessionId,
        accountId: input.accountId,
        token: input.token,
        expectedGeneration: input.expectedGeneration,
        now: input.now,
        ttlMs: input.ttlMs,
      })
    }
    if (current.token === input.token) {
      return { ok: true, expiresAt: current.expiresAt }
    }
    const renewedAt = current.renewedAt
    const expired = current.expiresAt <= input.now
    const abandoned = renewedAt > 0 && renewedAt <= input.now - input.staleMs
    if (!expired && !abandoned) {
      return { ok: false, reason: 'lease_conflict', expiresAt: current.expiresAt }
    }

    const expiresAt = input.now + input.ttlMs
    const cursor = this.sql.exec(
      `UPDATE m365_sessions
       SET lease_token = ?, lease_account_id = ?, lease_expires_at = ?, lease_renewed_at = ?
       WHERE session_id = ? AND generation = ? AND lease_token = ?`,
      input.token,
      input.accountId,
      expiresAt,
      input.now,
      input.sessionId,
      input.expectedGeneration,
      current.token,
    )
    if (cursor.rowsWritten !== 1) {
      // 持有者在我们判断与写入之间成功续约/释放：让调用方重新评估，不强行夺锁
      const authoritative = this.loadOrCreate(input.sessionId)
      return {
        ok: false,
        reason: 'lease_conflict',
        ...(authoritative.lease ? { expiresAt: authoritative.lease.expiresAt } : {}),
      }
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
       SET lease_token = NULL, lease_account_id = NULL, lease_expires_at = NULL, lease_renewed_at = 0
       WHERE session_id = ? AND lease_token = ?`,
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
