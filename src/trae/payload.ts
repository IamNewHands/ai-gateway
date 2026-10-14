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

// ===== Remote 传输的 query 扁平化（移植自 Trae2api-cn `flatten_query`） =====

/**
 * 源侧 `cli_client.renderer_block_text`：Trae 桌面渲染器把文本放在 `value` 而不是
 * `text`/`content`（`{type:"text",value:…}`、`{type:"tool_result",value:[…]}`），
 * 不取 `value` 这些块会被读成空串。
 *
 * 与 `remote-messages.ts` 里同名的那份**故意各留一份**：那边跟的是源侧
 * `raw_client._content_to_text`（图片块会产出 `[Unsupported image_url input omitted]`），
 * 这边跟的是源侧 `trae_client._content_to_text`（图片块塌成空串）。共用一个 helper
 * 会把源侧本来就分叉的两套语义重新绑死。
 */
function rendererBlockText(block: Record<string, any>): string {
  const value = block['value']
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item)
        continue
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const nested = item as Record<string, any>
        // 源侧 `item.get("text") or item.get("content") or item.get("value")`：取第一个真值。
        const text = nested['text'] || nested['content'] || nested['value']
        if (typeof text === 'string') parts.push(text)
      }
    }
    // 源侧 `"\n".join(part for part in parts if part)`：空串不参与拼接。
    return parts.filter(Boolean).join('\n')
  }
  return ''
}

/**
 * 把 content 归一化成纯文本（源侧 `trae_client._content_to_text` + `cli_client.renderer_block_text`）。
 *
 * Remote 端点的 `query` 是**一个扁平字符串**（不是结构化消息数组），所以多模态 / 内容块
 * 必须先降级成文本。推理类块（`reasoning`/`thinking`）刻意丢弃——那是上一轮模型的思考链，
 * 回灌给上游既费 token 又会诱导它复述。**这条是本仓库对源侧的有意分歧**：源侧那份
 * `_content_to_text` 没有 reasoning 概念，会把思考文本一起拼进去（回归用例见
 * `remote.test.ts` 的「数组 content 里的 reasoning 块被丢弃」）。
 *
 * ## 图片：源侧不发，但**协议支持**（2026-10-15 抓到官方 web 客户端请求体后更正）
 *
 * 上一版这里写的是「源侧不支持图片」——那是**推论错误**。源侧客户端不发图片 ≠ 协议不能带图。
 *
 * 官方 web 客户端（`work.trae.cn` 的 `POST /api/remote/v1/chat_sessions`）真实下发的
 * `query` 是**一个 JSON 块数组的字符串**，图片走独立的 `attachment` 块：
 *
 * ```json
 * [{"type":"text","data":{"content":"描述下图片"}},
 *  {"type":"attachment","data":{"uri":"trae-res://remote_resource/tos-cn-i-aiagcest/cn/<uid>/remote_resource/<uuid>.trae",
 *                               "filename":"PixPin_2026-10-14_14-16-32.png"}}]
 * ```
 *
 * 由此确定三件事：
 *  1. **格式家族与我们一致**（都是 `[{type,data}]` 的 JSON 字符串），差别只在官方按消息
 *     分多个 `text` 块，而我们（照源侧 `flatten_query`）把整段对话压成**一个** `text` 块；
 *  2. 附件是独立的 `attachment` 块，`uri` 指向 Trae 自己的资源存储（火山 TOS），
 *     **不是** data URI —— 说明本地文件必须先经一个**上传 / 预签名**步骤换成 `trae-res://`；
 *  3. `custom_model.multimodal: true` 确认该模型声明支持图片（该字段我们已解析但未使用，
 *     见 `remote.ts` 的 `buildRemoteModelConfig`）。
 *
 * 那个上传端点曾经「源侧与本仓库都还没有」（源侧 `flatten_query` 只产 `text` 块）。
 * 2026-10-15 已补齐，落在 `resource-upload.ts`：① `POST {IDE}/get_resource_upload_url`
 * 拿上传位 → ② `PUT https://{upload_host}/{store_uri}` 传字节 → ③ 拼出 `trae-res://…`。
 * 本文件只负责**引用**它（`flattenTraeQuery` 的 `attachments` 选项），不做上传。
 *
 * 门禁是 `custom_model.multimodal`（`remote.ts` 的 `buildRemoteModelConfig` 解析）。
 * 模型不识图时图片仍然只能走面板的识图桥（`vision/bridge.ts`）转写成文本 —— 那是**有损的
 * 权宜之计**，不是终态；`multimodal: true` 时走真正的 `attachment` 块。
 *
 * 源侧另有一份同名的 `raw_client._content_to_text` 会产出
 * `[Unsupported image_url input omitted]`，但**那条路径不经过 Remote 的 flatten**
 *（它只被 `_remote_client_tool_task_anchor` 用，见 `remote-messages.ts`）——
 * 两份同名函数在源侧就是分叉的，别拿另一份的结论套这一份。
 */
function contentToText(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (typeof c === 'string') {
        parts.push(c)
        continue
      }
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const block = c as Record<string, any>
        const type = String(block['type'] || '').toLowerCase()
        if (type === 'reasoning' || type === 'thinking' || type === 'reasoning_text') continue
        // 源侧 `c.get("text") or c.get("content")`；两者都空才回落到 renderer 的 `value`。
        const direct = block['text'] || block['content']
        const text =
          direct === null || direct === undefined || direct === ''
            ? rendererBlockText(block)
            : direct
        // 源侧 `parts.append(text or "")`：取不到文本的块（图片就是这一类）也占一个空元素，
        // 因此 join 出来会多一个换行 —— 这是源侧的实际输出，不是漏写。
        // 源侧对「非空但非字符串」的 text 会直接 append 原值（Python join 会抛），
        // 这里退化成空串，是全文件唯一一处有意比源侧更保守的地方。
        parts.push(typeof text === 'string' ? text : '')
        continue
      }
      // 源侧对既不是 dict 也不是 str 的元素**直接跳过**（不 append），照抄。
    }
    return parts.join('\n')
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, any>
    for (const key of ['text', 'content', 'value', 'data']) {
      const candidate = obj[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return String(content)
}

/**
 * 序列化 assistant 的历史 tool_calls 为一段可读文本（源侧 `_serialize_tool_calls`）。
 *
 * Remote 的 `query` 没有结构化的 tool 历史位；工具调用只能作为文本回灌，
 * 并显式标注「已经处理过，不要重复调用」——否则上游会看到自己（或调用方）上一轮
 * 的调用记录，再执行一遍。
 */
function serializeToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ''
  const calls: Array<Record<string, any>> = []
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) continue
    const c = call as Record<string, any>
    const fn = c['function'] && typeof c['function'] === 'object' && !Array.isArray(c['function'])
      ? (c['function'] as Record<string, any>)
      : c
    calls.push({
      id: c['id'] ?? c['tool_call_id'] ?? null,
      name: fn['name'] ?? null,
      input: fn['arguments'] ?? fn['input'] ?? {},
    })
  }
  if (calls.length === 0) return ''
  return 'Client tool history (already handled; do not repeat):\n' + JSON.stringify(calls)
}

/**
 * 一个已经上传好的附件（`uri` 必须是 `trae-res://…`，由 `resource-upload.ts` 产出）。
 *
 * 单独成类型而不是内联对象：`remote.ts`（上传）与 `proxy.ts`（抽取字节）都要引用同一形态，
 * 各写一份字面量迟早会漂移。
 */
export interface TraeQueryAttachment {
  uri: string
  filename: string
}

/**
 * 把 OpenAI messages 扁平化为 Remote 端点的 `query` 字段。
 *
 * 形态：`JSON.stringify([{ type: 'text', data: { content: <整段文本> } }])`
 * ——注意**整个对话压成一条 text block**，角色靠 `[System]` / `[Assistant]` /
 * `[Client Tool Result: …]` 前缀在纯文本里表达。这是上游 web 端的原生格式，
 * 改成结构化数组上游不认。
 *
 * 与 SOLO 的 `prepareBody` 是两套格式：SOLO 走结构化 `messages`（content 转
 * `[{type:"text",text}]`），Remote 走这一条扁平 query。两者不可互换。
 *
 * ## 多模态：**追加** `attachment` 块，不动 `text` 块
 *
 * 官方 web 端把图片发成独立的 `attachment` 块（`uri` 指向 Trae 自己的资源存储，见
 * `contentToText` 的注释）。我们照发，但**刻意不**模仿官方「按消息分多个 text 块」的形态：
 * 本仓库对源侧 `flatten_query` 的「整段对话压成一个 text 块」是既有行为，动它会改掉所有
 * 历史请求的字节形态（缓存、回归用例全受影响）。所以这里的规则是：
 *
 *  - `opts.attachments` 为空 → 输出与加这个参数之前**逐字节相同**；
 *  - 非空 → 在 text 块**之后**追加 `{type:'attachment',data:{uri,filename}}`，text 块一字不动。
 *
 * 空 `uri` 的附件被跳过（而不是发一个上游必然拒绝的空引用）—— 上传失败时调用方就不该
 * 把半成品塞进来，这里再兜一层。
 */
export function flattenTraeQuery(messages: unknown, opts?: { attachments?: TraeQueryAttachment[] }): string {
  const list = Array.isArray(messages) ? messages : []
  const parts: string[] = []
  for (const mi of list) {
    if (!mi || typeof mi !== 'object' || Array.isArray(mi)) continue
    const m = mi as Record<string, any>
    const role = typeof m['role'] === 'string' ? m['role'] : 'user'

    let contentValue = m['content']
    const hasToolCalls = Array.isArray(m['tool_calls']) && (m['tool_calls'] as unknown[]).length > 0
    if ((contentValue === null || contentValue === undefined || contentValue === '' || (Array.isArray(contentValue) && contentValue.length === 0)) && !hasToolCalls) {
      // 部分客户端把文本放在 parts/text/prompt 等别名里（Anthropic 风格输入）。
      for (const key of ['parts', 'text', 'prompt', 'message', 'input']) {
        const candidate = m[key]
        if (candidate === null || candidate === undefined || candidate === '' || candidate === '{}') continue
        if (Array.isArray(candidate) && candidate.length === 0) continue
        contentValue = candidate
        break
      }
    }
    const content = contentToText(contentValue)

    if (role === 'system' || role === 'developer') {
      // developer 归一化为 system：上游 Remote 的角色词表同样只认 system
      //（与 payload.prepareBody 的 developer→system 保持同一口径）。
      parts.push(`[System]\n${content}`)
    } else if (role === 'assistant') {
      const assistantParts: string[] = content ? [content] : []
      const toolHistory = serializeToolCalls(m['tool_calls'])
      if (toolHistory) assistantParts.push(toolHistory)
      if (assistantParts.length > 0) parts.push('[Assistant]\n' + assistantParts.join('\n\n'))
    } else if (role === 'tool' || role === 'function') {
      const toolId = m['tool_call_id'] ?? m['toolCallId'] ?? 'unknown'
      const toolName = m['name'] ?? 'tool'
      // 失败态由内容里的错误标记推断（上游不单独下发 status 字段）。
      const text = content.toLowerCase()
      const status = text.includes('"error"') || text.includes('failed') || text.includes('exception')
        ? 'failed'
        : 'succeeded'
      parts.push(`[Client Tool Result: ${toolId} ${toolName} status=${status}]\n${content}`)
    } else {
      parts.push(content)
    }
  }
  const text = parts.join('\n\n')
  // 键序固定（type 在前、data 在后；data 里 content 唯一）：无附件时这里必须与改动前
  // **逐字节相同**，回归用例 `payload.test.ts` 的「无附件输出逐字节不变」在守这条。
  const blocks: Array<{ type: string; data: Record<string, string> }> = [
    { type: 'text', data: { content: text } },
  ]
  for (const attachment of opts?.attachments ?? []) {
    if (!attachment) continue
    const uri = typeof attachment.uri === 'string' ? attachment.uri.trim() : ''
    if (!uri) continue
    blocks.push({
      type: 'attachment',
      data: { uri, filename: String(attachment.filename ?? '') },
    })
  }
  try {
    return JSON.stringify(blocks)
  } catch {
    return JSON.stringify([{ type: 'text', data: { content: '' } }])
  }
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
      // 上游 SOLO 的角色白名单只有 system/assistant/user/tool/function：
      // OpenAI 新式客户端（DSH / Codex 等）用 developer 承载系统提示词，原样透传会被上游
      // 以 4027 invalid_parameter_error（"developer is not one of [...]"）整请求拒绝。
      // 与 WorkBuddy 通路 sanitizeUpstreamBody 的 developer→system 归一化保持同一口径。
      if (m['role'] === 'developer') m['role'] = 'system'

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

  // 兜底：`__trae_effort` 是网关内部载体（src/proxy.ts 为 Remote 端点抢救的思考档位），
  // **绝不能**出现在 SOLO 上游的请求体里。正常路径上它只在 Remote 提供商被创建，
  // 但这里再删一次，保证任何调用方都漏不出去（同 `__budget` 的处理方式）。
  delete obj['__trae_effort']

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
