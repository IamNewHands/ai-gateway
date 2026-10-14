/**
 * remote-messages.ts — TRAE **Remote** 请求体的源侧消息预处理。
 *
 * 移植自 Trae2api-cn（三个来源，逐条给出行号，方便复核）：
 *  - `src/main.py` `_remote_client_tool_task_anchor`（5729 行）+ 它依赖的
 *    `_tool_protocol_requested`（4004 行）/ `_message_contains_tool_protocol`（4018 行）
 *    / `_CONTINUATION_ONLY_RE`（5721 行）
 *  - `src/main.py` 6320-6323 行的**插入位置**：
 *    `prepared = _messages_with_client_runtime(...)`；若锚点存在则
 *    `prepared = [prepared[0], task_anchor, *prepared[1:]]`
 *  - `src/trae_client.py` `_messages_with_client_runtime`（1119 行）→ 它调用的
 *    `src/raw_client.py` `build_runtime_system_prompt`（813 行）、`build_client_context`（529 行）、
 *    `build_tool_discovery`（475 行）、`_normalized_tools`（629 行）、`_tool_definitions_prompt`（704 行）、
 *    `_compact_tool_signature`（675 行）、`_tool_schema_budget`（667 行）
 *
 * ## 为什么需要工具目录提示
 *
 * Remote 的 `initial_message.query` 是**一段扁平文本**，结构化的 `tools` 字段根本发不出去
 * （`flattenTraeQuery` 只拼对话文本）。不补这一环，上游压根不知道调用方声明了哪些工具，
 * 自然一次也调不出来 —— 网关下游的 `allowedTools` 过滤只是「不转发不该转发的调用」，
 * 不能凭空让上游学会调用。源侧正是靠把工具目录序列化进 system 提示解决这件事。
 *
 * ## 为什么需要工具任务锚点
 *
 * Remote 的 `query` 超长时源侧从最旧的对话轮开始整条丢弃（`_bounded_remote_query`：
 * `flatten_query` 超过 ~480k 字符就砍历史）。Codex 这类长会话能到上千条消息，压缩几乎必然发生。
 *
 * 问题在于「继续」这种纯续跑消息**本身不带任何任务语义**：压缩把它前面的真实请求丢掉
 * 之后，上游只知道「继续」，于是既可能去猜（丢掉 URL、目标路径），也可能直接声称完成
 * —— 而调用方的工具调用一次都没发生过。源侧踩过这个坑，所以把最近一条真正的 user
 * 请求**原样**包成一条 system 消息塞回去，让压缩后任务语义还在。
 *
 * ## 为什么锚点必须是 system 消息
 *
 * 压缩口径是「system 恒保留，从最旧的 non-system 开始丢」（源侧 `_compact_raw_history`、
 * 本仓库 `payload.ts` 的 `applyHistoryBudget` 同口径）。锚点若做成 user 消息，它自己
 * 就是「最旧的 non-system」之一，下一轮压缩就把它丢了 —— 等于没做。
 *
 * ## 与源侧的已知差异（每一处都是有意为之，改动前先读这里）
 *
 * 1. **锚点触发条件**：源侧 `_tool_protocol_requested(options, messages)` 除了请求体的
 *    `tools` / `tool_choice` / `parallel_tool_calls`，**还会**扫历史里的工具协议。
 *    本函数的 `hasTools` 由调用方决定；扫历史那半已导出成 `historyHasToolProtocol`，
 *    请调用方自行并进 `hasTools`。
 * 2. **工具目录提示的触发条件**：源侧只要 `tools` 出现在 options 里就会插这条提示，
 *    哪怕目录里一个合法工具都没有（那时提示里会出现
 *    「No client tools are available for this request; answer directly.」，但同时又教了
 *    `<opencode_tool_call>` 格式，自相矛盾）。本函数要求**至少有一个合法工具定义**
 *    才插，否则视同没有工具（`raw_client.py:888-889` 那条分支刻意不移植）。
 * 3. **client context 只保留能算出来的那一项**：源侧 `build_client_context`
 *    （`raw_client.py:529-594`）会填 `system_type` / `workspace_path` / `terminal_context` /
 *    `client_name` / `context_source`，但那些都来自请求头或 `options.client_context`，
 *    本函数两者都拿不到。**尤其不编造 `workspace_path`** —— 源侧 549-550 行明确警告：
 *    编一个绝对根路径会让模型把调用方的相对路径（`r.txt`）改写成
 *    `C:\workspace\r.txt`。所以 context 里只放 `tool_discovery`（它只依赖 `tools`）。
 * 4. **未移植的提示片段**（都因为缺载体，不是遗漏）：
 *    - `raw_client.py:891-898` 的 tool_choice 三行（缺 `tool_choice`）；
 *    - `raw_client.py:899-900` 的「Request at most one tool per turn.」（缺 `parallel_tool_calls`）；
 *    - `raw_client.py:904-906` 的 `response_style_instruction()`（`raw_client.py:796-810`，
 *      受 `TRAE_VERBOSE_REASONING` 环境变量控制；本函数没有对应开关载体，
 *      而且它是「回答风格」而非「工具目录」，塞进来会顺手改掉 Remote 的可见输出风格）。
 * 5. **锚点插入位置**：源侧写死 1 号位，因为它自己刚在 0 号位插了工具目录提示。
 *    本函数在插了工具目录提示时同样插 1 号位（与源侧一致）；**没插提示时**退化为
 *    「紧跟首个 system/developer 消息，没有则放最前」，保证锚点仍排在全部对话轮之前
 *    （源侧那条不变量的实际内容）。
 */

/**
 * 源侧 `_CONTINUATION_ONLY_RE`：整条消息只有「继续」语义，不带任何任务信息。
 *
 * 源侧用 `re.fullmatch` + `re.IGNORECASE`；这里靠 `^…$` 且**不带 `m` 标志**等价
 * （`m` 会让 `^`/`$` 变成行首行尾，那样「前半段是继续」也会误判）。
 * `j继续` 是源侧原样的笔误，照抄 —— 历史请求里真出现过，删掉等于丢一个真实触发词。
 */
const CONTINUATION_ONLY_RE =
  /^(?:继续(?:执行|完成|处理|下载|安装|操作|进行|做)?|接着(?:做|执行|处理)?|往下继续|下一步|j继续|continue(?:\s+(?:it|this|working))?|go\s+on|proceed|keep\s+going|resume)[\s。.!！?？]*$/i

/** 源侧那段英文提示词，逐字照抄（不要顺手改成中文：它是要让上游模型照做的指令）。 */
const TASK_ANCHOR_PREAMBLE =
  'Active caller task retained during history compaction. The latest user message is only a continuation request. Continue the task below. For any caller-side download or file change, emit the matching client tool call and wait for its result; do not claim success from a remote/internal tool.\n\n'

/** 源侧 `max_chars = 16_000`。 */
const ANCHOR_MAX_CHARS = 16_000
/** 源侧首尾各留 8_000。 */
const ANCHOR_KEEP_CHARS = 8_000
/** 源侧中段省略标记（前后各带一个换行）。 */
const ANCHOR_OMITTED_MARKER = '\n...[task middle omitted]...\n'

/**
 * 源侧 `_tool_schema_budget()`（`raw_client.py:667-672`）的默认值：
 * `TRAE_RAW_MAX_TOOL_SCHEMA_CHARS` 未设时 48000，下限 1024。
 *
 * 为什么不复用 `constants.ts` 的 `TRAE_RAW_MAX_TOOL_SCHEMA_CHARS`（10000）：
 * 那个常量是 **SOLO 结构化通路**的 schema 压缩预算（proxy.ts 的 `__budget`），
 * 与这里「Remote 只能把 schema 塞进一段文本」的预算不是一回事，而且它的值比源侧
 * 的 Remote 默认紧 4.8 倍 —— 直接复用会让大批工具退化成「只有名字」。
 * 要让它可配置，就给 options 加一个字段。
 */
const TOOL_SCHEMA_BUDGET_CHARS = 48_000

/** 源侧 `build_tool_discovery` 里判定「发现类工具」的名字集合（`raw_client.py:495-500`）。 */
const TOOL_SEARCH_NAMES = new Set(['tool_search', 'search_tools', 'list_tools', 'plugin_search'])

/** 源侧 `build_tool_discovery` 里判定「环境探测类工具」的名字片段（`raw_client.py:504-517`）。 */
const ENVIRONMENT_TOOL_MARKERS = [
  'shell',
  'exec',
  'terminal',
  'environment',
  'workspace',
  'filesystem',
  'read_file',
  'list_dir',
  'glob',
]

/** 源侧 `_tool_definitions_prompt` 的优先级名单（`raw_client.py:720-741`）。 */
const DISCOVERY_TOOL_NAMES = new Set([
  'tool_search',
  'search_tools',
  'list_tools',
  'plugin_search',
  'environment',
  'get_environment',
])
const EXECUTION_TOOL_NAMES = new Set([
  'shell',
  'shell_exec',
  'exec',
  'exec_command',
  'download',
  'download_file',
  'write',
  'write_file',
  'file_write',
  'edit',
  'edit_file',
  'apply_patch',
])

/** 调用方需要告诉本函数的东西。 */
export interface RemoteMessagePrepOptions {
  /**
   * 请求侧是否声明了工具能力（决定要不要注入**工具任务锚点**）。
   *
   * 源侧的口径是 `_tool_protocol_requested(options, messages)`：请求体带
   * `tools`/`tool_choice`/`parallel_tool_calls`，**或者**历史里有工具协议。
   * 后者请用本文件导出的 `historyHasToolProtocol(messages)` 并进来。
   */
  hasTools: boolean
  /**
   * OpenAI 请求体的 `tools` 数组原样（决定要不要注入**工具目录 system 提示**）。
   *
   * 缺失 / 非数组 / 空数组 / 一个合法工具都没有 → 不插这条提示。
   */
  tools?: unknown
}

/**
 * 请求体 `tools` 之外，历史消息里是否出现工具协议。
 *
 * 源侧 `main.py:4004-4043` `_tool_protocol_requested` + `_message_contains_tool_protocol`：
 * 客户端并不总是用 OpenAI 的 `role=tool` —— TraeWork 的渲染器把调用/结果序列化成
 * `tool_use` / `tool_result` 内容块，结果常常挂在 `role=user` 的消息上。这些轮次
 * 同样需要工具感知的运行时提示与 raw 安全路由，所以必须一起算进来。
 *
 * 命中条件（任一即可，全部照抄源侧）：
 *  1. `role`（trim + 小写后）是 `tool` 或 `function`；
 *  2. `role=assistant` 且 `tool_calls` 是非空数组，或 `function_call` 是对象；
 *  3. `content` 是数组，且其中任一块的 `type`（trim + 小写后）是
 *     `tool_use` / `tool_call` / `function_call` / `tool_result`。
 *
 * 注意：源侧对第 2 条的 `function_call` 只判「是不是 Mapping」，**空对象也算命中**；
 * 对 `tool_calls` 则要求非空数组。这个不对称照抄。
 */
export function historyHasToolProtocol(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const message = raw as Record<string, any>
    const role = String(message['role'] || '').trim().toLowerCase()
    if (role === 'tool' || role === 'function') return true
    if (role === 'assistant') {
      const toolCalls = message['tool_calls']
      if (Array.isArray(toolCalls) && toolCalls.length > 0) return true
      const functionCall = message['function_call']
      if (functionCall && typeof functionCall === 'object' && !Array.isArray(functionCall)) return true
    }
    const content = message['content']
    if (!Array.isArray(content)) continue
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue
      const type = String((rawBlock as Record<string, any>)['type'] || '').trim().toLowerCase()
      if (type === 'tool_use' || type === 'tool_call' || type === 'function_call' || type === 'tool_result') {
        return true
      }
    }
  }
  return false
}

/**
 * 统计请求里的图片块数量（**诊断用**）。
 *
 * 为什么需要它：Remote 的 flatten 只读 `text`/`content`，图片块本身不会变成 query 里的
 * 文本。图片现在走独立的上传 + `attachment` 块（`resource-upload.ts`），但那条路有**三道
 * 静默失败**——模型不声明多模态、上传被拒、抽取阶段就丢了（远端 URL / 解码失败）——
 * 上游一律不报错，用户只看到「模型答非所问」。这个计数就是分母：`proxy.ts` 用
 * `countImageBlocks() - extractImageParts().length` 与 `trace.imageAttachments` 的差额
 * 打 `dropped_images=` 日志。
 *
 * 只数两种形态（本仓库到 trae 之前已由 `formats.ts` 统一成第一种）：
 *  - OpenAI：`{ type: 'image_url', image_url: { url } }`
 *  - Anthropic：`{ type: 'image', source: { type: 'base64' | 'url', … } }`
 *
 * 只看 `content` 数组里的块，不看顶层字段，也不校验 url 是否为空 —— 计数器的用途是
 * 「有没有图没进上游」，不是「图能不能用」。`input_image`（Responses 形态）与 `file`
 * 块不计入：它们到 trae 之前会被归一成 `image_url`，真要覆盖再各加一个分支。
 *
 * ⚠️ 口径必须与 `resource-upload.ts` 的 `extractImageParts` **成对演进**：两者数的不是
 * 同一批块时，日志里的差额就会说谎（多报或漏报丢图）。
 */
export function countImageBlocks(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const content = (raw as Record<string, any>)['content']
    if (!Array.isArray(content)) continue
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue
      const type = String((rawBlock as Record<string, any>)['type'] || '').trim().toLowerCase()
      if (type === 'image_url' || type === 'image') count++
    }
  }
  return count
}

// ===== 工具目录 → system 提示（源侧 raw_client.build_runtime_system_prompt） =====

/** 源侧 `json.dumps(..., ensure_ascii=False, separators=(",", ":"))` 的等价物。 */
function jsonCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return 'null'
  }
}

/** 源侧 `_normalized_tools`（`raw_client.py:629-664`）：摊平 OpenAI / 原生两种工具声明。 */
function normalizeToolDefs(tools: unknown): Array<Record<string, any>> {
  if (!Array.isArray(tools)) return []
  const out: Array<Record<string, any>> = []
  const seen = new Set<string>()
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const tool = raw as Record<string, any>
    const fn = tool['function']
    let name: unknown
    let description: unknown
    let schema: unknown
    if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
      const f = fn as Record<string, any>
      name = f['name']
      description = f['description'] ?? ''
      schema = f['parameters'] || f['input_schema'] || {}
    } else {
      name = tool['name']
      description = tool['description'] ?? ''
      schema = tool['input_schema'] || tool['inputSchema'] || tool['parameters'] || {}
    }
    if (!name) continue
    const normalizedName = String(name)
    if (seen.has(normalizedName)) continue
    seen.add(normalizedName)
    out.push({
      name: normalizedName,
      description: String(description || ''),
      input_schema: schema,
    })
  }
  return out
}

/** 源侧 `build_tool_discovery`（`raw_client.py:475-526`）：只靠工具名就能算出的发现摘要。 */
function buildToolDiscovery(toolDefs: Array<Record<string, any>>): Record<string, any> {
  const names: string[] = []
  const namespaces: string[] = []
  for (const tool of toolDefs) {
    const name = String(tool['name'] || '').trim()
    if (!name || names.includes(name)) continue
    names.push(name)
    let namespace = ''
    if (name.includes('__')) {
      // Responses 命名空间工具摊平成 `namespace__tool`。
      namespace = name.split('__').slice(0, -1).join('__').replace(/^_+|_+$/g, '')
    } else if (name.includes('.')) {
      namespace = name.slice(0, name.lastIndexOf('.'))
    }
    if (namespace && !namespaces.includes(namespace)) namespaces.push(namespace)
  }

  // 源侧用 dict 推导式做小写索引：同名不同大小写时**后者覆盖前者**，但键的位置留在首次出现处。
  const lowered = new Map<string, string>()
  for (const name of names) lowered.set(name.toLowerCase(), name)
  const searchTools = [...lowered.entries()]
    .filter(([loweredName]) => TOOL_SEARCH_NAMES.has(loweredName) || loweredName.includes('tool_search'))
    .map(([, original]) => original)
  const environmentTools = names.filter((name) =>
    ENVIRONMENT_TOOL_MARKERS.some((marker) => name.toLowerCase().includes(marker)),
  )

  return {
    mode: 'automatic',
    declared_tools: names,
    plugin_namespaces: namespaces,
    tool_search_available: searchTools.length > 0,
    tool_search_tools: searchTools,
    environment_probe_tools: environmentTools,
  }
}

/** 源侧 `_compact_tool_signature`（`raw_client.py:675-701`）：把 schema 压成字段类型签名。 */
function compactToolSignature(tool: Record<string, any>): Record<string, any> {
  const schema = tool['input_schema']
  const properties =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, any>)['properties']
      : null
  const fields: Record<string, any> = {}
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, rawHint] of Object.entries(properties as Record<string, any>)) {
      const hint: Record<string, any> = {}
      if (rawHint && typeof rawHint === 'object' && !Array.isArray(rawHint)) {
        const h = rawHint as Record<string, any>
        const valueType = h['type']
        if (typeof valueType === 'string' || Array.isArray(valueType)) hint['type'] = valueType
        const enumValues = h['enum']
        if (Array.isArray(enumValues) && enumValues.length <= 20) hint['enum'] = enumValues
        const items = h['items']
        if (valueType === 'array' && items && typeof items === 'object' && !Array.isArray(items)) {
          const itemType = (items as Record<string, any>)['type']
          if (typeof itemType === 'string') hint['items'] = itemType
        }
      }
      // 源侧 `hint or "any"`：空 dict 也算「没有信息」。
      fields[String(name)] = Object.keys(hint).length > 0 ? hint : 'any'
    }
  }
  const signature: Record<string, any> = {
    name: String(tool['name'] || ''),
    fields,
  }
  const required =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, any>)['required']
      : null
  if (Array.isArray(required)) signature['required'] = required.map((value) => String(value))
  return signature
}

/**
 * 源侧 `_tool_definitions_prompt`（`raw_client.py:704-778`）：在预算内序列化工具 schema。
 *
 * 正常规模保留**完整** OpenAI schema；目录过大时保留全部工具名 + 尽量多的紧凑字段签名，
 * 并让发现类/执行类工具排前面（否则被裁掉的可能正是「能干活的那几个」）。
 *
 * 长度用 `String.length`（UTF-16 码元）而不是码点：源侧数码点，这里数出来的只会**偏大**，
 * 也就是偏保守（宁可多裁一点，也不让提示超预算）。
 */
function toolDefinitionsPrompt(toolDefs: Array<Record<string, any>>): {
  payload: string
  compacted: boolean
  omitted: number
} {
  const full = jsonCompact(toolDefs)
  if (full.length <= TOOL_SCHEMA_BUDGET_CHARS) return { payload: full, compacted: false, omitted: 0 }

  const names = toolDefs.map((tool) => String(tool['name'] || ''))
  const priority = (signature: Record<string, any>): number => {
    const name = String(signature['name'] || '').toLowerCase()
    // Responses 命名空间工具摊平成 `namespace__tool`，完整名与末段名都要参与判定，
    // 这样 functions__exec 与 browser__download_file 在压力下仍能保住参数字段。
    const basename = name.split('__').slice(-1)[0]
    const candidates = [name, basename]
    if (candidates.some((c) => DISCOVERY_TOOL_NAMES.has(c))) return 0
    if (candidates.some((c) => EXECUTION_TOOL_NAMES.has(c))) return 1
    return 2
  }

  // Array.prototype.sort 是稳定的（ES2019+），与源侧 `list.sort` 的稳定性一致。
  const signatures = toolDefs.map(compactToolSignature).sort((a, b) => priority(a) - priority(b))
  let payload: Record<string, any> = {
    available_tools: names,
    signatures: [],
    omitted_signatures: signatures.length,
  }
  for (const signature of signatures) {
    const candidate: Record<string, any> = {
      ...payload,
      signatures: [...(payload['signatures'] as unknown[]), signature],
      omitted_signatures: signatures.length - ((payload['signatures'] as unknown[]).length + 1),
    }
    if (jsonCompact(candidate).length > TOOL_SCHEMA_BUDGET_CHARS) continue
    payload = candidate
  }
  return {
    payload: jsonCompact(payload),
    compacted: true,
    omitted: Number(payload['omitted_signatures']),
  }
}

/**
 * 源侧 `raw_client.build_runtime_system_prompt`（813-907 行），
 * 走的是 `_messages_with_client_runtime` 传给它的 `native_tools=False` 分支
 * （`trae_client.py:1152-1158` 调用时没传 `native_tools`，默认 False —— 这是 Remote 走的那条）。
 *
 * 返回 `null` 表示「不该插这条提示」（没有可用的工具定义），见文件头差异 2。
 */
function buildRuntimeSystemPrompt(tools: unknown): string | null {
  const toolDefs = normalizeToolDefs(tools)
  if (toolDefs.length === 0) return null

  // 源侧 `build_client_context` + `setdefault("tool_discovery", …)`：拿不到请求头与
  // options.client_context，所以只放只依赖 tools 的这一项（见文件头差异 3）。
  const context: Record<string, any> = { tool_discovery: buildToolDiscovery(toolDefs) }
  const discovery = context['tool_discovery'] as Record<string, any>
  // 源侧 827-831 行：schema 载荷里已经有全部工具名，摘要里不再重复 declared_tools。
  delete discovery['declared_tools']

  const lines: string[] = [
    "You are Trae Code connected to the user's local application.",
    'The external Trae-compatible terminal client application that started this conversation provides the client tools below.',
    'Caller client context (JSON):',
    jsonCompact(context),
    'Discover the local environment through the available client tools when the request requires it.',
    'If a tool can answer the question, call it proactively and wait for the external client result.',
    'Remote or server-side tools cannot write into the caller workspace. Never claim that a client file was downloaded, created, edited, patched, or saved unless a later matching client tool result with the same call id confirms success.',
    'A tool request, emitted tool-call block, plan, or assistant narration is not execution proof. If the matching client result reports failure, state the failure or request a corrective client tool; never report the operation as completed.',
    "Never repeat a completed tool call; do not describe that server's Linux filesystem as the caller workspace.",
    // native_tools=False 分支（源侧 852-861 行）
    "Client tools are NOT native/server functions: never invoke them through function calling or any built-in tool, and never fall back to server tools (LS, Glob, Read, terminal) to reach the caller's files. The only way to call a client tool is the text block below; a native call reports 'not available' because the tool lives on the client.",
    'To use tools, emit only one or more JSON blocks and include no prose or final answer in that turn:',
    '<opencode_tool_call>{"name":"tool_name","input":{}}</opencode_tool_call>',
    'Do not invent an id field; the client assigns call ids. Keep file paths exactly as the user or tool result gave them.',
    'Fill input according to the selected tool schema and wait for the client result before continuing.',
  ]

  const { payload, compacted, omitted } = toolDefinitionsPrompt(toolDefs)
  let schemaLabel = 'Available client tool definitions and input schemas (JSON):'
  if (compacted) {
    schemaLabel =
      'Available client tools and compact input signatures (JSON). The full schema catalog exceeded the relay input budget'
    if (omitted > 0) {
      schemaLabel += `; ${omitted} signature(s) are name-only. Use an available tool_search/plugin discovery tool before guessing arguments`
    }
    schemaLabel += ':'
  }
  lines.push(
    schemaLabel,
    payload,
    'To call a tool, emit one block per call in this format and no prose or final answer in the same turn: <opencode_tool_call>{"name":"tool_name","input":{}}</opencode_tool_call>. Omit the id field (the client assigns it), use an exact declared tool name, and fill input according to that tool\'s schema.',
    "After the client returns a tool result, continue from that result until the user's request is complete.",
  )
  return lines.join('\n')
}

// ===== 工具任务锚点（源侧 main.py._remote_client_tool_task_anchor） =====

/**
 * 源侧 `cli_client.renderer_block_text`：Trae 桌面渲染器把文本放在 `value` 而不是
 * `text`/`content`（`{type:"text",value:…}`、`{type:"tool_result",value:[…]}`），
 * 不取 `value` 这些块会被读成空串。
 *
 * 为什么在这里再抄一份、不 export `payload.ts` 的那份：见下面 `anchorContentToText` 的注释。
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
 * 源侧 `raw_client._content_to_text`（**不是** `trae_client` 里同名的那份）。
 *
 * 与 flatten 那份的关键差别：图片/文件块在这里会产出
 * `[Unsupported image_url input omitted]` 占位，而不是被静默吞掉。锚点取文要的是
 * 「这条 user 消息有没有内容」，占位文案算内容，所以行为不同是有意义的。
 */
function anchorContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        parts.push(String(block))
        continue
      }
      const b = block as Record<string, any>
      const direct = b['text'] || b['content']
      if (typeof direct === 'string') {
        parts.push(direct)
        continue
      }
      if (b['value'] !== null && b['value'] !== undefined) {
        const nested = rendererBlockText(b)
        if (nested) parts.push(nested)
        continue
      }
      // 源侧按字面比较 type（不做大小写归一），照抄。
      const type = b['type']
      if (type === 'image' || type === 'image_url' || type === 'file') {
        parts.push(`[Unsupported ${String(type)} input omitted]`)
      }
    }
    // 源侧 `"\n".join(part for part in parts if part)`：空串不参与拼接。
    return parts.filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content)
}

/**
 * 源侧 `text[:8000] + "\n...[task middle omitted]...\n" + text[-8000:]`（`len > 16000` 时）。
 *
 * 源侧 `len()` 数的是**码点**，JS `String.length` 数的是 UTF-16 码元（一个 emoji 算 2），
 * 所以先走 `.length` 快路径 —— 码点数恒 ≤ 码元数，`.length ≤ 16000` 必然不用截 ——
 * 只有超限时才按码点切，避免把 emoji 拦腰砍成半个代理对。
 */
function truncateAnchorText(text: string): string {
  if (text.length <= ANCHOR_MAX_CHARS) return text
  const chars = Array.from(text)
  if (chars.length <= ANCHOR_MAX_CHARS) return text
  return (
    chars.slice(0, ANCHOR_KEEP_CHARS).join('') +
    ANCHOR_OMITTED_MARKER +
    chars.slice(-ANCHOR_KEEP_CHARS).join('')
  )
}

/**
 * 源侧 `_remote_client_tool_task_anchor`：能锚就返回那条 system 消息，否则 `null`。
 *
 * 判定顺序照抄源侧，一步都不能省：
 *  1. 至少两条**非空** user 消息（只有一条时「最近一条真正的请求」不存在）；
 *  2. 最后一条 user 必须是纯继续；
 *  3. 往前找第一条**既不是纯继续、又在最后一条之前**的 user 请求。
 */
function buildToolTaskAnchor(messages: unknown[]): { role: 'system'; content: string } | null {
  const userMessages: Array<{ index: number; text: string }> = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const m = message as Record<string, any>
    // 源侧 `str(message.get("role") or "user") != "user"`：**缺 role 的按 user 算**。
    if (String(m['role'] || 'user') !== 'user') continue
    // 源侧只看 `content` 字段（不认 parts/text/prompt 这些别名），且空内容不计入。
    const text = anchorContentToText(m['content']).trim()
    if (text) userMessages.push({ index, text })
  }
  if (userMessages.length < 2) return null

  const latest = userMessages[userMessages.length - 1]
  if (!CONTINUATION_ONLY_RE.test(latest.text)) return null

  for (let i = userMessages.length - 2; i >= 0; i--) {
    const candidate = userMessages[i]
    // 源侧带这个防御判断（候选按构造永远在 latest 之前，实际不可达），保留以对齐。
    if (candidate.index >= latest.index) continue
    // 连续两次「继续」时跳过前一个，继续往前找真正的请求。
    if (CONTINUATION_ONLY_RE.test(candidate.text)) continue
    return {
      role: 'system',
      content: TASK_ANCHOR_PREAMBLE + truncateAnchorText(candidate.text),
    }
  }
  return null
}

/** 没插工具目录提示时的锚点落点：紧跟首个 system/developer，没有则放最前。 */
function leadingSystemOffset(messages: unknown[]): number {
  const head = messages[0]
  const headRole =
    head && typeof head === 'object' && !Array.isArray(head)
      ? String((head as Record<string, any>)['role'] || '')
      : ''
  return headRole === 'system' || headRole === 'developer' ? 1 : 0
}

/**
 * 预处理 Remote 请求体里的 messages：注入工具目录提示 + 工具任务锚点。
 *
 * **返回新数组，绝不改入参**（元素本身是浅拷贝，调用方仍共享同一批消息对象）。
 * 不满足注入条件时返回内容原样的新数组 —— 也就是「不注入」，而不是「无脑插一条」。
 *
 * 组装顺序与源侧 `main.py:6320-6323` 一致：
 * `[工具目录 system 提示, 工具任务锚点, ...原始消息]`（后两条各自按条件出现）。
 *
 * 压缩前两者都必须已经在数组里，所以调用方要在**建会话之前**调一次并复用结果
 * （档位兜底会建两次会话，两次的消息形态必须一致）。
 */
export function prepareRemoteMessages(messages: unknown, opts: RemoteMessagePrepOptions): unknown {
  // 非数组没法注入，原样返回（`flattenTraeQuery` 对非数组也只会产出空文本）。
  if (!Array.isArray(messages)) return messages
  const options = opts || ({} as RemoteMessagePrepOptions)

  // 1) 工具目录 system 提示。触发条件只看 `tools`（源侧只要请求体带 tools 就插）。
  const toolPrompt = buildRuntimeSystemPrompt(options.tools)
  const out: unknown[] =
    toolPrompt === null ? messages.slice() : [{ role: 'system', content: toolPrompt }, ...messages]

  // 2) 工具任务锚点。硬约束：`hasTools` 不为 true 就绝不注入。
  if (options.hasTools === true) {
    // 源侧用的是**原始** messages 判定锚点（6321 行传的是 messages，不是 prepared_messages）。
    const anchor = buildToolTaskAnchor(messages)
    if (anchor !== null) {
      // 源侧写死 1 号位（它自己刚在 0 号位插了提示）；没插提示时退化到首个 system 之后。
      const at = toolPrompt === null ? leadingSystemOffset(messages) : 1
      return [...out.slice(0, at), anchor, ...out.slice(at)]
    }
  }
  return out
}
