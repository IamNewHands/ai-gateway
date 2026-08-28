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

  it('parses full-width-pipe XYML tags <｜XYML｜...>', () => {
    const input = `<｜XYML｜tool_calls><｜XYML｜invoke name="shell_execute"><｜XYML｜parameter name="command"><![CDATA[echo hello]]></｜XYML｜parameter></｜XYML｜invoke></｜XYML｜tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'echo hello' })
  })

  it('parses mixed-width XYML tags <｜XYML|...>', () => {
    const input = `<｜XYML|tool_calls><｜XYML|invoke name="shell_execute"><｜XYML|parameter name="command"><![CDATA[echo hello]]></｜XYML|parameter></｜XYML|invoke></｜XYML|tool_calls>`
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

  it('scrubs full-width-pipe XYML tags from text', () => {
    const text = `普通正文 <｜XYML｜tool_calls> <｜XYML｜invoke name="shell_execute"> </｜XYML｜invoke> </｜XYML｜tool_calls> 结束正文`
    const scrubbed = scrubToolFragments(text)
    expect(scrubbed).not.toContain('XYML')
    expect(scrubbed).not.toContain('invoke')
    expect(scrubbed).not.toContain('tool_calls')
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

  it('handles ToolSieve streaming with full-width-pipe tags and no leak', () => {
    const sieve = new ToolSieve(tools)
    const chunk1 = '正在执行检查。\n<｜XYML｜tool_calls><｜XYML｜invoke name="shell_execute"><｜XYML｜parameter name="command"><![CDATA[cat token.json]]></｜XYML｜parameter>'
    const chunk2 = '</｜XYML｜invoke></｜XYML｜tool_calls> 检查完成'

    const events1 = sieve.processChunk(chunk1)
    const events2 = sieve.processChunk(chunk2)
    const eventsFlush = sieve.flush()

    const allEvents = [...events1, ...events2, ...eventsFlush]
    const contentEvents = allEvents.filter((e) => e.type === 'content')
    const toolEvents = allEvents.filter((e) => e.type === 'tool_calls')

    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0].calls?.[0].name).toBe('shell_execute')
    expect(toolEvents[0].calls?.[0].input).toEqual({ command: 'cat token.json' })

    const fullContent = contentEvents.map((e) => e.text).join('')
    expect(fullContent).not.toContain('XYML')
    expect(fullContent).not.toContain('invoke')
    expect(fullContent).not.toContain('tool_calls')
    expect(fullContent).toContain('正在执行检查。')
    expect(fullContent).toContain('检查完成')
  })
})

describe('fault-tolerant markup parser (Plan C)', () => {
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
          },
          required: ['command'],
        },
      },
    },
  ]

  it('parses tags with inner whitespace between protocol name and delim', () => {
    // <|XYML |tool_calls|> — 协议名后带空格再闭合定界符
    const input = `<|XYML |tool_calls> <|XYML |invoke name="shell_execute"> <|XYML |parameter name="command"><![CDATA[ls -la]]></|XYML |parameter> </|XYML |invoke> </|XYML |tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'ls -la' })
  })

  it('parses closing tags whose delimiters differ from their opening tags', () => {
    // 开标签用 ASCII 竖线 <|XYML|，闭标签用全角竖线 </｜XYML｜>（模型输出不自洽）
    const input = `<|XYML|tool_calls><|XYML|invoke name="shell_execute"><|XYML|parameter name="command"><![CDATA[echo hi]]></｜XYML｜parameter></｜XYML｜invoke></｜XYML｜tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'echo hi' })
  })

  it('parses invoke whose name attribute appears after extra space and before other attrs', () => {
    // name 属性前有多余空白、且顺序在其它属性之后仍要能取到
    const input = `<|XYML|tool_calls><|XYML|invoke  name = "shell_execute" ><|XYML|parameter name="command"><![CDATA[pwd]]></|XYML|parameter></|XYML|invoke></|XYML|tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'pwd' })
  })

  it('recovers parameters whose closing tag is missing inside a closed invoke', () => {
    // <|XYML|parameter...> 的闭合标签丢失（模型把 </|XYML|invoke> 写成了闭合），
    // 但 invoke 块本身闭合。容错解析器应基于标签嵌套深度恢复该参数，而非整块丢弃。
    const input = `<|XYML|tool_calls><|XYML|invoke name="shell_execute"><|XYML|parameter name="command"><![CDATA[date]]></|XYML|invoke></|XYML|tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'date' })
  })

  it('treats a parameter whose closing tag was replaced by the invoke closing tag as the invoke body', () => {
    // 同上但更彻底：最后一对 <|XYML|parameter ...> ... </|XYML|invoke> 里没有 parameter 闭合，
    // 值以 CDATA 形式出现在 invoke 末尾，仍应被恢复进参数。
    const input = `<|XYML|tool_calls><|XYML|invoke name="shell_execute"><|XYML|parameter name="command"><![CDATA[uptime]]></|XYML|invoke></|XYML|tool_calls>`
    const calls = parseToolCalls(input, tools)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('shell_execute')
    expect(calls[0].input).toEqual({ command: 'uptime' })
  })
})

describe('ToolSieve truncated-block handling (Plan C)', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'shell_execute',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
  ]

  it('captures a tool block wrapped in full-width brackets via streaming sieve', () => {
    // 模型偶发输出全角尖括号包裹的工具块（流式检测层用 ASCII < 无法命中），
    // 若不被捕获、只靠 scrub 兜底，参数值会作为正文泄漏。方案C把 canonicalizeMarkup
    // 抬到捕获层入口，使全角尖括号形态也能被识别为工具块并被正确解析。
    const input = `前文\n＜｜XYML｜tool_calls＞＜｜XYML｜invoke name="shell_execute"＞＜｜XYML｜parameter name="command"＞＜![CDATA[echo fullwidth]]＞＜／｜XYML｜parameter＞＜／｜XYML｜invoke＞＜／｜XYML｜tool_calls＞后续`
    const sieve = new ToolSieve(tools)
    const events = sieve.processChunk(input)
    const flushed = sieve.flush()
    const all = [...events, ...flushed]
    const callEvents = all.filter((e) => e.type === 'tool_calls') as Array<{ type: 'tool_calls'; calls?: Array<{ name: string; input: unknown }> }>
    expect(callEvents.length).toBeGreaterThan(0)
    expect(callEvents[0].calls?.[0].name).toBe('shell_execute')
    expect(callEvents[0].calls?.[0].input).toEqual({ command: 'echo fullwidth' })
    const content = all.filter((e) => e.type === 'content').map((e) => e.text).join('')
    expect(content).not.toContain('fullwidth')
  })

  it('flush with an unclosed tool block does not leak XYML markup into content', () => {
    // 流在 <|XYML|tool_calls> 打开后直接结束（模拟上游断流/输出被截断）
    const sieve = new ToolSieve(tools)
    const events = sieve.processChunk('前文\n<|XYML|tool_calls><|XYML|invoke name="shell_execute"><|XYML|parameter name="command"><![CDATA[ls')
    const flushEvents = sieve.flush()

    const contentEvents = [events, flushEvents].flat().filter((e) => e.type === 'content')
    const content = contentEvents.map((e) => e.text).join('')
    expect(content).not.toContain('XYML')
    expect(content).not.toContain('invoke')
    expect(content).not.toContain('parameter')
    expect(content).not.toContain('CDATA')
    expect(content).not.toContain('<|')
    // 关键断点：被截断工具块里的值文本（echo truncated_value 之类的 CDATA）属于工具入参，
    // 绝不能作为正文透出——否则就是"工具参数泄漏进正文"（本次方案C要修复的核心问题）。
    expect(content).not.toContain('ls')
    expect(content).not.toContain('truncated')
  })
})
