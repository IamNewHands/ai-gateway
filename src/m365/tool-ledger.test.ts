import { describe, it, expect } from 'vitest'
import {
  buildToolLedger,
  guardToolLedger,
  toolCallFingerprint,
  resultFailed,
  ToolLedger,
} from './tool-ledger'
import type { OaiMsgLite } from './tools'

describe('toolCallFingerprint', () => {
  it('相同 name+args 生成相同指纹', () => {
    const f1 = toolCallFingerprint('sh', { cmd: 'ls' })
    const f2 = toolCallFingerprint('sh', { cmd: 'ls' })
    expect(f1).toBe(f2)
  })

  it('不同 args 生成不同指纹', () => {
    const f1 = toolCallFingerprint('sh', { cmd: 'ls' })
    const f2 = toolCallFingerprint('sh', { cmd: 'pwd' })
    expect(f1).not.toBe(f2)
  })

  it('不同键顺序生成相同指纹（规范化）', () => {
    const f1 = toolCallFingerprint('sh', { a: 1, b: 2 })
    const f2 = toolCallFingerprint('sh', { b: 2, a: 1 })
    expect(f1).toBe(f2)
  })

  it('数字 1 和 1.0 生成相同指纹（规范化）', () => {
    const f1 = toolCallFingerprint('sh', { n: 1 })
    const f2 = toolCallFingerprint('sh', { n: 1.0 })
    expect(f1).toBe(f2)
  })

  it('不同 name 生成不同指纹', () => {
    const f1 = toolCallFingerprint('sh', { cmd: 'ls' })
    const f2 = toolCallFingerprint('bash', { cmd: 'ls' })
    expect(f1).not.toBe(f2)
  })
})

describe('resultFailed', () => {
  it('exit code 1 检测为失败', () => {
    expect(resultFailed('exit code: 1, error occurred')).toBe(true)
  })

  it('exit status 1 检测为失败', () => {
    expect(resultFailed('exit status 1')).toBe(true)
  })

  it('普通输出不检测为失败', () => {
    expect(resultFailed('ok')).toBe(false)
  })

  it('空字符串不检测为失败', () => {
    expect(resultFailed('')).toBe(false)
  })

  it('error 关键词检测为失败', () => {
    expect(resultFailed('error: something went wrong')).toBe(true)
  })

  it('Process exited 检测为失败', () => {
    expect(resultFailed('Process exited with code 1')).toBe(true)
  })
})

describe('buildToolLedger', () => {
  it('空消息列表产生空 ledger', async () => {
    const ledger = await buildToolLedger([])
    expect(ledger.calls).toHaveLength(0)
    expect(ledger.completed).toHaveLength(0)
    expect(ledger.pending).toHaveLength(0)
    expect(ledger.issues).toHaveLength(0)
    expect(ledger.roundCount).toBe(0)
    expect(ledger.blocked).toBe(false)
  })

  it('单次成功调用', async () => {
    const msgs: OaiMsgLite[] = [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'sh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]
    const ledger = await buildToolLedger(msgs)
    expect(ledger.calls).toHaveLength(1)
    expect(ledger.completed).toHaveLength(1)
    expect(ledger.completed[0].failed).toBe(false)
    expect(ledger.roundCount).toBe(1)
    expect(ledger.blocked).toBe(false)
  })

  it('同一 callId 重复声明触发 duplicate_call_id', async () => {
    const msgs: OaiMsgLite[] = [
      { role: 'assistant', tool_calls: [
        { id: 'c1', function: { name: 'sh', arguments: '{}' } },
        { id: 'c1', function: { name: 'bash', arguments: '{}' } },
      ]},
    ]
    const ledger = await buildToolLedger(msgs)
    const hasDuplicate = ledger.issues.some((i) => i.code === 'duplicate_call_id')
    expect(hasDuplicate).toBe(true)
    expect(ledger.blocked).toBe(true)
  })

  it('结果消费后再次消费触发 call_id_already_consumed', async () => {
    const msgs: OaiMsgLite[] = [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'sh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c1', content: 'again' },
    ]
    const ledger = await buildToolLedger(msgs)
    const hasConsumed = ledger.issues.some((i) => i.code === 'call_id_already_consumed')
    expect(hasConsumed).toBe(true)
    expect(ledger.blocked).toBe(true)
  })

  it('未知 callId 的 result 触发 unknown_call_id', async () => {
    const msgs: OaiMsgLite[] = [
      { role: 'tool', tool_call_id: 'unknown', content: 'result' },
    ]
    const ledger = await buildToolLedger(msgs)
    const hasUnknown = ledger.issues.some((i) => i.code === 'unknown_call_id')
    expect(hasUnknown).toBe(true)
    expect(ledger.blocked).toBe(true)
  })

  it('相同失败重复触发 repeated_failure', async () => {
    const msgs: OaiMsgLite[] = [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'sh', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'exit code: 1, error' },
      { role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'sh', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'exit code: 1, error' },
    ]
    const ledger = await buildToolLedger(msgs)
    const hasRepeatedFailure = ledger.issues.some((i) => i.code === 'repeated_failure')
    expect(hasRepeatedFailure).toBe(true)
    expect(ledger.blocked).toBe(true)
  })

  it('连续相同指纹触发 consecutive_fingerprint_limit', async () => {
    const msgs: OaiMsgLite[] = []
    for (let i = 0; i < 3; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'sh', arguments: '{"cmd":"ls"}' } }] })
    }
    const ledger = await buildToolLedger(msgs)
    const hasConsecutive = ledger.issues.some((i) => i.code === 'consecutive_fingerprint_limit')
    expect(hasConsecutive).toBe(true)
    expect(ledger.blocked).toBe(true)
  })
})

describe('guardToolLedger', () => {
  it('空 ledger 允许通过', () => {
    const ledger: ToolLedger = {
      calls: [], completed: [], pending: [], consumedCallIds: [],
      issues: [], roundCount: 0, maxToolRounds: 128, maxConsecutiveFingerprints: 2, blocked: false,
    }
    const result = guardToolLedger(ledger)
    expect(result.allowed).toBe(true)
  })

  it('repeated_failure 阻止', () => {
    const ledger: ToolLedger = {
      calls: [], completed: [], pending: [], consumedCallIds: [],
      issues: [{ code: 'repeated_failure', message: 'test', callId: 'c1', fingerprint: 'f1' }],
      roundCount: 2, maxToolRounds: 128, maxConsecutiveFingerprints: 2, blocked: true,
    }
    const result = guardToolLedger(ledger)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe('repeated_tool_failure')
  })

  it('tool_round_limit 阻止', () => {
    const ledger: ToolLedger = {
      calls: [], completed: [], pending: [], consumedCallIds: [],
      issues: [{ code: 'tool_round_limit', message: 'test', fingerprint: 'f1' }],
      roundCount: 128, maxToolRounds: 128, maxConsecutiveFingerprints: 2, blocked: true,
    }
    const result = guardToolLedger(ledger)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe('tool_round_limit')
  })

  it('consecutive_fingerprint_limit 阻止', () => {
    const ledger: ToolLedger = {
      calls: [], completed: [], pending: [], consumedCallIds: [],
      issues: [{ code: 'consecutive_fingerprint_limit', message: 'test', fingerprint: 'f1' }],
      roundCount: 3, maxToolRounds: 128, maxConsecutiveFingerprints: 2, blocked: true,
    }
    const result = guardToolLedger(ledger)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe('repeated_tool_call')
  })
})