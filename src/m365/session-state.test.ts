import { describe, expect, it } from 'vitest'
import {
  SESSION_SNAPSHOT_VERSION,
  createEmptySessionSnapshot,
  decodeSessionSnapshot,
  encodeSessionSnapshot,
  normalizeSessionSnapshot,
  encodeEncryptedSessionSnapshot,
  decodeEncryptedSessionSnapshot,
  shouldRestoreChatPortableCheckpoint,
  hydrateSessionSnapshotFromCheckpoint,
} from './session-state'
import { randomToken } from './crypto'
import {
  buildToolLedger,
  restoreToolLedgerSnapshot,
  snapshotToolLedger,
} from './tool-ledger'
import type { OaiMsgLite } from './tools'

describe('M365 persisted session state contract', () => {
  it('creates a safe empty versioned snapshot', () => {
    const snapshot = createEmptySessionSnapshot('session-1')

    expect(snapshot.version).toBe(SESSION_SNAPSHOT_VERSION)
    expect(snapshot.sessionId).toBe('session-1')
    expect(snapshot.generation).toBe(0)
    expect(snapshot.pendingCall).toBeNull()
    expect(snapshot.protocolTail).toEqual({ protocol: 'chat', items: [] })
    expect(snapshot.taskAnchors).toEqual([])
    expect(snapshot.lease).toBeNull()
    expect(snapshot.checkpoint).toBeNull()
    expect(snapshot.toolLedger.pending).toEqual([])
    expect(snapshot.toolLedger.completed).toEqual([])
  })

  it('normalizes a legacy partial snapshot with safe defaults', () => {
    const snapshot = normalizeSessionSnapshot({
      sessionId: 'legacy-session',
      generation: 3,
      taskAnchors: [{ kind: 'windows_path', value: 'D:\\repo' }],
    })

    expect(snapshot.version).toBe(SESSION_SNAPSHOT_VERSION)
    expect(snapshot.sessionId).toBe('legacy-session')
    expect(snapshot.generation).toBe(3)
    expect(snapshot.taskAnchors).toEqual([{ kind: 'windows_path', value: 'D:\\repo' }])
    expect(snapshot.pendingCall).toBeNull()
    expect(snapshot.lease).toBeNull()
    expect(snapshot.checkpoint).toBeNull()
    expect(snapshot.toolLedger.calls).toEqual([])
  })

  it('rejects unknown future snapshot versions', () => {
    expect(() => normalizeSessionSnapshot({
      version: SESSION_SNAPSHOT_VERSION + 1,
      sessionId: 'future-session',
    })).toThrow(/unsupported.*version/i)
  })

  it('round-trips the persisted snapshot without losing continuation state', () => {
    const snapshot = createEmptySessionSnapshot('session-2')
    snapshot.generation = 7
    snapshot.pendingCall = {
      callId: 'call-1',
      name: 'read',
      arguments: '{"file_path":"D:\\\\repo\\\\a.ts"}',
      fingerprint: 'fp-1',
      repairAttempts: 1,
    }
    snapshot.protocolTail = {
      protocol: 'responses',
      previousResponseId: 'resp-1',
      items: [{ type: 'function_call', call_id: 'call-1' }],
    }
    snapshot.lease = {
      token: 'lease-1',
      generation: 7,
      accountId: 'account-1',
      expiresAt: 123456,
      renewedAt: 123000,
    }
    snapshot.checkpoint = {
      reason: 'tool_round_limit',
      continuationToken: 'continue-1',
      createdAt: 123000,
    }

    expect(decodeSessionSnapshot(encodeSessionSnapshot(snapshot))).toEqual(snapshot)
  })
})

describe('ToolLedger persisted snapshot', () => {
  it('restores completed and pending calls without overlap', async () => {
    const messages: OaiMsgLite[] = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'done-1', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
          { id: 'pending-1', function: { name: 'read', arguments: '{"file_path":"b.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'done-1', content: 'file contents' },
    ]
    const ledger = await buildToolLedger(messages)
    const restored = restoreToolLedgerSnapshot(snapshotToolLedger(ledger))

    expect(restored.completed.map((item) => item.callId)).toEqual(['done-1'])
    expect(restored.pending.map((item) => item.callId)).toEqual(['pending-1'])
    expect(new Set(restored.completed.map((item) => item.callId)).has('pending-1')).toBe(false)
    expect(restored.roundCount).toBe(2)
  })

  it('preserves stable fingerprints across snapshot restore', async () => {
    const ledger = await buildToolLedger([
      {
        role: 'assistant',
        tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"b":2,"a":1}' } }],
      },
    ])
    const restored = restoreToolLedgerSnapshot(snapshotToolLedger(ledger))

    expect(restored.calls[0].fingerprint).toBe(ledger.calls[0].fingerprint)
    expect(restored.calls[0].normalizedArguments).toBe('{"a":1,"b":2}')
  })

  it('rejects a corrupted snapshot where one call is both completed and pending', async () => {
    const ledger = await buildToolLedger([
      {
        role: 'assistant',
        tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }],
      },
    ])
    const snapshot = snapshotToolLedger(ledger)
    snapshot.completed = [{
      ...snapshot.pending[0],
      result: 'ok',
      normalizedResult: '"ok"',
      resultFingerprint: 'result-fp',
      failed: false,
    }]

    expect(() => restoreToolLedgerSnapshot(snapshot)).toThrow(/completed.*pending|pending.*completed/i)
  })

  it('加密编码与解密会话快照完整恢复', async () => {
    const key1 = randomToken(32)
    const key2 = randomToken(32)
    const snapshot = createEmptySessionSnapshot('session-enc-1')
    snapshot.generation = 3
    snapshot.taskAnchors = [{ kind: 'windows_path', value: 'C:\\test\\file.txt' }]

    const encrypted = await encodeEncryptedSessionSnapshot(snapshot, key2)
    expect(typeof encrypted).toBe('string')
    expect(encrypted).not.toContain('session-enc-1')

    const decrypted = await decodeEncryptedSessionSnapshot(encrypted, [key1, key2])
    expect(decrypted).toEqual(snapshot)
  })
})

describe('M365 会话检查点恢复（移植自 M365-Gateway shouldRestoreChatPortableCheckpoint/hydrateLeaseFromCompaction）', () => {
  it('满足全部条件时才允许从可移植检查点恢复', () => {
    expect(shouldRestoreChatPortableCheckpoint(false, true, true, [], 1)).toBe(true)
  })

  it('会话已开始/账号未锁定/无尾部/无完成证据时不恢复', () => {
    expect(shouldRestoreChatPortableCheckpoint(true, true, true, [], 1)).toBe(false)
    expect(shouldRestoreChatPortableCheckpoint(false, false, true, [], 1)).toBe(false)
    expect(shouldRestoreChatPortableCheckpoint(false, true, false, [], 1)).toBe(false)
    expect(shouldRestoreChatPortableCheckpoint(false, true, true, [], 0)).toBe(false)
  })

  it('当前请求携带 user 消息时不恢复（避免覆盖新指令）', () => {
    expect(shouldRestoreChatPortableCheckpoint(false, true, true, [{ role: 'user' }], 1)).toBe(false)
    expect(shouldRestoreChatPortableCheckpoint(false, true, true, [{ role: 'assistant' }], 1)).toBe(true)
  })

  it('空/全新快照被检查点完整填充', () => {
    const checkpoint = { reason: 'compaction', continuationToken: 'tok', createdAt: 1 }
    const empty = createEmptySessionSnapshot('s-new')
    const result = hydrateSessionSnapshotFromCheckpoint(empty, checkpoint)
    expect(result.checkpoint).toEqual(checkpoint)
  })

  it('已有持久化状态时绝不被更旧胶囊回滚', () => {
    const checkpoint = { reason: 'old', continuationToken: 'old', createdAt: 1 }
    const snapshot = createEmptySessionSnapshot('s-live')
    snapshot.generation = 5
    snapshot.taskAnchors = [{ kind: 'unix_path', value: '/work' }]
    const result = hydrateSessionSnapshotFromCheckpoint(snapshot, checkpoint)
    expect(result.checkpoint).toBeNull()
    expect(result.taskAnchors).toEqual([{ kind: 'unix_path', value: '/work' }])
  })

  it('checkpoint 为 null 时原样返回', () => {
    const snapshot = createEmptySessionSnapshot('s-null')
    expect(hydrateSessionSnapshotFromCheckpoint(snapshot, null)).toBe(snapshot)
  })
})

