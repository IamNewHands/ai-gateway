import type { TaskAnchor } from './task-anchors'
import {
  DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS,
  DEFAULT_MAX_TOOL_ROUNDS,
  restoreToolLedgerSnapshot,
  snapshotToolLedger,
} from './tool-ledger'
import type { ToolLedger, ToolLedgerSnapshot } from './tool-ledger'

export const SESSION_SNAPSHOT_VERSION = 1

export type M365Protocol = 'chat' | 'responses' | 'anthropic'

export interface PendingCallState {
  callId: string
  name: string
  arguments: string
  fingerprint: string
  repairAttempts: number
}

export interface PortableProtocolTail {
  protocol: M365Protocol
  previousResponseId?: string
  items: unknown[]
}

export interface SessionLeaseState {
  token: string
  generation: number
  accountId: string
  expiresAt: number
}

export interface CompactionCheckpoint {
  reason: string
  continuationToken: string
  createdAt: number
}

export interface SessionSnapshotV1 {
  version: typeof SESSION_SNAPSHOT_VERSION
  sessionId: string
  generation: number
  pendingCall: PendingCallState | null
  protocolTail: PortableProtocolTail
  taskAnchors: TaskAnchor[]
  lease: SessionLeaseState | null
  checkpoint: CompactionCheckpoint | null
  toolLedger: ToolLedgerSnapshot
}

function emptyToolLedger(): ToolLedger {
  return {
    calls: [],
    completed: [],
    pending: [],
    consumedCallIds: [],
    issues: [],
    roundCount: 0,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
    maxConsecutiveFingerprints: DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS,
    blocked: false,
  }
}

export function createEmptySessionSnapshot(sessionId: string): SessionSnapshotV1 {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    generation: 0,
    pendingCall: null,
    protocolTail: { protocol: 'chat', items: [] },
    taskAnchors: [],
    lease: null,
    checkpoint: null,
    toolLedger: snapshotToolLedger(emptyToolLedger()),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizePendingCall(value: unknown): PendingCallState | null {
  const raw = recordValue(value)
  if (!raw.callId && !raw.name && !raw.fingerprint) return null
  const callId = stringValue(raw.callId)
  const name = stringValue(raw.name)
  const fingerprint = stringValue(raw.fingerprint)
  if (!callId || !name || !fingerprint) throw new Error('INVALID_PENDING_CALL_STATE')
  return {
    callId,
    name,
    arguments: stringValue(raw.arguments),
    fingerprint,
    repairAttempts: nonNegativeInteger(raw.repairAttempts),
  }
}

function normalizeProtocolTail(value: unknown): PortableProtocolTail {
  const raw = recordValue(value)
  const protocol = raw.protocol === 'responses' || raw.protocol === 'anthropic' || raw.protocol === 'chat'
    ? raw.protocol
    : 'chat'
  const previousResponseId = stringValue(raw.previousResponseId)
  return {
    protocol,
    ...(previousResponseId ? { previousResponseId } : {}),
    items: Array.isArray(raw.items) ? raw.items : [],
  }
}

function normalizeTaskAnchors(value: unknown): TaskAnchor[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(['windows_path', 'unc_path', 'unix_path', 'url', 'server'])
  return value.flatMap((item): TaskAnchor[] => {
    const raw = recordValue(item)
    return allowed.has(String(raw.kind)) && typeof raw.value === 'string'
      ? [{ kind: raw.kind as TaskAnchor['kind'], value: raw.value }]
      : []
  })
}

function normalizeLease(value: unknown): SessionLeaseState | null {
  const raw = recordValue(value)
  if (!raw.token && !raw.accountId) return null
  const token = stringValue(raw.token)
  const accountId = stringValue(raw.accountId)
  if (!token || !accountId) throw new Error('INVALID_SESSION_LEASE_STATE')
  return {
    token,
    generation: nonNegativeInteger(raw.generation),
    accountId,
    expiresAt: finiteNumber(raw.expiresAt),
  }
}

function normalizeCheckpoint(value: unknown): CompactionCheckpoint | null {
  const raw = recordValue(value)
  if (!raw.reason && !raw.continuationToken) return null
  const reason = stringValue(raw.reason)
  const continuationToken = stringValue(raw.continuationToken)
  if (!reason || !continuationToken) throw new Error('INVALID_COMPACTION_CHECKPOINT')
  return {
    reason,
    continuationToken,
    createdAt: finiteNumber(raw.createdAt),
  }
}

function normalizeToolLedger(value: unknown): ToolLedgerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return snapshotToolLedger(emptyToolLedger())
  }
  return snapshotToolLedger(restoreToolLedgerSnapshot(value as ToolLedgerSnapshot))
}

export function normalizeSessionSnapshot(value: unknown): SessionSnapshotV1 {
  const raw = recordValue(value)
  const version = raw.version === undefined ? SESSION_SNAPSHOT_VERSION : raw.version
  if (version !== SESSION_SNAPSHOT_VERSION) {
    throw new Error(`UNSUPPORTED_SESSION_SNAPSHOT_VERSION: ${String(version)}`)
  }

  return {
    version: SESSION_SNAPSHOT_VERSION,
    sessionId: stringValue(raw.sessionId),
    generation: nonNegativeInteger(raw.generation),
    pendingCall: normalizePendingCall(raw.pendingCall),
    protocolTail: normalizeProtocolTail(raw.protocolTail),
    taskAnchors: normalizeTaskAnchors(raw.taskAnchors),
    lease: normalizeLease(raw.lease),
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    toolLedger: normalizeToolLedger(raw.toolLedger),
  }
}

export function encodeSessionSnapshot(snapshot: SessionSnapshotV1): string {
  return JSON.stringify(normalizeSessionSnapshot(snapshot))
}

export function decodeSessionSnapshot(encoded: string | null | undefined): SessionSnapshotV1 {
  if (!encoded) throw new Error('MISSING_SESSION_SNAPSHOT')
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new Error('INVALID_SESSION_SNAPSHOT_JSON')
  }
  return normalizeSessionSnapshot(parsed)
}

/**
 * 使用 AES-GCM 加密编码会话快照（便携压缩胶囊）
 */
export async function encodeEncryptedSessionSnapshot(snapshot: SessionSnapshotV1, key: string): Promise<string> {
  const { encryptCompactionCapsule } = await import('./crypto')
  return encryptCompactionCapsule(normalizeSessionSnapshot(snapshot), key)
}

/**
 * 使用 AES-GCM 多 Key 容错解密会话快照
 */
export async function decodeEncryptedSessionSnapshot(
  payload: string,
  keys: string | readonly string[],
): Promise<SessionSnapshotV1> {
  const { decryptCompactionCapsule } = await import('./crypto')
  const decrypted = await decryptCompactionCapsule<unknown>(payload, keys)
  return normalizeSessionSnapshot(decrypted)
}

