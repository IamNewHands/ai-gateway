import { describe, it, expect } from 'vitest'
import { buildAgentLedger, canContinue, MAX_TOOL_ROUNDS_DEFAULT } from './tools'
import type { OaiMsgLite } from './tools'

describe('buildAgentLedger + canContinue 熔断门禁', () => {
  it('无工具证据时允许继续', () => {
    const l = buildAgentLedger([])
    expect(canContinue(l)).toBe(true)
  })

  it('同一成功调用重复 3 次（合法轮询）不熔断', () => {
    const msgs = repeatedCalls(3)
    const l = buildAgentLedger(msgs)
    expect(l.stuckLoop).toBeFalsy()
    expect(canContinue(l)).toBe(true)
  })

  it('同一成功调用重复 5 次（StuckLoop）时熔断', () => {
    const msgs = repeatedCalls(5)
    const l = buildAgentLedger(msgs)
    expect(l.stuckLoop).toBe(true)
    expect(canContinue(l)).toBe(false)
  })

  it('同一失败调用重复 2 次（RepeatedFailure）时熔断', () => {
    const msgs: OaiMsgLite[] = []
    for (let i = 0; i < 2; i++) {
      msgs.push({ role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'sh', arguments: '{}' } }] })
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'exit code: 1, error occurred' })
    }
    const l = buildAgentLedger(msgs)
    expect(l.repeatedFailure).toBe(true)
    expect(canContinue(l)).toBe(false)
  })

  it('轮数达到上限时熔断', () => {
    const msgs = repeatedCalls(MAX_TOOL_ROUNDS_DEFAULT)
    const l = buildAgentLedger(msgs)
    expect(l.toolRounds).toBe(MAX_TOOL_ROUNDS_DEFAULT)
    expect(canContinue(l, MAX_TOOL_ROUNDS_DEFAULT)).toBe(false)
  })

  it('轮数未达上限且无死循环/重复失败时允许继续', () => {
    const msgs = repeatedCalls(2)
    const l = buildAgentLedger(msgs)
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