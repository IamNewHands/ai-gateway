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
import { buildToolLedger, toolLedgerToAgentLedger, guardToolLedger, toolCallFingerprint, redactEvidence, compactMiddle } from './tool-ledger'
import type { TaskAnchor } from './task-anchors'
import { repairTaskAnchorArtifacts } from './task-anchors'

/** 客户端工具名混淆常量（同 CF2 chathub.ts CLIENT_TOOL_ALIAS_PREFIX） */
const CLIENT_TOOL_ALIAS_PREFIX = 'm365gw_client_'

/** 生成客户端工具混淆名：原名 → `m365gw_client_<hex>`（同 CF2 clientToolWireName） */
export function clientToolWireName(name: string): string {
  const normalized = name.trim()
  if (!normalized) return normalized
  const hex = Array.from(new TextEncoder().encode(normalized), (byte) =>
    byte.toString(16).padStart(2, '0')).join('')
  return `${CLIENT_TOOL_ALIAS_PREFIX}${hex}`
}

type SafeTextDecodeResult = { ok: true; value: unknown } | { ok: false }

function decodeAZHEXString(value: string): string | null {
  let decoded = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === 'Z') {
      const hexadecimal = value.slice(index + 1, index + 3)
      if (/^[0-9A-F]{2}$/u.test(hexadecimal) && value[index + 3] === 'X') {
        decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16))
        index += 3
        continue
      }
      const unicodeHexadecimal = value.slice(index + 1, index + 5)
      if (/^[0-9A-F]{4}$/u.test(unicodeHexadecimal)) {
        const codeUnit = Number.parseInt(unicodeHexadecimal, 16)
        if (codeUnit <= 0x7f) return null
        decoded += String.fromCharCode(codeUnit)
        index += 4
        continue
      }
      return null
    }
    if (character.codePointAt(0)! <= 0x7f && !/^[A-Ya-z0-9]$/u.test(character)) return null
    decoded += character
  }
  return decoded
}

function decodeAZHEXValue(value: unknown, depth = 0, budget = { visited: 0 }): SafeTextDecodeResult {
  budget.visited++
  if (depth > 32 || budget.visited > 50_000) return { ok: false }
  if (typeof value === 'string') {
    const decoded = decodeAZHEXString(value)
    return decoded === null ? { ok: false } : { ok: true, value: decoded }
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { ok: true, value }
  }
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (const item of value) {
      const decoded = decodeAZHEXValue(item, depth + 1, budget)
      if (!decoded.ok) return decoded
      output.push(decoded.value)
    }
    return { ok: true, value: output }
  }
  if (!value || typeof value !== 'object') return { ok: false }
  const entries: Array<[string, unknown]> = []
  const keys = new Set<string>()
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const decodedKey = decodeAZHEXString(key)
    if (decodedKey === null || keys.has(decodedKey)) return { ok: false }
    keys.add(decodedKey)
    const decoded = decodeAZHEXValue(item, depth + 1, budget)
    if (!decoded.ok) return decoded
    entries.push([decodedKey, decoded.value])
  }
  return { ok: true, value: Object.fromEntries(entries) }
}

export function decodeAZHEXArguments(value: unknown): unknown | null {
  let candidate = value
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) } catch { /* scalar encoded value */ }
  }
  const decoded = decodeAZHEXValue(candidate)
  return decoded.ok ? decoded.value : null
}

const SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS: Record<string, readonly string[]> = {
  exec_command: [
    'cmd', 'justification', 'login', 'max_output_tokens', 'prefix_rule',
    'sandbox_permissions', 'shell', 'tty', 'workdir', 'yield_time_ms',
  ],
  write_stdin: ['chars', 'max_output_tokens', 'session_id', 'yield_time_ms'],
  view_image: ['detail', 'path'],
}

function clientToolParameterKeys(name: string, tools: ToolDef[]): Set<string> {
  const keys = new Set(SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS[name] ?? [])
  for (const tool of tools) {
    if (tool.function?.name !== name || !tool.function.parameters || typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)) continue
    const properties = (tool.function.parameters as { properties?: unknown }).properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue
    for (const key of Object.keys(properties as Record<string, unknown>)) keys.add(key)
  }
  return keys
}

/**
 * M365 偶尔把 AZHEX 回退参数的下划线改写为连字符。仅依据已声明 schema
 * 和固定敏感工具参数表进行规范化；若两个输入键映射到同一规范键则拒绝。
 */
export function normalizeClientArgumentKeys(name: string, value: unknown, tools: ToolDef[]): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const canonicalKeys = clientToolParameterKeys(name, tools)
  if (canonicalKeys.size === 0) return value
  const bySignature = new Map<string, string | null>()
  for (const key of canonicalKeys) {
    const signature = key.toLowerCase().replaceAll('-', '').replaceAll('_', '')
    const previous = bySignature.get(signature)
    bySignature.set(signature, previous === undefined || previous === key ? key : null)
  }
  const output: Record<string, unknown> = {}
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
    const signature = rawKey.toLowerCase().replaceAll('-', '').replaceAll('_', '')
    const matched = bySignature.get(signature)
    const key = matched === undefined || matched === null ? rawKey : matched
    if (Object.hasOwn(output, key)) return null
    output[key] = item
  }
  return output
}

/** 从 tools 数组构建混淆名映射：wireName → originalName */
export function buildWireNameMap(tools: ToolDef[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of tools) {
    const name = t.function?.name
    if (name) map.set(clientToolWireName(name), name)
  }
  return map
}

/** 从工具描述/文档中移除客户端工具原名，替换为 'caller function'（同 CF2 redactPublicFunctionNames） */
export function redactPublicFunctionNames(value: string, names: readonly string[]): string {
  let redacted = value
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    redacted = redacted.replace(
      new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'giu'),
      '$1caller function',
    )
  }
  return redacted
}

/** 递归从 schema 的 description/title/$comment 中移除原名（同 CF2 redactSchemaDocumentation） */
export function redactSchemaDocumentation(value: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 64 || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactSchemaDocumentation(item, names, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (['description', 'title', '$comment'].includes(key) && typeof item === 'string') {
        return [key, redactPublicFunctionNames(item, names)]
      }
      return [key, redactSchemaDocumentation(item, names, depth + 1)]
    }),
  )
}

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
  const publicNames = tools.map((t) => t.function?.name || '').filter(Boolean)
  for (const t of tools) {
    const f = t.function
    if (!f || !f.name) continue
    const wireName = clientToolWireName(f.name)
    const description = redactPublicFunctionNames(f.description || '', publicNames)
    const parameters = redactSchemaDocumentation(f.parameters, publicNames)
    let params = '{}'
    try {
      const s = parameters === undefined ? '' : JSON.stringify(parameters)
      if (s && s !== 'null' && s.trim() !== '') params = s
    } catch { /* keep {} */ }
    defs.push(`${wireName} — caller-provided function; ${description}\n\`\`\`${wireName}\n${params}\n\`\`\``)
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

/** 从 M365 返回的文本中解析工具名：接受原名或混淆名，返回原名（未找到返回 null） */
export function resolveToolName(name: string, tools: ToolDef[]): string | null {
  const allowed = allowedToolNames(tools)
  if (allowed.has(name)) return name
  if (name.startsWith(CLIENT_TOOL_ALIAS_PREFIX)) {
    for (const t of tools) {
      if (t.function?.name && clientToolWireName(t.function.name) === name) {
        return t.function.name
      }
    }
  }
  return null
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

/** JSON Schema 校验（移植自 M365-Gateway-CF2 tool-schema.ts 的 validateJSONSchema）。
 *  返回错误信息或 null。
 *  安全护栏：MAX_SCHEMA_DEPTH=64 限制递归深度、MAX_VALIDATION_NODES=50000 限制单次校验遍历节点数，
 *  防止调用方 schema 引发远程引用/无限递归。
 *  支持：type（含 type 数组）、enum、const、properties/required/additionalProperties、
 *  items/minItems/maxItems/uniqueItems、minProperties/maxProperties、minLength/maxLength、
 *  数值边界（minimum、maximum、exclusive min/max、multipleOf）、$ref（仅本地引用）、allOf/anyOf/oneOf/not。 */
const MAX_SCHEMA_DEPTH = 64
const MAX_VALIDATION_NODES = 50000

interface SchemaState {
  nodes: number
  /** 根 schema，用于解析 $ref 本地引用 */
  root: unknown
}

function schemaIsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function schemaJsonEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true
  if (depth > MAX_SCHEMA_DEPTH) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => schemaJsonEqual(value, right[index], depth + 1))
  }
  if (schemaIsObject(left) && schemaIsObject(right)) {
    const lk = Object.keys(left).sort()
    const rk = Object.keys(right).sort()
    return lk.length === rk.length && lk.every((key, index) => key === rk[index] && schemaJsonEqual(left[key], right[key], depth + 1))
  }
  return false
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return schemaIsObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/** 解析本地 $ref（仅 "#" / "#/..."，拒绝远程引用） */
function schemaLocalReference(root: unknown, reference: string): unknown {
  if (reference === '#') return root
  if (!reference.startsWith('#/')) return undefined
  let current: unknown = root
  for (const rawPart of reference.slice(2).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~')
    if (schemaIsObject(current) || Array.isArray(current)) {
      if (!(part in current)) return undefined
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

export function validateJSONSchema(value: unknown, schema: Record<string, unknown> | boolean, path: string, depth = 0, state?: SchemaState): string | null {
  const st: SchemaState = state ?? { nodes: 0, root: schema }
  st.nodes++
  if (st.nodes > MAX_VALIDATION_NODES) return `${path} validation nodes exceeded safe limit`
  if (depth > MAX_SCHEMA_DEPTH) return `${path} schema exceeds max depth`
  if (schema === true) return null
  if (schema === false) return `${path} is rejected by the false schema`

  // $ref：先解析到目标 schema 再继续校验；远程引用（非 "#/..."）一律拒绝
  if (typeof schema['$ref'] === 'string') {
    const target = schemaLocalReference(st.root, schema['$ref'])
    if (target === undefined || target === schema) return `${path} unresolvable or recursive $ref`
    const err = validateJSONSchema(value, target as Record<string, unknown>, path, depth + 1, st)
    if (err) return err
    // $ref 命中后仍继续校验当前节点的其余关键字（const/enum 等）
  }

  // const / enum
  if ('const' in schema && !schemaJsonEqual(value, schema['const'])) return `${path} must equal the const value`
  const enums = schema['enum']
  if (Array.isArray(enums) && !enums.some((e) => schemaJsonEqual(value, e))) return `${path} is not an allowed enum value`

  // allOf / anyOf / oneOf / not
  if (Array.isArray(schema['allOf'])) {
    for (let i = 0; i < schema['allOf'].length; i++) {
      const err = validateJSONSchema(value, (schema['allOf'][i] as Record<string, unknown>), `${path}`, depth + 1, st)
      if (err) return err
    }
  }
  if (Array.isArray(schema['anyOf'])) {
    let anyMatch = false
    for (const branch of schema['anyOf'] as unknown[]) {
      if (validateJSONSchema(value, branch as Record<string, unknown>, path, depth + 1, st) === null) { anyMatch = true; break }
    }
    if (!anyMatch) return `${path} does not match any anyOf branch`
  }
  if (Array.isArray(schema['oneOf'])) {
    let matches = 0
    for (const branch of schema['oneOf'] as unknown[]) {
      if (validateJSONSchema(value, branch as Record<string, unknown>, path, depth + 1, st) === null) matches++
    }
    if (matches !== 1) return `${path} must match exactly one oneOf branch (matched ${matches})`
  }
  if (schema['not'] !== undefined) {
    if (validateJSONSchema(value, schema['not'] as Record<string, unknown>, path, depth + 1, st) === null) {
      return `${path} must not match the not schema`
    }
  }

  const declaredTypes: string[] = typeof schema['type'] === 'string'
    ? [schema['type']]
    : Array.isArray(schema['type'])
      ? (schema['type'] as unknown[]).filter((item): item is string => typeof item === 'string')
      : []
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => schemaTypeMatches(value, type))) {
    return `${path} must be of type ${declaredTypes.join('/')}`
  }
  const typeCheck = (type: string): boolean => declaredTypes.length === 0 || declaredTypes.includes(type)

  // object 结构
  if (schemaIsObject(value) && typeCheck('object')) {
    const m = value as Record<string, unknown>
    const keys = Object.keys(m)
    if (typeof schema['minProperties'] === 'number' && keys.length < schema['minProperties']) return `${path} has too few properties`
    if (typeof schema['maxProperties'] === 'number' && keys.length > schema['maxProperties']) return `${path} has too many properties`
    const req = schema['required']
    if (Array.isArray(req)) {
      for (const raw of req) {
        const n = String(raw)
        if (!Object.hasOwn(m, n)) return `missing required argument ${n}`
      }
    }
    const props = (schema['properties'] as Record<string, unknown>) || {}
    const ap = schema['additionalProperties']
    for (const n of keys) {
      if (n in props) {
        const ps = props[n] as Record<string, unknown> | undefined
        if (ps) {
          const err = validateJSONSchema(m[n], ps, `${path}.${n}`, depth + 1, st)
          if (err) return err
        }
      } else if (ap === false) {
        return `${path}.${n} is not allowed`
      } else if (schemaIsObject(ap) || typeof ap === 'boolean') {
        const err = validateJSONSchema(m[n], ap as Record<string, unknown>, `${path}.${n}`, depth + 1, st)
        if (err) return err
      }
    }
  }

  // array 结构
  if (Array.isArray(value) && typeCheck('array')) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return `${path} has too few items`
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return `${path} has too many items`
    if (schema['uniqueItems'] === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (schemaJsonEqual(value[i], value[j])) return `${path} must contain unique items`
        }
      }
    }
    const item = schema['items'] as Record<string, unknown> | undefined
    if (item) {
      for (let i = 0; i < value.length; i++) {
        const err = validateJSONSchema(value[i], item, `${path}[${i}]`, depth + 1, st)
        if (err) return err
      }
    }
  }

  // string 边界
  if (typeof value === 'string' && typeCheck('string')) {
    const length = Array.from(value).length
    if (typeof schema['minLength'] === 'number' && length < schema['minLength']) return `${path} is shorter than minLength`
    if (typeof schema['maxLength'] === 'number' && length > schema['maxLength']) return `${path} is longer than maxLength`
  }

  // number 边界
  if (typeof value === 'number' && Number.isFinite(value) && (typeCheck('number') || typeCheck('integer'))) {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) return `${path} is below minimum`
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) return `${path} is above maximum`
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) return `${path} is not above exclusiveMinimum`
    if (typeof schema['exclusiveMaximum'] === 'number' && value >= schema['exclusiveMaximum']) return `${path} is not below exclusiveMaximum`
    if (typeof schema['multipleOf'] === 'number' && schema['multipleOf'] > 0) {
      const quotient = value / schema['multipleOf']
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) {
        return `${path} is not a multiple of ${schema['multipleOf']}`
      }
    }
  }

  return null
}

function schemaValid(args: Record<string, unknown>, fn: Record<string, unknown>): string | null {
  const params = fn['parameters']
  if (params === null || typeof params !== 'object') return null
  return validateJSONSchema(args, params as Record<string, unknown>, 'arguments')
}

const INTEGRITY_SENSITIVE_CLIENT_TOOLS = new Set(['exec_command', 'write_stdin', 'view_image'])

function boundedInteger(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 1_000_000_000
}

/**
 * Responses continuation 可能省略 tools 数组。仅对固定敏感工具使用封闭参数表和严格类型校验，
 * 未知属性、错误类型和越界整数均拒绝，避免把 continuation 兼容变成通用 schema 绕过。
 */
function acceptsFixedSensitiveClientCall(name: string, args: Record<string, unknown>): boolean {
  if (!INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(name)) return false
  const allowed = new Set(SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS[name])
  if (Object.keys(args).some((key) => !allowed.has(key))) return false

  if (name === 'exec_command') {
    if (typeof args.cmd !== 'string') return false
    if (args.justification !== undefined && typeof args.justification !== 'string') return false
    if (args.login !== undefined && typeof args.login !== 'boolean') return false
    if (args.max_output_tokens !== undefined && !boundedInteger(args.max_output_tokens, 1)) return false
    if (args.prefix_rule !== undefined
      && (!Array.isArray(args.prefix_rule) || args.prefix_rule.some((item) => typeof item !== 'string'))) return false
    if (args.sandbox_permissions !== undefined
      && !['use_default', 'require_escalated'].includes(String(args.sandbox_permissions))) return false
    if (args.shell !== undefined && typeof args.shell !== 'string') return false
    if (args.tty !== undefined && typeof args.tty !== 'boolean') return false
    if (args.workdir !== undefined && typeof args.workdir !== 'string') return false
    if (args.yield_time_ms !== undefined && !boundedInteger(args.yield_time_ms, 0)) return false
    return true
  }

  if (name === 'write_stdin') {
    if (!boundedInteger(args.session_id, 1)) return false
    if (args.chars !== undefined && typeof args.chars !== 'string') return false
    if (args.max_output_tokens !== undefined && !boundedInteger(args.max_output_tokens, 1)) return false
    if (args.yield_time_ms !== undefined && !boundedInteger(args.yield_time_ms, 0)) return false
    return true
  }

  if (typeof args.path !== 'string' || !args.path.trim()) return false
  return args.detail === undefined || args.detail === 'high' || args.detail === 'original'
}

/**
 * 兼容旧 exec_command schema 仅遗漏安全执行控制字段的情况。命令及路径、shell 类型保持严格，
 * 并保留调用方已声明 schema 的全部 required 字段约束。
 */
function acceptsBoundedExecArguments(name: string, args: Record<string, unknown>, tools: ToolDef[]): boolean {
  if (name !== 'exec_command' || typeof args.cmd !== 'string') return false
  if (args.workdir !== undefined && typeof args.workdir !== 'string') return false
  if (args.shell !== undefined && typeof args.shell !== 'string') return false
  if (args.max_output_tokens !== undefined && !boundedInteger(args.max_output_tokens, 1)) return false
  if (args.yield_time_ms !== undefined && !boundedInteger(args.yield_time_ms, 0)) return false

  const declared = tools.find((tool) => tool.function?.name === name)
  const schema = declared?.function?.parameters
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const required = (schema as Record<string, unknown>)['required']
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.hasOwn(args, key)) return false
      }
    }
  }
  return true
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
    // continuation 可能省略 tools；仅固定敏感工具可继续进入封闭校验。
    if (!fn && !INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(c.name)) { dropped++; continue }
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
    const hasAZHEXToken = /Z[0-9A-F]{2}X/u.test(raw)
    const decoded = hasAZHEXToken ? decodeAZHEXArguments(args) : args
    const normalized = decoded === null ? null : normalizeClientArgumentKeys(c.name, decoded, tools)
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) { dropped++; continue }
    args = normalized as Record<string, unknown>
    const schemaAccepted = fn !== null && schemaValid(args, fn) === null
    const fixedSensitiveAccepted = acceptsFixedSensitiveClientCall(c.name, args)
    const boundedExecAccepted = acceptsBoundedExecArguments(c.name, args, tools)
    if (!schemaAccepted && !fixedSensitiveAccepted && !boundedExecAccepted) { dropped++; continue }
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
      const rawName = typeof mi['name'] === 'string' ? mi['name'] : ''
      // 解析原名或混淆名
      const resolved = resolveToolName(rawName, tools)
      const name = resolved ?? rawName
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
 * 工具名使用混淆名（m365gw_client_<hex>），防止 M365 识别客户端工具原名。
 */
export function modelToolRouterPrompt(text: string, tools: ToolDef[], choice: unknown): string {
  const wireTools = tools.map((t) => ({
    ...t,
    function: {
      ...t.function,
      name: clientToolWireName(t.function?.name || ''),
      description: redactPublicFunctionNames(t.function?.description || '', tools.map((tt) => tt.function?.name || '').filter(Boolean)),
      parameters: redactSchemaDocumentation(t.function?.parameters, tools.map((tt) => tt.function?.name || '').filter(Boolean)),
    },
  }))
  const defs = JSON.stringify(wireTools)
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
  // 1) CALL_TOOL: name({...}) 自然语言格式（支持原名或混淆名）
  if (t.startsWith('CALL_TOOL:') || lower.startsWith('call_tool:')) {
    const rest = t.slice(t.indexOf(':') + 1).trim()
    const start = rest.indexOf('(')
    const end = rest.lastIndexOf(')')
    if (start > 0 && end > start) {
      const rawName = rest.slice(0, start).trim()
      const argsStr = rest.slice(start + 1, end)
      try {
        const args = JSON.parse(argsStr) as Record<string, unknown>
        if (args !== null && typeof args === 'object') {
          // 解析混淆名 → 原名
          const resolved = resolveToolName(rawName, tools)
          const name = resolved ?? rawName
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
  // 3) 兜底：fenced code block 或 JSON envelope {"decision": ...} / {"calls":[...]}
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
      const env = JSON.parse(inner) as Record<string, unknown>
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        const keys = Object.keys(env).sort()
        // 严格 decision=answer
        if (keys.length === 2 && keys[0] === 'decision' && keys[1] === 'text' && env['decision'] === 'answer' && typeof env['text'] === 'string') {
          return { calls: [], parsed: true }
        }
        // 严格 decision=tool_call
        if (
          keys.length === 3 &&
          keys[0] === 'arguments' &&
          keys[1] === 'decision' &&
          keys[2] === 'name' &&
          env['decision'] === 'tool_call' &&
          typeof env['name'] === 'string' &&
          env['arguments'] &&
          typeof env['arguments'] === 'object' &&
          !Array.isArray(env['arguments'])
        ) {
          const rawName = env['name'] as string
          const resolved = resolveToolName(rawName, tools)
          const name = resolved ?? rawName
          const fn = toolFunction(name, tools)
          const argsObj = env['arguments'] as Record<string, unknown>
          if (fn && schemaValid(argsObj, fn) === null && toolChoiceAllows(choice, name)) {
            return {
              calls: [{ id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: JSON.stringify(argsObj) }],
              parsed: true,
            }
          }
        }
      }
      if (env && Array.isArray(env['calls'])) {
        const calls: DetectedToolCall[] = []
        for (const c of env['calls'] as Array<{ name?: string; arguments?: unknown }>) {
          if (!c || typeof c !== 'object') continue
          const rawName = String(c.name || '')
          const resolved = resolveToolName(rawName, tools)
          const name = resolved ?? rawName
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

/** 从回答文本解析所有 fenced 工具调用（含 <m365-tool-call> 与 ```name\n{json}\n``` 两种约定）
 *  支持原名和混淆名（m365gw_client_<hex>），混淆名自动解析为原名。 */
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
      const rawName = c.name
      const resolved = resolveToolName(rawName, tools)
      const name = resolved ?? rawName
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
      const rawName = m[1]
      const resolved = resolveToolName(rawName, tools)
      const name = resolved ?? rawName
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

/** 从原生工具事件列表提取工具调用（同原版 nativeToolCalls，遍历事件树找 name/arguments）
 *  支持原名和混淆名（m365gw_client_<hex>），混淆名自动解析为原名。 */
export function nativeToolCalls(events: unknown[], tools: ToolDef[]): DetectedToolCall[] {
  const names = new Map<string, string>()
  for (const t of tools) {
    const name = t.function?.name
    if (!name) continue
    names.set(name, name)
    names.set(clientToolWireName(name), name)
  }

  const out: DetectedToolCall[] = []
  let visited = 0
  const walk = (x: unknown, depth: number, inheritedInvocationContext = false): void => {
    if (depth > 32 || visited++ > 50_000 || x === null || typeof x !== 'object') return
    if (Array.isArray(x)) {
      for (const item of x) walk(item, depth + 1, inheritedInvocationContext)
      return
    }

    const obj = x as Record<string, unknown>
    const invocationContext = inheritedInvocationContext || [obj['contentType'], obj['messageType'], obj['type'], obj['kind']]
      .some((item) => typeof item === 'string' && /(?:tool|function|plugin).*(?:call|invocation)|(?:call|invocation).*(?:tool|function|plugin)/iu.test(item))
    const candidates: Array<{ name: unknown; fields: string[] }> = [
      { name: obj['functionName'], fields: ['functionArguments', 'arguments', 'args', 'input', ...(invocationContext ? ['parameters'] : [])] },
      { name: obj['toolName'], fields: ['arguments', 'args', 'input', 'functionArguments', ...(invocationContext ? ['parameters'] : [])] },
      { name: obj['pluginName'], fields: ['arguments', 'args', 'input', 'functionArguments', ...(invocationContext ? ['parameters'] : [])] },
      { name: obj['name'], fields: ['arguments', 'args', 'input', 'functionArguments', ...(invocationContext ? ['parameters'] : [])] },
      { name: obj['id'], fields: ['arguments', 'args', 'input', 'functionArguments', ...(invocationContext ? ['parameters'] : [])] },
    ]

    for (const candidate of candidates) {
      if (typeof candidate.name !== 'string') continue
      const name = names.get(candidate.name)
      if (!name) continue
      for (const key of candidate.fields) {
        if (!Object.hasOwn(obj, key)) continue
        let argumentsJSON: string
        try {
          argumentsJSON = JSON.stringify(obj[key])
        } catch {
          continue
        }
        const validated = validateDetectedToolCalls([
          { id: `call_${crypto.randomUUID()}`, type: toolTypeOf(name, tools), name, arguments: argumentsJSON },
        ], tools)
        if (validated.calls.length > 0) {
          out.push(validated.calls[0])
          return
        }
      }
    }

    for (const [key, nested] of Object.entries(obj)) {
      const childInvocationContext = invocationContext && ['payload', 'invocation', 'call', 'toolCall', 'functionCall', 'value'].includes(key)
      walk(nested, depth + 1, childInvocationContext)
    }
  }

  for (const event of events) walk(event, 0)
  return out
}

/**
 * 从单条原生事件或对象树中解析原生工具/函数调用（同 CF2 chathub.ts parseNativeFunctionCall）。
 * 仅在名字和参数字段均显式匹配时接受调用。
 */
export function parseNativeFunctionCall(value: unknown, tools: ToolDef[] = []): DetectedToolCall | null {
  const calls = nativeToolCalls([value], tools)
  return calls.length > 0 ? calls[0] : null
}

/**
 * 检测上游原生工具/函数调用信封（同 CF2 chathub.ts hasNativeFunctionCallEnvelope）。
 * 用于区分模型语法错误/畸形调用与空白网络传输异常，避免将模型调用误判为空响应降级。
 */
export function hasNativeFunctionCallEnvelope(value: unknown): boolean {
  let visited = 0
  const walk = (candidate: unknown, depth: number, inherited = false): boolean => {
    if (depth > 32 || visited++ > 50_000 || candidate === null || typeof candidate !== 'object') return false
    if (Array.isArray(candidate)) return candidate.some((item) => walk(item, depth + 1, inherited))
    const record = candidate as Record<string, unknown>
    const invocation = inherited || [record['contentType'], record['messageType'], record['type'], record['kind']]
      .some((item) => typeof item === 'string' && /(?:tool|function|plugin).*(?:call|invocation)|(?:call|invocation).*(?:tool|function|plugin)/iu.test(item))
    const named = [record['functionName'], record['toolName'], record['pluginName'], record['name'], record['id']]
      .some((item) => typeof item === 'string' && item.trim().length > 0)
    const argumentsPresent = ['functionArguments', 'arguments', 'args', 'input', 'parameters']
      .some((key) => Object.hasOwn(record, key))
    if (invocation && named && argumentsPresent) return true
    return Object.entries(record).some(([key, nested]) => walk(
      nested,
      depth + 1,
      invocation && ['payload', 'invocation', 'call', 'toolCall', 'functionCall', 'value', 'item', 'result'].includes(key),
    ))
  }
  return walk(value, 0)
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

/** 是否允许继续发起工具轮：死循环 / 反复失败 / 连续重复 / 超轮数则停止（同原版 CanContinue） */
export function canContinue(l: AgentLedger, maxRounds = MAX_TOOL_ROUNDS_DEFAULT): boolean {
  if (l.stuckLoop) return false
  // 同一调用反复失败（>=2 次同样失败）且已有一次失败证据，继续重试无意义 → 熔断
  if (l.repeatedFailure) return false
  // 连续相同调用超限（新版 ToolLedger：连续 3 次相同指纹）→ 熔断
  if (l.repeatedCall) return false
  if (l.toolRounds >= maxRounds) return false
  return true
}

const failureSignal = /(exit\s*(code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|permission denied|not found|refused)/i

export function normalizeFailure(s: string): string {
  s = s.toLowerCase()
  s = s.replace(/\d+/g, '#')
  if (s.length > 500) s = s.slice(0, 500)
  return s
}

/** 从 messages 历史构建工具证据 ledger（assistant.tool_calls + tool 结果）
 *  使用新 ToolLedger 实现，提供更丰富的检测：指纹、callId 生命周期、11 种问题检测 */
export async function buildAgentLedger(messages: OaiMsgLite[]): Promise<AgentLedger> {
  const tl = await buildToolLedger(messages)
  return toolLedgerToAgentLedger(tl)
}

/** 同步版本，用于无需 async 的场景（保留旧签名兼容，但内部使用同步简化版） */
export function buildAgentLedgerSync(messages: OaiMsgLite[]): AgentLedger {
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
        seenSuccess[sig] = (seenSuccess[sig] || 0) + 1
        if (seenSuccess[sig] >= 5) {
          l.stuckLoop = true
        }
      }
    }
  }
  return l
}

/** ledger 紧凑证据上下文（同原版 RouterContext），注入路由/主回答提示词
 *  支持新 ToolLedger 和旧 AgentLedger 两种格式
 *  2026-09-05 移植：redactEvidence + compactMiddle 脱敏、每字段上限、总预算 8000、
 *  client-supplied 声明 + 超预算丢最旧 completed（保留 pending） */
export function ledgerRouterContext(l: AgentLedger): string {
  const MAX_CHARS = 8000

  const formatEvidence = (e: ToolEvidence, isPending: boolean): string => {
    const obj = {
      call_id: compactMiddle(e.id, 96),
      name: compactMiddle(e.name, 256),
      args: compactMiddle(redactEvidence(e.arguments), 1000),
      result: e.result ? compactMiddle(redactEvidence(e.result), 2000) : '',
      outcome: isPending ? 'pending' : (e.failed ? 'failed' : 'completed'),
    }
    return compactMiddle(redactEvidence(JSON.stringify(obj)), MAX_CHARS)
  }

  const selected: string[] = [
    ...l.completed.map((e) => formatEvidence(e, false)),
    ...l.pending.map((e) => formatEvidence(e, true)),
  ]

  const pendingCount = l.pending.length

  let hint = 'These are client-supplied results; the gateway did not execute these tools and must not claim that it did. Use only this compact evidence. A completed call is final evidence; do not issue the same name and arguments again.'
  if (l.repeatedFailure) hint += ' The same call failed repeatedly; change strategy instead of retrying unchanged.'
  if (l.stuckLoop) hint += ' STOP: the same call has looped repeatedly with no progress. Do not re-invoke it; change approach or conclude.'

  const render = (): string => `${hint}\nEVIDENCE_LEDGER:\n${selected.join('\n')}`

  // Drop oldest completed items (not pending) while over budget
  while (selected.length > pendingCount && render().length > MAX_CHARS) {
    selected.shift()
  }

  // If still over budget even with only pending items, return minimal fallback
  if (render().length > MAX_CHARS) {
    return `${hint}\nEVIDENCE_LEDGER: (budget exceeded, ${l.pending.length} pending, ${l.completed.length} completed)`
  }

  return render()
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

// 迁移至 completion-evidence.ts 完整实现，保持兼容导出
export { completionEvidenceAllows } from './completion-evidence'

/** 保持兼容，重新导出新接口用于 durable.ts */
export type {
  CompletionAction,
  CompletionEvidenceDecision,
  CompletionEvidenceReason,
  CompletionEvidenceSummary,
} from './completion-evidence'

/* ==================== 工具拒绝 / 沙箱幻觉检测（同原版 toolloop.go） ==================== */

/**
 * 通用"整体无内容"拒答模板（移植 M365-Gateway 20260906 openai.ts genericAssistantNonAnswer）：
 * 与模型家族无关的空答复——"Sorry, I wasn't able to respond..." / "I can't chat about this" /
 * "Hmm… I was not able to respond to that" 等。全文锚定正则，只匹配整条消息即该模板的场合，
 * 不会命中包含此措辞的真实回答。用途：这类模板化空答复应视为工具拒答，触发既有纠正重试。
 */
export function genericAssistantNonAnswer(text: string): boolean {
  const value = text.trim()
  return /^(?:(?:Sorry,?\s*)|(?:Hmm(?:\.{3}|…)\s*))?(?:it\s+looks\s+like\s+)?I\s+(?:(?:wasn['’]t|was not|couldn['’]t|could not|am not)\s+able to respond(?:\s+to that)?|can(?:not|['’]t)\s+chat\s+about\s+(?:this|that))[.!]?\s*(?:Is there something else I can help with\?|Let['’]s try a different topic[.!]?)?$/iu.test(value)
}

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
  // 模板化空答复整体命中即拒答（B 20260906 移植）：锚定全文、长度有限，先于长度守卫也安全，
  // 但保持与既有行为一致仍在守卫之后判定。
  if (text.length < 200 && genericAssistantNonAnswer(text)) return true
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

/**
 * 未提交承诺检测（移植自 M365-Gateway unresolvedAssistantCommitment）：
 * 模型声明"我将要/正在执行某动作"却没有产生任何工具调用，即"承诺了行动但未落地"。
 * 这类回答会被长任务客户端误判为完成，必须触发同会话续接复核或返回检查点终态。
 *
 * 边界：仅匹配明确的未来/进行时行动措辞（中英文），且要求回答不含"已完成"式完成声明，
 * 避免与 completion-evidence 的完成声明校验重叠；长度不设上限但要求文本非空。
 */
const commitmentPatterns = [
  /\bI(?:'ll| will)\s+(?:now\s+)?(?:run|execute|apply|create|write|edit|update|delete|remove|install|deploy|fix|start|restart|upload|configure|verify|test|check|build|patch)\b/i,
  /\b(?:let me|I(?:'m| am)\s+going to|I(?:'m| am)\s+about to)\s+(?:run|execute|apply|create|write|edit|update|delete|remove|install|deploy|fix|start|restart|upload|configure|verify|test|check|build|patch)\b/i,
  /(?:接下来|现在|马上|即将|我将|我会|让我|准备)\s*(?:执行|运行|创建|写入|修改|更新|删除|移除|安装|部署|修复|启动|重启|上传|配置|验证|测试|检查|构建|打补丁|应用)/,
]

/** 完成声明措辞：出现时说明模型在声称结果而非承诺行动，不应判为未提交承诺 */
const resolutionPatterns = [
  /\b(?:successfully\s+)?(?:done|completed|finished|deployed|installed|fixed|created|updated|deleted|removed|configured|verified|passed|applied)\b/i,
  /(?:已|成功|完成|完毕|搞定|处理好)/,
]

/**
 * 检测模型是否"承诺了下一步行动却未给出任何工具调用"。
 *
 * 契约兼容：目标历史签名带 hasToolCalls 短路参数（源为纯 (text)）；保留该参数以免破坏现有调用方，
 * 但内部升级为源版质量——先用 assistantProseWithoutQuotedData 剥离代码块/引用/引号数据，
 * 再用时态承诺正则（源 progressive/未来式，含无主语中文进度句），避免把"引用文档里的将来时"误判。
 */
export function unresolvedAssistantCommitment(text: string, hasToolCalls: boolean): boolean {
  if (hasToolCalls) return false
  const value = (text || '').trim()
  if (!value) return false
  const prose = assistantProseWithoutQuotedData(value)
  const low = prose.toLowerCase()
  if (resolutionPatterns.some((p) => p.test(low))) return false
  return commitmentPatterns.some((p) => p.test(prose))
}

/* ==================== caller-local 能力分类 + 本地执行拒绝恢复（同原版 openai.ts） ==================== */

/** 本地补丁类工具的参数名（同原版 LOCAL_PATCH_PROPERTY_NAMES） */
const LOCAL_PATCH_PROPERTY_NAMES = ['patch', 'patch_text', 'patchtext', 'diff', 'old_string', 'new_string'] as const

/** 本地补丁类工具的描摹模式（同原版 LOCAL_PATCH_DESCRIPTION_PATTERN） */
const LOCAL_PATCH_DESCRIPTION_PATTERN = /(?:patch|diff|edit|modify|replace|补丁|编辑|修改|替换)/iu

/** tool_choice 是否要求必须调用工具（同原版 toolRequired） */
export function toolRequired(choice: unknown): boolean {
  if (String(choice ?? '').toLowerCase() === 'required') return true
  if (!choice || typeof choice !== 'object') return false
  const value = choice as { type?: string; function?: { name?: string }; name?: string }
  return value.type === 'function' || Boolean(value.function?.name || value.name)
}

/** 调用方本地能力分类（同原版 CallerLocalCapability） */
export type CallerLocalCapability =
  | 'process_start'
  | 'process_continue'
  | 'filesystem_read'
  | 'filesystem_search'
  | 'filesystem_write'
  | 'filesystem_patch'
  | 'visual_read'
  | 'computer_control'

/**
 * 调用方本地工具候选（同原版 CallerLocalToolCandidate）。
 * 适配点：源继承 FunctionToolDefinition（含 raw/name/description/parameters），
 * 目标只读 ToolDef 的 function，故这里内联 name/description/parameters 并以 raw 保留原始定义。
 */
export interface CallerLocalToolCandidate {
  raw: unknown
  name: string
  description: string
  parameters: unknown
  capabilities: CallerLocalCapability[]
}

/** 本地执行拒绝恢复判定输入（同原版 FableLocalExecRefusalInput，省略 freshCallerLocalResult 可选字段） */
export interface FableLocalExecRefusalInput {
  tone: string
  toolChoice: unknown
  tools: unknown[] | undefined
  responseText: string
  prompt: string
  /** 仅当结构化客户端协议证明本轮在续接调用方本地工具运行时为 true；绝不从工具输出推断（同原版 FableLocalExecRefusalInput） */
  freshCallerLocalResult?: boolean
}

/** 把任意声明归一为工具定义（同原版 function-tools.ts functionToolDefinition，支持 parameters/input_schema/inputSchema） */
function functionToolDefinition(raw: unknown): { raw: unknown; name: string; description: string; parameters: unknown } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record['type'] !== undefined && record['type'] !== 'function') return null
  const candidate = (record['function'] && typeof record['function'] === 'object' && !Array.isArray(record['function']))
    ? record['function'] as Record<string, unknown>
    : record
  const name = typeof candidate['name'] === 'string' ? candidate['name'].trim() : ''
  if (!name) return null
  const parameters = candidate['parameters'] ?? candidate['input_schema'] ?? candidate['inputSchema']
  return {
    raw,
    name,
    description: typeof candidate['description'] === 'string' ? candidate['description'] : '',
    parameters,
  }
}

/** 归一化工具标识符：camelCase → snake_case、小写、非字母数字压成下划线并去首尾（同原版 normalizedToolIdentifier） */
export function normalizedToolIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
}

/** 提取 JSON Schema 顶层 properties 的归一化键集合（同原版 schemaPropertyNames） */
function schemaPropertyNames(parameters: unknown): Set<string> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return new Set()
  const properties = (parameters as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return new Set()
  return new Set(Object.keys(properties as Record<string, unknown>).map(normalizedToolIdentifier))
}

/** 集合中是否命中任一候选（同原版 hasAny） */
function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate))
}

/** 从工具声明本身分类调用方本地能力（同原版 callerLocalToolCandidate）。
 *  产品名是有用证据，但参数形状与描述也可识别改名/命名空间化的等价工具，
 *  同时不会把不相关的网络工具误判为本地 shell/文件系统能力。 */
export function callerLocalToolCandidate(raw: unknown): CallerLocalToolCandidate | null {
  const definition = functionToolDefinition(raw)
  if (!definition) return null
  const name = normalizedToolIdentifier(definition.name)
  const properties = schemaPropertyNames(definition.parameters)
  const description = definition.description
  const capabilities = new Set<CallerLocalCapability>()

  const commandShape = hasAny(properties, ['cmd', 'command', 'commands', 'code', 'script'])
  const sessionShape = hasAny(properties, ['session_id', 'sessionid', 'process_id', 'processid', 'pid'])
  const processActionShape = sessionShape && hasAny(properties, ['action', 'chars', 'input', 'data', 'signal'])
  const pathShape = hasAny(properties, [
    'path', 'file_path', 'filepath', 'directory', 'folder', 'root', 'workdir', 'cwd',
    'source', 'source_path', 'destination', 'destination_path',
  ])
  const patternShape = hasAny(properties, ['pattern', 'glob', 'query', 'include', 'regex'])
  const contentShape = hasAny(properties, ['content', 'contents', 'text', 'data'])
  const patchShape = hasAny(properties, LOCAL_PATCH_PROPERTY_NAMES)
  const localDescription = /(?:caller|local|file\s*system|filesystem|workspace|working\s+directory|terminal|shell|desktop|computer|调用方|本机|本地|文件系统|工作区|终端|桌面)/iu.test(description)
  // 熟悉的名称并不代表有权在调用方执行。Hermes 等客户端会在真正的本地终端/文件系统工具旁
  // 暴露托管式 code/computer 工具；因此显式的非调用方执行环境会覆盖下面所有名称/schema 正信号。
  const hostedDescription = /(?:hosted|remote|sandbox(?:ed)?|cloud|server[- ]side|container|virtual\s+machine|vm\b|execution\s+environment|托管|远程|沙箱|云端|服务端|容器|虚拟机|执行环境)/iu.test(description)
    && !/(?:caller[- ]side|caller['’]?s|local|on\s+your\s+(?:machine|computer)|调用方|本机|本地)/iu.test(description)
  if (hostedDescription) return null
  const fileDescription = /(?:file|directory|folder|path|filesystem|文件|目录|路径)/iu.test(description)
  const executionDescription = /(?:run|execute|command|shell|terminal|code|process|运行|执行|命令|终端|代码|进程)/iu.test(description)
  const readDescription = /(?:read|inspect|view|load|读取|查看|检查|加载)/iu.test(description)
  const searchDescription = /(?:search|find|glob|grep|match|搜索|查找|匹配)/iu.test(description)
  const writeDescription = /(?:write|create|save|写入|创建|保存)/iu.test(description)
  const patchDescription = LOCAL_PATCH_DESCRIPTION_PATTERN.test(description)

  if (['exec', 'exec_command', 'bash', 'terminal', 'shell', 'powershell', 'execute_code'].includes(name)
    || (commandShape && executionDescription && (localDescription || hasAny(properties, ['workdir', 'cwd'])))) {
    capabilities.add('process_start')
  }
  if (['write_stdin', 'process'].includes(name)
    || (processActionShape && executionDescription)) {
    capabilities.add('process_continue')
  }
  if (['read', 'read_file'].includes(name) && (pathShape || (localDescription && fileDescription))
    || (pathShape && localDescription && fileDescription && readDescription)) {
    capabilities.add('filesystem_read')
  }
  if (['find', 'glob', 'grep', 'list_directory', 'ls', 'search_files'].includes(name)
    && (patternShape || pathShape || (localDescription && fileDescription))
    || (patternShape && pathShape && fileDescription && searchDescription)) {
    capabilities.add('filesystem_search')
  }
  if (['move_file', 'write', 'write_file'].includes(name) && (pathShape || contentShape || (localDescription && fileDescription))
    || (pathShape && contentShape && fileDescription && writeDescription)) {
    capabilities.add('filesystem_write')
  }
  if (['edit', 'edit_file', 'multi_edit', 'patch', 'apply_patch'].includes(name)
    && (patchShape || patchDescription || properties.size === 0)
    || (patchShape && patchDescription)) {
    capabilities.add('filesystem_patch')
  }
  if (name === 'view_image'
    || (pathShape && localDescription && /(?:image|picture|screenshot|图像|图片|截图)/iu.test(description))) {
    capabilities.add('visual_read')
  }
  if (name === 'computer_use'
    || (localDescription && /(?:computer|desktop|mouse|keyboard|screen|电脑|桌面|鼠标|键盘|屏幕)/iu.test(description))) {
    capabilities.add('computer_control')
  }

  return capabilities.size > 0 ? { ...definition, capabilities: [...capabilities] } : null
}

/** 从工具数组中筛出全部调用方本地候选（同原版 callerLocalToolCandidates） */
export function callerLocalToolCandidates(tools: unknown[] = []): CallerLocalToolCandidate[] {
  return tools.flatMap((raw) => {
    const candidate = callerLocalToolCandidate(raw)
    return candidate ? [candidate] : []
  })
}

/** 调用方本地工具名列表（同原版 callerLocalToolNames） */
function callerLocalToolNames(tools: unknown[] = []): string[] {
  return callerLocalToolCandidates(tools).map((candidate) => candidate.name)
}

/** 为第二次有界路由尝试挑选单个调用方本地工具（同原版 preferredSecondAttemptLocalToolName）。
 *  首次尝试保留调用方全部候选集；若宽路由未产生 schema 合法调用，收窄到有充分支持的下一步，
 *  可在不臆造参数、不在 Worker 内执行任何东西的前提下让修复确定化，
 *  产出的调用仍须通过原有的 schema、指纹与轮数守卫。
 *  适配点：入参 ledger 由源 ToolLedger 改为目标 AgentLedger，仅读取完成证据。 */
export function preferredSecondAttemptLocalToolName(
  tools: unknown[] | undefined,
  ledger: AgentLedger,
  prompt: string,
): string | null {
  const candidates = callerLocalToolCandidates(tools)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].name

  const ranked = (capability: CallerLocalCapability, preferredNames: readonly string[]): string | null => {
    const matches = candidates.filter((candidate) => candidate.capabilities.includes(capability))
    if (matches.length === 0) return null
    for (const preferred of preferredNames) {
      const match = matches.find((candidate) => normalizedToolIdentifier(candidate.name) === preferred)
      if (match) return match.name
    }
    return matches.length === 1 ? matches[0].name : null
  }

  const latest = ledger.completed.at(-1)
  const latestCandidate = latest
    ? candidates.find((candidate) => candidate.name === latest.name)
    : undefined
  if (latestCandidate?.capabilities.includes('filesystem_search')) {
    const reader = ranked('filesystem_read', ['read', 'read_file'])
    if (reader) return reader
  }

  const text = prompt.toLowerCase()
  const processAction = /\b(?:run|execute|build|test|deploy|ssh|login|connect)\b|(?:运行|执行|构建|测试|部署|登录|连接)/iu.test(text)
  if (processAction) {
    const process = ranked('process_start', ['exec', 'exec_command', 'terminal', 'bash', 'shell', 'powershell'])
    if (process) return process
  }
  const specificFile = /(?:\b[\w.-]+\.(?:jsonc?|tsx?|jsx?|mjs|cjs|md|toml|ya?ml|css|html|sql|py|go|rs)\b|package\.json|wrangler\.jsonc)/iu.test(text)
  const readAction = /\b(?:read|open|inspect|view)\b|(?:读取|打开|查看)/iu.test(text)
  if (specificFile && readAction) {
    const reader = ranked('filesystem_read', ['read', 'read_file'])
    if (reader) return reader
  }
  const searchAction = /\b(?:inspect|analy[sz]e|list|find|search|inventory|repository|repo|project|workspace|directory|folder)\b|(?:分析|查看|列出|查找|搜索|盘点|仓库|项目|工作区|目录|文件夹)/iu.test(text)
  if (searchAction) return ranked('filesystem_search', ['glob', 'search_files', 'grep'])
  return null
}

/** 在已声明 schema 中按归一化候选名反查真实属性名（同原版 declaredPropertyName） */
function declaredPropertyName(definition: { parameters: unknown }, candidates: readonly string[]): string | null {
  if (!definition.parameters || typeof definition.parameters !== 'object' || Array.isArray(definition.parameters)) return null
  const properties = (definition.parameters as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const entries = Object.keys(properties as Record<string, unknown>)
  for (const candidate of candidates) {
    const matched = entries.find((entry) => normalizedToolIdentifier(entry) === candidate)
    if (matched) return matched
  }
  return null
}

/** 仅检测模型"工具不可用"的声明，绝不授予另选工具的权限；调用方须另行证明用户意图（同原版 isCallerLocalExecRefusal） */
export function isCallerLocalExecRefusal(input: FableLocalExecRefusalInput): boolean {
  if (String(input.toolChoice ?? 'auto').toLowerCase() !== 'auto') return false
  const localTools = callerLocalToolCandidates(input.tools)
  if (localTools.length === 0) return false

  const refusal = input.responseText.trim()
  // 这段固定道歉是与模型家族无关的空答复。仅按 Claude 处理会让同样的 GPT 完成句
  // 通过语义续接审计而被当作可用终态回答。
  const genericNonAnswer = genericAssistantNonAnswer(refusal)
  // 某些 Responses continuation 会非人称地描述已声明的调用方路由
  //（"no matching caller-local execution tool is available"）而非"I cannot access it"。
  // 上面的声明检查使这是一个具体矛盾，而不是泛泛的失败解释。
  const englishDeclaredToolAbsence = /\bno\s+(?:matching\s+)?(?:(?:caller(?:-local|-side)?|client(?:-side)?|local|Windows)\s+)?(?:execution\s+)?(?:tools?|runtime|channels?|capabilit(?:y|ies))\s+(?:is|are)\s+(?:currently\s+)?(?:available|accessible|exposed|provided)\b/iu.test(refusal)
  const englishRefusal = /(?:\b(?:I|we)\s+(?:can(?:not|['’]t)|am unable to|are unable to|do not have|have no)\b[\s\S]{0,180}\b(?:access|use|interact with|reach)\b[\s\S]{0,180}\b(?:the\s+)?(?:(?:caller['’]?s|your)\s+(?:local\s+)?(?:machine|computer|file\s*system|filesystem|tools?|runtime|environment|execution\s+channel|capabilit(?:y|ies))|local\s+(?:machine|computer|file\s*system|filesystem|tools?|execution\s+channel|capabilit(?:y|ies))|(?:another|different)\s+(?:execution|runtime)\s+environment)\b|\b(?:local\s+(?:file\s*system|filesystem)\s+tools?|(?:another|different)\s+(?:execution|runtime)\s+environment)\b[\s\S]{0,180}\b(?:is|are)\s+(?:not\s+accessible|unavailable)\b|\b(?:current\s+)?(?:session|conversation|chat|turn)\b[\s\S]{0,120}\b(?:does\s+not|doesn['’]t|has\s+not|hasn['’]t)\b[\s\S]{0,80}\b(?:expose|provide|connect|include|offer)\b[\s\S]{0,120}\b(?:client(?:-side)?|local|Windows)\b[\s\S]{0,80}\b(?:execution\s+)?(?:tools?|runtime|channels?|capabilit(?:y|ies))\b)/iu.test(refusal)
  const chineseLocalSubject = /(?:调用方[^\n]{0,32}(?:本机|本地|文件系统|工具|环境|通道|能力)|你[^\n]{0,48}(?:本机|本地)|(?:本机|本地)[^\n]{0,24}(?:文件系统|工具|环境|通道|能力)|(?:客户端|Windows)[^\n]{0,40}(?:执行)?(?:工具|通道|能力)|(?:另一|不同)(?:个|的)?(?:执行|运行)环境|(?:弹出|远程)[^\n]{0,24}(?:登录|连接)?窗口|(?:服务器列表|登录窗口|连接窗口))/u
  const chineseRefusal = (
    /(?:无法|不能|无权|没有权限|不具备)[\s\S]{0,80}(?:访问|使用|操作|读取|连接|调用|执行|写入|修改|继续|重试)[\s\S]{0,160}/u.test(refusal)
      && chineseLocalSubject.test(refusal)
  ) || (
    chineseLocalSubject.test(refusal)
      && /(?:无法|不能|无权|没有权限|不具备)[\s\S]{0,80}(?:访问|使用|操作|读取|连接|调用|执行|写入|修改|继续|重试)/u.test(refusal)
  ) || (
    /(?:当前|这个)?(?:会话|对话)[\s\S]{0,80}(?:未|没有|并未)[\s\S]{0,40}(?:暴露|提供|接入|连接)[\s\S]{0,100}(?:客户端|本地|本机|Windows)[\s\S]{0,40}(?:执行)?工具/u.test(refusal)
  ) || (
    /(?:当前|这个)?(?:会话|对话|回合)[\s\S]{0,80}(?:未|没有|并未)[\s\S]{0,48}(?:可调用|可用|暴露|提供|接入|连接)?[\s\S]{0,100}(?:客户端|本地|本机|Windows)[\s\S]{0,48}(?:执行)?(?:工具|通道|能力)/u.test(refusal)
  ) || (
    /(?:请|需要)[\s\S]{0,40}(?:重新|再次)[\s\S]{0,40}(?:连接|接入)[\s\S]{0,60}(?:本地|客户端)?工具(?:运行时|环境)?/u.test(refusal)
  )
  // 具备视觉能力的客户端通过调用方侧工具暴露本地图片。模型仍可能声称看不到像素
  // 或图片输入不受支持。仅当请求确实声明了视觉读取器时，才把该回答视为可用性矛盾；
  // 只有 exec 或纯文本的客户端不得被路由到臆造的图像操作。
  const hasVisualReadTool = localTools.some((tool) => tool.capabilities.includes('visual_read'))
  const visualRefusal = hasVisualReadTool && (
    /(?:当前|这个|该)?(?:环境|会话|对话|回合)[\s\S]{0,64}(?:不支持|无法|不能)[\s\S]{0,48}(?:图片|图像|视觉)(?:输入|读取|识别|内容)?/u.test(refusal)
      || /(?:无法|不能|没有|未能)[\s\S]{0,64}(?:实际)?(?:看到|读取|访问|获取|识别)[\s\S]{0,64}(?:图片|图像|截图|像素|画面)(?:内容)?/u.test(refusal)
      || /(?:只|仅)[\s\S]{0,40}(?:收到|看到|获取到)[\s\S]{0,56}(?:图片)?(?:文件名|路径|占位(?:符|信息))/u.test(refusal)
      || /\b(?:I|we)\s+(?:can(?:not|['’]t)|am unable to|are unable to|do not)\b[\s\S]{0,80}\b(?:see|read|access|view|inspect|analy[sz]e)\b[\s\S]{0,64}\b(?:the\s+)?(?:actual\s+)?(?:image|picture|screenshot|pixels?|visual(?:\s+content)?)\b/iu.test(refusal)
      || /\b(?:current\s+)?(?:environment|session|conversation|chat|turn)\b[\s\S]{0,80}\b(?:does\s+not|doesn['’]t|cannot|can['’]t)\b[\s\S]{0,64}\bsupport\b[\s\S]{0,40}\b(?:image|visual)\s+input\b/iu.test(refusal)
      || /\bonly\s+(?:received|have|got)\b[\s\S]{0,64}\b(?:file\s*name|path|placeholder)\b[\s\S]{0,64}\b(?:image|picture|screenshot|pixels?|visual)\b/iu.test(refusal)
  )
  return genericNonAnswer || englishDeclaredToolAbsence || englishRefusal || chineseRefusal || visualRefusal
}

/** 检测任一模型"在当前请求已声明这些工具的情况下仍声称调用方本地工具缺失"的具体声明。
 *  同时要求拒绝文本与具体本地动作，因此普通解释、真实命令失败与无任务的工具结果续接
 *  永远不会被升级为猜测的工具调用（同原版 shouldRecoverCallerLocalExecRefusal）。 */
export function shouldRecoverCallerLocalExecRefusal(input: FableLocalExecRefusalInput): boolean {
  if (!isCallerLocalExecRefusal(input)) return false

  const lastUserMarker = input.prompt.lastIndexOf('[USER]\n')
  const toolProtocolOnly = lastUserMarker < 0
    && /\[(?:ASSISTANT TOOL CALL|TOOL RESULT|ASSISTANT|TOOL)(?:\s|\])/iu.test(input.prompt)
  const userRequest = lastUserMarker >= 0
    ? input.prompt.slice(lastUserMarker + 7).split(/\n\n\[[A-Z][^\]]*\]\n/u, 1)[0]
    : toolProtocolOnly ? '' : input.prompt
  const explanatoryOnly = /^(?:\s*(?:please\s+)?(?:explain|describe|tell me (?:how|why)|what|why|how (?:does|can|would))\b|\s*(?:请)?(?:解释|说明|为什么|如何|怎么))/iu.test(userRequest)
  // 具体的可用性拒绝本已是很强的证据，说明模型未能履行调用方本地任务。一旦因果关系上的
  // USER 条目存在，就把其自然语言内容作为权威，交由隔离的语义路由判断是否真的需要动作。
  // 不要用有限的动词/路径词表来把关恢复：像"接上那台机器"或"按刚才的结果继续"这类的
  // 命令即使不含网关历史上的关键词也仍是命令。解释性提问与显式"失败即停止"请求按策略
  // 保持为仅回答。
  const textualIntent = Boolean(userRequest.trim())
    && !explanatoryOnly
    && !callerRequestedStopOnFailure(userRequest)
  // 新鲜证据证明调用方本地工具存在，但不会揭示用户缺失的任务，也不会授权网关猜测下一步。
  // 无状态 Responses continuation 会保留上述因果 USER 条目，而纯工具输入必须保持不可路由。
  return textualIntent
}

/** 向后兼容导出，供针对 Claude 的定向测试使用（同原版 shouldRecoverFableLocalExecRefusal） */
export function shouldRecoverFableLocalExecRefusal(input: FableLocalExecRefusalInput): boolean {
  if (!/^Claude_(?:Fable|Opus|Sonnet)(?:_|$)/u.test(input.tone)) return false
  return shouldRecoverCallerLocalExecRefusal(input)
}

/**
 * 仅用已验证的结构化工具历史识别"进行中的本地任务"（同原版 hasFreshCallerLocalContinuationEvidence）。
 * 覆盖那些活跃 prompt 含 function_call_output 却有意省略原始 user 消息的 Responses continuation。
 *
 * 类型映射（语义等价，非降级）：
 * - 源 `ToolLedger.consumedCallIds` = 结果已被消费的 callId 集合；目标等价物即
 *   `ledger.completed`（result 非空的证据）的 id 集合，因为 completed 恰是"已拿到结果"的调用。
 * - 源 `ledger.calls`（全部已注册调用，含未消费）≈ 目标 `completed ∪ pending` 的 id→name 映射。
 * 因此本谓词在目标侧等价于"存在任一本地工具调用已获得完成结果"。
 */
export function hasFreshCallerLocalContinuationEvidence(
  tools: unknown[] | undefined,
  ledger: AgentLedger,
): boolean {
  const localNames = new Set(callerLocalToolNames(tools).map(normalizedToolIdentifier))
  if (localNames.size === 0) return false
  // consumedCallIds 等价物：已获得结果（completed）的调用 id 集合
  const consumedIds = new Set(ledger.completed.map((e) => e.id))
  const freshLocalCallIds = new Set(
    [...ledger.completed, ...ledger.pending]
      .filter((item) => consumedIds.has(item.id) && localNames.has(normalizedToolIdentifier(item.name)))
      .map((item) => item.id),
  )
  return ledger.completed.some((item) => freshLocalCallIds.has(item.id))
}

/**
 * 新鲜的调用方侧失败结果意味着请求的动作尚未成功（同原版 hasFreshCallerLocalFailureEvidence）。
 * 保持完全基于证据：网关不选择工作流或替代工具，但也不得让独立路由在因果用户任务仍活跃时
 * 把该失败变成 NO_TOOL_REQUIRED。
 *
 * 适配点：与 hasFreshCallerLocalContinuationEvidence 相同——consumedCallIds 用 completed 的 id 近似。
 */
export function hasFreshCallerLocalFailureEvidence(
  tools: unknown[] | undefined,
  ledger: AgentLedger,
): boolean {
  const localNames = new Set(callerLocalToolNames(tools).map(normalizedToolIdentifier))
  if (localNames.size === 0) return false
  const consumedIds = new Set(ledger.completed.map((e) => e.id))
  const freshLocalCallIds = new Set(
    [...ledger.completed, ...ledger.pending]
      .filter((item) => consumedIds.has(item.id) && localNames.has(normalizedToolIdentifier(item.name)))
      .map((item) => item.id),
  )
  const latestFreshLocalResult = ledger.completed
    .filter((item) => freshLocalCallIds.has(item.id))
    .at(-1)
  return latestFreshLocalResult?.failed ?? false
}

/** 提取最近的 user 请求文本（同原版 callerLocalRecoveryUserRequest） */
function callerLocalRecoveryUserRequest(prompt: string): string {
  const lastUserMarker = prompt.lastIndexOf('[USER]\n')
  return lastUserMarker >= 0
    ? prompt.slice(lastUserMarker + 7).split(/\n\n\[[A-Z][^\]]*\]\n/u, 1)[0]
    : prompt
}

/** 用户是否显式要求"失败即停止"（同原版 callerRequestedStopOnFailure） */
function callerRequestedStopOnFailure(userRequest: string): boolean {
  return /(?:失败|报错|出错)[^。！？\n]{0,32}(?:停止|终止|不要继续|别继续)|(?:停止|终止|不要继续|别继续)[^。！？\n]{0,32}(?:失败|报错|出错)|\b(?:(?:if|when|on)\b[^.!?\n]{0,32}\b(?:error|fail)|(?:error|fail)\b[^.!?,\n]{0,32}\b(?:then\s+)?(?:stop|abort|do not continue|don['’]t continue)|(?:stop|abort|do not continue|don['’]t continue)\b[^.!?\n]{0,40}\b(?:error|fail))/iu.test(userRequest)
}

/** 有界仓库列举命令（同原版 boundedRepositoryCommand）：仅做只读首轮盘点 */
export function boundedRepositoryCommand(workdir: string): string {
  if (!workdir) return 'Get-ChildItem -Force | Select-Object -First 200 Name,FullName,Mode,Length,LastWriteTime'
  const safeWorkdir = workdir.replace(/'/gu, "''")
  return `Get-ChildItem -LiteralPath '${safeWorkdir}' -Force | Select-Object -First 200 Name,FullName,Mode,Length,LastWriteTime`
}

/**
 * 必需调用方本地动作的最后一道"无网络"恢复（同原版 deterministicToolRouterRecovery）。
 * 仅当 tool_choice 为 required 时，从"唯一路径任务锚点 + 只读意图"合成一个**有界的只读首次探查**调用。
 * 写入/修改/补丁/删除/部署/发布/SSH/登录/连接/运行/执行/构建/测试等一律不进入此路径，
 * 这些操作必须由模型给出通过 schema 校验的参数，网关绝不代猜。
 *
 * 目标适配点：
 * - 源 FunctionToolDefinition/functionToolDefinition → 目标内部 functionToolDefinition + callerLocalToolCandidate 的 raw。
 * - 源 FunctionCall → 目标 DetectedToolCall（id 用 `call_${Date.now()}`，type 固定 'function'）。
 * - 源 repairFunctionCallTaskAnchors 仅在 argumentEncoding==='legacy_azhex' 时修复传输损坏；
 *   目标的合成参数由本函数自己 JSON.stringify 生成，不含 legacy AZHEX 伪影，
 *   因此这里跳过该修复（DetectedToolCall 也无 argumentEncoding 字段）。
 * - 源 boundPublicExecFunctionCall → 目标用 normalizeClientArgumentKeys 做键归一（等价于
 *   normalizeClientFunctionCall 内的归一化），失败即放弃。
 * - 源 validateToolArguments / guardProposedToolCalls → 目标用 validateDetectedToolCalls(choice='required')，
 *   与源路径同样要求 schema 校验通过（且 required 模式下 toolChoiceAllows 恒为真，不影响结果）。
 * - 源 guardProposedToolCalls/consecutive_fingerprint_limit → 目标无该守卫，用
 *   "canonicalToolArguments 指纹 + ledgerHasCompleted + completed/pending 同名同参去重"作为等价护栏。
 */
export async function deterministicToolRouterRecovery(
  prompt: string,
  tools: unknown[] | undefined,
  choice: unknown,
  ledger: AgentLedger,
  taskAnchors: ReadonlyArray<TaskAnchor> = [],
): Promise<DetectedToolCall | null> {
  if (!toolRequired(choice)) return null
  const definitions = (tools ?? []).flatMap((raw) => {
    const definition = functionToolDefinition(raw)
    return definition ? [definition] : []
  })
  const explicit = typeof choice === 'object' && choice
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name
      ?? (choice as { name?: string }).name)
    : undefined
  const selectedName = explicit
    ?? preferredSecondAttemptLocalToolName(tools, ledger, prompt)
    ?? (definitions.length === 1 ? definitions[0].name : undefined)
  if (!selectedName) return null
  const definition = definitions.find((candidate) => candidate.name === selectedName)
  const local = definition ? callerLocalToolCandidate(definition.raw) : null
  if (!definition || !local) return null

  const pathAnchors = [...new Set(taskAnchors
    .filter((anchor) => ['windows_path', 'unc_path', 'unix_path'].includes(anchor.kind))
    .map((anchor) => anchor.value))]
  if (pathAnchors.length !== 1) return null
  const target = pathAnchors[0]
  const argumentsObject: Record<string, unknown> = {}
  const normalizedName = normalizedToolIdentifier(selectedName)
  const readIntent = /\b(?:read|open|inspect|view|list|inventory|analy[sz]e)\b|(?:读取|打开|查看|列出|盘点|分析)/iu.test(prompt)
  const unsafeIntent = /\b(?:write|edit|modify|patch|delete|remove|deploy|publish|ssh|login|connect|run|execute|build|test)\b|(?:写入|编辑|修改|删除|部署|发布|登录|连接|运行|执行|构建|测试)/iu.test(prompt)

  if (local.capabilities.includes('filesystem_read')) {
    const pathKey = declaredPropertyName(definition, ['path', 'file_path', 'filepath'])
    const looksLikeFile = /[\\/][^\\/]+(?:\.[A-Za-z0-9_-]{1,16}|(?:README|LICENSE|Makefile))$/iu.test(target)
    if (!pathKey || !looksLikeFile || !readIntent || unsafeIntent) return null
    argumentsObject[pathKey] = target
  } else if (local.capabilities.includes('filesystem_search') && !normalizedName.includes('grep')) {
    const patternKey = declaredPropertyName(definition, ['pattern', 'glob', 'query', 'include'])
    const pathKey = declaredPropertyName(definition, ['path', 'directory', 'folder', 'root', 'workdir', 'cwd'])
    if (!patternKey || !readIntent || unsafeIntent) return null
    const separator = target.includes('\\') ? '\\' : '/'
    argumentsObject[patternKey] = pathKey ? '*' : `${target.replace(/[\\/]$/u, '')}${separator}*`
    if (pathKey) argumentsObject[pathKey] = target
  } else if (local.capabilities.includes('process_start')
    && ['exec_command', 'powershell'].includes(normalizedName)) {
    const commandKey = declaredPropertyName(definition, ['cmd', 'command'])
    const workdirKey = declaredPropertyName(definition, ['workdir', 'cwd'])
    const windowsTarget = /^[A-Za-z]:[\\/]|^\\\\/u.test(target)
    if (!commandKey || !windowsTarget || !readIntent || unsafeIntent) return null
    argumentsObject[commandKey] = boundedRepositoryCommand(target)
    if (workdirKey) argumentsObject[workdirKey] = target
  } else {
    return null
  }

  // 合成调用：id 用时间戳（无需 crypto）与 type 固定为 'function' 适配 DetectedToolCall。
  let candidate: DetectedToolCall = { id: `call_${Date.now()}`, type: 'function', name: selectedName, arguments: JSON.stringify(argumentsObject) }
  // 目标归一/校验函数要求 ToolDef[]，而本函数签名按源保留 tools: unknown[]，故此处收窄类型。
  const typedTools = (tools ?? []) as ToolDef[]
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.arguments)
  } catch {
    return null
  }
  const normalizedArguments = normalizeClientArgumentKeys(candidate.name, parsed, typedTools)
  if (!normalizedArguments || typeof normalizedArguments !== 'object' || Array.isArray(normalizedArguments)) return null
  candidate = { ...candidate, arguments: JSON.stringify(normalizedArguments) }
  // 目标等价的信息完整性校验：与源路径相同的 schema 校验（required 模式下不会因 tool_choice 被剔除）。
  const validated = validateDetectedToolCalls([candidate], typedTools, 'required')
  if (validated.dropped !== 0 || validated.calls.length !== 1) return null
  candidate = validated.calls[0]
  // 目标架构下的等价护栏：canonicalToolArguments 指纹 + 已完成/进行中同名同参去重，
  // 替代源 ToolLedger.calls/completed/pending 的指纹比对与 guardedFunctionCall 守卫。
  const fingerprint = canonicalToolArguments(candidate.arguments)
  if (ledgerHasCompleted(ledger, candidate.name, candidate.arguments)) return null
  const duplicated = [...ledger.completed, ...ledger.pending].some((item) => (
    item.name === candidate.name && canonicalToolArguments(item.arguments) === fingerprint
  ))
  if (duplicated) return null
  return candidate
}

/* ==================== 长任务终态判定：未完成结局 / 续接审计 / 流缓冲（同原版 openai.ts） ==================== */

/**
 * 剥离代码块、行内代码、成对引号内容与引用行，得到"助手散文"。
 * 用于把引用文档/代码里的将来时与真实承诺区分开（同原版 assistantProseWithoutQuotedData）。
 */
function assistantProseWithoutQuotedData(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/gu, ' ')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*>/u.test(line))
    .join('\n')
}

/**
 * 诚实的"未完成"状态报告：可以报告未完成的工作而不承诺动作（同原版 assistantReportsIncompleteOutcome）。
 * 与 unresolvedAssistantCommitment 分开，使用户显式要求的暂停/状态汇报仍可正常终止。
 */
export function assistantReportsIncompleteOutcome(text: string): boolean {
  const prose = assistantProseWithoutQuotedData(text)
  return /(?:尚未|仍未|还未|并未|未能)[^。！？\n]{0,120}(?:完成|完毕|收尾|结束|执行|落实|验证|测试|部署|同步|提交|写入|修改|修复)|(?:还不能|尚不能|暂不能)[^。！？\n]{0,48}(?:完成|收尾|结束)|\b(?:still|not\s+yet|hasn['’]t|haven['’]t|remains?\s+to\s+be)[^.!?\n]{0,120}\b(?:complete|completed|done|finish(?:ed)?|deploy(?:ed)?|verify|verified|test(?:ed)?|submit(?:ted)?|write|written|fix(?:ed)?)\b/iu.test(prose)
}

/**
 * 结构化本地结果 + 因果 USER 段存在时，是否应触发同模型续接审计（同原版 shouldAuditCallerLocalContinuation）。
 * 权威来自"结构化本地结果 + USER 段"，不用有限动词表把关：隔离的 auto 路由按语义决定
 * 是否需要再次动作或 NO_TOOL_REQUIRED 是否正确。
 *
 * 适配点：源用 callerLocalToolNames（返回名字数组）判定非空；目标等价物为 callerLocalToolCandidates。
 */
export function shouldAuditCallerLocalContinuation(input: FableLocalExecRefusalInput): boolean {
  if (String(input.toolChoice ?? 'auto').toLowerCase() !== 'auto') return false
  if (!input.freshCallerLocalResult || callerLocalToolCandidates(input.tools).length === 0) return false
  if (input.prompt.lastIndexOf('[USER]\n') < 0) return false
  const userRequest = callerLocalRecoveryUserRequest(input.prompt)
  const explanatoryOnly = /^(?:\s*(?:please\s+)?(?:explain|describe|tell me (?:how|why)|what|why|how (?:does|can|would))\b|\s*(?:请)?(?:解释|说明|为什么|如何|怎么))/iu.test(userRequest)
  return Boolean(userRequest.trim())
    && !explanatoryOnly
    && !callerRequestedStopOnFailure(userRequest)
}

/** 用户是否指向调用方本地目标（本地/工作区/路径等），且未指向托管目的地（同原版 callerLocalDestinationRequest） */
function callerLocalDestinationRequest(prompt: string): boolean {
  const request = callerLocalRecoveryUserRequest(prompt)
  const localDestination = /(?:\b(?:local|workspace|working\s+(?:tree|directory)|current\s+(?:directory|folder)|repository|repo|project|file|folder|directory)\b|(?:本机|本地|工作区|当前目录|仓库|项目|文件|文件夹|目录))/iu.test(request)
  const localPath = /(?:[A-Za-z]:\\|\\\\|(?:^|[\s'"`(])(?:\.\.\/|\.\/|\/(?:home|Users|workspace|workspaces|tmp|var\/tmp)\/))[^\n]{1,240}/u.test(request)
  const hostedDestinationRequested = /(?:\b(?:teams|sharepoint|onedrive|hosted|cloud|upload|publish)\b|(?:Teams|SharePoint|OneDrive|托管|云端|上传|发布))/iu.test(request)
  return (localDestination || localPath) && !hostedDestinationRequested
}

/**
 * 是否为"目标在调用方工作区"的变更/校验请求（同原版 callerLocalMutationRequest）。
 * 仅用于进行中与完成证据校验；语义工具选择不依赖它。
 */
function callerLocalMutationRequest(prompt: string): boolean {
  if (!callerLocalDestinationRequest(prompt)) return false
  const request = callerLocalRecoveryUserRequest(prompt)
  const action = /(?:\b(?:edit|modify|write|patch|create|generate|scaffold|build|fix|verify|validate|check|read\s+back)\b|(?:编辑|修改|写入|打补丁|创建|生成|搭建|构建|修复|验证|检查|回读))/iu.test(request)
  const failedOutcome = /(?:\b(?:missing|empty|not\s+(?:there|written|created|saved)|wasn['’]t\s+(?:written|created|saved))\b|(?:没有|为空|不存在|没(?:有)?(?:写入|创建|生成|保存|改)|未(?:写入|创建|生成|保存|修改)))/iu.test(request)
  if (action || failedOutcome) return true
  // 显式调用方路径 + 非解释性用户回合即已是任务边界：不依赖不断增长的动词表。
  const explanatoryOnly = /^(?:\s*(?:please\s+)?(?:explain|describe|tell me (?:how|why)|what|why|how (?:does|can|would))\b|\s*(?:请)?(?:解释|说明|为什么|如何|怎么))/iu.test(request)
  return Boolean(request.trim()) && !explanatoryOnly && !callerRequestedStopOnFailure(request)
}

/**
 * 是否应缓冲工具流（同原版 shouldBufferToolStream）：
 * 有工具且 tool_choice 非 none → 缓冲以便原子化校验；
 * 无工具的兼容请求若要求创建/校验调用方工作区文件，也保持原子，供托管产物与完成证据护栏撤回不安全散文。
 */
export function shouldBufferToolStream(tools: unknown[] | undefined, toolChoice: unknown, prompt = ''): boolean {
  if (Boolean(tools?.length) && String(toolChoice ?? 'auto').toLowerCase() !== 'none') return true
  return Boolean(prompt.trim()) && callerLocalMutationRequest(prompt)
}