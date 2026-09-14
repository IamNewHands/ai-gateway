import { describe, expect, it } from 'vitest'
import { KukuSSEParser, openAIChunk, openAICompletion } from './stream'

describe('KukuSSEParser', () => {
  it('parses CRLF events split across chunks', () => {
    const parser = new KukuSSEParser()
    expect(parser.push('data: {"type":"TEXT_BLOCK_')).toEqual([])
    expect(parser.push('DELTA","data":{"delta":"hello"}}\r\n\r\n'))
      .toEqual([{ type: 'delta', text: 'hello' }])
    expect(parser.push('data: {"type":"REPLY_END"}\n\n')).toEqual([{ type: 'done' }])
  })

  it('surfaces upstream ERROR events', () => {
    const parser = new KukuSSEParser()
    const events = parser.push('data: {"type":"ERROR","message":"denied"}\n\n')
    expect(events[0]?.type).toBe('error')
    expect(events[0]?.error).toContain('denied')
  })
})

describe('OpenAI output helpers', () => {
  it('creates streaming and non-streaming shapes', () => {
    expect(openAIChunk('id', 'glm-5.3', 'hi')).toContain('chat.completion.chunk')
    expect(openAICompletion('id', 'glm-5.3', 'hi').choices[0].message.content).toBe('hi')
  })
})
