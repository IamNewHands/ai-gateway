import { describe, it, expect } from 'vitest'
import {
  buildAgentLedger,
  canContinue,
  clientToolWireName,
  decodeAZHEXArguments,
  extractToolCalls,
  MAX_TOOL_ROUNDS_DEFAULT,
  nativeToolCalls,
  normalizeClientArgumentKeys,
  parseModelToolDecision,
  validateDetectedToolCalls,
  parseNativeFunctionCall,
  hasNativeFunctionCallEnvelope,
} from './tools'
import type { OaiMsgLite, ToolDef } from './tools'

const readTool: ToolDef = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
}

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

describe('M365 工具调用信任边界', () => {
  it('原生事件不会把普通插件定义误判为工具调用', () => {
    const events = [{
      name: 'read',
      description: 'Read a file',
      parameters: readTool.function.parameters,
    }]

    expect(nativeToolCalls(events, [readTool])).toEqual([])
  })

  it('原生事件中的参数必须通过调用工具的 schema', () => {
    const events = [{
      contentType: 'ToolCall',
      name: clientToolWireName('read'),
      arguments: { file_path: 42 },
    }]

    expect(nativeToolCalls(events, [readTool])).toEqual([])
  })

  it('parseNativeFunctionCall 正确解析有效的原生工具事件', () => {
    const event = {
      contentType: 'ToolCall',
      name: clientToolWireName('read'),
      arguments: { file_path: 'README.md' },
    }
    const call = parseNativeFunctionCall(event, [readTool])
    expect(call).not.toBeNull()
    expect(call?.name).toBe('read')
    expect(JSON.parse(call?.arguments || '{}')).toEqual({ file_path: 'README.md' })
  })

  it('hasNativeFunctionCallEnvelope 检测畸形或显式调用信封', () => {
    expect(hasNativeFunctionCallEnvelope({
      contentType: 'ToolCall',
      name: 'some_function',
      arguments: 'invalid_json',
    })).toBe(true)

    expect(hasNativeFunctionCallEnvelope({
      type: 'message',
      text: 'hello world',
    })).toBe(false)
  })

  it('named tool_choice 接受所选工具的混淆名文本调用', () => {
    const text = `<m365-tool-call>${JSON.stringify({
      name: clientToolWireName('read'),
      arguments: { file_path: 'README.md' },
    })}</m365-tool-call>`
    const choice = { type: 'function', function: { name: 'read' } }

    const calls = extractToolCalls(text, [readTool], choice)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      name: 'read',
      arguments: JSON.stringify({ file_path: 'README.md' }),
    })
  })

  it('AZHEX 解码嵌套值和属性名，并保留 JSON 标量', () => {
    expect(decodeAZHEXArguments({
      fileZ5FXpath: 'CZ3AXZ5CXrepoZ5CXREADMEZ2EXmd',
      flags: [true, 42, null],
    })).toEqual({
      file_path: 'C:\\repo\\README.md',
      flags: [true, 42, null],
    })
  })

  it('AZHEX 解码拒绝属性名解码后的冲突', () => {
    expect(decodeAZHEXArguments({
      file_path: 'first',
      fileZ5FXpath: 'second',
    })).toBeNull()
  })

  it('AZHEX 解码拒绝未编码的传输敏感 ASCII 字符', () => {
    expect(decodeAZHEXArguments({ cmd: 'echo hello' })).toBeNull()
  })

  it('按工具 schema 将连字符参数键规范化为下划线键', () => {
    expect(normalizeClientArgumentKeys('read', {
      'file-path': 'README.md',
    }, [readTool])).toEqual({
      file_path: 'README.md',
    })
  })

  it('参数键规范化拒绝映射到同一规范键的冲突', () => {
    expect(normalizeClientArgumentKeys('read', {
      file_path: 'first',
      'file-path': 'second',
    }, [readTool])).toBeNull()
  })

  it('固定敏感工具参数表可在缺少 tools 定义时规范化参数键', () => {
    expect(normalizeClientArgumentKeys('exec_command', {
      cmd: 'echoZ20Xhello',
      'yield-time-ms': 100,
    }, [])).toEqual({
      cmd: 'echoZ20Xhello',
      yield_time_ms: 100,
    })
  })

  it('信任边界保留不含完整 AZHEX token 的普通 JSON 参数', () => {
    const detected = [{
      id: 'call_plain',
      type: 'function',
      name: 'read',
      arguments: JSON.stringify({ file_path: 'folder name/README.md' }),
    }]

    expect(validateDetectedToolCalls(detected, [readTool])).toEqual({
      calls: [{
        id: 'call_plain',
        type: 'function',
        name: 'read',
        arguments: JSON.stringify({ file_path: 'folder name/README.md' }),
      }],
      dropped: 0,
    })
  })

  it('信任边界在 schema 校验前解码 AZHEX 并规范化参数键', () => {
    const detected = [{
      id: 'call_azhex',
      type: 'function',
      name: 'read',
      arguments: JSON.stringify({ 'fileZ2DXpath': 'READMEZ2EXmd' }),
    }]

    expect(validateDetectedToolCalls(detected, [readTool])).toEqual({
      calls: [{
        id: 'call_azhex',
        type: 'function',
        name: 'read',
        arguments: JSON.stringify({ file_path: 'README.md' }),
      }],
      dropped: 0,
    })
  })

  it('信任边界拒绝 AZHEX 解码后的参数键冲突', () => {
    const detected = [{
      id: 'call_collision',
      type: 'function',
      name: 'read',
      arguments: JSON.stringify({
        fileZ5FXpath: 'first',
        fileZ2DXpath: 'second',
      }),
    }]

    expect(validateDetectedToolCalls(detected, [readTool])).toEqual({
      calls: [],
      dropped: 1,
    })
  })

  it('continuation 缺少 tools 时仍接受固定敏感 exec_command 调用', () => {
    const detected = [{
      id: 'call_exec',
      type: 'function',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'git status', yield_time_ms: 1000 }),
    }]

    expect(validateDetectedToolCalls(detected, [])).toEqual({
      calls: detected,
      dropped: 0,
    })
  })

  it('continuation 缺少 tools 时拒绝固定敏感 write_stdin 工具的未知参数', () => {
    const detected = [{
      id: 'call_write_stdin_unknown',
      type: 'function',
      name: 'write_stdin',
      arguments: JSON.stringify({ session_id: 1, unexpected: true }),
    }]

    expect(validateDetectedToolCalls(detected, [])).toEqual({
      calls: [],
      dropped: 1,
    })
  })

  it('有界 exec_command 兼容旧 schema 遗漏的安全执行控制参数', () => {
    const legacyExecTool: ToolDef = {
      type: 'function',
      function: {
        name: 'exec_command',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
      },
    }
    const detected = [{
      id: 'call_bounded_exec',
      type: 'function',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'git status', yield_time_ms: 1000 }),
    }]

    expect(validateDetectedToolCalls(detected, [legacyExecTool])).toEqual({
      calls: detected,
      dropped: 0,
    })
  })

  it('有界 exec_command 兼容仍保留已声明 schema 的 required 字段约束', () => {
    const legacyExecTool: ToolDef = {
      type: 'function',
      function: {
        name: 'exec_command',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string' },
            workdir: { type: 'string' },
          },
          required: ['cmd', 'workdir'],
          additionalProperties: false,
        },
      },
    }
    const detected = [{
      id: 'call_missing_required',
      type: 'function',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'git status', yield_time_ms: 1000, unexpected: true }),
    }]

    expect(validateDetectedToolCalls(detected, [legacyExecTool])).toEqual({
      calls: [],
      dropped: 1,
    })
  })

  it('工具路由接受严格 decision=tool_call JSON envelope', () => {
    const result = parseModelToolDecision(JSON.stringify({
      decision: 'tool_call',
      name: clientToolWireName('read'),
      arguments: { file_path: 'README.md' },
    }), [readTool], 'auto')

    expect(result.parsed).toBe(true)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]).toMatchObject({
      name: 'read',
      arguments: JSON.stringify({ file_path: 'README.md' }),
    })
  })

  it('工具路由接受严格 decision=answer JSON envelope', () => {
    expect(parseModelToolDecision(JSON.stringify({
      decision: 'answer',
      text: 'No external state is needed.',
    }), [readTool], 'auto')).toEqual({ calls: [], parsed: true })
  })

  it('工具路由拒绝带额外字段的伪严格 tool_call envelope', () => {
    expect(parseModelToolDecision(JSON.stringify({
      decision: 'tool_call',
      name: clientToolWireName('read'),
      arguments: { file_path: 'README.md' },
      extra: true,
    }), [readTool], 'auto')).toEqual({ calls: [], parsed: false })
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
