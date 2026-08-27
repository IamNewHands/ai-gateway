import { describe, it, expect } from 'vitest'
import { parseToolCalls, scrubToolFragments, ToolSieve } from './xyml'

describe('XYML tool call parsing & scrubbing', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'shell_execute',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'number' },
            tool_title: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
  ]

  it('parses colon-style XYML tags <:XYML:...>', () => {
    const input = `<:XYML:tool_calls> <:XYML:invoke name="shell_execute"> <:XYML:parameter name="command"><![CDATA[cat ~/.workbuddy/credentials/token.json]]></:XYML:parameter> <:XYML:parameter name="timeout">30</:XYML:parameter> <:XYML:parameter name="tool_title">检查缓存token</:XYML:parameter> </:XYML:invoke> </:XYML:tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({
      command: 'cat ~/.workbuddy/credentials/token.json',
      timeout: 30,
      tool_title: '检查缓存token',
    })
  })

  it('parses standard pipe-style XYML tags <|XYML|...>', () => {
    const input = `<|XYML|tool_calls><|XYML|invoke name="shell_execute"><|XYML|parameter name="command"><![CDATA[echo hello]]></|XYML|parameter></|XYML|invoke></|XYML|tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'echo hello' })
  })

  it('scrubs colon-style and pipe-style XYML tags from text', () => {
    const text = `普通正文 <:XYML:tool_calls> <:XYML:invoke name="shell_execute"> </:XYML:invoke> </:XYML:tool_calls> 结束正文`
    const scrubbed = scrubToolFragments(text)
    expect(scrubbed).not.toContain(':XYML:')
    expect(scrubbed).not.toContain('invoke')
    expect(scrubbed).toContain('普通正文')
    expect(scrubbed).toContain('结束正文')
  })

  it('handles ToolSieve streaming with colon-style tags', () => {
    const sieve = new ToolSieve(tools)
    const chunk1 = '让我用 Python 读一下缓存 token。\n<:XYML:tool_calls> <:XYML:invoke name="shell_execute"> <:XYML:parameter name="command"><![CDATA[cat token.json]]></:XYML:parameter>'
    const chunk2 = ' <:XYML:parameter name="timeout">30</:XYML:parameter> </:XYML:invoke> </:XYML:tool_calls>'

    const events1 = sieve.processChunk(chunk1)
    const events2 = sieve.processChunk(chunk2)
    const eventsFlush = sieve.flush()

    const allEvents = [...events1, ...events2, ...eventsFlush]
    const contentEvents = allEvents.filter((e) => e.type === 'content')
    const toolEvents = allEvents.filter((e) => e.type === 'tool_calls')

    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0].calls?.[0].name).toBe('shell_execute')
    expect(toolEvents[0].calls?.[0].input).toEqual({ command: 'cat token.json', timeout: 30 })

    const fullContent = contentEvents.map((e) => e.text).join('')
    expect(fullContent).not.toContain(':XYML:')
    expect(fullContent).not.toContain('invoke')
  })
})
