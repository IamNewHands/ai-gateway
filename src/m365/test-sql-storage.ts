type SqlValue = ArrayBuffer | string | number | null
export type SqlRow = Record<string, SqlValue>

interface SessionRow {
  session_id: string
  generation: number
  snapshot_json: string
  lease_token: string | null
  lease_account_id: string | null
  lease_expires_at: number | null
  updated_at: number
}

interface AccountLockRow {
  account_id: string
  session_id: string
  lease_token: string
  expires_at: number
}

interface ResponseIndexRow {
  response_id: string
  session_id: string
  generation: number
}

export interface FaithfulSqlState {
  sessions: Map<string, SessionRow>
  accountLocks: Map<string, AccountLockRow>
  responseIndex: Map<string, ResponseIndexRow>
}

export function createFaithfulSqlState(): FaithfulSqlState {
  return {
    sessions: new Map(),
    accountLocks: new Map(),
    responseIndex: new Map(),
  }
}

function normalized(query: string): string {
  return query.replace(/\s+/g, ' ').trim()
}

function cursor<T extends SqlRow>(rows: T[], rowsWritten = 0) {
  return {
    toArray: () => rows.map((row) => ({ ...row })),
    one: () => {
      if (rows.length !== 1) throw new Error(rows.length === 0 ? 'NO_ROWS' : 'TOO_MANY_ROWS')
      return { ...rows[0] }
    },
    next: () => rows.length > 0
      ? { done: false as const, value: { ...rows[0] } }
      : { done: true as const, value: undefined },
    raw: function* () {
      for (const row of rows) yield Object.values(row)
    },
    columnNames: rows.length > 0 ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten,
    [Symbol.iterator]: function* () {
      for (const row of rows) yield { ...row }
    },
  }
}

/**
 * Stateful SQL test double for the exact Durable Object SQL used by
 * M365SessionStore. Multiple instances may share one FaithfulSqlState to model
 * JavaScript object restarts while preserving the underlying database.
 */
export class FaithfulSqlStorage {
  readonly statements: Array<{ query: string; bindings: unknown[] }> = []

  constructor(readonly state: FaithfulSqlState = createFaithfulSqlState()) {}

  transactionSync<T>(closure: () => T): T {
    const sessions = new Map(
      [...this.state.sessions].map(([key, value]) => [key, { ...value }]),
    )
    const accountLocks = new Map(
      [...this.state.accountLocks].map(([key, value]) => [key, { ...value }]),
    )
    const responseIndex = new Map(
      [...this.state.responseIndex].map(([key, value]) => [key, { ...value }]),
    )

    try {
      return closure()
    } catch (error) {
      this.state.sessions.clear()
      for (const [key, value] of sessions) this.state.sessions.set(key, value)
      this.state.accountLocks.clear()
      for (const [key, value] of accountLocks) this.state.accountLocks.set(key, value)
      this.state.responseIndex.clear()
      for (const [key, value] of responseIndex) this.state.responseIndex.set(key, value)
      throw error
    }
  }

  exec<T extends SqlRow>(query: string, ...bindings: unknown[]) {
    this.statements.push({ query, bindings })
    const sql = normalized(query)

    if (/^CREATE (?:TABLE|INDEX) IF NOT EXISTS /i.test(sql)) {
      return cursor<T>([])
    }

    if (/^SELECT snapshot_json, generation, lease_token, lease_account_id, lease_expires_at FROM m365_sessions WHERE session_id = \?$/i.test(sql)) {
      const row = this.state.sessions.get(String(bindings[0]))
      return cursor<T>(row ? [{
        snapshot_json: row.snapshot_json,
        generation: row.generation,
        lease_token: row.lease_token,
        lease_account_id: row.lease_account_id,
        lease_expires_at: row.lease_expires_at,
      } as unknown as T] : [])
    }

    if (/^SELECT generation FROM m365_sessions WHERE session_id = \?$/i.test(sql)) {
      const row = this.state.sessions.get(String(bindings[0]))
      return cursor<T>(row ? [{ generation: row.generation } as unknown as T] : [])
    }

    if (/^INSERT OR IGNORE INTO m365_sessions /i.test(sql)) {
      const sessionId = String(bindings[0])
      if (this.state.sessions.has(sessionId)) return cursor<T>([], 0)
      this.state.sessions.set(sessionId, {
        session_id: sessionId,
        generation: Number(bindings[1]),
        snapshot_json: String(bindings[2]),
        lease_token: null,
        lease_account_id: null,
        lease_expires_at: null,
        updated_at: Number(bindings[3]),
      })
      return cursor<T>([], 1)
    }

    if (/^UPDATE m365_sessions SET generation = \?, snapshot_json = \?, updated_at = \? WHERE session_id = \? AND generation = \? AND lease_token = \?$/i.test(sql)) {
      const sessionId = String(bindings[3])
      const expectedGeneration = Number(bindings[4])
      const leaseToken = String(bindings[5])
      const row = this.state.sessions.get(sessionId)
      if (!row || row.generation !== expectedGeneration || row.lease_token !== leaseToken) return cursor<T>([], 0)
      row.generation = Number(bindings[0])
      row.snapshot_json = String(bindings[1])
      row.updated_at = Number(bindings[2])
      return cursor<T>([], 1)
    }

    if (/^UPDATE m365_sessions SET generation = \?, snapshot_json = \?, updated_at = \? WHERE session_id = \? AND generation = \?$/i.test(sql)) {
      const sessionId = String(bindings[3])
      const expectedGeneration = Number(bindings[4])
      const row = this.state.sessions.get(sessionId)
      if (!row || row.generation !== expectedGeneration) return cursor<T>([], 0)
      row.generation = Number(bindings[0])
      row.snapshot_json = String(bindings[1])
      row.updated_at = Number(bindings[2])
      return cursor<T>([], 1)
    }

    if (/^UPDATE m365_sessions SET lease_token = \?, lease_account_id = \?, lease_expires_at = \? WHERE session_id = \? AND generation = \?$/i.test(sql)) {
      const sessionId = String(bindings[3])
      const row = this.state.sessions.get(sessionId)
      if (!row || row.generation !== Number(bindings[4])) return cursor<T>([], 0)
      row.lease_token = String(bindings[0])
      row.lease_account_id = String(bindings[1])
      row.lease_expires_at = Number(bindings[2])
      return cursor<T>([], 1)
    }

    if (/^UPDATE m365_sessions SET lease_expires_at = \? WHERE session_id = \? AND lease_token = \?$/i.test(sql)) {
      const row = this.state.sessions.get(String(bindings[1]))
      if (!row || row.lease_token !== String(bindings[2])) return cursor<T>([], 0)
      row.lease_expires_at = Number(bindings[0])
      return cursor<T>([], 1)
    }

    if (/^UPDATE m365_sessions SET lease_token = NULL, lease_account_id = NULL, lease_expires_at = NULL WHERE session_id = \? AND lease_token = \?$/i.test(sql)) {
      const row = this.state.sessions.get(String(bindings[0]))
      if (!row || row.lease_token !== String(bindings[1])) return cursor<T>([], 0)
      row.lease_token = null
      row.lease_account_id = null
      row.lease_expires_at = null
      return cursor<T>([], 1)
    }

    if (/^INSERT INTO m365_account_locks /i.test(sql)) {
      const accountId = String(bindings[0])
      const existing = this.state.accountLocks.get(accountId)
      const mayWrite = !existing
        || existing.expires_at <= Number(bindings[4])
        || (existing.session_id === String(bindings[5]) && existing.lease_token === String(bindings[6]))
      if (!mayWrite) return cursor<T>([], 0)
      this.state.accountLocks.set(accountId, {
        account_id: accountId,
        session_id: String(bindings[1]),
        lease_token: String(bindings[2]),
        expires_at: Number(bindings[3]),
      })
      return cursor<T>([], 1)
    }

    if (/^SELECT session_id, expires_at FROM m365_account_locks WHERE account_id = \?$/i.test(sql)) {
      const row = this.state.accountLocks.get(String(bindings[0]))
      return cursor<T>(row ? [{ session_id: row.session_id, expires_at: row.expires_at } as unknown as T] : [])
    }

    if (/^DELETE FROM m365_account_locks WHERE account_id = \? AND session_id = \? AND lease_token = \?$/i.test(sql)) {
      const accountId = String(bindings[0])
      const row = this.state.accountLocks.get(accountId)
      if (!row || row.session_id !== String(bindings[1]) || row.lease_token !== String(bindings[2])) {
        return cursor<T>([], 0)
      }
      this.state.accountLocks.delete(accountId)
      return cursor<T>([], 1)
    }

    if (/^INSERT INTO m365_response_index /i.test(sql)) {
      const responseId = String(bindings[0])
      if (this.state.responseIndex.has(responseId)) return cursor<T>([], 0)
      this.state.responseIndex.set(responseId, {
        response_id: responseId,
        session_id: String(bindings[1]),
        generation: Number(bindings[2]),
      })
      return cursor<T>([], 1)
    }

    if (/^SELECT session_id, generation FROM m365_response_index WHERE response_id = \?$/i.test(sql)) {
      const row = this.state.responseIndex.get(String(bindings[0]))
      return cursor<T>(row ? [{ session_id: row.session_id, generation: row.generation } as unknown as T] : [])
    }

    throw new Error(`UNSUPPORTED_TEST_SQL: ${sql}`)
  }
}
