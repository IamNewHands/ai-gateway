import { describe, it, expect } from 'vitest'
import { openAIChunkToResponsesSSE } from './formats'

// 构造一个响应转换器的累加器（与 proxy.ts handleResponsesSpecial 的用法一致）
function acc() {
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