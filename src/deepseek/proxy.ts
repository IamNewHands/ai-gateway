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
 *  - 上游处罚（biz 10 封禁 / 5 禁言 / 11 设备风险）→ **park** 该 token 并换下一条；
 *    全部被 park 时按处罚种类回 502/429/503（见 `banErrorResponse`）；
 *  - 上游 `parallel_chat_limit`（同账号并发生成）→ 换下一条重试；
 *  - 其他上游错误 → 502，带上游原文片段。
 *
 * 为什么处罚必须 park 而不能只「换下一条重试」：不 park 的话下一次请求会继续挑到
 * 同一账号，上游看到同一账号再次违规会**续期窗口甚至升级处罚**（Go 版注释里的实测：
 * 6h 禁言 → 3 天封禁）。park 让这个账号在窗口内完全冷下来，且持久化后重启仍然冷。
 */

import type { Env, Provider } from '../types'
import { baseUrlHostIs } from '../url-host'
import { BizError, DeepseekClient, banKind, isAuthFailure, type BanKind, type FetchLike } from './client'
import {
  DeepseekRequestError,
  assertPromptLength,
  flattenMessages,
  parseDeepseekRequest,
  type ParsedDeepseekRequest,
} from './request'
import {
  acquireDeepseekToken,
  clearExpiredDeepseekParks,
  computeDeepseekPark,
  countReady,
  isDeepseekTokenParked,
  markDeepseekToken,
  parkDeepseekToken,
  readDeepseekPool,
  toTokenView,
  type DeepseekPark,
  type DeepseekParkKind,
  type DeepseekTokenRecord,
  type DeepseekTokenView,
} from './pool'
import { aggregateDeepseekSse } from './sse'
import { deepseekSSEToOpenAIStream } from './stream'
import {
  DeepseekImageError,
  extractDeepseekImages,
  type DeepseekImage,
  type ImageFetchLike,
} from './images'

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

// ===== 上游处罚（biz 10/5/11）→ park + 客户端可见的错误形状 =====

/** 禁言但上游没给可用窗口时的 `Retry-After` 兜底（秒）。与 Go 版一致：保守的分钟，不是小时。 */
export const DEEPSEEK_MUTE_RETRY_AFTER_FALLBACK_S = 60

/** `Retry-After` 上限（秒）：超过一天的窗口对客户端没有指导意义，按一天报。 */
export const DEEPSEEK_MUTE_RETRY_AFTER_MAX_S = 24 * 60 * 60

/** 处罚种类 → 客户端错误形状（状态码/类型/错误码/文案），逐条对齐 Go 版 `writeUpstreamError`。 */
const BAN_ERROR_SHAPE: Record<DeepseekParkKind, { status: number; type: string; code: string; message: string }> = {
  banned: { status: 502, type: 'upstream_error', code: 'account_banned', message: 'account banned upstream' },
  muted: { status: 429, type: 'rate_limit_error', code: 'account_muted', message: 'account muted upstream' },
  // 风险设备：账号被 park 冷却，但网关继续服务——客户端应重试，而不是认为自己的请求有问题。
  risk: { status: 503, type: 'upstream_error', code: 'upstream_unavailable', message: 'account flagged as risk device upstream' },
}

/** 从上游错误里取 park 所需的种类与窗口；非处罚错误返回 null。 */
export function parkFromError(
  err: unknown,
  now = Date.now(),
): { kind: DeepseekParkKind; park: DeepseekPark } | null {
  const kind = banKind(err)
  if (kind === 'none') return null
  const muteUntil = err instanceof BizError ? err.muteUntil : null
  const reason = err instanceof Error ? err.message : String(err)
  return { kind, park: computeDeepseekPark(kind, { until: muteUntil, reason, now }) }
}

/**
 * 把「池里已无可用 token」这件事按处罚种类回给客户端。
 *
 * 为什么优先报处罚而不是笼统的 503：banned 是不可逆的人工问题，muted 有明确的重试窗口
 * （`Retry-After`），risk 只是冷却——三者对客户端的含义完全不同，混成一个 503 会让
 * 「账号被封」看起来像「网关抖动」，用户不会去处理。
 */
export function banErrorResponse(ban: { kind: DeepseekParkKind; park: DeepseekPark }, now = Date.now()): Response {
  const shape = BAN_ERROR_SHAPE[ban.kind]
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
  if (ban.kind === 'muted') {
    const until = ban.park.until
    const seconds =
      until !== undefined && until > now
        ? Math.min(Math.round((until - now) / 1000), DEEPSEEK_MUTE_RETRY_AFTER_MAX_S)
        : DEEPSEEK_MUTE_RETRY_AFTER_FALLBACK_S
    headers['Retry-After'] = String(Math.max(seconds, 1))
  }
  return new Response(
    JSON.stringify({ error: { message: shape.message, type: shape.type, code: shape.code } }),
    { status: shape.status, headers },
  )
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
  /** 测试注入图片抓取 fetch（与上游 fetch 分开：图片走外部主机，不该共用调优）。 */
  imageFetch?: ImageFetchLike
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
    if (err instanceof DeepseekRequestError) return jsonError(400, err.message, 'invalid_request_error', err.code)
    throw err
  }

  const persist = deps.persist !== false
  const newId = deps.newId ?? (() => `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`)
  const model = parsed.model || DEEPSEEK_APP_MODEL

  const prompt = flattenMessages(parsed.messages)
  // 超长 prompt 在本地 400，别让它打上游再变成归因错误的 502（Go 版同语义，且同样
  // 放在取号之前：这是**请求本身**的问题，与池里有没有号无关）。
  try {
    assertPromptLength(prompt)
  } catch (err) {
    if (err instanceof DeepseekRequestError) return jsonError(400, err.message, 'invalid_request_error', err.code)
    throw err
  }

  const tokens = deps.tokens ?? (await readDeepseekPool(env))
  if (tokens.length === 0) {
    return jsonError(
      503,
      'deepseek-app: 没有可用 token。请在管理面板注入（浏览器登录 chat.deepseek.com → DevTools → localStorage.userToken 的 value 字段）。',
      'no_available_account',
      'no_token',
    )
  }

  // 自然解禁：过期的 park 必须先清掉，否则「已到期」的账号在本进程内永远不被选中。
  // 只在持久化路径上做（测试注入的 tokens 数组不该被静默改写）。
  if (persist && deps.tokens === undefined) await clearExpiredDeepseekParks(env, tokens)

  const readyCount = countReady(tokens)
  const maxAttempts = Math.max(readyCount, 1)
  let lastError = ''
  /** 本次请求遇到过的处罚（用于池被 park 空时给出正确的错误形状）。 */
  let lastBan: { kind: DeepseekParkKind; park: DeepseekPark } | null = null

  // 图片在**取号之前**解析完：抓外部图床的耗时不能占着池槽位（Go 版 gap-analysis R4）。
  // 失败即 400，绝不静默丢图（否则会产出一个「客户端以为带了图」的回答）。
  let images: DeepseekImage[] = []
  try {
    images = await extractDeepseekImages(parsed.messages, { fetch: deps.imageFetch })
  } catch (err) {
    if (err instanceof DeepseekImageError) {
      return jsonError(400, err.message, 'invalid_request_error', 'image_fetch_failed')
    }
    throw err
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 每轮都重新按当前池状态挑选（上一轮可能刚把某条标成 expired 或 park）
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
      // 图片先上传拿 file id（上传每次都要单独解一次 PoW，见 client.ts 的说明）。
      // 上传失败归因到图片这条路径：报 502 upload_failed，不标 token 失效、不 park
      // ——账号本身没问题，只是这张图没上去。
      const refFileIds: string[] = []
      let imageAborted = false
      for (const img of images) {
        try {
          refFileIds.push(await client.uploadImageAndWait(record.token, img.data, `image.${img.ext}`))
        } catch (err) {
          const ban = parkFromError(err)
          if (ban) {
            if (persist) await parkDeepseekToken(env, record.id, ban.park)
            lastBan = ban
            lastError = ban.park.reason
            imageAborted = true
            break
          }
          if (isAuthFailure(err)) {
            if (persist) await markDeepseekToken(env, record.id, { state: 'expired', error: 'token expired (image upload)' })
            lastError = 'token expired'
            imageAborted = true
            break
          }
          if (persist) await markDeepseekToken(env, record.id, { error: (err as Error).message ?? String(err) })
          return jsonError(502, 'image upload failed', 'upstream_error', 'upload_failed')
        }
      }
      // 上传阶段已经判定了这条 token 不能继续（处罚 / 失效）：换下一条重试。
      if (imageAborted) continue

      let sessionId: string
      try {
        sessionId = await client.createSession(record.token)
      } catch (err) {
        // 处罚优先于鉴权判定：biz 5/10/11 也会带上「login」类文案，误判成 token 过期
        // 会让账号被标 expired 而**不 park**，下一次请求又打上去。
        const ban = parkFromError(err)
        if (ban) {
          if (persist) await parkDeepseekToken(env, record.id, ban.park)
          lastBan = ban
          lastError = ban.park.reason
          continue
        }
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
        refFileIds,
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
        // 并发上限以**流内 hint** 到达（不是抛错），非流式路径此时还没回任何字节，
        // 所以能像 Go 版的 attempt 阶梯一样换一条 token 重试——不重试就会把一个
        // 「换个账号就好」的情况报成 502。
        if (state.error.isParallelLimit && attempt + 1 < maxAttempts) {
          lastError = `parallel_chat_limit: ${state.error.content}`
          continue
        }
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
      // 上游处罚：park 该 token（持久化后重启仍然冷），换下一条重试
      const ban = parkFromError(err)
      if (ban) {
        if (persist) await parkDeepseekToken(env, record.id, ban.park)
        lastBan = ban
        lastError = ban.park.reason
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

  // 池里已经没有可挑的 token：若是被处罚清空的，回处罚专属的错误形状
  // （banned 502 / muted 429+Retry-After / risk 503），而不是笼统的 503。
  const dominant = lastBan ?? pickDominantPark(tokens)
  if (dominant) return banErrorResponse(dominant)

  return jsonError(
    503,
    `deepseek-app: 没有可用 token 完成本次请求${lastError ? `（最后错误：${lastError}）` : ''}`,
    'no_available_account',
    'exhausted',
  )
}

/**
 * 池内所有可用 token 都被 park 时，挑一条最能指导客户端的处罚来报。
 *
 * 取舍：**全为封禁**时报 `banned`（永久问题，只能人工处理）；否则报**最快恢复**的那条
 * ——客户端的 `Retry-After` 应该指向服务真正会恢复的时刻，而不是最严重的那条。
 * 具体的池状态在管理面板逐条可见，这里只需要给客户端一个正确的等待信号。
 */
export function pickDominantPark(
  tokens: DeepseekTokenRecord[],
  now = Date.now(),
): { kind: DeepseekParkKind; park: DeepseekPark } | null {
  const parked = tokens
    .filter((t) => t.park !== undefined && isDeepseekTokenParked(t, now))
    .map((t) => t.park as DeepseekPark)
  if (parked.length === 0) return null
  if (parked.every((p) => p.kind === 'banned')) return { kind: 'banned', park: parked[0] }
  const recoverable = parked.filter((p) => p.kind !== 'banned')
  const soonest = recoverable.reduce((a, b) => ((a.until ?? Infinity) <= (b.until ?? Infinity) ? a : b))
  return { kind: soonest.kind, park: soonest }
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
    // 判活打的是 users/current：被禁言/封禁的账号在这个端点上就可能直接回 biz 5/10/11。
    // 这种 token **不是失效**（换浏览器重新登录也还是这个账号），所以按 park 处理并
    // 在面板上说明处罚种类——标成 expired 会让用户白折腾一次重新注入。
    const ban = parkFromError(err)
    if (ban) {
      if (persist) await parkDeepseekToken(env, record.id, ban.park)
      return { ok: false, state: 'ready', detail: `${ban.park.reason}（已 park：${ban.kind}）` }
    }
    const expired = isAuthFailure(err)
    if (persist) {
      await markDeepseekToken(env, record.id, expired ? { state: 'expired', error: message } : { error: message })
    }
    return { ok: false, state: expired ? 'expired' : 'ready', detail: message }
  }
}

/** 池的面板视图（脱敏）。`parked` 只统计**仍在窗口内**的 park。 */
export function deepseekPoolView(tokens: DeepseekTokenRecord[], now = Date.now()): {
  tokens: DeepseekTokenView[]
  summary: { total: number; ready: number; expired: number; parked: number }
} {
  return {
    tokens: tokens.map((t) => toTokenView(t, now)),
    summary: {
      total: tokens.length,
      // ready 口径与轮转一致：状态 ready 且不在 park 窗口内才是真的可用。
      ready: countReady(tokens, now),
      expired: tokens.filter((t) => t.state === 'expired').length,
      parked: tokens.filter((t) => isDeepseekTokenParked(t, now)).length,
    },
  }
}
