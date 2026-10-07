/**
 * body.ts — 构建 QoderWork agent_chat_generation 请求体（移植自 cpa-plugin/qoderwork/body.go）。
 * baseprompt.json 为请求模板，每次请求覆盖 id / 模型 key / 用户 prompt / 会话记录。
 */

import basepromptJson from './baseprompt.json'

/** 上游模型 key 映射（cpaToUpstreamKey）。未知名称原样透传（上游静默路由到 auto）。 */
const MODEL_KEY_MAP: Record<string, string> = {
  'qoder-auto': 'auto',
  'auto': 'auto',
  'qwen3.8-max-preview': 'qmodel_preview',
  'qwen3.8-max': 'qmodel_preview',
  'qmodel_preview': 'qmodel_preview',
  'qwen3.7-max': 'qmodel_latest',
  'qmodel_latest': 'qmodel_latest',
  'qwen3.7-plus': 'qmodel',
  'qmodel': 'qmodel',
  'qwen3.6-flash': 'q36fmodel',
  'q36fmodel': 'q36fmodel',
  'deepseek-v4-pro': 'dmodel',
  'dmodel': 'dmodel',
  'deepseek-v4-flash': 'dfmodel',
  'dfmodel': 'dfmodel',
  'glm-5.2': 'gm51model',
  'gm51model': 'gm51model',
  'kimi-k2.7-code': 'kmodel',
  'kmodel': 'kmodel',
  'minimax-m2.7': 'mmodel',
  'mmodel': 'mmodel',
}

export function cpaToUpstreamKey(model: string): string {
  return MODEL_KEY_MAP[model] || model
}

/**
 * 客户端模型家族关键字 → 上游合法 SKU 的兜底映射（移植 qoder2api internal/bridge/bridge.go:575-583
 * `defaultModelMapping` 的设计原则：默认表只负责让请求落到合法 SKU 不出错，不做分档）。
 *
 * 为什么需要：客户端（Claude Code / Cline / Roo 等）传的是自己的模型名（`claude-sonnet-4-6`、
 * `gpt-5`），上游不认识。原实现原样透传 → 上游静默路由到 auto，**这次调用不计入 quota**
 * （源 bridge.go:316-317 明确记载这是「请求成功但 dashboard 无用量」的根因）。
 *
 * 兜底值取 `auto`：它是两个实现共同承认的合法 SKU，且源在 f4fe47f 已把默认档定为 auto。
 * 不在这里做 Claude/GPT 分档——目标 SKU 词汇表与源（qmodel_38max/gmodel/qfmodel）不同，
 * 分档属产品决策，需实测后再定（见移植分析 P1-5）。
 *
 * 注意**只匹配家族关键字**，不做全量白名单：模型列表接口返回的新 key 必须能原样透传，
 * 否则上游新增模型会在网关侧被强制降级成 auto。
 */
const CLIENT_FAMILY_KEYWORDS = ['claude', 'sonnet', 'opus', 'haiku', 'gpt', 'gemini', 'o1-', 'o3-', 'o4-']

/** 未知模型名 → 兜底 SKU；命中家族关键字返回 'auto'，否则原样返回。 */
export function fallbackUnknownModel(model: string): string {
  const low = model.toLowerCase()
  for (const kw of CLIENT_FAMILY_KEYWORDS) {
    if (low.includes(kw)) return 'auto'
  }
  return model
}

export interface ChatMessage {
  role: string
  content: unknown
  /** assistant 发起的工具调用（OpenAI 形态）。丢掉它，后续 tool 结果就失去配对。 */
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>
  /** tool 消息对应的调用 id（与 assistant.tool_calls[].id 配对）。 */
  tool_call_id?: string
  name?: string
}

/** 模型列表的场景桶优先级（qoder2api internal/bridge/bridge.go:195-206 parseQoderModels）。 */
export const QODER_MODEL_CATEGORIES = ['assistant', 'developer', 'chat'] as const

export interface QoderModelPick {
  /** 启用的模型 key；失败时为空数组 */
  models: Array<{ id: string }>
  /** 命中的场景桶名（失败时为空串） */
  category: string
  /** 各桶条目数，供诊断（区分「没有模型」与「模型都被禁用」） */
  counts: Record<string, number>
  /** 失败原因；成功为 '' */
  error: string
}

/**
 * 从 model/list 响应中挑出启用的模型。
 *
 * 上游把模型按场景分桶，**不是所有桶都有内容**：只读 `chat` 会在某些区域/账号下
 * 拿到空列表或明显偏少的模型。按 assistant → developer → chat 取第一个非空桶。
 *
 * 失败时区分两种情形（都不谎报成功）：
 *   - 完全没有已知场景桶 → 报出实际 keys；
 *   - 桶存在但全部 enable=false → 报出桶名与条目数。
 */
export function pickQoderModels(json: unknown): QoderModelPick {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const counts: Record<string, number> = {}
  let picked: any[] | null = null
  let category = ''
  for (const cat of QODER_MODEL_CATEGORIES) {
    const arr = Array.isArray(obj[cat]) ? (obj[cat] as any[]) : null
    counts[cat] = arr ? arr.length : 0
    if (arr && arr.length > 0 && !picked) {
      picked = arr
      category = cat
    }
  }
  if (!picked) {
    return {
      models: [],
      category: '',
      counts,
      error: `响应缺少模型场景，keys=${Object.keys(obj).join(',') || '(empty)'}`,
    }
  }
  const models = picked
    .filter((m: any) => m && m.enable === true && m.key)
    .map((m: any) => ({ id: String(m.key) }))
  if (models.length === 0) {
    return {
      models: [],
      category,
      counts,
      error: `场景 ${category} 的 ${picked.length} 个模型均未启用（enable=false）`,
    }
  }
  return { models, category, counts, error: '' }
}

/** 取最后一条 user 消息的文本内容。content 为数组时提取第一段 text。 */
export function extractLatestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          const text = (part as { text?: unknown }).text
          if (typeof text === 'string') return text
        }
      }
    }
  }
  return ''
}

function deepClone(obj: unknown): any {
  return JSON.parse(JSON.stringify(obj))
}

// ===== 工具历史结构化直传（hub qoder_proxy.py task-32 / v1.2.6 563346c） =====

/** 结构化工具历史开关：`on` 强制、`off` 关闭、`auto`（默认）按 id 齐备度自动判定。 */
export type QoderStructuredToolMode = 'on' | 'off' | 'auto'

/**
 * 从环境读开关（`QODER_STRUCTURED_TOOL_HISTORY`，缺省 auto）。
 *
 * 参数类型全为可选，故 `Env` 可直接传入（TS 结构化类型），不必往 Env 上加字段。
 */
export function qoderStructuredToolMode(env?: { QODER_STRUCTURED_TOOL_HISTORY?: string }): QoderStructuredToolMode {
  const raw = String(env?.QODER_STRUCTURED_TOOL_HISTORY || '').trim().toLowerCase()
  if (!raw || raw === 'auto') return 'auto'
  if (['1', 'on', 'true', 'yes', 'enable', 'enabled', 'force'].includes(raw)) return 'on'
  if (['0', 'off', 'false', 'no', 'disable', 'disabled'].includes(raw)) return 'off'
  return 'auto'
}

/**
 * 工具历史的 id 是否齐备——**结构化直传的硬前提**。
 *
 * 上游对「role:tool 但配不上前一条 assistant.tool_calls」是直接拒绝的，实测原文：
 * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
 * 故只要有一条 tool 缺 `tool_call_id`、或某个 `tool_calls` 条目缺 `id`，就不能走结构化
 * （hub `_tool_ids_ok` 同口径：**任何模式下** id 不齐备都回退，宁可不发畸形请求）。
 */
export function qoderToolIdsComplete(messages: readonly ChatMessage[]): boolean {
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'tool') {
      if (!String(m.tool_call_id || '').trim()) return false
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        if (!tc || typeof tc !== 'object' || !String(tc.id || '').trim()) return false
      }
    }
  }
  return true
}

/**
 * 本次请求是否走结构化工具历史。
 *
 * - `off` → 恒 false（一键回退，出问题不用改代码）；
 * - `on`  → 强制（id 仍须齐备）；
 * - `auto`（默认）→ 仅在**确实存在工具历史**且 id 齐备时启用；纯对话请求形态不变
 *   （不改变无工具请求的任何行为）。
 *
 * 注：hub 的 auto 另有一条「仅 CN + provider 白名单」限制，理由是 task-31 只在
 * Qwen/GLM 上验过、DeepSeek/Kimi 待补验。本模块的模型 key 是 Qoder 自家 SKU
 * （qmodel/dmodel/gm51model…），无法与 hub 的白名单直接对齐，故不照搬该限制——
 * 改由 env 开关兜底（`off` 可一键回退）。
 */
export function useQoderStructuredToolHistory(
  messages: readonly ChatMessage[],
  mode: QoderStructuredToolMode = 'auto'
): boolean {
  if (mode === 'off') return false
  if (!qoderToolIdsComplete(messages)) return false
  if (mode === 'on') return true
  return messages.some(
    (m) =>
      !!m &&
      typeof m === 'object' &&
      (m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0))
  )
}

/**
 * tool 结果正文取字符串形态。
 *
 * tool 的 content 在 OpenAI 规范里就是字符串；这里额外兼容数组形态（Claude 风格的
 * content block），只取 text 部分，避免把结构化 block 原样丢给上游。
 */
function qoderToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content) {
      if (typeof p === 'string') {
        parts.push(p)
        continue
      }
      if (p && typeof p === 'object') {
        const t = (p as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join('\n')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

/**
 * assistant.tool_calls 归一为 OpenAI 规范形态（id / type / function.{name,arguments}）。
 *
 * `arguments` 统一成 **JSON 字符串**：dict/数组会被两侧的转换层按字符串处理，
 * 字符串最稳（hub task-32 同口径）。返回 null = 没有可用的 tool_calls。
 */
function qoderNormalizeToolCalls(raw: unknown): any[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: any[] = []
  for (const tc of raw) {
    if (!tc || typeof tc !== 'object') return null
    const t = tc as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const fn = t.function && typeof t.function === 'object' ? t.function : {}
    let args = fn.arguments
    if (args && typeof args === 'object') args = JSON.stringify(args)
    else if (typeof args !== 'string') args = args === null || args === undefined ? '' : String(args)
    out.push({
      id: String(t.id || ''),
      type: typeof t.type === 'string' && t.type ? t.type : 'function',
      function: { name: String(fn.name || ''), arguments: args },
    })
  }
  return out
}

/**
 * buildQoderBody 渲染上游请求体 JSON 字符串。
 * @param messages OpenAI 格式消息
 * @param modelKey 上游模型 key（已通过 cpaToUpstreamKey 映射）
 * @param userType aliyun_user_type，默认 personal_professional_trial
 * @param tools 客户端 tools 定义；传入时**覆盖**模板内置的 14 个 Qoder CLI 工具
 */
export function buildQoderBody(
  messages: ChatMessage[],
  modelKey: string,
  userType = 'personal_professional_trial',
  tools?: unknown,
  structuredToolHistory?: boolean
): string {
  const base = deepClone(basepromptJson)
  const prompt = extractLatestUserPrompt(messages)

  const nid = crypto.randomUUID()
  base.request_id = nid
  base.chat_record_id = nid
  base.request_set_id = crypto.randomUUID()
  base.session_id = crypto.randomUUID()
  base.stream = true
  base.aliyun_user_type = userType
  base.agent_id = 'agent_common'

  if (base.model_config && typeof base.model_config === 'object') {
    base.model_config.key = modelKey
  }

  if (base.chat_context && typeof base.chat_context === 'object') {
    const cc = base.chat_context
    if (cc.text && typeof cc.text === 'object') cc.text.text = prompt
    if (cc.extra && typeof cc.extra === 'object') {
      if (cc.extra.originalContent && typeof cc.extra.originalContent === 'object') {
        cc.extra.originalContent.text = prompt
      }
      if (cc.extra.modelConfig && typeof cc.extra.modelConfig === 'object') {
        cc.extra.modelConfig.key = modelKey
      }
    }
  }

  // messages：保留模板中的 system 提示词，追加真实对话
  const systemMsgs: any[] = (Array.isArray(base.messages) ? base.messages : [])
    .filter((m: any) => m && m.role === 'system')
  const structured = structuredToolHistory === true
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (structured) {
      // ===== 结构化直传（hub qoder_proxy.py flatten_messages structured 分支）=====
      // 旧实现无条件只发 {role, content}：`role:'tool'` 丢掉 tool_call_id（上游判为
      // 「配不上前一条 tool_calls」→ 直接拒绝）、assistant 丢掉 tool_calls（模型看不到
      // 自己发起过什么调用）。多轮工具会话因此被截断成孤立文本。
      if (m.role === 'tool') {
        // content 恒为空字符串而非 null：hub task-31 实测 null 会让上游转换层丢掉
        // 配对的 assistant 消息，DeepSeek/Kimi 直接 provider_error。
        systemMsgs.push({
          role: 'tool',
          tool_call_id: String(m.tool_call_id || ''),
          content: qoderToolResultText(m.content),
        })
        continue
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const calls = qoderNormalizeToolCalls(m.tool_calls)
        if (calls) {
          systemMsgs.push({ role: 'assistant', content: qoderToolResultText(m.content), tool_calls: calls })
          continue
        }
      }
    }
    systemMsgs.push({ role: m.role, content: m.content })
  }
  base.messages = systemMsgs

  // 客户端 tools 覆盖模板内置工具（移植 qoder2api internal/bridge/bridge.go:388-391
  // `body["tools"] = tools`）。不覆盖时上游永远只看到模板里那 14 个 Qoder CLI 工具，
  // 客户端（Claude Code / Cline 等）声明的工具名对模型不可见 → 工具调用指向错误工具。
  // 只认数组且非空：空数组会让上游按「无工具」处理，与客户端「未声明工具」语义一致，
  // 故同样覆盖（显式无工具 ≠ 偷偷塞 14 个工具）。
  if (Array.isArray(tools)) base.tools = deepClone(tools)

  if (base.business && typeof base.business === 'object') {
    base.business.id = crypto.randomUUID()
    base.business.begin_at = Date.now()
    base.business.name = prompt.slice(0, 30)
  }

  return JSON.stringify(base)
}
