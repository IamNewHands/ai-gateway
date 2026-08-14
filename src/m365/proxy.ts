/**
 * M365 Copilot 协议适配层（迁移自 M365-Copilot2API internal/web/server.go 的
 * openaiChat / flattenPromptMessages 逻辑）。
 *
 * 职责：
 *   - isM365Provider：识别 M365 提供商（oauth.flowType ∈ m365-pkce | m365-ropc）
 *   - proxyM365ChatRequest：把 OpenAI chat.completions 请求体交给 M365 Session
 *     Durable Object（env.M365_SESSION.get(sessionKey)）执行 ChatHub WS 对话，
 *     DO 返回 OpenAI SSE / JSON（同一出口格式），网关直接透传。
 *   - Anthropic / Responses 格式复用现有网关转换链路：先转成 OpenAI body，
 *     走本函数（DO），再把 OpenAI SSE/JSON 转回对应格式。
 *
 * 会话绑定：
 *   - 客户端可在请求体带 `m365_session_id`，或网关按末尾消息内容指纹分片到不同
 *     DO 实例（见 durable.sessionKey）。
 */
import type { Env, Provider } from '../types'
import { sessionKey } from './durable'
import type { M365ChatPayload } from './durable'

/** 是否 M365 Copilot 提供商（OAuth flowType ∈ m365-pkce | m365-ropc） */
export function isM365Provider(provider: Provider): boolean {
  return provider.oauth?.flowType === 'm365-pkce' || provider.oauth?.flowType === 'm365-ropc'
}

/**
 * M365 Copilot 可用模型清单（静态。订阅账号的模型命名与官方客户端一致，
 * 无公开 models 端点，登录成功后由后台一键拉取自动合并保存）。
 */
export const M365_MODELS: Array<{ id: string; displayName: string }> = [
  { id: 'gpt-4o', displayName: 'GPT-4o' },
  { id: 'gpt-4.1', displayName: 'GPT-4.1' },
  { id: 'gpt-5', displayName: 'GPT-5' },
  { id: 'gpt-5.1', displayName: 'GPT-5.1' },
  { id: 'gpt-5.6', displayName: 'GPT-5.6' },
  { id: 'gpt-5.6-high', displayName: 'GPT-5.6 High' },
  { id: 'gpt-5.6-mini', displayName: 'GPT-5.6 Mini' },
  { id: 'o4-mini', displayName: 'o4-mini' },
  { id: 'o3', displayName: 'o3' },
]

export interface M365ProxyContext {
  explicitSessionId?: string
  user?: string
  ip?: string
  userAgent?: string
}

/** 从请求体提取客户端指定的会话 ID（可选，X-M365-Session-Id 的 JSON 对应字段） */
function extractExplicitSession(body: Record<string, unknown>): string | undefined {
  const v = body['m365_session_id'] ?? body['session_id']
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/**
 * OpenAI chat.completions → M365 DO 转发。
 * 返回 DO 构造的 OpenAI SSE / JSON 响应（stream 由 body 决定）。
 * context 仅用于会话归属（IP/UA 指纹），不参与协议转换。
 */
export async function proxyM365ChatRequest(
  env: Env,
  provider: Provider,
  body: Record<string, unknown>,
  context?: M365ProxyContext
): Promise<Response> {
  const messages = (body['messages'] as Array<Record<string, unknown>>) || []
  const explicitSessionId = extractExplicitSession(body)
  const sessionId = sessionKey(provider.id, explicitSessionId, messages)

  const payload: M365ChatPayload = {
    providerId: provider.id,
    model: typeof body['model'] === 'string' ? body['model'] : '',
    body,
    stream: body['stream'] === true,
    explicitSessionId,
    user: context?.user,
    ip: context?.ip,
    userAgent: context?.userAgent,
  }

  const stub = env.M365_SESSION.get(env.M365_SESSION.idFromName(sessionId))
  return stub.fetch('https://m365-session.local/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 连通性测试：走完整 ChatHub 链路发一条最小消息（非流式） */
export async function testM365Model(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const resp = await proxyM365ChatRequest(
      env,
      provider,
      { model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: false }
    )
    if (resp.ok) {
      return { success: true, message: '连接成功', statusCode: resp.status }
    }
    const text = await resp.text().catch(() => '')
    let detail = text
    try {
      const j = JSON.parse(text)
      detail = j?.error?.message || text
    } catch { /* keep text */ }
    console.error(`[m365-test-model] model=${modelId} status=${resp.status} detail=${detail.substring(0, 200)}`)
    return { success: false, message: `HTTP ${resp.status}: ${detail.substring(0, 200)}`, statusCode: resp.status }
  } catch (err) {
    const msg = (err as Error)?.message || String(err)
    console.error(`[m365-test-model] model=${modelId} 异常: ${msg}`)
    return { success: false, message: `测试异常: ${msg.substring(0, 200)}`, statusCode: 0 }
  }
}
