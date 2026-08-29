/**
 * M365 工具协议（移植自 M365-Copilot2API internal/chathub/tool_protocol.go + internal/web/prompt.go + toolloop.go）。
 *
 * 原理：ChatHub 上游不支持标准 OpenAI function calling，采用"提示词注入 + fenced block"约定：
 * - 工具定义包装在 <tools> 文本块注入 prompt，告知模型可调用
 * - 模型要调用工具时，输出 <m365-tool-call>{"name","arguments"}</m365-tool-call> fenced block
 * - 网关解析该块为标准 tool_calls 返回客户端，客户端执行后用 tool 结果续聊（客户端驱动循环）
 */
import type { ChatHubTool } from './chathub'
import { parseToolCalls } from '../cnb/xyml'

/** 由客户端 tool 定义构造的简化结构 */
export interface ToolDef {
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}

/** 无工具请求注入的防截断前缀（同原版：避免长回答被模型截断） */
const ANTI_TRUNCATION_PREFIX =
  'You are a helpful AI assistant. Provide a complete, thorough answer to the request. ' +
  'Do not truncate or stop partway through your response; cover all relevant points until the answer is fully delivered.\n\n'

/** 原生插件通道的身份/工具可用声明前缀：插件定义在 payload 的 plugins 字段已携带，文本仅需声明可用性 */
const PLUGIN_AGENT_PREFIX =
  'You are an execution agent on the caller\'s Windows machine. The registered plugins in this conversation are real, active, and callable right now.\n' +
  'When the user\'s request requires one, call the appropriate plugin with its defined parameters. ' +
  'Do not analyze whether plugins are registered or available — they are. Do not say a plugin is unavailable. ' +
  'Wait for the plugin result before claiming completion.\n' +
  'You are NOT running in a sandbox/container, and there is no built-in code interpreter; only the registered plugins are available.\n\n'

/**
 * 工具定义注入提示词（同原版 toolProtocolPrompt）。
 * - 无工具 / tool_choice=none：注入防截断前缀（原版对每个无工具请求均注入）。
 * - 有原生插件（hasPlugins）：payload 的 plugins 字段已携带工具定义，故不重复注入 <tools> 块，
 *   但补上身份声明/工具可用提示，防止模型「不知道有工具」或产生沙箱幻觉。
 * - 有工具但非原生插件：注入完整 <tools> 块，支持一个或多个 fenced block（并行多调用），
 *   并明确「不要使用内置 code interpreter / Python 沙箱」防幻觉段。
 */
export function toolProtocolPrompt(text: string, tools: ToolDef[], choice: unknown, hasPlugins: boolean): string {
  const hasTools = tools && tools.length > 0 && String(choice).toLowerCase() !== 'none'
  if (!hasTools) {
    return ANTI_TRUNCATION_PREFIX + text
  }
  if (hasPlugins) {
    // 原生插件通道：把可用性声明放到用户请求之前，让模型明确知道工具可调用且非沙盒。
    // 若 text 已带防截断前缀则避免叠加（防截断前缀只出现在无工具分支，此处通常不会命中）。
    const body = text
    return PLUGIN_AGENT_PREFIX + body
  }
  const defs: string[] = []
  for (const t of tools) {
    const f = t.function
    if (!f || !f.name) continue
    let params = '{}'
    try {
      const s = f.parameters === undefined ? '' : JSON.stringify(f.parameters)
      if (s && s !== 'null' && s.trim() !== '') params = s
    } catch { /* keep {} */ }
    defs.push(`${f.name} — ${f.description || ''}\n\`\`\`${f.name}\n${params}\n\`\`\``)
  }
  if (defs.length === 0) return ANTI_TRUNCATION_PREFIX + text
  return (
    'You are an execution agent on the caller\'s Windows machine. The tools below are real, active, and callable right now. ' +
    'The bash tool runs Windows PowerShell 5.1; Windows paths like D:\\ are directly accessible.\n' +
    'When the user\'s request requires a tool, call it by emitting one or more fenced blocks, each having the exact tool name ' +
    'as its info string and a JSON object of arguments as its body (multiple calls may be issued in parallel as separate blocks). ' +
    'Do not analyze whether tools are registered or available — they are. ' +
    'Do not say a tool is unavailable. Do not wrap the call in XML or Markdown prose. Wait for the tool result before claiming completion.\n' +
    'You are NOT allowed to use any built-in code interpreter or Python sandbox; only call the caller tools listed below.\n\n' +
    `<tools>\n${defs.join('\n\n')}\n</tools>\n\n` +
    `User request:\n${text}`
  )
}

export interface DetectedToolCall {
  id: string
  type: string
  name: string
  arguments: string
}

function allowedToolNames(tools: ToolDef[]): Set<string> {
  const out = new Set<string>()
  for (const t of tools) {
    if (t.function?.name) out.add(t.function.name)
  }
  return out
}

function toolTypeOf(name: string, tools: ToolDef[]): string {
  for (const t of tools) {
    if (t.function?.name === name) {
      if (t.type) return t.type
    }
  }
  return 'function'
}

function toolChoiceAllows(choice: unknown, name: string): boolean {
  if (choice === undefined || choice === null) return true
  if (typeof choice === 'string') {
    return choice !== 'none' && (choice !== 'required' || name !== '')
  }
  if (typeof choice === 'object') {
    const c = choice as Record<string, unknown>
    const f = c['function'] as Record<string, unknown> | undefined
    if (f && typeof f['name'] === 'string') return f['name'] === name
    if (typeof c['name'] === 'string') return c['name'] === name
  }
  return true
}

/** tool_choice 归一化：string 直接返回；命名选择器返回 'named:<name>'；默认 'auto'（同原版 normalizedToolChoiceMode） */
export function normalizedToolChoiceMode(choice: unknown): string {
  if (choice === undefined || choice === null) return 'auto'
  if (typeof choice === 'string') return choice
  if (typeof choice === 'object') {
    const c = choice as Record<string, unknown>
    const f = c['function'] as Record<string, unknown> | undefined
    if (f && typeof f['name'] === 'string') return 'named:' + f['name']
    if (typeof c['name'] === 'string') return 'named:' + c['name']
  }
  return 'auto'
}

/** 按名称查找工具定义（返回 function 对象），未找到返回 null（同原版 toolFunction） */
export function toolFunction(name: string, tools: ToolDef[]): Record<string, unknown> | null {
  for (const t of tools) {
    const f = t.function
    if (f && f.name === name) return f as unknown as Record<string, unknown>
  }
  return null
}

/** JSON Schema 校验（同原版 validateJSONSchema）。返回错误信息或 null。
 *  安全护栏（同对方 tool-schema.ts）：MAX_SCHEMA_DEPTH=64 限制递归深度、
 *  MAX_VALIDATION_NODES=50000 限制单次校验遍历节点数，防止调用方 schema 引发远程引用/无限递归。 */
const MAX_SCHEMA_DEPTH = 64
const MAX_VALIDATION_NODES = 50000
export function validateJSONSchema(value: unknown, schema: Record<string, unknown>, path: string, depth = 0, state?: { nodes: number }): string | null {
  const st = state ?? { nodes: 0 }
  st.nodes++
  if (st.nodes > MAX_VALIDATION_NODES) return `${path} validation nodes exceeded safe limit`
  if (depth > MAX_SCHEMA_DEPTH) return `${path} schema exceeds max depth`
  const enums = schema['enum']
  if (Array.isArray(enums)) {
    const a = JSON.stringify(value)
    let found = false
    for (const e of enums) {
      if (JSON.stringify(e) === a) { found = true; break }
    }
    if (!found) return `${path} is not an allowed enum value`
  }
  const typ = schema['type']
  switch (typ) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path} must be object`
      const m = value as Record<string, unknown>
      const req = schema['required']
      if (Array.isArray(req)) {
        for (const raw of req) {
          const n = String(raw)
          if (!(n in m)) return `missing required argument ${n}`
        }
      }
      const props = (schema['properties'] as Record<string, unknown>) || {}
      const ap = schema['additionalProperties']
      if (typeof ap === 'boolean' && !ap) {
        for (const n of Object.keys(m)) {
          if (!(n in props)) return `${path}.${n} is not allowed`
        }
      }
      for (const n of Object.keys(m)) {
        const ps = props[n] as Record<string, unknown> | undefined
        if (ps) {
          const err = validateJSONSchema(m[n], ps, `${path}.${n}`, depth + 1, st)
          if (err) return err
        }
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be array`
      const item = schema['items'] as Record<string, unknown> | undefined
      if (item) {
        for (let i = 0; i < value.length; i++) {
          const err = validateJSONSchema(value[i], item, `${path}[${i}]`, depth + 1, st)
          if (err) return err
        }
      }
      return null
    }
    case 'string':
      return typeof value === 'string' ? null : `${path} must be string`
    case 'number':
      return typeof value === 'number' ? null : `${path} must be number`
    case 'integer': {
      if (typeof value !== 'number' || Math.trunc(value) !== value) return `${path} must be integer`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be boolean`
    case 'null':
      return value === null ? null : `${path} must be null`
    default:
      return null
  }
}

function schemaValid(args: Record<string, unknown>, fn: Record<string, unknown>): string | null {
  const params = fn['parameters']
  if (params === null || typeof params !== 'object') return null
  return validateJSONSchema(args, params as Record<string, unknown>, 'arguments')
}

/**
 * 工具调用信任边界校验（同原版 tooldecision.go validateDetectedToolCalls）。
 * 模型输出天然不可信——可能调用未注册工具或拼出不符合 schema 的参数。
 * 这里按客户端注册的工具定义做二次校验：未知工具名、参数解析失败、参数不合法一律剔除。
 * 返回过滤后的合法调用与剔除数量（供日志/告警）。
 */
export function validateDetectedToolCalls(calls: DetectedToolCall[], tools: ToolDef[], choice?: unknown): { calls: DetectedToolCall[]; dropped: number } {
  const out: DetectedToolCall[] = []
  let dropped = 0
  for (const c of calls) {
    const fn = toolFunction(c.name, tools)
    if (!fn) { dropped++; continue }
    // tool_choice 约束：named/required 下不匹配当前调用的直接剔除（同原版 toolChoiceAllows）
    if (!toolChoiceAllows(choice, c.name)) { dropped++; continue }
    let args: Record<string, unknown>
    const raw = (c.arguments || '').trim()
    if (raw === '' || raw === 'null') {
      // 空串 / "null" arguments 归一为 {}（原版默认保留继续校验）
      args = {}
    } else {
      try {
        const v = JSON.parse(raw)
        if (v === null || typeof v !== 'object' || Array.isArray(v)) { dropped++; continue }
        args = v
      } catch { dropped++; continue }
    }
    if (schemaValid(args, fn) !== null) { dropped++; continue }
    out.push({ ...c, arguments: JSON.stringify(args) })
  }
  return { calls: out, dropped }
}

/**
 * 从响应文本解析 <m365-tool-call> fenced block（与 M365 官方协议一致）。
 * 支持文本中多个独立块，每个块可含单个对象或数组（同原版 tooldecision.extractToolCalls）。
 * 返回 (工具调用列表, 是否包含调用块)。
 */
export function extractToolCalls(text: string, tools: ToolDef[], choice: unknown): DetectedToolCall[] {
  const allowed = allowedToolNames(tools)
  const out: DetectedToolCall[] = []
  const re = /<m365-tool-call>([\s\S]*?)<\/m365-tool-call>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let raw: unknown
    try {
      raw = JSON.parse(m[1])
    } catch {
      continue
    }
    const items = Array.isArray(raw) ? raw : [raw]
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const mi = item as Record<string, unknown>
      const name = typeof mi['name'] === 'string' ? mi['name'] : ''
      if (!allowed.has(name) || !toolChoiceAllows(choice, name)) continue
      let args = '{}'
      try {
        const s = mi['arguments'] === undefined ? undefined : JSON.stringify(mi['arguments'])
        if (s !== undefined && s !== '') args = s
      } catch { /* keep {} */ }
      out.push({ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: args })
    }
  }
  return out
}

/**
 * 工具路由提示词（同原版 modelToolRouterPrompt）：
 * 注入完整工具定义 + 决策规则，让模型显式选择调用哪个工具（CALL_TOOL: name({...})）
 * 或判定无需工具（NO_TOOL_NEEDED）。这是让 M365 模型真正调用工具的核心机制。
 */
export function modelToolRouterPrompt(text: string, tools: ToolDef[], choice: unknown): string {
  const defs = JSON.stringify(tools)
  const mode = normalizedToolChoiceMode(choice)
  let rules =
    '- If a tool is needed, respond with: CALL_TOOL: tool_name({"arg1":"value1"})\n' +
    '- If no tool is needed, respond with: NO_TOOL_NEEDED\n' +
    '- Only use tools from the available list above\n' +
    '- Validate all arguments against the tool\'s schema\n' +
    '- Do not invent tools that are not in the list'
  // 多轮：已完成工具证据（tool[...] / tool_calls:）不应重复触发
  if (text.includes('tool_calls:') || text.includes('tool[call_')) {
    rules +=
      '\n- Completed evidence must not be repeated: tool_calls/tool[call_x] rows are prior results already delivered to the user, never re-invoke them' +
      '\n- Only start a new tool call when fresh unfinished work remains on the current request'
  }
  return (
    'You are a tool selection assistant. Based on the user request, decide which tool to call next.\n\n' +
    `Available tools: ${defs}\n\n` +
    `MODE: ${mode}\n\n` +
    `Rules:\n${rules}\n\n` +
    `User request and evidence:\n${text}`
  )
}

/**
 * 解析工具路由决策（同原版 parseModelToolDecision）：
 * 优先 CALL_TOOL: name({...})，其次 NO_TOOL_NEEDED，兜底解析 JSON envelope。
 * 返回 (工具调用列表, 是否成功解析)。
 */
export function parseModelToolDecision(text: string, tools: ToolDef[], choice: unknown): { calls: DetectedToolCall[]; parsed: boolean } {
  const t = text.trim()
  const lower = t.toLowerCase()
  // 1) CALL_TOOL: name({...}) 自然语言格式
  if (t.startsWith('CALL_TOOL:') || lower.startsWith('call_tool:')) {
    const rest = t.slice(t.indexOf(':') + 1).trim()
    const start = rest.indexOf('(')
    const end = rest.lastIndexOf(')')
    if (start > 0 && end > start) {
      const name = rest.slice(0, start).trim()
      const argsStr = rest.slice(start + 1, end)
      try {
        const args = JSON.parse(argsStr) as Record<string, unknown>
        if (args !== null && typeof args === 'object') {
          const fn = toolFunction(name, tools)
          // 同原版 model_tool_router：必须通过 schema 校验才采用（schemaValid 返回 null 表示合法）
          if (fn && schemaValid(args, fn) === null && toolChoiceAllows(choice, name)) {
            return {
              calls: [{ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(args) }],
              parsed: true,
            }
          }
        }
      } catch { /* fall through */ }
    }
  }
  // 2) NO_TOOL_NEEDED
  if (t.includes('NO_TOOL_NEEDED') || lower.includes('no_tool_needed')) {
    return { calls: [], parsed: true }
  }
  // 3) 兜底：fenced code block 或 JSON envelope {"calls":[...]}
  let body = t
  const fenceStart = t.indexOf('```')
  if (fenceStart >= 0) {
    body = t.slice(fenceStart + 3).replace(/```$/, '').replace(/^json\s*/i, '').trim()
  }
  const js = body.indexOf('{')
  const je = body.lastIndexOf('}')
  if (js >= 0 && je > js) {
    const inner = body.slice(js, je + 1)
    try {
      const env = JSON.parse(inner) as { calls?: Array<{ name?: string; arguments?: unknown }> }
      if (env && Array.isArray(env.calls)) {
        const calls: DetectedToolCall[] = []
        for (const c of env.calls) {
          if (!c || typeof c !== 'object') continue
          const name = String(c.name || '')
          const fn = toolFunction(name, tools)
          if (!fn || c.arguments === undefined || c.arguments === null) continue
          if (!toolChoiceAllows(choice, name)) continue
          const argsObj = c.arguments as Record<string, unknown>
          if (schemaValid(argsObj, fn)) continue
          calls.push({ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(argsObj) })
        }
        return { calls, parsed: true }
      }
    } catch { /* fall through */ }
  }
  return { calls: [], parsed: false }
}

/** 解析 fenced code block 形式的工具调用（同原版 fencedToolCalls 的扩展解析） */
const FENCED_TOOL = /```([A-Za-z0-9_-]+)\s*\n([\s\S]*?)\n```/

/** 从回答文本解析所有 fenced 工具调用（含 <m365-tool-call> 与 ```name\n{json}\n``` 两种约定） */
export function fencedToolCalls(text: string, tools: ToolDef[], choice: unknown): DetectedToolCall[] {
  // 1) 原生 <m365-tool-call> 约定
  const native = extractToolCalls(text, tools, choice)
  if (native.length > 0) return native
  // 2) XYML/QNML/XML/JSON/text-kv 容错解析（复用 CNB 的 ToolForge 解析引擎，兼容多格式与结构损坏：
  //    </parameter> 缺失、参数被 </invoke> 提前闭合、全角括号/竖线、CDATA 包裹等正则难以覆盖的形态）。
  //    解析结果再经 schema 校验，避免容错放宽导致 args 形状非法。
  let out: DetectedToolCall[] = []
  const xymlCalls = parseToolCalls(text, tools as unknown as Record<string, unknown>[])
  if (xymlCalls.length > 0) {
    for (const c of xymlCalls) {
      const name = c.name
      if (!allowedToolNames(tools).has(name) || !toolChoiceAllows(choice, name)) continue
      out.push({ id: c.id || `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(c.input ?? {}) })
    }
  }
  // 3) ```name\n{json}\n``` 约定（XYML 引擎不解析 fenced 形态时的回退）
  if (out.length === 0) {
    out = []
    const allowed = allowedToolNames(tools)
    let m: RegExpExecArray | null
    const re = new RegExp(FENCED_TOOL, 'g')
    while ((m = re.exec(text)) !== null) {
      const name = m[1]
      const args = m[2].trim()
      let v: unknown
      try {
        v = JSON.parse(args)
      } catch {
        v = null
      }
      if (!allowed.has(name) || !toolChoiceAllows(choice, name)) continue
      if (v === null) continue
      out.push({ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(v) })
    }
  }
  return out
}

/** 从原生工具事件列表提取工具调用（同原版 nativeToolCalls，遍历事件树找 name/arguments） */
export function nativeToolCalls(events: unknown[], tools: ToolDef[]): DetectedToolCall[] {
  const allowed = new Set<string>()
  for (const t of tools) {
    if (t.function?.name) allowed.add(t.function.name)
  }
  const out: DetectedToolCall[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    if (x && typeof x === 'object') {
      const obj = x as Record<string, unknown>
      let name = ''
      for (const k of ['name', 'toolName', 'pluginName', 'functionName', 'id']) {
        const s = obj[k]
        if (typeof s === 'string' && allowed.has(s)) { name = s; break }
      }
      if (name !== '') {
        let a: unknown
        for (const k of ['arguments', 'args', 'parameters', 'input', 'functionArguments']) {
          if (obj[k] !== undefined) { a = obj[k]; break }
        }
        if (a !== undefined && a !== null) {
          out.push({ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(a) })
          return
        }
      }
      for (const k of Object.keys(obj)) walk(obj[k])
    }
  }
  for (const ev of events) walk(ev)
  return out
}

/** OpenAI messages → ChatHub 单文本 prompt（保留角色边界与工具调用身份，同原版 flattenPromptMessages） */
export interface OaiMsgLite {
  role?: string
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (typeof p['text'] === 'string') parts.push(p['text'])
      else if (typeof p['output'] === 'string') parts.push(p['output'])
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c['text'] === 'string') return c['text']
  }
  return ''
}

/** 从 content 中提取图片附件（image_url data:/https） */
export function extractAttachments(content: unknown): { type: 'image'; url: string; mimeType?: string; name?: string }[] {
  const out: { type: 'image'; url: string; mimeType?: string; name?: string }[] = []
  if (typeof content === 'string') return out
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p['type'] === 'image_url') {
        const u = p['image_url'] as Record<string, unknown> | undefined
        if (u && typeof u['url'] === 'string') {
          out.push({ type: 'image', url: u['url'] })
        }
      }
    }
  }
  return out
}

export function compactToolResult(text: string, max = 4000): string {
  const s = String(text || '').trim()
  // 与原版 agent_ledger.go compactResult 一致：Limit 小于 200 时按其上限；
  // 否则 head=Limit/3、tail=Limit-head-80，保留约 Limit 字符
  const limit = Math.max(1, max)
  if (s.length <= limit) return s
  const head = Math.floor(limit / 3)
  const tail = Math.min(Math.max(limit - head - 80, 0), s.length)
  const keepHead = Math.min(head, s.length - tail)
  const trimmed = s.length - head - tail
  if (keepHead <= 0) return `[truncated ${s.length} chars]`
  return s.substring(0, keepHead) + `\n...[truncated ${trimmed} chars]...\n` + s.substring(s.length - tail)
}

/** 工具结果 content 序列化：非 string 时整体 JSON（数组型 tool_result 保留全部字段，同原版） */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try { return JSON.stringify(content) } catch { return String(content) }
}

export function flattenPromptMessages(messages: OaiMsgLite[], attachments?: { type: 'image'; url: string }[]): { prompt: string; attachments: { type: 'image'; url: string }[] } {
  const outAttachments = attachments ? [...attachments] : []
  const parts: string[] = []

  // 前置聚合所有 system/developer 为单一 system 块（同原版），避免系统指令落在消息序列中间
  const systemParts: string[] = []
  for (const m of messages) {
    const role = (m.role || '').toLowerCase().trim()
    if (role === 'system' || role === 'developer') {
      const t = contentToString(m.content).trim()
      if (t !== '') systemParts.push(t)
    }
  }
  if (systemParts.length > 0) {
    parts.push(`\n[system]\n${systemParts.join('\n')}`)
  }

  for (const m of messages) {
    let role = (m.role || 'user').toLowerCase().trim()
    if (role === '') role = 'user'
    if (role === 'system' || role === 'developer') continue // 已前置聚合
    let txt = contentToString(m.content).trim()
    outAttachments.push(...extractAttachments(m.content))
    if (m.tool_calls && m.tool_calls.length > 0) {
      if (txt !== '') parts.push(`\n[${role}]\n${txt}`)
      parts.push(`\n[${role} tool_calls]\n${JSON.stringify(m.tool_calls)}`)
      continue
    }
    if (role === 'tool') {
      const t = toolResultText(m.content)
      parts.push(`\n[tool result id=${m.tool_call_id || ''}]\n${compactToolResult(t)}`)
      continue
    }
    if (txt === '') continue
    parts.push(`\n[${role}]\n${txt}`)
  }
  return { prompt: parts.join('').trim(), attachments: outAttachments }
}

/* ==================== 多轮工具证据 ledger（同原版 agent_ledger.go） ==================== */

export interface ToolEvidence {
  id: string
  name: string
  arguments: string
  result: string
  failed: boolean
}

export interface AgentLedger {
  completed: ToolEvidence[]
  pending: ToolEvidence[]
  toolRounds: number
  repeatedCall: boolean
  repeatedFailure: boolean
  /** 同一调用（name+args）被反复执行 >=3 次，判定陷入死循环（同原版 StuckLoop） */
  stuckLoop?: boolean
  repetitionSignature?: string
}

/** 单次对话允许的最大工具轮数（对齐原版 maxToolRounds 默认 32；可用 M365_MAX_TOOL_ROUNDS 覆盖，上限 512） */
export const MAX_TOOL_ROUNDS_DEFAULT = 32

/** 解析最大工具轮数：env 合法（1..512）用 env，否则默认 32（同原版 maxToolRounds()） */
export function resolveMaxToolRounds(raw?: string): number {
  if (raw != null && raw.trim() !== '') {
    const n = parseInt(raw.trim(), 10)
    if (Number.isFinite(n) && n > 0 && n <= 512) return n
  }
  return MAX_TOOL_ROUNDS_DEFAULT
}

/**
 * 只取"最近一条 user 消息之后"的连续窗口（同原版 activeMessages）。
 * 构建 ledger 时用它，使 toolRounds 只统计当前用户请求开启的工具链，
 * 避免把历史已完成工具调用累计而上限误拦（长会话第 N 轮被 409 的根因）。
 * 无 user 消息或 user 在首条时返回全量。
 */
export function activeMessages(messages: OaiMsgLite[]): OaiMsgLite[] {
  let last = -1
  for (let i = 0; i < messages.length; i++) {
    if (String(messages[i].role || '').toLowerCase() === 'user') last = i
  }
  if (last <= 0) return messages
  return messages.slice(last)
}

/** 是否允许继续发起工具轮：死循环 / 反复失败 / 超轮数则停止（同原版 CanContinue） */
export function canContinue(l: AgentLedger, maxRounds = MAX_TOOL_ROUNDS_DEFAULT): boolean {
  if (l.stuckLoop) return false
  // 同一调用反复失败（>=2 次同样失败）且已有一次失败证据，继续重试无意义 → 熔断
  if (l.repeatedFailure) return false
  if (l.toolRounds >= maxRounds) return false
  return true
}

const failureSignal = /(exit\s*(code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|permission denied|not found|refused)/i
const unsupportedSuccess = /\b(installed|created|written|executed|ran|started|deployed|deleted|verified|completed|succeeded|successful(?:ly)?)\b/i

export function normalizeFailure(s: string): string {
  s = s.toLowerCase()
  s = s.replace(/\d+/g, '#')
  if (s.length > 500) s = s.slice(0, 500)
  return s
}

/** 从 messages 历史构建工具证据 ledger（assistant.tool_calls + tool 结果） */
export function buildAgentLedger(messages: OaiMsgLite[]): AgentLedger {
  const calls: Record<string, ToolEvidence> = {}
  const order: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const raw of m.tool_calls) {
        if (!raw || typeof raw !== 'object') continue
        const r = raw as Record<string, unknown>
        const id = typeof r['id'] === 'string' ? r['id'] : ''
        const fn = (r['function'] || {}) as Record<string, unknown>
        const name = typeof fn['name'] === 'string' ? fn['name'] : ''
        const args = fn['arguments'] === undefined ? '' : String(fn['arguments'])
        if (id !== '') {
          calls[id] = { id, name, arguments: args, result: '', failed: false }
          order.push(id)
        }
      }
    }
    if (m.role === 'tool') {
      const tid = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      if (calls[tid]) {
        calls[tid].result = compactToolResult(contentToString(m.content), 4000)
        calls[tid].failed = failureSignal.test(calls[tid].result)
      }
    }
  }
  const l: AgentLedger = { completed: [], pending: [], toolRounds: 0, repeatedCall: false, repeatedFailure: false }
  const seenCall: Record<string, number> = {}
  const seenFailure: Record<string, number> = {}
  /** 成功调用的重复计数（区别于失败，见下：不对合法重复成功调用误判死循环） */
  const seenSuccess: Record<string, number> = {}
  for (const id of order) {
    const e = calls[id]
    l.toolRounds++
    const sig = e.name + '\x00' + e.arguments
    seenCall[sig] = (seenCall[sig] || 0) + 1
    if (seenCall[sig] >= 2) {
      l.repeatedCall = true
      l.repetitionSignature = sig
    }
    if (e.result === '') {
      l.pending.push(e)
    } else {
      l.completed.push(e)
      if (e.failed) {
        // 失败重试无进展才是真正的死循环：重复失败 >=3 次切断（同原版，阈值保持 3）
        const fs = e.name + '\x00' + e.arguments + '\x00' + normalizeFailure(e.result)
        seenFailure[fs] = (seenFailure[fs] || 0) + 1
        if (seenFailure[fs] >= 2) {
          l.repeatedFailure = true
          l.repetitionSignature = fs
          if (seenFailure[fs] >= 3) {
            l.stuckLoop = true
          }
        }
      } else {
        // 合法的重复成功调用（反复读同一文件 / 轮询状态）不应被误判死循环，
        // 阈值放宽到 >=5（同原版 #68）；上限仍受 repeatedFailure 与轮数熔断兜底。
        seenSuccess[sig] = (seenSuccess[sig] || 0) + 1
        if (seenSuccess[sig] >= 5) {
          l.stuckLoop = true
        }
      }
    }
  }
  return l
}

/** ledger 紧凑证据上下文（同原版 RouterContext），注入路由/主回答提示词 */
export function ledgerRouterContext(l: AgentLedger): string {
  const compact = { completed: l.completed, pending: l.pending, repeated_call: l.repeatedCall }
  const json = JSON.stringify(compact)
  let hint = 'Use only this compact evidence. A completed call is final evidence; do not issue the same name and arguments again.'
  if (l.repeatedFailure) hint += ' The same call failed repeatedly; change strategy instead of retrying unchanged.'
  if (l.stuckLoop) hint += ' STOP: the same call has looped repeatedly with no progress. Do not re-invoke it; change approach or conclude.'
  return hint + '\nEVIDENCE_LEDGER: ' + json
}

export function canonicalToolArguments(s: string): string {
  s = String(s || '').trim()
  try {
    return JSON.stringify(JSON.parse(s))
  } catch {
    return s
  }
}

export function ledgerHasCompleted(l: AgentLedger, name: string, args: string): boolean {
  const want = canonicalToolArguments(args)
  for (const e of l.completed) {
    if (e.name === name && canonicalToolArguments(e.arguments) === want) return true
  }
  return false
}

/** 过滤掉 ledger 中已完成（同参数同名称）的工具调用，避免重复触发 */
export function filterCompletedCalls(calls: DetectedToolCall[], l: AgentLedger): DetectedToolCall[] {
  return calls.filter((c) => !ledgerHasCompleted(l, c.name, c.arguments))
}

/** 已完成的工具调用 ID 列表（排序），用于作用域化 call id */
export function completedCallIDs(l: AgentLedger): string[] {
  return l.completed.map((e) => e.id).sort()
}

/** 主回答是否允许作为"已完成"结论（存在待处理调用时不允许；有完成证据时不允许含失败措辞） */
export function completionEvidenceAllows(answer: string, l: AgentLedger): boolean {
  if (l.pending.length > 0) return false
  if (l.completed.length === 0 && l.pending.length === 0) return !unsupportedSuccess.test(answer)
  const low = answer.toLowerCase()
  const failureKeywords = ['cannot confirm', 'not confirmed', 'unable to confirm', 'no tool result', 'no matching tool results were returned', 'no external action has been verified']
  let hasFailure = false
  for (const h of failureKeywords) if (low.includes(h)) { hasFailure = true; break }
  if (l.completed.length > 0) return !hasFailure
  if (unsupportedSuccess.test(answer)) return false
  return true
}

/* ==================== 工具拒绝 / 沙箱幻觉检测（同原版 toolloop.go） ==================== */

const toolRefusalPatterns = [
  'tools are not available', 'tool is not available', 'cannot access the Windows path', 'only provides Linux',
  '只提供 Linux 容器', '工具未暴露', '工具不可用', '没有可调用的', '无法继续操作',
  'will not pretend', 'will not fake', 'cannot fake', 'would be fabricated', 'cannot fabricate',
  'refuse to fabricate', 'not actually registered', 'not actually available', 'not exposed in this',
  'not available in this session', 'cannot execute on this platform', '没有 Windows 执行接口',
  '回复通道没有', '没有执行接口', '不会虚构', '不会!转入', '不会转入',
]

/** 沙箱幻觉检测词表（移植自 M365-Copilot2API toolloop.go sandboxHallucinationPatterns） */
const sandboxHallucinationPatterns = [
  'no Windows execution', "don't have a Windows", 'no execution channel', '没有 Windows 执行通道',
  'cannot run commands on', "don't have command execution", '无法执行命令',
  "I don't have SSH access tools", 'execution environment has changed', '执行环境已经切换',
  'running in sandbox', 'executing in sandbox', 'code interpreter', 'python sandbox',
  'sandbox environment', '/mnt/data', 'cloud sandbox', 'none of which can reach',
  '内置 code interpreter', 'python 沙箱', '沙箱环境',
]

/** 检测模型是否错误拒绝使用工具（触发纠正重试）。同原版 toolloop.go：长文本不判定，避免误判 */
export function isToolRefusal(text: string): boolean {
  if (text.length >= 200) return false
  const low = text.toLowerCase()
  for (const p of toolRefusalPatterns) if (low.includes(p)) return true
  return false
}

/** 检测模型是否产生"沙箱幻觉"（误以为自己在沙箱/有内置解释器）。独立检测、无长度限制（同原版） */
export function isSandboxHallucination(text: string): boolean {
  if (!text) return false
  const low = text.toLowerCase()
  for (const p of sandboxHallucinationPatterns) if (low.includes(p)) return true
  return false
}