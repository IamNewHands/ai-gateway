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
 * 而 OpenAI 兼容客户端（如 DSH）只在**真的产出思考块**的轮次才发 `reasoning_content`：
 * 实测一个 31 步的会话里 30 条 assistant 有 29 条带思考，唯独中间一条模型没吐思考文本，
 * 下一次请求就炸。补齐方式与 DeepSeek 官方兼容做法一致：缺的轮次补空串 `""`。
 *
 * 与 `workbuddy-upstream.ts` 的 `backfillReasoningContent()` 是**同一条上游规则的兄弟实现**
 * （workbuddy2api thinking.go 的 requiresReasoningContentOnAssistantMessages），差异只在
 * 传输面：
 * - workbuddy 那边额外**镜像**写 `reasoning`（上游校验 `len(reasoning)>0`，空白串才过闸）；
 * - agentrouter 只需要 `reasoning_content`，多写 `reasoning` 反而可能被转译层当思考内容。
 * 因此这里只补 `reasoning_content`，且只对 agentrouter 的 deepseek 模型生效（见
 * `needsReasoningEcho`）——非该上游的请求体零改动。
 */

import { baseUrlHostIs } from './url-host'

/** agentrouter 上游主机名（预设与实测地址）。 */
const AGENTROUTER_HOST = 'ps.air-outer.com'

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
 * 给每条 assistant 消息补齐 `reasoning_content`（原地改写，无返回）。
 *
 * 门控对齐 `backfillReasoningContent`：`thinking.type === 'enabled'` 或**已有思考痕迹**
 * 时才动手。两者都不成立（纯非思考会话）→ 请求体逐字节不变，避免给关闭思考的请求
 * 塞空思考块。
 *
 * 逐条规则：
 * - `reasoning_content` 已是 string → 原样保留（含空串，不覆盖客户端的选择）；
 * - 否则 `reasoning` 是 string → 用同源文本回填；
 * - 都没有 → 补 `""`（上游接受空串，拒绝缺字段）。
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
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const msg = item as Record<string, unknown>
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
  if (!thinkingEnabled && !hasTrace) return

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const msg = item as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    if (typeof msg['reasoning_content'] === 'string') continue
    const reasoning = msg['reasoning']
    msg['reasoning_content'] = typeof reasoning === 'string' ? reasoning : ''
  }
}
