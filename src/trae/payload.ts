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
 */
import { TRAE_CONSTANTS, TRAE_DEFAULT_MODEL } from './constants'

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
function normalizeToolChoice(obj: Record<string, any>): void {
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
function normalizeTools(obj: Record<string, any>): void {
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
