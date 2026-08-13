/**
 * xyml.ts — ToolForge XYML 工具调用引擎移植（TypeScript 版）。
 *
 * 移植自 https://github.com/YuJunZhiXue/toolforge 的 app/engine/xyml.py（MIT）。
 * 原实现刻意只依赖 Python 标准库以便用于 worker/serverless，这里以同样思路
 * 移植为纯 TS：无外部依赖，仅做文本注入/解析/流式分块。
 *
 * 用途：CNB（cnb.cool）上游禁止原生 tools（403），网关开启工具桥后把客户端的
 * OpenAI tools 转成 XYML 提示词注入，再把模型返回的文本按 XYML/QNML/XML/JSON/
 * text-kv 格式解析回标准 tool_calls。
 */

// ===== 常量 =====

// ToolSieve 捕获区异常兜底（防"会话几轮后停止返回"）：
// 模型偶发输出畸形工具块（只有开标签 <|XYML|...，无闭合标签，常见于流式中断/上下文过长），
// 若不干预，capture 将无限累积、后随正文全被吞掉，客户端收不到任何内容、只能输入"继续"续命。
// 双保险：
// - MAX_CAPTURE_MS：开标签后超过该时长仍未闭合 → 视为畸形块，强制降级为正文透传；
//   正常工具块从开标签到闭合亚秒级到达，不受影响，故设 2s。
// - MAX_CAPTURE_LEN：罕见超大块（超大参数）兜底，避免长度型吞内容。
const MAX_CAPTURE_MS = 2_000
const MAX_CAPTURE_LEN = 50_000

const DEFAULT_RAW_STRING_PARAMS = new Set([
  'content', 'command', 'cmd', 'script', 'code', 'prompt', 'file_content',
  'old_string', 'new_string', 'insert_text', 'patch', 'pattern', 'text',
  'query', 'url', 'path', 'file_path',
])

const DEFAULT_TOOL_ALIASES: Record<string, string> = {
  fs_open_file: 'Read',
  fs_put_file: 'Write',
  fs_patch_file: 'Edit',
  shell_run: 'Bash',
  text_search: 'Grep',
  path_find: 'Glob',
  notebook_patch: 'NotebookEdit',
  http_get_url: 'WebFetch',
  web_query: 'WebSearch',
}

const SAFE_TOOL_ALIASES: Record<string, string> = {
  Read: 'fs_open_file',
  Write: 'fs_put_file',
  Edit: 'fs_patch_file',
  Bash: 'shell_run',
  Grep: 'text_search',
  Glob: 'path_find',
  NotebookEdit: 'notebook_patch',
  WebFetch: 'http_get_url',
  WebSearch: 'web_query',
}

const MARKUP_REPLACEMENTS: Array<[string, string]> = [
  ['＜', '<'], ['＞', '>'], ['／', '/'], ['∕', '/'], ['⁄', '/'],
  ['＝', '='], ['｜', '|'], ['│', '|'], ['┃', '|'], ['▏', '|'], ['▕', '|'],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['﹤', '<'], ['﹥', '>'],
]

// ===== 基础工具 =====

const RANDOM_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function randomId(length = 12): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)]
  }
  return out
}

export function randomCallId(): string {
  return 'call_' + randomId(12)
}

export interface ParsedToolCall {
  name: string
  input: unknown
  id: string
}

function newParsedToolCall(name: string, input: unknown, id?: string): ParsedToolCall {
  return { name, input: input === null || input === undefined ? {} : input, id: id || randomCallId() }
}

export type ParsedToolCallLike = ParsedToolCall | Record<string, unknown>

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return undefined
}

function callValue(call: unknown, key: string, defaultValue?: unknown): unknown {
  if (isMapping(call)) return call[key] !== undefined ? call[key] : defaultValue
  return defaultValue
}

function jsonDumps(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'function' ? String(v) : v))
  } catch {
    return String(value)
  }
}

function argumentsString(value: unknown): string {
  if (typeof value === 'string') return value
  return jsonDumps(value === null || value === undefined ? {} : value)
}

function tryJson(text: unknown): [boolean, unknown] {
  if (typeof text !== 'string') return [false, undefined]
  try {
    return [true, JSON.parse(text)]
  } catch {
    return [false, undefined]
  }
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function htmlUnescape(value: unknown): string {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function toolAliasKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function clip(text: unknown, maximum: number): string {
  const value = String(text ?? '').trim()
  return value.length > maximum ? value.slice(0, maximum) + '...' : value
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']'
  if (isMapping(value)) {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => jsonDumps(k) + ':' + stableStringify(value[k])).join(',') + '}'
  }
  return jsonDumps(value)
}

// ===== 配置 =====

export interface ProtocolSpec {
  name: string
  parseOnly: boolean
  tags: { root: string; invoke: string; parameter: string }
}

function normalizeProtocolSpec(value: unknown, emitProtocol: string): ProtocolSpec {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as any).tags) {
    return value as ProtocolSpec
  }
  let name: string
  let parseOnly = false
  const tags: Record<string, string> = {}
  if (typeof value === 'string') {
    name = value.trim()
    parseOnly = name.toLowerCase() !== emitProtocol.toLowerCase()
  } else if (isMapping(value)) {
    name = String(value.name ?? '').trim()
    parseOnly = value.parseOnly === true || value.parseOnly === 'parseOnly' ? true : false
    if (value.tags && isMapping(value.tags)) {
      const t = value.tags as Record<string, unknown>
      if (typeof t.root === 'string') tags.root = t.root
      if (typeof t.invoke === 'string') tags.invoke = t.invoke
      if (typeof t.parameter === 'string') tags.parameter = t.parameter
    }
  } else {
    name = ''
  }
  if (!name) throw new TypeError('ProtocolSpec name must be a non-empty string')
  return {
    name,
    parseOnly,
    tags: { root: tags.root || 'tool_calls', invoke: tags.invoke || 'invoke', parameter: tags.parameter || 'parameter' },
  }
}

export interface ToolCallConfig {
  emitProtocol: string
  parseProtocols: ProtocolSpec[]
  strict: boolean
  unknownTool: 'drop' | 'error' | 'keep'
  missingRequired: 'drop' | 'error' | 'keep'
  enableMarkup: boolean
  enableXml: boolean
  enableJson: boolean
  enableTextKV: boolean
  enableCoercion: boolean
  enableDedupe: boolean
  promptStyle: 'standard' | 'minimal'
  toolAliases: Record<string, string>
  argumentAliases: Record<string, string>
  rawStringParams: Set<string>
}

function resolveConfig(config?: Partial<ToolCallConfig> | ToolCallConfig): ToolCallConfig {
  const base: ToolCallConfig = {
    emitProtocol: 'XYML',
    parseProtocols: [],
    strict: false,
    unknownTool: 'drop',
    missingRequired: 'drop',
    enableMarkup: true,
    enableXml: true,
    enableJson: true,
    enableTextKV: true,
    enableCoercion: true,
    enableDedupe: true,
    promptStyle: 'standard',
    toolAliases: { ...DEFAULT_TOOL_ALIASES },
    argumentAliases: {},
    rawStringParams: new Set(DEFAULT_RAW_STRING_PARAMS),
  }
  const src: Record<string, unknown> = {}
  if (config) {
    const c = config as Record<string, unknown>
    for (const key of Object.keys(c)) {
      const camel = key.replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase())
      src[camel] = c[key]
    }
  }
  if (src.emitProtocol !== undefined) base.emitProtocol = String(src.emitProtocol)
  if (src.parseProtocols !== undefined) {
    base.parseProtocols = (asList(src.parseProtocols) as unknown[]).map((p) => normalizeProtocolSpec(p, base.emitProtocol))
  } else {
    base.parseProtocols = [
      normalizeProtocolSpec(base.emitProtocol, base.emitProtocol),
      normalizeProtocolSpec('QNML', base.emitProtocol),
    ]
  }
  if (src.strict !== undefined) base.strict = Boolean(src.strict)
  if (src.unknownTool !== undefined) base.unknownTool = src.unknownTool as ToolCallConfig['unknownTool']
  if (src.missingRequired !== undefined) base.missingRequired = src.missingRequired as ToolCallConfig['missingRequired']
  if (src.enableMarkup !== undefined) base.enableMarkup = Boolean(src.enableMarkup)
  if (src.enableXml !== undefined) base.enableXml = Boolean(src.enableXml)
  if (src.enableJson !== undefined) base.enableJson = Boolean(src.enableJson)
  if (src.enableTextKV !== undefined) base.enableTextKV = Boolean(src.enableTextKV)
  if (src.enableCoercion !== undefined) base.enableCoercion = Boolean(src.enableCoercion)
  if (src.enableDedupe !== undefined) base.enableDedupe = Boolean(src.enableDedupe)
  if (src.promptStyle !== undefined) base.promptStyle = src.promptStyle as ToolCallConfig['promptStyle']
  if (src.toolAliases !== undefined && isMapping(src.toolAliases)) {
    base.toolAliases = { ...base.toolAliases, ...(src.toolAliases as Record<string, string>) }
  }
  if (src.argumentAliases !== undefined && isMapping(src.argumentAliases)) {
    base.argumentAliases = { ...(src.argumentAliases as Record<string, string>) }
  }
  if (src.rawStringParams !== undefined) {
    for (const p of asList(src.rawStringParams)) {
      base.rawStringParams.add(String(p).toLowerCase())
    }
  }
  return base
}

export const DEFAULT_CONFIG: ToolCallConfig = resolveConfig()

// ===== 工具归一化 =====

export function normalizeTools(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const raw of asList(value)) {
    if (!isMapping(raw)) continue
    if (raw.type === 'function' && isMapping(raw.function)) {
      out.push({ ...(raw.function as Record<string, unknown>) })
    } else if (typeof raw.name === 'string' && raw.name.trim()) {
      out.push({ ...raw })
    }
  }
  return out
}

// ===== 渲染 =====

function renderMarkupValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return '<![CDATA[' + value.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return jsonDumps(value)
}

function protocolOpenTagRe(protocol: ProtocolSpec, tag: string): RegExp {
  const name = protocol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tg = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<\\s*\\|\\s*${name}\\s*\\|\\s*${tg}\\b[^>]*>`, 'gi')
}

function protocolTagBlockRe(protocol: ProtocolSpec, tag: string): RegExp {
  const name = protocol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tg = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `<\\s*\\|\\s*${name}\\s*\\|\\s*${tg}\\b([^>]*)>([\\s\\S]*?)<\\s*/\\s*\\|\\s*${name}\\s*\\|\\s*${tg}\\s*>`,
    'gis',
  )
}

export function renderToolCall(
  name: unknown,
  input?: unknown,
  opts?: { config?: Partial<ToolCallConfig>; protocol?: unknown },
): string {
  const config = resolveConfig(opts?.config)
  const activeProtocol = opts?.protocol !== undefined ? normalizeProtocolSpec(opts.protocol, config.emitProtocol) : config.parseProtocols[0] && !config.parseProtocols[0].parseOnly ? config.parseProtocols[0] : normalizeProtocolSpec(config.emitProtocol, config.emitProtocol)
  const callName = String(name ?? '').trim()
  if (!callName) return ''
  const argumentsObj: Record<string, unknown> = isMapping(input) ? { ...input } : { input: input }
  const p = activeProtocol
  const lines = [
    `<|${p.name}|${p.tags.root}>`,
    `  <|${p.name}|${p.tags.invoke} name="${escapeXml(callName)}">`,
  ]
  const keys = Object.keys(argumentsObj).sort()
  for (const key of keys) {
    lines.push(
      `    <|${p.name}|${p.tags.parameter} name="${escapeXml(key)}">${renderMarkupValue(argumentsObj[key])}</|${p.name}|${p.tags.parameter}>`,
    )
  }
  lines.push(`  </|${p.name}|${p.tags.invoke}>`)
  lines.push(`</|${p.name}|${p.tags.root}>`)
  return lines.join('\n')
}

export function renderToolCalls(
  calls: unknown,
  opts?: { config?: Partial<ToolCallConfig>; protocol?: unknown },
): string {
  const parts: string[] = []
  for (const call of asList(calls)) {
    const rendered = renderToolCall(callValue(call, 'name'), callValue(call, 'input', {}), opts)
    if (rendered) parts.push(rendered)
  }
  return parts.join('\n\n')
}

// ===== 工具指令构建 =====

function schemaProperties(schema: unknown): Record<string, unknown> | null {
  if (isMapping(schema) && isMapping(schema.properties)) return schema.properties as Record<string, unknown>
  return null
}

function schemaTypes(schema: unknown): Set<string> {
  const types = new Set<string>()
  if (!isMapping(schema)) return types
  const kind = schema.type
  if (typeof kind === 'string') types.add(kind)
  else if (Array.isArray(kind)) kind.forEach((k) => typeof k === 'string' && types.add(k))
  if (schema.properties !== null && schema.properties !== undefined) types.add('object')
  if (schema.items !== null && schema.items !== undefined) types.add('array')
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      for (const variant of schema[key]) {
        for (const t of schemaTypes(variant)) types.add(t)
      }
    }
  }
  return types
}

function safeToolName(name: unknown): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return ''
  if (SAFE_TOOL_ALIASES[trimmed]) return SAFE_TOOL_ALIASES[trimmed]
  if (Object.values(SAFE_TOOL_ALIASES).some((alias) => alias.toLowerCase() === trimmed.toLowerCase())) return trimmed
  return trimmed.startsWith('u_') ? trimmed : 'u_' + trimmed
}

function exampleValue(schema: unknown): unknown {
  const kinds = schemaTypes(schema)
  if (kinds.has('array')) return []
  if (kinds.has('object')) return {}
  if (kinds.has('boolean')) return true
  if (kinds.has('number') || kinds.has('integer')) return 1
  return 'value'
}

function exampleInputFromTool(tool: Record<string, unknown>): Record<string, unknown> {
  const properties = schemaProperties(tool.parameters || tool.input_schema)
  if (!properties) return { ARG: 'value' }
  const example: Record<string, unknown> = {}
  let count = 0
  for (const key of Object.keys(properties)) {
    if (count >= 3) break
    example[key] = exampleValue(properties[key])
    count++
  }
  return Object.keys(example).length ? example : { ARG: 'value' }
}

export function buildToolInstructions(
  tools: unknown,
  opts?: { config?: Partial<ToolCallConfig>; protocol?: unknown },
): string {
  const config = resolveConfig(opts?.config)
  const activeProtocol = opts?.protocol !== undefined ? normalizeProtocolSpec(opts.protocol, config.emitProtocol) : normalizeProtocolSpec(config.emitProtocol, config.emitProtocol)
  const normalized = normalizeTools(tools)
  const safeTools: Array<Record<string, unknown>> = normalized.map((tool) => ({ ...tool, name: safeToolName(tool.name) }))
  const names = safeTools.filter((t) => t.name).map((t) => t.name)
  const schemas: string[] = []
  for (const tool of safeTools) {
    const parameters = tool.parameters as Record<string, unknown> | undefined || tool.input_schema as Record<string, unknown> | undefined || {}
    schemas.push(
      [
        'Action name: ' + tool.name,
        'Description: ' + clip(tool.description, 240),
        'Parameters: ' + jsonDumps(parameters),
      ].join('\n'),
    )
  }
  const exampleTools = safeTools.slice(0, 2).length
    ? safeTools.slice(0, 2)
    : [{ name: 'TOOL_NAME', parameters: { type: 'object', properties: { ARG: { type: 'string' } } } }]
  const examples = exampleTools
    .map((tool) => renderToolCall(tool.name, exampleInputFromTool(tool), { config, protocol: activeProtocol }))
    .join('\n\n')
  const accepted = config.parseProtocols.map((spec) => spec.name).join(', ')
  const schemaBlock = schemas.length ? 'You have access to these tools:\n\n' + schemas.join('\n\n') + '\n\n' : ''
  let defensiveRules = ''
  if (config.promptStyle !== 'minimal') {
    defensiveRules = `
RULES:
1. If a tool is needed, output a parseable ${activeProtocol.name} tool-call block. If no tool is needed, answer normally.
2. Use exact action names and parameter names from the schema.
3. Strings should use <![CDATA[...]]>; objects may use JSON or nested XML-like values; arrays may use JSON arrays or repeated <item> nodes.
4. Never emit empty required parameters. Ask normally if required information is unknown.
5. After a tool result, call another tool only if needed; otherwise answer normally.
6. Path-like parameters must contain only the path string, not prose or protocol fragments.
`
  }
  const renderedFormat = renderToolCall('TOOL_NAME', { ARG: 'value' }, { config, protocol: activeProtocol })
  return `=== ${activeProtocol.name} TOOL CALL PROTOCOL ===
${schemaBlock}Default protocol for new tool calls: ${activeProtocol.name}
Accepted parse protocols by this client: ${accepted}
Available action names: ${names.join(', ')}

FORMAT:
${renderedFormat}
${defensiveRules}CORRECT EXAMPLES:

${examples}

Remember: the preferred tool-call form is <|${activeProtocol.name}|tool_calls>...</|${activeProtocol.name}|tool_calls>.
=== END ${activeProtocol.name} TOOL INSTRUCTIONS ===`
}

// ===== 解析 =====

function stripMarkdownFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, '$1')
}

function canonicalizeMarkup(text: string): string {
  let t = text
  for (const [old, nw] of MARKUP_REPLACEMENTS) t = t.split(old).join(nw)
  return t
    .replace(/\u200b/g, '').replace(/\u200c/g, '').replace(/\u200d/g, '').replace(/\ufeff/g, '')
    .replace(/\u3000/g, ' ').replace(/\u00a0/g, ' ')
}

function stripJsonFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return m ? m[1].trim() : text.trim()
}

function repairLooseJson(text: string): string {
  let repaired = text.trim()
  repaired = repaired.replace(/"name="\s*/gi, '"name": "')
  repaired = repaired.replace(/"name=([^",}\s]+)"/gi, '"name": "$1"')
  repaired = repaired.replace(/"(name|input|arguments|args|parameters|tool|tool_name|function_name)"\s*=\s*/gi, '"$1": ')
  repaired = repaired.replace(/([{,]\s*)(name|input|arguments|args|parameters|tool|tool_name|function_name)\s*:/gi, '$1"$2":')
  return repaired
}

function recoverJsonLike(text: string): string {
  let repaired = text.trim()
  const unclosedBraces = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length
  const unclosedBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length
  return repaired + ']'.repeat(Math.max(unclosedBrackets, 0)) + '}'.repeat(Math.max(unclosedBraces, 0))
}

function forEachJsonFragment(text: unknown, visit: (value: unknown) => void): void {
  const normalized = stripJsonFence(String(text ?? ''))
  const candidates = [normalized, repairLooseJson(normalized), recoverJsonLike(normalized)]
  for (const candidate of candidates) {
    const [ok, parsed] = tryJson(candidate)
    if (ok) {
      visit(parsed)
      break
    }
  }
  const starts: number[] = []
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '{' || normalized[i] === '[') starts.push(i)
  }
  for (const start of starts) {
    for (let end = normalized.length; end > start; end--) {
      const fragment = normalized.slice(start, end)
      const [ok, parsed] = tryJson(fragment)
      if (ok) {
        visit(parsed)
        break
      }
      const [ok2, parsed2] = tryJson(repairLooseJson(fragment))
      if (ok2) {
        visit(parsed2)
        break
      }
    }
  }
}

function buildAllowedToolMap(tools: Array<Record<string, unknown>>, config: ToolCallConfig): Record<string, string> {
  const allowed: Record<string, string> = {}
  for (const tool of tools) {
    const name = tool.name
    if (!name) continue
    allowed[toolAliasKey(name)] = String(name)
    const alias = SAFE_TOOL_ALIASES[String(name)]
    if (alias) allowed[toolAliasKey(alias)] = String(name)
  }
  for (const [alias, canonical] of Object.entries(config.toolAliases)) {
    const real = allowed[toolAliasKey(canonical)] ?? canonical
    allowed[toolAliasKey(alias)] = real
  }
  return allowed
}

function canonicalToolName(name: unknown, allowed: Record<string, string>, config: ToolCallConfig): string {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  const direct = allowed[toolAliasKey(raw)]
  if (direct) return direct
  const configured = config.toolAliases[raw] || config.toolAliases[raw.toLowerCase()]
  if (configured && allowed[toolAliasKey(configured)]) return allowed[toolAliasKey(configured)]
  if (raw.startsWith('u_')) return allowed[toolAliasKey(raw.slice(2))] ?? ''
  return config.unknownTool === 'drop' ? '' : raw
}

function extractNameAttr(attributes: unknown): string {
  const m = String(attributes ?? '').match(/(?:^|[\s|])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s|/>]+))/i)
  if (!m) return ''
  const v = m[1] ?? m[2] ?? m[3] ?? ''
  return htmlUnescape(v.trim())
}

function parseTextKVInput(text: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const equals = line.indexOf('=')
    const colon = line.indexOf(':')
    let separator: number
    if (equals < 0) separator = colon
    else if (colon < 0) separator = equals
    else separator = colon < equals ? colon : equals
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) out[key] = value
  }
  return out
}

function normalizeToolInput(value: unknown): unknown {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    const [ok, parsed] = tryJson(trimmed)
    if (ok) return normalizeToolInput(parsed)
    const keyValues = parseTextKVInput(trimmed)
    return Object.keys(keyValues).length ? keyValues : value
  }
  return value
}

function parseToolInput(text: string): unknown {
  if (!text) return {}
  const [ok, parsed] = tryJson(text)
  if (ok) return normalizeToolInput(parsed)
  const parameters: Record<string, unknown> = {}
  const re = /<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    parameters[m[1]] = decodeMarkupValue(m[2], m[1], DEFAULT_CONFIG)
  }
  if (Object.keys(parameters).length) return parameters
  const keyValues = parseTextKVInput(text)
  return Object.keys(keyValues).length ? keyValues : { input: text }
}

function parseNestedMarkupValue(raw: string, config: ToolCallConfig): [boolean, unknown] {
  const text = raw.trim()
  if (!text || !text.includes('<')) return [false, undefined]
  const matches: RegExpExecArray[] = []
  const re = /<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) matches.push(m)
  if (!matches.length) return [false, undefined]
  const names = matches.map((mm) => mm[1])
  const values = matches.map((mm) => decodeMarkupValue(mm[2], mm[1], config))
  if (names.every((n) => n.toLowerCase() === 'item')) return [true, values]
  const out: Record<string, unknown> = {}
  names.forEach((name, i) => {
    const v = values[i]
    if (!(name in out)) out[name] = v
    else if (Array.isArray(out[name])) (out[name] as unknown[]).push(v)
    else out[name] = [out[name], v]
  })
  return [true, out]
}

function coerceMarkupScalar(raw: unknown, rawString: boolean): unknown {
  const value = htmlUnescape(String(raw ?? '').trim())
  if (rawString) return value
  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null') return null
  const [ok, parsed] = tryJson(value)
  return ok ? normalizeToolInput(parsed) : value
}

function decodeMarkupValue(raw: unknown, parameterName: unknown, config: ToolCallConfig): unknown {
  const cdataMatches = String(raw ?? '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/gi)
  const rawString = String(parameterName ?? '').toLowerCase() in config.rawStringParams
  if (cdataMatches && cdataMatches.length) {
    const joined = cdataMatches.map((c) => (c.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i) || [])[1] ?? '').join('')
    return rawString ? joined : coerceMarkupScalar(joined, false)
  }
  if (!rawString) {
    const [parsed, nested] = parseNestedMarkupValue(String(raw ?? ''), config)
    if (parsed) return nested
  }
  return coerceMarkupScalar(raw, rawString)
}

function parseProtocolParameters(body: string, protocol: ProtocolSpec, config: ToolCallConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const re = protocolTagBlockRe(protocol, protocol.tags.parameter)
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const name = extractNameAttr(m[1])
    if (name) out[name] = decodeMarkupValue(m[2], name, config)
  }
  if (Object.keys(out).length) return out
  return parseTextKVInput(body)
}

function filterInputForTool(name: string, input: Record<string, unknown>, tools: Array<Record<string, unknown>>): Record<string, unknown> {
  const properties = schemaProperties(toolSchema(name, tools))
  if (!properties) return { ...input }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key in properties) out[key] = value
  }
  return out
}

function requiredToolArgs(name: string, tools: unknown): string[] {
  const seen = new Set<string>()
  const required: string[] = []
  const add = (...keys: unknown[]) => {
    for (const key of keys) {
      if (typeof key === 'string' && key && !seen.has(key)) {
        seen.add(key)
        required.push(key)
      }
    }
  }
  const schema = toolSchema(name, tools)
  if (isMapping(schema) && Array.isArray(schema.required)) add(...(schema.required as string[]))
  if (name === 'Read') add('file_path')
  else if (name === 'Write') add('file_path', 'content')
  else if (name === 'Edit') add('file_path')
  else if (name === 'Bash' || name === 'PowerShell') add('command')
  return required
}

function toolSchema(name: string, tools: unknown): Record<string, unknown> | null {
  for (const tool of normalizeTools(tools)) {
    if (tool.name === name && isMapping(tool.parameters || tool.input_schema)) {
      return (tool.parameters || tool.input_schema) as Record<string, unknown>
    }
  }
  return null
}

function parseLooseProtocolCalls(
  text: string,
  protocol: ProtocolSpec,
  allowed: Record<string, string>,
  tools: Array<Record<string, unknown>>,
  config: ToolCallConfig,
): ParsedToolCall[] {
  if (!new RegExp('\\b' + protocol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) return []
  const attrRe = /\b(?:name|parameter)\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.:-]+))/gi
  const attributes: Array<{ raw: string; name: string; isTool: boolean; position: number }> = []
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(text)) !== null) {
    const raw = htmlUnescape((m[1] ?? m[2] ?? m[3] ?? '').trim())
    if (!raw) continue
    const name = canonicalToolName(raw, allowed, config)
    attributes.push({ raw, name: name || raw, isTool: Boolean(name), position: m.index })
  }
  const calls: ParsedToolCall[] = []
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes[index]
    if (!attribute.isTool) continue
    const nextTool = (attributes.slice(index + 1).find((item) => item.isTool) || { position: text.length }).position!
    const input: Record<string, unknown> = {}
    for (const field of attributes.slice(index + 1)) {
      if (field.position >= nextTool || field.isTool) break
      const cdata = text.slice(field.position, nextTool).match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)
      if (cdata) input[field.raw] = decodeMarkupValue(cdata[1], field.raw, config)
    }
    const filtered = filterInputForTool(attribute.name, input, tools)
    if (!Object.keys(filtered).length && requiredToolArgs(attribute.name, tools).length) continue
    calls.push(newParsedToolCall(attribute.name, filtered))
  }
  return calls
}

function parseProtocolMarkup(
  text: unknown,
  protocol: ProtocolSpec,
  allowed: Record<string, string>,
  tools: Array<Record<string, unknown>>,
  config: ToolCallConfig,
): ParsedToolCall[] {
  const canonical = canonicalizeMarkup(stripMarkdownFences(String(text ?? '')))
  const calls: ParsedToolCall[] = []
  const rootRe = protocolTagBlockRe(protocol, protocol.tags.root)
  let m: RegExpExecArray | null
  while ((m = rootRe.exec(canonical)) !== null) {
    const invokeRe = protocolTagBlockRe(protocol, protocol.tags.invoke)
    let im: RegExpExecArray | null
    while ((im = invokeRe.exec(m[2])) !== null) {
      const name = canonicalToolName(extractNameAttr(im[1]), allowed, config)
      if (!name) continue
      const input = parseProtocolParameters(im[2], protocol, config)
      calls.push(newParsedToolCall(name, input))
    }
  }
  if (!calls.length) calls.push(...parseLooseProtocolCalls(canonical, protocol, allowed, tools, config))
  return calls
}

function parseXmlToolCalls(text: unknown, allowed: Record<string, string>, config: ToolCallConfig): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  const rawText = String(text ?? '')
  const re = /<tool_call\b[^>]*>\s*([\s\S]*?)\s*<\/tool_call\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(rawText)) !== null) {
    const body = m[1].trim()
    const [ok, parsed] = tryJson(body)
    calls.push(...parseJsonToolCalls(ok ? parsed : parseToolInput(body), allowed, config))
  }
  for (const expression of [
    /<tool_use\b([^>]*)>([\s\S]*?)<\/tool_use>/gi,
    /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi,
    /<function\b([^>]*)>([\s\S]*?)<\/function>/gi,
    /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi,
  ]) {
    let em: RegExpExecArray | null
    while ((em = expression.exec(rawText)) !== null) {
      const name = canonicalToolName(extractNameAttr(em[1]), allowed, config)
      if (name) calls.push(newParsedToolCall(name, parseToolInput(em[2].trim())))
    }
  }
  return calls
}

function parseJsonToolCalls(value: unknown, allowed: Record<string, string>, config: ToolCallConfig): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  if (Array.isArray(value)) {
    for (const item of value) calls.push(...parseJsonToolCalls(item, allowed, config))
    return calls
  }
  if (!isMapping(value)) return calls
  for (const key of ['tool_calls', 'tools']) {
    if (Array.isArray(value[key])) {
      for (const item of value[key]) calls.push(...parseJsonToolCalls(item, allowed, config))
    }
  }
  let name = firstString(value.name, value.tool, value.tool_name, value.function_name)
  let input = firstDefined(value.input, value.arguments, value.args, value.parameters)
  const fn = value.function
  if (isMapping(fn)) {
    name = name || firstString(fn.name)
    if (input === null || input === undefined) {
      input = firstDefined(fn.arguments, fn.input, fn.parameters)
    }
  }
  const canonicalName = canonicalToolName(name, allowed, config)
  if (canonicalName) {
    calls.push(newParsedToolCall(canonicalName, normalizeToolInput(input), firstString(value.id, value.call_id) || undefined))
  }
  return calls
}

function parseTextKVToolCalls(
  text: unknown,
  allowed: Record<string, string>,
  tools: Array<Record<string, unknown>>,
  config: ToolCallConfig,
): ParsedToolCall[] {
  const values: Record<string, string[]> = { name: [], arguments: [] }
  let current = ''
  const aliases: Record<string, string> = {
    'function.name': 'name', 'name': 'name', 'tool': 'name', 'tool.name': 'name', 'tool_name': 'name',
    'function.arguments': 'arguments', 'arguments': 'arguments', 'args': 'arguments',
    'input': 'arguments', 'tool_input': 'arguments', 'parameters': 'arguments',
  }
  const lines = String(text ?? '').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const m = line.match(/^([A-Za-z_.-][A-Za-z0-9_.-]*)\s*:\s*(.*)$/)
    if (m && aliases[m[1].toLowerCase()] !== undefined) {
      current = aliases[m[1].toLowerCase()]
      values[current].push(m[2].trim())
      continue
    }
    if (current) values[current].push(rawLine)
  }
  if (!values.name.length) return []
  const rawName = values.name.join('\n').split('\n')[0].trim().replace(/^['"]|['"]$/g, '')
  const name = canonicalToolName(rawName, allowed, config)
  if (!name) return []
  const input = normalizeToolInput(values.arguments.join('\n').trim())
  const call = coerceParsedCall(newParsedToolCall(name, input), tools, config)
  return call ? [call] : []
}

function coerceValueBySchema(value: unknown, schema: Record<string, unknown>): unknown {
  const types = schemaTypes(schema)
  if (typeof value === 'string' && (types.has('array') || types.has('object'))) {
    const [parsed, changed] = parseJsonStringForSchema(value, types.has('array'), types.has('object'))
    if (changed) value = parsed
  }
  if (types.has('array')) {
    if (isMapping(value)) value = [value]
    if (Array.isArray(value) && isMapping(schema.items)) {
      return value.map((item) => coerceValueBySchema(item, schema.items as Record<string, unknown>))
    }
    return value
  }
  if (types.has('object') && isMapping(value)) {
    const properties = schemaProperties(schema)
    if (!properties) return value
    const fixed: Record<string, unknown> = { ...value }
    for (const [key, child] of Object.entries(properties)) {
      if (key in fixed && isMapping(child)) fixed[key] = coerceValueBySchema(fixed[key], child)
    }
    return fixed
  }
  return value
}

function parseJsonStringForSchema(value: string, wantArray: boolean, wantObject: boolean): [unknown, boolean] {
  const stripped = value.trim()
  if (!stripped) return [value, false]
  const candidates = [stripped]
  if (wantArray && !stripped.startsWith('[')) candidates.push('[' + stripped + ']')
  for (const candidate of candidates) {
    const [ok, parsed] = tryJson(candidate)
    if (!ok) continue
    if (wantArray && Array.isArray(parsed)) return [parsed, true]
    if (wantArray && isMapping(parsed)) return [[parsed], true]
    if (wantObject && isMapping(parsed)) return [parsed, true]
  }
  return [value, false]
}

function coerceToolInputBySchema(name: string, input: unknown, tools: Array<Record<string, unknown>>): unknown {
  if (!isMapping(input)) return input
  const properties = schemaProperties(toolSchema(name, tools))
  if (!properties) return input
  const fixed: Record<string, unknown> = { ...input }
  for (const [key, value] of Object.entries(fixed)) {
    if (isMapping(properties[key])) fixed[key] = coerceValueBySchema(value, properties[key] as Record<string, unknown>)
  }
  return fixed
}

function missingRequiredArgs(name: string, input: unknown, tools: unknown): boolean {
  if (!isMapping(input)) return false
  for (const key of requiredToolArgs(name, tools)) {
    const value = input[key]
    if (value === null || value === undefined) return true
    if (typeof value === 'string' && !value.trim() && !requiredArgAllowsEmptyString(name, key)) return true
  }
  return false
}

function requiredArgAllowsEmptyString(toolName: string, argumentName: string): boolean {
  const t = toolAliasKey(toolName)
  const a = toolAliasKey(argumentName)
  return (t === 'write' || t === 'writefile' || t === 'createfile') &&
    (a === 'content' || a === 'text' || a === 'body' || a === 'data' || a === 'value' || a === 'contents' || a === 'filecontent')
}

function invalidToolArgs(input: unknown): boolean {
  if (!isMapping(input)) return false
  return Object.entries(input).some(([key, value]) => isPathLikeArgName(key) && pathLikeArgLooksPolluted(String(value ?? '')))
}

function isPathLikeArgName(name: unknown): boolean {
  const key = toolAliasKey(name)
  return ['path', 'filepath', 'filename', 'targetfile', 'file', 'dir', 'directory', 'cwd', 'workdir', 'workingdirectory'].includes(key)
}

function pathLikeArgLooksPolluted(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0') || /[\r\n<>]/.test(trimmed)) return true
  const lowered = trimmed.toLowerCase()
  const markers = [
    '<![cdata[', ']]>', 'xyml|', 'qnml|', 'tool_calls', 'invoke name=', 'parameter name=',
    '</parameter', '</invoke', 'function.name:', 'function.arguments:',
  ]
  return markers.some((marker) => lowered.includes(marker))
}

function coerceParsedCall(
  call: ParsedToolCall,
  tools: Array<Record<string, unknown>>,
  config: ToolCallConfig,
): ParsedToolCall | null {
  const input = coerceToolInput(call.name, call.input, tools, { config })
  if (config.unknownTool === 'error' && toolSchema(call.name, tools) === null) {
    throw new Error('Unknown tool: ' + call.name)
  }
  if (missingRequiredArgs(call.name, input, tools)) {
    if (config.missingRequired === 'error' || config.strict) {
      throw new Error('Missing required arguments for tool: ' + call.name)
    }
    if (config.missingRequired === 'drop') return null
  }
  if (invalidToolArgs(input)) return null
  return { id: call.id, name: call.name, input }
}

function renameFirstPresent(obj: Record<string, unknown>, canonical: string, ...aliases: string[]): void {
  if (obj[canonical] !== null && obj[canonical] !== undefined) return
  for (const alias of aliases) {
    if (obj[alias] !== null && obj[alias] !== undefined) {
      obj[canonical] = obj[alias]
      delete obj[alias]
      return
    }
  }
}

function toolAcceptsField(name: string, tools: unknown, field: string): boolean {
  const properties = schemaProperties(toolSchema(name, tools))
  return Boolean(properties && field in properties)
}

export function coerceToolInput(
  name: string,
  input: unknown,
  tools?: unknown,
  opts?: { config?: Partial<ToolCallConfig> },
): unknown {
  const config = resolveConfig(opts?.config)
  const normalizedTools = normalizeTools(tools)
  const raw = coerceToolInputBySchema(name, input, normalizedTools)
  if (!isMapping(raw)) return raw
  const fixed: Record<string, unknown> = { ...raw }
  const aliases = isMapping(config.argumentAliases) ? config.argumentAliases : {}
  for (const [canonical, alternateNames] of Object.entries(aliases)) {
    renameFirstPresent(fixed, canonical, ...asList(alternateNames).map(String))
  }
  if (name === 'AskUserQuestion') {
    if (fixed.question !== null && fixed.question !== undefined && fixed.questions === undefined) {
      fixed.questions = [
        {
          question: fixed.question,
          header: 'Question',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'Confirm' },
            { label: 'No', description: 'Decline' },
          ],
        },
      ]
      delete fixed.question
    }
    if (fixed.questions !== null && fixed.questions !== undefined && !Array.isArray(fixed.questions)) {
      fixed.questions = [fixed.questions]
    }
  } else if (name === 'Agent') {
    if (fixed.description === undefined) fixed.description = 'Execute sub-task'
    if (fixed.prompt === undefined) fixed.prompt = fixed.description
  } else if (name === 'Read') {
    renameFirstPresent(fixed, 'file_path', 'path', 'filename', 'file')
  } else if (name === 'Write') {
    renameFirstPresent(fixed, 'file_path', 'path', 'target_file', 'filename', 'file')
    renameFirstPresent(fixed, 'content', 'text', 'body', 'data', 'file_content', 'contents', 'value')
  } else if (name === 'Edit') {
    renameFirstPresent(fixed, 'file_path', 'path', 'target_file', 'filename', 'file')
  } else if (name === 'Bash' || name === 'PowerShell') {
    renameFirstPresent(fixed, 'command', 'cmd', 'script')
  } else if (fixed.query === undefined && fixed.queries !== undefined && toolAcceptsField(name, normalizedTools, 'query')) {
    const queries = fixed.queries
    delete fixed.queries
    if (Array.isArray(queries)) fixed.query = queries.filter((q) => String(q)).join('\n')
    else fixed.query = String(queries).trim()
  }
  return fixed
}

function dedupeToolCalls(calls: ParsedToolCall[]): ParsedToolCall[] {
  const seen = new Set<string>()
  const out: ParsedToolCall[] = []
  for (const call of calls) {
    const key = toolAliasKey(call.name) + '\0' + stableStringify(call.input)
    if (!call.name || seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

/**
 * 从模型输出文本中解析工具调用（markup / XML / JSON / text-kv 四种格式）。
 */
export function parseToolCalls(
  text: unknown,
  tools?: unknown,
  opts?: { config?: Partial<ToolCallConfig> },
): ParsedToolCall[] {
  const config = resolveConfig(opts?.config)
  const normalizedTools = normalizeTools(tools)
  if (!String(text ?? '').trim() || !normalizedTools.length) return []
  const allowed = buildAllowedToolMap(normalizedTools, config)
  const calls: ParsedToolCall[] = []
  try {
    if (config.enableMarkup) {
      for (const protocol of config.parseProtocols) {
        calls.push(...parseProtocolMarkup(text, protocol, allowed, normalizedTools, config))
      }
    }
    if (config.enableXml) calls.push(...parseXmlToolCalls(text, allowed, config))
    if (config.enableJson) forEachJsonFragment(text, (value) => calls.push(...parseJsonToolCalls(value, allowed, config)))
    if (config.enableTextKV) calls.push(...parseTextKVToolCalls(text, allowed, normalizedTools, config))
    if (config.enableCoercion) {
      const coerced: ParsedToolCall[] = []
      for (const call of calls) {
        const c = coerceParsedCall(call, normalizedTools, config)
        if (c) coerced.push(c)
      }
      return config.enableDedupe ? dedupeToolCalls(coerced) : coerced
    }
    return config.enableDedupe ? dedupeToolCalls(calls) : calls
  } catch {
    return []
  }
}

export function openAIToolCalls(calls: unknown): Array<Record<string, unknown>> {
  return asList(calls).map((call) => ({
    id: callValue(call, 'id'),
    type: 'function',
    function: {
      name: callValue(call, 'name'),
      arguments: argumentsString(callValue(call, 'input', {})),
    },
  }))
}

// ===== 流式分块解析 =====

function firstToolMarkerIndex(text: string, config: ToolCallConfig): number {
  const indexes: number[] = []
  for (const protocol of config.parseProtocols) {
    for (const tag of [protocol.tags.root, protocol.tags.invoke]) {
      const m = protocolOpenTagRe(protocol, tag).exec(text)
      if (m) indexes.push(m.index)
    }
  }
  for (const expression of [/^\s*\{\s*"tool_calls"/i, /function\.name\s*:/i]) {
    const m = expression.exec(text)
    if (m) indexes.push(m.index)
  }
  return indexes.length ? Math.min(...indexes) : -1
}

function hasOpenProtocolBlock(text: string, config: ToolCallConfig): boolean {
  for (const protocol of config.parseProtocols) {
    if (protocolOpenTagRe(protocol, protocol.tags.root).exec(text) || protocolOpenTagRe(protocol, protocol.tags.invoke).exec(text)) {
      return true
    }
  }
  return false
}

function looksStructurallyClosed(text: string, config: ToolCallConfig): boolean {
  if (/\n\s*[\]}]\s*$/.test(text)) return true
  for (const protocol of config.parseProtocols) {
    const name = protocol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tag = protocol.tags.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`<\\s*/\\s*\\|\\s*${name}\\s*\\|\\s*${tag}\\s*>`, 'i').test(text)) return true
  }
  return false
}

/**
 * 返回文本中「第一个已闭合协议块」的结束位置（不含之后的剩余内容）。
 * 用于流式解析：一次 capture 内可能同时包含多个连续工具块（前一块的闭合标签
 * 与后一块的开标签在同一 chunk 到达），只消费第一个完整块，剩余内容交由
 * processChunk 继续处理，避免后一块的开标签被吞掉、尾部标记裸漏给客户端。
 * 找不到可确定的块边界时返回 -1（视为整段是一个块）。
 */
function firstClosedBlockEnd(text: string, config: ToolCallConfig): number {
  let best = -1
  // 协议根闭合标签：</|XYML|tool_calls> / </|QNML|tool_calls>
  for (const protocol of config.parseProtocols) {
    const name = protocol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tag = protocol.tags.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`<\\s*/\\s*\\|\\s*${name}\\s*\\|\\s*${tag}\\s*>`, 'i')
    const m = re.exec(text)
    if (m) {
      const end = m.index + m[0].length
      best = best === -1 ? end : Math.min(best, end)
    }
  }
  // 普通 XML 工具块闭合标签：</tool_call> </tool_use> </function> </invoke>
  for (const tag of ['tool_call', 'tool_use', 'function', 'invoke']) {
    const m = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i').exec(text)
    if (m) {
      const end = m.index + m[0].length
      best = best === -1 ? end : Math.min(best, end)
    }
  }
  return best
}

/**
 * 剥离流式正文里漏网的协议标记残片（未配对的 XYML 标签、CDATA 结束符、
 * 普通 XML 工具标签、行首协议说明行），避免原始工具标记显示给客户端。
 * 仅作兜底：正常情况下工具块都已被 ToolSieve 捕获解析，此处只处理截断/残缺块。
 */
function scrubToolFragments(text: unknown): string {
  let t = String(text ?? '')
  t = t.replace(/<!\[CDATA\[/g, '')
  t = t.replace(/\]\]>/g, '')
  // 完整协议标签（开/闭，单/双 tag，含属性）：<|XYML|tool_calls> </|XYML|parameter name="..."> <|XYML|tool_calls>
  t = t.replace(/<\s*\/?\s*\|\s*[A-Za-z][A-Za-z0-9_]*\s*\|\s*[A-Za-z_][A-Za-z0-9_.:-]*(\s[^>]*)?>/gi, '')
  t = t.replace(/<\s*\/?\s*\|\s*[A-Za-z][A-Za-z0-9_]*\s*\|?>/gi, '')
  // 截断残片（无 >）：</|XYML|、<|XYML|、</|XYML —— 精确匹配标签本身，不吞后续正文（如路径/行号）
  t = t.replace(/<\s*\/?\s*\|\s*[A-Za-z][A-Za-z0-9_]*\s*\|?/gi, '')
  t = t.replace(/<\/?(?:tool_call|tool_use|function|invoke|parameter)\b[^>]*>/gi, '')
  t = t.replace(/^=+\s*(?:XYML|QNML)\s+TOOL CALL PROTOCOL\s*=+$/gim, '')
  t = t.replace(/^Default protocol for new tool calls:.*$/gim, '')
  return t
}

export interface SieveEvent {
  type: 'content' | 'tool_calls'
  text?: string
  calls?: ParsedToolCall[]
}

/**
 * ToolSieve — 流式内容分块：把工具调用标记从普通文本中切出来。
 * hold_length 缓冲窗口内出现协议标记才进入 capture 模式。
 */
export class ToolSieve {
  config: ToolCallConfig
  tools: Array<Record<string, unknown>>
  pending = ''
  capture = ''
  capturing = false
  captureStart = 0
  holdLength: number

  constructor(tools?: unknown, opts?: { config?: Partial<ToolCallConfig>; holdLength?: number }) {
    this.config = resolveConfig(opts?.config)
    this.tools = normalizeTools(tools)
    this.holdLength = opts?.holdLength ?? 96
  }

  processChunk(chunk: unknown): SieveEvent[] {
    if (!chunk) return []
    this.pending += String(chunk)
    const events: SieveEvent[] = []
    // 循环处理：一个 chunk 可能包含多个连续工具块（前一块闭合后紧跟着下一块的开标签）。
    // consumeCapture 只消费第一个完整闭合块并返回 remainder，这里把 remainder 重新喂回，
    // 避免后一块的开标签被吞掉、其尾部闭合标签被当作正文裸漏。
    while (true) {
      if (this.capturing) {
        this.capture += this.pending
        this.pending = ''
        const consumed = this.consumeCapture(false)
        if (consumed === null) return events // 捕获区未闭合，等待更多数据
        events.push(...consumed.events)
        if (!consumed.remainder) return events
        this.pending = consumed.remainder
        continue
      }
      const start = firstToolMarkerIndex(this.pending, this.config)
      if (start >= 0) {
        const prefix = this.pending.slice(0, start)
        if (prefix) events.push({ type: 'content', text: scrubToolFragments(prefix) })
        this.capture = this.pending.slice(start)
        this.pending = ''
        this.capturing = true
        this.captureStart = Date.now()
        const consumed = this.consumeCapture(false)
        if (consumed === null) return events
        events.push(...consumed.events)
        if (!consumed.remainder) return events
        this.pending = consumed.remainder
        continue
      }
      if (this.pending.length <= this.holdLength) return events
      const safe = this.pending.slice(0, -this.holdLength)
      this.pending = this.pending.slice(-this.holdLength)
      if (safe) events.push({ type: 'content', text: scrubToolFragments(safe) })
      return events
    }
  }

  flush(): SieveEvent[] {
    const events: SieveEvent[] = []
    if (this.capturing && this.capture) {
      const consumed = this.consumeCapture(true)
      if (consumed && consumed.events.length) {
        events.push(...consumed.events)
        // 闭合块之后剩余的尾部内容（可能含残缺工具块标记），清洗后再透传
        if (consumed.remainder) events.push({ type: 'content', text: scrubToolFragments(consumed.remainder) })
      } else if (consumed && consumed.remainder) {
        events.push({ type: 'content', text: scrubToolFragments(consumed.remainder) })
      }
      this.capture = ''
      this.capturing = false
    }
    if (this.pending) {
      events.push({ type: 'content', text: scrubToolFragments(this.pending) })
      this.pending = ''
    }
    return events
  }

  private consumeCapture(force: boolean): { events: SieveEvent[]; remainder: string } | null {
    // 捕获区异常判定：
    // 1) hasOpenProtocolBlock 检测到开标签且结构未闭合 → 正常等待更多数据（流式块未到齐）
    // 2) 捕获区超时仍未闭合（模型输出了畸形工具块/流式中断，只有开标签无闭合标签，
    //    后续正文被持续吞入捕获区）→ 强制降级为正文透传，否则客户端"停止返回"。
    const stalled = this.captureStart > 0 && Date.now() - this.captureStart > MAX_CAPTURE_MS
    const tooLong = this.capture.length > MAX_CAPTURE_LEN
    if (!force && !stalled && !tooLong && hasOpenProtocolBlock(this.capture, this.config) && !looksStructurallyClosed(this.capture, this.config)) {
      return null
    }
    this.capturing = false
    this.captureStart = 0
    // 只消费第一个完整闭合块；块之后的剩余内容（后续工具块 / 正文）由 processChunk 继续处理
    const end = firstClosedBlockEnd(this.capture, this.config)
    const blockText = end > 0 ? this.capture.slice(0, end) : this.capture
    const remainder = end > 0 ? this.capture.slice(end) : ''
    this.capture = ''
    const calls = parseToolCalls(blockText, this.tools, { config: this.config })
    // 解析不出工具调用（无可用工具 / 块残缺 / 畸形未闭合块 / 非工具块）时降级为正文透传，
    // 清洗协议标记后输出原文——绝不静默丢弃，否则该轮内容被吞、客户端"停止返回"。
    if (calls.length) return { events: [{ type: 'tool_calls', calls }], remainder }
    const text = scrubToolFragments(blockText)
    return { events: text ? [{ type: 'content', text }] : [], remainder }
  }
}
