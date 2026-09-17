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
  /**
   * 已转发的**有效帧**计数（对齐 workbuddy2api StreamHint 的 validFrames）：
   * 口径 = `data:` 负载 JSON 解析成功（`processWorkbuddyFrame` 返回 valid:true），
   * 解析失败的原样直写帧**不计数**（对齐源实现 writeFrame 注释）。错误帧计数。
   *
   * 用途：为 0 时说明上游「200 但空流」，流结束时由 finishStream 补 error 帧兜底。
   */
  validFrames: number
  /**
   * 上游 `data: [DONE]` 因「当时 0 有效帧」被**扣留**（未透传）。
   * 扣留是为了让上游「200 + 只有 [DONE]」的空流不再被客户端当成正常收尾；
   * 由 finishStream 决定补 error 帧还是仅补 [DONE]。
   */
  doneWithheld: boolean
  /**
   * 缺 `index` 的 tool_call 分派状态（移植 workbuddy2api 5c2db2f，见
   * `dispatchToolCallIndexes`）：分配序号源 / 已占用 index / 最近槽位 / id → index。
   * 跨帧持续，与本流下发出去的补位 index 保持一致。
   */
  toolIndexSeq: number
  toolUsedIndexes: Set<number>
  toolLastIndex: number
  toolIdIndex: Map<string, number>
  /**
   * 非 delta `message` 帧最近一次已下发的正文快照（移植 11b75d4 + 6701631 的
   * latch 语义，见 `hoistMessageToDelta`）：同一快照重复出现不重复下发，快照增长
   * 只补差量，避免「每帧都带完整 message」的上游让客户端拼出 N 遍正文。
   */
  messageSnapshot: string
  /**
   * 本流是否已从**真正的 delta** 路径下发过非空正文（对齐源 `gotAnyContent` 守卫）。
   * 为真时 `message` 快照正文一律跳过——否则快照会把已下发的 delta 正文重复一遍。
   * 注意不能用 `contentChars` 代替：message 快照自己也会累加 contentChars。
   */
  deltaContentSeen: boolean
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
    validFrames: 0,
    doneWithheld: false,
    toolIndexSeq: 0,
    toolUsedIndexes: new Set<number>(),
    toolLastIndex: -1,
    toolIdIndex: new Map<string, number>(),
    messageSnapshot: '',
    deltaContentSeen: false,
  }
}

/** 全流无真实 id 时使用的哨兵 id（对齐 workbuddy2api normalizeFrame）。 */
export const WORKBUDDY_SENTINEL_ID = 'chatcmpl-wb2api'

/**
 * 上游「200 + 0 有效帧」空流时网关补发的 error 帧原文（移植 workbuddy2api 0a86854）。
 *
 * 与源实现逐字一致，含 `code` 字段且值为 `upstream_parse`——与 JSON 端点的错误 code
 * 口径统一（源 commit 刻意从 PR 的 `upstream_stream_error` 改为 `upstream_parse`，
 * 让客户端按 code 聚合时空流不裂成两类）。固定字面量、不含任何上游数据，故无需脱敏。
 */
export const WORKBUDDY_EMPTY_STREAM_FRAME =
  '{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}'

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
 * 为非 delta 的 `choices[].message` 帧补出等价 `delta`（移植 workbuddy2api 11b75d4 +
 * 6701631 的 message 兜底与 latch 语义）。
 *
 * 背景：白名单重建（`normalizeWorkbuddyFrame`）只认 `delta`，上游若把**完整消息**放在
 * `choices[].message`（非 delta 形态），正文/推理/工具调用会被整体丢弃 → 客户端收到
 * 200 + 空内容。此处把 message 字段搬到 delta，走与 delta 分支同一条下发管线。
 *
 * 去重（latch）比源实现的「首次即锁、后续全丢」更稳，且不重复下发：
 *  - delta 路径已下发过正文（`contentChars > 0`）→ 整帧跳过（对齐源 `!gotAnyContent` 守卫，
 *    否则快照会与已下发的 delta 正文重复）；
 *  - message 正文与上次快照相同 → 只透出非正文字段，不重复追加正文；
 *  - message 正文是上次快照的**增长版**（快照式上游）→ 只补差量（客户端按 delta 累加
 *    后仍等于快照原文）；
 *  - 其余情况（首次、或与上次无前缀关系）→ 整段下发一次。
 *
 * 只改写 delta 的 role/content/reasoning_content/tool_calls；`finish_reason`/`usage`
 * 等帧级字段原样保留在帧上（由调用方的既有逻辑处理）。
 */
export function hoistMessageToDelta(frame: Record<string, unknown>, state: WorkbuddyStreamState): boolean {
  const choices = frame['choices']
  if (!Array.isArray(choices)) return false
  let hoistedAny = false
  for (const ci of choices) {
    if (!isObj(ci)) continue
    const msg = ci['message']
    if (!isObj(msg)) continue
    hoistedAny = true
    const delta: Record<string, unknown> = isObj(ci['delta']) ? (ci['delta'] as Record<string, unknown>) : {}

    if (typeof msg['role'] === 'string' && msg['role'] !== '') delta['role'] = msg['role']
    if (typeof msg['reasoning_content'] === 'string' && msg['reasoning_content'] !== '') {
      delta['reasoning_content'] = msg['reasoning_content']
    }
    if (Array.isArray(msg['tool_calls']) && msg['tool_calls'].length > 0) {
      delta['tool_calls'] = msg['tool_calls']
    }

    const text = msg['content']
    if (typeof text === 'string' && text !== '' && !state.deltaContentSeen) {
      if (text === state.messageSnapshot) {
        // 完整快照重复出现：正文已在前面下发过，不重复追加
      } else if (state.messageSnapshot !== '' && text.startsWith(state.messageSnapshot)) {
        delta['content'] = text.slice(state.messageSnapshot.length)
        state.messageSnapshot = text
      } else {
        delta['content'] = text
        state.messageSnapshot = text
      }
    }

    ci['delta'] = delta
  }
  return hoistedAny
}

/**
 * 给缺 `index` 的 tool_call 分派 index 并**写回帧**（移植 workbuddy2api 5c2db2f 的分派
 * 规则到流式透传路径）。
 *
 * 为什么流式侧也要做：本仓流式路径逐帧透传（客户端自己聚合），上游省略 index 时不同调用
 * 会被**客户端**合并进同一槽——arguments 串联污染、name 互相覆盖。网关按下发前分派好
 * index，客户端即可正确聚合。规则与源 `mergeToolCallsChunk` 一致：
 *  - 带 index → 原样保留，仅登记占用；
 *  - 缺 index 带 id 且 id 已见过 → 归位该 id 所在 index；
 *  - 缺 index 带 id 且新 id → 开新序号；
 *  - 缺 index 无 id → 延续最近槽位（单调用延续分片的标准形态），无既往则开新号。
 * 新序号从 `toolIndexSeq` 递增并跳过已占用 index，绝不覆盖合规槽。
 */
export function dispatchToolCallIndexes(frame: Record<string, unknown>, state: WorkbuddyStreamState): void {
  const choices = frame['choices']
  if (!Array.isArray(choices)) return
  const nextIndex = (): number => {
    for (;;) {
      const idx = state.toolIndexSeq++
      if (!state.toolUsedIndexes.has(idx)) return idx
    }
  }
  for (const ci of choices) {
    if (!isObj(ci)) continue
    const delta = ci['delta']
    if (!isObj(delta)) continue
    const tcs = delta['tool_calls']
    if (!Array.isArray(tcs)) continue
    for (const tci of tcs) {
      if (!isObj(tci)) continue
      const raw = tci['index']
      let idx: number
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        idx = Math.trunc(raw)
      } else {
        const cid = typeof tci['id'] === 'string' ? tci['id'] : ''
        if (cid !== '') {
          const seen = state.toolIdIndex.get(cid)
          idx = seen !== undefined ? seen : nextIndex()
        } else if (state.toolLastIndex >= 0) {
          idx = state.toolLastIndex
        } else {
          idx = nextIndex()
        }
        // 写回帧：客户端按 index 聚合，网关分派的槽位必须对客户端可见
        tci['index'] = idx
      }
      state.toolUsedIndexes.add(idx)
      state.toolLastIndex = idx
      const cid = typeof tci['id'] === 'string' ? tci['id'] : ''
      if (cid !== '') state.toolIdIndex.set(cid, idx)
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
  /**
   * 网关视角的补充说明（透出时的 `error.gateway_hint` 字段值，见
   * `buildWorkbuddyGatewayHint`）。**未定义 = 未覆盖形态 → 透出时不带该字段**
   * （宁缺勿滥，不编造）。
   *
   * 注意 `raw` 里**不含**该字段：raw 始终是「已脱敏的上游帧原文」这一单一含义，
   * hint 由透出方按需并列附加（帧路径 `attachWorkbuddyGatewayHint`、非流式错误体
   * `workbuddyStreamErrorResponse`）。
   */
  hint?: string
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
 *
 * gateway_hint：返回对象的 `hint` 由 `buildWorkbuddyGatewayHint` 按上游真实 code/文案
 * 判定（未覆盖形态为 undefined = 透出时不带字段）；`raw` 保持「已脱敏上游帧原文」这一
 * 单一含义、**不含** hint，由透出方按需并列附加。
 */
export function sanitizeWorkbuddyErrorFrame(
  frame: Record<string, unknown>,
  sanitize?: (text: string) => string,
): WorkbuddyErrorFrame {
  const fn = sanitize ?? ((t: string) => t)
  const cleaned = sanitizeErrorLeaves(frame, fn) as Record<string, unknown>
  const err = frame['error']
  // hint 只吃上游真实信息（code + 已脱敏文案），不引入任何请求侧上下文/能力元数据。
  const hint = buildWorkbuddyFrameGatewayHint(frame)
  return {
    code: errorCodeOf(frame, err),
    message: errorMessageOf(cleaned['error'] !== undefined ? cleaned['error'] : cleaned),
    requestId: errorRequestIdOf(frame, err),
    raw: JSON.stringify(cleaned),
    ...(hint !== '' ? { hint } : {}),
  }
}

// ===== gateway_hint：错误附加说明字段（移植 workbuddy2api hint.go + sse.go StreamHint）=====

/**
 * 上游错误码的**归一化文本**（`error.code` → `error.data.code` → 顶层 `code`）。
 * 数字/字符串形态统一为字符串，取不到返回空串。
 *
 * 为什么单独抽一个函数：hint 判定既要吃「已解析帧」的 code，也要吃「非流式聚合
 * 错误体」（WorkbuddyErrorFrame）的 code，两者归一化口径必须一致。
 */
function gatewayHintCodeText(frame: Record<string, unknown>): string {
  const code = errorCodeOf(frame, frame['error'])
  if (code === undefined || code === null) return ''
  const text = String(code).trim()
  return text === 'undefined' ? '' : text
}

/** 上游错误码是否为指定值（归一化后精确比较，不做子串匹配）。 */
function isErrorCode(codeText: string, want: string): boolean {
  return codeText !== '' && codeText === want
}

/**
 * 上游错误文案是否命中 11133 `model_param_invalid` 家族。
 *
 * 判据优先级（宁宽勿漏，但只认**真实上游信号**，不猜）：
 *  1. 业务码 11133（归一化精确匹配）；
 *  2. 文案含 `model_param_invalid`（上游 extError.code 原样落在文案里的形态）。
 *
 * 刻意**不**收录源实现的 `invalid request parameters` /
 * `request parameters do not meet the current model requirements` 两条**英文泛化短语**：
 * 上游（腾讯 CodeBuddy）的 msg 是中文（`Invalid request parameters` 只出现在
 * displayMsg.en / extError.message 里，本仓透传的是 msg 原文），而这两条短语会命中
 * 大量**非 11133** 的通用参数错误（含 11101 Unmarshal 家族）——那正是「未覆盖形态
 * 不带字段」要守住的边界。少给一条中性 hint 的代价，远小于对任意参数错误误报图片问题。
 */
function isWorkbuddyModelParamInvalid(codeText: string, message: string): boolean {
  if (isErrorCode(codeText, '11133')) return true
  return message.toLowerCase().includes('model_param_invalid')
}

/**
 * 上游错误文案是否命中 11135 `invalid_image_data` 家族。
 * 判据同 `isWorkbuddyModelParamInvalid`：业务码 11135 精确匹配，或文案含
 * `invalid_image_data`；源实现的 `replace the image` 泛化短语同样不收（理由同上）。
 */
function isWorkbuddyInvalidImageData(codeText: string, message: string): boolean {
  if (isErrorCode(codeText, '11135')) return true
  return message.toLowerCase().includes('invalid_image_data')
}

/**
 * 判定上游错误形态对应的**错误分类**（对齐 workbuddy2api hint.go `FrameKind` 的意图）。
 *
 * 与 `classifyWorkbuddyUpstreamError`（workbuddy-upstream.ts，需要 HTTP status + body）
 * 的分工：hint 判定发生在**流式 error 帧**（没有独立 HTTP status，wire 早已是 200）与
 * 非流式聚合错误体上，两者都只有 code + message。这里只做「code/文案 → 分类」的
 * 无 status 子集，避免为 hint 反向依赖 status 语义。
 *
 * 6004 模型级限流**最先判**：它是模型维度的确定性业务码（对齐源实现
 * `FrameKind` 的 `IsModelRateLimit` 优先），且 6004 的文案可能同时含其他关键词。
 */
function classifyWorkbuddyHintKind(codeText: string, message: string): WorkbuddyHintKind {
  if (isErrorCode(codeText, '6004')) return 'model_rate'
  if (isErrorCode(codeText, '11115') || message.toLowerCase().includes('prompt is too long')) {
    return 'prompt_too_long'
  }
  if (isErrorCode(codeText, '11102') || message.toLowerCase().includes('service info not found')) {
    return 'model_blocked'
  }
  return 'unknown'
}

/** hint 判定用的错误分类（对齐 workbuddy2api ErrKind 的**已接线子集**，见 `buildWorkbuddyGatewayHint`）。 */
export type WorkbuddyHintKind = 'model_rate' | 'prompt_too_long' | 'model_blocked' | 'unknown'

/** gateway_hint 文案（英文口径，面向客户端工具链；与源实现措辞逐字一致，便于跨仓对账）。 */
export const WORKBUDDY_HINT_MODEL_RATE = 'rate limited by upstream; retry after reset'
export const WORKBUDDY_HINT_PROMPT_TOO_LONG = "request context exceeds the model's limit; reduce history/message size"
export const WORKBUDDY_HINT_MODEL_BLOCKED = 'upstream has no such model on this backend; switch model or retry on another account'
export const WORKBUDDY_HINT_MODEL_PARAM_NEUTRAL =
  'request parameters were rejected by the model provider; check message format and model capabilities'
export const WORKBUDDY_HINT_INVALID_IMAGE =
  'image data rejected by upstream; use a real/valid image, may need a new conversation'

/**
 * 组装 `error.gateway_hint` 的**单一事实来源**（移植 workbuddy2api internal/upstream/hint.go
 * `GatewayHint`，按本仓错误出口重新实现）。
 *
 * 纪律（与源实现一致）：
 *  - hint 只做与 `error.message` **并列**的网关视角补充说明，绝不替换/包装 message
 *    （message 永远一字不改地透传）；
 *  - 文案集中在本函数，不散落到各错误出口的 if-else；
 *  - **未覆盖形态返回空串 → 透出时不带该字段**（不编造）；
 *  - 只吃上游**真实信息**（code / message 原文），不臆造 token 数、上限值或能力事实。
 *
 * 已接线形态（覆盖本仓全部可确定判定的出口）：
 *  - 11133 `model_param_invalid`（上游业务码或 extError marker）→ 中性参数提示；
 *  - 11135 `invalid_image_data` → 图片数据无效提示；
 *  - 6004 模型级限流 → 等待重置（流式 error 帧的主形态）；
 *  - 11115 prompt too long（`prompt_too_long` 出口）→ 缩减上下文；
 *  - 11102 model blocked → 换模型/换号。
 *
 * **刻意砍掉**（源实现有、本仓无数据源或出口未接线，故不硬编造）：
 *  1. 源 `HintContext` 的 `HasImage` / `ModelInCatalog` / `ModelSupportsImages`
 *     三件套，以及 11133 的
 *     `model <name> does not support images; pick one with supports_images=true from /v1/models`
 *     分支。理由：本仓**没有**可复用的模型目录 `supports_images` 数据源——`/v1/models`
 *     由 provider 的静态 `models[]` 生成（只有 id/enabled），`workbuddy-models.ts` 的
 *     探测只取 credits/description/efforts（无图片能力），context 目录模块
 *     （`model-context-catalog.ts`）也只声明 context/output 上限。源实现能点名模型的前提
 *     是「目录确实收录了该模型的 supports_images 声明」，缺该前提做「不支持图片」判定就是
 *     编造能力事实 → 退为中性参数提示（宁缺勿滥）。
 *     连带砍掉请求侧 `hasImagePart` 探测：仅 11133 的图片分支需要它，无该分支即无消费者
 *     （源实现也把探测结果只喂给 hintContext）。
 *  2. 源 Kind 表里的 `waf_block` / `account_fault` / `session_dead` / `hard_credit` /
 *     `content_blocked` 条目。理由：本仓这些分类只在**上游 HTTP 响应分类器**
 *     （`classifyWorkbuddyUpstreamError`，需要 status + body）里出现，而它们的错误出口
 *     （ContentBlockedError / WorkbuddyClientError / 503 无可用账号）按本仓**脱敏红线**
 *     只回网关改写文案、**不回上游 code**——没有 code 与原文可依就编 hint 属臆造。
 *     待这些出口把分类信息带出来时再接线（源实现对应出口正是带着 kind 调用的）。
 *
 * @param codeText 上游业务错误码（已归一化为字符串；空串 = 无 code）
 * @param message  上游错误文案原文（**已脱敏**；hint 只读不改）
 */
export function buildWorkbuddyGatewayHint(codeText: string, message: string): string {
  const msg = typeof message === 'string' ? message : ''
  // 11133/11135 上游业务码**先于** Kind 表：实测这两族分类可能落任意 kind，
  // 而 hint 层自带形态判定（hint 是补充说明非权威分类，误判代价只是多一条中性说明）。
  if (isWorkbuddyModelParamInvalid(codeText, msg)) return WORKBUDDY_HINT_MODEL_PARAM_NEUTRAL
  if (isWorkbuddyInvalidImageData(codeText, msg)) return WORKBUDDY_HINT_INVALID_IMAGE
  switch (classifyWorkbuddyHintKind(codeText, msg)) {
    case 'model_rate':
      return WORKBUDDY_HINT_MODEL_RATE
    case 'prompt_too_long':
      return WORKBUDDY_HINT_PROMPT_TOO_LONG
    case 'model_blocked':
      return WORKBUDDY_HINT_MODEL_BLOCKED
    default:
      // 未覆盖形态（无 code / 5xx / 11101 参数错 / 审核 / WAF …）→ 空串，透出不带字段。
      return ''
  }
}

/** 已解析的 SSE 错误帧 → gateway_hint（空串 = 不带字段）。 */
function buildWorkbuddyFrameGatewayHint(frame: Record<string, unknown>): string {
  const err = frame['error']
  const message = errorMessageOf(err !== undefined && err !== null ? err : frame)
  return buildWorkbuddyGatewayHint(gatewayHintCodeText(frame), message)
}

/**
 * 把 `gateway_hint` 并列附加到**已脱敏**的错误帧 JSON 上（对齐 workbuddy2api sse.go
 * `attachHintToErrorFrame`）。
 *
 * 契约：
 *  - hint 为空串 → **原样返回 payload（零改写）**；
 *  - payload 非 JSON / 非对象 → 原样返回；
 *  - 帧内**无 error 对象**（error 为 null / 字符串 / 数组等非对象形态）→ 原样返回
 *    （宁可不加 hint，也不把 error 信封改形状、更不往顶层塞字段）；
 *  - 有 error 对象 → 只**新增** `error.gateway_hint` 一个键，`message` / `code` /
 *    `requestId` 等既有键逐字保留（JSON 键序变化是重序列化的固有结果，键与值不变）。
 */
export function attachWorkbuddyGatewayHint(payload: string, hint: string): string {
  if (!hint) return payload
  let frame: unknown
  try {
    frame = JSON.parse(payload)
  } catch {
    return payload
  }
  if (!isObj(frame)) return payload
  const err = frame['error']
  if (!isObj(err)) return payload
  err['gateway_hint'] = hint
  try {
    return JSON.stringify(frame)
  } catch {
    return payload
  }
}

/**
 * 处理一条 `data: ` 负载（对齐 workbuddy2api Stream 的 writeFrame）：
 *  0. **上游错误帧**（顶层带 `error`）→ 脱敏后**原样透传**（不参与白名单重建）；
 *  1. JSON 解析失败 → 原样返回（`valid: false`，不计入有效帧）；
 *  2. 非 delta 的 `message` 帧补出等价 `delta`（11b75d4 + 6701631）；
 *  3. 缺 `index` 的 tool_call 分派并写回 index（5c2db2f）；
 *  4. 回填 tool_calls name；
 *  5. **首帧 id 续传**：首个非空 id 缓存为 firstId；后续帧 id 缺失/空 → 用 firstId；
 *     已有自己 id 的帧保持原样（不同流分裂的帧允许各自 id）；
 *  6. 白名单重建后序列化。
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

  // 处理顺序有依赖（移植 11b75d4 + 5c2db2f）：
  //  1. 非 delta 的完整 message 先补出等价 delta（否则正文/工具调用被白名单整体丢弃）；
  //  2. 给缺 index 的 tool_call 分派并写回 index（客户端按 index 聚合，槽位必须可见）；
  //  3. 再按（分派后的）index 回填 function.name。
  const hoisted = hoistMessageToDelta(frame, state)
  dispatchToolCallIndexes(frame, state)
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
        // 只有「真正的 delta 正文」才置位：message 快照提升出来的 delta 会走
        // hoistMessageToDelta 自己的 messageSnapshot 去重，不能反过来把后续
        // 快照增长量也挡掉（见 deltaContentSeen 注释）。
        if (!hoisted) state.deltaContentSeen = true
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
 * 有状态 WorkBuddy SSE 清洗器：既是逐行清洗函数，也持有**流级收尾**能力。
 *
 * 为什么带 `finishStream`：上游「200 + 0 有效帧」的空流必须在流结束时补一帧 error
 * （移植 workbuddy2api 0a86854），而逐行 cleanFn 只在有输入时被调用——收尾时机只有
 * 转发侧（passthroughResponse 的读取循环结束）知道，故由清洗器暴露收尾入口。
 */
export interface WorkbuddyChunkCleaner {
  /** 逐行清洗（passthroughResponse 的 cleanFn 契约）。 */
  (chunk: string): string
  /** 流结束时调用一次：返回需补写的尾部文本（'' = 无需补写）；重复调用幂等返回 ''。 */
  finishStream(): string
  /** 流级统计快照（观测/测试用）：有效帧数、是否已发合成终态帧、[DONE] 是否被扣留。 */
  frameStats(): { validFrames: number; terminated: boolean; doneWithheld: boolean }
}

/**
 * 创建一个**有状态**的 WorkBuddy SSE 行清洗器，供 passthroughResponse 的 cleanFn 使用。
 *
 * 与纯函数版 cleanWorkbuddyChunk 的差异：跨帧维护 firstId 与 toolCallNames，
 * 并在流式转发中执行推理退化监控、预算熔断、垃圾 reasoning 抑制与优雅截断。
 *
 * 行为：
 *  - 非 `data:` 行 / 空行 → 原样返回（保留 SSE 分隔语义）；
 *  - `[DONE]` → 已出现过有效帧时原样返回；**0 有效帧时扣留**，改由 finishStream
 *    补 error 帧 + [DONE]（防「200 + 空流」被客户端当正常收尾，移植 0a86854）；
 *  - **上游错误帧**（顶层带 `error`）→ 脱敏后原样写出，**不参与**白名单重建与噪声丢弃，
 *    并计入有效帧（对齐 workbuddy2api sse.go writeRaw 的 error-passthrough）；
 *  - 有效 data 帧 → 白名单重建与退化/预算防护；
 *  - 退化且未产出正文时 → 注入合成 finish_reason: "length" 截断帧并通知中止；
 *  - 重建后 `choices` 为空数组且无 `usage`（或 delta 被抑制为空的帧）→ 丢弃（纯噪声）。
 */
export function createWorkbuddyChunkCleaner(options?: WorkbuddyStreamOptions): WorkbuddyChunkCleaner {
  const state = newWorkbuddyStreamState(options)
  let finished = false

  /**
   * 流结束时调用一次：返回需要补写到客户端尾部的文本（'' = 无需补写）。
   * 两个职责（对齐 workbuddy2api StreamHint 的收尾段）：
   *  1. **空流兜底**（移植 0a86854）：全程 0 有效帧 → 补 error 帧（code=upstream_parse）
   *     + [DONE]。否则上游「200 + 空流」会被客户端当成正常收尾（假成功：既无内容也无错误）。
   *     HTTP 头早已发出（wire 仍是 200），只能靠帧内错误让客户端知道失败——
   *     与源实现「wire 仍 200，但日志/状态收敛到 upstream_parse」同语义。
   *  2. **补收尾**：若 [DONE] 曾因「当时 0 有效帧」被扣留，而其后又出现有效帧（畸形流：
   *     帧在 [DONE] 之后），补回一个 [DONE]，兑现源实现「恰好一个 [DONE]」的承诺。
   */
  const finishStream = (): string => {
    if (finished) return ''
    finished = true
    // 已发出护盾熔断合成终态帧（自带 [DONE]）→ 不再补写，避免出现两个 [DONE]
    if (state.terminated) return ''
    if (state.validFrames === 0) {
      return `data: ${WORKBUDDY_EMPTY_STREAM_FRAME}\n\ndata: [DONE]`
    }
    if (state.doneWithheld) return 'data: [DONE]'
    return ''
  }

  const clean = ((chunk: string): string => {
    const trimmed = chunk.trim()
    if (!trimmed) return chunk
    if (!trimmed.startsWith('data:')) return chunk
    const data = trimmed.slice(5).trim()
    if (!data) return chunk
    if (data === '[DONE]') {
      // [DONE] 的写出时机由本清洗器决定（对齐 workbuddy2api StreamHint：统一在流结束时
      // 保证恰好一个）。**0 有效帧时扣留**：上游「200 + 只有 [DONE]」的空流若原样透传，
      // 客户端会把它当正常收尾（假成功）；扣留后由 finishStream 补 error 帧 + [DONE]。
      if (state.validFrames === 0) {
        state.doneWithheld = true
        return ''
      }
      return chunk
    }

    const { payload, valid, isError, error } = processWorkbuddyFrame(data, state)
    if (!valid) return chunk
    // 有效帧计数（口径同源实现 writeFrame：JSON 解析成功即计，含错误帧；解析失败不计数）
    state.validFrames++

    // 上游错误帧：脱敏后原样透出。**必须先于**噪声判定与终态丢弃判定——
    // 错误帧没有 choices，会被下面的噪声逻辑当空帧丢掉；而它恰恰是客户端
    // 唯一能知道"为什么失败"的信息（6004 限流 / 审核 / 会话失效）。
    if (isError) {
      // 已发出合成终态帧（含 [DONE]）后不再追加，否则 [DONE] 之后还有帧属畸形流。
      // 但 state.lastError 已在 processWorkbuddyFrame 中记录，聚合路径仍能拿到。
      if (state.terminated) return ''
      // gateway_hint（移植 workbuddy2api sse.go StreamHint 的 writeRaw 段）：上游 error 帧
      // 透出前并列附加 error.gateway_hint；message/code/requestId 原文不动。
      // hint 为空 / 非 JSON / 无 error 对象 → 逐字节原样透出（零改写）。
      const hinted = error?.hint ? attachWorkbuddyGatewayHint(payload, error.hint) : payload
      return `data: ${hinted}`
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
  }) as WorkbuddyChunkCleaner
  clean.finishStream = finishStream
  clean.frameStats = () => ({ validFrames: state.validFrames, terminated: state.terminated, doneWithheld: state.doneWithheld })
  return clean
}

