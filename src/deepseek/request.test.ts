/**
 * deepseek/request.test.ts — 请求侧规则回归。
 *
 * 期望值逐条来自 simple-chat 的 `openai_test.go` / `strip_test.go`
 * （TestFlattenMessagesRoleTagged / MultipartContent、TestParseRequestSystemMergeTable
 * 的 8 例表、kitchen-sink 剥离、max_completion_tokens 别名等）。
 */

import { describe, it, expect } from 'vitest'
import {
  SYSTEM_MERGE_SEPARATOR as SEP,
  DeepseekRequestError,
  flattenMessages,
  parseDeepseekRequest,
  parseSearchSwitch,
  parseThinkingSwitch,
  type DeepseekContentPart,
  type DeepseekMessage,
} from './request'

const body = (msgs: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'deepseek-flash', messages: msgs, ...extra })

/** 手工构造消息：flatten 的单测要绕过净化（Go 版也是直接调 FlattenMessages）。 */
const msg = (role: string, content = '', contentParts: DeepseekContentPart[] = []): DeepseekMessage => ({
  role,
  content,
  contentParts,
  junkParts: 0,
  hasName: false,
})

describe('flattenMessages', () => {
  it('tags every role including system, without swallowing content', () => {
    const flat = flattenMessages([
      msg('system', 'be brief'),
      msg('user', 'hi'),
      msg('assistant', 'hello'),
      msg('user', 'bye'),
    ])
    expect(flat).toContain('system:')
    expect(flat).toContain('user:')
    expect(flat).toContain('assistant:')
    expect(flat).toContain('be brief')
    expect(flat).toContain('bye')
    // system 和其它角色一样被标记，不做特殊注入：只出现一次
    expect(flat.match(/system:/g)).toHaveLength(1)
  })

  it('keeps text parts and never leaks image data into the prompt', () => {
    const flat = flattenMessages([
      msg('user', '', [
        { type: 'text', text: 'what is in this image' },
        { type: 'image_url', imageUrl: 'data:image/png;base64,aGVsbG8=' },
      ]),
    ])
    expect(flat).toContain('what is in this image')
    expect(flat).not.toContain('aGVsbG8=')
  })

  it('separates multiple text parts with a newline', () => {
    const flat = flattenMessages([
      msg('user', '', [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ])
    // 首个片段紧贴 "user: "（Go 版的 HasSuffix(": ") 判断），后续片段各起一行
    expect(flat).toBe('user: one\ntwo\n')
  })

  it('parsed requests flatten the MERGED system text (no bare system tag survives)', () => {
    const { messages } = parseDeepseekRequest(
      body([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ]),
    )
    const flat = flattenMessages(messages)
    expect(flat).toBe(`user: be brief${SEP}hi\n`)
    expect(flat).not.toContain('system:')
  })
})

describe('system merge table (ported golden cases)', () => {
  const cases: Array<{ name: string; msgs: unknown; want: Array<{ role: string; content: string }>; count: string }> = [
    {
      name: 'multiple system messages merge in original order',
      msgs: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'question' },
      ],
      want: [{ role: 'user', content: `first\n\nsecond${SEP}question` }],
      count: 'system_messages=2',
    },
    {
      name: 'system-only conversation becomes a user message',
      msgs: [{ role: 'system', content: 'only system' }],
      want: [{ role: 'user', content: 'only system' }],
      count: 'system_messages=1',
    },
    {
      name: 'system between user turns still merges into the first user',
      msgs: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      want: [
        { role: 'user', content: `mid${SEP}u1` },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      count: 'system_messages=1',
    },
    {
      name: 'empty system content skipped without counting',
      msgs: [
        { role: 'system', content: '' },
        { role: 'system', content: 'real' },
        { role: 'user', content: 'q' },
      ],
      want: [{ role: 'user', content: `real${SEP}q` }],
      count: 'system_messages=1',
    },
    {
      name: 'multipart system content concatenates text parts',
      msgs: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
        { role: 'user', content: 'q' },
      ],
      want: [{ role: 'user', content: `part one\npart two${SEP}q` }],
      count: 'system_messages=1',
    },
    {
      name: 'system with only junk parts is skipped',
      msgs: [
        { role: 'system', content: [{ type: 'audio', audio: 'x' }] },
        { role: 'user', content: 'q' },
      ],
      want: [{ role: 'user', content: 'q' }],
      count: '',
    },
    {
      name: 'no user message: system merges into new leading user message',
      msgs: [
        { role: 'system', content: 's1' },
        { role: 'assistant', content: 'a1' },
        { role: 'system', content: 's2' },
      ],
      want: [
        { role: 'user', content: 's1\n\ns2' },
        { role: 'assistant', content: 'a1' },
      ],
      count: 'system_messages=2',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const req = parseDeepseekRequest(body(c.msgs))
      expect(req.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual(c.want)
      if (c.count === '') {
        expect(req.stripped.some((s) => s.startsWith('system_messages'))).toBe(false)
      } else {
        expect(req.stripped).toContain(c.count)
      }
    })
  }

  it('all system messages empty still errors', () => {
    expect(() => parseDeepseekRequest(body([{ role: 'system', content: '' }]))).toThrow(
      /messages must not be empty/,
    )
  })

  it('merges all system messages across the transcript (interleaved)', () => {
    const req = parseDeepseekRequest(
      body([
        { role: 'system', content: 's1' },
        { role: 'user', content: 'u1' },
        { role: 'system', content: 's2' },
        { role: 'system', content: 's3' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ]),
    )
    expect(req.messages[0].content).toBe(`s1\n\ns2\n\ns3${SEP}u1`)
    expect(req.stripped).toContain('system_messages=3')
  })
})

describe('field stripping', () => {
  it('reports real values and ignores null / empty-array / zero', () => {
    const req = parseDeepseekRequest(
      body([{ role: 'user', content: 'hi' }], {
        tools: [{ type: 'function' }],
        tool_choice: 'auto',
        stop: null,
        n: 0,
        seed: 42,
        user: 'u-1',
        stream_options: [],
      }),
    )
    expect(req.stripped).toEqual(['tools', 'tool_choice', 'user', 'seed'])
  })

  it('drops tool-call carriers and counts them', () => {
    const req = parseDeepseekRequest(
      body([
        { role: 'user', content: 'q' },
        { role: 'assistant', tool_calls: [{ id: '1' }] },
        { role: 'tool', tool_call_id: '1', content: '' },
        { role: 'assistant', content: 'a' },
      ]),
    )
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(req.messages[1].content).toBe('a')
    expect(req.stripped).toContain('tool_messages=2')
  })

  it('counts junk content parts and ignored name fields', () => {
    const req = parseDeepseekRequest(
      body([
        {
          role: 'user',
          name: 'bob',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'audio', audio: 'x' },
          ],
        },
      ]),
    )
    expect(req.stripped).toContain('junk_content_parts=1')
    expect(req.stripped).toContain('message_names=1')
    expect(req.messages[0].contentParts).toHaveLength(1)
  })

  it('rejects a content value that is neither string nor array', () => {
    expect(() => parseDeepseekRequest(body([{ role: 'user', content: 42 }]))).toThrow(
      /content must be a string or an array of content parts/,
    )
  })
})

describe('switches', () => {
  it('defaults thinking ON and search OFF', () => {
    const req = parseDeepseekRequest(body([{ role: 'user', content: 'hi' }]))
    expect(req.thinkingEnabled).toBe(true)
    expect(req.searchEnabled).toBe(false)
  })

  it('honours explicit switches', () => {
    const req = parseDeepseekRequest(
      body([{ role: 'user', content: 'hi' }], { thinking: { type: 'disabled' }, search: { type: 'enabled' } }),
    )
    expect(req.thinkingEnabled).toBe(false)
    expect(req.searchEnabled).toBe(true)
  })

  it('rejects malformed switch values with actionable messages', () => {
    expect(() => parseThinkingSwitch({ type: 'banana' })).toThrow(/invalid "thinking.type" "banana"/)
    expect(() => parseThinkingSwitch({ type: 123 })).toThrow(/invalid "thinking" field/)
    expect(() => parseThinkingSwitch({})).toThrow(/invalid "thinking" field/)
    expect(() => parseThinkingSwitch('enabled')).toThrow(/invalid "thinking" field/)
    expect(() => parseSearchSwitch({ type: 'nope' })).toThrow(/invalid "search.type" "nope"/)
  })
})

describe('sampling params and aliases', () => {
  it('passes temperature / top_p through and takes the larger max-token alias', () => {
    const req = parseDeepseekRequest(
      body([{ role: 'user', content: 'hi' }], {
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 100,
        max_completion_tokens: 250,
      }),
    )
    expect(req.temperature).toBe(0.7)
    expect(req.topP).toBe(0.9)
    expect(req.maxTokens).toBe(250)
  })

  it('falls back to max_tokens when the alias is absent or smaller', () => {
    const a = parseDeepseekRequest(body([{ role: 'user', content: 'hi' }], { max_tokens: 100 }))
    const b = parseDeepseekRequest(
      body([{ role: 'user', content: 'hi' }], { max_tokens: 100, max_completion_tokens: 10 }),
    )
    expect(a.maxTokens).toBe(100)
    expect(b.maxTokens).toBe(100)
  })
})

describe('envelope errors', () => {
  it('rejects malformed JSON and non-object bodies', () => {
    expect(() => parseDeepseekRequest('not json')).toThrow(DeepseekRequestError)
    expect(() => parseDeepseekRequest('[]')).toThrow(/invalid JSON body/)
    expect(() => parseDeepseekRequest(null as unknown)).toThrow(/invalid JSON body/)
  })

  it('rejects a non-array messages field', () => {
    expect(() => parseDeepseekRequest({ model: 'deepseek-flash', messages: 'hi' })).toThrow(
      /invalid messages: expected an array/,
    )
  })

  it('can enforce an exact model name when asked', () => {
    expect(() =>
      parseDeepseekRequest(body([{ role: 'user', content: 'hi' }]), { enforceModel: 'other' }),
    ).toThrow(/unknown model/)
    expect(
      parseDeepseekRequest(body([{ role: 'user', content: 'hi' }]), { enforceModel: 'deepseek-flash' }).model,
    ).toBe('deepseek-flash')
  })
})
