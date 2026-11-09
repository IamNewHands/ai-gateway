import { describe, it, expect, vi } from 'vitest'
import { createResponsesSSEToOpenAI, responsesSSEToChatStream } from './responses-chat-stream'
import type { ResponsesChatStreamOptions } from './responses-chat-stream'

// 全部为合成帧：不依赖 proxy、fetch、网络或真实凭据。
type Event = [string, Record<string, unknown>]
type ToolDelta = { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }
type Frame = {
  id?: string
  model?: string
  choices?: Array<{ delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: ToolDelta[] }; finish_reason: string | null }>
  usage?: Record<string, unknown>
  error?: { code: string; message: string; type: string }
}

function decoded(text: string) {
  const data = text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6))
  const frames = data.filter(value => value !== '[DONE]').map(value => JSON.parse(value) as Frame)
  const chunks = frames.filter(frame => frame.choices)
  const deltas = chunks.map(frame => frame.choices![0].delta)
  return {
    frames, chunks, deltas,
    content: deltas.map(delta => delta.content ?? '').join(''),
    reasoning: deltas.map(delta => delta.reasoning_content ?? '').join(''),
    finishes: chunks.map(frame => frame.choices![0].finish_reason).filter(reason => reason !== null),
    errors: frames.flatMap(frame => frame.error ? [frame.error] : []),
    done: data.filter(value => value === '[DONE]').length,
  }
}

function run(events: Event[], options?: ResponsesChatStreamOptions) {
  const conv = createResponsesSSEToOpenAI('hint-model', options)
  const frames = events.flatMap(([event, data]) => conv(event, data))
  frames.push(...conv.end())
  return decoded(frames.join(''))
}

function completed(output: unknown[] = [], extra: Record<string, unknown> = {}): Event {
  return ['response.completed', { response: { id: 'resp_test', status: 'completed', output, ...extra } }]
}

function message(id: string, texts: string[]) {
  return { id, type: 'message', status: 'completed', content: texts.map(text => ({ type: 'output_text', text })) }
}

function tool(n: number, args = '{}', extra: Record<string, unknown> = {}) {
  return { id: `fc_${n}`, type: 'function_call', call_id: `call_${n}`, name: `tool_${n}`, arguments: args, status: 'completed', ...extra }
}

function tools(result: ReturnType<typeof decoded>) {
  const calls = new Map<number, { index: number; id: string; name: string; arguments: string }>()
  for (const delta of result.deltas) for (const part of delta.tool_calls ?? []) {
    const call = calls.get(part.index) ?? { index: part.index, id: '', name: '', arguments: '' }
    if (part.id) call.id = part.id
    if (part.function?.name) call.name = part.function.name
    call.arguments += part.function?.arguments ?? ''
    calls.set(part.index, call)
  }
  return [...calls.values()]
}

function sse([event, data]: Event, typeOnly = false) {
  return `${typeOnly ? '' : `event: ${event}\n`}data: ${JSON.stringify({ type: event, ...data })}\n\n`
}

function source(text: string, bytewise = false, keepOpen = false) {
  const bytes = new TextEncoder().encode(text)
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      else if (bytes.length) controller.enqueue(bytes)
      if (!keepOpen) controller.close()
    },
    cancel,
  })
  return { body, cancel }
}

async function stream(text: string, bytewise = false, options?: ResponsesChatStreamOptions) {
  return decoded(await new Response(responsesSSEToChatStream(source(text, bytewise).body, 'hint-model', options)).text())
}

function expectError(result: ReturnType<typeof decoded>, code: string) {
  expect(result.errors.map(error => error.code)).toEqual([code])
  expect(result.finishes).toEqual([])
  expect(result.done).toBe(1)
}

describe('createResponsesSSEToOpenAI：按 item / part 对账', () => {
  it('created → delta/text.done/item.done/completed：同 item 多 part、多 message 只补后缀', () => {
    const m1 = message('msg_1', ['你好', '世界!'])
    const m2 = message('msg_2', ['第二条'])
    const result = run([
      ['response.created', { response: { id: 'resp_test', model: 'upstream-model' } }],
      ['response.output_item.added', { output_index: 0, item: { ...m1, content: [] } }],
      ['response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你' }],
      ['response.output_text.done', { item_id: 'msg_1', content_index: 0, text: '你好' }],
      ['response.output_text.delta', { item_id: 'msg_1', content_index: 1, delta: '世' }],
      ['response.output_item.done', { output_index: 0, item: m1 }],
      ['response.output_item.added', { output_index: 1, item: { ...m2, content: [] } }],
      ['response.output_text.delta', { output_index: 1, content_index: 0, delta: '第二' }],
      completed([m1, m2]),
      completed([m1, m2]),
    ])
    expect(result.content).toBe('你好世界!第二条')
    expect(result.deltas.filter(delta => delta.role === 'assistant')).toHaveLength(1)
    expect(result.chunks.every(chunk => chunk.id === 'chatcmpl_test' && chunk.model === 'upstream-model')).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
    expect(result.done).toBe(1)
  })

  it('只有 completed 的多 message、多 part 快照补齐全部内容', () => {
    const result = run([completed([message('msg_1', ['甲', '乙']), message('msg_2', ['丙'])])])
    expect(result.content).toBe('甲乙丙')
    expect(result.finishes).toEqual(['stop'])
  })

  it('reasoning summary / content 与 refusal 增量、done、最终快照不重复', () => {
    const reasoning = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要完整' }], content: [{ type: 'reasoning_text', text: '思考完整' }] }
    const refusal = { id: 'msg_1', type: 'message', content: [{ type: 'refusal', refusal: '不能提供' }] }
    const result = run([
      ['response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 0, delta: '摘要' }],
      ['response.reasoning_summary_text.done', { item_id: 'rs_1', summary_index: 0, text: '摘要完整' }],
      ['response.reasoning_text.delta', { item_id: 'rs_1', content_index: 0, delta: '思考' }],
      ['response.reasoning_text.done', { item_id: 'rs_1', content_index: 0, text: '思考完整' }],
      ['response.refusal.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: '不能' }],
      ['response.refusal.done', { item_id: 'msg_1', content_index: 0, refusal: '不能提供' }],
      ['response.output_item.done', { output_index: 0, item: reasoning }],
      completed([reasoning, refusal]),
    ])
    expect(result.reasoning).toBe('摘要完整思考完整')
    expect(result.content).toBe('不能提供')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it('reasoning/refusal 最终快照补未收到 done 的后缀', () => {
    const result = run([
      ['response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, delta: '想' }],
      ['response.refusal.delta', { item_id: 'msg_1', output_index: 1, delta: '不能' }],
      completed([
        { id: 'rs_1', type: 'reasoning', summary: [{ text: '想清楚' }] },
        { id: 'msg_1', type: 'message', content: [{ type: 'refusal', refusal: '不能回答' }] },
      ]),
    ])
    expect(result.reasoning).toBe('想清楚')
    expect(result.content).toBe('不能回答')
    expect(result.errors).toEqual([])
  })

  it('reasoning content 增量的最终快照只补后缀', () => {
    const result = run([
      ['response.reasoning_text.delta', { item_id: 'rs_1', output_index: 0, content_index: 0, delta: '思考' }],
      completed([{ id: 'rs_1', type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考完整' }] }]),
    ])
    expect(result.reasoning).toBe('思考完整')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it('唯一已知 item 后无身份 delta 与快照绑定，不重复正文', () => {
    const m = message('msg_1', ['hello'])
    const result = run([
      ['response.output_item.added', { output_index: 0, item: { ...m, content: [] } }],
      ['response.output_text.delta', { delta: 'he' }],
      completed([m]),
    ])
    expect(result.content).toBe('hello')
    expect(result.errors).toEqual([])
  })

  it('匿名增量不抢绑随后索引 1，完整快照按前缀唯一对账', () => {
    const a = message('A', ['A'])
    const b = message('B', ['B'])
    const result = run([
      ['response.output_text.delta', { delta: 'A' }],
      ['response.output_item.added', { output_index: 1, item: { ...b, content: [] } }],
      completed([a, b]),
    ])
    expect(result.content).toBe('AB')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it.each([false, true])('匿名delta恢复明确身份后的后缀不会重复或误报重叠（item.done=%s）', itemDone => {
    const final = message('msg_1', ['AB'])
    const result = run([
      ['response.output_text.delta', { delta: 'A' }],
      ['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: 'B' }],
      ...(itemDone ? [['response.output_item.done', { output_index: 0, item: final }] as Event] : []),
      completed(itemDone ? [] : [final]),
    ])
    expect(result.content).toBe('AB')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it('匿名delta恢复身份后 text.done 只补未发送后缀', () => {
    const result = run([
      ['response.output_text.delta', { delta: 'A' }],
      ['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: 'B' }],
      ['response.output_text.done', { item_id: 'msg_1', text: 'ABC' }],
      completed([message('msg_1', ['ABC'])]),
    ])
    expect(result.content).toBe('ABC')
    expect(result.finishes).toEqual(['stop'])
    expect(result.errors).toEqual([])
  })

  it('匿名增量多个快照都匹配时不重复补发或猜测 item', () => {
    const result = run([['response.output_text.delta', { delta: 'same' }], completed([message('A', ['same A']), message('B', ['same B'])])])
    expect(result.content).toBe('same')
    expectError(result, 'upstream_invalid_response')
  })

  it('多个活跃 item 的无身份 delta 显式拒绝，不猜测归属', () => {
    expectError(run([
      ['response.output_item.added', { output_index: 0, item: { ...message('m1', []), status: 'in_progress' } }],
      ['response.output_item.added', { output_index: 1, item: { ...message('m2', []), status: 'in_progress' } }],
      ['response.output_text.delta', { delta: 'ambiguous' }],
    ]), 'upstream_invalid_response')
  })

  it('最终文本与已发送前缀不符不能以 stop 伪装成功', () => {
    const result = run([
      ['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '已经发送' }],
      completed([message('msg_1', ['另一段正文'])]),
    ])
    expect(result.content).toBe('已经发送')
    expectError(result, 'upstream_invalid_response')
  })
})

describe('createResponsesSSEToOpenAI：工具调用身份、参数与完成状态', () => {
  it('多个交织 function_call 的 added/delta/arguments.done/item.done/completed 不重复', () => {
    const t0 = tool(0, '{"city":"上海"}')
    const t1 = tool(1, '{"n":2}')
    const result = run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { status: 'in_progress' }) }],
      ['response.output_item.added', { output_index: 1, item: tool(1, '', { status: 'in_progress' }) }],
      ['response.function_call_arguments.delta', { item_id: 'fc_0', output_index: 0, delta: '{"city":' }],
      ['response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: '{"n":' }],
      ['response.function_call_arguments.delta', { item_id: 'fc_0', delta: '"上海"}' }],
      ['response.function_call_arguments.done', { item_id: 'fc_1', arguments: '{"n":2}' }],
      ['response.function_call_arguments.done', { item_id: 'fc_0', arguments: t0.arguments }],
      ['response.output_item.done', { output_index: 1, item: t1 }],
      ['response.output_item.done', { output_index: 0, item: t0 }],
      completed([t0, t1]),
    ])
    expect(tools(result)).toEqual([
      { index: 0, id: 'call_0', name: 'tool_0', arguments: t0.arguments },
      { index: 1, id: 'call_1', name: 'tool_1', arguments: t1.arguments },
    ])
    expect(result.deltas.flatMap(delta => delta.tool_calls ?? []).filter(call => call.id)).toHaveLength(2)
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['tool_calls'])
  })

  it('added 缺 call_id 时暂缓宣布身份，done 补真实 id 后发送缓存参数', () => {
    const result = run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { call_id: undefined, status: 'in_progress' }) }],
      ['response.function_call_arguments.delta', { item_id: 'fc_0', delta: '{"n":' }],
      ['response.output_item.done', { output_index: 0, item: tool(0, '{"n":1}', { call_id: 'call_REAL' }) }],
      completed(),
    ])
    expect(tools(result)).toEqual([{ index: 0, id: 'call_REAL', name: 'tool_0', arguments: '{"n":1}' }])
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['tool_calls'])
  })

  it('没有 arguments delta 时 completed 补全部工具参数', () => {
    const args = JSON.stringify({ text: '长'.repeat(700) })
    const result = run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { status: 'in_progress' }) }],
      completed([tool(0, args), tool(1, '{"value":true}')]),
    ])
    expect(tools(result).map(call => call.arguments)).toEqual([args, '{"value":true}'])
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['tool_calls'])
  })

  it('completed 快照参数为 JSON 对象时规范化，缺省 item status 保持兼容', () => {
    const result = run([completed([tool(0, '{}', { arguments: { value: 1 }, status: undefined })])])
    expect(tools(result)[0].arguments).toBe('{"value":1}')
    expect(result.finishes).toEqual(['tool_calls'])
  })

  it.each([
    ['缺少 call_id 和 id', { id: '', call_id: '' }],
    ['缺少名称', { name: '' }],
    ['截断参数', { arguments: '{"n":' }],
    ['JSON 数组', { arguments: '[]' }],
    ['JSON null', { arguments: 'null' }],
    ['JSON 字符串', { arguments: '"text"' }],
    ['JSON 数字', { arguments: '1' }],
    ['incomplete item', { status: 'incomplete' }],
    ['in_progress item', { status: 'in_progress' }],
    ['failed item', { status: 'failed' }],
    ['cancelled item', { status: 'cancelled' }],
  ])('completed 中%s 不得返回 tool_calls', (_label, extra) => {
    expectError(run([completed([tool(0, '{}', extra)])]), 'upstream_invalid_response')
  })

  it.each([
    ['call_id 不匹配', { call_id: 'other_call' }],
    ['名称不匹配', { name: 'other_tool' }],
    ['item id 不匹配', { id: 'other_item' }],
    ['arguments 前缀不匹配', { arguments: '{"n":2}' }],
  ])('%s 不得伪装成完成', (_label, extra) => {
    expectError(run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '{"n":1}', { status: 'in_progress' }) }],
      completed([tool(0, '{"n":1}', extra)]),
    ]), 'upstream_invalid_response')
  })

  it('arguments.done 仅确认参数，缺少 item 完成确认仍不得工具成功', () => {
    expectError(run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { status: 'in_progress' }) }],
      ['response.function_call_arguments.done', { item_id: 'fc_0', arguments: '{}' }],
      completed(),
    ]), 'upstream_invalid_response')
  })

  it('已有参数 delta 但无任何完成确认，completed 空 output 仍不得工具成功', () => {
    expectError(run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { status: 'in_progress' }) }],
      ['response.function_call_arguments.delta', { item_id: 'fc_0', delta: '{}' }],
      completed(),
    ]), 'upstream_invalid_response')
  })
})

describe('createResponsesSSEToOpenAI：终态、usage 与脱敏诊断', () => {
  it.each(['response.failed', 'error'])('%s 在正文前/后透 error，后续 completed 无效', event => {
    for (const partial of [false, true]) {
      const onFinish = vi.fn()
      const error = { code: 'rate_limit_exceeded', message: '不应回显的上游正文' }
      const result = run([
        ...(partial ? [['response.output_text.delta', { item_id: 'msg_1', delta: '部分正文' }] as Event] : []),
        [event, event === 'error' ? { error } : { response: { id: 'resp_test', status: 'failed', error } }],
        completed([message('msg_1', ['错误后正文'])]),
      ], { onFinish })
      expect(result.content).toBe(partial ? '部分正文' : '')
      expectError(result, 'rate_limit_exceeded')
      expect(result.errors[0].message).toContain('429')
      expect(result.errors[0].message).not.toContain(error.message)
      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(onFinish.mock.calls[0][0]).toMatchObject({ outcome: 'failed', terminalEvent: event, errorCode: error.code })
    }
  })

  it('incomplete max_output_tokens 只发 length，后续 completed 无效', () => {
    const onFinish = vi.fn()
    const result = run([
      ['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '截断' }],
      ['response.incomplete', { response: { id: 'resp_test', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('msg_1', ['截断正文'])] } }],
      completed(),
    ], { onFinish })
    expect(result.content).toBe('截断正文')
    expect(result.finishes).toEqual(['length'])
    expect(result.errors).toEqual([])
    expect(onFinish.mock.calls[0][0]).toMatchObject({ outcome: 'incomplete', terminalEvent: 'response.incomplete' })
  })

  it('max_output_tokens 截断工具参数保留 length，不要求完整 JSON 或伪装 tool_calls', () => {
    const result = run([
      ['response.output_item.added', { output_index: 0, item: tool(0, '', { status: 'in_progress' }) }],
      ['response.function_call_arguments.delta', { item_id: 'fc_0', delta: '{"n":' }],
      ['response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [tool(0, '{"n":', { status: 'incomplete' })] } }],
    ])
    expect(result.finishes).toEqual(['length'])
    expect(result.errors).toEqual([])
  })

  it('content_filter incomplete 发具名错误而非 stop/length', () => {
    expectError(run([['response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }]]), 'content_filter')
  })

  it('真空 completed 保留一个 assistant 起始帧和 stop', () => {
    const onFinish = vi.fn()
    const result = run([completed()], { onFinish })
    expect(result.content).toBe('')
    expect(result.deltas).toEqual([{ role: 'assistant', content: '' }, {}])
    expect(result.finishes).toEqual(['stop'])
    expect(result.done).toBe(1)
    expect(onFinish.mock.calls[0][0]).toMatchObject({ outcome: 'completed', empty: true, toolCalls: 0 })
  })

  it.each([true, false])('includeUsage=%s：仅终帧按开关携带正确 usage', includeUsage => {
    const result = run([completed([], { usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } })], { includeUsage })
    expect(result.chunks.filter(chunk => chunk.usage)).toHaveLength(includeUsage ? 1 : 0)
    if (includeUsage) expect(result.chunks.at(-1)?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } })
  })

  it('诊断只含状态、计数、event/id/code；不含正文、reasoning、tool args', () => {
    const onFinish = vi.fn()
    run([completed([
      message('msg_1', ['secret-content']),
      { id: 'rs_1', type: 'reasoning', summary: [{ text: 'secret-reasoning' }] },
      tool(0, '{"secret-args":true}'),
    ])], { onFinish })
    expect(onFinish).toHaveBeenCalledTimes(1)
    const summary = onFinish.mock.calls[0][0]
    expect(Object.keys(summary).sort()).toEqual(['contentChars', 'empty', 'events', 'outcome', 'reasoningChars', 'responseId', 'terminalEvent', 'toolCalls'].sort())
    expect(summary).toMatchObject({ responseId: 'resp_test', events: 1, contentChars: 14, reasoningChars: 16, toolCalls: 1, empty: false })
    expect(JSON.stringify(summary)).not.toContain('secret-')
  })

  it('诊断回调抛异常不改变完成结果；错误文案只走调用方 sanitizer', () => {
    expect(run([completed()], { onFinish: () => { throw new Error('diagnostic failure') } }).finishes).toEqual(['stop'])
    const sanitizeErrorText = vi.fn(() => '[sanitized]')
    const result = run([['error', { code: 'invalid_api_key', message: 'private-upstream-message' }]], { sanitizeErrorText })
    expect(sanitizeErrorText).toHaveBeenCalledWith('private-upstream-message')
    expect(result.errors[0].message).toContain('401 Responses upstream')
    expect(result.errors[0].message).toContain('[sanitized]')
    expect(result.errors[0].message).not.toContain('private-upstream-message')
  })
})

describe('responsesSSEToChatStream：字节解析与 reader 生命周期', () => {
  it('混合 event/type-only、合法多行 data、注释和未知字段', async () => {
    const text = ': heartbeat\nid: ignored\nretry: 100\n' + sse(['response.created', { response: { id: 'resp_test' } }])
      + 'event: response.output_text.delta\ndata: {"item_id":"msg_1",\ndata: "output_index":0,"delta":"你好"}\n\n'
      + sse(completed([message('msg_1', ['你好世界'])]), true)
    const result = await stream(text)
    expect(result.content).toBe('你好世界')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it.each(['\n', '\r', '\r\n'])('每字节 UTF8：%j 换行跨边界仍保留中文', async newline => {
    const text = (sse(['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '中文🌟' }], true)
      + sse(completed([message('msg_1', ['中文🌟后缀'])]))).replace(/\n/g, newline)
    const result = await stream(text, true)
    expect(result.content).toBe('中文🌟后缀')
    expect(result.errors).toEqual([])
    expect(result.finishes).toEqual(['stop'])
  })

  it('单字节流混合 CR / LF / CRLF 分界', async () => {
    const text = sse(['response.created', { response: { id: 'resp_test' } }]).replace(/\n/g, '\r')
      + sse(['response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '中文' }], true)
      + sse(completed([message('msg_1', ['中文'])])).replace(/\n/g, '\r\n')
    const result = await stream(text, true)
    expect(result.content).toBe('中文')
    expect(result.finishes).toEqual(['stop'])
    expect(result.done).toBe(1)
  })

  it.each(['', '\r'])('EOF 无空行尾帧（尾部 %j）仍处理 terminal', async suffix => {
    const result = await stream(sse(completed([message('msg_1', ['尾部中文'])]), true).trimEnd() + suffix, true)
    expect(result.content).toBe('尾部中文')
    expect(result.finishes).toEqual(['stop'])
    expect(result.errors).toEqual([])
  })

  it('下游未消费不预读；消费一个事件仅拉有限帧', async () => {
    let reads = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(new TextEncoder().encode(sse(['response.output_text.delta', { output_index: 0, delta: 'x'.repeat(1000) }])))
      },
    }, { highWaterMark: 0 })
    const reader = responsesSSEToChatStream(upstream, 'hint-model').getReader()
    await Promise.resolve()
    expect(reads).toBe(0)
    await reader.read()
    expect(reads).toBe(1)
    await reader.cancel()
  })

  it('空 data 行也计入单帧上限，不能绕过数组增长限制', async () => {
    const upstream = source('data:\n'.repeat(700000), false, true)
    const result = decoded(await new Response(responsesSSEToChatStream(upstream.body, 'hint-model')).text())
    expectError(result, 'upstream_invalid_sse')
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
  })

  it('超大无换行帧被拒绝并取消上游，不回显原始帧', async () => {
    const upstream = source('data: ' + 'x'.repeat(4 * 1024 * 1024 + 1), false, true)
    const result = decoded(await new Response(responsesSSEToChatStream(upstream.body, 'hint-model')).text())
    expectError(result, 'upstream_invalid_sse')
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['data: {broken-secret-json}\n\n', 'data: []\n\n'])('坏 JSON 或非对象帧 %j 显式失败且不回显', async text => {
    const result = await stream(text)
    expectError(result, 'upstream_invalid_sse')
    expect(result.errors[0].message).not.toContain('broken-secret-json')
  })

  it.each([
    ['空 EOF', ''],
    ['only DONE', 'data: [DONE]\n\n'],
    ['有 delta 无 terminal', sse(['response.output_text.delta', { delta: '部分中文' }])],
    ['delta 后仅 DONE', sse(['response.output_text.delta', { delta: '部分中文' }]) + 'data: [DONE]\n\n'],
  ])('%s 不伪造 stop', async (_label, text) => {
    const result = await stream(text, true)
    expectError(result, 'upstream_no_finish')
    expect(result.content).toBe(text.includes('部分中文') ? '部分中文' : '')
  })

  it.each([false, true])('reader read 失败（已有正文=%s）显式报 upstream_interrupted', async partial => {
    const onFinish = vi.fn()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (partial && reads++ === 0) controller.enqueue(new TextEncoder().encode(sse(['response.output_text.delta', { delta: '部分内容' }])))
        else controller.error(new Error('secret-read-error'))
      },
    })
    const result = decoded(await new Response(responsesSSEToChatStream(body, 'hint-model', { onFinish })).text())
    expect(result.content).toBe(partial ? '部分内容' : '')
    expectError(result, 'upstream_interrupted')
    expect(JSON.stringify(onFinish.mock.calls)).not.toContain('secret-read-error')
    expect(onFinish.mock.calls[0][0]).toMatchObject({ terminalEvent: 'transport.read_error', errorCode: 'upstream_interrupted' })
  })

  it.each(['response.completed', 'response.failed', 'error'])('%s 后取消上游 reader 并忽略后续帧', async event => {
    const terminal: Event = event === 'response.completed' ? completed() : event === 'error'
      ? ['error', { code: 'upstream_error', message: 'private-error' }]
      : ['response.failed', { response: { status: 'failed', error: { code: 'upstream_error' } } }]
    const upstream = source(sse(terminal) + sse(['response.output_text.delta', { delta: '不该发送' }]), false, true)
    const result = decoded(await new Response(responsesSSEToChatStream(upstream.body, 'hint-model')).text())
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('')
    expect(result.done).toBe(1)
    expect(result.finishes).toEqual(event === 'response.completed' ? ['stop'] : [])
  })

  it('客户端取消会 cancel reader，诊断 cancelled、不伪造 error/stop', async () => {
    const onFinish = vi.fn()
    const upstream = source(sse(['response.output_text.delta', { delta: '取消前正文' }]), false, true)
    const reader = responsesSSEToChatStream(upstream.body, 'hint-model', { onFinish }).getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled', terminalEvent: 'transport.cancel' })
    expect(JSON.stringify(onFinish.mock.calls)).not.toContain('取消前正文')
    expect((await reader.read()).done).toBe(true)
  })
})
