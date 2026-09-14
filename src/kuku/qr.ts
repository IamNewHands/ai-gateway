import { KV_KEYS } from '../config'
import { getProvider, updateProvider } from '../storage'
import type { Env } from '../types'

/**
 * Kuku 后台内置百度扫码登录（逆向适配 passport 非官方接口）。
 *
 * 百度没有面向 Kuku 的 OAuth API，鉴权靠网页会话 Cookie（BDUSS/STOKEN）。
 * 这里在服务端代理三步扫码流程：
 *   1. GET /v2/api/getqrcode        → 返回二维码图片地址 imgurl + 会话标识 sign
 *   2. GET /channel/unicast（轮询）  → 用户扫码并确认后返回临时 v（等价临时 BDUSS）
 *   3. GET /v3/login/main/qrbdusslogin?bduss=<v> → JSON body data.session.{bduss,ptoken,stoken}
 *
 * 与 OAuth 设备码登录同构：connect 发起写 KV 状态 → poll 轮询兑换并落地 Provider.apiKeys。
 * 注意：passport 为逆向非官方接口，百度改版可能导致流程失效。
 */

const PASSPORT_TARGET = 'https://passport.baidu.com'
const QR_TTL_SECONDS = 300

export interface KukuQrInfo {
  imgUrl: string
  expiresAt: number
}

interface KukuQrState {
  /** 二维码会话唯一标识（getqrcode 返回的 sign） */
  sign: string
  imgUrl: string
  /** 透传给后续请求的 Cookie（getqrcode 下发的 BAIDUID 等，模拟 Session 连续性） */
  cookieJar: string
  createdAt: number
  expiresAt: number
}

export type KukuQrPollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string; cookie: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

const qrKey = (providerId: string) => `${KV_KEYS.KUKU_QR_PREFIX}${providerId}`

function genGid(): string {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 32)
}

/** 解析可能被 JSONP 包裹的响应：取 `cb(...)` 内层 JSON 文本。 */
function unwrapJsonp(text: string): string {
  const s = text.trim()
  const open = s.indexOf('(')
  const close = s.lastIndexOf(')')
  if (open > 0 && close > open) return s.slice(open + 1, close).trim()
  return s
}

/** 从 set-cookie 响应头抽取 name=value，合并进已有 cookie jar（同名覆盖）。 */
function collectCookies(response: Response, prev: string): string {
  let raw = ''
  // Worker 对多 Set-Cookie 有折叠限制，尽量读取全部；取不到再多取第一条兜底
  const all = typeof (response.headers as unknown as { getAll?: (n: string) => string[] }).getAll === 'function'
    ? (response.headers as unknown as { getAll: (n: string) => string[] }).getAll('set-cookie')
    : []
  if (all.length > 0) raw = all.join('; ')
  else raw = response.headers.get('set-cookie') || ''

  const parts = prev ? prev.split(';').map((s) => s.trim()).filter(Boolean) : []
  for (const seg of raw.split(';')) {
    const pair = seg.replace(/^([^=]+)=/, '$1').trim()
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name || !value) continue
    const idx = parts.findIndex((p) => p.startsWith(name + '='))
    const entry = `${name}=${value}`
    if (idx >= 0) parts[idx] = entry
    else parts.push(entry)
  }
  return parts.join('; ')
}

/**
 * 发起百度扫码登录：调 getqrcode 拿二维码，写 KV 状态（TTL 5 分钟）。
 * providerId 仅作为 KV 状态键；无需提供商已保存（新增表单未保存也能发起）。
 */
export async function startKukuQrLogin(env: Env, providerId: string): Promise<{ success: boolean; message: string; qr?: KukuQrInfo }> {
  // 百度 passport 对数据中心出口 IP 有风控（常表现为吊起/黑洞而非快速报错），
  // 超时放宽到 30s 并重试一次兜住偶发抖动。仍失败多为出口 IP 被拦，需换网络环境。
  const QR_FETCH_TIMEOUT_MS = 30_000
  const qrHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.baidu.com/',
    'Origin': 'https://www.baidu.com',
  }
  const buildQrUrl = () => {
    const url = new URL(`${PASSPORT_TARGET}/v2/api/getqrcode`)
    url.searchParams.set('lp', 'pc')
    url.searchParams.set('qrloginfrom', 'pc')
    url.searchParams.set('apiver', 'v3')
    url.searchParams.set('gid', genGid())
    return url
  }
  const tryFetch = async (): Promise<Response> => {
    const res = await fetch(buildQrUrl().toString(), {
      method: 'GET',
      headers: qrHeaders,
      signal: AbortSignal.timeout(QR_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }

  try {
    let res: Response
    try {
      res = await tryFetch()
    } catch (firstError) {
      if (!(firstError instanceof Error && /timeout|abort/i.test(firstError.message))) throw firstError
      res = await tryFetch() // 超时重试一次
    }

    const payload = JSON.parse(unwrapJsonp(await res.text())) as {
      errno?: number
      imgurl?: string
      sign?: string
    }
    if (payload.errno !== 0 || typeof payload.imgurl !== 'string' || typeof payload.sign !== 'string') {
      return { success: false, message: `获取二维码接口返回异常 errno=${payload.errno ?? 'unknown'}` }
    }

    const now = Date.now()
    const imgUrl = /^https?:\/\//i.test(payload.imgurl) ? payload.imgurl : `https://${payload.imgurl}`
    const state: KukuQrState = {
      sign: payload.sign,
      imgUrl,
      cookieJar: collectCookies(res, ''),
      createdAt: now,
      expiresAt: now + QR_TTL_SECONDS * 1000,
    }
    await env.KV.put(qrKey(providerId), JSON.stringify(state), { expirationTtl: QR_TTL_SECONDS })
    return { success: true, message: '二维码已生成，请用手机百度 App 扫码', qr: { imgUrl: state.imgUrl, expiresAt: state.expiresAt } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = /timeout|abort/i.test(message)
      ? '（百度 passport 疑似拦截了服务器出口 IP，请更换网络/节点后重试）'
      : ''
    return { success: false, message: `获取二维码异常: ${message}${hint}` }
  }
}

/**
 * 轮询百度扫码结果；确认后调 qrbdusslogin 换取 BDUSS/STOKEN/PTOKEN，
 * 拼成 Cookie 写入 Provider.apiKeys（移除旧 Kuku Cookie），并删除临时状态。
 */
export async function pollKukuQrLogin(env: Env, providerId: string): Promise<KukuQrPollResult> {
  const raw = await env.KV.get(qrKey(providerId))
  if (!raw) return { status: 'error', message: '没有进行中的扫码登录，请重新发起' }

  let state: KukuQrState
  try { state = JSON.parse(raw) as KukuQrState } catch {
    return { status: 'error', message: '扫码状态异常，请重新发起' }
  }
  if (Date.now() > state.expiresAt) {
    await env.KV.delete(qrKey(providerId))
    return { status: 'failed', message: '二维码已过期，请重新发起' }
  }

  try {
    // 轮询扫码状态（需带 getqrcode 下发的 cookie，模拟 Session 连续性）
    const pollUrl = new URL(`${PASSPORT_TARGET}/channel/unicast`)
    pollUrl.searchParams.set('channel_id', state.sign)
    pollUrl.searchParams.set('callback', `kuku_qr_${Date.now()}`)
    pollUrl.searchParams.set('gid', genGid())
    pollUrl.searchParams.set('apiver', 'v3')
    pollUrl.searchParams.set('tt', String(Date.now()))
    const poll = await fetch(pollUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        ...(state.cookieJar ? { Cookie: state.cookieJar } : {}),
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!poll.ok) return { status: 'pending', message: '等待扫码…' }

    const pollData = JSON.parse(unwrapJsonp(await poll.text())) as {
      errno?: number
      channel_v?: string
    }
    if (pollData.errno !== 0) return { status: 'pending', message: '等待扫码…' }

    let channel: { status?: number; v?: string }
    try { channel = JSON.parse(String(pollData.channel_v || '{}')) } catch {
      return { status: 'pending', message: '等待扫码…' }
    }
    if (channel.status !== 0 || typeof channel.v !== 'string' || !channel.v) {
      return { status: 'pending', message: '已扫码，请在手机端确认登录' }
    }

    // 用临时 BDUSS 换正式会话 Cookie
    const tempBduss = channel.v
    const loginUrl = new URL(`${PASSPORT_TARGET}/v3/login/main/qrbdusslogin`)
    loginUrl.searchParams.set('bduss', tempBduss)
    const login = await fetch(loginUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        ...(state.cookieJar ? { Cookie: state.cookieJar } : {}),
      },
      signal: AbortSignal.timeout(15000),
    })
    const loginData = (await login.json().catch(() => null)) as {
      errInfo?: { no?: string; msg?: string }
      data?: { session?: { bduss?: string; ptoken?: string; stoken?: string } }
    } | null
    const session = loginData?.data?.session
    const bduss = session?.bduss || ''
    const stoken = session?.stoken || ''
    if (!bduss) {
      await env.KV.delete(qrKey(providerId))
      return {
        status: 'error',
        message: `扫码登录兑换失败${loginData?.errInfo?.msg ? `：${loginData.errInfo.msg}` : ''}`,
      }
    }
    const ptoken = session?.ptoken || ''
    const cookie = `BDUSS=${bduss}${ptoken ? `; PTOKEN=${ptoken}` : ''}${stoken ? `; STOKEN=${stoken}` : ''}`

    // 落地到 provider.apiKeys（移除旧的 Kuku Cookie，只保留最新一条）
    const existing = await getProvider(env, providerId)
    if (existing && existing.type === 'kuku') {
      const kept = existing.apiKeys.filter((k) => !looksLikeKukuCookie(k.key))
      kept.push({ key: cookie, enabled: true })
      await updateProvider(env, providerId, { apiKeys: kept })
    }

    await env.KV.delete(qrKey(providerId))
    return { status: 'success', message: '扫码登录成功，Cookie 已写入', cookie }
  } catch (error) {
    return { status: 'error', message: `扫码登录异常: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 通过特征判断某条 key 是否为 Kuku Cookie（形态 BDUSS=… 或含 STOKEN/BAIDUID）。 */
function looksLikeKukuCookie(key: string): boolean {
  const k = key || ''
  return /^BDUSS=/.test(k) || /(^|;\s*)(STOKEN|BAIDUID)=/.test(k)
}