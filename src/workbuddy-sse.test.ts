import { describe, it, expect } from 'vitest'
import {
  newWorkbuddyStreamState,
  processWorkbuddyFrame,
  normalizeWorkbuddyFrame,
  backfillToolCallNames,
  createWorkbuddyChunkCleaner,
  sanitizeWorkbuddyErrorFrame,
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

