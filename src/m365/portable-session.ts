import { decodeTaskAnchors, encodeTaskAnchors } from './task-anchors'
import type { TaskAnchor } from './task-anchors'

/** 会话快照持久化的字节预算（移植自 M365-Gateway chat-session.ts） */
export const MAX_CHAT_SESSION_STATE_BYTES = 192 * 1_024
export const MAX_PORTABLE_SESSION_BYTES = 64 * 1_024
export const MAX_CALLER_TOOLS_SNAPSHOT_BYTES = 64 * 1_024
export const MAX_TOOL_LEDGER_SNAPSHOT_BYTES = 64 * 1_024

/**
 * 可移植会话状态：任务锚点 + 有界的协议尾部。
 * 协议尾部刻意保留"完整的成帧回合"后缀：预算耗尽时最新的
 * 调用/结果/用户回合存活，陈旧历史从头部脱落，且不切断某个回合。
 */
export interface PortableSessionState {
  taskAnchors: TaskAnchor[]
  protocolTail: string
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** 与提示词渲染层共用的成帧分隔符，保证持久化的字节上限不会切断最新逻辑回合 */
export const PORTABLE_TURN_SEPARATOR = '\n\u001eM365_PORTABLE_TURN_V1\u001f\n'

export function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

/** 保留最新的一段 UTF-8 后缀，且起点绝不落在码点中间（同源 boundedUtf8Suffix） */
export function boundedUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return ''
  const encoded = utf8Encoder.encode(value)
  if (encoded.byteLength <= maxBytes) return value
  let start = encoded.byteLength - maxBytes
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1
  return start < encoded.byteLength ? utf8Decoder.decode(encoded.subarray(start)) : ''
}

/** 保留一段 UTF-8 前缀，且终点绝不落在码点中间（同源 boundedUtf8Prefix） */
function boundedUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return ''
  const encoded = utf8Encoder.encode(value)
  if (encoded.byteLength <= maxBytes) return value
  let end = Math.min(encoded.byteLength, Math.trunc(maxBytes))
  // 有界前缀可能在多字节前导字节后结束：逐步回退直到 fatal 解码器接受完整序列。
  // 这同时覆盖 ASCII 与任意 UTF-8 宽度，且不会伪造 U+FFFD。
  while (end > 0) {
    try {
      return utf8Decoder.decode(encoded.subarray(0, end))
    } catch {
      end -= 1
    }
  }
  return ''
}

function portableTurnIsComplete(value: string): boolean {
  const turn = value.trim()
  if (!turn || !turn.startsWith('[')) return false
  return /(?:^|\n)\[ASSISTANT(?: TOOL CALL[^\]]*)?\]/u.test(turn)
    && /(?:^|\n)\[(?:USER|TURN|SYSTEM|DEVELOPER|INTERNAL TASK REFERENCES)\]/u.test(turn)
}

const OVERSIZED_PORTABLE_TURN_MARKER = '[OVERSIZED PORTABLE TURN CONTENT OMITTED]'

/**
 * 当单个最新回合大于整个可移植预算时，保留结构完整的表示。
 * 请求前缀通常承载任务/路径锚点，因此只替换超大的正文部分。
 */
function compactOversizedPortableTurn(turn: string, maxBytes: number): string {
  const value = turn.trim()
  const requestMatch = /(?:^|\n)\[(?:USER|TURN|SYSTEM|DEVELOPER|INTERNAL TASK REFERENCES)\]/u.exec(value)
  const assistantMatch = /(?:^|\n)\[ASSISTANT(?: TOOL CALL[^\]]*)?\]/u.exec(value)
  if (!requestMatch || !assistantMatch || assistantMatch.index <= requestMatch.index) return ''
  const requestStart = requestMatch.index + (requestMatch[0].startsWith('\n') ? 1 : 0)
  const assistantHeader = assistantMatch[0].trimStart()
  const request = value.slice(requestStart, assistantMatch.index).trimEnd()
  const suffix = `\n\n${assistantHeader}\n${OVERSIZED_PORTABLE_TURN_MARKER}`
  const available = maxBytes - utf8Bytes(suffix)
  if (available <= 0) return ''
  const prefix = boundedUtf8Prefix(request, available).trimEnd()
  const compacted = `${prefix}${suffix}`
  return utf8Bytes(compacted) <= maxBytes ? compacted : ''
}

/**
 * 按"完整成帧回合"裁剪可移植历史。原始 UTF-8 后缀可能在最新的
 * `[USER]` 或 `[ASSISTANT]` 段中间开始；恢复时会丢弃该最新任务，
 * 导致长任务智能体"忘记"自己在做什么。无帧的遗留文本保留码点安全行为。
 */
export function boundedPortableProtocolSuffix(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return ''
  if (utf8Bytes(value) <= maxBytes) return value
  const rawTurns = value.includes(PORTABLE_TURN_SEPARATOR)
    ? value.split(PORTABLE_TURN_SEPARATOR)
    : [value]
  const hasFramedTurn = rawTurns.some((turn) => portableTurnIsComplete(turn))
  if (!hasFramedTurn) return boundedUtf8Suffix(value, maxBytes)

  const selected: string[] = []
  let selectedBytes = 0
  for (let index = rawTurns.length - 1; index >= 0; index -= 1) {
    const turn = rawTurns[index].trim()
    if (!portableTurnIsComplete(turn)) continue
    const separatorBytes = selected.length > 0 ? utf8Bytes(PORTABLE_TURN_SEPARATOR) : 0
    const turnBytes = utf8Bytes(turn)
    if (turnBytes + separatorBytes + selectedBytes <= maxBytes) {
      selected.unshift(turn)
      selectedBytes += turnBytes + separatorBytes
      continue
    }
    // 若最新完整回合本身就超预算，则为该回合保留紧凑、结构有效的检查点，
    // 而不是退回过期历史。
    if (selected.length === 0) return compactOversizedPortableTurn(turn, maxBytes)
    break
  }
  return selected.join(PORTABLE_TURN_SEPARATOR)
}

/**
 * 任务锚点有独立的严格计数/取值上限。先为锚点分配预算，剩余字节保留
 * 最新的协议历史。因此持久化表示的总量永远不会超过 64 KiB。
 */
export function boundPortableSessionState(
  taskAnchors: ReadonlyArray<TaskAnchor> | undefined,
  protocolTail: string | null | undefined,
): PortableSessionState {
  const anchors = decodeTaskAnchors(encodeTaskAnchors(taskAnchors))
  const encodedAnchors = encodeTaskAnchors(anchors)
  const anchorBytes = utf8Bytes(encodedAnchors)
  if (anchorBytes > MAX_PORTABLE_SESSION_BYTES) throw new Error('PORTABLE_TASK_ANCHORS_TOO_LARGE')
  return {
    taskAnchors: anchors,
    protocolTail: boundedPortableProtocolSuffix(
      typeof protocolTail === 'string' ? protocolTail : '',
      MAX_PORTABLE_SESSION_BYTES - anchorBytes,
    ),
  }
}

export function portableSessionByteLength(state: PortableSessionState): number {
  return utf8Bytes(encodeTaskAnchors(state.taskAnchors)) + utf8Bytes(state.protocolTail)
}
