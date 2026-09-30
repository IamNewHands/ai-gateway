/**
 * deepseek/client.ts — chat.deepseek.com 私有 API 客户端（移植自 simple-chat
 * `internal/upstream/client.go`）。
 *
 * 上游是安卓 App 2.5.3 的私有接口，不是 OpenAI 兼容端点。线上指纹（UA、四个
 * x-client-*、x-device-*）是**功能性**协议值：上游 WAF 对中性 UA 直接回 HTTP 202
 * 空体（Go 版 2026-09-19 实测），所以这些常量不许「品牌化」改写。
 *
 * 与 Go 版的运行时差异：
 *  - 无连接池可调（Workers 的 fetch 自带），故没有 transport 调优；
 *  - 预检请求用 AbortSignal 设整体超时（Go 用 http.Client.Timeout）；
 *  - 补全流的空闲看门狗由调用方在读取侧实现（见 sse.ts，T4）。
 */

import { utf8 } from './bytes'
import {
  channelOS,
  normalizeChannel,
  resolveDeviceProfile,
  type AccountIdentity,
  type DeviceProfile,
} from './device'
import { solveAndBuildHeader, type PowChallenge } from './pow'

/** 生产上游主机。BaseURL 是常量：不是用户配置项。 */
export const DEFAULT_BASE_URL = 'https://chat.deepseek.com'

/** 预检请求（登录/建会话/取挑战/上传/删除）的整体超时。 */
export const PREFLIGHT_TIMEOUT_MS = 60_000

/** 补全流的空闲窗口：这段时间没有字节即判定上游哑掉。 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000

// ===== 模拟的安卓设备指纹（apk-alignment.md §2/§11，功能性常量）=====
export const APP_CLIENT_VERSION = '2.5.3'
export const APP_USER_AGENT = 'DeepSeek/2.5.3 Android/35'
export const APP_CLIENT_LOCALE = 'en_US'
export const APP_BUNDLE_ID = 'com.deepseek.chat'
export const APP_TIMEZONE_OFFSET = '28800' // +08:00 秒
export const APP_DEVICE_MODEL = 'Pixel 8'

/** 上游信封：每个 JSON 端点统一的外层包装。 */
export interface Envelope {
  code: number
  msg: string
  data: {
    biz_code: number
    biz_msg: string
    biz_data: unknown
  }
}

/** 账号级封禁状态。 */
export type BanKind = 'none' | 'banned' | 'muted' | 'risk'

/**
 * 上游业务错误（外层 code 或 data.biz_code 非 0，或非 200 状态）。
 * muteUntil 只在 biz 5（禁言）时可能有值。
 */
export class BizError extends Error {
  readonly httpStatus: number
  readonly code: number
  readonly bizCode: number
  readonly msg: string
  readonly bizMsg: string
  readonly muteUntil: Date | null

  constructor(init: {
    httpStatus?: number
    code?: number
    bizCode?: number
    msg?: string
    bizMsg?: string
    muteUntil?: Date | null
  }) {
    const detail = init.bizMsg
      ? `biz_code ${init.bizCode}: ${init.bizMsg}`
      : init.msg
        ? `code ${init.code}: ${init.msg}`
        : `http ${init.httpStatus}`
    super(`upstream: ${detail}`)
    this.name = 'BizError'
    this.httpStatus = init.httpStatus ?? 0
    this.code = init.code ?? 0
    this.bizCode = init.bizCode ?? 0
    this.msg = init.msg ?? ''
    this.bizMsg = init.bizMsg ?? ''
    this.muteUntil = init.muteUntil ?? null
  }
}

/** 非 200 的补全响应（体可能不是 JSON）。 */
export class HttpStatusError extends Error {
  readonly status: number
  readonly snippet: string

  constructor(status: number, snippet: string) {
    super(`upstream: completion http ${status}: ${snippet.slice(0, 200)}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.snippet = snippet
  }
}

/** 登录体（手机号或邮箱二选一）。 */
export interface LoginBody {
  password: string
  device_id: string
  os: string
  mobile?: string
  email?: string
  area_code?: null
}

/** 补全请求参数。 */
export interface CompletionRequest {
  sessionId: string
  prompt: string
  refFileIds?: string[]
  /** 取反语义：上游 thinking_enabled 默认为 true。 */
  thinkingDisabled?: boolean
  searchEnabled?: boolean
  temperature?: number
  topP?: number
  maxTokens?: number
}

/** 从账号身份归一化手机号：剥离 +86 前缀（Go 版 recon §3.2）。 */
export function normalizeMobile(raw: string): string {
  const s = (raw ?? '').trim()
  const hasPlus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if ((hasPlus || digits.startsWith('86')) && digits.startsWith('86') && digits.length === 13) {
    return digits.slice(2)
  }
  return digits
}

/** 组装登录体；调用方已保证 mobile/email 至少有一个。 */
export function buildLoginBody(account: AccountIdentity & { password: string }, profile: DeviceProfile): LoginBody {
  const body: LoginBody = {
    password: account.password,
    device_id: profile.deviceId,
    os: channelOS(profile.channel),
  }
  const email = (account.email ?? '').trim()
  const mobile = normalizeMobile(account.mobile ?? '')
  if (email) {
    body.email = email
  } else if (mobile) {
    body.mobile = mobile
    body.area_code = null
  } else {
    throw new Error('upstream: account needs mobile or email')
  }
  return body
}

/** 从 biz_data 里安全取嵌套字符串（上游不同端点字段位置不一致）。 */
function pickString(raw: unknown, ...path: string[]): string {
  let cur: unknown = raw
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return ''
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' ? cur : ''
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/**
 * 解析 mute_until：上游在不同位置发过 unix 秒（数字或字符串）与 RFC3339，
 * 且可能嵌在 data.biz_data / .chat / .user.chat 下。
 */
export function parseMuteUntil(raw: unknown): Date | null {
  const candidates = [
    asRecord(raw).mute_until,
    asRecord(asRecord(raw).chat).mute_until,
    asRecord(asRecord(asRecord(raw).user).chat).mute_until,
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim().replace(/^"|"$/g, '')
    if (!s || s === 'null') continue
    if (/^\d+$/.test(s)) {
      const d = new Date(Number(s) * 1000)
      if (!Number.isNaN(d.getTime())) return d
    }
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

/** 校验信封成功；失败时抛 BizError。 */
export function checkEnv(env: Envelope): void {
  if (env.code !== 0) {
    throw new BizError({
      code: env.code,
      msg: env.msg,
      bizCode: env.data?.biz_code ?? 0,
      bizMsg: env.data?.biz_msg ?? '',
      muteUntil: parseMuteUntil(env.data?.biz_data),
    })
  }
  if ((env.data?.biz_code ?? 0) !== 0) {
    throw new BizError({
      bizCode: env.data.biz_code,
      bizMsg: env.data.biz_msg,
      muteUntil: parseMuteUntil(env.data.biz_data),
    })
  }
}

/** 账号级封禁分类：biz 10 封禁 / 5 禁言 / 11 设备风险。 */
export function banKind(err: unknown): BanKind {
  if (!(err instanceof BizError)) return 'none'
  switch (err.bizCode) {
    case 10:
      return 'banned'
    case 5:
      return 'muted'
    case 11:
      return 'risk'
    default:
      return 'none'
  }
}

/** 是否值得刷新 token（401/403、外层 40001-40003、或文案暗示鉴权失效）。 */
export function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof BizError)) return false
  if (err.httpStatus === 401 || err.httpStatus === 403) return true
  const authCode = (n: number) => n >= 40001 && n <= 40003
  if (authCode(err.code) || authCode(err.bizCode)) return true
  const combined = `${err.msg} ${err.bizMsg}`.toLowerCase()
  return ['token', 'unauthorized', 'expired', 'not login', 'login required', 'invalid jwt'].some((kw) =>
    combined.includes(kw),
  )
}

/**
 * 是否值得重试：传输层错误与 5xx 值得；上游已表态的业务错误（BizError）不值得——
 * 重试只是白送负载。
 */
export function isRetryable(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (err instanceof BizError) return false
  if (err instanceof HttpStatusError) return err.status >= 500
  return true
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/**
 * 线上指纹覆写（**诊断/兼容用**，不是为了「更像 App」而随手加开关）。
 *
 * 背景（2026-09-30 实测）：完整的 App 2.5.3 指纹块 + 按账号铸造的 App 形状 device_id
 * 在登录时被风控直接拒为 biz_code 11 RISK_DEVICE_DETECTED；而 ds2api（生产在用的
 * 参考实现）用的是**极简头 + 字面量 device_id "deepseek_to_api"**。两者谁对必须靠
 * 真机探测判定，所以把指纹做成可覆写项，而不是写死。
 */
export interface WireOverride {
  /** 覆盖登录体的 device_id（默认是按账号确定性铸造的 App 形状 id）。 */
  loginDeviceId?: string
  /** 追加/覆盖的请求头。 */
  headers?: Record<string, string>
  /** true = 用 headers **整体替换** 默认 App 指纹块（不合并）。 */
  replaceHeaders?: boolean
}

export interface DeepseekClientConfig {
  baseUrl?: string
  account: AccountIdentity & { password: string }
  /** 测试注入用；生产走全局 fetch。 */
  fetch?: FetchLike
  /** 预检请求整体超时（ms）。 */
  preflightTimeoutMs?: number
  logger?: (msg: string) => void
  /** 线上指纹覆写（见 WireOverride）。 */
  wire?: WireOverride
}

/**
 * 单账号客户端。会话/令牌状态由调用方（pool）持有，这里只做无状态的线上交互。
 */
export class DeepseekClient {
  readonly baseUrl: string
  private readonly account: AccountIdentity & { password: string }
  private readonly fetchImpl: FetchLike
  private readonly preflightTimeoutMs: number
  private profilePromise: Promise<DeviceProfile> | null = null
  private readonly logger?: (msg: string) => void
  private readonly wireOverride?: WireOverride

  constructor(cfg: DeepseekClientConfig) {
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.account = cfg.account
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init))
    this.preflightTimeoutMs = cfg.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS
    this.logger = cfg.logger
    this.wireOverride = cfg.wire
  }

  private log(msg: string): void {
    this.logger?.(msg)
  }

  /** 设备身份按账号确定性铸造一次，随后复用。 */
  profile(): Promise<DeviceProfile> {
    if (!this.profilePromise) this.profilePromise = resolveDeviceProfile(this.account)
    return this.profilePromise
  }

  /** 安卓客户端的仿真头（dj.java case-18 块），可被 wire 覆写。 */
  async baseHeaders(): Promise<Record<string, string>> {
    const p = await this.profile()
    const app: Record<string, string> = {
      Accept: 'application/json',
      Referer: this.baseUrl,
      'User-Agent': APP_USER_AGENT,
      'x-client-platform': 'android',
      'x-client-version': APP_CLIENT_VERSION,
      'x-client-locale': APP_CLIENT_LOCALE,
      'x-client-bundle-id': APP_BUNDLE_ID,
      'x-client-timezone-offset': APP_TIMEZONE_OFFSET,
      'x-device-model': APP_DEVICE_MODEL,
      'x-device-id': p.headerDeviceId,
      'x-rangers-id': p.rangersId,
    }
    const override = this.wireOverride
    if (!override?.headers) return app
    if (override.replaceHeaders) return { ...override.headers }
    return { ...app, ...override.headers }
  }

  /** 预检 JSON POST：整体超时 + 信封解码。 */
  private async postJSON(
    path: string,
    token: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Envelope> {
    const headers: Record<string, string> = {
      ...(await this.baseHeaders()),
      'Content-Type': 'application/json',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    Object.assign(headers, extraHeaders ?? {})

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.preflightTimeoutMs)
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await resp.text()
      let env: Envelope
      try {
        env = JSON.parse(text) as Envelope
      } catch {
        throw new Error(`upstream: bad JSON from ${path} (http ${resp.status}): ${text.slice(0, 200)}`)
      }
      if (resp.status !== 200) {
        throw new BizError({
          httpStatus: resp.status,
          code: env.code,
          msg: env.msg,
          bizCode: env.data?.biz_code ?? 0,
          bizMsg: env.data?.biz_msg ?? '',
        })
      }
      return env
    } finally {
      clearTimeout(timer)
    }
  }

  /** 预检 GET。 */
  private async getJSON(path: string, token: string): Promise<Envelope> {
    const headers: Record<string, string> = { ...(await this.baseHeaders()) }
    if (token) headers.Authorization = `Bearer ${token}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.preflightTimeoutMs)
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      const text = await resp.text()
      try {
        return JSON.parse(text) as Envelope
      } catch {
        throw new Error(`upstream: bad JSON from ${path} (http ${resp.status}): ${text.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 传输层错误重试一次（250ms 退避）；上游已应答的业务错误不重试。 */
  private async retryTransport<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryable(err)) throw err
      await new Promise((r) => setTimeout(r, 250))
      return fn()
    }
  }

  /**
   * POST /api/v0/users/login → bearer token。
   * 键序对齐 Go 版（Go 用 map，encoding/json 按键名排序）：area_code 在手机号
   * 登录时显式发 null（App 的 explicitNulls=true）。
   */
  async login(): Promise<string> {
    const profile = await this.profile()
    const deviceId = this.wireOverride?.loginDeviceId ?? profile.deviceId
    const body = buildLoginBody(this.account, { ...profile, deviceId })
    // 保持与 Go map 序列化一致的键序（字母序）
    const ordered: Record<string, unknown> = {}
    if (body.area_code !== undefined) ordered.area_code = body.area_code
    ordered.device_id = body.device_id
    if (body.email !== undefined) ordered.email = body.email
    if (body.mobile !== undefined) ordered.mobile = body.mobile
    ordered.os = body.os
    ordered.password = body.password

    const env = await this.postJSON('/api/v0/users/login', '', ordered)
    checkEnv(env)
    const token = pickString(env.data?.biz_data, 'user', 'token')
    if (!token) throw new Error('upstream: login response missing token')
    return token
  }

  /** POST /api/v0/chat_session/create → 会话 id。 */
  async createSession(token: string): Promise<string> {
    const env = await this.retryTransport(() =>
      this.postJSON('/api/v0/chat_session/create', token, { agent: 'chat' }),
    )
    checkEnv(env)
    const sessionId =
      pickString(env.data?.biz_data, 'chat_session', 'id') || pickString(env.data?.biz_data, 'id')
    if (!sessionId) throw new Error('upstream: create_session response missing id')
    return sessionId
  }

  /**
   * 取挑战并解算 → X-DS-PoW-Response 值。
   * 解算结果**一次性**：服务端对复用回 40301 INVALID_POW_RESPONSE（Go 版实测），
   * 所以这里不做缓存，每个补全/上传各解一次。
   */
  async powHeader(token: string, targetPath: string): Promise<string> {
    const env = await this.retryTransport(() =>
      this.postJSON('/api/v0/chat/create_pow_challenge', token, { target_path: targetPath }),
    )
    checkEnv(env)
    const challenge = asRecord(env.data?.biz_data).challenge as PowChallenge | undefined
    if (!challenge || typeof challenge.challenge !== 'string') {
      throw new Error('upstream: pow challenge missing from response')
    }
    const started = Date.now()
    const header = solveAndBuildHeader(challenge)
    this.log(`pow: solved difficulty=${challenge.difficulty} in ${Date.now() - started}ms`)
    return header
  }

  /**
   * POST /api/v0/chat/completion → SSE 响应体（调用方负责读取/关闭）。
   *
   * 请求体字段序 = App 的 kotlinx descriptor 序（qj1.java:16-26），是设备指纹的
   * 组成部分，因此用有序对象字面量构造，**不要**改成 Map（键序会变）。
   * 上游可能用 HTTP 200 + JSON 信封报错，故按 Content-Type 区分。
   */
  async completion(token: string, req: CompletionRequest): Promise<Response> {
    const powHeader = await this.powHeader(token, '/api/v0/chat/completion')

    const payload: Record<string, unknown> = {
      chat_session_id: req.sessionId,
      parent_message_id: null,
      prompt: req.prompt,
      ref_file_ids: req.refFileIds ?? [],
      thinking_enabled: !req.thinkingDisabled,
      search_enabled: Boolean(req.searchEnabled),
      audio_id: null,
      preempt: false,
      model_type: 'default',
      action: null,
    }
    if (req.temperature) payload.temperature = req.temperature
    if (req.topP) payload.top_p = req.topP
    if (req.maxTokens) payload.max_tokens = req.maxTokens

    const headers: Record<string, string> = {
      ...(await this.baseHeaders()),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-DS-PoW-Response': powHeader, // App 的原始大小写（qf3.java:346）
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/api/v0/chat/completion`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    if (resp.status !== 200) {
      const snippet = await resp.text().catch(() => '')
      throw new HttpStatusError(resp.status, snippet)
    }
    const ct = resp.headers.get('Content-Type') ?? ''
    if (ct.includes('text/event-stream')) return resp

    // 200 但不是 SSE：多半是错误信封，按信封解析以求准确归因。
    const raw = await resp.text()
    let env: Envelope
    try {
      env = JSON.parse(raw) as Envelope
    } catch {
      throw new Error(`upstream: unexpected completion response: ${raw.slice(0, 200)}`)
    }
    checkEnv(env)
    throw new Error('upstream: completion returned JSON without stream')
  }

  /** POST /api/v0/chat_session/delete（尽力而为）。 */
  async deleteSession(token: string, sessionId: string): Promise<void> {
    const env = await this.postJSON('/api/v0/chat_session/delete', token, { chat_session_id: sessionId })
    checkEnv(env)
  }

  /** POST /api/v0/chat_session/delete_all —— App 的「清空全部会话」（无请求体）。 */
  async deleteAllSessions(token: string): Promise<void> {
    const env = await this.postJSON('/api/v0/chat_session/delete_all', token, {})
    checkEnv(env)
  }

  /** GET /api/v0/users/current —— 启动序列用（token 存活与账号状态探测）。 */
  async usersCurrent(token: string): Promise<Envelope> {
    const env = await this.getJSON('/api/v0/users/current', token)
    checkEnv(env)
    return env
  }

  /** GET /api/v0/chat_session/fetch_page —— 会话抽屉第一页。 */
  async fetchSessionPage(token: string): Promise<Envelope> {
    const env = await this.getJSON('/api/v0/chat_session/fetch_page', token)
    checkEnv(env)
    return env
  }

  /** UTF-8 便捷入口（登录体等由调用方自建时的编码一致性）。 */
  encodeBody(text: string): Uint8Array {
    return utf8(text)
  }
}

/** 频道合法性（加载期校验，避免「web 频道没给 device_id」这类注定被拒的账号）。 */
export function validateChannel(channel: string | undefined, deviceId: string | undefined): string {
  const norm = normalizeChannel(channel)
  if (norm === null) throw new Error('upstream: unknown channel (only "" (android) and "web" are supported)')
  if (norm === 'web' && !(deviceId ?? '').trim()) {
    throw new Error('upstream: channel "web" requires an explicit device_id (browser-harvested Shumei SMSdk id)')
  }
  return norm
}
