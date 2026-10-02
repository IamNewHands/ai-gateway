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
  tools?: unknown
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
  for (const m of messages) {
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
