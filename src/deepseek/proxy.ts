/**
 * deepseek/proxy.ts — ai-gateway 的 deepseek-app 提供商入口。
 *
 * 上游是 chat.deepseek.com 的私有 App 协议（不是 OpenAI 兼容端点），所以这里完整
 * 负责「OpenAI 请求 → 上游调用 → OpenAI 响应」。凭据形态是**浏览器注入的 token**
 * （见 pool.ts 与 DEEPSEEK-APP-PORT.md）：上游硬卡密码登录，无头进程无法自主登录。
 *
 * 失败语义（与仓库既有约定一致）：
 *  - 无可用 token → 503 `no_available_account`（面板需提示注入/续期）；
 *  - token 失效（40003 / 鉴权类文案）→ 标记 `expired`（面板可见）并换下一条重试，**不静默**；
 *  - 上游 `parallel_chat_limit`（同账号并发生成）→ 换下一条重试；
 *  - 其他上游错误 → 502，带上游原文片段。
 */

import type { Env, Provider } from '../types'
import { baseUrlHostIs } from '../url-host'
import { BizError, DeepseekClient, isAuthFailure, type FetchLike } from './client'
import {
  DeepseekRequestError,
  flattenMessages,
  parseDeepseekRequest,
  type ParsedDeepseekRequest,
} from './request'
import {
  acquireDeepseekToken,
  markDeepseekToken,
  readDeepseekPool,
  toTokenView,
  type DeepseekTokenRecord,
  type DeepseekTokenView,
} from './pool'
import { aggregateDeepseekSse } from './sse'
import { deepseekSSEToOpenAIStream } from './stream'

export const DEEPSEEK_APP_PROVIDER_ID = 'deepseek-app'
/** 上游只有一个模型。 */
export const DEEPSEEK_APP_MODEL = 'deepseek-flash'

/** 上游固定主机。用 hostname 精确比对（见 url-host.ts），子串判定会被
 * `https://evil.com/?u=chat.deepseek.com` / `https://chat.deepseek.com.evil.com` 骗过。 */
const DEEPSEEK_APP_HOST = 'chat.deepseek.com'

/** 该 provider 是否由本模块处理（camelCase/域名双判定，便于「测试连通性」时也能路由）。 */
export function isDeepseekAppProvider(provider: Pick<Provider, 'id' | 'baseUrl'> | undefined | null): boolean {
  if (!provider) return false
  return provider.id === DEEPSEEK_APP_PROVIDER_ID || baseUrlHostIs(provider.baseUrl, DEEPSEEK_APP_HOST)
}

function jsonError(status: number, message: string, type = 'invalid_request_error', code = ''): Response {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * 用注入的 token 记录拼出实测得到的 web 线上指纹。
 * 导出以便 sessions.ts（后台会话维护）复用同一份指纹常量，避免两处漂移。
 */
export function webHeaders(rec: DeepseekTokenRecord): Record<string, string> {
  return {
    Accept: '*/*',
    'Content-Type': 'application/json',
    'User-Agent': rec.userAgent || 'Mozilla/5.0',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': '28800',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-device-model': '',
    'x-device-id': rec.headerDeviceId,
  }
}

/** 读完整条上游流（非流式路径用），上限保护避免病态上游撑爆内存。 */
async function collectUpstream(resp: Response, capBytes = 2_000_000): Promise<string> {
  const reader = resp.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let raw = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
    if (raw.length > capBytes) break
  }
  reader.cancel().catch(() => undefined)
  return raw
}

export interface DeepseekProxyDeps {
  /** 测试注入 fetch。 */
  fetch?: FetchLike
  /** 测试注入 token（跳过 KV 读取）。 */
  tokens?: DeepseekTokenRecord[]
  /** false = 不回写 KV（测试用）。默认 true。 */
  persist?: boolean
  /** 生成响应 id（测试可固定）。 */
  newId?: () => string
  /** 每次尝试前回调（测试可断言轮转次数）。 */
  onAttempt?: (rec: DeepseekTokenRecord, attempt: number) => void
}

/**
 * 处理一次 deepseek-app 的 chat/completions 请求。
 * 返回的 Response 永远是 OpenAI 格式（流式 SSE 或 JSON）。
 */
export async function proxyDeepseekChatRequest(
  env: Env,
  provider: Provider,
  body: Record<string, unknown>,
  deps: DeepseekProxyDeps = {},
): Promise<Response> {
  let parsed: ParsedDeepseekRequest
  try {
    parsed = parseDeepseekRequest(body, { thinkingDefaultOff: provider.deepseekThinkingOff === true })
  } catch (err) {
    if (err instanceof DeepseekRequestError) return jsonError(400, err.message)
    throw err
  }

  const persist = deps.persist !== false
  const newId = deps.newId ?? (() => `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`)
  const model = parsed.model || DEEPSEEK_APP_MODEL

  const tokens = deps.tokens ?? (await readDeepseekPool(env))
  if (tokens.length === 0) {
    return jsonError(
      503,
      'deepseek-app: 没有可用 token。请在管理面板注入（浏览器登录 chat.deepseek.com → DevTools → localStorage.userToken 的 value 字段）。',
      'no_available_account',
      'no_token',
    )
  }

  const prompt = flattenMessages(parsed.messages)
  const readyCount = tokens.filter((t) => t.state === 'ready').length
  const maxAttempts = Math.max(readyCount, 1)
  let lastError = ''

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 每轮都重新按当前池状态挑选（上一轮可能刚把某条标成 expired）
    const acquired = acquireDeepseekToken(provider.id, tokens)
    if (!acquired) break
    const { record, release } = acquired
    deps.onAttempt?.(record, attempt)

    const client = new DeepseekClient({
      account: { password: '' },
      fetch: deps.fetch,
      wire: { replaceHeaders: true, headers: webHeaders(record) },
    })

    try {
      let sessionId: string
      try {
        sessionId = await client.createSession(record.token)
      } catch (err) {
        if (isAuthFailure(err)) {
          if (persist) await markDeepseekToken(env, record.id, { state: 'expired', error: 'token expired (create_session)' })
          lastError = 'token expired'
          continue
        }
        throw err
      }

      const upstream = await client.completion(record.token, {
        sessionId,
        prompt,
        thinkingDisabled: !parsed.thinkingEnabled,
        searchEnabled: parsed.searchEnabled,
        temperature: parsed.temperature,
        topP: parsed.topP,
        maxTokens: parsed.maxTokens,
      })

      if (persist) await markDeepseekToken(env, record.id, { ok: true })

      if (parsed.stream) {
        return new Response(
          deepseekSSEToOpenAIStream(upstream.body as ReadableStream<Uint8Array>, {
            id: newId(),
            model,
            suppressReasoning: !parsed.thinkingEnabled,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Accel-Buffering': 'no',
            },
          },
        )
      }

      const raw = await collectUpstream(upstream)
      const { response, state, truncated } = aggregateDeepseekSse(raw, {
        id: newId(),
        model,
        suppressReasoning: !parsed.thinkingEnabled,
      })
      if (state.contentFilter) {
        return jsonError(400, `上游拒绝该提示词（content_filter）：${state.contentFilter}`, 'invalid_request_error', 'content_filter')
      }
      if (state.error) {
        return jsonError(502, state.error.content, 'upstream_error', state.error.finishReason || 'upstream_error')
      }
      if (!state.finished && truncated && state.text === '') {
        return jsonError(502, '上游流在产出任何正文前就结束了', 'upstream_error', 'truncated')
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    } catch (err) {
      // 并发上限：同账号已有生成在跑，换一条 token 重试即可
      if (err instanceof BizError && err.bizCode === 0 && err.msg.includes('parallel')) {
        lastError = err.message
        continue
      }
      if (isAuthFailure(err)) {
        if (persist) await markDeepseekToken(env, record.id, { state: 'expired', error: 'token expired' })
        lastError = 'token expired'
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      if (persist) await markDeepseekToken(env, record.id, { error: message })
      lastError = message
      break
    } finally {
      release()
    }
  }

  return jsonError(
    503,
    `deepseek-app: 没有可用 token 完成本次请求${lastError ? `（最后错误：${lastError}）` : ''}`,
    'no_available_account',
    'exhausted',
  )
}

export interface VerifyResult {
  ok: boolean
  state: 'ready' | 'expired'
  detail: string
  account?: Record<string, unknown>
}

/**
 * 判活：拿这条 token 打 `users/current`。
 * 面板「注入」与「重新判活」都走这里；结果写回池（ok → ready，鉴权失败 → expired）。
 */
export async function verifyDeepseekToken(
  env: Env,
  record: DeepseekTokenRecord,
  deps: { fetch?: FetchLike; persist?: boolean } = {},
): Promise<VerifyResult> {
  const persist = deps.persist !== false
  const client = new DeepseekClient({
    account: { password: '' },
    fetch: deps.fetch,
    wire: { replaceHeaders: true, headers: webHeaders(record) },
  })
  try {
    const envl = await client.usersCurrent(record.token)
    const bizData = (envl.data?.biz_data ?? {}) as Record<string, unknown>
    if (persist) await markDeepseekToken(env, record.id, { ok: true })
    return {
      ok: true,
      state: 'ready',
      detail: `token 可用（账号 ${String(bizData.mobile_number ?? bizData.id ?? 'unknown')}）`,
      account: {
        id: bizData.id,
        mobile_number: bizData.mobile_number,
        is_mainland: bizData.is_mainland,
        chat: bizData.chat,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const expired = isAuthFailure(err)
    if (persist) {
      await markDeepseekToken(env, record.id, expired ? { state: 'expired', error: message } : { error: message })
    }
    return { ok: false, state: expired ? 'expired' : 'ready', detail: message }
  }
}

/** 池的面板视图（脱敏）。 */
export function deepseekPoolView(tokens: DeepseekTokenRecord[]): {
  tokens: DeepseekTokenView[]
  summary: { total: number; ready: number; expired: number }
} {
  return {
    tokens: tokens.map(toTokenView),
    summary: {
      total: tokens.length,
      ready: tokens.filter((t) => t.state === 'ready').length,
      expired: tokens.filter((t) => t.state === 'expired').length,
    },
  }
}
