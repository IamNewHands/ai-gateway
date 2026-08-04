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
 */
export function buildQoderBody(messages: ChatMessage[], modelKey: string, userType = 'personal_professional_trial'): string {
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

  if (base.business && typeof base.business === 'object') {
    base.business.id = crypto.randomUUID()
    base.business.begin_at = Date.now()
    base.business.name = prompt.slice(0, 30)
  }

  return JSON.stringify(base)
}
