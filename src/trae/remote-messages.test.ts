/**
 * remote-messages.test.ts — Remote 请求体的源侧消息预处理（工具目录提示 + 工具任务锚点）。
 *
 * 这层要钉住的是「**不注入**」比「注入」更容易出错的三件事：
 *  1. 条件不满足时**必须原样返回**（多插一条 system 会把上游带偏，且很难从现象回推）；
 *  2. 注入的两条 system 必须排在**全部对话轮之前** —— 否则压缩第一轮就把它们丢了，
 *     功能等于没做，而且日志上完全看不出来；
 *  3. 工具目录提示的**措辞与序列化格式**逐字来自源侧，改一个字都可能让上游不再照做。
 *
 * 源侧对应实现：`main.py` `_remote_client_tool_task_anchor`（5729 行起）、
 * `trae_client.py` `_messages_with_client_runtime`（1119 行）、
 * `raw_client.py` `build_runtime_system_prompt`（813 行）。
 */
import { describe, expect, it } from 'vitest'
import {
  countImageBlocks,
  historyHasToolProtocol,
  prepareRemoteMessages,
  type RemoteMessagePrepOptions,
} from './remote-messages'

/** 源侧那段英文提示词（逐字，用来钉住注入内容）。 */
const PREAMBLE =
  'Active caller task retained during history compaction. The latest user message is only a continuation request. Continue the task below. For any caller-side download or file change, emit the matching client tool call and wait for its result; do not claim success from a remote/internal tool.\n\n'

/** 源侧中段省略标记。 */
const MARKER = '\n...[task middle omitted]...\n'

const WITH_TOOLS: RemoteMessagePrepOptions = { hasTools: true }
const NO_TOOLS: RemoteMessagePrepOptions = { hasTools: false }

/** 造一条消息。 */
function msg(role: string, content: unknown): Record<string, any> {
  return { role, content }
}

/** 取出注入的锚点（按源侧提示词开头识别），没注入返回 undefined。 */
function anchorOf(out: unknown): Record<string, any> | undefined {
  if (!Array.isArray(out)) return undefined
  return out.find(
    (m: any) => m && typeof m === 'object' && typeof m['content'] === 'string' && m['content'].startsWith(PREAMBLE),
  ) as Record<string, any> | undefined
}

/** 只看角色序列，便于断言插入位置。 */
function rolesOf(out: unknown): string[] {
  return (Array.isArray(out) ? out : []).map((m: any) => String(m && m['role']))
}

// ===== 注入条件（源侧判定顺序照抄） =====

describe('prepareRemoteMessages：条件满足才注入锚点', () => {
  it('带 tools + 最后一条 user 是「继续」→ 注入 system 锚点，内容含前一条真实请求', () => {
    const out = prepareRemoteMessages(
      [msg('user', '把 https://example.com/a.zip 下到 D:/dl'), msg('user', '继续')],
      WITH_TOOLS,
    )
    const anchor = anchorOf(out)
    expect(anchor).toBeDefined()
    expect(anchor!['role']).toBe('system')
    // 真实请求必须原样带进锚点（URL 与目标路径就是压缩后最容易被丢掉的东西）
    expect(anchor!['content']).toBe(PREAMBLE + '把 https://example.com/a.zip 下到 D:/dl')
  })

  it('hasTools=false → 绝不注入（即使「继续」条件全满足）', () => {
    const messages = [msg('user', '真实请求'), msg('user', '继续')]
    const out = prepareRemoteMessages(messages, NO_TOOLS)
    expect(anchorOf(out)).toBeUndefined()
    expect(rolesOf(out)).toEqual(['user', 'user'])
    expect(out).toEqual(messages)
  })

  it('最后一条 user 不是纯继续 → 不注入', () => {
    const out = prepareRemoteMessages(
      [msg('user', '真实请求'), msg('user', '继续处理这个文件')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)).toBeUndefined()
    expect(rolesOf(out)).toEqual(['user', 'user'])
  })

  it('只有一条 user → 不注入（「最近一条真正的请求」不存在）', () => {
    const out = prepareRemoteMessages([msg('user', '继续')], WITH_TOOLS)
    expect(anchorOf(out)).toBeUndefined()
    expect(rolesOf(out)).toEqual(['user'])
  })

  it('前面那条也是「继续」→ 跳过它，锚到更早的真实请求', () => {
    const out = prepareRemoteMessages(
      [msg('user', '真实请求'), msg('user', '继续'), msg('user', '接着做')],
      WITH_TOOLS,
    )
    const anchor = anchorOf(out)
    expect(anchor).toBeDefined()
    expect(anchor!['content']).toBe(PREAMBLE + '真实请求')
  })

  it('前面全是「继续」→ 不注入（没有可锚的任务）', () => {
    const out = prepareRemoteMessages(
      [msg('user', '继续'), msg('user', '接着做'), msg('user', 'continue')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)).toBeUndefined()
  })

  it('中间隔着 assistant / tool 消息，仍锚到最近一条 user 请求', () => {
    const out = prepareRemoteMessages(
      [
        msg('user', '真实请求'),
        msg('assistant', '好的'),
        msg('tool', '结果'),
        msg('user', '继续'),
      ],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(PREAMBLE + '真实请求')
  })

  it('空 content 的 user 消息不计入（只有一条真请求时仍不注入）', () => {
    const out = prepareRemoteMessages([msg('user', []), msg('user', '继续')], WITH_TOOLS)
    expect(anchorOf(out)).toBeUndefined()
  })

  it('缺 role 的消息按 user 算（源侧 `message.get("role") or "user"`）', () => {
    const out = prepareRemoteMessages(
      [{ content: '把文件下到 D:/out' }, msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(PREAMBLE + '把文件下到 D:/out')
  })
})

// ===== 纯继续的判定口径 =====

describe('prepareRemoteMessages：「纯继续」的正则口径（照抄源侧 _CONTINUATION_ONLY_RE）', () => {
  /** 造一个「真实请求 + 指定尾句」的会话，返回是否注入了锚点。 */
  function injectsFor(last: string): boolean {
    return anchorOf(prepareRemoteMessages([msg('user', '真实请求'), msg('user', last)], WITH_TOOLS)) !== undefined
  }

  it('中文续跑词全部命中（含源侧原样的 `j继续` 笔误）', () => {
    for (const text of ['继续', '继续执行', '继续完成', '继续处理', '继续下载', '继续安装', '继续操作', '继续进行', '继续做', '接着', '接着做', '接着执行', '接着处理', '往下继续', '下一步', 'j继续']) {
      expect(injectsFor(text), text).toBe(true)
    }
  })

  it('英文续跑词全部命中，且大小写不敏感', () => {
    for (const text of ['continue', 'Continue', 'CONTINUE', 'continue it', 'continue this', 'continue working', 'go on', 'Go On', 'proceed', 'keep going', 'resume']) {
      expect(injectsFor(text), text).toBe(true)
    }
  })

  it('尾随标点/空白不影响命中', () => {
    for (const text of ['继续。', '继续！', '继续!', '继续?', '继续？', 'continue!', 'continue.', '继续 ']) {
      expect(injectsFor(text), text).toBe(true)
    }
  })

  it('带任务内容的句子不算纯继续（不做子串匹配）', () => {
    for (const text of ['继续吧', '请继续', '继续处理这个文件', 'continue please', 'resume the task', 'proceeding', '下一步怎么办']) {
      expect(injectsFor(text), text).toBe(false)
    }
  })
})

// ===== 插入位置 =====

describe('prepareRemoteMessages：锚点位置必须排在全部对话轮之前', () => {
  it('首条是 system → 插到 1 号位（源侧 prepared_messages[0] 之后）', () => {
    const out = prepareRemoteMessages(
      [msg('system', '客户端系统提示词'), msg('user', '真实请求'), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(rolesOf(out)).toEqual(['system', 'system', 'user', 'user'])
    expect((out as any[])[0]['content']).toBe('客户端系统提示词')
    expect(anchorOf(out)).toBe((out as any[])[1])
  })

  it('首条是 developer → 同样插到 1 号位', () => {
    const out = prepareRemoteMessages(
      [msg('developer', 'D'), msg('user', '真实请求'), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(rolesOf(out)).toEqual(['developer', 'system', 'user', 'user'])
  })

  it('首条不是 system → 插到最前', () => {
    const out = prepareRemoteMessages(
      [msg('user', '真实请求'), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(rolesOf(out)).toEqual(['system', 'user', 'user'])
    expect(anchorOf(out)).toBe((out as any[])[0])
  })
})

// ===== 超长截断 =====

describe('prepareRemoteMessages：真实请求超长时的首尾截断', () => {
  it('超过 16000 字符 → 前 8000 + 省略标记 + 后 8000', () => {
    const head = 'A'.repeat(8_000)
    const middle = 'M'.repeat(4_000)
    const tail = 'Z'.repeat(8_000)
    const out = prepareRemoteMessages([msg('user', head + middle + tail), msg('user', '继续')], WITH_TOOLS)
    const anchor = anchorOf(out)!
    expect(anchor['content']).toBe(PREAMBLE + head + MARKER + tail)
    expect(anchor['content']).not.toContain('MMMM')
  })

  it('恰好 16000 字符 → 不截断（源侧判的是 `len > 16000`）', () => {
    const text = 'A'.repeat(16_000)
    const out = prepareRemoteMessages([msg('user', text), msg('user', '继续')], WITH_TOOLS)
    const anchor = anchorOf(out)!
    expect(anchor['content']).toBe(PREAMBLE + text)
    expect(anchor['content']).not.toContain(MARKER)
  })

  it('16001 字符 → 开始截断', () => {
    const text = 'A'.repeat(16_001)
    const out = prepareRemoteMessages([msg('user', text), msg('user', '继续')], WITH_TOOLS)
    expect(anchorOf(out)!['content']).toContain(MARKER)
  })

  it('emoji 不会被按 UTF-16 码元砍成半个代理对（源侧 len() 数码点）', () => {
    // 16001 个 emoji：.length 是 32002，码点数是 16001 → 必须按码点截断
    const text = '😀'.repeat(16_001)
    const out = prepareRemoteMessages([msg('user', text), msg('user', '继续')], WITH_TOOLS)
    const content = anchorOf(out)!['content'] as string
    expect(content).toContain(MARKER)
    // 截断后仍是合法字符串（没有孤立代理项）
    expect([...content].every((ch) => ch.length > 0)).toBe(true)
    expect(content.slice(PREAMBLE.length).startsWith('😀'.repeat(8_000))).toBe(true)
    expect(content.endsWith('😀'.repeat(8_000))).toBe(true)
  })
})

// ===== 不可变性 =====

describe('prepareRemoteMessages：返回新数组，绝不改入参', () => {
  it('注入时返回新数组，入参内容与顺序不变', () => {
    const messages = [msg('system', 'S'), msg('user', '真实请求'), msg('user', '继续')]
    const snapshot = JSON.parse(JSON.stringify(messages))
    const out = prepareRemoteMessages(messages, WITH_TOOLS)
    expect(out).not.toBe(messages)
    expect(messages).toEqual(snapshot)
    expect(messages.length).toBe(3)
    expect(anchorOf(out)).toBeDefined()
  })

  it('不注入时也返回新数组（内容原样，不是同一个引用）', () => {
    const messages = [msg('user', '真实请求'), msg('user', '继续处理这个文件')]
    const out = prepareRemoteMessages(messages, WITH_TOOLS)
    expect(out).not.toBe(messages)
    expect(out).toEqual(messages)
  })

  it('非数组入参 → 原样返回（不注入也不抛）', () => {
    expect(prepareRemoteMessages(null, WITH_TOOLS)).toBeNull()
    expect(prepareRemoteMessages(undefined, WITH_TOOLS)).toBeUndefined()
    expect(prepareRemoteMessages('not-an-array', WITH_TOOLS)).toBe('not-an-array')
  })
})

// ===== 取文语义（源侧 raw_client._content_to_text，与 flatten 口径不同） =====

describe('prepareRemoteMessages：锚点取文用源侧 raw_client 口径', () => {
  it('content 是文本块数组 → 能取到文本', () => {
    const out = prepareRemoteMessages(
      [msg('user', [{ type: 'text', text: '真实请求' }]), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(PREAMBLE + '真实请求')
  })

  it('图片块产出 [Unsupported image_url input omitted]（flatten 那边是空串，两处刻意分叉）', () => {
    const out = prepareRemoteMessages(
      [
        msg('user', [
          { type: 'text', text: '下载这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]),
        msg('user', '继续'),
      ],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(
      PREAMBLE + '下载这张图\n[Unsupported image_url input omitted]',
    )
  })

  it('纯图片的 user 消息算「有内容」（占位文案让它非空）', () => {
    const out = prepareRemoteMessages(
      [msg('user', [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(PREAMBLE + '[Unsupported image_url input omitted]')
  })

  it('renderer 的 value 块能取到文本（不取 value 会读成空）', () => {
    const out = prepareRemoteMessages(
      [msg('user', [{ type: 'text', value: '渲染器形态的真实请求' }]), msg('user', '继续')],
      WITH_TOOLS,
    )
    expect(anchorOf(out)!['content']).toBe(PREAMBLE + '渲染器形态的真实请求')
  })
})

// ===== 工具目录 → system 提示（源侧 raw_client.build_runtime_system_prompt） =====

/** 取出注入的工具目录提示（按源侧首行识别），没注入返回 undefined。 */
function toolPromptOf(out: unknown): string | undefined {
  if (!Array.isArray(out)) return undefined
  const found = out.find(
    (m: any) => m && typeof m === 'object' && typeof m['content'] === 'string' && m['content'].startsWith('You are Trae Code connected'),
  ) as Record<string, any> | undefined
  return found ? String(found['content']) : undefined
}

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}

/**
 * 单个工具时的**完整**提示词（逐字对照源侧 `raw_client.py:832-887`）。
 * 这里刻意写全，改一个字测试就红 —— 措辞本身就是这段代码的功能。
 */
const EXPECTED_TOOL_PROMPT = [
  "You are Trae Code connected to the user's local application.",
  'The external Trae-compatible terminal client application that started this conversation provides the client tools below.',
  'Caller client context (JSON):',
  '{"tool_discovery":{"mode":"automatic","plugin_namespaces":[],"tool_search_available":false,"tool_search_tools":[],"environment_probe_tools":["read_file"]}}',
  'Discover the local environment through the available client tools when the request requires it.',
  'If a tool can answer the question, call it proactively and wait for the external client result.',
  'Remote or server-side tools cannot write into the caller workspace. Never claim that a client file was downloaded, created, edited, patched, or saved unless a later matching client tool result with the same call id confirms success.',
  'A tool request, emitted tool-call block, plan, or assistant narration is not execution proof. If the matching client result reports failure, state the failure or request a corrective client tool; never report the operation as completed.',
  "Never repeat a completed tool call; do not describe that server's Linux filesystem as the caller workspace.",
  "Client tools are NOT native/server functions: never invoke them through function calling or any built-in tool, and never fall back to server tools (LS, Glob, Read, terminal) to reach the caller's files. The only way to call a client tool is the text block below; a native call reports 'not available' because the tool lives on the client.",
  'To use tools, emit only one or more JSON blocks and include no prose or final answer in that turn:',
  '<opencode_tool_call>{"name":"tool_name","input":{}}</opencode_tool_call>',
  'Do not invent an id field; the client assigns call ids. Keep file paths exactly as the user or tool result gave them.',
  'Fill input according to the selected tool schema and wait for the client result before continuing.',
  'Available client tool definitions and input schemas (JSON):',
  '[{"name":"read_file","description":"读取文件","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]',
  'To call a tool, emit one block per call in this format and no prose or final answer in the same turn: <opencode_tool_call>{"name":"tool_name","input":{}}</opencode_tool_call>. Omit the id field (the client assigns it), use an exact declared tool name, and fill input according to that tool\'s schema.',
  "After the client returns a tool result, continue from that result until the user's request is complete.",
].join('\n')

/** 造一个大目录（用于触发 schema 预算的紧凑签名分支）。 */
function bigCatalog(count: number): Array<Record<string, any>> {
  const pad = 'x'.repeat(100)
  return Array.from({ length: count }, (_, i) => ({
    type: 'function',
    function: {
      name: i === 0 ? 'tool_search' : `tool_${i}`,
      description: pad,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          mode: { type: 'string', enum: ['a', 'b'] },
          list: { type: 'array', items: { type: 'string' } },
          anything: { description: '没有 type 的字段' },
        },
      },
    },
  }))
}

describe('prepareRemoteMessages：工具目录 system 提示（Remote 的 query 发不出结构化 tools）', () => {
  it('带 tools → 0 号位插入工具提示，且提示全文逐字对齐源侧', () => {
    const out = prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: [READ_FILE_TOOL] })
    expect(rolesOf(out)).toEqual(['system', 'user'])
    expect(toolPromptOf(out)).toBe(EXPECTED_TOOL_PROMPT)
  })

  it('工具名与 schema 用源侧的 name/description/input_schema 三字段形态序列化', () => {
    const prompt = toolPromptOf(prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: [READ_FILE_TOOL] }))!
    expect(prompt).toContain('"name":"read_file"')
    expect(prompt).toContain('"input_schema":{"type":"object"')
  })

  it('原生形态工具（顶层 name/input_schema）同样识别', () => {
    const out = prepareRemoteMessages([msg('user', 'hi')], {
      hasTools: true,
      tools: [{ name: 'shell', description: '跑命令', input_schema: { type: 'object' } }],
    })
    const prompt = toolPromptOf(out)!
    expect(prompt).toContain('"name":"shell"')
    expect(prompt).toContain('"input_schema":{"type":"object"}')
  })

  it('重名工具只保留第一个（源侧 seen_names 去重）', () => {
    const out = prepareRemoteMessages([msg('user', 'hi')], {
      hasTools: true,
      tools: [READ_FILE_TOOL, READ_FILE_TOOL],
    })
    const prompt = toolPromptOf(out)!
    const payload = prompt.split('\n').find((line) => line.startsWith('[{"name":"read_file"'))!
    expect(JSON.parse(payload)).toHaveLength(1)
  })

  it('tools 缺失 / 空数组 / 非数组 / 无合法工具 → 不插提示', () => {
    const cases: RemoteMessagePrepOptions[] = [
      { hasTools: true },
      { hasTools: true, tools: [] },
      { hasTools: true, tools: 'not-an-array' },
      { hasTools: true, tools: null },
      { hasTools: true, tools: [{ type: 'function', function: { description: '没有 name' } }] },
      { hasTools: true, tools: ['garbage', 42] },
    ]
    for (const opts of cases) {
      const out = prepareRemoteMessages([msg('user', 'hi')], opts)
      expect(toolPromptOf(out), JSON.stringify(opts)).toBeUndefined()
      expect(rolesOf(out)).toEqual(['user'])
    }
  })

  it('hasTools=false 但带 tools → 仍插工具提示（源侧只看请求体有没有 tools），只是不插锚点', () => {
    const out = prepareRemoteMessages([msg('user', '真实请求'), msg('user', '继续')], {
      hasTools: false,
      tools: [READ_FILE_TOOL],
    })
    expect(toolPromptOf(out)).toBeDefined()
    expect(anchorOf(out)).toBeUndefined()
    expect(rolesOf(out)).toEqual(['system', 'user', 'user'])
  })

  it('目录超预算 → 退化成紧凑签名（保留全部工具名 + 尽量多的字段签名）', () => {
    const catalog = bigCatalog(600)
    const prompt = toolPromptOf(prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: catalog }))!
    expect(prompt).toContain('compact input signatures')
    expect(prompt).toContain('signature(s) are name-only')
    const lines = prompt.split('\n')
    const labelIdx = lines.findIndex((line) => line.includes('compact input signatures'))
    const payload = JSON.parse(lines[labelIdx + 1])
    expect(payload.available_tools).toHaveLength(600)
    expect(payload.available_tools[0]).toBe('tool_search')
    // 发现类工具排第一（否则被裁掉的可能正是「能找到工具的那个工具」）
    expect(payload.signatures[0].name).toBe('tool_search')
    expect(payload.signatures.length).toBeGreaterThan(0)
    expect(payload.signatures.length).toBeLessThan(600)
    expect(payload.omitted_signatures).toBe(600 - payload.signatures.length)
    // 提示整体确实被预算住了（固定行约 1.9k 字符 + 48k 预算）
    expect(prompt.length).toBeLessThan(48_000 + 4_000)
  })

  it('紧凑签名保留字段类型/enum/items，无信息的字段退化成 "any"', () => {
    const catalog = bigCatalog(600)
    const prompt = toolPromptOf(prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: catalog }))!
    const lines = prompt.split('\n')
    const payload = JSON.parse(lines[lines.findIndex((line) => line.includes('compact input signatures')) + 1])
    const fields = payload.signatures[0].fields
    expect(fields.path).toEqual({ type: 'string' })
    expect(fields.mode).toEqual({ type: 'string', enum: ['a', 'b'] })
    expect(fields.list).toEqual({ type: 'array', items: 'string' })
    expect(fields.anything).toBe('any')
  })

  it('未移植的源侧片段确实不在提示里（缺 tool_choice / parallel_tool_calls / 风格指令载体）', () => {
    const prompt = toolPromptOf(prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: [READ_FILE_TOOL] }))!
    expect(prompt).not.toContain('Tool choice')
    expect(prompt).not.toContain('at most one tool per turn')
    expect(prompt).not.toContain('Response format:')
  })

  it('不编造 client context：没有 workspace_path / system_type（源侧警告编路径会让模型改写相对路径）', () => {
    const prompt = toolPromptOf(prepareRemoteMessages([msg('user', 'hi')], { hasTools: true, tools: [READ_FILE_TOOL] }))!
    expect(prompt).not.toContain('workspace_path')
    expect(prompt).not.toContain('system_type')
    expect(prompt).not.toContain('terminal_context')
    expect(prompt).not.toContain('declared_tools')
  })

  it('注入工具提示时不改入参', () => {
    const messages = [msg('system', 'S'), msg('user', 'hi')]
    const snapshot = JSON.parse(JSON.stringify(messages))
    prepareRemoteMessages(messages, { hasTools: true, tools: [READ_FILE_TOOL] })
    expect(messages).toEqual(snapshot)
    expect(messages.length).toBe(2)
  })
})

describe('prepareRemoteMessages：工具提示与锚点的相对顺序（源侧 main.py:6320-6323）', () => {
  it('两条都注入 → [工具提示, 锚点, …原始消息]（锚点排在客户端自己的 system 之前）', () => {
    const out = prepareRemoteMessages(
      [msg('system', '客户端系统提示词'), msg('user', '真实请求'), msg('user', '继续')],
      { hasTools: true, tools: [READ_FILE_TOOL] },
    )
    // 源侧 `[prepared[0], task_anchor, *prepared[1:]]`：锚点紧跟在工具提示之后，
    // 而不是跟在客户端原有的 system 之后。
    expect(rolesOf(out)).toEqual(['system', 'system', 'system', 'user', 'user'])
    expect(toolPromptOf(out)).toBe((out as any[])[0]['content'])
    expect(anchorOf(out)).toBe((out as any[])[1])
    expect((out as any[])[2]['content']).toBe('客户端系统提示词')
  })

  it('只注入工具提示（最后一条不是「继续」）→ 不插锚点', () => {
    const out = prepareRemoteMessages(
      [msg('user', '真实请求'), msg('user', '继续处理这个文件')],
      { hasTools: true, tools: [READ_FILE_TOOL] },
    )
    expect(rolesOf(out)).toEqual(['system', 'user', 'user'])
    expect(anchorOf(out)).toBeUndefined()
  })
})

// ===== historyHasToolProtocol（源侧 _message_contains_tool_protocol） =====

describe('historyHasToolProtocol：历史里的工具协议（决定要不要并进 hasTools）', () => {
  it('role=tool / function 命中', () => {
    expect(historyHasToolProtocol([{ role: 'tool', content: 'x' }])).toBe(true)
    expect(historyHasToolProtocol([{ role: 'function', content: 'x' }])).toBe(true)
    expect(historyHasToolProtocol([{ role: ' TOOL ', content: 'x' }])).toBe(true)
  })

  it('assistant.tool_calls 非空命中，空数组不命中', () => {
    expect(historyHasToolProtocol([{ role: 'assistant', tool_calls: [{ id: 'c1' }] }])).toBe(true)
    expect(historyHasToolProtocol([{ role: 'assistant', tool_calls: [] }])).toBe(false)
  })

  it('assistant.function_call 只要是对象就命中（源侧不判空，照抄这个不对称）', () => {
    expect(historyHasToolProtocol([{ role: 'assistant', function_call: {} }])).toBe(true)
    expect(historyHasToolProtocol([{ role: 'assistant', function_call: 'nope' }])).toBe(false)
  })

  it('content 里的 tool_use / tool_call / function_call / tool_result 块命中（含大小写与空格）', () => {
    for (const type of ['tool_use', 'tool_call', 'function_call', 'tool_result', ' Tool_Use ']) {
      expect(historyHasToolProtocol([{ role: 'user', content: [{ type }] }]), type).toBe(true)
    }
  })

  it('TraeWork 渲染器把结果挂在 role=user 上也算命中', () => {
    expect(
      historyHasToolProtocol([
        { role: 'user', content: [{ type: 'tool_result', value: [{ type: 'text', value: 'ok' }] }] },
      ]),
    ).toBe(true)
  })

  it('普通对话 / 非数组 / 脏元素 → false', () => {
    expect(historyHasToolProtocol([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }])).toBe(false)
    expect(historyHasToolProtocol([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(false)
    expect(historyHasToolProtocol(null)).toBe(false)
    expect(historyHasToolProtocol('nope')).toBe(false)
    expect(historyHasToolProtocol([null, 42, 'x', []])).toBe(false)
  })
})

// ===== countImageBlocks（诊断：Remote 会静默丢图） =====

describe('countImageBlocks：图片块计数（图片被静默丢弃，只能靠日志暴露）', () => {
  it('OpenAI image_url 与 Anthropic image 都计入', () => {
    expect(
      countImageBlocks([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA' } }] },
      ]),
    ).toBe(2)
  })

  it('同一消息里文本与图片混排也只数图片', () => {
    expect(
      countImageBlocks([
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'https://x/a.png' } },
            { type: 'text', text: '再改配置' },
            { type: 'image_url', image_url: { url: 'https://x/b.png' } },
          ],
        },
      ]),
    ).toBe(2)
  })

  it('大小写与空格归一（上游/客户端形态不统一）', () => {
    expect(countImageBlocks([{ role: 'user', content: [{ type: ' Image_URL ' }] }])).toBe(1)
  })

  it('无图 / 非数组 / 脏元素 → 0（不能把「没图」误报成有图）', () => {
    expect(countImageBlocks([{ role: 'user', content: 'hi' }])).toBe(0)
    expect(countImageBlocks([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(0)
    expect(countImageBlocks(null)).toBe(0)
    expect(countImageBlocks('nope')).toBe(0)
    expect(countImageBlocks([null, 1, 'x', [], { role: 'user', content: [null, 'x', []] }])).toBe(0)
  })

  it('url 为空也计数（计数器的用途是「有没有图被丢」，不是「图能不能用」）', () => {
    expect(countImageBlocks([{ role: 'user', content: [{ type: 'image_url' }] }])).toBe(1)
  })
})
