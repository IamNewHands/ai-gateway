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
  /**
   * 上游 error 帧内**文本叶子**的脱敏钩子（默认恒等，即原样透传）。
   *
   * 为什么是钩子而非直接 import：proxy.ts 已 import 本模块，反向 import 会成环；
   * 且脱敏是**网关侧策略**（本仓有 sanitizeUpstreamError 的脱敏红线），
   * 由 proxy 层注入、本模块只负责"在哪里脱敏"。
   *
   * 只对字符串值生效：`code`/`requestId` 等非字符串叶子必须原样透出（否则客户端
   * 拿不到可判定的错误码）。
   */
  sanitizeErrorText?: (text: string) => string
  /**
   * 可选的在途用量（prompt/completion/total），用于护盾合成终态帧时填进 usage，
   * 避免客户端把熔断截断计为零用量。未提供时用已投喂的 reasoning 字符数兜底估算。
   */
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
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
  /** 触发抑制/熔断的原因（供合成终态帧标记，区分真实 token 上限与护盾截断）。 */
  runawayKind?: 'degenerate_loop' | 'budget_exhausted'
  /** 流内最后一次收到的上游错误帧（已脱敏）；无错误帧则为 undefined */
  lastError?: WorkbuddyErrorFrame
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
  /**
   * 该帧是否为**上游错误帧**（顶层带 `error` 键）。
   *
   * 语义：上游在流中/流首回报错误（6004 限流、审核拦截、会话失效等）。这类帧
   * **不参与**白名单重建——重建会把 error 整键剥掉，客户端既看不到错误也拿不到
   * 内容（只能干等到流结束）。见 `passthroughWorkbuddyErrorFrame`。
   */
  isError?: boolean
  /** 错误帧的**已脱敏**文本（`isError` 为真时存在），供聚合路径转非流式错误体。 */
  error?: WorkbuddyErrorFrame
}

/**
 * 上游错误帧的提取结果（对齐 workbuddy2api sse.go 的 error-passthrough）。
 *
 * `raw` 是**已脱敏**后的 JSON 原文（不是上游原文）——本仓有 `sanitizeUpstreamError`
 * 的脱敏红线，故折中为"透传语义 + 网关脱敏"，而非上游的裸透传。
 */
export interface WorkbuddyErrorFrame {
  /** 上游业务错误码（6004/11102/11-128 等）；非字符串叶子原样保留以便客户端判定 */
  code?: unknown
  /** 上游错误文案（已脱敏、已截断） */
  message?: string
  /** 上游请求 id（便于对账；非字符串叶子原样保留） */
  requestId?: unknown
  /** 已脱敏的完整帧 JSON 文本 */
  raw: string
}

/** 判断帧是否带 `error` 键（非 null/undefined）。 */
function hasErrorKey(frame: Record<string, unknown>): boolean {
  const e = frame['error']
  return e !== undefined && e !== null
}

/**
 * 递归脱敏错误帧中的**字符串叶子**（非字符串值——含 code/requestId——原样保留）。
 *
 * 为什么只脱敏字符串：`code` 常是数字（6004），`requestId` 是字符串。若把 code 也
 * 当文本处理会破坏类型，客户端 `err.code === 6004` 判定即失效。脱敏的诉求是"别泄漏
 * 凭据/内网地址"，那只可能出现在文案里。
 */
function sanitizeErrorLeaves(value: unknown, sanitize: (t: string) => string): unknown {
  if (typeof value === 'string') return sanitize(value)
  if (Array.isArray(value)) return value.map((v) => sanitizeErrorLeaves(v, sanitize))
  if (isObj(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeErrorLeaves(v, sanitize)
    return out
  }
  return value
}

/** 从错误信封里取文案（`error.message` → `error.msg` → `msg` → `message`）。 */
function errorMessageOf(err: unknown): string {
  if (isObj(err)) {
    for (const k of ['message', 'msg', 'error_description', 'detail']) {
      const v = err[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
  }
  if (typeof err === 'string' && err.trim() !== '') return err.trim()
  return ''
}

/** 从错误信封里取业务码（`error.code` → `error.data.code` → 顶层 `code`）。 */
function errorCodeOf(frame: Record<string, unknown>, err: unknown): unknown {
  if (isObj(err)) {
    if (err['code'] !== undefined) return err['code']
    const data = err['data']
    if (isObj(data) && data['code'] !== undefined) return data['code']
  }
  return frame['code']
}

/** 从错误信封里取 requestId（`error.requestId` → `error.data.requestId` → 顶层）。 */
function errorRequestIdOf(frame: Record<string, unknown>, err: unknown): unknown {
  if (isObj(err)) {
    if (err['requestId'] !== undefined) return err['requestId']
    const data = err['data']
    if (isObj(data) && data['requestId'] !== undefined) return data['requestId']
  }
  return frame['requestId']
}

/**
 * 把带 `error` 键的帧转成**已脱敏**的错误帧（对齐 workbuddy2api sse.go 的 writeRaw 语义，
 * 但出口套本仓脱敏管线）。
 *
 * 与 `normalizeWorkbuddyFrame` 的分工：错误帧**不走白名单**——白名单只认
 * id/object/created/model/system_fingerprint/service_tier 六个键，error 会被整键丢弃，
 * 于是客户端收到一个语义为空的 chunk。这里改为：脱敏后原样序列化，键结构（含
 * `error.data.code` 这类嵌套）完整保留。
 */
export function sanitizeWorkbuddyErrorFrame(
  frame: Record<string, unknown>,
  sanitize?: (text: string) => string,
): WorkbuddyErrorFrame {
  const fn = sanitize ?? ((t: string) => t)
  const cleaned = sanitizeErrorLeaves(frame, fn) as Record<string, unknown>
  const err = frame['error']
  return {
    code: errorCodeOf(frame, err),
    message: errorMessageOf(cleaned['error'] !== undefined ? cleaned['error'] : cleaned),
    requestId: errorRequestIdOf(frame, err),
    raw: JSON.stringify(cleaned),
  }
}

/**
 * 处理一条 `data: ` 负载（对齐 workbuddy2api Stream 的 writeFrame）：
 *  0. **上游错误帧**（顶层带 `error`）→ 脱敏后**原样透传**（不参与白名单重建）；
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

  // 上游错误帧：原样透传（仅脱敏），且计入有效帧——否则会被误判为空流。
  if (hasErrorKey(frame)) {
    const err = sanitizeWorkbuddyErrorFrame(frame, state.options?.sanitizeErrorText)
    state.lastError = err
    return { payload: err.raw, valid: true, isError: true, error: err }
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
            state.runawayKind = 'degenerate_loop'
            state.options?.onRunaway?.('degenerate_loop')
            if (state.options?.stopSignal) state.options.stopSignal.aborted = true
          }
        }

        // 字符预算上限检测
        const maxChars = state.options?.maxReasoningChars ?? WORKBUDDY_DEFAULT_MAX_REASONING_CHARS
        if (maxChars > 0 && state.reasoningChars >= maxChars && !state.suppressed) {
          state.suppressed = true
          state.runawayKind = 'budget_exhausted'
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
 *  - **上游错误帧**（顶层带 `error`）→ 脱敏后原样写出，**不参与**白名单重建与噪声丢弃，
 *    并计入有效帧（对齐 workbuddy2api sse.go writeRaw 的 error-passthrough）；
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

    const { payload, valid, isError } = processWorkbuddyFrame(data, state)
    if (!valid) return chunk

    // 上游错误帧：脱敏后原样透出。**必须先于**噪声判定与终态丢弃判定——
    // 错误帧没有 choices，会被下面的噪声逻辑当空帧丢掉；而它恰恰是客户端
    // 唯一能知道"为什么失败"的信息（6004 限流 / 审核 / 会话失效）。
    if (isError) {
      // 已发出合成终态帧（含 [DONE]）后不再追加，否则 [DONE] 之后还有帧属畸形流。
      // 但 state.lastError 已在 processWorkbuddyFrame 中记录，聚合路径仍能拿到。
      if (state.terminated) return ''
      return `data: ${payload}`
    }

    // 若触发抑制且全程未产出任何正文/工具调用，且尚未发送终态合成帧
    if (state.suppressed && !state.terminated && state.contentChars === 0 && !state.hasToolCalls) {
      state.terminated = true
      // 护盾截断帧：携带估算 usage（避免客户端计费/用量显示为全 0）以及非标准
      // x_workbuddy_runaway 标记，让客户端能把「护盾熔断」与上游真实的 finish_reason
      // "length"（真·token 上限）区分开，而不是把死循环熔断误报成输出 token 上限。
      const termObj = {
        id: state.firstId || WORKBUDDY_SENTINEL_ID,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: state.model || 'workbuddy',
        usage: {
          prompt_tokens: state.options?.usage?.promptTokens ?? 0,
          completion_tokens: state.options?.usage?.completionTokens ?? state.detector.totalReasoningChars,
          total_tokens: state.options?.usage?.totalTokens ?? state.detector.totalReasoningChars,
        },
        x_workbuddy_runaway: state.runawayKind ?? 'degenerate_loop',
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

