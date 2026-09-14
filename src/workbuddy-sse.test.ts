import { describe, it, expect } from 'vitest'
import {
  newWorkbuddyStreamState,
  processWorkbuddyFrame,
  normalizeWorkbuddyFrame,
  backfillToolCallNames,
  createWorkbuddyChunkCleaner,
  WORKBUDDY_SENTINEL_ID,
  isDegenerateReasoningWindow,
  WorkbuddyDegeneracyDetector,
  WORKBUDDY_DEFAULT_MAX_REASONING_CHARS,
} from './workbuddy-sse'

/**
 * WorkBuddy SSE 帧规范化重建测试
 * （移植 workbuddy2api internal/upstream/sse.go normalizeFrame / backfillToolCallNames / Stream）。
 */

/** 构造一个 chunk 帧的 helper。 */
function chunk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 123,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    ...over,
  }
}

describe('normalizeWorkbuddyFrame 白名单重建', () => {
  it('保留顶层白名单键', () => {
    const out = normalizeWorkbuddyFrame(chunk({ system_fingerprint: 'fp', service_tier: 'default' }))
    expect(out['id']).toBe('chatcmpl-1')
    expect(out['object']).toBe('chat.completion.chunk')
    expect(out['created']).toBe(123)
    expect(out['model']).toBe('deepseek-v4-flash')
    expect(out['system_fingerprint']).toBe('fp')
    expect(out['service_tier']).toBe('default')
  })

  it('剔除顶层未知字段', () => {
    const out = normalizeWorkbuddyFrame(chunk({ extra_field: 'noise', another: 1 }))
    expect(out['extra_field']).toBeUndefined()
    expect(out['another']).toBeUndefined()
  })

  it('object 缺失补 chat.completion.chunk；id 缺失补哨兵', () => {
    const out = normalizeWorkbuddyFrame({ choices: [] })
    expect(out['object']).toBe('chat.completion.chunk')
    expect(out['id']).toBe(WORKBUDDY_SENTINEL_ID)
  })

  it('usage 存在原样保留；缺失显式 null', () => {
    const withUsage = normalizeWorkbuddyFrame(chunk({ usage: { prompt_tokens: 1, credit: 0 } }))
    expect(withUsage['usage']).toEqual({ prompt_tokens: 1, credit: 0 })

    const withoutUsage = normalizeWorkbuddyFrame(chunk())
    expect(withoutUsage['usage']).toBeNull()
  })

  it('finish_reason 非空保留；空串 → null', () => {
    expect((normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))['choices'] as any[])[0].finish_reason).toBe('stop')
    expect((normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: {}, finish_reason: '' }] }))['choices'] as any[])[0].finish_reason).toBeNull()
    expect((normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: {} }] }))['choices'] as any[])[0].finish_reason).toBeNull()
  })

  it('delta 只保留非空字段（空 content/refusal/reasoning_content 省略）', () => {
    const out = normalizeWorkbuddyFrame(chunk({
      choices: [{ index: 0, delta: { content: '', refusal: '', reasoning_content: '', role: 'assistant' }, finish_reason: null }],
    }))
    const delta = (out['choices'] as any[])[0].delta
    expect(delta.role).toBe('assistant')
    expect('content' in delta).toBe(false)
    expect('refusal' in delta).toBe(false)
    expect('reasoning_content' in delta).toBe(false)
  })

  it('reasoning_content 非空保留（思维链透传）', () => {
    const out = normalizeWorkbuddyFrame(chunk({
      choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }],
    }))
    expect((out['choices'] as any[])[0].delta.reasoning_content).toBe('think')
  })

  it('空 tool_calls 数组省略；非空保留', () => {
    const empty = normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }))
    expect('tool_calls' in (empty['choices'] as any[])[0].delta).toBe(false)

    const one = normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1' }] }, finish_reason: null }] }))
    expect((one['choices'] as any[])[0].delta.tool_calls.length).toBe(1)
  })

  it('空占位 function_call（name/arguments 全空）剔除；非空保留', () => {
    const noise = normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: { function_call: { name: '', arguments: '' } }, finish_reason: null }] }))
    expect('function_call' in (noise['choices'] as any[])[0].delta).toBe(false)

    const real = normalizeWorkbuddyFrame(chunk({ choices: [{ index: 0, delta: { function_call: { name: 'f', arguments: '{}' } }, finish_reason: null }] }))
    expect((real['choices'] as any[])[0].delta.function_call.name).toBe('f')
  })

  it('choices 非数组 → 不输出 choices 键（但 usage 仍补齐）', () => {
    const out = normalizeWorkbuddyFrame({ id: 'x', choices: 'bad' })
    expect(out['choices']).toBeUndefined()
    expect(out['usage']).toBeNull()
  })

  it('choices 内非对象项被跳过', () => {
    const out = normalizeWorkbuddyFrame(chunk({ choices: [null, { index: 1, delta: {}, finish_reason: 'stop' }] }))
    expect((out['choices'] as any[]).length).toBe(1)
    expect((out['choices'] as any[])[0].index).toBe(1)
  })
})

describe('backfillToolCallNames 跨帧 name 回填', () => {
  it('首帧带 name → 缓存；后续帧缺 name → 回填', () => {
    const names = new Map<number, string>()
    const f1 = chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'get_weather', arguments: '{"c' } }] }, finish_reason: null }] })
    backfillToolCallNames(f1, names)
    expect(names.get(0)).toBe('get_weather')

    const f2 = chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ity":"sf"}' } }] }, finish_reason: null }] })
    backfillToolCallNames(f2, names)
    const fn = (f2['choices'] as any[])[0].delta.tool_calls[0].function
    expect(fn.name).toBe('get_weather')
    // arguments 不被改动
    expect(fn.arguments).toBe('ity":"sf"}')
  })

  it('后续帧 name 为空串 → 回填（上游常见置空形态）', () => {
    const names = new Map<number, string>()
    backfillToolCallNames(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'foo' } }] }, finish_reason: null }] }), names)
    const f2 = chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '', arguments: 'x' } }] }, finish_reason: null }] })
    backfillToolCallNames(f2, names)
    expect((f2['choices'] as any[])[0].delta.tool_calls[0].function.name).toBe('foo')
  })

  it('function 对象缺失 → 新建并回填 name', () => {
    const names = new Map<number, string>([[0, 'cached']])
    const f = chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }] }, finish_reason: null }] })
    backfillToolCallNames(f, names)
    expect((f['choices'] as any[])[0].delta.tool_calls[0].function.name).toBe('cached')
  })

  it('多个 index 各自独立缓存', () => {
    const names = new Map<number, string>()
    backfillToolCallNames(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'a' } }, { index: 1, function: { name: 'b' } }] }, finish_reason: null }] }), names)
    expect(names.get(0)).toBe('a')
    expect(names.get(1)).toBe('b')
  })

  it('后续帧改名 → 覆盖缓存（允许上游中途改名）', () => {
    const names = new Map<number, string>()
    backfillToolCallNames(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'old' } }] }, finish_reason: null }] }), names)
    backfillToolCallNames(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'new' } }] }, finish_reason: null }] }), names)
    expect(names.get(0)).toBe('new')
  })

  it('畸形输入不抛错', () => {
    const names = new Map<number, string>()
    expect(() => backfillToolCallNames({}, names)).not.toThrow()
    expect(() => backfillToolCallNames({ choices: 'bad' }, names)).not.toThrow()
    expect(() => backfillToolCallNames({ choices: [null, { delta: 'bad' }] }, names)).not.toThrow()
  })
})

describe('processWorkbuddyFrame（含首帧 id 续传）', () => {
  it('JSON 解析失败 → 原样返回且 valid=false', () => {
    const st = newWorkbuddyStreamState()
    const r = processWorkbuddyFrame('not json', st)
    expect(r.valid).toBe(false)
    expect(r.payload).toBe('not json')
  })

  it('首帧真实 id 被缓存；后续帧缺失 id → 续用首帧 id', () => {
    const st = newWorkbuddyStreamState()
    const r1 = processWorkbuddyFrame(JSON.stringify(chunk({ id: 'real-id-1' })), st)
    expect(JSON.parse(r1.payload)['id']).toBe('real-id-1')
    expect(st.firstId).toBe('real-id-1')

    const r2 = processWorkbuddyFrame(JSON.stringify(chunk({ id: undefined })), st)
    expect(JSON.parse(r2.payload)['id']).toBe('real-id-1')

    const r3 = processWorkbuddyFrame(JSON.stringify(chunk({ id: '' })), st)
    expect(JSON.parse(r3.payload)['id']).toBe('real-id-1')
  })

  it('后续帧有自己 id → 保持原样（不同流分裂的帧允许各自 id）', () => {
    const st = newWorkbuddyStreamState()
    processWorkbuddyFrame(JSON.stringify(chunk({ id: 'first' })), st)
    const r = processWorkbuddyFrame(JSON.stringify(chunk({ id: 'second' })), st)
    expect(JSON.parse(r.payload)['id']).toBe('second')
    // firstId 不被改写
    expect(st.firstId).toBe('first')
  })

  it('全流无真实 id → 哨兵兜底', () => {
    const st = newWorkbuddyStreamState()
    const r = processWorkbuddyFrame(JSON.stringify(chunk({ id: undefined })), st)
    expect(JSON.parse(r.payload)['id']).toBe(WORKBUDDY_SENTINEL_ID)
  })

  it('非对象 JSON（数组/标量）→ valid=false', () => {
    const st = newWorkbuddyStreamState()
    expect(processWorkbuddyFrame('[1,2]', st).valid).toBe(false)
    expect(processWorkbuddyFrame('123', st).valid).toBe(false)
    expect(processWorkbuddyFrame('null', st).valid).toBe(false)
  })
})

describe('createWorkbuddyChunkCleaner（有状态清洗器）', () => {
  it('非 data: 行 / 空行 / [DONE] 原样返回', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean('')).toBe('')
    expect(clean('   ')).toBe('   ')
    expect(clean(': comment')).toBe(': comment')
    expect(clean('data: [DONE]')).toBe('data: [DONE]')
  })

  it('有效帧被重建（白名单 + finish_reason null）', () => {
    const clean = createWorkbuddyChunkCleaner()
    const out = clean(`data: ${JSON.stringify(chunk({ extra: 'noise', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: '' }] }))}`)
    const obj = JSON.parse(out.slice(5).trim())
    expect(obj.extra).toBeUndefined()
    expect(obj.choices[0].finish_reason).toBeNull()
    expect(obj.usage).toBeNull()
  })

  it('跨帧 id 续传生效', () => {
    const clean = createWorkbuddyChunkCleaner()
    clean(`data: ${JSON.stringify(chunk({ id: 'keep-me' }))}`)
    const out = clean(`data: ${JSON.stringify(chunk({ id: undefined }))}`)
    expect(JSON.parse(out.slice(5).trim()).id).toBe('keep-me')
  })

  it('跨帧 tool_calls name 回填生效', () => {
    const clean = createWorkbuddyChunkCleaner()
    clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'my_tool' } }] }, finish_reason: null }] }))}`)
    const out = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] }))}`)
    expect(JSON.parse(out.slice(5).trim()).choices[0].delta.tool_calls[0].function.name).toBe('my_tool')
  })

  it('解析失败的行原样返回（不丢帧）', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean('data: {broken')).toBe('data: {broken')
  })

  it('噪声帧（choices 空且无 usage）被丢弃为空串', () => {
    const clean = createWorkbuddyChunkCleaner()
    const out = clean(`data: ${JSON.stringify(chunk({ choices: [] }))}`)
    expect(out).toBe('')
  })

  it('choices 空但有 usage → 保留（末帧 usage 不能丢）', () => {
    const clean = createWorkbuddyChunkCleaner()
    const out = clean(`data: ${JSON.stringify(chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, credit: 0 } }))}`)
    expect(out).not.toBe('')
    expect(JSON.parse(out.slice(5).trim()).usage.credit).toBe(0)
  })

  it('每次调用返回独立实例（跨请求不共享状态）', () => {
    const c1 = createWorkbuddyChunkCleaner()
    const c2 = createWorkbuddyChunkCleaner()
    c1(`data: ${JSON.stringify(chunk({ id: 'stream-A' }))}`)
    // c2 是独立流：无 firstId 缓存 → 自身帧缺失 id 时用哨兵，而非 stream-A
    const out = c2(`data: ${JSON.stringify(chunk({ id: undefined }))}`)
    expect(JSON.parse(out.slice(5).trim()).id).toBe(WORKBUDDY_SENTINEL_ID)
  })
})

describe('isDegenerateReasoningWindow & WorkbuddyDegeneracyDetector 推理退化死循环检测', () => {
  it('正常长推理思考与技术推导不会误判为退化', () => {
    const normalReasoning = `
Let me analyze the problem carefully.
First, we need to inspect the file structure and verify types.
In TypeScript, we have:
\`\`\`ts
interface Config {
  apiKey: string
  retryCount: number
}
\`\`\`
Now let's check the test suite:
1. Ensure all edge cases are covered.
2. Check boundary conditions.
3. Validate error mappings.
The function returns true on success.
`
    expect(isDegenerateReasoningWindow(normalReasoning)).toBe(false)
  })

  it('典型死循环模式（log4/log3 模式："Writing. \\n\\n Let me output. \\n\\n Go."）准确判定为退化窗口', () => {
    const phrases = ['Writing.', 'Let me output.', 'Go.', 'Now.', 'OK.']
    const loopLines: string[] = []
    for (let i = 0; i < 40; i++) {
      loopLines.push(phrases[i % phrases.length])
    }
    const loopText = loopLines.join('\n\n')
    expect(isDegenerateReasoningWindow(loopText)).toBe(true)
  })

  it('行数不足时（< 20 行）不触发窗口退化', () => {
    const shortLoop = ['Writing.', 'Go.', 'OK.'].join('\n\n')
    expect(isDegenerateReasoningWindow(shortLoop)).toBe(false)
  })

  it('独特行过多（> 10 种不同行）时不触发窗口退化', () => {
    const diverseLines: string[] = []
    for (let i = 0; i < 25; i++) {
      diverseLines.push(`Step ${i}: checking condition`)
    }
    expect(isDegenerateReasoningWindow(diverseLines.join('\n'))).toBe(false)
  })

  it('WorkbuddyDegeneracyDetector 连续流式输入死循环达到阈值时触发 isDegenerate', () => {
    const detector = new WorkbuddyDegeneracyDetector({
      windowChars: 400,
      stride: 100,
      minLines: 10,
      maxDistinct: 5,
      minRepeatRatio: 0.8,
      consecutiveTrips: 2,
    })

    const loopFragment = 'Writing.\n\nLet me output.\n\nGo.\n\nOK.\n\n'
    let triggered = false
    for (let i = 0; i < 25; i++) {
      if (detector.feedDelta(loopFragment)) {
        triggered = true
        break
      }
    }
    expect(triggered).toBe(true)
    expect(detector.isDegenerate).toBe(true)
    // 触发后再投喂依然保持 true
    expect(detector.feedDelta('more junk')).toBe(true)
  })
})

describe('WorkBuddy 流式推理退化抑制与预算熔断防护（createWorkbuddyChunkCleaner）', () => {
  it('正常思考帧与正文内容正常透传', () => {
    const clean = createWorkbuddyChunkCleaner()
    const r1 = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking step 1' }, finish_reason: null }] }))}`)
    const r2 = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'hello world' }, finish_reason: null }] }))}`)
    expect(JSON.parse(r1.slice(5).trim()).choices[0].delta.reasoning_content).toBe('thinking step 1')
    expect(JSON.parse(r2.slice(5).trim()).choices[0].delta.content).toBe('hello world')
  })

  it('超过 maxReasoningChars 预算后，抑制后续 reasoning_content 并标记 stopSignal', () => {
    const stopSignal = { aborted: false }
    let runawayReason = ''
    const clean = createWorkbuddyChunkCleaner({
      maxReasoningChars: 50,
      stopSignal,
      onRunaway: (reason) => {
        runawayReason = reason
      },
    })

    // 第一帧 30 字符（未超 50）
    const r1 = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: '123456789012345678901234567890' }, finish_reason: null }] }))}`)
    expect(r1).not.toBe('')
    expect(JSON.parse(r1.slice(5).trim()).choices[0].delta.reasoning_content).toBeDefined()
    expect(stopSignal.aborted).toBe(false)

    // 第二帧再来 30 字符（累计 60 字符，超预算）
    const r2 = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: '123456789012345678901234567890' }, finish_reason: null }] }))}`)
    expect(stopSignal.aborted).toBe(true)
    expect(runawayReason).toBe('budget_exhausted')
    // 触发抑制后，因为全程没有正文，cleaner 会合成 finish_reason: "length" 终止帧
    expect(r2).toContain('finish_reason')
    expect(r2).toContain('length')
    expect(r2).toContain('[DONE]')
  })

  it('严重死循环退化且全程无正文时，合成 finish_reason: "length" 并终止上游流', () => {
    const stopSignal = { aborted: false }
    let runawayReason = ''
    const clean = createWorkbuddyChunkCleaner({
      stopSignal,
      onRunaway: (reason) => {
        runawayReason = reason
      },
    })

    const loopText = 'Writing.\n\nLet me output.\n\nGo.\n\nNow.\n\nOK.\n\n'.repeat(15)
    // 模拟多次投喂大段重复行以触发连续退化
    let lastOut = ''
    for (let i = 0; i < 5; i++) {
      const out = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: loopText }, finish_reason: null }] }))}`)
      if (out) lastOut = out
      if (stopSignal.aborted) break
    }

    expect(stopSignal.aborted).toBe(true)
    expect(runawayReason).toBe('degenerate_loop')
    // 输出包含合成的完成帧和 [DONE]
    expect(lastOut).toContain('finish_reason')
    expect(lastOut).toContain('length')
    expect(lastOut).toContain('[DONE]')

    // 终态发出后，后续帧应被丢弃为空串
    const afterDone = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: 'more spam' }, finish_reason: null }] }))}`)
    expect(afterDone).toBe('')
  })
})

