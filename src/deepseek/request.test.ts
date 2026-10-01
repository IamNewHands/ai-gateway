/**
 * deepseek/request.test.ts — 请求侧规则回归。
 *
 * 期望值逐条来自 simple-chat 的 `openai_test.go` / `strip_test.go`
 * （TestFlattenMessagesRoleTagged / MultipartContent、TestParseRequestSystemMergeTable
 * 的 8 例表、kitchen-sink 剥离、max_completion_tokens 别名等）。
 */

import { describe, it, expect } from 'vitest'
import {
  DEEPSEEK_MAX_PROMPT_CHARS,
  SYSTEM_MERGE_SEPARATOR as SEP,
  DeepseekPromptTooLongError,
  DeepseekRequestError,
  assertPromptLength,
  flattenMessages,
  isDeepseekReasoningOff,
  parseDeepseekRequest,
  parseSearchSwitch,
  parseThinkingSwitch,
  resolveDeepseekThinking,
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
  it('detects an explicit "no thinking" request across both client spellings', () => {
    // Anthropic 折成 reasoning_effort；Responses 用 reasoning.effort
    expect(isDeepseekReasoningOff({ reasoning_effort: 'none' })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning_effort: 'off' })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning_effort: 'disabled' })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning_effort: 'MINIMAL' })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning_effort: ' minimal ' })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning: { effort: 'none' } })).toBe(true)
    expect(isDeepseekReasoningOff({ reasoning: { effort: 'minimal' } })).toBe(true)
    // 未表态 / 明确要高推理：都不算「关」，走上游缺省（开）
    expect(isDeepseekReasoningOff({})).toBe(false)
    expect(isDeepseekReasoningOff({ reasoning_effort: 'high' })).toBe(false)
    expect(isDeepseekReasoningOff({ reasoning: { effort: 'medium' } })).toBe(false)
    expect(isDeepseekReasoningOff({ reasoning: null })).toBe(false)
    expect(isDeepseekReasoningOff({ reasoning_effort: 5 })).toBe(false)
  })

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

/**
 * provider 级「默认关思考」的优先级：**客户端显式声明 > provider 默认 > 内置默认(开)**。
 *
 * 事故背景：上游 thinking_enabled 缺省是开，翻译这类轻量任务白等思考时间。
 * 但开关只能单向覆盖就成了陷阱——勾了默认关之后必须有办法在个别请求上开回来，
 * 所以「客户端显式 enabled / 非 none 的 reasoning_effort」必须压过 provider 默认。
 */
describe('深度思考开关的优先级（provider 默认 vs 客户端显式声明）', () => {
  const user = [{ role: 'user', content: 'hi' }]

  it('provider 默认关：客户端没表态时关思考', () => {
    const req = parseDeepseekRequest(body(user), { thinkingDefaultOff: true })
    expect(req.thinkingEnabled).toBe(false)
  })

  it('provider 默认关但客户端显式要思考 → 以客户端为准（开关不能锁死功能）', () => {
    expect(
      parseDeepseekRequest(body(user, { thinking: { type: 'enabled' } }), { thinkingDefaultOff: true })
        .thinkingEnabled,
    ).toBe(true)
    expect(
      parseDeepseekRequest(body(user, { reasoning_effort: 'high' }), { thinkingDefaultOff: true })
        .thinkingEnabled,
    ).toBe(true)
    expect(
      parseDeepseekRequest(body(user, { reasoning: { effort: 'medium' } }), { thinkingDefaultOff: true })
        .thinkingEnabled,
    ).toBe(true)
  })

  it('provider 默认关 + 客户端显式关 → 仍是关', () => {
    expect(
      parseDeepseekRequest(body(user, { thinking: { type: 'disabled' } }), { thinkingDefaultOff: true })
        .thinkingEnabled,
    ).toBe(false)
    expect(
      parseDeepseekRequest(body(user, { reasoning_effort: 'none' }), { thinkingDefaultOff: true })
        .thinkingEnabled,
    ).toBe(false)
  })

  it('provider 默认关但客户端 reasoning_effort=none/minimal → 关（与 isDeepseekReasoningOff 同口径）', () => {
    for (const effort of ['none', 'off', 'disabled', 'minimal']) {
      expect(
        parseDeepseekRequest(body(user, { reasoning_effort: effort }), { thinkingDefaultOff: true })
          .thinkingEnabled,
        `reasoning_effort=${effort} 应判为关思考`,
      ).toBe(false)
    }
  })

  it('provider 未设默认（undefined/false）时保持内置默认开', () => {
    expect(parseDeepseekRequest(body(user)).thinkingEnabled).toBe(true)
    expect(parseDeepseekRequest(body(user), { thinkingDefaultOff: false }).thinkingEnabled).toBe(true)
    expect(parseDeepseekRequest(body(user), { thinkingDefaultOff: undefined }).thinkingEnabled).toBe(true)
  })

  it('provider 默认关时，客户端显式关思考仍然有效（两路都指向关，不能互相覆盖成开）', () => {
    expect(resolveDeepseekThinking({ thinking: { type: 'disabled' } }, true)).toBe(false)
    expect(resolveDeepseekThinking({}, true)).toBe(false)
    expect(resolveDeepseekThinking({}, undefined)).toBe(true)
  })

  it('非法 thinking 值在 provider 默认关时仍报错（不被默认值掩盖）', () => {
    expect(() => parseDeepseekRequest(body(user, { thinking: { type: 'banana' } }), { thinkingDefaultOff: true }))
      .toThrow(/invalid "thinking.type" "banana"/)
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

/**
 * 超长 prompt 前置校验（移植自 Go 版 `DefaultMaxPromptChars = 2_000_000`）。
 *
 * 计数口径是 JS 字符串长度（UTF-16 code unit），与 Go 的 `len(prompt)`（字节数）**不同**：
 * 对中文来说 Go 会把 1 个字符算成 3 字节，所以同样文本 Go 会先触发。这是有意的——
 * 上限的职责是拦住病态请求，不是精确 token 预算；真正的目的是让客户端拿到可归因的 400
 * 而不是上游的模糊 502。这里把这个口径写进断言，避免以后被误当成 bug「修正」。
 */
describe('prompt 长度上限', () => {
  it('上限常量与 Go 版一致（200 万字符）', () => {
    expect(DEEPSEEK_MAX_PROMPT_CHARS).toBe(2_000_000)
  })

  it('恰好等于上限不报错，超一个字符就报错', () => {
    expect(() => assertPromptLength('x'.repeat(2_000_000))).not.toThrow()
    expect(() => assertPromptLength('x'.repeat(2_000_001))).toThrow(DeepseekPromptTooLongError)
  })

  it('错误带上实际长度与上限，且 code 是 context_length_exceeded', () => {
    try {
      assertPromptLength('x'.repeat(2_000_005))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DeepseekPromptTooLongError)
      const e = err as DeepseekPromptTooLongError
      expect(e.code).toBe('context_length_exceeded')
      expect(e.message).toContain('2000005')
      expect(e.message).toContain('2000000')
    }
  })

  it('limit <= 0 表示关闭校验（Go 的 DS_MAX_PROMPT_CHARS=0 语义）', () => {
    expect(() => assertPromptLength('x'.repeat(10), 0)).not.toThrow()
    expect(() => assertPromptLength('x'.repeat(10), -1)).not.toThrow()
  })

  it('自定义上限可收紧（测试与未来配置化用）', () => {
    expect(() => assertPromptLength('x'.repeat(11), 10)).toThrow(DeepseekPromptTooLongError)
  })

  /** 上限是按**摊平后**的 prompt 算的：角色标签与分隔符都计入。 */
  it('按摊平后的长度判定（角色标签计入）', () => {
    const msgs = parseDeepseekRequest(body([{ role: 'user', content: 'x'.repeat(2_000_000) }])).messages
    const flat = flattenMessages(msgs)
    expect(flat.length).toBeGreaterThan(2_000_000) // "user: " 前缀 + 结尾换行
    expect(() => assertPromptLength(flat)).toThrow(DeepseekPromptTooLongError)
  })
})
