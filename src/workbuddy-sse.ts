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

/** 帧重建的跨帧状态（一条 SSE 流一个实例）。 */
export interface WorkbuddyStreamState {
  /** 首帧的真实 id（后续帧缺失/空时续用）；全流无真实 id 才出现哨兵。 */
  firstId: string
  /** tool_calls index → function.name 缓存（跨帧回填被上游清空的 name）。 */
  toolCallNames: Map<number, string>
}

/** 新建一条流的跨帧状态。 */
export function newWorkbuddyStreamState(): WorkbuddyStreamState {
  return { firstId: '', toolCallNames: new Map() }
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

  backfillToolCallNames(frame, state.toolCallNames)

  // 首帧 id 透传与哨兵兜底
  const rawId = frame['id']
  if (state.firstId === '') {
    if (typeof rawId === 'string' && rawId !== '') state.firstId = rawId
  } else if (typeof rawId !== 'string' || rawId === '') {
    frame['id'] = state.firstId
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
 * 因此必须按流创建实例（不能复用同一函数引用跨请求）。
 *
 * 行为：
 *  - 非 `data:` 行 / 空行 → 原样返回（保留 SSE 分隔语义）；
 *  - `[DONE]` → 原样返回（由上层保证只写一次）；
 *  - 有效 data 帧 → 白名单重建；
 *  - 重建后 `choices` 为空数组且无 `usage` → 丢弃该帧（纯噪声）。
 */
export function createWorkbuddyChunkCleaner(): (chunk: string) => string {
  const state = newWorkbuddyStreamState()
  return (chunk: string): string => {
    const trimmed = chunk.trim()
    if (!trimmed) return chunk
    if (!trimmed.startsWith('data:')) return chunk
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return chunk

    const { payload, valid } = processWorkbuddyFrame(data, state)
    if (!valid) return chunk

    // 噪声帧丢弃：choices 为空且无 usage（上游偶发的空占位帧）
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>
      const chs = obj['choices']
      if (Array.isArray(chs) && chs.length === 0 && (obj['usage'] === null || obj['usage'] === undefined)) {
        return ''
      }
    } catch { /* 保持原 payload */ }

    return `data: ${payload}`
  }
}
