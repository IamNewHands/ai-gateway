import { describe, it, expect } from 'vitest'
import {
  CnbToolRenamer,
  sanitizeUpstreamBody,
  convertMessages,
  buildUpstreamBody,
} from './proxy'
import type { CnbMessage } from './proxy'

// ===== CnbToolRenamer =====

describe('CnbToolRenamer', () => {
  it('adds cnb_ prefix and restores original name', () => {
    const r = new CnbToolRenamer()
    const up = r.forward('get_weather')
    expect(up).toBe('cnb_get_weather')
    expect(r.restore(up)).toBe('get_weather')
  })

  it('does not double-prefix names already starting with cnb_', () => {
    const r = new CnbToolRenamer()
    const up = r.forward('cnb_existing')
    expect(up).toBe('cnb_existing')
    // No mapping recorded → restore returns as-is
    expect(r.restore('cnb_existing')).toBe('cnb_existing')
  })

  it('handles empty/null names', () => {
    const r = new CnbToolRenamer()
    expect(r.forward('')).toBe('')
    expect(r.restore('')).toBe('')
  })

  it('restore returns original for unmapped names', () => {
    const r = new CnbToolRenamer()
    r.forward('mapped_tool')
    expect(r.restore('unmapped_tool')).toBe('unmapped_tool')
  })

  it('handles multiple tools with different names', () => {
    const r = new CnbToolRenamer()
    const a = r.forward('search')
    const b = r.forward('calculate')
    expect(a).toBe('cnb_search')
    expect(b).toBe('cnb_calculate')
    expect(r.restore(a)).toBe('search')
    expect(r.restore(b)).toBe('calculate')
  })
})

// ===== sanitizeUpstreamBody =====

describe('sanitizeUpstreamBody', () => {
  it('replaces 🇹🇼 flag emoji with "tw"', () => {
    const input = '{"messages":[{"role":"user","content":"hello 🇹🇼 world"}]}'
    const result = sanitizeUpstreamBody(input)
    expect(result).not.toContain('🇹🇼')
    expect(result).toContain('tw')
    expect(result).toBe('{"messages":[{"role":"user","content":"hello tw world"}]}')
  })

  it('handles multiple occurrences', () => {
    const input = '🇹🇼 and 🇹🇼'
    const result = sanitizeUpstreamBody(input)
    expect(result).toBe('tw and tw')
  })

  it('leaves non-flag emoji untouched', () => {
    const input = '{"content":"hello 👋 world 🎉"}'
    const result = sanitizeUpstreamBody(input)
    expect(result).toBe(input)
  })

  it('leaves strings without emoji unchanged', () => {
    const input = '{"content":"plain text"}'
    expect(sanitizeUpstreamBody(input)).toBe(input)
  })

  it('handles empty string', () => {
    expect(sanitizeUpstreamBody('')).toBe('')
  })
})

// ===== convertMessages — native tool history =====

describe('convertMessages (nativeTools mode)', () => {
  const renamer = new CnbToolRenamer()

  it('keeps assistant tool_calls in native format with cnb_ prefix', () => {
    const input = [
      { role: 'user', content: 'check weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":" Beijing"}' },
          },
        ],
      },
    ]
    const result = convertMessages(input, true, true, renamer)
    expect(result).toHaveLength(2)
    expect(result[1].role).toBe('assistant')
    expect(result[1].tool_calls).toBeDefined()
    expect(result[1].tool_calls![0].function.name).toBe('cnb_get_weather')
    expect(result[1].tool_calls![0].id).toBe('call_abc')
  })

  it('keeps tool role with tool_call_id in native format', () => {
    const input = [
      { role: 'user', content: 'check weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' },
    ]
    const renamer2 = new CnbToolRenamer()
    const result = convertMessages(input, true, true, renamer2)
    // Should have user, assistant (with tool_calls), tool (with tool_call_id)
    const toolMsg = result.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe('call_1')
    expect(toolMsg!.content).toBe('{"temp":25}')
  })

  it('generates call ID when missing in native mode', () => {
    const input = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
    ]
    const renamer2 = new CnbToolRenamer()
    const result = convertMessages(input, true, true, renamer2)
    expect(result[0].tool_calls![0].id).toMatch(/^call_/)
  })

  it('falls back to XYML text when nativeTools=false and bridge=true', () => {
    const input = [
      {
        role: 'assistant',
        content: 'thinking...',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }],
      },
    ]
    const renamer2 = new CnbToolRenamer()
    const result = convertMessages(input, true, false, renamer2)
    expect(result[0].tool_calls).toBeUndefined()
    // Should contain XYML render in content
    expect(result[0].content).toContain('calc')
  })

  it('falls back to plain text when nativeTools=false and bridge=false', () => {
    const input = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }],
      },
    ]
    const renamer2 = new CnbToolRenamer()
    const result = convertMessages(input, false, false, renamer2)
    expect(result[0].tool_calls).toBeUndefined()
    expect(result[0].content).toContain('calc')
    expect(result[0].content).toContain('assistant called tool')
  })

  it('preserves normal user/assistant messages in native mode', () => {
    const input = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    const renamer2 = new CnbToolRenamer()
    const result = convertMessages(input, true, true, renamer2)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('hello')
    expect(result[1].role).toBe('assistant')
    expect(result[1].content).toBe('hi there')
  })
})

// ===== buildUpstreamBody — native tools, reasoning_effort, max_tokens =====

describe('buildUpstreamBody', () => {
  const baseInput = {
    model: 'cnb/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  }

  it('adds tools with cnb_ prefix in native mode', () => {
    const renamer = new CnbToolRenamer()
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hello' }], tools, true, true, renamer)
    expect(body.tools).toBeDefined()
    const toolsArr = body.tools as Array<Record<string, unknown>>
    expect(toolsArr).toHaveLength(1)
    const fn = (toolsArr[0] as Record<string, unknown>).function as Record<string, unknown>
    expect(fn.name).toBe('cnb_get_weather')
  })

  it('does not include tools in XYML bridge mode', () => {
    const renamer = new CnbToolRenamer()
    const tools = [
      { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
    ]
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hello' }], tools, true, false, renamer)
    expect(body.tools).toBeUndefined()
    // XYML instructions injected into system message
    const msgs = body.messages as CnbMessage[]
    expect(msgs[0].role).toBe('system')
  })

  it('does not include tools when no tools provided', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hi' }], [], true, true, renamer)
    expect(body.tools).toBeUndefined()
  })

  it('defaults reasoning_effort to low when not specified', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hi' }], [], false, false, renamer)
    expect(body.reasoning_effort).toBe('low')
  })

  it('respects client reasoning_effort when specified', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(
      { ...baseInput, reasoning_effort: 'high' },
      [{ role: 'user', content: 'hi' }],
      [],
      false, false, renamer,
    )
    expect(body.reasoning_effort).toBe('high')
  })

  it('defaults maxTokens to 60000 when client does not specify', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hi' }], [], false, false, renamer)
    expect(body.maxTokens).toBe(60000)
  })

  it('respects client max_tokens when provided', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(
      { ...baseInput, max_tokens: 1024 },
      [{ role: 'user', content: 'hi' }],
      [],
      false, false, renamer,
    )
    expect(body.maxTokens).toBe(1024)
  })

  it('ignores invalid max_tokens (zero/negative/non-number)', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(
      { ...baseInput, max_tokens: 0 },
      [{ role: 'user', content: 'hi' }],
      [],
      false, false, renamer,
    )
    expect(body.maxTokens).toBe(60000)
  })

  it('does not include tool_choice in native mode (triggers 403)', () => {
    const renamer = new CnbToolRenamer()
    const tools = [
      { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
    ]
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hi' }], tools, true, true, renamer)
    expect(body.tool_choice).toBeUndefined()
  })

  it('handles bare tool format {name, description, parameters}', () => {
    const renamer = new CnbToolRenamer()
    const tools = [
      { name: 'calculate', description: 'Do math', parameters: { type: 'object' } },
    ]
    const body = buildUpstreamBody(baseInput, [{ role: 'user', content: 'hi' }], tools, true, true, renamer)
    const toolsArr = body.tools as Array<Record<string, unknown>>
    expect(toolsArr).toHaveLength(1)
    const fn = (toolsArr[0]).function as Record<string, unknown>
    expect(fn.name).toBe('cnb_calculate')
  })

  it('passes through temperature, top_p, enable_thinking, presence_penalty', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(
      {
        ...baseInput,
        temperature: 0.7,
        top_p: 0.9,
        enable_thinking: true,
        presence_penalty: 0.5,
      },
      [{ role: 'user', content: 'hi' }],
      [],
      false, false, renamer,
    )
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
    expect(body.enable_thinking).toBe(true)
    expect(body.presence_penalty).toBe(0.5)
  })

  it('strips model prefix (cnb/deepseek → deepseek)', () => {
    const renamer = new CnbToolRenamer()
    const body = buildUpstreamBody(
      { model: 'cnb/deepseek-v4-pro' },
      [{ role: 'user', content: 'hi' }],
      [], false, false, renamer,
    )
    expect(body.model).toBe('deepseek-v4-pro')
  })
})
