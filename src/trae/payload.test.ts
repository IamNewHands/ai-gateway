import { describe, it, expect } from 'vitest'
import {
  boundRemoteQuery,
  flattenTraeQuery,
  isRemoteOnlyModel,
  prepareBody,
  RemoteQueryTooLargeError,
  applyHistoryBudget,
  applyToolSchemaBudget,
  TRAE_REMOTE_QUERY_MAX_CHARS,
  TRAE_REMOTE_QUERY_TRUNCATION_MARKER,
} from './payload'

function msg(role: string, content: string): Record<string, any> {
  return { role, content }
}

// applyHistoryBudget/applyToolSchemaBudget 在生产中以宽松 unknown[] 签名处理 TRAE 原始消息/schema，
// 测试需在访问元素属性时做一次窄化（仅类型层面，不影响运行期）。
type LiteMsg = { role: string; content: unknown; [k: string]: unknown }
type LiteTool = { type: string; function: { name: string; parameters?: unknown } }
const asMsgs = (a: unknown[]): LiteMsg[] => a as unknown as LiteMsg[]
const asTools = (a: unknown[]): LiteTool[] => a as unknown as LiteTool[]

describe('applyHistoryBudget：历史消息裁剪（raw/remote 长会话省输入积分）', () => {
  const system = msg('system', 'sys')
  it('未配置预算(maxMessages=0) → 原样返回，不动数组', () => {
    const messages = [system, msg('user', 'u'), msg('assistant', 'a')]
    const out = applyHistoryBudget(messages, { maxMessages: 0, maxHistoryChars: 0, maxToolSchemaChars: 0 })
    expect(out).toBe(messages)
    expect(out.length).toBe(3)
  })

  it('maxMessages 保留最近 non-system 消息，system 恒保留', () => {
    const messages = [system, msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2'), msg('assistant', 'a2')]
    const out = asMsgs(applyHistoryBudget(messages, { maxMessages: 3, maxHistoryChars: 0, maxToolSchemaChars: 0 }))
    expect(out.length).toBe(4) // system + 最近3条
    expect(out[0]).toBe(system)
    expect(out[1].content).toBe('a1')
    expect(out[2].content).toBe('u2')
    expect(out[3].content).toBe('a2')
  })

  it('工具调用配对消息不可被拆散（保留边界 tool/tool_call_id 配对）', () => {
    // 最近消息是 assistant tool_calls，其后必须有对应 tool 消息；裁剪到剩 3 条时
    // 不能只留 assistant.tool_calls 而丢掉其 tool 结果。
    const messages = [
      msg('user', 'u1'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ]
    const out = asMsgs(applyHistoryBudget(messages, { maxMessages: 1, maxHistoryChars: 0, maxToolSchemaChars: 0 }))
    // 最后 pair 必须整体保留（至少 2 条），不能拆散
    expect(out.length).toBeGreaterThanOrEqual(1)
    const roles = out.map((m) => m.role)
    // 若保留了 assistant.tool_calls 则必须保留其 tool 结果
    if (roles.includes('assistant')) {
      expect(roles).toContain('tool')
      expect(out[out.length - 1].role).toBe('tool')
    }
  })

  it('maxHistoryChars 截断后的消息整体剔除而不是半条', () => {
    const messages = [msg('user', 'a'.repeat(10)), msg('assistant', 'b'.repeat(10))]
    // 预算只够 1 条 → 只保留最近 1 条完整消息
    const out = asMsgs(applyHistoryBudget(messages, { maxMessages: 0, maxHistoryChars: 12, maxToolSchemaChars: 0 }))
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('b'.repeat(10))
  })
})

describe('applyToolSchemaBudget：工具 schema 压缩（省输入积分，超限时保留工具名签名）', () => {
  function tool(name: string, params: string): Record<string, any> {
    return { type: 'function', function: { name, parameters: JSON.parse(params) } }
  }
  it('未配置预算(maxToolSchemaChars=0) → 原样返回', () => {
    const tools = [tool('read_file', '{"type":"object","properties":{"path":{"type":"string"}}}')]
    const out = applyToolSchemaBudget(tools, 0)
    expect(out).toBe(tools)
    expect(out.length).toBe(1)
  })

  it('总体积在预算内 → 不做任何改写', () => {
    const tools = [tool('read_file', '{"type":"object","properties":{"path":{"type":"string"},"depth":{"type":"integer"}}}')]
    const out = applyToolSchemaBudget(tools, 10000)
    expect(out).toEqual(tools)
  })

  it('超预算 → 仅压缩 function.parameters 为保留必填字段的最小 schema', () => {
    const bigParams = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(200) }, b: { type: 'integer', description: 'y'.repeat(200) } } }
    const tools = [tool('t', JSON.stringify(bigParams))]
    const out = asTools(applyToolSchemaBudget(tools, 100))
    expect(out.length).toBe(1)
    const fn = out[0].function
    expect(fn.name).toBe('t')
    // 压缩后体积显著小于原始且仍是合法 JSON schema
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(tools).length)
  })
})

describe('isRemoteOnlyModel：模型级路由（TRAE_REMOTE_ONLY_MODELS）', () => {
  it('空配置 → 全走默认（非强制 remote）', () => {
    expect(isRemoteOnlyModel('glm-5.2', '')).toBe(false)
  })
  it('* 通配 → 全部强制 remote', () => {
    expect(isRemoteOnlyModel('anything', '*')).toBe(true)
  })
  it('逗号分隔精确匹配（忽略大小写/前后空格）', () => {
    const cfg = ' Deepseek-V4-Pro , glm-5.2 '
    expect(isRemoteOnlyModel('deepseek-v4-pro', cfg)).toBe(true)
    expect(isRemoteOnlyModel('glm-5.2', cfg)).toBe(true)
    expect(isRemoteOnlyModel('kimi-k3', cfg)).toBe(false)
  })
})

describe('prepareBody 回归：历史/工具预算接线后仍产出合法 SOLO 请求体', () => {
  it('多轮工具历史裁剪后 stream=true、function 固定、config_name/model 对齐', () => {
    const body = {
      model: 'glm-5.2',
      messages: [
        msg('user', 'hi'),
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'x' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
      stream: false,
    }
    const out = prepareBody(JSON.stringify(body))
    const parsed = JSON.parse(out)
    expect(parsed.stream).toBe(true)
    expect(parsed.function).toBe('solo_work_lite')
    expect(parsed.config_name).toBe('glm-5.2')
    expect(parsed.model).toBe('glm-5.2')
    expect(Array.isArray(parsed.messages)).toBe(true)
  })
})

describe('prepareBody：上游角色白名单归一化（SOLO 只认 system/assistant/user/tool/function）', () => {
  it('developer → system（DSH / Codex 等客户端用 developer 承载系统提示词）', () => {
    const body = { model: 'glm-5.2', messages: [msg('developer', 'sys prompt'), msg('user', 'hi')] }
    const parsed = JSON.parse(prepareBody(JSON.stringify(body)))
    // 4027 回归：上游对 developer 直接整请求拒绝（invalid_parameter_error）
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
  })

  it('白名单内角色原样保留（system/user/assistant/tool 不被改写）', () => {
    const body = {
      model: 'glm-5.2',
      messages: [
        msg('system', 's'),
        msg('user', 'u'),
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'x' },
        msg('developer', 'd'),
      ],
    }
    const parsed = JSON.parse(prepareBody(JSON.stringify(body)))
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'system'])
  })
})

// ===== Remote 扁平 query 的多模态（源侧 trae_client.flatten_query 口径） =====

/** 取出扁平 query 里的整段文本（形态固定：单条 text block）。 */
function queryText(messages: unknown): string {
  return JSON.parse(flattenTraeQuery(messages))[0].data.content
}

describe('flattenTraeQuery：多模态图片（源侧不支持图片，结论已写进 contentToText 注释）', () => {
  it('文本与图片混排 → 文本保留，图片位置只留一个空元素（源侧 "\n".join 的实际输出）', () => {
    const text = queryText([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: '然后改配置' },
        ],
      },
    ])
    // 源侧 `parts.append(text or "")` 会为空块占一个元素，join 出来就是两个连续换行。
    expect(text).toBe('看图\n\n然后改配置')
  })

  it('纯图片消息 → 整段文本为空串（源侧就是丢掉，没有占位文案）', () => {
    expect(queryText([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }])).toBe('')
  })

  it('不发明新格式：base64、远程 URL、任何 image/Unsupported 占位都不得出现', () => {
    const text = queryText([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRETB64' } },
          { type: 'image_url', image_url: { url: 'https://example.com/secret.png' } },
        ],
      },
    ])
    expect(text).not.toContain('SECRETB64')
    expect(text).not.toContain('secret.png')
    expect(text.toLowerCase()).not.toContain('image')
    expect(text).not.toContain('Unsupported')
  })

  it('Anthropic 风格 image 块（source.base64）同样只留空元素', () => {
    const text = queryText([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'A' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SECRET' } },
        ],
      },
    ])
    expect(text).toBe('A\n')
  })

  it('图片消息不污染相邻消息的文本', () => {
    const text = queryText([
      { role: 'system', content: 'S' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
      { role: 'user', content: 'U' },
    ])
    expect(text).toBe('[System]\nS\n\n\n\nU')
  })

  it('多模态消息不改变 query 形态：仍是单条 text block', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'T' }] },
    ]))
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text')
    expect(out[0].data.content).toBe('\nT')
  })

  it('reasoning 块仍被丢弃（本仓库对源侧的有意分歧，与 remote.test.ts 同口径）', () => {
    const text = queryText([
      { role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'reasoning', text: 'SECRET' }] },
    ])
    expect(text).toBe('A')
  })

  it('renderer 的 value 块仍能取到文本（多模态改动不误伤这条路径）', () => {
    expect(queryText([{ role: 'user', content: [{ type: 'text', value: 'V' }] }])).toBe('V')
    expect(
      queryText([
        {
          role: 'user',
          content: [
            { type: 'tool_result', value: [{ type: 'text', value: 'R1' }, { type: 'text', value: 'R2' }] },
          ],
        },
      ]),
    ).toBe('R1\nR2')
  })

  it('非数组 messages → 仍是合法 JSON 且 content 为空（回归）', () => {
    expect(queryText(null)).toBe('')
  })
})

// ===== Remote 扁平 query 的附件块（官方 web 端形态：text 块 + attachment 块） =====

describe('flattenTraeQuery：attachment 块（**追加**，不改 text 块）', () => {
  const MESSAGES = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '看图' },
  ]
  const ATTACHMENT = {
    uri: 'trae-res://remote_resource/tos-cn-i-aiagcest/cn/u1/remote_resource/abc.trae',
    filename: 'PixPin_2026-10-14_14-16-32.png',
  }

  it('无附件 → 输出与加这个参数之前**逐字节相同**（省略参数 / 空对象 / 空数组三种写法）', () => {
    const before = flattenTraeQuery(MESSAGES)
    expect(flattenTraeQuery(MESSAGES, {})).toBe(before)
    expect(flattenTraeQuery(MESSAGES, { attachments: [] })).toBe(before)
    // 形态也不能变：仍是**单条** text 块。
    expect(JSON.parse(before)).toHaveLength(1)
  })

  it('有附件 → text 块一字不动，**追加** attachment 块（键序与官方一致）', () => {
    const out = JSON.parse(flattenTraeQuery(MESSAGES, { attachments: [ATTACHMENT] }))
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect(out[0].data.content).toBe('[System]\nS\n\n看图')
    expect(out[1]).toEqual({ type: 'attachment', data: ATTACHMENT })
    // 序列化后的键序也要对（上游按原文字节读，重排键序是没必要的风险）。
    expect(flattenTraeQuery(MESSAGES, { attachments: [ATTACHMENT] }))
      .toContain('{"type":"attachment","data":{"uri":"trae-res://')
  })

  it('多个附件按顺序追加', () => {
    const out = JSON.parse(flattenTraeQuery(MESSAGES, {
      attachments: [ATTACHMENT, { uri: 'trae-res://remote_resource/b.trae', filename: 'b.png' }],
    }))
    expect(out.map((b: { type: string }) => b.type)).toEqual(['text', 'attachment', 'attachment'])
    expect(out[2].data.filename).toBe('b.png')
  })

  it('空 uri 的附件被跳过（不发上游必然拒绝的空引用）', () => {
    const out = JSON.parse(flattenTraeQuery(MESSAGES, {
      attachments: [
        { uri: '', filename: 'x.png' },
        { uri: '   ', filename: 'y.png' },
        { uri: 'trae-res://remote_resource/ok.trae', filename: 'ok.png' },
      ],
    }))
    expect(out).toHaveLength(2)
    expect(out[1].data.uri).toBe('trae-res://remote_resource/ok.trae')
  })

  it('无文本 + 有附件 → 仍是合法的两块（text 块 content 为空串，不省略）', () => {
    const out = JSON.parse(flattenTraeQuery(null, { attachments: [ATTACHMENT] }))
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'text', data: { content: '' } })
  })
})

// ===== boundRemoteQuery：Remote 输入上限与压缩（移植 Trae2api-cn 2f2dc1a / e077061）=====
//
// 上游对超长 `query` 是静默失败（不发 done、直接关连接，约 480k）。目标侧此前完全没有上限，
// 面板的「历史总字符数上限」也因 `__budget` 只在 SOLO 路径注入而对 remote 提供商失效。
// 现在的口径：丢最旧回合 → 单条头尾截断 → 仍超限抛 413（不换号重放）。
describe('boundRemoteQuery：Remote query 上限与压缩', () => {
  const measure = (messages: unknown[], attachments?: Array<{ uri: string; filename: string }>): number =>
    flattenTraeQuery(messages, { attachments }).length

  it('未超限 → 内容不变，dropped/truncated 均为 0', () => {
    const messages = [msg('system', 'S'), msg('user', 'hello')]
    const r = boundRemoteQuery(messages, { maxChars: 100_000 })
    expect(r.droppedMessages).toBe(0)
    expect(r.truncatedMessages).toBe(0)
    expect(r.messages).toEqual(messages)
    expect(r.chars).toBe(measure(messages))
  })

  it('maxChars<=0 = 不设限（面板留空的显式语义），原样返回同一个数组', () => {
    const messages = [msg('user', 'x'.repeat(5000))]
    const r = boundRemoteQuery(messages, { maxChars: 0 })
    expect(r.messages).toBe(messages)
    expect(r.droppedMessages).toBe(0)
  })

  it('超限 → 先丢最旧的完整回合，system 与最后一条恒保留', () => {
    const messages = [msg('system', 'S'), msg('user', 'a'.repeat(400)), msg('user', 'newest')]
    const r = boundRemoteQuery(messages, { maxChars: 200 })
    expect(r.droppedMessages).toBe(1)
    expect(r.messages).toHaveLength(2)
    expect(asMsgs(r.messages).map((m) => m.role)).toEqual(['system', 'user'])
    expect(asMsgs(r.messages)[1].content).toBe('newest')
    expect(r.chars).toBeLessThanOrEqual(200)
  })

  it('单条超长消息 → 保留头尾并插入截断标记，总长压到上限内', () => {
    const messages = [msg('system', 'S'), msg('user', 'A'.repeat(3000))]
    const r = boundRemoteQuery(messages, { maxChars: 600 })
    expect(r.truncatedMessages).toBeGreaterThan(0)
    expect(r.chars).toBeLessThanOrEqual(600)
    const content = String(asMsgs(r.messages)[1].content)
    expect(content).toContain(TRAE_REMOTE_QUERY_TRUNCATION_MARKER)
    expect(content.startsWith('A')).toBe(true)
    expect(content.endsWith('A')).toBe(true)
  })

  it('压到上限内之后仍超限 → 抛 RemoteQueryTooLargeError（调用方据此返回 413 且不换号）', () => {
    const messages = [msg('user', 'A'.repeat(3000))]
    expect(() => boundRemoteQuery(messages, { maxChars: 60 })).toThrow(RemoteQueryTooLargeError)
  })

  it('图片 attachment 计入同一长度上限（仅图片就超限 → 直接抛，不让上游静默关流）', () => {
    const attachments = [{ uri: 'trae-res://remote_resource/' + 'x'.repeat(300) + '.trae', filename: 'a.png' }]
    expect(() => boundRemoteQuery([], { maxChars: 100, attachments })).toThrow(RemoteQueryTooLargeError)
  })

  it('默认上限常量对齐源侧约 480k', () => {
    expect(TRAE_REMOTE_QUERY_MAX_CHARS).toBe(480_000)
  })

  it('工具配对不被拆散：丢弃历史时保留 tool 消息与结构字段', () => {
    const messages = [
      msg('system', 'S'),
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'Bash', content: 'ok' },
      msg('user', 'next'),
    ]
    const r = boundRemoteQuery(messages, { maxChars: 400 })
    // 压缩只动 content，不删 tool_calls / tool_call_id 等结构字段
    const kept = asMsgs(r.messages).filter((m) => m.role === 'assistant')
    for (const m of kept) expect(Array.isArray(m.tool_calls)).toBe(true)
  })
})