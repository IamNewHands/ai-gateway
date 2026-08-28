/**
 * ChatHub SignalR WebSocket 客户端（移植自 M365-Copilot2API internal/chathub/client.go）。
 *
 * 协议要点：
 * - 出站 WS 连接到 wss://substrate.office.com/m365Copilot/Chathub，access_token/OID/TID 放 URL query
 * - SignalR JSON 协议，帧之间用 RS 分隔符（\x1e）
 * - 握手：先发 {"protocol":"json","version":1}\x1e
 * - 心跳：收到 type=6 回 {"type":6}\x1e
 * - 事件：type=1 update（流式）/ type=2 result / type=3 complete（结束）
 *
 * 出站 WS 用 fetch + Upgrade: websocket 建立（不依赖 connect 全局，Worker/DO 均可用）。
 */
import { classifyUpdateMessages, extractToolEvents, normalizeFrame, imageURLs } from './events'
import type { ChatHubStreamEvent } from './events'
import { toolProtocolPrompt } from './tools'

/**
 * Workers 出站 WebSocket 客户端。
 * 说明：出站 WS 用 `fetch()` + `Upgrade: websocket` 建立（`resp.webSocket`），
 * 该方式在普通 Worker 与 Durable Object 中均可用，不依赖 `connect()` 全局
 * （`connect` 仅在部分运行环境注入，DO / nodejs_compat 下可能缺失导致 is not defined）。
 */
interface OutboundWebSocket extends WebSocket {
  accept(options?: { allowHalfOpen?: boolean }): void
}

const RS = '\x1e'
const DEFAULT_TONE = 'magic'
const WS_BASE = 'wss://substrate.office.com/m365Copilot/Chathub'
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_MIB = 10

/** 与浏览器探针一致的 variants 字符串（含静态补全缺失 flag） */
const VARIANTS =
  'EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnWorkTabRecommendation,turnOffWorkTabUpsellFromClient,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.EnableCuaTakeControlApi,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix,EnableMergingPureDeltas,EnableRemoveStreamingMode,EnableConversationShareApisClient,EnableConversationShareApis,feature.EnableConversationShareApis,feature.EnableImageGenThrottled,feature.EnableImageGen2Throttled'

export interface ChatHubAccount {
  accessToken: string
  oid: string
  tid: string
  /** 可选：refresh_token 存在时，上层可在 401 时先刷新再定责（避免过期 token 被误判账号禁用） */
  refreshToken?: string
}

export interface ChatHubAttachment {
  type: 'image' | 'file'
  url: string
  mimeType?: string
  name?: string
  docId?: string
  fileType?: string
}

export interface ChatHubTool {
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}

export interface ChatHubRequest {
  text: string
  tone?: string
  conversationId?: string
  sessionId?: string
  attachments?: ChatHubAttachment[]
  tools?: ChatHubTool[]
  toolChoice?: unknown
  /** 首轮标记：会话/对话 ID 为空或首次使用时为 true */
  started?: boolean
  /** MCP 网关 URL：非空时向 plugins 注入 {Id:'mcp-gateway', Source:'MCPServer'}（同原版） */
  mcpServerUrl?: string
}

export interface ChatHubResult {
  text: string
  reasoning: string
  conversationId: string
  sessionId: string
  requestId: string
  events: unknown[]
  images: string[]
  /** 上游最终 message / result.value 原文（含图片元数据，供上层提取） */
  rawResult?: string
  /** 上游限流 / 风险提示元数据 */
  throttling?: unknown
}

export type ChatHubStreamHandler = (ev: ChatHubStreamEvent) => void

export interface ChatHubOptions {
  /** 会话/请求总超时（ms），默认 300_000 */
  timeoutMs?: number
  /** 单条帧读超时（ms），默认 90_000 */
  readTimeoutMs?: number
  /** 附件元数据追踪回调（可选） */
  trace?: (meta: Record<string, unknown>) => void
  /** 取消信号：客户端断连时中止上游对话（同原版 r.Context().Done()） */
  signal?: AbortSignal
  /** 调试：true 时通过 onDebug 上报原始文本增量/快照/最终消息（供排查换行/格式来源） */
  debug?: boolean
  /** 调试回调：tag ∈ chathub-delta / chathub-snapshot / chathub-result / chathub-final */
  onDebug?: (tag: string, text: string) => void
}

function randomUUID(): string {
  return crypto.randomUUID()
}

function buildWSURL(acc: ChatHubAccount, sessionID: string, conversationID: string, requestID: string): string {
  const q = new URLSearchParams()
  q.set('chatsessionid', requestID)
  q.set('clientrequestid', requestID)
  q.set('XRoutingParameterSessionKey', requestID)
  q.set('X-SessionId', sessionID)
  q.set('ConversationId', conversationID)
  q.set('access_token', acc.accessToken)
  q.set('variants', VARIANTS)
  q.set('source', '"officeweb"')
  q.set('product', 'Office')
  q.set('agentHost', 'Bizchat.FullScreen')
  q.set('licenseType', 'Starter')
  q.set('agent', 'web')
  q.set('scenario', 'OfficeWebIncludedCopilot')
  q.set('isEdu', 'false')
  return `${WS_BASE}/${encodeURIComponent(acc.oid)}@${encodeURIComponent(acc.tid)}?${q.toString()}`
}

/** 校验远程图片下载 URL（防 SSRF，同 ai-gateway isSafeHttpUrl 思路） */
function isSafeDownloadURL(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.local')) return false
    if (/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return false
    if (host === '169.254.169.254') return false
    // 拒绝带用户名/密码（userinfo）的 URL，避免凭证被带到重定向目标
    if (u.username !== '' || u.password !== '') return false
    return true
  } catch {
    return false
  }
}

/** 附件下载重定向跳数上限（同原版 downloadClient 的 CheckRedirect 上限） */
const MAX_DOWNLOAD_REDIRECTS = 5

/**
 * 安全下载远程图片附件：手动跟随重定向，每一跳都用 isSafeDownloadURL 重新校验，
 * 防止公共 URL 302 到云元数据地址 / 内网主机而绕过 SSRF 检查（原版 6654ada 修复）。
 * 仅返回 2xx 的最终响应；任何一跳不合法或跳数超限都返回 null（上层按失败跳过该附件）。
 */
async function safeFetchImage(url: string, redirects = 0): Promise<Response | null> {
  if (redirects > MAX_DOWNLOAD_REDIRECTS) return null
  if (!isSafeDownloadURL(url)) return null
  let resp: Response
  try {
    resp = await fetch(url, { redirect: 'manual' })
  } catch {
    return null
  }
  const status = resp.status
  // 3xx：校验 Location 后继续跟随（仅 302/303/307/308 这类显式重定向）
  if (status >= 300 && status < 400) {
    const loc = resp.headers.get('location')
    if (!loc) return null
    let next: string
    try {
      next = new URL(loc, url).toString()
    } catch {
      return null
    }
    return safeFetchImage(next, redirects + 1)
  }
  if (status < 200 || status >= 300) return null
  return resp
}

/** 上游内容策略 / 图片额度 / 限流 / 空返回 的语义分类（同原版 IsContentPolicyBlock 等） */
export type ChatHubErrorClass = 'rate_limit' | 'content_policy' | 'image_quota' | 'empty' | null
// 原版 contentPolicyPatterns 精确词表（避免长回答中普通词误判）
const contentPolicyPatterns = [
  '很抱歉，我无法响应',
  '我很抱歉，我无法响应',
  '很抱歉，我无法',
  '抱歉，我无法',
  "i'm sorry, i can't respond",
  "i'm sorry, i cannot respond",
  'i apologize, i cannot',
]
const imageLimitPatterns = [
  '无法生成更多图像', 'unable to generate more images', 'cannot generate more images today',
  'image generation quota', 'daily image limit', 'generate any more images',
  '无法再生成图片', '请明天再试', '图片生成额度',
  // chatWithHandlers 抛出的 ErrImageLimit 等价消息，需在错误消息归类时命中
  'image generation daily limit',
]

/** 判断错误是否与上游内容策略拦截相关（同原版：>300 字符不判定，避免长回答误报） */
function isContentPolicyBlock(text: string): boolean {
  if (text.length > 300) return false
  const low = text.toLowerCase()
  for (const p of contentPolicyPatterns) if (low.includes(p.toLowerCase())) return true
  return false
}

/** 分类非协议错误的上游提示（供 durable 映射为 429/502/400 等） */
export function classifyChatHubNotice(text: string): ChatHubErrorClass {
  if (!text) return null
  const low = text.toLowerCase()
  if (
    low.includes('temporarily unable to respond to this many requests') ||
    low.includes('太多请求') ||
    low.includes('无法响应这么多请求') ||
    low.includes('too many requests') ||
    (low.includes('please retry') && low.includes('later'))
  ) return 'rate_limit'
  // chatWithHandlers 抛出的 ErrOffensiveContent 等价消息
  if (low.includes('content policy flagged as offensive')) return 'content_policy'
  if (isContentPolicyBlock(text)) return 'content_policy'
  for (const p of imageLimitPatterns) if (low.includes(p)) return 'image_quota'
  return null
}

/**
 * 上传图片附件到 M365 UploadFile 端点（form-urlencoded，base64 data URL）。
 * 远程 https URL 会先下载再转 base64。返回 docId 供消息注解使用。
 */
async function uploadAttachments(acc: ChatHubAccount, conversationID: string, attachments: ChatHubAttachment[], opts: ChatHubOptions): Promise<void> {
  let imageCount = 0
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i]
    if (a.type !== 'image') continue
    imageCount++
    if (imageCount > MAX_ATTACHMENTS) throw new Error(`too many image attachments: limit is ${MAX_ATTACHMENTS}`)

    let imageData = a.url
    if (!imageData.startsWith('data:')) {
      // 安全下载：手动跟随重定向且每一跳重新校验 SSRF（见 safeFetchImage）
      const resp = await safeFetchImage(imageData)
      if (!resp) throw new Error('download image attachment failed (unsafe URL, redirect limit, or non-2xx)')
      const buf = await resp.arrayBuffer()
      if (buf.byteLength > MAX_ATTACHMENT_MIB << 20) throw new Error(`image attachment exceeds ${MAX_ATTACHMENT_MIB}MiB`)
      const mimeType = resp.headers.get('Content-Type') || 'image/png'
      imageData = `data:${mimeType};base64,${bytesToBase64(new Uint8Array(buf))}`
    }
    const comma = imageData.indexOf(',')
    if (comma < 0) throw new Error('invalid image data URL')
    if (!/;base64/i.test(imageData.substring(0, comma))) throw new Error('image URL is not base64')

    const form = new URLSearchParams()
    form.set('scenario', 'UploadImage')
    form.set('conversationId', conversationID)
    form.set('FileBase64', imageData)
    form.append('optionsSets', 'cwcgptvsan')
    form.append('optionsSets', 'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch')

    let resp: Response
    try {
      resp = await fetch('https://substrate.office.com/m365Copilot/UploadFile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${acc.accessToken}`,
          'Accept': 'application/json',
          'X-Variants': 'feature.EnableImageSupportInUploadFile',
          'X-Scenario': 'OfficeWebIncludedCopilot',
          'Referer': 'https://m365.cloud.microsoft/',
          'Origin': 'https://m365.cloud.microsoft',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
        },
        body: form.toString(),
      })
    } catch (e) {
      throw new Error(`image attachment upload failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!resp.ok) throw new Error(`image attachment upload HTTP ${resp.status}`)
    let out: { docId?: string; fileName?: string; fileType?: string; result?: { value?: string } }
    try {
      out = await resp.json()
    } catch {
      throw new Error('image attachment upload returned invalid JSON')
    }
    if (out.result?.value !== 'Success' || !out.docId) throw new Error(`image attachment upload rejected: ${out.result?.value || 'unknown'}`)
    a.docId = out.docId
    a.fileType = (out.fileType || '').toLowerCase().replace(/^\./, '')
    if (a.fileType === 'jpeg') a.fileType = 'jpg'
    if (!a.name) a.name = out.fileName
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

/**
 * 用最终消息对齐流式文本（原版 finalizeText 移植，导出以便单测）：
 * - final 为空或 final 不高于 streamed → 直接用现有文本；
 * - streamed 是 final 的前缀 → 流式漏了尾部，通过 emit 补发缺失片段后返回 final；
 * - 否则流式文本已偏离 final → 无法撤回已发出的 delta，但以 final 作为返回值，
 *   保证非流式调用与对话历史（会话绑定）使用完整正确的文本。
 * emit 为可选的文本增量回调（流式透出时传入 onDelta）。
 */
export function finalizeText(streamed: string, final: string, emit?: (delta: string) => void): string {
  if (final === '' || final.length <= streamed.length) {
    return streamed === '' ? final : streamed
  }
  if (final.startsWith(streamed)) {
    const tail = final.substring(streamed.length)
    if (tail) emit?.(tail)
    return final
  }
  return final
}

/**
 * 折叠"无意义的空行"（仅最终完整文本专用，SSE 流式增量不做）。
 *
 * 上游 M365 常返回大量连续空行，让长回答看起来碎成一段一断。这里做 markdown 感知的紧凑化：
 * - 普通文字区域：连续的多个空行压缩为最多 maxConsecutive 个 `\n`（段落留白保留）；
 * - 代码块（```  /  ~~~ 围栏）：内部所有空行原样保留，避免压缩破坏代码/文字排版缩进；
 * - 末尾多余空行清掉。
 * 不动单个换行（列表项/标题/引用的行内结构保持），因此不会破坏有意的 markdown 排版。
 */
export function collapseExcessBlankLines(text: string, maxConsecutive = 1): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let blankRun = 0
  for (const line of lines) {
    // 围栏行（``` / ~~~）翻转代码块状态；围栏内的空行一律保留
    if (/^(\s*)(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) { out.push(line); blankRun = 0; continue }
    if (line.trim() === '') { blankRun++; if (blankRun <= maxConsecutive) out.push(''); continue }
    blankRun = 0
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** 组装 ChatHub chat 帧（type=4 target=chat） */
function chatPayload(req: ChatHubRequest, requestID: string, firstTurn: boolean): string {
  const tools = req.tools || []
  const attachments = req.attachments || []
  const hasPlugins = clientPlugins(tools).length > 0
  const text = toolProtocolPrompt(req.text, tools, req.toolChoice, hasPlugins)

  // 序列化进 message.attachments 的 wire 对象：剥离内部字段 docId/fileType（对齐原版 json:"-"），
  // docId/fileType 只通过 messageAnnotations 里携带，避免上游收到形状不一致的 attachment。
  const wireAttachments = attachments.map((a) => {
    const w: Record<string, unknown> = { type: a.type, url: a.url }
    if (a.mimeType) w['mimeType'] = a.mimeType
    if (a.name) w['name'] = a.name
    return w
  })

  // clientInfo 与真实浏览器一致（HAR 逆向），在 argument 层与 message 层各嵌一份副本
  const clientInfo: Record<string, unknown> = {
    clientPlatform: 'mcmcopilot-web',
    clientAppName: 'Office',
    clientEntrypoint: 'mcmcopilot-officeweb',
    clientSessionId: req.sessionId,
    ProductCategory: 'Chat',
    clientAppType: 'Web',
    productEntryPoint: 'ChatPanel',
    deviceOS: 'Windows',
    deviceType: 'Desktop',
    clientPlatformVersion: '10',
  }

  const message: Record<string, unknown> = {
    author: 'user',
    attachments: wireAttachments,
    inputMethod: 'Keyboard',
    text,
    entityAnnotationTypes: ['People', 'File', 'Event', 'Email', 'TeamsMessage'],
    requestId: requestID,
    locationInfo: { timeZoneOffset: 8, timeZone: 'Asia/Shanghai' },
    locale: 'zh-cn',
    messageType: 'Chat',
    experienceType: 'Default',
    adaptiveCards: [],
    clientPreferences: {},
    connectedFederatedConnections: ['dummyId'],
    clientInfo,
  }

  // 图片上传后注入文件注解（messageAnnotations）
  const annotations: Record<string, unknown>[] = []
  for (const a of attachments) {
    if (a.type !== 'image' || !a.docId) continue
    const name = a.name || `image.${a.fileType || 'jpg'}`
    let fileType = a.fileType
    if (!fileType) fileType = (a.mimeType || '').replace(/^image\//, '')
    if (!fileType || fileType === 'image' || fileType === '*') fileType = 'jpg'
    annotations.push({
      id: a.docId,
      messageAnnotationMetadata: {
        '@type': 'File',
        annotationType: 'File',
        fileType,
        fileName: name,
      },
      messageAnnotationType: 'ImageFile',
    })
  }
  if (annotations.length > 0) {
    message['messageAnnotations'] = annotations
    message['connectedFederatedConnections'] = ['dummyId']
  }
  // 兼容旧网关注入路径
  for (const a of attachments) {
    if (a.type !== 'image' || !a.url) continue
    if (a.url.startsWith('data:')) {
      const comma = a.url.indexOf(',')
      if (comma >= 0 && comma + 1 < a.url.length) {
        message['imageBase64'] = a.url.substring(comma + 1)
      }
    } else {
      message['imageUrl'] = a.url
    }
    break
  }

  const optionsSets = [
    'search_result_progress_messages_with_search_queries',
    'update_textdoc_response_after_streaming',
    'deepleo_networking_timeout_10minutes_canmore',
    'cwc_flux_image',
    'cwcfluxgptv',
    'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch',
    'gptvnorm2048',
    'cwc_fileupload_odb',
    'update_memory_plugin',
    'add_custom_instructions',
    'cwc_flux_v3',
    'flux_v3_progress_messages',
    'enable_batch_token_processing',
    'enable_gg_gpt',
    'cwc_code_interpreter_v3',
    'rich_responses',
    // 静态补全缺失项（同原版 optionsSets 静态部分；不引入 FeatureFlags 条件项）
    'code-interpreter',
    'flux_v3_references',
    'image-gen-dimensions-1024x1024',
    'image-gen-dimensions-1792x1792',
  ]

  const chat = {
    arguments: [
      {
        source: 'officeweb',
        clientCorrelationId: randomUUID(),
        sessionId: req.sessionId,
        optionsSets,
        options: {},
        allowedMessageTypes: ['Chat', 'Suggestion', 'Disengaged', 'Progress', 'EndOfRequest', 'InternalLoaderMessage', 'GeneratedCode', 'SearchQuery', 'TriggerPlugin', 'MemoryUpdate', 'SideBySide', 'ReferencesListComplete', 'RichResponse', 'GenerateGraphicArt', 'GenerateContentQuery', 'RenderCardRequest', 'PromptSuggestion', 'CodeInterpreterResult', 'AudioResult', 'ImageResult', 'MeetingInsights', 'TranscriptSearch', 'DraftWithCopilot', 'MeetingTranscript', 'TranslationSuggestion', 'Citation', 'ActionCard', 'UserPromptSuggestion', 'GeneratedQuestions', 'SummaryInsights', 'SubTopicSuggestion'],
        sliceIds: [],
        threadLevelGptId: {},
        // HAR 逆向：参数层不再下发 conversationId/productThreadType/toolChoice，
        // isStartOfSession 恒为 false（WS URL 已绑定会话/对话身份，同原项目 chatPayload）
        isStartOfSession: false,
        traceId: randomUUID(),
        clientInfo,
        tone: req.tone || DEFAULT_TONE,
        streamingMode: 'ConciseWithPadding',
        message,
        plugins: buildPlugins(tools, req.mcpServerUrl),
        extraExtensionParameters: {},
        isSbsSupported: true,
        renderReferencesBehindEOS: true,
        disconnectBehavior: 'continue',
      },
    ],
    invocationId: '0',
    target: 'chat',
    type: 4,
  }
  // Metrics 帧带真实 ISO 时间戳 + RequestSent（同原项目），供 M365 侧计费/统计识别
  const nowMs = Date.now()
  const iso = (d: number) => new Date(nowMs + d).toISOString()
  const metrics = {
    arguments: [
      {
        Timestamps: {
          ConnectionStart: iso(-2000),
          UserInputStart: iso(-2000),
          ConnectionEstablished: iso(-500),
          UserInputSubmit: iso(0),
          RequestSent: iso(1),
        },
      },
    ],
    target: 'Metrics',
    type: 1,
  }
  return JSON.stringify(chat) + RS + JSON.stringify(metrics) + RS
}

/** M365 原生插件列表（与原版 clientPlugins 一致的官方插件结构，字段名须大写）。
 * mcpServerUrl 非空时附加 mcp-gateway 插件条目（同原版：Source:'MCPServer'）。 */
function clientPlugins(tools: ChatHubTool[]): Record<string, unknown>[] {
  if (!tools || tools.length === 0) return []
  const plugins: Record<string, unknown>[] = []
  for (const t of tools) {
    const f = t.function
    if (!f || !f.name) continue
    plugins.push({
      Id: f.name,
      Source: 'API',
      Description: f.description || '',
      Parameters: f.parameters ?? null,
    })
  }
  return plugins
}

function buildPlugins(tools: ChatHubTool[], mcpServerUrl?: string): Record<string, unknown>[] {
  const plugins = clientPlugins(tools)
  if (mcpServerUrl && mcpServerUrl.trim() !== '') {
    plugins.push({ Id: 'mcp-gateway', Source: 'MCPServer', ServerUrl: mcpServerUrl.trim() })
  }
  return plugins
}

/**
 * 核心对话入口：建立 WS → 握手 → 发送 payload → 流式解析事件 → 返回完整结果。
 * text delta 与 reasoning 通过 handler 即时送出，最终 Result 包含全文与推理。
 */
export async function chatWithHandlers(
  acc: ChatHubAccount,
  req: ChatHubRequest,
  opts: ChatHubOptions,
  onDelta?: (text: string) => void,
  onEvent?: (ev: ChatHubStreamEvent) => void,
): Promise<ChatHubResult> {
  if (!acc.accessToken || !acc.oid || !acc.tid) throw new Error('missing access token / oid / tid')
  if (!req.text.trim() && (!req.attachments || req.attachments.length === 0)) throw new Error('empty prompt and no attachments')

  let sessionId = req.sessionId || randomUUID()
  let conversationId = req.conversationId || randomUUID()
  const firstTurn = req.started === true || !req.sessionId || !req.conversationId
  const requestID = randomUUID()

  // 同原版 client.go：把生成的 UUID 回填进 req，保证 payload 里的
  // sessionId/conversationId 与 WS URL 一致（否则首轮 payload 两字段缺失）
  req.sessionId = sessionId
  req.conversationId = conversationId

  // 1) 上传图片附件
  if (req.attachments && req.attachments.length > 0) {
    await uploadAttachments(acc, conversationId, req.attachments, opts)
  }

  // 2) 建立出站 WS（Cloudflare 出站 WebSocket 需用 fetch + Upgrade 头，
  //    且 URL 必须把 wss:// 转成 https://，不能直接用 wss 协议 fetch。
  //    参考 openai-agents-js CloudflareRealtimeTransport：wss→https 后取 resp.webSocket.accept()）
  const wsURL = buildWSURL(acc, sessionId, conversationId, requestID)
  let socket: OutboundWebSocket
  try {
    const httpUrl = wsURL.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
    const resp = await fetch(httpUrl, {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Origin: 'https://m365.cloud.microsoft',
        // UA 与真实浏览器统一为 Chrome（同原项目 NewClient）——M365 按会话指纹的 UA 识别，避免被当作异常客户端
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    })
    if (resp.status !== 101 || !resp.webSocket) {
      const text = await resp.text().catch(() => '')
      // 读取 Retry-After 并挂到错误上，供 account-health 冷却使用（同原版 DialError.RetryAfter）
      const retryAfterRaw = resp.headers.get('retry-after')
      const err = new Error(`ws dial failed: HTTP ${resp.status} ${text.substring(0, 200)}`) as Error & { retryAfterSeconds?: number }
      if (retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim())) {
        err.retryAfterSeconds = parseInt(retryAfterRaw.trim(), 10)
      }
      throw err
    }
    socket = resp.webSocket as unknown as OutboundWebSocket
    socket.accept()
  } catch (err) {
    const wrapped = new Error(`ws dial: ${err instanceof Error ? err.message : String(err)}`) as Error & { retryAfterSeconds?: number }
    // 保留上游 Retry-After（供 account-health 冷却）
    if ((err as Error & { retryAfterSeconds?: number }).retryAfterSeconds) {
      wrapped.retryAfterSeconds = (err as Error & { retryAfterSeconds?: number }).retryAfterSeconds
    }
    throw wrapped
  }

  // 消息队列：事件驱动 → 同步式读取
  const queue: { msg?: string; err?: Error }[] = []
  const waiters: ((v: { msg?: string; err?: Error }) => void)[] = []
  let closed = false
  const push = (v: { msg?: string; err?: Error }) => {
    if (closed) return
    if (waiters.length > 0) {
      const w = waiters.shift()!
      w(v)
    } else {
      queue.push(v)
    }
  }
  socket.addEventListener('message', (e) => {
    const data = (e as MessageEvent).data
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data)
    push({ msg: text })
  })
  socket.addEventListener('close', (e) => {
    // 先入队再置 closed（push 内部会丢弃 closed 之后的项，顺序反了会导致 close 错误永远送不到读循环）
    push({ err: new Error(`ws closed: code=${(e as CloseEvent).code} reason=${(e as CloseEvent).reason || ''}`) })
    closed = true
  })
  socket.addEventListener('error', () => {
    // close 事件随后触发；这里只兜底
    push({ err: new Error('ws error') })
  })

  const next = (): Promise<{ msg?: string; err?: Error }> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!)
    if (closed) return Promise.resolve({ err: new Error('ws already closed') })
    return new Promise((resolve) => waiters.push(resolve))
  }

  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${what} (${ms}ms)`)), ms)
      p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
    })
  }

  const timeoutMs = opts.timeoutMs || 300_000
  const readTimeoutMs = opts.readTimeoutMs || 90_000
  const deadline = Date.now() + timeoutMs
  // 无语义进展超时（同原版 04f5481）：微软会保持连接却长时间不发 update/result 帧。
  // 此时不应挂满整个 timeoutMs；收到语义帧才续期 progressDeadline，否则到达截止即失败，
  // 让客户端快速感知冻结并及时重试（而非看起来卡死）。
  const progressIdleMs = 90_000
  let progressDeadline = Math.min(deadline, Date.now() + progressIdleMs)
  // 客户端断连时中止（同原版 r.Context().Done() → 取消上游对话）
  const aborted = () => opts.signal?.aborted === true

  try {
    // 3) 握手
    socket.send(`{"protocol":"json","version":1}${RS}`)
    await withTimeout(next(), 15_000, 'handshake')

    // 4) 发送 chat payload
    const payload = chatPayload(req, requestID, firstTurn)
    socket.send(payload)

    // 5) 事件循环
    const seenStreamTools = new Set<string>()
    let reasoningBuf = ''
    let finalText = ''
    let streamedText = ''
    let rawResult = ''
    let throttling: unknown
    /** 收集原生工具事件（含 messages[] 之外的插件调用），供上层 nativeToolCalls 提取 */
    const collectedEvents: unknown[] = []
    /** 收集图片 URL 的帧内容：update 帧 arguments + result 帧 item（同原版 events 全量收集） */
    const rawFrames: unknown[] = []

    /** 调试：上报 ChatHub 原始文本（增量/快照/最终消息），供上层排查换行与格式来源 */
    const debugEmit = (tag: string, text: string): void => {
      if (!opts.debug || !opts.onDebug || !text) return
      try { opts.onDebug(tag, text) } catch { /* ignore */ }
    }

    const rateLimited = (text: string): boolean => {
      if (streamedText !== '') return false
      const t = text.toLowerCase()
      return (
        t.includes('temporarily unable to respond to this many requests') ||
        t.includes('太多请求') ||
        t.includes('无法响应这么多请求') ||
        t.includes('too many requests') ||
        (t.includes('please retry') && t.includes('later'))
      )
    }

    // 图片额度耗尽检测（同原版 imageLimitDetected：仅在无已流式文本时判定）
    const imageLimitDetected = (text: string): boolean => {
      if (streamedText !== '') return false
      const t = text.toLowerCase()
      return (
        t.includes('无法生成更多图像') ||
        t.includes('unable to generate more images') ||
        t.includes('cannot generate more images today')
      )
    }

    const contentPolicyDetected = (text: string): boolean => {
      if (streamedText !== '') return false
      return isContentPolicyBlock(text)
    }

    // 非前缀重写被 emitSnapshot 跳过的次数统计：这些片段可能让流式文本不完整
    // （甚至偏离最终答案），complete 时用 finalizeText 以最终消息兜底对齐。
    let skippedSnapshots = 0

    // ChatHub 以"全量快照 + 光标重写"方式送文本，只输出未见过的后缀。
    // 对齐原版 client.go emitSnapshot：仅当新快照以前缀命中当前文本时才补发尾部，
    // 非前缀的重写直接跳过，避免吐出重复/错乱片段。
    const emitSnapshot = (snapshot: string): void => {
      if (!snapshot) return
      debugEmit('chathub-snapshot', snapshot)
      // 同原版顺序：图片额度 → 限流 → 内容策略
      if (imageLimitDetected(snapshot)) throw new Error('upstream image generation daily limit reached')
      if (rateLimited(snapshot)) throw new Error('upstream rate-limit notice')
      if (contentPolicyDetected(snapshot)) throw new Error('upstream content policy flagged as offensive')
      const cur = streamedText
      if (cur === '') {
        streamedText = snapshot
        onDelta?.(snapshot)
        return
      }
      if (snapshot.startsWith(cur)) {
        const tail = snapshot.substring(cur.length)
        if (tail) { streamedText = snapshot; onDelta?.(tail) }
        return
      }
      // 非前缀重写：原版跳过（仅记录），这里不做任何透出
      skippedSnapshots++
    }

    while (Date.now() < deadline) {
      if (aborted()) throw new Error('request aborted by client')
      // 无语义进展超时检查：本次读帧前若已越过进度截止，说明期间无任何语义帧 → 抛错
      if (Date.now() >= progressDeadline) throw new Error('CHAT_PROGRESS_TIMEOUT')
      const read = await withTimeout(next(), Math.min(readTimeoutMs, Math.max(0, progressDeadline - Date.now())), 'ws message')
      if (read.err) {
        // 读等待本身跨过了进度截止：同样按无语义进展超时处理
        if (Date.now() >= progressDeadline) throw new Error('CHAT_PROGRESS_TIMEOUT')
        throw read.err
      }
      if (!read.msg) continue
      let semanticProgress = false

      const parts = read.msg.split(RS)
      for (const partRaw of parts) {
        const part = partRaw.trim()
        if (!part) continue
        const frame = normalizeFrame(part)
        if (!frame) continue

        // SignalR ping
        if (frame.type === 6) {
          try { socket.send(`{"type":6}${RS}`) } catch { /* ignore */ }
          continue
        }

        // update：流式文本 / 推理 / 工具 / 进度
        if (frame.type === 1 && frame.target === 'update') {
          // update 帧即视为存在语义进展（同原版 04f5481：语义帧才续期进度截止）
          semanticProgress = true
          if (frame.arguments && Array.isArray(frame.arguments)) rawFrames.push(...frame.arguments)
          for (const arg of frame.arguments || []) {
            if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue
            const a = arg as Record<string, unknown>
            const toolEvents = extractToolEvents(a, seenStreamTools)
            if (toolEvents.length > 0) {
              collectedEvents.push(...toolEvents)
              if (onEvent) for (const ev of toolEvents) onEvent(ev)
            }
            const msgs = Array.isArray(a['messages']) ? (a['messages'] as unknown[]) : []
            for (const ev of classifyUpdateMessages(msgs)) {
              if (ev.kind === 'reasoning') reasoningBuf += ev.text || ''
              if (ev.kind !== 'text' && onEvent) onEvent(ev)
            }
            // 判断工具帧（跳过光标文本，工具帧的 writeAtCursor 不应当作答案输出）
            let toolFrame = false
            for (const mraw of msgs) {
              if (!mraw || typeof mraw !== 'object') continue
              const m = mraw as Record<string, unknown>
              if (m['messageType'] === 'Progress' || m['contentType'] === 'SearchResults' || m['contentType'] === 'Code' || m['contentType'] === 'ToolCall') {
                toolFrame = true
                break
              }
            }
            if (a['throttling'] !== undefined) throttling = a['throttling']
            const wac = a['writeAtCursor']
            if (typeof wac === 'string' && wac !== '' && !toolFrame) {
              debugEmit('chathub-delta', wac)
              // HAR 05：writeAtCursor 是纯 append 增量。一旦存在文本基线就把它直接作 delta 透出，
              // 避免把 33-47 个 cursor 帧折叠成 2-3 个巨大快照（同原项目 client.go：streamed 非空走 emitDelta）。
              if (streamedText !== '') { streamedText += wac; onDelta?.(wac) }
              else emitSnapshot(wac)
            }
            for (const mraw of msgs) {
              if (!mraw || typeof mraw !== 'object') continue
              const m = mraw as Record<string, unknown>
              if (m['author'] === 'bot' && (m['messageType'] || '') === '' && typeof m['text'] === 'string' && m['text'] !== '') {
                emitSnapshot(m['text'] as string)
              }
            }
          }
          continue
        }

        // result：最终结果帧
        if (frame.type === 2) {
          // 收到 result 帧即视为语义进展（同原版 04f5481）
          semanticProgress = true
          const item = frame.item as Record<string, unknown> | undefined
          if (item) {
            // 图片 URL 也可能只出现在 result 帧（item/result 元数据）：一并纳入收集
            rawFrames.push(item)
            if (item['throttling'] !== undefined) throttling = item['throttling']
            const res = item['result'] as Record<string, unknown> | undefined
            if (res) {
              if (typeof res['value'] === 'string') {
                rawResult = res['value']
                debugEmit('chathub-result', rawResult)
              }
              if (typeof res['message'] === 'string') {
                finalText = res['message']
                debugEmit('chathub-result', finalText)
                // 同原版 type=2 分支：final 消息三类检测（内容策略此处不带 streamed 守卫）
                if (imageLimitDetected(finalText)) throw new Error('upstream image generation daily limit reached')
                if (rateLimited(finalText)) throw new Error('upstream rate-limit notice')
                if (isContentPolicyBlock(finalText)) throw new Error('upstream content policy flagged as offensive')
              }
            }
          }
          continue
        }

        // complete：结束
        if (frame.type === 3) {
          if (frame.error) throw new Error(`chathub completion error: ${JSON.stringify(frame.error)}`)
          // 同原版：先检查 final 是否限流，避免限流提示经 finalizeText 泄漏给客户端
          if (rateLimited(finalText)) throw new Error('upstream rate-limit notice')
          // 以最终消息对齐流式文本：流式漏掉的尾部在这里补发（原版 finalizeText）
          const text = finalizeText(streamedText, finalText || streamedText, onDelta)
          debugEmit('chathub-final', text)
          if (imageLimitDetected(text)) throw new Error('upstream image generation daily limit reached')
          if (rateLimited(text)) throw new Error('upstream rate-limit notice')
          if (isContentPolicyBlock(text)) throw new Error('upstream content policy flagged as offensive')
          // 空返回：既无正文也无工具/推理事件 → 视为空完成（同原版 ErrEmptyCompletion）
          if (text.trim() === '' && reasoningBuf.trim() === '' && collectedEvents.length === 0) {
            throw new Error('empty completion')
          }
          return {
            text,
            reasoning: reasoningBuf,
            conversationId,
            sessionId,
            requestId: requestID,
            events: collectedEvents,
            rawResult,
            throttling,
            images: imageURLs(rawFrames),
          }
        }
      }
      // 本次读到的消息中存在语义帧 → 续期进度截止
      if (semanticProgress) {
        progressDeadline = Math.min(deadline, Date.now() + progressIdleMs)
      }
    }
    throw new Error('chathub response deadline exceeded before completion')
  } finally {
    try { socket.close() } catch { /* ignore */ }
  }
}
