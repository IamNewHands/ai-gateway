/**
 * workbuddy-sse.ts — WorkBuddy 上游 SSE 帧的**规范化重建**与流式透传
 * （移植 workbuddy2api internal/upstream/sse.go 的 normalizeFrame / backfillToolCallNames /
 * Stream 的首帧 id 续传与 [DONE] 兜底）。
 *
 * 为什么要"重建"而非"清洗"：本仓原有 cleanWorkbuddyChunk 只做删除（去空 tool_calls 等），
 * 而上游帧里还有若干**必须补齐**的规范字段，否则严格客户端解析失败：
 *  - `finish_reason: ""` → 必须为 `null`（OpenAI 规范只允许 null 或具体值）；
 *  - `usage` 缺失 → 必须显式 `null`（部分 SDK 依赖该键存在）；
 *  - 顶层未知字段应剔除（白名单）；
 *  - `id` 在中间帧缺失/空 → 应续用首帧真实 id（否则同一条消息的帧 id 分裂，客户端/后台
 *    无法按 id 归并）；
 *  - `tool_calls[].function.name` 在后续分片缺省/置空 → 必须按 index 回填（否则逐 chunk
 *    消费的客户端会把工具名清空，导致 tool call 卡死）。
 *
 * 纯函数 + 一个显式的跨帧状态对象：便于单测，也避免把状态藏在模块级变量里。
 */

/** 判定文本窗口是否呈现典型的短语/行重复推理退化（校准自 log3 与 log4 真实会话数据）。 */
export function isDegenerateReasoningWindow(
  text: string,
  minLines = 20,
  maxDistinct = 10,
  minRepeatRatio = 0.85,
  minOccurrence = 4,
): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < minLines) return false
  const counts = new Map<string, number>()
  for (const l of lines) {
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  if (counts.size > maxDistinct) return false
  let repeated = 0
  for (const c of counts.values()) {
    if (c >= minOccurrence) repeated += c
  }
  return repeated / lines.length >= minRepeatRatio
}

/** 连续流式 reasoning delta 退化检测器。 */
export class WorkbuddyDegeneracyDetector {
  readonly windowChars: number
  readonly stride: number
  readonly minLines: number
  readonly maxDistinct: number
  readonly minRepeatRatio: number
  readonly minOccurrence: number
  readonly consecutiveTripsRequired: number

  private buffer = ''
  private lastEvaluatedPos = 0
  private consecutiveTrips = 0
  isDegenerate = false
  totalReasoningChars = 0

  constructor(opts?: {
    windowChars?: number
    stride?: number
    minLines?: number
    maxDistinct?: number
    minRepeatRatio?: number
    minOccurrence?: number
    consecutiveTrips?: number
  }) {
    this.windowChars = opts?.windowChars ?? 2000
    this.stride = opts?.stride ?? 500
    this.minLines = opts?.minLines ?? 20
    this.maxDistinct = opts?.maxDistinct ?? 10
    this.minRepeatRatio = opts?.minRepeatRatio ?? 0.85
    this.minOccurrence = opts?.minOccurrence ?? 4
    this.consecutiveTripsRequired = opts?.consecutiveTrips ?? 3
  }

  feedDelta(delta: string): boolean {
    if (this.isDegenerate) return true
    this.totalReasoningChars += delta.length
    this.buffer += delta

    while (this.buffer.length - this.lastEvaluatedPos >= this.windowChars) {
      const win = this.buffer.slice(this.lastEvaluatedPos, this.lastEvaluatedPos + this.windowChars)
      const trip = isDegenerateReasoningWindow(
        win,
        this.minLines,
        this.maxDistinct,
        this.minRepeatRatio,
        this.minOccurrence,
      )
      if (trip) {
        this.consecutiveTrips++
        if (this.consecutiveTrips >= this.consecutiveTripsRequired) {
          this.isDegenerate = true
          return true
        }
      } else {
        this.consecutiveTrips = 0
      }
      this.lastEvaluatedPos += this.stride
    }

    if (this.lastEvaluatedPos > this.windowChars * 2) {
      this.buffer = this.buffer.slice(this.lastEvaluatedPos)
      this.lastEvaluatedPos = 0
    }
    return this.isDegenerate
  }
}

/** 默认最大 reasoning 字符数（约 16k tokens），超过且未产生正文则熔断 */
export const WORKBUDDY_DEFAULT_MAX_REASONING_CHARS = 65536

/** 流式推理防护配置选项 */
export interface WorkbuddyStreamOptions {
  /** 单次请求最大 reasoning 字符上限，默认 65536（0 或负数表示不限） */
  maxReasoningChars?: number
  /** 是否启用退化死循环检测，默认 true */
  enableDegeneracyDetection?: boolean
  /** 发生严重退化或超预算时的回调通知 */
  onRunaway?: (kind: 'degenerate_loop' | 'budget_exhausted') => void
  /** 中止流控制信号 */
  stopSignal?: { aborted: boolean }
}

/** 帧重建与推理防护的跨帧状态（一条 SSE 流一个实例）。 */
export interface WorkbuddyStreamState {
  /** 首帧的真实 id（后续帧缺失/空时续用）；全流无真实 id 才出现哨兵。 */
  firstId: string
  /** tool_calls index → function.name 缓存（跨帧回填被上游清空的 name）。 */
  toolCallNames: Map<number, string>
  /** 累计 reasoning 字符数 */
  reasoningChars: number
  /** 累计正文字符数 */
  contentChars: number
  /** 是否已出现 tool_calls */
  hasToolCalls: boolean
  /** 是否已触发抑制（一旦抑制，不再下发 reasoning_content） */
  suppressed: boolean
  /** 是否已发出合成的截断/完成帧 */
  terminated: boolean
  /** 上游模型名称 */
  model: string
  /** 退化检测器实例 */
  detector: WorkbuddyDegeneracyDetector
  /** 流选项 */
  options?: WorkbuddyStreamOptions
}

/** 新建一条流的跨帧状态。 */
export function newWorkbuddyStreamState(options?: WorkbuddyStreamOptions): WorkbuddyStreamState {
  return {
    firstId: '',
    toolCallNames: new Map(),
    reasoningChars: 0,
    contentChars: 0,
    hasToolCalls: false,
    suppressed: false,
    terminated: false,
    model: '',
    detector: new WorkbuddyDegeneracyDetector(),
    options,
  }
}

/** 全流无真实 id 时使用的哨兵 id（对齐 workbuddy2api normalizeFrame）。 */
export const WORKBUDDY_SENTINEL_ID = 'chatcmpl-wb2api'

/** 顶层保留键白名单（对齐 workbuddy2api normalizeFrame）。 */
const FRAME_TOP_KEYS = ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier'] as const

/** 判断是否为对象（非 null / 非数组）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 按 index 回填 tool_calls 的 function.name（就地修改，对齐 workbuddy2api backfillToolCallNames）。
 *
 * 规则：
 *  - `function.name` 非空 → **覆盖**缓存（允许上游中途改名）；
 *  - name 缺失/空 → 从缓存回填；`function` 不存在时新建。
 * 只动 `function.name`，其余字段（尤其 arguments 跨 chunk 拼接）保持不变。
 */
export function backfillToolCallNames(frame: Record<string, unknown>, names: Map<number, string>): void {
  const choices = frame['choices']
  if (!Array.isArray(choices)) return
  for (const ci of choices) {
    if (!isObj(ci)) continue
    const delta = ci['delta']
    if (!isObj(delta)) continue
    const tcs = delta['tool_calls']
    if (!Array.isArray(tcs)) continue
    for (const tci of tcs) {
      if (!isObj(tci)) continue
      const idx = typeof tci['index'] === 'number' ? tci['index'] : 0
      let fn = tci['function']
      const name = isObj(fn) && typeof fn['name'] === 'string' ? fn['name'] : ''
      if (name !== '') {
        names.set(idx, name)
        continue
      }
      const cached = names.get(idx)
      if (cached !== undefined) {
        if (!isObj(fn)) {
          fn = {}
          tci['function'] = fn
        }
        ;(fn as Record<string, unknown>)['name'] = cached
      }
    }
  }
}

/**
 * 以 OpenAI 流式规范白名单重建单帧（对齐 workbuddy2api normalizeFrame）。
 *
 * 顶层：只保留白名单键（非 null）；`object` 缺失补 `chat.completion.chunk`；
 * `id` 缺失补哨兵；`usage` 存在则原样保留，**缺失则显式 null**。
 *
 * choices[]：逐项重建 —— `index` 存在才留；`delta` 从零重建，只保留非空的
 * `role`/`content`/`reasoning_content`/`refusal`、非空数组 `tool_calls`、
 * 以及非空占位的 `function_call`；`finish_reason` 非空才留，**否则写 null**。
 */
export function normalizeWorkbuddyFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of FRAME_TOP_KEYS) {
    const v = frame[k]
    if (v !== undefined && v !== null) out[k] = v
  }
  if (out['object'] === undefined) out['object'] = 'chat.completion.chunk'
  if (out['id'] === undefined) out['id'] = WORKBUDDY_SENTINEL_ID

  const choices = frame['choices']
  if (Array.isArray(choices)) {
    const nchs: Record<string, unknown>[] = []
    for (const ci of choices) {
      if (!isObj(ci)) continue
      const nc: Record<string, unknown> = {}
      if (ci['index'] !== undefined) nc['index'] = ci['index']

      const delta: Record<string, unknown> = {}
      const d = ci['delta']
      if (isObj(d)) {
        if (typeof d['role'] === 'string' && d['role'] !== '') delta['role'] = d['role']
        if (typeof d['content'] === 'string' && d['content'] !== '') delta['content'] = d['content']
        if (typeof d['reasoning_content'] === 'string' && d['reasoning_content'] !== '') {
          delta['reasoning_content'] = d['reasoning_content']
        }
        if (typeof d['refusal'] === 'string' && d['refusal'] !== '') delta['refusal'] = d['refusal']
        if (Array.isArray(d['tool_calls']) && d['tool_calls'].length > 0) delta['tool_calls'] = d['tool_calls']
        const fc = d['function_call']
        if (fc !== undefined && fc !== null) {
          // 空占位 function_call（name/arguments 全空）视为噪声剔除
          let keep = true
          if (isObj(fc)) {
            const n = typeof fc['name'] === 'string' ? fc['name'] : ''
            const a = typeof fc['arguments'] === 'string' ? fc['arguments'] : ''
            keep = n !== '' || a !== ''
          }
          if (keep) delta['function_call'] = fc
        }
      }
      nc['delta'] = delta

      const fr = ci['finish_reason']
      nc['finish_reason'] = typeof fr === 'string' && fr !== '' ? fr : null
      nchs.push(nc)
    }
    out['choices'] = nchs
  }

  out['usage'] = frame['usage'] !== undefined ? frame['usage'] : null
  return out
}

/** 单帧处理结果。 */
export interface FrameProcessResult {
  /** 要写出的 `data: ` 负载（空串表示该帧应被丢弃） */
  payload: string
  /** 该帧是否为有效数据帧（JSON 解析成功） */
  valid: boolean
}

/**
 * 处理一条 `data: ` 负载（对齐 workbuddy2api Stream 的 writeFrame）：
 *  1. JSON 解析失败 → 原样返回（`valid: false`，不计入有效帧）；
 *  2. 回填 tool_calls name；
 *  3. **首帧 id 续传**：首个非空 id 缓存为 firstId；后续帧 id 缺失/空 → 用 firstId；
 *     已有自己 id 的帧保持原样（不同流分裂的帧允许各自 id）；
 *  4. 白名单重建后序列化。
 */
export function processWorkbuddyFrame(payload: string, state: WorkbuddyStreamState): FrameProcessResult {
  let frame: Record<string, unknown>
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!isObj(parsed)) return { payload, valid: false }
    frame = parsed
  } catch {
    return { payload, valid: false }
  }

  // 记录上游 model
  if (typeof frame['model'] === 'string' && frame['model'] !== '') {
    state.model = frame['model']
  }

  backfillToolCallNames(frame, state.toolCallNames)

  // 首帧 id 透传与哨兵兜底
  const rawId = frame['id']
  if (state.firstId === '') {
    if (typeof rawId === 'string' && rawId !== '') state.firstId = rawId
  } else if (typeof rawId !== 'string' || rawId === '') {
    frame['id'] = state.firstId
  }

  // 统计正文与推理，执行退化与预算防护
  const choices = frame['choices']
  if (Array.isArray(choices)) {
    for (const ci of choices) {
      if (!isObj(ci)) continue
      const delta = ci['delta']
      if (!isObj(delta)) continue

      if (typeof delta['content'] === 'string' && delta['content'] !== '') {
        state.contentChars += delta['content'].length
      }
      if (Array.isArray(delta['tool_calls']) && delta['tool_calls'].length > 0) {
        state.hasToolCalls = true
      }

      const reasoning = delta['reasoning_content']
      if (typeof reasoning === 'string' && reasoning !== '') {
        state.reasoningChars += reasoning.length

        // 退化死循环检测
        if (state.options?.enableDegeneracyDetection !== false && !state.suppressed) {
          if (state.detector.feedDelta(reasoning)) {
            state.suppressed = true
            state.options?.onRunaway?.('degenerate_loop')
            if (state.options?.stopSignal) state.options.stopSignal.aborted = true
          }
        }

        // 字符预算上限检测
        const maxChars = state.options?.maxReasoningChars ?? WORKBUDDY_DEFAULT_MAX_REASONING_CHARS
        if (maxChars > 0 && state.reasoningChars >= maxChars && !state.suppressed) {
          state.suppressed = true
          state.options?.onRunaway?.('budget_exhausted')
          if (state.options?.stopSignal) state.options.stopSignal.aborted = true
        }

        // 触发抑制后，彻底从输出 delta 中剔除 reasoning_content，防止 UI 刷屏/崩溃
        if (state.suppressed) {
          delete delta['reasoning_content']
        }
      }
    }
  }

  try {
    return { payload: JSON.stringify(normalizeWorkbuddyFrame(frame)), valid: true }
  } catch {
    return { payload, valid: true }
  }
}

/**
 * 创建一个**有状态**的 WorkBuddy SSE 行清洗器，供 passthroughResponse 的 cleanFn 使用。
 *
 * 与纯函数版 cleanWorkbuddyChunk 的差异：跨帧维护 firstId 与 toolCallNames，
 * 并在流式转发中执行推理退化监控、预算熔断、垃圾 reasoning 抑制与优雅截断。
 *
 * 行为：
 *  - 非 `data:` 行 / 空行 → 原样返回（保留 SSE 分隔语义）；
 *  - `[DONE]` → 原样返回（由上层保证只写一次）；
 *  - 有效 data 帧 → 白名单重建与退化/预算防护；
 *  - 退化且未产出正文时 → 注入合成 finish_reason: "length" 截断帧并通知中止；
 *  - 重建后 `choices` 为空数组且无 `usage`（或 delta 被抑制为空的帧）→ 丢弃（纯噪声）。
 */
export function createWorkbuddyChunkCleaner(options?: WorkbuddyStreamOptions): (chunk: string) => string {
  const state = newWorkbuddyStreamState(options)
  return (chunk: string): string => {
    const trimmed = chunk.trim()
    if (!trimmed) return chunk
    if (!trimmed.startsWith('data:')) return chunk
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return chunk

    const { payload, valid } = processWorkbuddyFrame(data, state)
    if (!valid) return chunk

    // 若触发抑制且全程未产出任何正文/工具调用，且尚未发送终态合成帧
    if (state.suppressed && !state.terminated && state.contentChars === 0 && !state.hasToolCalls) {
      state.terminated = true
      const termObj = {
        id: state.firstId || WORKBUDDY_SENTINEL_ID,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: state.model || 'workbuddy',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'length',
          },
        ],
      }
      return `data: ${JSON.stringify(termObj)}\n\ndata: [DONE]`
    }

    // 终态发出后，丢弃后续上游帧
    if (state.terminated) {
      return ''
    }

    // 噪声帧丢弃：choices 为空且无 usage，或 reasoning 被抑制后 delta 完全为空且无 finish_reason
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>
      const chs = obj['choices']
      if (Array.isArray(chs)) {
        if (chs.length === 0 && (obj['usage'] === null || obj['usage'] === undefined)) {
          return ''
        }
        if (chs.length === 1 && isObj(chs[0])) {
          const delta = (chs[0] as Record<string, unknown>)['delta']
          const fr = (chs[0] as Record<string, unknown>)['finish_reason']
          if (
            isObj(delta) &&
            Object.keys(delta).length === 0 &&
            (fr === null || fr === undefined) &&
            (obj['usage'] === null || obj['usage'] === undefined)
          ) {
            return ''
          }
        }
      }
    } catch { /* 保持原 payload */ }

    return `data: ${payload}`
  }
}

