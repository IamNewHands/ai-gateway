/**
 * web-sse.test.ts — TRAE Remote 事件流 → OpenAI SSE / chat.completion。
 *
 * 这层最容易出两类**静默**错误（不报错、只是内容不对）：
 *  1. **累积快照当增量转发** → 客户端看到 `a`+`ab`+`abc` 拼成 `aababc`；
 *  2. **丢掉 heartbeat** → 客户端误判本轮结束并重放上一次工具请求（源侧实测）。
 * 两者都不会抛异常，只能靠断言文本与帧序把它们钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateWebSse,
  allowedToolNames,
  callsFromRemotePayload,
  cliTextDelta,
  compactReasoningText,
  filterRemoteCalls,
  holdIncompleteToolBlock,
  mergePlanMessageText,
  payloadReasoningText,
  ProtocolTextAccumulator,
  remoteFinishReason,
  splitEmbeddedReasoning,
  stripReasoningNarration,
  stripToolCallBlocks,
  visibleText,
  webFinishSummary,
  webMessageText,
  webPlanContent,
  webPlanHasSplitReasoning,
  webPlanReasoning,
  webStreamToOpenAIStream,
  WEB_HEARTBEAT_LINE,
} from './web-sse'
import type { TraeRemoteEvent } from './types'

/** 把事件列表包成 async iterable（Remote 事件流的形态）。 */
async function* feed(list: TraeRemoteEvent[]): AsyncGenerator<TraeRemoteEvent> {
  for (const e of list) yield e
}

/** 造一个 Remote 事件。 */
function ev(event: string, data: Record<string, any> = {}): TraeRemoteEvent {
  return { event, data }
}

/** 读完整条 SSE 流，返回原始帧（已按空行切分）。 */
async function readSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += value
  }
  return out.split('\n\n').map((s) => s.trim()).filter(Boolean)
}

/** 帧 → 已解析的 chunk（丢弃 [DONE]）。 */
function parseFrames(frames: string[]): any[] {
  return frames
    .map((f) => (f.startsWith('data:') ? f.slice(5).trim() : f))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d))
}

/** 抽出全部 content 增量并拼接（验证「不重复、不丢字」）。 */
function concatContent(chunks: any[]): string {
  return chunks.map((c) => c?.choices?.[0]?.delta?.content ?? '').join('')
}

// ===== 纯函数 =====

describe('cliTextDelta：快照 → 增量', () => {
  it('当前以旧串开头 → 多出来的尾巴', () => {
    expect(cliTextDelta('ab', 'abc')).toBe('c')
    expect(cliTextDelta('', 'abc')).toBe('abc')
  })

  it('旧串以当前开头 → 收到过期快照，不发（发出去等于回退）', () => {
    expect(cliTextDelta('abc', 'ab')).toBe('')
  })

  it('两者都不包含 → 按公共前缀切', () => {
    expect(cliTextDelta('abc', 'abd')).toBe('d')
    expect(cliTextDelta('hello', 'help')).toBe('p')
  })

  it('空 current → 空', () => {
    expect(cliTextDelta('abc', '')).toBe('')
  })
})

describe('mergePlanMessageText：plan 与 message 不重放', () => {
  it('一方为空 → 返回另一方', () => {
    expect(mergePlanMessageText('', 'm')).toBe('m')
    expect(mergePlanMessageText('p', '')).toBe('p')
  })

  it('plan 已包含 message → 只用 plan（不重复）', () => {
    expect(mergePlanMessageText('hello world', 'world')).toBe('hello world')
    expect(mergePlanMessageText('hello', 'hello')).toBe('hello')
  })

  it('message 包含 plan → 用 message（更完整）', () => {
    expect(mergePlanMessageText('hel', 'hello')).toBe('hello')
  })

  it('后缀/前缀重叠 ≥4 字符 → 接上不重复的部分', () => {
    expect(mergePlanMessageText('hello worl', 'world')).toBe('hello world')
  })

  it('重叠不足 4 字符 → 不合并，改用空行拼接（避免把巧合重叠当续写）', () => {
    expect(mergePlanMessageText('hello wor', 'world')).toBe('hello wor\n\nworld')
  })

  it('无重叠 → 空行拼接', () => {
    expect(mergePlanMessageText('aaa', 'bbb')).toBe('aaa\n\nbbb')
  })
})

describe('工具块处理：未闭合要扣住，已闭合才剥掉', () => {
  it('stripToolCallBlocks 剥掉已闭合块', () => {
    expect(stripToolCallBlocks('前<tool_call>{"a":1}</tool_call>后')).toBe('前后')
  })

  it('未闭合块**不**被剥（避免把正文当协议删掉）', () => {
    expect(stripToolCallBlocks('前<tool_call>{"a":1}')).toBe('前<tool_call>{"a":1}')
  })

  it('holdIncompleteToolBlock 从块起点扣住（流式不能让半截协议上线）', () => {
    expect(holdIncompleteToolBlock('答案<tool_call>{"a"')).toBe('答案')
  })

  it('holdIncompleteToolBlock 扣住切在半截标记上的尾巴', () => {
    expect(holdIncompleteToolBlock('答案<tool_ca')).toBe('答案')
  })

  it('holdIncompleteToolBlock 扣住尾部反斜杠串（转义等待帧）', () => {
    expect(holdIncompleteToolBlock('答案\\\\')).toBe('答案')
  })

  it('无协议标记 → 原样', () => {
    expect(holdIncompleteToolBlock('普通答案')).toBe('普通答案')
  })

  it('visibleText 只接受字符串', () => {
    expect(visibleText('x')).toBe('x')
    expect(visibleText(null)).toBe('')
    expect(visibleText(123)).toBe('')
  })
})

describe('splitEmbeddedReasoning：内嵌 <think> 块', () => {
  it('拆出思考并保留可见正文', () => {
    expect(splitEmbeddedReasoning('a<think>B</think>c')).toEqual(['B', 'ac'])
  })

  it('支持 <thinking> 与大小写', () => {
    expect(splitEmbeddedReasoning('<THINKING>x</THINKING>y')).toEqual(['x', 'y'])
  })

  it('无块 → 原文进 visible', () => {
    expect(splitEmbeddedReasoning('plain')).toEqual(['', 'plain'])
  })

  it('非字符串 → 双空', () => {
    expect(splitEmbeddedReasoning(null)).toEqual(['', ''])
  })
})

describe('stripReasoningNarration：丢掉开头的元叙述', () => {
  it('删掉「The user wants…」这类开头，保留后面的答案', () => {
    expect(stripReasoningNarration('The user wants a ping. pong')).toBe('pong')
  })

  it('删掉「Let me…」开头', () => {
    expect(stripReasoningNarration("Let me check. answer")).toBe('answer')
  })

  it('holdIncomplete：停在叙述词前缀上 → 返回空（让调用方扣住不发）', () => {
    expect(stripReasoningNarration('The', true)).toBe('')
    expect(stripReasoningNarration('Let me', true)).toBe('')
    expect(stripReasoningNarration('I need', true)).toBe('')
  })

  it('holdIncomplete：已越过叙述词前缀的中间态按原文返回（源侧正则的已知边界，忠实移植）', () => {
    // 源侧 `_NARRATION_PREFIX_RE` 的 `t` 分支只覆盖到 `the user('s)` 为止，
    // 后面还能接什么它没建模 —— 故 `The user wa` 不在其内，不扣住。
    // 这里保持与源侧一致，**不**自作主张扩大匹配范围（扩大可能误扣正常答案的开头）。
    expect(stripReasoningNarration('The user wa', true)).toBe('The user wa')
  })

  it('holdIncomplete：整段只有叙述 → 返回空', () => {
    expect(stripReasoningNarration('The user wants a ping.', true)).toBe('')
  })

  it('普通答案不受影响（没有叙述前缀）', () => {
    expect(stripReasoningNarration('TCP is slower.')).toBe('TCP is slower.')
  })
})

describe('compactReasoningText：有界抽取式摘要', () => {
  it('超长输入被压到上限内', () => {
    const long = Array.from({ length: 50 }, (_, i) => `步骤${i}完成。`).join('')
    const out = compactReasoningText(long, 120, 4)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.split('\n').length).toBeLessThanOrEqual(4)
  })

  it('空 / 非法 → 空串', () => {
    expect(compactReasoningText('')).toBe('')
    expect(compactReasoningText(null)).toBe('')
  })

  it('去重相同的句子（切分符是中日文句读/换行，ASCII 句点不算）', () => {
    const out = compactReasoningText('same line。same line。same line。', 800, 6)
    // 三句完全相同 → 去重后只剩一行（句读符是否留在节点里不影响这条判定）
    expect(out.split('\n').filter(Boolean)).toHaveLength(1)
    expect(out).toContain('same line')
  })

  it('保留结论类节点（优先级）', () => {
    const text = Array.from({ length: 12 }, (_, i) => `普通步骤${i}。`).join('') + '结论：就这样。'
    const out = compactReasoningText(text, 800, 3)
    expect(out).toContain('结论')
  })
})

describe('Remote payload 提取', () => {
  it('payloadReasoningText 认 reasoning_content / thought / thinking', () => {
    expect(payloadReasoningText({ reasoning_content: 'a' })).toBe('a')
    expect(payloadReasoningText({ thought: 'b' })).toBe('b')
    expect(payloadReasoningText({ thinking: { content: 'c' } })).toBe('c')
  })

  it('payloadReasoningText 从嵌套 message 的 reasoning 块取', () => {
    expect(payloadReasoningText({ message: { content: [{ type: 'reasoning', text: 'r' }] } })).toBe('r')
  })

  it('webPlanHasSplitReasoning：有 reasoning_content 键即分离式', () => {
    expect(webPlanHasSplitReasoning({ reasoning_content: '' })).toBe(true)
    expect(webPlanHasSplitReasoning({ reasoningContent: 'x' })).toBe(true)
    expect(webPlanHasSplitReasoning({ thought: 'x' })).toBe(false)
  })

  it('分离式布局：thought 是**答案**，reasoning_content 是思考', () => {
    expect(webPlanReasoning({ thought: 'pong', reasoning_content: '' })).toBe('')
    expect(webPlanContent({ thought: 'pong', reasoning_content: '' })).toBe('pong')
  })

  it('旧式布局：thought 是思考，不当作答案', () => {
    expect(webPlanReasoning({ thought: 'I am thinking' })).toBe('I am thinking')
    expect(webPlanContent({ thought: 'I am thinking' })).toBe('')
  })

  it('webMessageText 认 content 字符串 / 数组 / text / response', () => {
    expect(webMessageText({ content: 'a' })).toBe('a')
    expect(webMessageText({ content: [{ type: 'text', text: 'b' }] })).toBe('b')
    expect(webMessageText({ text: 'c' })).toBe('c')
    expect(webMessageText({ response: 'd' })).toBe('d')
  })

  it('webMessageText 跳过 content 数组里的 reasoning 块', () => {
    expect(webMessageText({ content: [{ type: 'text', text: 'A' }, { type: 'reasoning', text: 'R' }] })).toBe('A')
  })

  it('webFinishSummary 只在 tool_call_info.name === finish 时取 summary', () => {
    expect(webFinishSummary({ tool_call_info: { name: 'finish', params: { summary: 'S' } } })).toBe('S')
    expect(webFinishSummary({ tool_call_info: { name: 'read', params: { summary: 'S' } } })).toBe('')
  })
})

describe('callsFromRemotePayload：工具调用提取', () => {
  it('认 OpenAI 形 tool_calls', () => {
    const calls = callsFromRemotePayload({
      tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":"x"}' } }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('read')
    expect(calls[0].function.arguments).toBe('{"p":"x"}')
  })

  it('认 Trae 形 tool_call_info（params → arguments）', () => {
    const calls = callsFromRemotePayload({ id: 'm1', tool_call_info: { name: 'grep', params: { q: 'x' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('grep')
    expect(calls[0].function.arguments).toBe('{"q":"x"}')
  })

  it('finish **不是**调用方工具，不进 tool_calls', () => {
    expect(callsFromRemotePayload({ tool_call_info: { name: 'finish', params: { summary: 'S' } } })).toHaveLength(0)
  })

  it('无调用 → 空数组', () => {
    expect(callsFromRemotePayload({ content: 'hi' })).toEqual([])
    expect(callsFromRemotePayload(null)).toEqual([])
  })
})

describe('工具过滤：区分「未声明」与「显式禁用」', () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]

  it('allowedToolNames：undefined = 未声明，空集 = 显式禁用', () => {
    expect(allowedToolNames(undefined)).toBeUndefined()
    expect(allowedToolNames(null)).toBeUndefined()
    expect(allowedToolNames([])).toEqual(new Set())
    expect(allowedToolNames([{ function: { name: 'read' } }])).toEqual(new Set(['read']))
  })

  it('未声明 tools → 保留（否则普通聊天会丢掉上游返回的调用）', () => {
    expect(filterRemoteCalls(calls, undefined, undefined)).toHaveLength(1)
  })

  it('显式禁用（空集）→ 全部丢弃', () => {
    expect(filterRemoteCalls(calls, new Set(), undefined)).toHaveLength(0)
  })

  it('不在声明集合里的调用 → 丢弃（挡上游幻觉调用）', () => {
    expect(filterRemoteCalls(calls, new Set(['grep']), undefined)).toHaveLength(0)
    expect(filterRemoteCalls(calls, new Set(['read']), undefined)).toHaveLength(1)
  })

  it('tool_choice=none → 全部丢弃', () => {
    expect(filterRemoteCalls(calls, new Set(['read']), 'none')).toHaveLength(0)
  })

  it('tool_choice 指定具名 → 只保留该名', () => {
    const two = [...calls, { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } }]
    expect(filterRemoteCalls(two, new Set(['read', 'grep']), 'grep')).toHaveLength(1)
  })
})

describe('remoteFinishReason', () => {
  it('有工具调用 → tool_calls', () => {
    expect(remoteFinishReason('stop', true)).toBe('tool_calls')
  })
  it('length / max_tokens → length', () => {
    expect(remoteFinishReason('length', false)).toBe('length')
    expect(remoteFinishReason('max_tokens', false)).toBe('length')
  })
  it('其余 → stop', () => {
    expect(remoteFinishReason('', false)).toBe('stop')
    expect(remoteFinishReason('whatever', false)).toBe('stop')
  })
})

describe('ProtocolTextAccumulator', () => {
  it('add：累积快照 → 只吐增量', () => {
    const acc = new ProtocolTextAccumulator()
    expect(acc.add('a')[0]).toBe('a')
    expect(acc.add('ab')[0]).toBe('b')
    expect(acc.add('abc')[0]).toBe('c')
    expect(acc.add('abc')[0]).toBe('')
  })

  it('addSnapshot：迟到的旧快照被忽略（不回退）', () => {
    const acc = new ProtocolTextAccumulator()
    acc.addSnapshot('abcdef')
    expect(acc.addSnapshot('abc')[0]).toBe('')
    expect(acc.addSnapshot('abcdefgh')[0]).toBe('gh')
  })

  it('addDelta：直接追加', () => {
    const acc = new ProtocolTextAccumulator()
    expect(acc.addDelta('a')[0]).toBe('a')
    expect(acc.addDelta('b')[0]).toBe('b')
    expect(acc.raw).toBe('ab')
  })

  it('未闭合工具块被扣住，闭合后 release（finalize）', () => {
    const acc = new ProtocolTextAccumulator()
    expect(acc.add('答案<tool_call>{"a"')[0]).toBe('答案')
    // 仍然没有闭合 → finalize 释放被扣住的尾巴（此处是半截协议，可见文本仍是「答案」）
    expect(acc.finalize()[0]).toBe('')
  })
})

// ===== 流式翻译 =====

describe('webStreamToOpenAIStream：事件 → SSE', () => {
  it('**heartbeat 必须透传**（丢掉会让客户端误判本轮结束并重放工具请求）', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([ev('heartbeat'), ev('plan_item', { id: 'p1', content: 'hi' }), ev('done', {})]),
      'm'
    ))
    expect(frames).toContain(WEB_HEARTBEAT_LINE.trim())
  })

  it('累积快照 → 增量（不得拼成 aababc）', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'a' }),
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'ab' }),
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'abc' }),
        ev('done', {}),
      ]),
      'm'
    ))
    const chunks = parseFrames(frames)
    expect(concatContent(chunks)).toBe('abc')
  })

  it('首帧带 role=assistant，末帧带 finish_reason=stop，并以 [DONE] 收尾', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([ev('plan_item', { id: 'p1', content: 'hi' }), ev('done', {})]),
      'm'
    ))
    const chunks = parseFrames(frames)
    expect(chunks[0].choices[0].delta.role).toBe('assistant')
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop')
    expect(frames[frames.length - 1]).toBe('data: [DONE]')
  })

  it('plan 与 message 承载同一段回答 → 不重复', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'hello' }),
        ev('message', { content: 'hello' }),
        ev('done', {}),
      ]),
      'm'
    ))
    expect(concatContent(parseFrames(frames))).toBe('hello')
  })

  it('message 补上 plan 缺的尾巴', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'hello wor' }),
        ev('message', { content: 'hello world' }),
        ev('done', {}),
      ]),
      'm'
    ))
    expect(concatContent(parseFrames(frames))).toBe('hello world')
  })

  it('**没有 done → finish_reason=length + x_trae_truncated**（半句话不得伪装成完整回答）', async () => {
    const seen: string[] = []
    const frames = await readSse(webStreamToOpenAIStream(
      feed([ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'partial' })]),
      'm',
      { onTruncated: (info) => seen.push(info.kind) }
    ))
    const chunks = parseFrames(frames)
    expect(seen).toEqual(['no_done'])
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('length')
    expect(chunks[chunks.length - 1].x_trae_truncated).toBe('no_done')
  })

  it('token_usage 进入 chunk.usage', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', content: 'hi' }),
        ev('token_usage', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
        ev('done', {}),
      ]),
      'm'
    ))
    const usage = parseFrames(frames).map((c) => c.usage).find(Boolean)
    expect(usage.total_tokens).toBe(7)
  })

  it('error 事件 → 注入 error 帧 + onErr 回调', async () => {
    const seen: Array<[number, string]> = []
    const frames = await readSse(webStreamToOpenAIStream(
      feed([ev('plan_item', { id: 'p1', content: 'x' }), ev('error', { code: 4008, message: 'quota' })]),
      'm',
      { onErr: (se) => seen.push([se.code, se.msg]) }
    ))
    expect(seen).toEqual([[4008, 'quota']])
    const withError = parseFrames(frames).find((c) => c.error)
    expect(withError.error.message).toContain('4008')
  })

  it('工具调用 → tool_calls 增量 + finish_reason=tool_calls', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', tool_call_info: { name: 'read', params: { p: 'x' } } }),
        ev('done', {}),
      ]),
      'm',
      { allowedTools: [{ function: { name: 'read' } }] }
    ))
    const chunks = parseFrames(frames)
    const toolDelta = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])
    expect(toolDelta.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls')
  })

  it('上游幻觉调用（不在声明集合）被丢弃', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', tool_call_info: { name: 'evil', params: {} } }),
        ev('done', {}),
      ]),
      'm',
      { allowedTools: [{ function: { name: 'read' } }] }
    ))
    const chunks = parseFrames(frames)
    const toolDelta = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])
    expect(toolDelta).toHaveLength(0)
  })

  it('分离式布局只有思考、没有答案 → 思考走 reasoning_content 专用通道，不当正文', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '我在想一件事。' }),
        ev('done', {}),
      ]),
      'm'
    ))
    const chunks = parseFrames(frames)
    const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join('')
    expect(reasoning).toContain('我在想')
    // 正文里不能出现思考内容
    expect(concatContent(chunks)).not.toContain('我在想')
  })

  it('旧式布局（无 reasoning_content）→ thought 作为正文回退（该布局下它承载答案）', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: 'pong' }),
        ev('done', {}),
      ]),
      'm'
    ))
    expect(concatContent(parseFrames(frames))).toContain('pong')
  })

  it('includeReasoning 开启 → 思考进 reasoning_content', async () => {
    const frames = await readSse(webStreamToOpenAIStream(
      feed([
        ev('plan_item', { id: 'p1', thought: '', reasoning_content: '思考过程', content: '答案' }),
        ev('done', {}),
      ]),
      'm',
      { includeReasoning: true }
    ))
    const chunks = parseFrames(frames)
    expect(chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join('')).toContain('思考过程')
    expect(concatContent(chunks)).toBe('答案')
  })

  it('全程无内容 → 明确回退文案，而不是空响应', async () => {
    const frames = await readSse(webStreamToOpenAIStream(feed([ev('done', {})]), 'm'))
    expect(concatContent(parseFrames(frames))).toContain('empty response')
  })
})

// ===== 非流式聚合 =====

describe('aggregateWebSse：事件 → chat.completion', () => {
  it('基本聚合：content + finish_reason=stop + usage', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'hello' }),
      ev('token_usage', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
      ev('done', {}),
    ]), 'm')
    expect(r.err).toBeNull()
    expect(r.truncated).toBeNull()
    expect(r.resp!.choices[0].message.content).toBe('hello')
    expect(r.resp!.choices[0].finish_reason).toBe('stop')
    expect(r.resp!.usage.total_tokens).toBe(4)
  })

  it('**没有 done → truncated，且不返回半句话**（resp 为 null）', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', thought: '', reasoning_content: '', content: 'partial' }),
    ]), 'm')
    expect(r.resp).toBeNull()
    expect(r.truncated?.kind).toBe('no_done')
  })

  it('error 事件 → err 通道', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', content: 'x' }),
      ev('error', { code: 1005, message: 'plan limit' }),
    ]), 'm')
    expect(r.err).toEqual({ code: 1005, msg: 'plan limit' })
  })

  it('工具调用进入 message.tool_calls 且 finish_reason=tool_calls', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', tool_call_info: { name: 'read', params: { p: 'x' } } }),
      ev('done', {}),
    ]), 'm', { allowedTools: [{ function: { name: 'read' } }] })
    expect(r.resp!.choices[0].message.tool_calls).toHaveLength(1)
    expect(r.resp!.choices[0].finish_reason).toBe('tool_calls')
  })

  it('分离式布局只有思考 → 思考进 reasoning_content，不进 content', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', thought: '', reasoning_content: '工作轨迹' }),
      ev('done', {}),
    ]), 'm')
    expect(r.resp!.choices[0].message.reasoning_content).toContain('工作轨迹')
    expect(r.resp!.choices[0].message.content ?? '').not.toContain('工作轨迹')
  })

  it('includeReasoning 开启时思考同时进 reasoning_content', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', thought: '', reasoning_content: '思考', content: '答案' }),
      ev('done', {}),
    ]), 'm', { includeReasoning: true })
    expect(r.resp!.choices[0].message.content).toBe('答案')
    expect(r.resp!.choices[0].message.reasoning_content).toContain('思考')
  })

  it('finish 摘要作为唯一答案时补进 content', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', tool_call_info: { name: 'finish', params: { summary: '最终答案' } } }),
      ev('done', {}),
    ]), 'm')
    expect(r.resp!.choices[0].message.content).toContain('最终答案')
  })

  it('无 usage → 兜底估算，不编造精确值', async () => {
    const r = await aggregateWebSse(feed([
      ev('plan_item', { id: 'p1', content: 'hello' }),
      ev('done', {}),
    ]), 'm')
    expect(r.resp!.usage.prompt_tokens).toBe(0)
    expect(r.resp!.usage.completion_tokens).toBeGreaterThan(0)
  })

  it('全程无内容 → 明确回退文案', async () => {
    const r = await aggregateWebSse(feed([ev('done', {})]), 'm')
    expect(r.resp!.choices[0].message.content).toContain('empty response')
  })
})
