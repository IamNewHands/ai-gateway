import { describe, expect, it } from 'vitest'
import {
  requestsPublicReasoning,
  appendPublicReasoning,
  publicReasoningEvents,
  extractPublicReasoningSummaries,
  chatDeliversPublicReasoning,
  chatReasoningContent,
} from './public-reasoning'

describe('M365 public reasoning summaries', () => {
  it('identifies requests for public reasoning summaries', () => {
    expect(requestsPublicReasoning({ summary: 'auto' })).toBe(true)
    expect(requestsPublicReasoning({ summary: 'concise' })).toBe(true)
    expect(requestsPublicReasoning({ summary: 'detailed' })).toBe(true)
    expect(requestsPublicReasoning({ generate_summary: 'auto' })).toBe(true)
    expect(requestsPublicReasoning({ summary: 'none' })).toBe(false)
    expect(requestsPublicReasoning(null)).toBe(false)
    expect(requestsPublicReasoning(undefined)).toBe(false)
  })

  it('appends public reasoning items at the end of responses output', () => {
    const originalOutput = [{ type: 'message', content: 'hello' }]
    const summaries = ['Step 1: Analyzed requirements', 'Step 2: Selected tool']
    const result = appendPublicReasoning(originalOutput, summaries, true)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(originalOutput[0])
    expect(result[1]).toMatchObject({
      type: 'reasoning',
      status: 'completed',
      summary: [
        { type: 'summary_text', text: 'Step 1: Analyzed requirements' },
        { type: 'summary_text', text: 'Step 2: Selected tool' },
      ],
    })
  })

  it('generates compliant OpenAI Responses SSE streaming events for reasoning', () => {
    const summaries = ['Thought step 1']
    const output = appendPublicReasoning([], summaries, true)
    const events = publicReasoningEvents(output)

    expect(events.length).toBeGreaterThan(0)
    expect(events[0].type).toBe('response.output_item.added')
    expect(events[1].type).toBe('response.reasoning_summary_part.added')
    expect(events[2].type).toBe('response.reasoning_summary_text.delta')
    expect(events[2].delta).toBe('Thought step 1')
    expect(events[3].type).toBe('response.reasoning_summary_text.done')
    expect(events[4].type).toBe('response.reasoning_summary_part.done')
    expect(events[5].type).toBe('response.output_item.done')
  })

  it('extracts public reasoning summaries from raw ChatHub events', () => {
    const events = [
      {
        type: 1,
        target: 'update',
        arguments: [
          {
            messages: [
              {
                author: 'bot',
                messageType: 'Progress',
                contentOrigin: 'ChainOfThoughtSummary',
                text: 'Draft summary',
                messageId: 'sum_1',
              },
            ],
          },
        ],
      },
      {
        type: 2,
        item: {
          messages: [
            {
              author: 'bot',
              messageType: 'Progress',
              contentOrigin: 'ChainOfThoughtSummary',
              text: 'Final summary revised',
              messageId: 'sum_1',
            },
            {
              author: 'bot',
              messageType: 'Progress',
              contentOrigin: 'ChainOfThoughtSummary',
              text: 'Second summary',
              messageId: 'sum_2',
            },
            {
              author: 'bot',
              messageType: 'Chat',
              text: 'Regular answer text',
            },
          ],
        },
      },
    ]

    const extracted = extractPublicReasoningSummaries(events)
    expect(extracted).toEqual(['Final summary revised', 'Second summary'])
  })
})

describe('M365 chat 公开推理投递（移植自 M365-Gateway chatDeliversPublicReasoning/chatReasoningContent）', () => {
  it('缺省投递，仅 summary:none 抑制', () => {
    expect(chatDeliversPublicReasoning(undefined)).toBe(true)
    expect(chatDeliversPublicReasoning(null)).toBe(true)
    expect(chatDeliversPublicReasoning({})).toBe(true)
    expect(chatDeliversPublicReasoning({ summary: 'auto' })).toBe(true)
    expect(chatDeliversPublicReasoning({ summary: 'concise' })).toBe(true)
    expect(chatDeliversPublicReasoning({ generate_summary: 'detailed' })).toBe(true)
    expect(chatDeliversPublicReasoning({ summary: 'none' })).toBe(false)
    expect(chatDeliversPublicReasoning({ generate_summary: 'none' })).toBe(false)
  })

  it('把摘要渲染为 reasoning_content：去重 + 空行连接', () => {
    expect(chatReasoningContent(['A', 'B'])).toBe('A\n\nB')
    expect(chatReasoningContent(['A', 'A', 'B'])).toBe('A\n\nB')
  })

  it('空/无效摘要返回 undefined', () => {
    expect(chatReasoningContent(undefined)).toBeUndefined()
    expect(chatReasoningContent([])).toBeUndefined()
    expect(chatReasoningContent(['', '   '])).toBeUndefined()
  })

  it('超过 16384 字符预算的摘要被丢弃', () => {
    const huge = 'x'.repeat(20_000)
    expect(chatReasoningContent([huge])).toBeUndefined()
    // 预算内累积：16000 + 1 均在同一 16384 预算内
    const ok = chatReasoningContent(['y'.repeat(16_000), 'z'])
    expect(ok).toBe(`${'y'.repeat(16_000)}\n\nz`)
    // 已用满预算后，后续摘要被丢弃
    const saturated = chatReasoningContent(['y'.repeat(16_384), 'z'])
    expect(saturated).toBe('y'.repeat(16_384))
  })
})
