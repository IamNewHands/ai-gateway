import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession, getValidProxyKey, recordLoginFailure, resetLoginFailures, getLoginFailureCount } from './storage'
import { SESSION_TTL } from './config'
import type { AppEnv, Env } from './types'

/** SHA-256 哈希 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** S8b：恒定时间字符串比较——两串长度不一致时补零对齐，逐字节累积 XOR，杜绝基于时序的侧信道 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a)
  const bBuf = new TextEncoder().encode(b)
  const len = Math.max(aBuf.length, bBuf.length)
  let diff = aBuf.length ^ bBuf.length
  for (let i = 0; i < len; i++) {
    const av = i < aBuf.length ? aBuf[i] : 0
    const bv = i < bBuf.length ? bBuf[i] : 0
    diff |= av ^ bv
  }
  return diff === 0
}

/** 管理后台 Session 验证中间件 */
export async function adminAuthMiddleware(c: Context<AppEnv>, next: Next) {
  const sessionId = getCookie(c, 'session_id')

  if (!sessionId) {
    const url = new URL(c.req.url)
    if (url.pathname === '/admin/login') return next()
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: '未登录' }, 401)
    }
    return c.redirect('/admin/login')
  }

  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    const url = new URL(c.req.url)
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: 'Session 已过期' }, 401)
    }
    return c.redirect('/admin/login')
  }

  c.set('username', session.username)
  return next()
}

/**
 * 对外管理 API（/api/manage/*）的 Token 认证中间件。
 * 校验 Authorization: Bearer <token> 是否匹配环境变量 MANAGEMENT_TOKEN。
 * - 未配置 MANAGEMENT_TOKEN → 503（功能未启用）
 * - 缺失/格式错/不匹配 → 401
 * 与浏览器 session 认证互不影响，独立应用于 /api/manage/* 路由。
 */
export async function managementAuthMiddleware(c: Context<AppEnv>, next: Next) {
  const configured = c.env.MANAGEMENT_TOKEN
  if (!configured) {
    return c.json({ success: false, message: '管理 API 未启用（未配置 MANAGEMENT_TOKEN）' }, 503)
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: '缺少或无效的 Authorization 头，格式: Bearer <token>' }, 401)
  }

  const token = authHeader.slice(7)
  // 沿用 handleLogin 的哈希比对模式（SHA-256 hex），恒定时间比较防时序侧信道
  const tokenHash = await hashPassword(token)
  const configuredHash = await hashPassword(configured)
  if (!safeEqual(tokenHash, configuredHash)) {
    return c.json({ success: false, message: '管理 Token 无效' }, 401)
  }

  return next()
}

// ===== Cloudflare Access JWT 校验（可选加固，仅作用于 /admin/*） =====
//
// 背景：Cloudflare Access 默认只在「边缘」拦截请求。若 Worker 挂在多个域名 / 原始
// *.workers.dev 上，或有人拿到备用域名直连，边缘拦截可能被绕过。这里在 Worker 内再做
// 一次 Cf-Access-Jwt 的签名 + 声明校验，做到"绕过边缘也进不来管理后台"。
//
// 关键点：本中间件**只挂到 /admin/***，且配置了 CF_ACCESS_AUD 才启用（未配置是空操作）。
// 客户端走 /v1/* 的转发 Key（sk_cf_*）鉴权，与本中间件完全无关，绝不会被它影响。
//
// Cloudflare Access JWT 规格（RS256）：
//   - 公钥：GET https://{team}.cloudflareaccess.com/cdn-cgi/access/certs → { keys: [{kid,n,e}] }
//   - 签名：RSASSA-PKCS1-v1_5 + SHA-256，输入 = header.payload（base64url 原文）
//   - 声明：aud 需包含 CF_ACCESS_AUD；校验 exp / nbf。

/** base64url → Uint8Array（补齐 padding 后走 atob，兼容任意字节序列） */
function b64urlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Access JWKS 内存缓存（5 分钟 TTL），避免每个管理请求都去 fetch 公钥 */
let accessCertCache = { at: 0, keys: null as Array<{ kid: string; n: string; e: string }> | null }
const ACCESS_CERTS_TTL_MS = 5 * 60 * 1000

async function getAccessKeys(teamDomain: string): Promise<Array<{ kid: string; n: string; e: string }> | null> {
  if (accessCertCache.keys && Date.now() - accessCertCache.at < ACCESS_CERTS_TTL_MS) {
    return accessCertCache.keys
  }
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const body = (await res.json()) as { keys?: Array<{ kid?: string; n?: string; e?: string }> }
    const keys = (body.keys || [])
      .filter((k) => k.kid && k.n && k.e)
      .map((k) => ({ kid: k.kid as string, n: k.n as string, e: k.e as string }))
    accessCertCache = { at: Date.now(), keys }
    return keys
  } catch {
    return null
  }
}

/**
 * Cloudflare Access JWT 校验中间件。
 * - 未配置 CF_ACCESS_AUD → 直接放行（零影响，保持现状）。
 * - 配置后：对 /admin/* 校验 Cf-Access-Jwt 签名与 aud/exp/nbf；不合法返回 403。
 *   CF_ACCESS_AUD 已配但 CF_ACCESS_TEAM_DOMAIN 缺失 → 配置错误，返回 500 并说明。
 */
export async function cloudflareAccessMiddleware(c: Context<AppEnv>, next: Next) {
  const aud = c.env.CF_ACCESS_AUD
  if (!aud) return next() // 未启用 → 跳过，绝不碰客户端 /v1
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN
  if (!teamDomain) {
    return c.json({ success: false, message: '已配置 CF_ACCESS_AUD 但缺少 CF_ACCESS_TEAM_DOMAIN' }, 500)
  }

  const jwt = c.req.header('Cf-Access-Jwt')
  if (!jwt) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：缺少 Cf-Access-Jwt 头' }, 403)
  }

  const parts = jwt.split('.')
  if (parts.length !== 3) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：JWT 格式错误' }, 403)
  }
  const [headerB64, payloadB64, sigB64] = parts
  if (!sigB64) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：JWT 未签名' }, 403)
  }

  let header: { kid?: string; alg?: string }
  let claims: Record<string, unknown>
  let payloadBytes: Uint8Array
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)))
    payloadBytes = b64urlDecode(payloadB64)
    claims = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：JWT 载荷无法解析' }, 403)
  }
  if (!header.kid) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：缺少 kid' }, 403)
  }

  const keys = await getAccessKeys(teamDomain)
  if (!keys) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：获取公钥失败' }, 503)
  }
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：公钥不匹配' }, 403)
  }

  // 校验签名（RSASSA-PKCS1-v1_5 + SHA-256）
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      key,
      b64urlDecode(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    )
    if (!valid) {
      return c.json({ success: false, message: 'Cloudflare Access 认证失败：签名无效' }, 403)
    }
  } catch {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：验签异常' }, 403)
  }

  // 校验声明：aud 包含目标 AUD；exp / nbf 时效
  const now = Math.floor(Date.now() / 1000)
  const claimAud = claims.aud as Array<unknown> | unknown
  const auds = Array.isArray(claimAud) ? claimAud.map(String) : [String(claimAud)]
  if (!auds.includes(aud)) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：aud 不匹配' }, 403)
  }
  if (typeof claims.exp === 'number' && claims.exp < now) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：已过期' }, 403)
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) {
    return c.json({ success: false, message: 'Cloudflare Access 认证失败：尚未生效' }, 403)
  }

  // 通过后可把邮箱放进上下文，供后台展示/审计
  c.set('cvAccessEmail', typeof claims.email === 'string' ? claims.email : undefined)
  return next()
}

/** 管理员登录 */
export async function handleLogin(c: Context<AppEnv>) {
  const { username, password } = await c.req.json()
  const adminUser = c.env.ADMIN_USERNAME
  const adminPass = c.env.ADMIN_PASSWORD

  // S8c：按客户端 IP 限速——窗口内失败 ≥5 次直接拒绝，防暴力破解
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-real-ip') || ''
  if (ip) {
    const failed = await getLoginFailureCount(c.env, ip)
    if (failed >= 5) {
      return c.json({ success: false, message: '尝试次数过多，请 5 分钟后再试' }, 429)
    }
  }

  if (!adminUser || !adminPass) {
    return c.json({
      success: false,
      message: '未配置管理员账号，请在 Cloudflare 环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD',
    }, 500)
  }

  if (!username || !password) {
    return c.json({ success: false, message: '请输入用户名和密码' }, 400)
  }

  if (!safeEqual(username, adminUser)) {
    if (ip) await recordLoginFailure(c.env, ip)
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const passwordHash = await hashPassword(password)
  const adminPassHash = await hashPassword(adminPass)

  if (!safeEqual(passwordHash, adminPassHash)) {
    if (ip) await recordLoginFailure(c.env, ip)
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  // 登录成功：清掉该 IP 的失败计数
  if (ip) await resetLoginFailures(c.env, ip)

  const sessionId = await createSession(c.env, username, SESSION_TTL)
  setCookie(c, 'session_id', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })

  return c.json({ success: true, message: '登录成功' })
}

/** 退出登录 */
export async function handleLogout(c: Context<AppEnv>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    await deleteSession(c.env, sessionId)
    deleteCookie(c, 'session_id')
  }
  return c.redirect('/')
}

/** 转发 API Key 验证中间件 */
export async function proxyKeyAuthMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      error: { message: '缺少或无效的 Authorization 头，格式: Bearer sk_cf_*', type: 'authentication_error' },
    }, 401)
  }

  const token = authHeader.slice(7)
  const proxyKey = await getValidProxyKey(c.env, token)
  if (!proxyKey) {
    return c.json({
      error: { message: 'API Key 无效或已禁用', type: 'authentication_error' },
    }, 401)
  }

  // 只把令牌对象和不可逆哈希放入请求上下文，观测层绝不持久化原始 sk_cf_*。
  c.set('proxyKey', proxyKey)
  c.set('proxyKeyHash', (await hashPassword(token)).slice(0, 32))
  return next()
}
