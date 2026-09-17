import { describe, it, expect } from 'vitest'
import {
  newWorkbuddyStreamState,
  processWorkbuddyFrame,
  normalizeWorkbuddyFrame,
  backfillToolCallNames,
  createWorkbuddyChunkCleaner,
  sanitizeWorkbuddyErrorFrame,
  buildWorkbuddyGatewayHint,
  attachWorkbuddyGatewayHint,
  WORKBUDDY_SENTINEL_ID,
  WORKBUDDY_EMPTY_STREAM_FRAME,
  WORKBUDDY_HINT_MODEL_RATE,
  WORKBUDDY_HINT_PROMPT_TOO_LONG,
  WORKBUDDY_HINT_MODEL_BLOCKED,
  WORKBUDDY_HINT_MODEL_PARAM_NEUTRAL,
  WORKBUDDY_HINT_INVALID_IMAGE,
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
  it('非 data: 行 / 空行原样返回；[DONE] 见下（0 有效帧时会被扣留）', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean('')).toBe('')
    expect(clean('   ')).toBe('   ')
    expect(clean(': comment')).toBe(': comment')
    // 出现过有效帧后 [DONE] 原样透传（既有语义不变）
    clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }))}`)
    expect(clean('data: [DONE]')).toBe('data: [DONE]')
  })

  it('空流兜底：0 有效帧时 [DONE] 被扣留，finishStream 补 error 帧 + [DONE]（移植 0a86854）', () => {
    const clean = createWorkbuddyChunkCleaner()
    // 上游「200 + 只有 [DONE]」：此前原样透传 → 客户端当正常收尾（假成功）
    expect(clean('data: [DONE]')).toBe('')
    expect(clean.frameStats()).toEqual({ validFrames: 0, terminated: false, doneWithheld: true })
    // 流结束：补 error 帧（code=upstream_parse，与非流式空流 → 502 同 code）+ [DONE]
    const tail = clean.finishStream()
    expect(tail).toBe(`data: ${WORKBUDDY_EMPTY_STREAM_FRAME}\n\ndata: [DONE]`)
    expect(JSON.parse(tail.slice(5, tail.indexOf('\n\n'))).error.code).toBe('upstream_parse')
    // 幂等：重复收尾不再补帧
    expect(clean.finishStream()).toBe('')
  })

  it('空流兜底：只有注释行/完全空体也要补帧', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean(': keep-alive')).toBe(': keep-alive')
    expect(clean.finishStream()).toContain('empty upstream stream')
  })

  it('正常流不补帧：有有效帧时 finishStream 返回空串', () => {
    const clean = createWorkbuddyChunkCleaner()
    clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }))}`)
    expect(clean('data: [DONE]')).toBe('data: [DONE]')
    expect(clean.frameStats().validFrames).toBe(1)
    expect(clean.finishStream()).toBe('')
  })

  it('上游错误帧计入有效帧：错误流不再被当成空流补帧（错误信息不被劫持）', () => {
    const clean = createWorkbuddyChunkCleaner()
    const errFrame = 'data: {"error":{"code":6004,"message":"rate limited"}}'
    expect(clean(errFrame)).toContain('6004')
    expect(clean('data: [DONE]')).toBe('data: [DONE]')
    expect(clean.finishStream()).toBe('')
    expect(clean.frameStats().validFrames).toBe(1)
  })

  it('解析失败的行不计有效帧（口径同源实现 writeFrame）：仅坏帧的流仍触发空流兜底', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean('data: {broken')).toBe('data: {broken')
    expect(clean.frameStats().validFrames).toBe(0)
    expect(clean.finishStream()).toContain('empty upstream stream')
  })

  it('畸形流：有效帧出现在 [DONE] 之后 → 补一个收尾 [DONE]（恰好一个）', () => {
    const clean = createWorkbuddyChunkCleaner()
    expect(clean('data: [DONE]')).toBe('')
    clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'late' }, finish_reason: null }] }))}`)
    expect(clean.frameStats().validFrames).toBe(1)
    expect(clean.finishStream()).toBe('data: [DONE]')
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

    // 预算熔断合成帧同样应带 usage 与标记（标记为 budget_exhausted）。
    const termData = r2.split('\n\n')[0].slice(5).trim()
    const term = JSON.parse(termData)
    expect(term.usage).toBeDefined()
    expect(term.x_workbuddy_runaway).toBe('budget_exhausted')
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

    // 护盾合成终态帧应携带估算 usage 与退化标记，而非全 0 计费/无标记。
    const termData = lastOut.split('\n\n')[0].slice(5).trim()
    const term = JSON.parse(termData)
    expect(term.usage).toBeDefined()
    expect(term.usage.total_tokens).toBeGreaterThan(0)
    expect(term.x_workbuddy_runaway).toBe('degenerate_loop')

    // 终态发出后，后续帧应被丢弃为空串
    const afterDone = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: 'more spam' }, finish_reason: null }] }))}`)
    expect(afterDone).toBe('')
  })
})

/**
 * 上游 error 帧透传（移植 workbuddy2api 5755fe3 sse.go writeRaw / error-passthrough）。
 *
 * 背景缺陷：`normalizeWorkbuddyFrame` 只保留 FRAME_TOP_KEYS 白名单，`error` 不在其中，
 * 于是上游错误帧被整帧销毁成一个语义为空的 chunk —— 客户端既拿不到错误也拿不到内容。
 * 且因 `choices` 不存在，噪声判定还会放行该空帧，畸形帧照样下发。
 */
describe('上游 error 帧透传（error-passthrough）', () => {
  /** 典型上游错误帧：6004 模型级限流。 */
  const rateLimitFrame = {
    error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-abc' },
  }

  it('normalizeWorkbuddyFrame 会剥掉 error（这就是必须绕过白名单的原因）', () => {
    const out = normalizeWorkbuddyFrame(rateLimitFrame as unknown as Record<string, unknown>)
    expect(out['error']).toBeUndefined()
    // 且产物是个语义为空的 chunk——正是缺陷现场
    expect(out['object']).toBe('chat.completion.chunk')
    expect(out['choices']).toBeUndefined()
  })

  it('processWorkbuddyFrame 对 error 帧原样透传，code/msg/requestId 全部保留', () => {
    const st = newWorkbuddyStreamState()
    const r = processWorkbuddyFrame(JSON.stringify(rateLimitFrame), st)
    expect(r.valid).toBe(true)
    expect(r.isError).toBe(true)
    const out = JSON.parse(r.payload)
    expect(out.error.code).toBe(6004)
    expect(out.error.msg).toBe('The model provider is rate-limiting requests.')
    expect(out.error.requestId).toBe('req-abc')
    // 不再被塞进 chat.completion.chunk 空壳
    expect(out.object).toBeUndefined()
  })

  it('错误帧计入有效帧：cleaner 不把它当噪声丢弃', () => {
    const clean = createWorkbuddyChunkCleaner()
    const out = clean(`data: ${JSON.stringify(rateLimitFrame)}`)
    expect(out).not.toBe('')
    expect(out.startsWith('data: ')).toBe(true)
    expect(JSON.parse(out.slice(5).trim()).error.code).toBe(6004)
  })

  it('错误帧后仍能继续处理后续正常帧（首帧 id 续传不受影响）', () => {
    const clean = createWorkbuddyChunkCleaner()
    const errOut = clean(`data: ${JSON.stringify(rateLimitFrame)}`)
    expect(JSON.parse(errOut.slice(5).trim()).error).toBeDefined()
    // 正常帧依旧走白名单重建
    const okOut = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }))}`)
    expect(JSON.parse(okOut.slice(5).trim()).choices[0].delta.content).toBe('hi')
  })

  it('嵌套形态 error.data.code 也被提取并保留结构', () => {
    const nested = { error: { data: { code: 11128, msg: 'blocked by security policy 色情' } } }
    const st = newWorkbuddyStreamState()
    const r = processWorkbuddyFrame(JSON.stringify(nested), st)
    expect(r.isError).toBe(true)
    expect(r.error!.code).toBe(11128)
    const out = JSON.parse(r.payload)
    expect(out.error.data.msg).toContain('blocked by security policy')
  })

  it('脱敏钩子只作用于字符串叶子：code/requestId 类型与值不变，文案被改写', () => {
    const st = newWorkbuddyStreamState({ sanitizeErrorText: (t) => t.replace(/sk-[A-Za-z0-9]+/g, '***') })
    const r = processWorkbuddyFrame(
      JSON.stringify({ error: { code: 6004, msg: 'auth failed for sk-secret123', requestId: 'req-1' } }),
      st,
    )
    const out = JSON.parse(r.payload)
    // 字符串叶子被脱敏
    expect(out.error.msg).toBe('auth failed for ***')
    // 非字符串叶子（数字 code / 字符串 requestId）保持原值——客户端要靠它判定错误类型
    expect(out.error.code).toBe(6004)
    expect(out.error.requestId).toBe('req-1')
  })

  it('未注入钩子时是恒等变换（原样透传）', () => {
    const st = newWorkbuddyStreamState()
    const r = processWorkbuddyFrame(JSON.stringify(rateLimitFrame), st)
    expect(JSON.parse(r.payload).error.msg).toBe('The model provider is rate-limiting requests.')
  })

  it('state.lastError 记录最后一个错误帧（供聚合路径转非流式错误体）', () => {
    const st = newWorkbuddyStreamState()
    expect(st.lastError).toBeUndefined()
    processWorkbuddyFrame(JSON.stringify(rateLimitFrame), st)
    expect(st.lastError!.code).toBe(6004)
    expect(st.lastError!.message).toBe('The model provider is rate-limiting requests.')
    expect(st.lastError!.requestId).toBe('req-abc')
  })

  it('合成终态帧发出后，后续错误帧不再追加（避免 [DONE] 之后还有帧）', () => {
    const stopSignal = { aborted: false }
    const clean = createWorkbuddyChunkCleaner({ stopSignal, maxReasoningChars: 10 })
    // 先触发预算熔断 → 合成终态（含 [DONE]）
    clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { reasoning_content: '123456789012345' }, finish_reason: null }] }))}`)
    expect(stopSignal.aborted).toBe(true)
    // 终态之后的错误帧被丢弃
    expect(clean(`data: ${JSON.stringify(rateLimitFrame)}`)).toBe('')
  })

  it('sanitizeWorkbuddyErrorFrame 对非错误帧/异常形态不抛错', () => {
    expect(() => sanitizeWorkbuddyErrorFrame({})).not.toThrow()
    expect(() => sanitizeWorkbuddyErrorFrame({ error: null })).not.toThrow()
    expect(() => sanitizeWorkbuddyErrorFrame({ error: 'plain string error' })).not.toThrow()
    // 字符串形态 error：文案可提取
    const e = sanitizeWorkbuddyErrorFrame({ error: 'boom' })
    expect(e.message).toBe('boom')
    expect(JSON.parse(e.raw).error).toBe('boom')
  })

  it('顶层 code/requestId 形态也能提取（非 error 信封包裹）', () => {
    const e = sanitizeWorkbuddyErrorFrame({ error: { msg: 'x' }, code: 11102, requestId: 'req-top' })
    expect(e.code).toBe(11102)
    expect(e.requestId).toBe('req-top')
  })

  it('sanitize 钩子抛错时不致命（保持可用性）', () => {
    // 钩子内部异常应由调用方保证不抛；此处验证常规钩子路径稳定
    const st = newWorkbuddyStreamState({ sanitizeErrorText: (t) => t })
    const r = processWorkbuddyFrame(JSON.stringify(rateLimitFrame), st)
    expect(r.isError).toBe(true)
  })
})

/**
 * P1-1（移植 5c2db2f）/ P1-4（移植 11b75d4 + 6701631）流式侧单元测试。
 *
 * 流式路径逐帧透传（客户端自己聚合），故网关的职责是：把非 delta 的完整 message
 * 提升成 delta（否则白名单会整帧丢弃正文），并把缺 index 的 tool_call 分派好 index
 * 后写回帧（否则客户端把不同调用并进同一槽）。
 */
describe('WorkBuddy 流式：message 提升与缺 index 分派（P1-1/P1-4）', () => {
  it('非 delta message 帧：正文/推理/工具调用都被提升成 delta 下发（此前整帧丢正文）', () => {
    const st = newWorkbuddyStreamState()
    const frame = {
      id: 'x1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'abc',
          reasoning_content: 'think',
          tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
        },
      }],
    }
    const r = processWorkbuddyFrame(JSON.stringify(frame), st)
    expect(r.valid).toBe(true)
    const out = JSON.parse(r.payload)
    expect(out.choices[0].delta.content).toBe('abc')
    expect(out.choices[0].delta.reasoning_content).toBe('think')
    expect(out.choices[0].delta.role).toBe('assistant')
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe('get_weather')
  })

  it('重复的完整 message 快照不重复下发正文（此前会得到 abcabcabc）', () => {
    const st = newWorkbuddyStreamState()
    const frame = (content: string) => JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, message: { role: 'assistant', content } }],
    })
    const first = JSON.parse(processWorkbuddyFrame(frame('abc'), st).payload)
    const second = JSON.parse(processWorkbuddyFrame(frame('abc'), st).payload)
    const third = JSON.parse(processWorkbuddyFrame(frame('abc'), st).payload)
    expect(first.choices[0].delta.content).toBe('abc')
    expect(second.choices[0].delta.content).toBeUndefined()
    expect(third.choices[0].delta.content).toBeUndefined()
  })

  it('快照式增长只补差量（客户端累加后仍等于快照原文）', () => {
    const st = newWorkbuddyStreamState()
    const frame = (content: string) => JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, message: { role: 'assistant', content } }],
    })
    const a = JSON.parse(processWorkbuddyFrame(frame('ab'), st).payload)
    const b = JSON.parse(processWorkbuddyFrame(frame('abc'), st).payload)
    expect(a.choices[0].delta.content).toBe('ab')
    expect(b.choices[0].delta.content).toBe('c')
  })

  it('delta 已下发过正文时，message 快照正文被跳过（不重复一遍）', () => {
    const st = newWorkbuddyStreamState()
    const deltaFrame = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'abc' } }],
    })
    processWorkbuddyFrame(deltaFrame, st)
    const msgFrame = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'abc' } }],
    })
    const out = JSON.parse(processWorkbuddyFrame(msgFrame, st).payload)
    expect(out.choices[0].delta.content).toBeUndefined()
  })

  it('同帧两个缺 index 的 tool_call 分派到不同 index 并写回帧（不被客户端并进同一槽）', () => {
    const st = newWorkbuddyStreamState()
    const frame = JSON.stringify({
      id: 'x1',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'f1', arguments: '{"a":1}' } },
            { id: 'call_b', type: 'function', function: { name: 'f2', arguments: '{"b":2}' } },
          ],
        },
      }],
    })
    const out = JSON.parse(processWorkbuddyFrame(frame, st).payload)
    const tcs = out.choices[0].delta.tool_calls
    expect(tcs.map((t: { index: number }) => t.index)).toEqual([0, 1])
  })

  it('缺 index 但带同一 id 的跨帧延续：归位到既有 index，不新开槽', () => {
    const st = newWorkbuddyStreamState()
    const first = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f1', arguments: '{"a":' } }] } }],
    })
    const second = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_a', function: { arguments: '1}' } }] } }],
    })
    const a = JSON.parse(processWorkbuddyFrame(first, st).payload)
    const b = JSON.parse(processWorkbuddyFrame(second, st).payload)
    expect(a.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(b.choices[0].delta.tool_calls[0].index).toBe(0)
  })

  it('缺 index 无 id 的碎片延续最近槽位（单调用标准形态）', () => {
    const st = newWorkbuddyStreamState()
    const first = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f1', arguments: '{"a":' } }] } }],
    })
    const second = JSON.stringify({
      id: 'x1',
      choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '1}' } }] } }],
    })
    processWorkbuddyFrame(first, st)
    const b = JSON.parse(processWorkbuddyFrame(second, st).payload)
    expect(b.choices[0].delta.tool_calls[0].index).toBe(0)
  })

  it('合规 index 已占用时，缺 index 的新调用补位不覆盖既有槽', () => {
    const st = newWorkbuddyStreamState()
    const frame = JSON.stringify({
      id: 'x1',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'f1', arguments: '{"a":1}' } },
            { id: 'call_b', type: 'function', function: { name: 'f2', arguments: '{"b":2}' } },
          ],
        },
      }],
    })
    const out = JSON.parse(processWorkbuddyFrame(frame, st).payload)
    const tcs = out.choices[0].delta.tool_calls
    expect(tcs[0].index).toBe(0)
    expect(tcs[1].index).toBe(1)
  })
})

/**
 * gateway_hint：上游 error 帧透出前的诊断附加字段
 * （移植 workbuddy2api 76bb543 sse.go StreamHint + a749016 hint.go + fa7b5d9 handler 接线）。
 *
 * 纪律：hint 只做与 error.message **并列**的补充说明——message 一字不改；
 * 未覆盖形态不带字段；非 JSON / 无 error 对象 / 空 hint 一律零改写。
 */
describe('gateway_hint：错误帧诊断附加字段（移植 76bb543 / a749016）', () => {
  /** 6004 模型级限流帧（上游真实形态）。 */
  const rateLimitFrame = {
    error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-abc' },
  }

  it('buildWorkbuddyGatewayHint：已接线形态映射（6004/11115/11102/11133/11135）', () => {
    expect(buildWorkbuddyGatewayHint('6004', 'The model provider is rate-limiting requests.'))
      .toBe(WORKBUDDY_HINT_MODEL_RATE)
    expect(buildWorkbuddyGatewayHint('11115', 'prompt is too long: 120000 tokens > 65536 maximum'))
      .toBe(WORKBUDDY_HINT_PROMPT_TOO_LONG)
    expect(buildWorkbuddyGatewayHint('', 'prompt is too long'))
      .toBe(WORKBUDDY_HINT_PROMPT_TOO_LONG)
    expect(buildWorkbuddyGatewayHint('11102', 'service info not found'))
      .toBe(WORKBUDDY_HINT_MODEL_BLOCKED)
    // 11133/11135 形态判定先于 Kind 表：只有真实上游 marker 才命中，不猜泛化短语。
    expect(buildWorkbuddyGatewayHint('11133', 'Invalid request parameters'))
      .toBe(WORKBUDDY_HINT_MODEL_PARAM_NEUTRAL)
    expect(buildWorkbuddyGatewayHint('', '{"extError":{"code":"model_param_invalid"}}'))
      .toBe(WORKBUDDY_HINT_MODEL_PARAM_NEUTRAL)
    expect(buildWorkbuddyGatewayHint('11135', 'Please start a new conversation, replace the image, and try again.'))
      .toBe(WORKBUDDY_HINT_INVALID_IMAGE)
    expect(buildWorkbuddyGatewayHint('', '{"extError":{"code":"invalid_image_data"}}'))
      .toBe(WORKBUDDY_HINT_INVALID_IMAGE)
  })

  it('buildWorkbuddyGatewayHint：未覆盖形态返回空串（不编造）', () => {
    // 无 code / 空文案
    expect(buildWorkbuddyGatewayHint('', '')).toBe('')
    // 5xx 上游故障
    expect(buildWorkbuddyGatewayHint('500', 'internal')).toBe('')
    // 11101 参数错（本仓 bad_params 出口未接线）——**不能**被泛化短语误判成图片形态
    expect(buildWorkbuddyGatewayHint('11101', 'Unmarshal chat params failed with error: unexpected EOF')).toBe('')
    // 审核拦截（网关改写文案口径，不回上游 code）
    expect(buildWorkbuddyGatewayHint('11-128', 'blocked by security policy')).toBe('')
    // 泛化英文短语不命中（源实现的宽口径已被刻意收窄，见 buildWorkbuddyGatewayHint 注释）
    expect(buildWorkbuddyGatewayHint('', 'invalid request parameters')).toBe('')
    expect(buildWorkbuddyGatewayHint('', 'Please replace the image and retry')).toBe('')
  })

  it('attachWorkbuddyGatewayHint：只新增 gateway_hint，既有键逐字保留', () => {
    const payload = JSON.stringify({ error: { message: 'm', code: '6004', requestId: 'r' } })
    const out = JSON.parse(attachWorkbuddyGatewayHint(payload, 'hint text'))
    expect(out.error.message).toBe('m')
    expect(out.error.code).toBe('6004')
    expect(out.error.requestId).toBe('r')
    expect(out.error.gateway_hint).toBe('hint text')
    expect(Object.keys(out)).toEqual(['error'])
  })

  it('attachWorkbuddyGatewayHint：空 hint / 非 JSON / 无 error 对象 → 逐字节原样', () => {
    const payload = JSON.stringify({ error: { message: 'm', code: '6004' } })
    expect(attachWorkbuddyGatewayHint(payload, '')).toBe(payload)
    expect(attachWorkbuddyGatewayHint('not-json', 'hint')).toBe('not-json')
    expect(attachWorkbuddyGatewayHint('[1,2]', 'hint')).toBe('[1,2]')
    const noErr = JSON.stringify({ message: 'no error object' })
    expect(attachWorkbuddyGatewayHint(noErr, 'hint')).toBe(noErr)
    const nullErr = JSON.stringify({ error: null })
    expect(attachWorkbuddyGatewayHint(nullErr, 'hint')).toBe(nullErr)
  })

  it('cleaner：error 帧透出时附加 gateway_hint，message/code/requestId 原文不变', () => {
    const clean = createWorkbuddyChunkCleaner()
    const out = clean(`data: ${JSON.stringify(rateLimitFrame)}`)
    expect(out.startsWith('data: ')).toBe(true)
    const err = JSON.parse(out.slice(5).trim()).error
    expect(err.gateway_hint).toBe(WORKBUDDY_HINT_MODEL_RATE)
    // message 原文一字不改 + 既有键原样
    expect(err.msg).toBe('The model provider is rate-limiting requests.')
    expect(err.code).toBe(6004)
    expect(err.requestId).toBe('req-abc')
  })

  it('cleaner：hint 为空时字段不出现（零改写，无 gateway_hint 键）', () => {
    const clean = createWorkbuddyChunkCleaner()
    const frame = { error: { code: 11101, msg: 'Unmarshal chat params failed', requestId: 'req-x' } }
    const out = clean(`data: ${JSON.stringify(frame)}`)
    // 未覆盖形态：payload 原样透出（与附加前逐字节一致）
    expect(out).toBe(`data: ${JSON.stringify(frame)}`)
    expect(out).not.toContain('gateway_hint')
  })

  it('cleaner：非 JSON 帧与无 error 对象的帧零改写', () => {
    const clean = createWorkbuddyChunkCleaner()
    // 非 JSON data 负载：原样透传（不计有效帧）
    expect(clean('data: not-json')).toBe('data: not-json')
    // 合法 JSON 但无 error 对象：走白名单重建，绝不出现 gateway_hint
    const out = clean(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }))}`)
    expect(out).not.toContain('gateway_hint')
    expect(JSON.parse(out.slice(5).trim()).choices[0].delta.content).toBe('hi')
  })

  it('sanitizeWorkbuddyErrorFrame：hint 按上游 code/文案判定，raw 保持脱敏原文不含 hint', () => {
    const st = newWorkbuddyStreamState({ sanitizeErrorText: (t) => t.replace(/sk-[A-Za-z0-9]+/g, '***') })
    const r = processWorkbuddyFrame(
      JSON.stringify({ error: { code: 6004, msg: 'rate limited for sk-secret123', requestId: 'req-1' } }),
      st,
    )
    expect(r.error!.hint).toBe(WORKBUDDY_HINT_MODEL_RATE)
    // raw 是「已脱敏的上游帧原文」单一含义：含脱敏后的文案，不含 hint
    expect(r.error!.raw).toContain('rate limited for ***')
    expect(r.error!.raw).not.toContain('gateway_hint')
    // 未覆盖形态：hint 字段缺席（undefined，而非空串）
    const plain = sanitizeWorkbuddyErrorFrame({ error: { code: 500, msg: 'internal' } })
    expect(plain.hint).toBeUndefined()
    expect('hint' in plain).toBe(false)
  })

  it('空流兜底帧不带 hint（网关本地故障形态未覆盖，不编造）', () => {
    const clean = createWorkbuddyChunkCleaner()
    // 0 有效帧 → 收尾补 error 帧 + [DONE]
    const tail = clean.finishStream()
    expect(tail).toContain(WORKBUDDY_EMPTY_STREAM_FRAME)
    expect(tail).not.toContain('gateway_hint')
    expect(WORKBUDDY_EMPTY_STREAM_FRAME).not.toContain('gateway_hint')
  })
})
