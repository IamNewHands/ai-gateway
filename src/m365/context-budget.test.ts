import { describe, it, expect } from 'vitest'
import { buildAtoms, slidingWindow, flattenPromptMessagesWithBudget, computeContextBudget } from './context-budget'
import type { OaiMsgLite } from './tools'

function msg(role: string, content: string, extra: Partial<OaiMsgLite> = {}): OaiMsgLite {
  return { role, content, ...extra }
}

describe('context-budget：原子构建', () => {
  it('system 多段聚合为单 SYSTEM 原子，第一条 user 升格 ANCHOR', () => {
    const atoms = buildAtoms([
      msg('system', 'sysA'),
      msg('developer', 'devB'),
      msg('user', 'hello'),
      msg('assistant', 'hi'),
      msg('user', 'again'),
    ])
    expect(atoms[0].kind).toBe('SYSTEM')
    expect(atoms[0].msgs.length).toBe(2)
    expect(atoms[1].kind).toBe('ANCHOR')
    expect(atoms[2].kind).toBe('ASSIST')
  })

  it('assistant.tool_calls 与其 tool 结果聚合为一个 ATOM_TOOL 原子', () => {
    const atoms = buildAtoms([
      msg('user', 'run'),
      msg('assistant', 'calling', { tool_calls: [{ id: 'c1', function: { name: 'sh', arguments: '{}' } }] }),
      msg('tool', 'ok', { tool_call_id: 'c1' }),
      msg('user', 'done'),
    ])
    const toolAtom = atoms.find((a) => a.kind === 'ATOM_TOOL')
    expect(toolAtom).toBeDefined()
    expect(toolAtom!.msgs.length).toBe(2)
  })
})

describe('context-budget：滑动窗口裁剪', () => {
  it('总 token 未超预算时不裁剪', () => {
    const msgs = [msg('system', 's'), msg('user', 'short fallback hello'), msg('assistant', 'ok')]
    const r = slidingWindow(msgs, 100000)
    expect(r.truncated).toBe(false)
    expect(r.error).toBeUndefined()
    expect(r.messages).toEqual(msgs)
  })

  it('超预算时保留 system + anchor + 末尾 tool 往返，裁剪中间历史', () => {
    const sys = msg('system', 'S')
    const anchor = msg('user', 'A')
    const middle: OaiMsgLite[] = []
    for (let i = 0; i < 200; i++) {
      middle.push(msg('assistant', 'big padding answer content '.repeat(50)))
      middle.push(msg('user', 'follow up question ' + i))
    }
    const tailTool = msg('assistant', 't', { tool_calls: [{ id: 'c9', function: { name: 'sh', arguments: '{}' } }] })
    const tailResult = msg('tool', 'result content '.repeat(200), { tool_call_id: 'c9' })
    const msgs = [sys, anchor, ...middle, tailTool, tailResult]

    const r = slidingWindow(msgs, 5000)
    expect(r.truncated).toBe(true)
    expect(r.error).toBeUndefined()
    // system、anchor、末尾 tool 往返必须都在
    expect(r.messages).toContainEqual(sys)
    expect(r.messages).toContainEqual(anchor)
    expect(r.messages).toContainEqual(tailTool)
    expect(r.messages).toContainEqual(tailResult)
    // 顺序保持不变
    expect(r.messages[0].role).toBe('system')
    expect(r.messages[r.messages.length - 1].role).toBe('tool')
  })

  it('固定上下文（system+anchor+tool）本身超预算时返回 context_length_exceeded', () => {
    const huge = 'x'.repeat(300) // ~75 tokens
    const msgs = [
      msg('system', huge),
      msg('user', huge),
      msg('assistant', huge, { tool_calls: [{ id: 'c', function: { name: 'sh', arguments: '{}' } }] }),
      msg('tool', huge, { tool_call_id: 'c' }),
    ]
    const r = slidingWindow(msgs, 300)
    expect(r.error).toMatch(/context_length_exceeded/)
  })
})

describe('context-budget：flatten + 预算计算', () => {
  it('flattenPromptMessagesWithBudget 返回布尔 truncated，不抛错当未超预算', () => {
    const r = flattenPromptMessagesWithBudget([msg('system', 's'), msg('user', 'hello')], undefined, 100000)
    expect(r.error).toBeUndefined()
    expect(typeof r.truncated).toBe('boolean')
    expect(r.prompt).toContain('hello')
  })

  it('computeContextBudget = window - maxOutput - 512，缺省用默认窗口', () => {
    const env = { M365_CONTEXT_WINDOW_TOKENS: '100000' } as any
    expect(computeContextBudget(env, { max_completion_tokens: 4000 })).toBe(100000 - 4000 - 512)
    expect(computeContextBudget(env, { max_tokens: 2000 })).toBe(100000 - 2000 - 512)
    expect(computeContextBudget({} as any, {})).toBe(200000 - 0 - 512)
  })
})