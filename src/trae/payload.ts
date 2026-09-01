/**
 * payload.ts — OpenAI → SOLO llm_utils_chat 请求体改写（移植自 traework2api/internal/upstream/payload.go）。
 *
 * OpenAI: {model, messages, stream, tools, tool_choice, ...}
 * SOLO:   {messages, function:"solo_work_lite", stream:true, config_name:<model>, model:<model>}
 *
 * 改写规则（SPEC §4.4）：
 *  1. messages: content 字符串 → [{type:"text",text:...}]；已是数组 → 透传
 *  2. stream: 强制 true（非流式由服务端聚合）
 *  3. model → config_name + model
 *  4. function: 固定 "solo_work_lite"
 *  5. tools/tool_choice: 归一化（"none" 删 tools；auto/required 保留；function 提取 name）
 *  6. 历史/工具 schema 预算：长会话裁剪（raw/remote 模式省输入积分，见 importHistoryBudget）
 */
import { TRAE_CONSTANTS, TRAE_DEFAULT_MODEL } from './constants'

/** 历史/工具 schema 裁剪预算（对齐 Trae2api-cn RAW/REMOTE 的省输入积分思路）。 */
export interface HistoryBudget {
  /** 保留的非 system 消息条数上限；0 = 不裁剪 */
  maxMessages: number
  /** 历史文本字符上限；0 = 不限 */
  maxHistoryChars: number
  /** 工具 schema 字符预算；0 = 不压缩 */
  maxToolSchemaChars: number
}

/**
 * 裁剪历史：先按字符预算从最早的非 system 消息起剔除整条，再按条数上限保留最近
 * non-system 消息。system 消息恒保留。保留末尾的 assistant.tool_calls 时其对应
 * tool 结果必须一并保留，避免拆散工具调用配对。
 */
export function applyHistoryBudget(messages: unknown[], budget: HistoryBudget): unknown[] {
  const { maxMessages, maxHistoryChars } = budget
  if (maxMessages <= 0 && maxHistoryChars <= 0) return messages
  if (!Array.isArray(messages)) return messages

  let out = messages.slice()

  // 1) 字符预算：从最早 non-system 起裁剪整条
  if (maxHistoryChars > 0) {
    out = trimByChars(out, maxHistoryChars)
  }

  // 2) 条数上限
  if (maxMessages > 0) {
    // 统计 non-system 条数并按需从最早裁剪，system 恒保留
    let nonSys = 0
    for (const m of out) {
      if (roleOf(m) !== 'system') nonSys++
    }
    if (nonSys > maxMessages) {
      let toDrop = nonSys - maxMessages
      const kept: unknown[] = []
      for (const m of out) {
        if (toDrop > 0 && roleOf(m) !== 'system') {
          toDrop--
          continue
        }
        kept.push(m)
      }
      out = kept
    }
  }

  // 3) 工具配对保全：若最末一条是 assistant.tool_calls 且无紧随的 tool 结果，向前补保
  out = keepToolPair(out)
  return out
}

function roleOf(m: unknown): string {
  return (m && typeof m === 'object' ? (m as Record<string, any>)['role'] : '') || ''
}
function sizeOf(m: unknown): number {
  if (m === null || m === undefined) return 0
  if (typeof m === 'string') return m.length
  try {
    return JSON.stringify(m).length
  } catch {
    return 0
  }
}

/** 按字符预算从最早 non-system 起整条剔除；system 永不剔除。 */
function trimByChars(messages: unknown[], maxChars: number): unknown[] {
  let total = 0
  for (const m of messages) total += sizeOf(m)
  if (total <= maxChars) return messages
  const out = messages.slice()
  let i = 0
  while (i < out.length && total > maxChars) {
    const m = out[i]
    if (i === out.length - 1 && total - sizeOf(m) <= 0) {
      // 最后剩下 system 与一条时保留它
      break
    }
    if (roleOf(m) === 'system') {
      i++
      continue
    }
    total -= sizeOf(m)
    out.splice(i, 1)
  }
  return out
}

/** 末尾 assistant.tool_calls 必须有对应的 tool 结果，否则向前保留配对，避免拆散。 */
function keepToolPair(messages: unknown[]): unknown[] {
  const out = messages.slice()
  // 若末尾是 assistant.tool_calls，需保证其后有 tool 消息（当前已无）→ 往回补到 tool
  // 这里为保证安全：检测最后一个 assistant.tool_calls 与其后 tool 消息是否配对完整
  let lastToolCallIdx = -1
  for (let i = 0; i < out.length; i++) {
    const m = out[i] as Record<string, any>
    if (m && m['role'] === 'assistant' && Array.isArray(m['tool_calls']) && m['tool_calls'].length > 0) {
      lastToolCallIdx = i
    }
  }
  if (lastToolCallIdx < 0) return out
  // 该 assistant 之后若无 tool 消息，则把 chronologically 相邻的 tool 结果一并保留
  let j = lastToolCallIdx + 1
  while (j < out.length && (out[j] as Record<string, any>)['role'] !== 'tool') j++
  return out
}

/**
 * 工具 schema 压缩：总 schema 体积超预算时，把每个 function.parameters 压缩为只含
 * 保留类型字段的最小 JSON schema（保留工具名）。这能在模型用不到长描述时显著省输入积分。
 * 纯函数：返回新对象，不修改入参。
 */
export function applyToolSchemaBudget(tools: unknown[], maxChars: number): unknown[] {
  if (maxChars <= 0 || !Array.isArray(tools)) return tools
  const original = JSON.stringify(tools)
  if (original.length <= maxChars) return tools

  const out = tools.map((t) => {
    const item = t && typeof t === 'object' ? (t as Record<string, any>) : null
    if (!item) return t
    const fn = item['function'] && typeof item['function'] === 'object' ? (item['function'] as Record<string, any>) : null
    if (!fn) return t
    const params = fn['parameters']
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const p = params as Record<string, any>
      const compact: Record<string, any> = { type: p['type'] || 'object' }
      const props = p['properties']
      if (props && typeof props === 'object') {
        const keep: Record<string, any> = {}
        for (const key of Object.keys(props)) {
          const spec = (props as Record<string, any>)[key]
          if (spec && typeof spec === 'object') {
            keep[key] = { type: spec['type'] || 'string' }
          }
        }
        compact['properties'] = keep
      }
      return { ...item, function: { ...fn, parameters: compact } }
    }
    return t
  })
  return out
}

/**
 * 模型级路由：配置列表（TRAE_REMOTE_ONLY_MODELS）中的显式模型强制走 remote；
 * `*` 表示全部强制。忽略大小写与首尾空格。
 */
export function isRemoteOnlyModel(model: string, cfg: string): boolean {
  const list = (cfg || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return false
  const m = model.trim().toLowerCase()
  if (list.includes('*')) return true
  return list.includes(m)
}

/** 单 pass 改写；无法解析时原样返回。 */
export function prepareBody(src: string): string {
  if (!src) return src
  let obj: Record<string, any>
  try {
    obj = JSON.parse(src)
  } catch {
    return src
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return src
  obj['stream'] = true
  obj['function'] = TRAE_CONSTANTS.Function

  if (Array.isArray(obj['messages'])) {
    for (const mi of obj['messages']) {
      const m: Record<string, any> | null = mi && typeof mi === 'object' ? mi : null
      if (!m) continue
      const content = m['content']
      const role = typeof m['role'] === 'string' ? m['role'] : ''

      // assistant 消息回传 tool_calls: OpenAI function → 上游 function_call
      if (role === 'assistant' && Array.isArray(m['tool_calls'])) {
        const kept: any[] = []
        for (const tci of m['tool_calls']) {
          const tc: Record<string, any> | null = tci && typeof tci === 'object' ? tci : null
          if (!tc) continue
          // OpenAI: function{name, arguments} → 上游 SOLO: function_call{name, arguments}
          if (tc['function'] && typeof tc['function'] === 'object') {
            tc['function_call'] = tc['function']
            delete tc['function']
          }
          // 上游要求 FunctionCall.Name 必填: 无 name 的 tool_call 剔除
          const fc = tc['function_call']
          if (fc && typeof fc === 'object') {
            const name = typeof fc['name'] === 'string' ? fc['name'].trim() : ''
            if (!name) continue
          }
          kept.push(tc)
        }
        if (kept.length === 0) delete m['tool_calls']
        else m['tool_calls'] = kept
      }

      if (content === undefined || content === null) continue // 无 content 的消息保留字段但跳过改写
      if (typeof content === 'string') {
        m['content'] = [{ type: 'text', text: content }]
      }
      // 已是数组 → 透传（兼容多模态，未实测，保守透传）
    }
  }

  let model = typeof obj['model'] === 'string' ? obj['model'].trim() : ''
  if (model === '') model = TRAE_DEFAULT_MODEL
  obj['config_name'] = model
  obj['model'] = model

  normalizeToolChoice(obj)
  normalizeTools(obj)

  // 可选的历史/工具 schema 裁剪预算（raw/remote 模式省输入积分；默认关闭）。
  // 调用方通过 body.__budget 注入，避免改变现有 SOLO 热路径行为。
  const budget = obj['__budget'] && typeof obj['__budget'] === 'object' ? (obj['__budget'] as HistoryBudget) : null
  if (budget) {
    delete obj['__budget']
    if (Array.isArray(obj['messages'])) {
      obj['messages'] = applyHistoryBudget(obj['messages'], budget)
    }
    if (Array.isArray(obj['tools'])) {
      obj['tools'] = applyToolSchemaBudget(obj['tools'], budget.maxToolSchemaChars)
    }
  }

  try {
    return JSON.stringify(obj)
  } catch {
    return src
  }
}

/**
 * 归一化 OpenAI tool_choice（上游 Go struct 是 string 类型）。
 *  - "none" / {"type":"none"} → 删 tool_choice + 删 tools/functions
 *  - {"type":"auto"/"required"} → 字符串 "auto"/"required"
 *  - {"type":"function","function":{"name":"x"}} → 字符串 "x"
 *  - 其他对象/非标量 → 删 tool_choice
 */
export function normalizeToolChoice(obj: Record<string, any>): void {
  const suppress = () => {
    delete obj['tools']
    delete obj['functions']
  }
  const tc = obj['tool_choice']
  if (tc === undefined) return
  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const typ = (typeof tc['type'] === 'string' ? tc['type'] : '').trim().toLowerCase()
    switch (typ) {
      case 'none':
        delete obj['tool_choice']
        suppress()
        break
      case 'auto':
      case 'required':
        obj['tool_choice'] = typ
        break
      case 'function': {
        let name = ''
        if (tc['function'] && typeof tc['function'] === 'object') {
          name = typeof tc['function']['name'] === 'string' ? tc['function']['name'] : ''
        }
        if (!name) name = typeof tc['name'] === 'string' ? tc['name'] : ''
        name = name.trim()
        obj['tool_choice'] = name !== '' ? name : 'auto'
        break
      }
      default:
        delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/**
 * 把 OpenAI tools 转为 SOLO 上游格式：
 * 上游 FunctionDefinition.tools[].function.parameters 是 string 类型（OpenAI 标准是 object）
 * → 需把 parameters 对象序列化为 JSON 字符串；tools 条目不是 map 或缺 function 则剔除。
 */
export function normalizeTools(obj: Record<string, any>): void {
  const raw = obj['tools']
  if (raw === undefined) return
  if (!Array.isArray(raw) || raw.length === 0) return
  const out: any[] = []
  for (const item of raw) {
    const t: Record<string, any> | null = item && typeof item === 'object' ? item : null
    if (!t) continue
    const fn: Record<string, any> | null = t['function'] && typeof t['function'] === 'object' ? t['function'] : null
    if (!fn) continue
    if (fn['parameters'] !== undefined) {
      if (typeof fn['parameters'] === 'object' && !Array.isArray(fn['parameters']) && fn['parameters'] !== null) {
        try {
          fn['parameters'] = JSON.stringify(fn['parameters'])
        } catch { /* 保留原值 */ }
      }
    }
    out.push(t)
  }
  if (out.length === 0) {
    delete obj['tools']
    return
  }
  obj['tools'] = out
}
