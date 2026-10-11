import { describe, it, expect } from 'vitest'
import {
  aggregateSoloSse,
  soloStreamToOpenAIStream,
  isJsonText,
  repairJsonArguments,
  splitJsonStream,
} from './sse'

/**
 * 回归用例：SOLO 原生工具流的 5 种坏形态不得再产出坏参数。
 *
 * 依据 Trae2api-cn issue #8（2026-10-05，d4.1f 最明显，并发 4 工具修前 0/12）：
 *  1. 分片截断      `{"command": "git status"` 缺闭合 `}`
 *  2. 同 index 压栈  `{"a":1}{"b":2}` 拼进同一个 arguments
 *  3. 跨调用交织    Bash 尾部 + Write body 混合
 *  4. 孤立闭合帧    单独一个 `}` 成为 tool_call
 *  5. 无 name/id 续片 被按数组位补 index 后归并到错误调用
 *
 * 目标侧旧实现：`mergeToolCallDelta` 对同一 index 做 `arguments += ` 盲拼、
 * 缺 index 一律落 0、无任何 repair/split/drop，客户端报 inputSchema validation failed。
 */

/** 构造一条 SOLO output 事件（tool_calls 原样嵌入）。 */
function output(payload: Record<string, unknown>): string {
  return `event: output\ndata: ${JSON.stringify(payload)}\n\n`
}

/** 构造一条 SOLO done 事件。 */
function done(): string {
  return `event: done\ndata: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`
}

/** 取非流式聚合结果的 tool_calls。 */
function aggToolCalls(text: string): Array<Record<string, any>> {
  const r = aggregateSoloSse(text)
  expect(r.err).toBeNull()
  expect(r.truncated).toBeNull()
  const calls = r.resp?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) ? calls : []
}

function argsOf(call: Record<string, any>): string {
  return String(call?.function?.arguments ?? '')
}

/** 把流式 SSE 文本里同一 index 的 tool_call 增量按客户端语义拼回来。 */
function collectStreamToolCalls(sseText: string): Array<{ id: string; name: string; args: string }> {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue
    const body = line.slice(5).trim()
    if (body === '' || body === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(body)
    } catch {
      continue
    }
    const tcs = chunk?.choices?.[0]?.delta?.tool_calls
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      const idx = typeof tc?.index === 'number' ? tc.index : 0
      let cur = calls.get(idx)
      if (!cur) {
        cur = { id: '', name: '', args: '' }
        calls.set(idx, cur)
      }
      if (typeof tc?.id === 'string' && tc.id !== '') cur.id = tc.id
      const fn = tc?.function
      if (fn && typeof fn === 'object') {
        if (typeof fn.name === 'string' && fn.name !== '') cur.name = fn.name
        if (typeof fn.arguments === 'string') cur.args += fn.arguments
      }
    }
  }
  return [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done: finished, value } = await reader.read()
    if (finished) break
    out += decoder.decode(value)
  }
  return out
}

function upstreamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })
}

async function streamToolCalls(chunks: string[]): Promise<Array<{ id: string; name: string; args: string }>> {
  const sse = await drain(soloStreamToOpenAIStream(upstreamOf(chunks), 'DeepSeek-V4.1-Flash'))
  return collectStreamToolCalls(sse)
}

// ===== 纯函数：repair / split =====

describe('repairJsonArguments：补全被截断的参数', () => {
  it('缺闭合花括号 → 补齐', () => {
    expect(repairJsonArguments('{"command": "git status"')).toBe('{"command": "git status"}')
  })

  it('缺闭合引号 → 补引号再补花括号', () => {
    const fixed = repairJsonArguments('{"path": "/tmp/a')
    expect(isJsonText(fixed)).toBe(true)
    expect(JSON.parse(fixed)).toEqual({ path: '/tmp/a' })
  })

  it('嵌套未闭合 → 按栈逆序补齐', () => {
    const fixed = repairJsonArguments('{"a": {"b": [1, 2')
    expect(isJsonText(fixed)).toBe(true)
    expect(JSON.parse(fixed)).toEqual({ a: { b: [1, 2] } })
  })

  it('已合法 / 无法可信修复 → 原样返回', () => {
    expect(repairJsonArguments('{"a":1}')).toBe('{"a":1}')
    expect(repairJsonArguments('not json at all')).toBe('not json at all')
    expect(repairJsonArguments('')).toBe('')
  })
})

describe('splitJsonStream：切开压栈拼接串', () => {
  it('{..}{..} → 两个对象', () => {
    expect(splitJsonStream('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('数组形态与空白容差', () => {
    expect(splitJsonStream(' [1,2] \n {"c":3} ')).toEqual([[1, 2], { c: 3 }])
  })

  it('非 JSON 起点 / 截断 → null（不得编造）', () => {
    expect(splitJsonStream('"scalar"')).toBeNull()
    expect(splitJsonStream('{"a":1')).toBeNull()
    expect(splitJsonStream('')).toBeNull()
  })
})

// ===== 非流式聚合：5 种坏形态 =====

describe('aggregateSoloSse：SOLO 工具调用坏形态（issue #8）', () => {
  it('形态1 分片截断 → repair 成合法 JSON，不丢调用', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command": "git status"' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(1)
    expect(JSON.parse(argsOf(calls[0]))).toEqual({ command: 'git status' })
  })

  it('形态2 同 index 压栈 → 开新调用，不字符串拼接', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":1}' } }] }) +
        output({ tool_calls: [{ index: 0, function: { arguments: '{"b":2}' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(2)
    expect(JSON.parse(argsOf(calls[0]))).toEqual({ a: 1 })
    expect(JSON.parse(argsOf(calls[1]))).toEqual({ b: 2 })
  })

  it('形态4 孤立闭合帧 → 丢弃，不污染前一个完整调用', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":1}' } }] }) +
        output({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(1)
    expect(JSON.parse(argsOf(calls[0]))).toEqual({ a: 1 })
  })

  it('形态5 无 index 的无 name 续片 → 并入最近未闭合调用，不落 index 0', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'Read', arguments: '{"p":"a"}' } }] }) +
        output({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'Bash', arguments: '{"c":' } }] }) +
        output({ tool_calls: [{ function: { arguments: '1}' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].function.name).toBe('Read')
    expect(JSON.parse(argsOf(calls[0]))).toEqual({ p: 'a' })
    expect(calls[1].function.name).toBe('Bash')
    expect(JSON.parse(argsOf(calls[1]))).toEqual({ c: 1 })
  })

  it('正常单调用与正常并发调用无回归', () => {
    const single = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":' } }] }) +
        output({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }) +
        done(),
    )
    expect(single).toHaveLength(1)
    expect(JSON.parse(argsOf(single[0]))).toEqual({ a: 1 })

    const parallel = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'Read', arguments: '{"p":"a"}' } }] }) +
        output({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'Write', arguments: '{"p":"b"}' } }] }) +
        done(),
    )
    expect(parallel).toHaveLength(2)
    expect(parallel.map((c) => c.function.name)).toEqual(['Read', 'Write'])
    expect(JSON.parse(argsOf(parallel[0]))).toEqual({ p: 'a' })
    expect(JSON.parse(argsOf(parallel[1]))).toEqual({ p: 'b' })
  })

  it('零参数调用保留为空 arguments，不编造', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'ListDir', arguments: '' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(1)
    expect(argsOf(calls[0])).toBe('')
  })

  it('无 id 的完整重复调用 → 只保留一条（上游重放）', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{"a":1}' } }] }) +
        output({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(1)
    expect(JSON.parse(argsOf(calls[0]))).toEqual({ a: 1 })
  })

  it('不可用参数（非 JSON、非闭合帧）→ 丢弃该调用而不是下发坏参数', () => {
    const calls = aggToolCalls(
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: 'not json at all' } }] }) +
        done(),
    )
    expect(calls).toHaveLength(0)
  })
})

// ===== 流式路径：同样的坏形态 =====

describe('soloStreamToOpenAIStream：SOLO 工具调用坏形态（issue #8）', () => {
  it('形态2 同 index 压栈 → 拆成两个 index 下发', async () => {
    const calls = await streamToolCalls([
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":1}' } }] }),
      output({ tool_calls: [{ index: 0, function: { arguments: '{"b":2}' } }] }),
      done(),
    ])
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0].args)).toEqual({ a: 1 })
    expect(JSON.parse(calls[1].args)).toEqual({ b: 2 })
  })

  it('形态4 孤立闭合帧 → 不下发', async () => {
    const calls = await streamToolCalls([
      output({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":1}' } }] }),
      output({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      done(),
    ])
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].args)).toEqual({ a: 1 })
  })

  it('形态5 无 index 续片 → 并入最近未闭合调用', async () => {
    const calls = await streamToolCalls([
      output({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'Read', arguments: '{"p":"a"}' } }] }),
      output({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'Bash', arguments: '{"c":' } }] }),
      output({ tool_calls: [{ function: { arguments: '1}' } }] }),
      done(),
    ])
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0].args)).toEqual({ p: 'a' })
    expect(JSON.parse(calls[1].args)).toEqual({ c: 1 })
  })

  it('正常单调用 / 并发调用无回归，首帧带 id+name 且续片不带空 id/name', async () => {
    const sse = await drain(
      soloStreamToOpenAIStream(
        upstreamOf([
          output({ tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'Read', arguments: '{"p":' } }] }),
          output({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
          done(),
        ]),
        'DeepSeek-V4.1-Flash',
      ),
    )
    const calls = collectStreamToolCalls(sse)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('c0')
    expect(calls[0].name).toBe('Read')
    expect(JSON.parse(calls[0].args)).toEqual({ p: 'a' })

    // 续片帧不得携带空 id / 空 name（会把首帧已落定的合法值冲掉）
    const deltas = sse
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((b) => b !== '' && b !== '[DONE]')
      .map((b) => JSON.parse(b))
      .flatMap((c) => (Array.isArray(c?.choices?.[0]?.delta?.tool_calls) ? c.choices[0].delta.tool_calls : []))
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toEqual({ index: 0, function: { arguments: '"a"}' } })
  })

  it('只有孤立帧时不得谎报 tool_calls（finish_reason 不能是 tool_calls）', async () => {
    const sse = await drain(
      soloStreamToOpenAIStream(
        upstreamOf([
          output({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
          done(),
        ]),
        'DeepSeek-V4.1-Flash',
      ),
    )
    expect(collectStreamToolCalls(sse)).toHaveLength(0)
    const finish = sse
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((b) => b !== '' && b !== '[DONE]')
      .map((b) => JSON.parse(b))
      .map((c) => c?.choices?.[0]?.finish_reason)
      .filter((f) => typeof f === 'string' && f !== '')
    expect(finish).not.toContain('tool_calls')
  })
})
