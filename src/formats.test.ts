import { describe, it, expect } from 'vitest'
import { openAIChunkToResponsesSSE, responsesToOpenAI, buildResponsesFallbackCompleted, createAnthropicSSEAccumulator, openAIChunkToAnthropicSSE, aggregateOpenAIToAnthropic, finalizeAnthropicStream, anthropicToOpenAI } from './formats'

// 构造一个响应转换器的累加器（与 proxy.ts handleResponsesSpecial 的用法一致）
function acc(): Parameters<typeof openAIChunkToResponsesSSE>[1] {
  return {
    responseId: '',
    model: '',
    itemId: null,
    textContent: '',
    toolCalls: new Map<number, { id: string; name: string; args: string }>(),
    inputTokens: 0,
    outputTokens: 0,
    hasStarted: false,
    completed: false,
  }
}

function chunk(delta: Record<string, unknown>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'poolside/laguna-s-2.1:free',
    choices: [{ index: 0, delta, finish_reason: null }],
  } as never
}

describe('openAIChunkToResponsesSSE item8：reasoning 映射', () => {
  it('首次 reasoning_content delta 发出 output_item.added(=reasoning) + summary_part + reasoning_summary_text.delta', () => {
    const out = openAIChunkToResponsesSSE(chunk({ reasoning_content: 'think step' }), acc())
    expect(out).toContain('event: response.output_item.added')
    expect(out).toContain('"type":"reasoning"')
    expect(out).toContain('event: response.reasoning_summary_part.added')
    expect(out).toContain('event: response.reasoning_summary_text.delta')
    expect(out).toContain('"delta":"think step"')
  })

  it('连续 reasoning delta 复用同一 output_item，不再重复发 output_item.added', () => {
    const a = acc()
    openAIChunkToResponsesSSE(chunk({ reasoning_content: 'think' }), a)
    const second = openAIChunkToResponsesSSE(chunk({ reasoning_content: ' more' }), a)
    expect(second).not.toContain('response.output_item.added')
    expect(second).not.toContain('response.reasoning_summary_part.added')
    expect(second).toContain('event: response.reasoning_summary_text.delta')
    expect(second).toContain('"delta":" more"')
  })

  it('无 reasoning_content 时不产出 reasoning 相关事件（回归保护）', () => {
    const out = openAIChunkToResponsesSSE(chunk({ content: 'hello' }), acc())
    expect(out).not.toContain('reasoning_summary_text')
    expect(out).not.toContain('"type":"reasoning"')
    expect(out).toContain('response.output_text.delta')
  })
})

describe('responsesToOpenAI additional_tools 解析', () => {
  it('从 input 的 additional_tools 项提取并合并进顶层 tools', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'additional_tools',
          tools: [
            { type: 'custom', name: 'exec', description: 'run cmd', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
          ],
        },
      ],
    })
    expect(body['tools']).toEqual([
      { type: 'function', function: { name: 'exec', description: 'run cmd', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
    ])
    // additional_tools 是元数据项,不应进入 messages
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('过滤 Codex 内部工具 wait / request_user_input,仅保留可投递声明', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        {
          type: 'additional_tools',
          tools: [
            { type: 'custom', name: 'wait', description: 'pauser' },
            { type: 'custom', name: 'request_user_input', description: 'ask' },
            { type: 'custom', name: 'exec', description: 'run' },
          ],
        },
      ],
    })
    const tools = body['tools'] as Array<{ function: { name: string } }>
    expect(tools.map((t) => t.function.name)).toEqual(['exec'])
  })

  it('顶层 tools 与 additional_tools 合并去重保留', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [{ type: 'additional_tools', tools: [{ type: 'custom', name: 'exec', description: 'run' }] }],
      tools: [{ type: 'custom', name: 'search', description: 'search web' }],
    })
    const tools = body['tools'] as Array<{ function: { name: string } }>
    expect(tools.map((t) => t.function.name)).toContain('exec')
    expect(tools.map((t) => t.function.name)).toContain('search')
  })
})

describe('responsesToOpenAI 工具历史项还原（Codex 多轮工具调用）', () => {
  it('function_call → assistant.tool_calls，function_call_output → tool 消息', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        { type: 'message', role: 'user', content: 'run ls' },
        { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file1\nfile2' },
        { type: 'message', role: 'user', content: 'now summarize' },
      ],
    })
    const msgs = body['messages'] as Array<Record<string, unknown>>
    expect(msgs[0]).toEqual({ role: 'user', content: 'run ls' })
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }],
    })
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file1\nfile2' })
    expect(msgs[3]).toEqual({ role: 'user', content: 'now summarize' })
  })

  it('连续多个 function_call 合并进同一条 assistant 消息', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
        { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'r1' },
        { type: 'function_call_output', call_id: 'c2', output: 'r2' },
      ],
    })
    const msgs = body['messages'] as Array<Record<string, unknown>>
    const assistant = msgs.find((m) => m['role'] === 'assistant') as { tool_calls: unknown[] }
    expect(assistant.tool_calls).toHaveLength(2)
    expect(msgs.filter((m) => m['role'] === 'tool')).toHaveLength(2)
  })

  it('无匹配调用的 function_call_output 被丢弃（协议保护）', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call_output', call_id: 'orphan', output: 'stray' },
      ],
    })
    const msgs = body['messages'] as Array<Record<string, unknown>>
    expect(msgs.some((m) => m['role'] === 'tool')).toBe(false)
  })

  it('结构化 output（parts 数组）折叠为文本', () => {
    const body = responsesToOpenAI({
      model: 'gpt-5',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'text', text: 'part-A' }, { type: 'text', text: 'part-B' }] },
      ],
    })
    const msgs = body['messages'] as Array<Record<string, unknown>>
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as { content: string }
    expect(toolMsg.content).toBe('part-Apart-B')
  })
})

describe('openAIChunkToResponsesSSE output_index 与终态 output', () => {
  it('reasoning / message / function_call 的 output_index 顺序分配且互不冲突', () => {
    const a = acc()
    const r = openAIChunkToResponsesSSE(chunk({ reasoning_content: 'think' }), a)
    openAIChunkToResponsesSSE(chunk({ content: 'hello' }), a)
    const t = openAIChunkToResponsesSSE(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '' } }] }), a)
    expect(r).toContain('"output_index":0')
    expect(t).toContain('"output_index":2')
  })

  it('function_call item 带 status 字段', () => {
    const a = acc()
    const out = openAIChunkToResponsesSSE(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }] }), a)
    expect(out).toContain('"type":"function_call"')
    expect(out).toContain('"status":"in_progress"')
  })

  it('response.completed 携带真实 output（非空）', () => {
    const a = acc()
    openAIChunkToResponsesSSE(chunk({ content: 'hi there' }), a)
    const out = openAIChunkToResponsesSSE({ id: 'x', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as never, a)
    expect(out).toContain('event: response.completed')
    expect(out).toContain('"type":"message"')
    expect(out).toContain('"text":"hi there"')
    expect(out).not.toContain('"output":[]')
  })

  it('m365_gateway 检查点 → response.completed 带 end_turn=false', () => {
    const a = acc()
    openAIChunkToResponsesSSE(chunk({ content: 'partial' }), a)
    const out = openAIChunkToResponsesSSE({
      id: 'x', model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      m365_gateway: { checkpoint: true, continuation_required: true },
    } as never, a)
    expect(out).toContain('"end_turn":false')
    expect(out).toContain('"continuation_required":true')
  })
})

describe('buildResponsesFallbackCompleted 流式兜底', () => {
  it('从累积状态重建 output（message + tool_call）', () => {
    const a = acc()
    a.responseId = 'resp_1'
    a.itemId = 'item_1'
    a.textContent = 'final text'
    a.toolCalls.set(0, { id: 'c1', name: 'exec', args: '{"a":1}' })
    const out = buildResponsesFallbackCompleted(a)
    expect(out).toContain('event: response.completed')
    expect(out).toContain('"text":"final text"')
    expect(out).toContain('"call_id":"c1"')
    expect(out).toContain('"name":"exec"')
  })

  it('无任何累积时也可安全生成（不抛错）', () => {
    const out = buildResponsesFallbackCompleted(acc())
    expect(out).toContain('event: response.completed')
    expect(out).toContain('resp_unknown')
  })
})

// ============================================================================
// Anthropic 转换的畸形 tool_call 防护（移植 luawei1/cline2api 49fdb8a，2026-09-24）
//
// 背景：上游偶发输出 function.name 为空的 tool call（GLM 流式分片丢失 / 工具调用以文本
// 形式泄漏）。这类块客户端无法执行，执行失败后会把残缺记录回放进下一轮历史，导致上游
// 恒定 400 "tool_calls[N].function.name must be a non-empty string"，毒化整个会话。
// ============================================================================

/** 收集 Anthropic SSE 里所有 input_json_delta 的 partial_json，按顺序拼接。 */
function anthropicToolArgDeltas(sse: string): string[] {
  const out: string[] = []
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      const obj = JSON.parse(payload) as { type?: string; delta?: { partial_json?: string } }
      if (obj.type === 'content_block_delta' && obj.delta?.partial_json !== undefined) {
        out.push(obj.delta.partial_json)
      }
    } catch { /* 跳过非 JSON 行 */ }
  }
  return out
}

function toolDeltaChunk(toolCalls: unknown[]): never {
  return {
    id: 'chatcmpl-t',
    object: 'chat.completion.chunk',
    model: 'm',
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  } as never
}

function finishChunk(finish: string): never {
  return { id: 'x', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: finish }] } as never
}

describe('Anthropic 流式：畸形 tool_call 防护', () => {
  it('空名 tool_call → 不发 content_block_start，stop_reason 降级为 end_turn', () => {
    const a = createAnthropicSSEAccumulator()
    // id 到齐但 name 整片丢失
    const first = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '{}' } }]),
      a,
    )
    expect(first).not.toContain('"type":"tool_use"')
    const last = openAIChunkToAnthropicSSE(finishChunk('tool_calls'), a)
    expect(last).not.toContain('content_block_start')
    expect(last).not.toContain('content_block_stop')
    expect(last).toContain('"stop_reason":"end_turn"')
  })

  it('name 晚于 id 到达 → name 到齐后才发 start，且此前累积的 arguments 不丢', () => {
    const a = createAnthropicSSEAccumulator()
    // 第 1 帧：只有 id + 首片 args（name 缺失）
    openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'call_1', type: 'function', function: { arguments: '{"cmd":' } }]),
      a,
    )
    // 第 2 帧：name 到齐 + 后续 args
    const out = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, type: 'function', function: { name: 'exec', arguments: '"ls"}' } }]),
      a,
    )
    expect(out).toContain('event: content_block_start')
    expect(out).toContain('"name":"exec"')
    // 首片 + 后续片拼接后必须是完整 JSON（旧实现会把首片吞掉）
    expect(anthropicToolArgDeltas(out).join('')).toBe('{"cmd":"ls"}')
  })

  it('单帧 name+args → arguments 作为 input_json_delta 发出（修旧实现漏发首片）', () => {
    const a = createAnthropicSSEAccumulator()
    const out = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"a":1}' } }]),
      a,
    )
    expect(out).toContain('"name":"exec"')
    expect(anthropicToolArgDeltas(out).join('')).toBe('{"a":1}')
  })

  it('正常多帧 tool_call → start/stop 齐全，stop_reason=tool_use（不误伤）', () => {
    const a = createAnthropicSSEAccumulator()
    openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '' } }]),
      a,
    )
    openAIChunkToAnthropicSSE(toolDeltaChunk([{ index: 0, type: 'function', function: { arguments: '{"a"' } }]), a)
    openAIChunkToAnthropicSSE(toolDeltaChunk([{ index: 0, type: 'function', function: { arguments: ':1}' } }]), a)
    const last = openAIChunkToAnthropicSSE(finishChunk('tool_calls'), a)
    expect(last).toContain('event: content_block_stop')
    expect(last).toContain('"stop_reason":"tool_use"')
  })
})

describe('aggregateOpenAIToAnthropic：畸形 tool_call 清洗', () => {
  it('空名 tool_call 被丢弃，stop_reason 从 tool_use 降级为 end_turn', () => {
    const resp = aggregateOpenAIToAnthropic([
      toolDeltaChunk([{ index: 0, id: 'a1', type: 'function', function: { name: '', arguments: '{}' } }]),
      finishChunk('tool_calls'),
    ])
    const content = resp['content'] as Array<Record<string, unknown>>
    expect(content.some((b) => b['type'] === 'tool_use')).toBe(false)
    expect(resp['stop_reason']).toBe('end_turn')
  })

  it('缺 id 的 tool_call 补兜底 id（toolu_ 前缀）', () => {
    const resp = aggregateOpenAIToAnthropic([
      toolDeltaChunk([{ index: 0, type: 'function', function: { name: 'exec', arguments: '{"a":1}' } }]),
      finishChunk('tool_calls'),
    ])
    const content = resp['content'] as Array<Record<string, unknown>>
    const tu = content.find((b) => b['type'] === 'tool_use') as Record<string, unknown>
    expect(String(tu['id'])).toMatch(/^toolu_/)
    expect(tu['name']).toBe('exec')
    expect(resp['stop_reason']).toBe('tool_use')
  })

  it('正常 tool_call 保留且 stop_reason=tool_use（不误伤）', () => {
    const resp = aggregateOpenAIToAnthropic([
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"a":1}' } }]),
      finishChunk('tool_calls'),
    ])
    expect(resp['stop_reason']).toBe('tool_use')
    const content = resp['content'] as Array<Record<string, unknown>>
    expect(content.filter((b) => b['type'] === 'tool_use')).toHaveLength(1)
  })
})

// ============================================================================
// Anthropic 工具块 JSON 校验（移植 Trae2api-cn a01d77c / e5eb6d1）
//
// 旧行为：`closeCurrentBlock` 解析失败**静默保留原串**，照常发 content_block_stop 且
// stop_reason 报 tool_use ⇒ 客户端拿半截 JSON 当成功去执行工具；非流式更糟，解析失败直接
// `input = {}`，等于「没有参数」也执行。现在：能修就补发后缀增量，修不好发 `event: error`
// 且不补 message_stop；非流式修不好则丢弃该块（不下发坏 input）。
// ============================================================================

describe('Anthropic 工具块：截断参数的修复与显式失败', () => {
  it('流式：截断在字符串中 → 收尾补发后缀，拼接后是合法 JSON，stop_reason 仍 tool_use', () => {
    const a = createAnthropicSSEAccumulator()
    let sse = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd": "ls' } }]),
      a,
    )
    sse += openAIChunkToAnthropicSSE(finishChunk('tool_calls'), a)
    const joined = anthropicToolArgDeltas(sse).join('')
    expect(() => JSON.parse(joined)).not.toThrow()
    expect(JSON.parse(joined)).toEqual({ cmd: 'ls' })
    expect(sse).toContain('"stop_reason":"tool_use"')
    expect(sse).not.toContain('event: error')
  })

  it('流式：修不好 → 发 event: error，且不补 message_stop（不得在失败后报正常结束）', () => {
    const a = createAnthropicSSEAccumulator()
    let sse = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"a": tru' } }]),
      a,
    )
    sse += openAIChunkToAnthropicSSE(finishChunk('tool_calls'), a)
    expect(sse).toContain('event: error')
    expect(sse).toContain('"type":"api_error"')
    expect(sse).not.toContain('message_stop')
    // 后续 chunk 一律不再产出事件（客户端已按失败处理）
    expect(openAIChunkToAnthropicSSE(finishChunk('stop'), a)).toBe('')
    expect(finalizeAnthropicStream(a)).toBe('')
  })

  it('流式：上游直接结束（无 finish_reason）→ 兜底 finalize 也走同一套修复', () => {
    const a = createAnthropicSSEAccumulator()
    openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd": "ls' } }]),
      a,
    )
    const tail = finalizeAnthropicStream(a)
    expect(tail).toContain('content_block_stop')
    // 已发出的增量 + 兜底补发 = 合法 JSON
    const deltas = anthropicToolArgDeltas(tail)
    expect(deltas.length).toBeGreaterThan(0)
    expect(() => JSON.parse('{"cmd": "ls' + deltas.join(''))).not.toThrow()
  })

  it('流式：累计快照（重发整段）只补后缀，不拼成 {...}{...}', () => {
    const a = createAnthropicSSEAccumulator()
    let sse = openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"a":' } }]),
      a,
    )
    sse += openAIChunkToAnthropicSSE(
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"a":1}' } }]),
      a,
    )
    sse += openAIChunkToAnthropicSSE(finishChunk('tool_calls'), a)
    expect(anthropicToolArgDeltas(sse).join('')).toBe('{"a":1}')
  })

  it('非流式：截断参数被修复后下发，而不是 input: {}', () => {
    const resp = aggregateOpenAIToAnthropic([
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"cmd": "ls' } }]),
      finishChunk('tool_calls'),
    ])
    const content = resp['content'] as Array<Record<string, unknown>>
    const tu = content.find((b) => b['type'] === 'tool_use') as Record<string, unknown>
    expect(tu['input']).toEqual({ cmd: 'ls' })
    expect(resp['stop_reason']).toBe('tool_use')
  })

  it('非流式：修不好 → 丢弃该 tool_use 块（不下发空参数），stop_reason 降为 end_turn', () => {
    const resp = aggregateOpenAIToAnthropic([
      toolDeltaChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"a": tru' } }]),
      finishChunk('tool_calls'),
    ])
    const content = resp['content'] as Array<Record<string, unknown>>
    expect(content.some((b) => b['type'] === 'tool_use')).toBe(false)
    expect(resp['stop_reason']).toBe('end_turn')
  })
})

describe('anthropicToOpenAI：并行工具调用策略', () => {
  const base = { model: 'm', messages: [] }

  it('顶层 parallel_tool_calls 原样透传（含显式 false）', () => {
    expect(anthropicToOpenAI({ ...base, parallel_tool_calls: false } as never)['parallel_tool_calls']).toBe(false)
    expect(anthropicToOpenAI({ ...base, parallel_tool_calls: true } as never)['parallel_tool_calls']).toBe(true)
  })

  it('disable_parallel_tool_use=true → false；显式 false → true（不丢显式取值）', () => {
    expect(
      anthropicToOpenAI({ ...base, tool_choice: { type: 'auto', disable_parallel_tool_use: true } } as never)['parallel_tool_calls'],
    ).toBe(false)
    expect(
      anthropicToOpenAI({ ...base, tool_choice: { type: 'auto', disable_parallel_tool_use: false } } as never)['parallel_tool_calls'],
    ).toBe(true)
  })

  it('两者都不带 → 不下发该字段（保持上游默认）', () => {
    expect(anthropicToOpenAI({ ...base } as never)['parallel_tool_calls']).toBeUndefined()
  })
})