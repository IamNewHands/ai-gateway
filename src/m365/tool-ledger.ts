/**
 * M365 工具账本（Tool Ledger）——移植自 M365-Gateway-CF2 tool-ledger.ts + completion-evidence.ts。
 *
 * 核心功能：
 * 1. canonicalJSONText — JSON 规范化（保留数字精度，按键排序）
 * 2. toolCallFingerprint — SHA-256 指纹（name + canonicalArguments）
 * 3. registerCall — 完整 callId 生命周期（唯一性、名称、指纹检查）
 * 4. consumeResult — callId 匹配、防止重复消费
 * 5. guardProposedToolCalls — 全面守卫：重复/失败/轮次/连续指纹
 *
 * 与现有 AgentLedger 兼容：buildAgentLedger 增强，新增接口渐进集成。
 */
import type { ToolDef, DetectedToolCall, OaiMsgLite } from './tools'

// ==================== 常量 ====================

/** 默认工具轮数上限（同 CF2 DEFAULT_MAX_TOOL_ROUNDS） */
export const DEFAULT_MAX_TOOL_ROUNDS = 128
/** 硬上限 */
export const HARD_MAX_TOOL_ROUNDS = 512
/** 默认连续相同指纹上限 */
export const DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS = 2
/** 硬上限 */
export const HARD_MAX_CONSECUTIVE_FINGERPRINTS = 8
/** 已完成指纹最大出现次数 */
export const MAX_COMPLETED_FINGERPRINT_OCCURRENCES = 8

// ==================== 接口 ====================

export type ToolLedgerIssueCode =
  | 'missing_call_id'
  | 'missing_tool_name'
  | 'duplicate_call_id'
  | 'unknown_call_id'
  | 'call_id_already_consumed'
  | 'duplicate_pending_call'
  | 'completed_call_reissued'
  | 'duplicate_completed_result'
  | 'repeated_failure'
  | 'tool_round_limit'
  | 'consecutive_fingerprint_limit'

export interface ToolLedgerIssue {
  code: ToolLedgerIssueCode
  message: string
  callId?: string
  fingerprint?: string
}

export interface ToolCallRecord {
  callId: string
  name: string
  arguments: unknown
  normalizedArguments: string
  fingerprint: string
}

export interface CompletedToolEvidence extends ToolCallRecord {
  result: string
  normalizedResult: string
  resultFingerprint: string
  failed: boolean
  failureFingerprint?: string
}

export interface ToolLedger {
  calls: ToolCallRecord[]
  completed: CompletedToolEvidence[]
  pending: ToolCallRecord[]
  consumedCallIds: string[]
  issues: ToolLedgerIssue[]
  roundCount: number
  maxToolRounds: number
  maxConsecutiveFingerprints: number
  blocked: boolean
}

export interface ToolLedgerOptions {
  maxToolRounds?: number
  maxConsecutiveFingerprints?: number
}

// ==================== 内部状态 ====================

interface MutableLedgerState {
  callsById: Map<string, ToolCallRecord>
  completedFingerprints: Set<string>
  completedFingerprintCounts: Map<string, number>
  failureSignatures: Set<string>
  calls: ToolCallRecord[]
  completed: CompletedToolEvidence[]
  pendingIds: Set<string>
  consumedCallIds: Set<string>
  issues: ToolLedgerIssue[]
  roundCount: number
  limits: ResolvedLimits
  lastFingerprint: string
  consecutiveFingerprintCount: number
}

interface ResolvedLimits {
  maxToolRounds: number
  maxConsecutiveFingerprints: number
}

// ==================== 指纹 ====================

/** 文本编码器 */
const encoder = new TextEncoder()

/** FNV-1a 双哈希 → hex 用于指纹（非安全用途，仅用于会话匹配/去重） */
function fnvHex(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ s.charCodeAt(i)) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'))
}

/** JSON 规范化：保留数字精度，按键排序（同 CF2 canonicalJSONText 核心逻辑） */
function canonicalJSONText(text: string): string {
  let offset = 0
  const whitespace = /\s/u
  const skipWhitespace = (): void => {
    while (offset < text.length && whitespace.test(text[offset])) offset += 1
  }
  const stringValue = (): { decoded: string; encoded: string } => {
    const start = offset
    offset += 1
    let escaped = false
    while (offset < text.length) {
      const character = text[offset++]
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        const encoded = text.slice(start, offset)
        const decoded = JSON.parse(encoded) as string
        return { decoded, encoded: JSON.stringify(decoded) }
      }
    }
    throw new Error('UNTERMINATED_JSON_STRING')
  }
  const parseValue = (depth: number): string => {
    if (depth > 128) throw new Error('TOOL_ARGUMENTS_TOO_DEEP')
    skipWhitespace()
    const character = text[offset]
    if (character === '"') return stringValue().encoded
    if (character === '[') {
      offset += 1
      skipWhitespace()
      const values: string[] = []
      if (text[offset] === ']') {
        offset += 1
        return '[]'
      }
      while (offset < text.length) {
        values.push(parseValue(depth + 1))
        skipWhitespace()
        if (text[offset] === ',') { offset += 1; continue }
        if (text[offset] === ']') { offset += 1; return `[${values.join(',')}]` }
        throw new Error('INVALID_JSON_ARRAY')
      }
      throw new Error('UNTERMINATED_JSON_ARRAY')
    }
    if (character === '{') {
      offset += 1
      skipWhitespace()
      if (text[offset] === '}') { offset += 1; return '{}' }
      const entries: Array<{ key: string; value: string }> = []
      while (offset < text.length) {
        const key = stringValue()
        skipWhitespace()
        if (text[offset] !== ':') throw new Error('INVALID_JSON_OBJECT')
        offset += 1
        const value = parseValue(depth + 1)
        entries.push({ key: key.encoded, value })
        skipWhitespace()
        if (text[offset] === ',') { offset += 1; continue }
        if (text[offset] === '}') {
          offset += 1
          entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
          return `{${entries.map((e) => `${e.key}:${e.value}`).join(',')}}`
        }
        throw new Error('INVALID_JSON_OBJECT')
      }
      throw new Error('UNTERMINATED_JSON_OBJECT')
    }
    // 数字
    const numStart = offset
    while (offset < text.length && /[0-9.eE+\-]/u.test(text[offset])) offset += 1
    if (offset === numStart) throw new Error('INVALID_JSON_VALUE')
    const raw = text.slice(numStart, offset)
    return canonicalJSONNumber(raw)
  }
  skipWhitespace()
  if (offset >= text.length) return text
  return parseValue(0)
}

/** 数字规范化（同 CF2 canonicalJSONNumber）：保留数字精度，不经过 IEEE-754 转换 */
function canonicalJSONNumber(raw: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(raw)
  if (!match) throw new Error('INVALID_JSON_NUMBER')
  const negative = match[1] === '-'
  const fraction = match[3] ?? ''
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, '')
  if (!digits) return '0'
  let exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length)
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent += 1n
  }
  const sign = negative ? '-' : ''
  if (exponent >= 0n && exponent <= 10_000n) return `${sign}${digits}${'0'.repeat(Number(exponent))}`
  const decimalPosition = BigInt(digits.length) + exponent
  if (decimalPosition > 0n && decimalPosition < BigInt(digits.length)) {
    const point = Number(decimalPosition)
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
  }
  if (decimalPosition <= 0n && decimalPosition >= -10_000n) {
    return `${sign}0.${'0'.repeat(Number(-decimalPosition))}${digits}`
  }
  const coefficient = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`
  return `${sign}${coefficient}e${String(exponent + BigInt(digits.length - 1))}`
}

/** 规范化工具参数（同 CF2 normalizeToolArguments） */
function normalizeToolArguments(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') {
    try {
      return canonicalJSONText(value)
    } catch {
      return JSON.stringify(value)
    }
  }
  try {
    return canonicalJSONText(JSON.stringify(value))
  } catch {
    return JSON.stringify(value)
  }
}

/** 对象的规范化 JSON 表示（同 CF2 canonicalValue） */
function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'number': return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null'
    case 'bigint': return JSON.stringify(value.toString())
    case 'undefined':
    case 'function':
    case 'symbol': return 'null'
    default: break
  }
  const object = value as object
  if (ancestors.has(object)) throw new Error('TOOL_ARGUMENTS_CIRCULAR')
  ancestors.add(object)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, ancestors)).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(object)
  }
}

/** 生成工具调用指纹：SHA-256 or FNV 哈希（同 CF2 toolCallFingerprint） */
export function toolCallFingerprint(name: string, args: unknown): string {
  const normalized = normalizeToolArguments(args)
  const data = `${name}\0${normalized}`
  // 使用 FNV 哈希（同步，适用于 Workers 环境）
  return fnvHex(data)
}

// ==================== 工具结果失败检测 ====================

const processExitSignal = /(?:^|\n)Process exited with code\s+(-?\d+)(?:\s|$)/iu
const leadingFailureSignal = /^(?:invalid\s+(?:patch|tool|arguments?|request|command|input)\s*:|errors?\s*:|failed\s*:|failure\s*:|exceptions?\s*:|traceback\b|permission denied\b|timed?\s*out\b|connection refused\b|\u9519\u8bef\s*[\uff1a:]|\u5931\u8d95\s*[\uff1a:]|\u8d85\u65f6\b|\u6743\u9650\u88ab\u62d2\u7edd\b)/iu
const powershellFailureSignal = /^[A-Za-z][A-Za-z0-9_.-]*\s*:\s*(?:cannot\s+find\s+path|the\s+term\b[^\n]{0,160}\bis\s+not\s+recognized|access\s+(?:is\s+)?denied|permission\s+denied)/iu
const commandFailureSignal = /^[A-Za-z][A-Za-z0-9_.-]*\s+(?:failed|error|failure)\s*:/iu
const operationFailureSignal = /^(?:the\s+)?(?:command|operation|request|action)\s+(?:failed|error|failure)\b/iu

function firstPayloadLine(value: string): string {
  const trimmed = value.trim()
  const newline = trimmed.indexOf('\n')
  return newline >= 0 ? trimmed.slice(0, newline) : trimmed
}

/** 检测工具结果是否失败（兼容原版 failureSignal 的 exit code 模式） */
export function resultFailed(value: string, call?: ToolCallRecord): boolean {
  if (!value) return false
  if (processExitSignal.test(value)) return true
  // 兼容旧版 failureSignal：exit code: 1 / exit status: 1 / exit code: 1, error 等格式
  if (/(?:^|\n|\s)exit\s+(?:code|status)?\s*[:=]?\s*[1-9]\d*(?:\s|$|[.,;!?])/iu.test(value)) return true
  const leading = firstPayloadLine(value)
  return leadingFailureSignal.test(leading)
    || powershellFailureSignal.test(leading)
    || commandFailureSignal.test(leading)
    || operationFailureSignal.test(leading)
}

// ==================== Factory 与解析 ====================

function resolveLimits(options: ToolLedgerOptions): ResolvedLimits {
  const bounded = (v: number | undefined, fallback: number, max: number): number => {
    if (!Number.isFinite(v) || !v || v < 1) return fallback
    return Math.min(max, Math.floor(v))
  }
  return {
    maxToolRounds: bounded(options.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS),
    maxConsecutiveFingerprints: bounded(options.maxConsecutiveFingerprints, DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS, HARD_MAX_CONSECUTIVE_FINGERPRINTS),
  }
}

function emptyState(options: ToolLedgerOptions): MutableLedgerState {
  return {
    callsById: new Map(),
    completedFingerprints: new Set(),
    completedFingerprintCounts: new Map(),
    failureSignatures: new Set(),
    calls: [],
    completed: [],
    pendingIds: new Set(),
    consumedCallIds: new Set(),
    issues: [],
    roundCount: 0,
    limits: resolveLimits(options),
    lastFingerprint: '',
    consecutiveFingerprintCount: 0,
  }
}

function addIssue(state: MutableLedgerState, issue: ToolLedgerIssue): void {
  if (state.issues.some((i) => i.code === issue.code && i.callId === issue.callId && i.fingerprint === issue.fingerprint)) return
  state.issues.push(issue)
}

// ==================== 注册调用 ====================

async function registerCall(
  state: MutableLedgerState,
  rawCallId: unknown,
  rawName: unknown,
  argumentsValue: unknown,
): Promise<ToolCallRecord | null> {
  const callId = typeof rawCallId === 'string' ? rawCallId.trim() : ''
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!callId) {
    addIssue(state, { code: 'missing_call_id', message: 'every structured tool call requires a non-empty call_id' })
    return null
  }
  if (!name) {
    addIssue(state, { code: 'missing_tool_name', callId, message: `tool call ${callId} requires a non-empty function name` })
    return null
  }
  if (state.callsById.has(callId) || state.consumedCallIds.has(callId)) {
    addIssue(state, { code: 'duplicate_call_id', callId, message: `call_id ${callId} was declared more than once` })
    return null
  }

  const normalizedArguments = normalizeToolArguments(argumentsValue)
  const fingerprint = toolCallFingerprint(name, argumentsValue)
  const call: ToolCallRecord = { callId, name, arguments: argumentsValue, normalizedArguments, fingerprint }

  if ((state.completedFingerprintCounts.get(fingerprint) ?? 0) >= MAX_COMPLETED_FINGERPRINT_OCCURRENCES) {
    addIssue(state, {
      code: 'completed_call_reissued',
      callId,
      fingerprint,
      message: `tool call ${name} repeats an action that already has completed evidence`,
    })
  } else if ([...state.pendingIds].some((id) => state.callsById.get(id)?.fingerprint === fingerprint)) {
    addIssue(state, {
      code: 'duplicate_pending_call',
      callId,
      fingerprint,
      message: `tool call ${name} duplicates an action that is still waiting for a result`,
    })
  }

  state.callsById.set(callId, call)
  state.calls.push(call)
  state.pendingIds.add(callId)

  if (state.lastFingerprint === fingerprint) state.consecutiveFingerprintCount += 1
  else {
    state.lastFingerprint = fingerprint
    state.consecutiveFingerprintCount = 1
  }
  if (state.consecutiveFingerprintCount > state.limits.maxConsecutiveFingerprints) {
    addIssue(state, {
      code: 'consecutive_fingerprint_limit',
      callId,
      fingerprint,
      message: `tool fingerprint repeated more than ${state.limits.maxConsecutiveFingerprints} consecutive times`,
    })
  }
  if (state.calls.length > state.limits.maxToolRounds) {
    addIssue(state, {
      code: 'tool_round_limit',
      callId,
      fingerprint,
      message: `tool round limit exceeded (${state.limits.maxToolRounds})`,
    })
  }
  return call
}

// ==================== 消费结果 ====================

async function consumeResult(
  state: MutableLedgerState,
  rawCallId: unknown,
  value: unknown,
  failedOverride?: boolean,
): Promise<void> {
  const callId = typeof rawCallId === 'string' ? rawCallId.trim() : ''
  if (!callId) {
    addIssue(state, { code: 'missing_call_id', message: 'every structured tool result requires a non-empty call_id' })
    return
  }
  if (state.consumedCallIds.has(callId)) {
    addIssue(state, { code: 'call_id_already_consumed', callId, message: `call_id ${callId} already consumed one result` })
    return
  }
  const call = state.callsById.get(callId)
  if (!call || !state.pendingIds.has(callId)) {
    addIssue(state, { code: 'unknown_call_id', callId, message: `tool result references unknown call_id ${callId}` })
    return
  }

  const result = typeof value === 'string' ? value : JSON.stringify(value)
  const normalizedResult = normalizeToolArguments(result)
  const resultFingerprint = toolCallFingerprint(result, {})
  const failed = failedOverride ?? resultFailed(result, call)

  const evidence: CompletedToolEvidence = {
    ...call,
    result,
    normalizedResult,
    resultFingerprint,
    failed,
    failureFingerprint: failed ? `${call.fingerprint}\0${normalizedResult}` : undefined,
  }

  if (failed && evidence.failureFingerprint &&
    state.failureSignatures.has(evidence.failureFingerprint)) {
    addIssue(state, {
      code: 'repeated_failure',
      callId,
      fingerprint: call.fingerprint,
      message: `tool call ${call.name} failed with the same result as a previous attempt`,
    })
  }

  state.pendingIds.delete(callId)
  state.consumedCallIds.add(callId)
  state.completed.push(evidence)
  state.completedFingerprints.add(call.fingerprint)
  state.completedFingerprintCounts.set(
    call.fingerprint,
    (state.completedFingerprintCounts.get(call.fingerprint) ?? 0) + 1,
  )
  if (failed && evidence.failureFingerprint) {
    state.failureSignatures.add(evidence.failureFingerprint)
  }
}

// ==================== Ledger 构建 ====================

/** 从 messages 构建新的 ToolLedger。
 *  与现有 buildAgentLedger 兼容，但提供更丰富的检测。 */
export async function buildToolLedger(
  messages: OaiMsgLite[],
  options: ToolLedgerOptions = {},
): Promise<ToolLedger> {
  const state = emptyState(options)

  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const raw of m.tool_calls as unknown[]) {
        if (!raw || typeof raw !== 'object') continue
        const tc = raw as Record<string, unknown>
        const fn = (tc['function'] || {}) as Record<string, unknown>
        await registerCall(state, tc['id'], fn['name'], fn['arguments'])
        state.roundCount++
      }
    }
    if (m.role === 'tool') {
      await consumeResult(state, m.tool_call_id, m.content)
    }
  }

  return {
    calls: state.calls,
    completed: state.completed,
    pending: [...state.pendingIds].map((id) => state.callsById.get(id)!).filter(Boolean),
    consumedCallIds: [...state.consumedCallIds],
    issues: state.issues,
    roundCount: state.roundCount,
    maxToolRounds: state.limits.maxToolRounds,
    maxConsecutiveFingerprints: state.limits.maxConsecutiveFingerprints,
    blocked: state.issues.length > 0,
  }
}

// ==================== 守卫 ====================

export interface GuardResult {
  allowed: boolean
  code?: string
  message?: string
  issue?: ToolLedgerIssue
}

/**
 * 检查阻塞性问题，返回是否允许继续。
 * 同 CF2 guardProposedToolCalls 核心逻辑。
 */
export function guardToolLedger(ledger: ToolLedger): GuardResult {
  // 有重复失败 → 阻塞
  const repeatedFailure = ledger.issues.find((i) => i.code === 'repeated_failure')
  if (repeatedFailure) {
    return { allowed: false, code: 'repeated_tool_failure', message: 'same tool call failed repeatedly; change strategy', issue: repeatedFailure }
  }
  // 轮数超限 → 阻塞
  const roundLimit = ledger.issues.find((i) => i.code === 'tool_round_limit')
  if (roundLimit) {
    return { allowed: false, code: 'tool_round_limit', message: 'tool round limit reached', issue: roundLimit }
  }
  // 连续相同指纹超限 → 阻塞
  const consecutiveLimit = ledger.issues.find((i) => i.code === 'consecutive_fingerprint_limit')
  if (consecutiveLimit) {
    return { allowed: false, code: 'repeated_tool_call', message: 'same tool call repeated consecutively; change approach', issue: consecutiveLimit }
  }
  // 完成调用重新发出（已完成的指纹）→ 阻塞
  const reissued = ledger.issues.find((i) => i.code === 'completed_call_reissued')
  if (reissued) {
    return { allowed: false, code: 'completed_call_reissued', message: 'tool call already completed', issue: reissued }
  }
  // 待处理调用重复 → 阻塞
  const duplicatePending = ledger.issues.find((i) => i.code === 'duplicate_pending_call')
  if (duplicatePending) {
    return { allowed: false, code: 'pending_tool_result', message: 'pending tool result must be consumed first', issue: duplicatePending }
  }
  return { allowed: true }
}

// ==================== 兼容 AgentLedger 适配器 ====================

/**
 * 将 ToolLedger 转换为 AgentLedger 接口（向后兼容）。
 * 供现有 buildAgentLedger + canContinue + ledgerRouterContext 使用。
 */
export function toolLedgerToAgentLedger(ledger: ToolLedger): {
  completed: Array<{ id: string; name: string; arguments: string; result: string; failed: boolean }>
  pending: Array<{ id: string; name: string; arguments: string; result: string; failed: boolean }>
  toolRounds: number
  repeatedCall: boolean
  repeatedFailure: boolean
  stuckLoop: boolean
  repetitionSignature: string | undefined
} {
  const completed = ledger.completed.map((e) => ({
    id: e.callId,
    name: e.name,
    arguments: e.normalizedArguments,
    result: e.result,
    failed: e.failed,
  }))
  const pending = ledger.pending.map((e) => ({
    id: e.callId,
    name: e.name,
    arguments: e.normalizedArguments,
    result: '',
    failed: false,
  }))
  const hasRepeatedFailure = ledger.issues.some((i) => i.code === 'repeated_failure')
  const hasRoundLimit = ledger.issues.some((i) => i.code === 'tool_round_limit')
  const hasConsecutive = ledger.issues.some((i) => i.code === 'consecutive_fingerprint_limit')
  // consecutive_fingerprint_limit 映射为 repeatedCall（连续相同调用），
  // 但不要映射为 stuckLoop（stuckLoop 是旧版中重复失败 >=3 或重复成功 >=5 的硬熔断）
  const stuckLoop = hasRepeatedFailure || hasRoundLimit
  const repeatedCall = hasConsecutive
  const repeatedFailure = hasRepeatedFailure
  const repetitionSignature = ledger.issues.find((i) => i.code === 'repeated_failure' || i.code === 'consecutive_fingerprint_limit')?.fingerprint

  return {
    completed,
    pending,
    toolRounds: ledger.roundCount,
    repeatedCall,
    repeatedFailure,
    stuckLoop,
    repetitionSignature,
  }
}

/** 紧凑证据上下文（同 CF2 completedEvidenceContext），注入路由/主回答提示词 */
export function ledgerRouterContext(ledger: ToolLedger): string {
  const compact = {
    completed: ledger.completed.map((e) => ({ name: e.name, args: e.normalizedArguments, failed: e.failed })),
    pending: ledger.pending.map((e) => ({ name: e.name, args: e.normalizedArguments })),
    issues: ledger.issues.map((i) => i.code),
  }
  const json = JSON.stringify(compact)
  let hint = 'Use only this compact evidence. A completed call is final evidence; do not issue the same name and arguments again.'
  if (ledger.issues.some((i) => i.code === 'repeated_failure')) {
    hint += ' The same call failed repeatedly; change strategy instead of retrying unchanged.'
  }
  if (ledger.issues.some((i) => i.code === 'consecutive_fingerprint_limit')) {
    hint += ' STOP: the same call has been repeated consecutively with no progress. Do not re-invoke it.'
  }
  return hint + '\nEVIDENCE_LEDGER: ' + json
}