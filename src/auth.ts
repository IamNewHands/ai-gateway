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
