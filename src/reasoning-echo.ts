/**
 * reasoning-echo.ts — agentrouter 思考模式的「thinking 回传」补齐。
 *
 * 背景（2026-10-22 实测）：agentrouter 的 `deepseek-v4-flash` 是 **Anthropic 形状**的
 * 思考模式（社区结论：该模型只能走 Anthropic 模式，OpenAI 兼容入口是转译层）。它要求
 * 会话历史里**每一条** assistant 消息都把它那轮的思考原样带回，缺一轮就让下一次请求
 * 整次 400：
 *
 *   The `content[].thinking` in the thinking mode must be passed back to the API.
 *
 * 第一版（`66a6fe8`）照 DeepSeek 官方的 compat 规则补**空串** `""`，线上验证**仍然 400**：
 * 客户端侧的 `requiresReasoningContentOnAssistantMessages` 本来就会补 `""`（pi-ai
 * openai-completions 的同一段逻辑），也就是说空串形态上游不认——转译层把空 thinking
 * 当「没带」处理。因此这里改补**非空占位串**（单个空格），与 workbuddy 上游那条
 * `len(reasoning)>0` 的校验同构：只要求字段**有内容**，不消费内容本身。
 *
 * 与 `workbuddy-upstream.ts` 的 `backfillReasoningContent()` 是**同一条上游规则的兄弟实现**
 * （workbuddy2api thinking.go 的 requiresReasoningContentOnAssistantMessages），差异只在
 * 传输面：
 * - workbuddy 那边额外**镜像**写 `reasoning`（它的校验读 `reasoning` 的 `len()>0`）；
 * - agentrouter 只认 `reasoning_content`（转译层把它变成 `content[].thinking`），多写
 *   `reasoning` 反而可能被当思考正文，所以这里只写一个字段。
 */

import { baseUrlHostIs } from './url-host'

/** agentrouter 上游主机名（预设与实测地址）。 */
const AGENTROUTER_HOST = 'ps.air-outer.com'

/**
 * 非空占位思考。转译层只判断「thinking 块有没有内容」，单空格即满足；不使用可见文本，
 * 避免占位串被当成模型自己写过的推理读进上下文。
 */
const PLACEHOLDER_THINKING = ' '

/**
 * 该请求是否需要补 thinking 回传：agentrouter 提供商 + deepseek 系模型。
 *
 * 只对这一个上游生效：其他上游（含 DeepSeek 官方 chat 端点）不吃这个字段，凭空加字段
 * 属于无谓的形状变更。按 host 精确判定而非子串匹配（见 url-host.ts 的 CodeQL 回归）。
 */
export function needsReasoningEcho(
  provider: { id?: string; baseUrl?: string },
  modelId: string,
): boolean {
  const byId = typeof provider.id === 'string' && provider.id === 'agentrouter'
  const byHost = baseUrlHostIs(provider.baseUrl, AGENTROUTER_HOST)
  if (!byId && !byHost) return false
  return /deepseek/i.test(modelId)
}

/**
 * 给每条 assistant 消息补齐非空 `reasoning_content`（原地改写，无返回）。
 *
 * 门控（三选一，任一成立就动手）：
 * - `thinking.type === 'enabled'`；
 * - **已有非空思考痕迹**（`reasoning_content` 或 `reasoning` 出现过真正的文本）；
 * - **请求里出现过 reasoning 字段**（哪怕值是空串）——这正是 OpenAI 兼容客户端
 *   （DSH/pi-ai）在思考模式下的形态：字段在、内容空。只看「非空痕迹」会漏掉它，
 *   第一版就是这样在线上没生效。
 *
 * 三者都不成立（纯非思考会话）→ 请求体逐字节不变，不给关闭思考的请求塞思考位。
 *
 * 逐条规则（只动 `role === 'assistant'`）：
 * - `reasoning_content` 非空 → 原样保留；
 * - `reasoning_content` 空串/纯空白、或 `reasoning` 有正文 → 用正文，否则占位串；
 * - 两者都没有 → 占位串。
 */
export function ensureAssistantReasoningEcho(body: Record<string, unknown>): void {
  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return

  const thinking = body['thinking']
  const thinkingEnabled =
    !!thinking &&
    typeof thinking === 'object' &&
    !Array.isArray(thinking) &&
    typeof (thinking as Record<string, unknown>)['type'] === 'string' &&
    ((thinking as Record<string, unknown>)['type'] as string).trim().toLowerCase() === 'enabled'

  let hasTrace = false
  let hasReasoningField = false
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const msg = item as Record<string, unknown>
    if ('reasoning_content' in msg || 'reasoning' in msg) hasReasoningField = true
    const rc = msg['reasoning_content']
    if (typeof rc === 'string' && rc.trim() !== '') {
      hasTrace = true
      break
    }
    const reasoning = msg['reasoning']
    if (typeof reasoning === 'string' && reasoning.trim() !== '') {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace && !hasReasoningField) return

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const msg = item as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    const existing = msg['reasoning_content']
    if (typeof existing === 'string' && existing.trim() !== '') continue
    const reasoning = msg['reasoning']
    msg['reasoning_content'] =
      typeof reasoning === 'string' && reasoning.trim() !== '' ? reasoning : PLACEHOLDER_THINKING
  }
}
