/**
 * 回归用例：Work 通道 `done.last_assistant_response` 的三种上游形态都必须落地。
 *
 * 缺陷（本轮修复）：原实现只认 JSON **数组** `["答案"]`；上游以 JSON **字符串**
 * `"答案"` 下发时，`JSON.parse` 成功返回 string → `Array.isArray` 不成立，且解析成功
 * 也不会走 catch → **最终答案被静默吞掉**，客户端只看到空内容（或只剩推理）。
 * 裸文本形态（非 JSON）此前靠 catch 兜住，属已工作路径，此处一并钉回归。
 */
import { describe, it, expect } from 'vitest'
import { aggregateWorkSse, pickWorkFinalAnswer, workStreamToOpenAIStream } from './sse'

const MODEL = 'DeepSeek-V4-Flash-Official'

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
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

/** 用给定的 last_assistant_response 原文跑一遍 Work 流式路径，返回 SSE 文本。 */
async function streamWithFinalAnswer(raw: string): Promise<string> {
  const line = `event: done\ndata: ${JSON.stringify({ payload: { last_assistant_response: raw } })}\n\n`
  return drain(workStreamToOpenAIStream(upstreamOf([line, 'data: [DONE]\n\n']), MODEL))
}

/** 用给定的 last_assistant_response 原文跑一遍 Work 非流式聚合，返回聚合正文。 */
function aggregateWithFinalAnswer(raw: string): string | undefined {
  const text = `event: done\ndata: ${JSON.stringify({ payload: { last_assistant_response: raw } })}\n\ndata: [DONE]\n\n`
  const agg = aggregateWorkSse(text, MODEL)
  return agg.resp?.choices?.[0]?.message?.content
}

describe('pickWorkFinalAnswer：形态归一', () => {
  it('JSON 字符串形态取原值（本轮修复的核心）', () => {
    expect(pickWorkFinalAnswer(JSON.parse('"答案"'))).toBe('答案')
  })
  it('数组形态取第一个非空字符串（不再固定 arr[0]）', () => {
    expect(pickWorkFinalAnswer(['', '答案'])).toBe('答案')
    expect(pickWorkFinalAnswer(['答案', '多余'])).toBe('答案')
  })
  it('数字/对象/null 一律返回空串（不得把 [object Object] 当答案）', () => {
    expect(pickWorkFinalAnswer(42)).toBe('')
    expect(pickWorkFinalAnswer({ text: '答案' })).toBe('')
    expect(pickWorkFinalAnswer(null)).toBe('')
  })
})

describe('Work 流式：done.last_assistant_response 三种形态都落地', () => {
  it('JSON 数组（原路径回归）', async () => {
    const sse = await streamWithFinalAnswer(JSON.stringify(['数组答案']))
    expect(sse).toContain('数组答案')
    expect(sse).toContain('"finish_reason":"stop"')
  })

  it('JSON 字符串（本轮修复：修复前该答案被静默丢弃）', async () => {
    const sse = await streamWithFinalAnswer(JSON.stringify('字符串答案'))
    expect(sse).toContain('字符串答案')
    expect(sse).toContain('"finish_reason":"stop"')
  })

  it('非 JSON 裸文本（catch 兜底路径回归）', async () => {
    const sse = await streamWithFinalAnswer('裸文本答案')
    expect(sse).toContain('裸文本答案')
  })

  it('数组首位为空串 → 取后面的非空元素', async () => {
    const sse = await streamWithFinalAnswer(JSON.stringify(['', '非空答案']))
    expect(sse).toContain('非空答案')
  })

  it('解析出对象/数字 → 不下发任何正文（避免 [object Object] 污染）', async () => {
    const objSse = await streamWithFinalAnswer(JSON.stringify({ text: '不该出现' }))
    expect(objSse).not.toContain('不该出现')
    expect(objSse).not.toContain('[object Object]')
    expect(objSse).toContain('"finish_reason":"stop"')
  })
})

describe('Work 非流式聚合：与流式同一提取口径', () => {
  it('JSON 数组 / JSON 字符串都能聚合出正文', () => {
    expect(aggregateWithFinalAnswer(JSON.stringify(['数组答案']))).toBe('数组答案')
    expect(aggregateWithFinalAnswer(JSON.stringify('字符串答案'))).toBe('字符串答案')
  })

  it('裸文本与非空元素回退同样生效', () => {
    expect(aggregateWithFinalAnswer('裸文本答案')).toBe('裸文本答案')
    expect(aggregateWithFinalAnswer(JSON.stringify(['', '非空答案']))).toBe('非空答案')
  })
})
