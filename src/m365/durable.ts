/**
 * M365 Session Durable Object。
 *
 * 职责：
 * 1. 串行化同一会话的并发请求（ChatHub 不支持同一 conversation 并发）
 * 2. 承载 ChatHub WS 对话（事件流 → OpenAI SSE / JSON）
 * 3. 会话绑定读写在 KV（复用 session.ts），DO 作为执行隔离点
 *
 * Worker 入口：`env.M365_SESSION.get(sessionKey).fetch(chatRequest)`
 * 其中 sessionKey = providerId + ':' + explicitSessionId | contextFingerprint
 */
import type { Env } from '../types'
import { chatWithHandlers, classifyChatHubNotice } from './chathub'
import type { ChatHubAccount, ChatHubTool, ChatHubResult } from './chathub'
import { flattenPromptMessages, modelToolRouterPrompt, parseModelToolDecision, fencedToolCalls, nativeToolCalls, compactToolResult, buildAgentLedger, ledgerRouterContext, filterCompletedCalls, validateDetectedToolCalls, completionEvidenceAllows, isToolRefusal } from './tools'
import type { DetectedToolCall, AgentLedger, OaiMsgLite } from './tools'
import { resolveSession, bindSession } from './session'
import type { ResolveResult } from './session'
import { listM365Accounts } from './oauth'
import { recordConversation, shouldCleanup, cleanupConversations, getCleanupMode, getCleanupConfig } from './conversation-manager'
import { markAccountSuccess, markAccountFailure, markAccountImageLimited, accountCooldownSeconds, isAccountAvailable, isRateLimited, isAuthFailure, isEmptyCompletion, confirmAndMarkRateLimit } from './account-health'
import type { RateLimitProbeFn } from './account-health'
import { writeLog } from '../admin'
import { acquireSlot, releaseSlot, fluxSnapshot } from './account-flux'

export interface M365ChatPayload {
  providerId: string
  model: string
  /** OpenAI chat body（messages/tools/tool_choice/stream 等） */
  body: Record<string, unknown>
  stream: boolean
  explicitSessionId?: string
  /** 客户端指定使用的账号（oid），缺省由网关轮询/failover */
  explicitAccountId?: string
  user?: string
  ip?: string
  userAgent?: string
  /**
   * 租户标识：调用方 API Key 的不可逆哈希（由网关 auth 中间件计算透传）。
   * 用于会话绑定/复用的租户隔离，杜绝跨 Key 读取他人云端对话。
   */
  tenant?: string
}

interface ChatOutcome {
  text: string
  reasoning: string
  conversationId: string
  sessionId: string
  toolCalls: DetectedToolCall[]
  /** 附加元数据（conversation/images/throttling 等，非流式响应透传为 m365 块） */
  metadata?: Record<string, unknown>
}

function sha256Hex(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ s.charCodeAt(i)) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** 估算 token 数（同原版 EstimateTokens：英文按 4 字符，中文按 1.5 字符） */
export function estimateTokens(s: string): number {
  if (!s) return 0
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const other = s.length - cjk
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4)
}

export class M365Session {
  env: Env
  /** 会话串行队列：同一 DO 实例的请求逐个执行 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    this.env = env
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/chat' && request.method === 'POST') {
      let payload: M365ChatPayload
      try {
        payload = (await request.json()) as M365ChatPayload
      } catch {
        return cjson({ error: { message: 'bad json', type: 'invalid_request_error' } }, 400)
      }
      return this.enqueue(() => this.handleChat(payload))
    }
    return cjson({ error: { message: 'not found', type: 'not_found' } }, 404)
  }

  private async handleChat(payload: M365ChatPayload): Promise<Response> {
    const { providerId, model, body, stream, explicitSessionId, explicitAccountId, user, ip, userAgent, tenant } = payload
    const messages = (body['messages'] as Array<Record<string, unknown>>) || []
    const tools = (body['tools'] as unknown[]) || []
    const toolChoice = body['tool_choice']

    // 1) 会话解析（显式 ID / 内容键），按租户（API Key 哈希）隔离
    const ctx = { explicitSessionId, user, ip, userAgent, tenant: payload.tenant }
    const resolved = await resolveSession(this.env, providerId, messages as never[], ctx)

    // 2) 构建 ChatHub 请求：messages 扁平化为单文本 prompt；复用命中只发增量
    const { prompt, attachments } = flattenPromptMessages(messages as never[])
    let answerPrompt = prompt
    if (!resolved.isNew && resolved.historyLen > 0 && resolved.historyLen < messages.length) {
      const inc = flattenPromptMessages(messages.slice(resolved.historyLen) as never[])
      if (inc.prompt.trim() !== '') {
        answerPrompt = inc.prompt
        attachments.length = 0
        attachments.push(...inc.attachments)
      }
    }

    const toolDefs: ChatHubTool[] = tools.map((t) => {
      const obj = t as Record<string, unknown>
      const f = (obj['function'] || {}) as Record<string, unknown>
      return { type: typeof obj['type'] === 'string' ? obj['type'] : 'function', function: { name: String(f['name'] || ''), description: typeof f['description'] === 'string' ? f['description'] : undefined, parameters: f['parameters'] } }
    })

    // 多轮工具证据 ledger：从 messages 历史解析已完成/待处理的工具调用，去重并注入上下文
    const ledger: AgentLedger = buildAgentLedger(messages as OaiMsgLite[])
    const ledgerCtx = ledger.toolRounds > 0 ? ledgerRouterContext(ledger) : ''

    // 3) 账号池选择：见 selectAccounts 注释。返回按尝试顺序排好的候选账号。
    const ordered = await this.selectAccounts(providerId, resolved, explicitAccountId)
    if (ordered.length === 0) {
      if (explicitAccountId) {
        return cjson({ error: { message: '指定的 M365 账号（m365_account_id）不存在或不可用', type: 'account_error' } }, 404)
      }
      // 全部账号处于冷却/不可用：对齐原版返回 429 + Retry-After（戴避账号被打爆），而非 401
      return cjson({ error: { message: 'M365 所有账号繁忙或冷却中，请稍后重试或先在后台添加/授权账号', type: 'rate_limit_error' } }, 429, { 'Retry-After': '60' })
    }
    const acc = ordered[0]

    // 4) 工具路由：带 tools 且 toolChoice != none 时，先发起一次独立的路由对话，
    //    注入完整工具定义 + ledger 证据让模型显式决策是否调用工具（同原版 planningMode="router"）。
    //    路由对话是临时会话（started=true，不绑定持久会话）。
    const choiceStr = String(toolChoice ?? 'auto').toLowerCase()
    let toolRouterFailed = false
    if (toolDefs.length > 0 && choiceStr !== 'none') {
      let route: Awaited<ReturnType<typeof this.tryToolRouter>> | null = null
      const routerAcquired = await acquireSlot(this.env, providerId, acc.oid)
      try {
        route = await this.tryToolRouter(acc, answerPrompt, toolDefs, toolChoice, attachments, ledgerCtx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const detail = `model=${model} tools=${toolDefs.length} promptLen=${answerPrompt.length} err=${msg}`
        try { await writeLog(this.env, 'error', `[m365-chat] provider=${providerId} → tool router failed, falling back to main chat`, detail) } catch { /* ignore */ }
        toolRouterFailed = true
      } finally {
        if (routerAcquired) await releaseSlot(this.env, providerId, acc.oid)
      }
      if (route && route.calls.length > 0) {
        // 有工具调用：直接返回 tool_calls 给客户端（客户端执行后再续聊）
        const outcome: ChatOutcome = {
          text: '',
          reasoning: route.res.reasoning || '',
          conversationId: route.res.conversationId,
          sessionId: route.res.sessionId,
          toolCalls: route.calls,
        }
        const id = 'chatcmpl-' + crypto.randomUUID()
        return stream ? buildSSE(id, model, outcome, payload) : buildJSON(id, model, outcome)
      }
      if (route && route.requiredFailed) {
        const detail = `model=${model} tools=${toolDefs.length} promptLen=${answerPrompt.length}`
        try { await writeLog(this.env, 'error', `[m365-chat] provider=${providerId} → model did not select a required tool`, detail) } catch { /* ignore */ }
        return cjson({ error: { message: 'model did not select a required tool after constrained retry', type: 'tool_required' } }, 502)
      }
    }

    // 5) 执行主回答对话（持久会话），带账号级 failover：
    //    限流/鉴权失败且为"新会话"时自动切换到下一个健康账号重试；已绑定会话不切号（云端对话归属该账号）。
    let mainPrompt = answerPrompt
    if (ledger.completed.length > 0 || ledger.pending.length > 0) mainPrompt += '\n' + ledgerCtx
    if (ledger.completed.length > 0) mainPrompt += '\nFINAL ANSWER RULE: Report only actions supported by completed tool results. If the goal is not fully verified, state exactly what remains unconfirmed.'

    // 工具路由 WS 失败时，主回答也不带工具（避免级联失败），上层仍可得到纯文本回复
    const mainTools = toolRouterFailed ? [] : toolDefs
    const mainChoice = toolRouterFailed ? 'none' : toolChoice

    let streamedText = ''
    let reasoning = ''
    let result: Awaited<ReturnType<typeof chatWithHandlers>> | undefined
    let usedAcc = acc
    let failoverLastResp: Response | null = null
    let allBusy = false
    for (let i = 0; i < ordered.length; i++) {
      usedAcc = ordered[i]
      // 并发闸门：占用该账号一个并发位；满则轮询等待，超时后该账号视为"忙"试下一个
      const acquired = await acquireSlot(this.env, providerId, usedAcc.oid)
      if (!acquired) {
        allBusy = true
        continue
      }
      try {
        result = await chatWithHandlers(
          usedAcc,
          {
            text: mainPrompt,
            conversationId: resolved.isNew ? undefined : resolved.conversationId,
            sessionId: resolved.isNew ? undefined : resolved.sessionId,
            started: resolved.isNew,
            attachments,
            tools: mainTools,
            toolChoice: mainChoice,
          },
          { timeoutMs: 300_000 },
          (delta) => { streamedText += delta },
          (ev) => { if (ev.kind === 'reasoning') reasoning += ev.text || '' },
        )
        break
      } catch (err) {
        // 记录完整 ChatHub 错误（含微软服务端返回的 detail）便于排查真实对话 500
        const msg = err instanceof Error ? err.message : String(err)
        const errObj = err instanceof Error ? err : new Error(msg)
        // 限流先做二次确认探测（误报不冷却），鉴权/其他失败直接标记
        if (isRateLimited(errObj)) {
          await confirmAndMarkRateLimit(this.env, usedAcc.oid, errObj, this.createRateLimitProbe(usedAcc))
        } else {
          await markAccountFailure(this.env, usedAcc.oid, errObj)
        }
        const cls = classifyChatHubNotice(msg)
        const detail =
          `model=${model} isNew=${resolved.isNew} account=${usedAcc.oid} tools=${toolDefs.length} ` +
          `promptLen=${mainPrompt.length} stream=${stream} historyLen=${resolved.historyLen} ` +
          `err=${msg}`
        try { await writeLog(this.env, 'error', `[m365-chat] provider=${providerId} → ${msg}`, detail) } catch { /* ignore */ }

        if (cls === 'image_quota') {
          // 图片额度耗尽：标记该账号 24h 封禁并返回 429（同原版 MarkImageLimited）
          await markAccountImageLimited(this.env, usedAcc.oid, 24)
          return cjson({ error: { message: 'M365 image generation quota is exhausted; try again later or use another account', type: 'rate_limit_error' } }, 429, { 'Retry-After': '86400' })
        }
        failoverLastResp = this.mapChatError(msg)
        const canFailover = isRateLimited(errObj) || isAuthFailure(errObj)
        // 上游限流/鉴权失败且为全新会话时允许切号；已绑定会话直接返回退避响应
        if (!canFailover || !resolved.isNew) return failoverLastResp
        if (i === ordered.length - 1) return failoverLastResp
      } finally {
        await releaseSlot(this.env, providerId, usedAcc.oid)
      }
    }
    if (!result) {
      // 全部候选忙（并发闸门打满）或全部失败
      if (failoverLastResp) return failoverLastResp
      if (allBusy) {
        return cjson({ error: { message: 'all M365 accounts are busy or rate-limited; try again shortly', type: 'rate_limit_error' } }, 429, { 'Retry-After': '5' })
      }
      return cjson({ error: { message: 'upstream failed on all accounts', type: 'upstream_error' } }, 502)
    }
    streamedText = streamedText || result.text

    // 主回答兜底 1：模型错误拒绝使用工具时，发起纠正对话重试（同原版 isToolRefusal）
    if (toolDefs.length > 0 && isToolRefusal(result.text || streamedText)) {
      const correction =
        'Your previous response incorrectly denied that caller tools are available. They are real, active, and callable on the caller\'s Windows machine. Call the appropriate tool now. Do not explain tool availability.\n\nUser request:\n' + mainPrompt
      const corrAcquired = await acquireSlot(this.env, providerId, usedAcc.oid)
      try {
        const corrRes = await chatWithHandlers(usedAcc, { text: correction, conversationId: resolved.isNew ? undefined : resolved.conversationId, sessionId: resolved.isNew ? undefined : resolved.sessionId, started: resolved.isNew, attachments }, { timeoutMs: 300_000 })
        if (!isToolRefusal(corrRes.text)) {
          result = { ...corrRes, events: result.events }
          streamedText = corrRes.text
        }
      } catch { /* keep original result */ } finally {
        if (corrAcquired) await releaseSlot(this.env, providerId, usedAcc.oid)
      }
    }

    // 主回答兜底 2：提取工具调用。先 fenced block（<m365-tool-call> / ```name\n{json}```），再原生工具事件；用 ledger 过滤已完成调用
    const rawCalls: DetectedToolCall[] =
      fencedToolCalls(result.text || streamedText, toolDefs, toolChoice)
    const allCalls = rawCalls.length > 0 ? rawCalls : nativeToolCalls(result.events, toolDefs)
    // 信任边界：模型输出不可信，二次校验（未知工具/参数不合 schema 一律剔除）
    const validated = validateDetectedToolCalls(allCalls, toolDefs)
    if (validated.dropped > 0) {
      console.warn(`[m365:${providerId}] 剔除 ${validated.dropped} 个不合规工具调用（信任边界校验）`)
    }
    const calls = filterCompletedCalls(validated.calls, ledger)

    let finalText = result.text
    // 兜底 3：若存在工具证据但回答声称"已完成"，且无匹配工具结果，则替换为未确认措辞
    if (toolDefs.length > 0 && !completionEvidenceAllows(finalText, ledger)) {
      finalText = 'I cannot confirm completion because no matching tool results were returned. No external action has been verified.'
    }

    const outcome: ChatOutcome = {
      text: finalText,
      reasoning: result.reasoning || reasoning,
      conversationId: result.conversationId,
      sessionId: result.sessionId,
      toolCalls: calls,
      metadata: {
        conversationId: result.conversationId,
        images: result.images,
        throttling: result.throttling ?? undefined,
      },
    }

    // 6) 绑定会话（记录全量历史 + 助手回复），把实际使用的账号 oid 记为 accountId
    // 只绑定正文（同原版 Bind：Content 与 ReasoningContent 分离）——reasoning 拼进 content
    // 会导致下一轮客户端回放的纯文本 assistant 消息前缀失配，会话复用退化为每轮新建
    await bindSession(this.env, providerId, outcome.sessionId, outcome.conversationId, usedAcc.oid || providerId, messages as never[], outcome.text, ctx)

    // 标记账户健康：成功
    await markAccountSuccess(this.env, usedAcc.oid)

    // 7) 对话管理器：记录云端对话 + 按模式清理
    const promptText = typeof messages[messages.length - 1]?.['content'] === 'string'
      ? String(messages[messages.length - 1]['content']).substring(0, 100)
      : ''
    await recordConversation(this.env, providerId, outcome.conversationId, usedAcc.oid || providerId, promptText)
    if (await shouldCleanup(this.env, providerId)) {
      const cfg = await getCleanupConfig(this.env, providerId)
      const mode = await getCleanupMode(this.env, providerId)
      const maxAgeMs = cfg.maxAgeHours * 60 * 60 * 1000
      // 收集活跃对话（当前会话绑定中的对话）
      const activeIds = new Set<string>()
      activeIds.add(outcome.conversationId)
      const cleaned = await cleanupConversations(this.env, providerId, mode, cfg.keepN, maxAgeMs, activeIds)
      if (cleaned.length > 0) {
        console.log(`[conversation-manager] auto-cleaned ${cleaned.length} conversations`)
      }
    }

    const id = 'chatcmpl-' + crypto.randomUUID()
    if (stream) {
      return buildSSE(id, model, outcome, payload)
    }
    return buildJSON(id, model, outcome)
  }

  /**
   * 账号池选择（多账号 failover 的入口）：
   * - 已绑定会话（非新）：只返回绑定的账号（oid）；该账号若不在池中/不健康则返回空（走 401/退避）。
   * - 新会话：返回所有健康账号，按最近未用优先（round-robin），便于在限流/鉴权失败时切号重试。
   * 返回按尝试顺序排列的 ChatHubAccount 候选数组。
   */
  private async selectAccounts(providerId: string, resolved: ResolveResult, explicitAccountId?: string): Promise<ChatHubAccount[]> {
    const accounts = await listM365Accounts(this.env, providerId)
    if (accounts.length === 0) return []
    const snapshot: { limit: number; inflight: Record<string, number> } =
      await fluxSnapshot(this.env, providerId).catch(() => ({ limit: 8, inflight: {} }))
    const healthy: ChatHubAccount[] = []
    for (const a of accounts) {
      if (!a.accessToken || !a.oid) continue
      if (!(await isAccountAvailable(this.env, a.oid))) continue
      // 并发闸门：已打满（inflight >= limit）的账号视为不可用，避免选到忙号
      const inflight = snapshot.inflight[a.oid] || 0
      if (inflight >= snapshot.limit) continue
      healthy.push({ accessToken: a.accessToken, oid: a.oid, tid: a.tid })
    }
    // 客户端显式指定账号：仅用该账号（须在池中且健康）
    if (explicitAccountId && explicitAccountId !== '') {
      const target = healthy.find((a) => a.oid === explicitAccountId)
      return target ? [target] : []
    }
    if (!resolved.isNew && resolved.accountId) {
      // 已绑定会话：仅允许使用绑定账号（云端对话归属它）
      const pinned = healthy.find((a) => a.oid === resolved.accountId)
      return pinned ? [pinned] : []
    }
    if (resolved.isNew && resolved.accountId) {
      // 新会话但存在 content 指纹命中的历史账号偏好：优先复用，其次健康账号轮询
      const pref = healthy.find((a) => a.oid === resolved.accountId)
      if (pref) return [pref, ...healthy.filter((a) => a.oid !== resolved.accountId)]
    }
    return healthy
  }

  /** 限流二次确认探测：用最小消息发全新 ChatHub 对话，30s 内成功即判定上次限流为误报（不冷却） */
  private createRateLimitProbe(account: ChatHubAccount): RateLimitProbeFn {
    return async () => {
      try {
        await chatWithHandlers(
          account,
          { text: 'Reply with exactly: OK', conversationId: undefined, sessionId: undefined, started: true, attachments: undefined },
          { timeoutMs: 30_000 },
        )
        // 成功取到回复 → 上次限流是误报，不标记冷却
        return false
      } catch (probeErr) {
        // 探测仍限流/失败 → 确认限流
        console.log(`[m365:rate-limit-probe] ${account.oid} still failing: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`)
        return true
      }
    }
  }

  /** 把主回答的 ChatHub 错误归类为合适的 HTTP 响应（429/401/502/500） */
  private mapChatError(msg: string): Response {
    const cls = classifyChatHubNotice(msg)
    if (cls === 'rate_limit') {
      return cjson({ error: { message: 'upstream is rate limiting; try again shortly', type: 'rate_limit_error' } }, 429, { 'Retry-After': '60' })
    }
    if (cls === 'content_policy') {
      return cjson({ error: { message: 'M365 upstream declined the request due to content policy; try rephrasing', type: 'content_policy' } }, 502)
    }
    if (isRateLimited(msg)) {
      return cjson({ error: { message: 'upstream is rate limiting; try again shortly', type: 'rate_limit_error' } }, 429, { 'Retry-After': '60' })
    }
    if (isAuthFailure(msg)) {
      return cjson({ error: { message: 'M365 account authentication failed; re-authorize required', type: 'auth_error' } }, 401)
    }
    // 兜底：不再把原始上游错误透给客户端（对齐原版统一 502、不泄漏内部细节）。
    // 详细原因写日志便于排查，端侧只给通用提示。
    return cjson({ error: { message: 'upstream M365 ChatHub error; please retry later', type: 'upstream_error' } }, 502)
  }

  /**
   * 工具路由对话：注入完整工具定义 + ledger 证据让模型决策是否调用工具。
   * 返回 { calls, res, requiredFailed }；无工具调用或未带 tools 时返回 null（走主回答）。
   * 路由对话使用独立临时会话（started=true），不绑定持久会话，避免污染多轮上下文。
   */
  private async tryToolRouter(
    acc: ChatHubAccount,
    prompt: string,
    toolDefs: ChatHubTool[],
    toolChoice: unknown,
    attachments: { type: 'image'; url: string }[],
    ledgerCtx: string,
  ): Promise<{ calls: DetectedToolCall[]; res: ChatHubResult; requiredFailed?: boolean } | null> {
    if (toolDefs.length === 0) return null
    const choiceStr = String(toolChoice ?? 'auto').toLowerCase()
    if (choiceStr === 'none') return null

    const opts = { timeoutMs: 300_000 }
    const routePrompt = modelToolRouterPrompt(prompt + (ledgerCtx ? '\n' + ledgerCtx : ''), toolDefs, toolChoice)
    // 路由对话是"决策是否调用工具"的辅助轮：上游限流/异常时优雅降级（返回 null 走主回答），
    // 不应让一次可选的决策对话因限流而阻断整个请求（同原版 failover 对路由阶段限流不致命）。
    let routeRes: Awaited<ReturnType<typeof chatWithHandlers>>
    try {
      routeRes = await chatWithHandlers(acc, { text: routePrompt, started: true, attachments }, opts)
    } catch {
      return null
    }
    let { calls, parsed } = parseModelToolDecision(routeRes.text, toolDefs, toolChoice)
    if (!parsed) {
      // 修复对话：让模型输出纯 JSON envelope
      const repairPrompt =
        'Repair this tool routing output into JSON only with shape {"calls":[{"name":"function_name","arguments":{}}]}. ' +
        'Do not invent calls; use {"calls":[]} if unrecoverable. OUTPUT:\n' +
        compactToolResult(routeRes.text, 6000)
      try {
        const repairRes = await chatWithHandlers(acc, { text: repairPrompt, started: true, attachments }, opts)
        const r2 = parseModelToolDecision(repairRes.text, toolDefs, toolChoice)
        if (r2.parsed) {
          calls = r2.calls
          return { calls, res: repairRes }
        }
      } catch { /* fall through */ }
      // 解析失败：非 required 时降级走主回答；required 时视为选择失败
      if (choiceStr !== 'required') return null
      return { calls: [], res: routeRes, requiredFailed: true }
    }
    // tool_choice='required' 时必须调用工具：路由判定无调用时强制重试（注入完整工具定义）
    if (calls.length === 0 && choiceStr === 'required') {
      const retryPrompt =
        'Select at least one required next tool call from FUNCTION_DEFINITIONS. Validate every argument against its schema. ' +
        'Return JSON only as {"calls":[{"name":"function_name","arguments":{}}]}.\n' +
        'APPLICATION_REQUEST_AND_EVIDENCE:\n' + prompt + (ledgerCtx ? '\n' + ledgerCtx : '') + '\nFUNCTION_DEFINITIONS:\n' + JSON.stringify(toolDefs)
      try {
        const retryRes = await chatWithHandlers(acc, { text: retryPrompt, started: true, attachments }, opts)
        const r3 = parseModelToolDecision(retryRes.text, toolDefs, toolChoice)
        if (r3.parsed && r3.calls.length > 0) return { calls: r3.calls, res: retryRes }
      } catch { /* fall through */ }
      return { calls: [], res: routeRes, requiredFailed: true }
    }
    if (calls.length === 0) return null
    return { calls, res: routeRes }
  }
}

function cjson(data: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } })
}

function buildJSON(id: string, model: string, o: ChatOutcome): Response {
  const pt = estimateTokens(o.text) + (o.reasoning ? estimateTokens(o.reasoning) : 0)
  const ct = pt
  const msg: Record<string, unknown> = { role: 'assistant', content: o.text }
  if (o.reasoning) msg['reasoning_content'] = o.reasoning
  let finish: string = 'stop'
  if (o.toolCalls.length > 0) {
    msg['tool_calls'] = o.toolCalls.map((tc) => ({ id: tc.id, type: tc.type, function: { name: tc.name, arguments: tc.arguments } }))
    finish = 'tool_calls'
  }
  const usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId }
  const resp: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage,
  }
  if (o.metadata && Object.keys(o.metadata).length) {
    resp['m365'] = o.metadata
  }
  return cjson(resp, 200)
}

function buildSSE(id: string, model: string, o: ChatOutcome, payload: M365ChatPayload): Response {
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const pt = estimateTokens(o.text) + (o.reasoning ? estimateTokens(o.reasoning) : 0)
  const ct = pt
  const chunks: Uint8Array[] = []

  const base = (delta: Record<string, unknown>, finish: unknown, extra: Record<string, unknown> = {}): string => {
    const chunk: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }
    for (const [k, v] of Object.entries(extra)) chunk[k] = v
    return 'data: ' + JSON.stringify(chunk) + '\n\n'
  }
  const push = (s: string) => chunks.push(encoder.encode(s))

  const first: Record<string, unknown> = { role: 'assistant', content: '' }
  if (o.reasoning) first['reasoning_content'] = o.reasoning
  push(base(first, null))

  if (o.toolCalls.length > 0) {
    // 工具块外的前置文本
    if (o.text.trim() !== '') push(base({ content: o.text }, null))
    o.toolCalls.forEach((tc, i) => {
      const args = tc.arguments || ''
      if (args.length <= 512) {
        push(base({ tool_calls: [{ index: i, id: tc.id, type: tc.type, function: { name: tc.name, arguments: args } }] }, null))
        return
      }
      // 大参数按 512 字符分块，且不切断 UTF-16 代理对（对齐原版 writeToolResponse 分块语义）
      let offset = 0
      let first = true
      while (offset < args.length) {
        let end = Math.min(offset + 512, args.length)
        if (end < args.length) {
          while (end > offset) {
            const prev = args.charCodeAt(end - 1)
            const cur = args.charCodeAt(end)
            if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) end--
            else break
          }
          if (end === offset) end = Math.min(offset + 512, args.length)
        }
        const frag = args.substring(offset, end)
        if (first) {
          push(base({ tool_calls: [{ index: i, id: tc.id, type: tc.type, function: { name: tc.name, arguments: frag } }] }, null))
          first = false
        } else {
          push(base({ tool_calls: [{ index: i, function: { arguments: frag } }] }, null))
        }
        offset = end
      }
    })
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  } else if (o.reasoning) {
    // 推理先行，正文逐字流式
    push(base({ reasoning_content: o.reasoning }, null))
    push(base({ content: o.text }, null))
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  } else {
    push(base({ content: o.text }, null))
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  }
  push('data: [DONE]\n\n')

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } })
}

/**
 * 计算会话路由键（DO instance 分片）。
 * tenant 参与分片：不同 API Key 永远落在不同的 DO 实例 / 绑定域，杜绝跨 Key 串号。
 */
export function sessionKey(providerId: string, explicitSessionId: string | undefined, messages: Array<Record<string, unknown>> | undefined, tenant?: string): string {
  const t = tenant || ''
  if (explicitSessionId) return `${providerId}:t:${t}:ex:${explicitSessionId}`
  if (messages && messages.length > 0) {
    const parts: string[] = []
    const limit = Math.min(messages.length, 3)
    for (let i = messages.length - limit; i < messages.length; i++) {
      const m = messages[i]
      parts.push(`${m['role']}:${typeof m['content'] === 'string' ? String(m['content']).substring(0, 200) : JSON.stringify(m['content'] || '')}`)
    }
    return `${providerId}:t:${t}:ctx:${sha256Hex(parts.join('||'))}`
  }
  return `${providerId}:t:${t}:ex:${crypto.randomUUID()}`
}