import { describe, it, expect } from 'vitest'
import { buildAgentLedger, canContinue, MAX_TOOL_ROUNDS_DEFAULT } from './tools'
import type { OaiMsgLite } from './tools'

describe('buildAgentLedger + canContinue 熔断门禁', () => {
  it('无工具证据时允许继续', async () => {
    const l = await buildAgentLedger([])
    expect(canContinue(l)).toBe(true)
  })

  it('同一成功调用重复 3 次（连续指纹超限）时阻断（新版：连续 3 次相同指纹即阻断）', async () => {
    const msgs = repeatedCalls(3)
    const l = await buildAgentLedger(msgs)
    expect(l.repeatedCall).toBe(true)
    expect(canContinue(l)).toBe(false)
  })

  it('同一成功调用重复 5 次（连续指纹超限）时阻断', async () => {
    const msgs = repeatedCalls(5)
    const l = await buildAgentLedger(msgs)
    // 新版：连续 3 次相同指纹即触发 consecutive_fingerprint_limit（默认 maxConsecutiveFingerprints=2，第 3 次阻断）
    expect(l.repeatedCall).toBe(true)
    expect(canContinue(l)).toBe(false)
  })

  it('同一失败调用重复 2 次（RepeatedFailure）时熔断', async () => {
    const msgs: OaiMsgLite[] = []
    for (let i = 0; i < 2; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'sh', arguments: '{}' } }] })
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'exit code: 1, error occurred' })
    }
    const l = await buildAgentLedger(msgs)
    expect(l.repeatedFailure).toBe(true)
    expect(canContinue(l)).toBe(false)
  })

  it('轮数达到上限时熔断', async () => {
    const msgs = repeatedCalls(MAX_TOOL_ROUNDS_DEFAULT)
    const l = await buildAgentLedger(msgs)
    expect(l.toolRounds).toBe(MAX_TOOL_ROUNDS_DEFAULT)
    expect(canContinue(l, MAX_TOOL_ROUNDS_DEFAULT)).toBe(false)
  })

  it('轮数未达上限且无死循环/重复失败时允许继续', async () => {
    const msgs = repeatedCalls(2)
    const l = await buildAgentLedger(msgs)
    expect(l.stuckLoop).toBeFalsy()
    expect(canContinue(l)).toBe(true)
  })
})

function repeatedCalls(n: number): OaiMsgLite[] {
  const msgs: OaiMsgLite[] = []
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'sh', arguments: '{"cmd":"ls"}' } }] })
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'ok' })
  }
  return msgs
}