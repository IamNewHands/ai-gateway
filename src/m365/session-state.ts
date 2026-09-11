import type { TaskAnchor } from './task-anchors'
import {
  DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS,
  DEFAULT_MAX_TOOL_ROUNDS,
  restoreToolLedgerSnapshot,
  snapshotToolLedger,
} from './tool-ledger'
import type { ToolLedger, ToolLedgerSnapshot } from './tool-ledger'
import { MAX_PORTABLE_SESSION_BYTES, MAX_TOOL_LEDGER_SNAPSHOT_BYTES, utf8Bytes } from './portable-session'

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
    items: boundProtocolTailItems(Array.isArray(raw.items) ? raw.items : []),
  }
}

/**
 * 协议尾部按字节预算保留最新的完整条目（移植自 M365-Gateway chat-session.ts
 * 的 boundedPortableProtocolSuffix 语义）。原始字节后缀可能在某个条目中间
 * 开始，恢复时会丢弃最新任务；此处按"条目"为最小单位从尾部保留，绝不切断
 * 单条结构，防止 DO 持久化快照无界增长（isolate 128 MiB 上限）。
 */
function boundProtocolTailItems(items: unknown[]): unknown[] {
  if (items.length === 0) return items
  if (utf8Bytes(JSON.stringify(items)) <= MAX_PORTABLE_SESSION_BYTES) return items
  let start = items.length
  let bytes = 2
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const itemBytes = utf8Bytes(JSON.stringify(items[i] ?? null)) + 1
    if (bytes + itemBytes > MAX_PORTABLE_SESSION_BYTES) break
    bytes += itemBytes
    start = i
  }
  return items.slice(start)
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
  const snapshot = snapshotToolLedger(restoreToolLedgerSnapshot(value as ToolLedgerSnapshot))
  // 账本快照有独立字节上界（同源 validateToolLedgerSnapshot）：
  // 防止异常的巨型账本把 DO 持久化快照撑爆 isolate 内存上限。
  if (utf8Bytes(JSON.stringify(snapshot)) > MAX_TOOL_LEDGER_SNAPSHOT_BYTES) {
    throw new Error('TOOL_LEDGER_SNAPSHOT_TOO_LARGE')
  }
  return snapshot
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

/**
 * 判断一个已持久化的会话是否应从"压缩胶囊检查点"恢复（移植自
 * M365-Gateway openai.ts shouldRestoreChatPortableCheckpoint 的语义，
 * 适配目标：started/accountLocked 对应未开始的空租约，protocolTail 对应
 * 目标的结构化协议尾部，completedToolResults 对应账本已完成证据数）。
 *
 * 仅当：会话尚未开始、账号已锁定、协议尾部/检查点存在、且已有至少一个
 * 完成的工具证据、并且当前请求没有携带任何 user 消息时，才允许恢复。
 * 否则一律以现有持久化状态为准，绝不能被更旧的胶囊回滚。
 */
export function shouldRestoreChatPortableCheckpoint(
  started: boolean,
  accountLocked: boolean,
  protocolTailPresent: boolean,
  messages: ReadonlyArray<Record<string, unknown>>,
  completedToolResults: number,
): boolean {
  if (started || !accountLocked || !protocolTailPresent || completedToolResults < 1) return false
  return !messages.some((message) => String(message.role ?? '').toLowerCase() === 'user')
}

/**
 * 从检查点恢复会话快照（移植自 M365-Gateway openai.ts
 * hydrateLeaseFromCompaction 的"合并不回滚"原则，适配目标 SessionSnapshotV1）。
 *
 * 一个部分存活的 DO 绝不能被更旧的胶囊回滚：若已有任何持久化状态，
 * 只合并缺失的加性字段（任务锚点/账本/待调用），保留更权威的现有状态。
 * 只有当会话确实为空/全新时，才用检查点完整填充。
 */
export function hydrateSessionSnapshotFromCheckpoint(
  snapshot: SessionSnapshotV1,
  checkpoint: CompactionCheckpoint | null | undefined,
): SessionSnapshotV1 {
  if (!checkpoint) return snapshot
  const hasDurableState = snapshot.generation > 0
    || snapshot.pendingCall !== null
    || snapshot.toolLedger.calls.length > 0
    || snapshot.taskAnchors.length > 0
    || snapshot.protocolTail.items.length > 0
    || Boolean(snapshot.lease)
  if (hasDurableState) return snapshot
  return {
    ...snapshot,
    checkpoint,
  }
}

