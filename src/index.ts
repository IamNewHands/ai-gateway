import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, managementAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels, handleAnthropicMessages, handleResponses } from './proxy'
import { handleProxyWebSocket } from './ws'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleUpsertProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleOAuthStatus,
  handleOAuthConnect,
  handleOAuthPoll,
  handleOAuthDisconnect,
  handleOAuthModels,
  handleClineOAuthConnect,
  handleClineOAuthPoll,
  handleLogs,
  handleLogsClear,
  handleLogConfig,
  writeLog,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession, getProviders } from './storage'
import { refreshAllOauthTokens } from './oauth'
import { runAllCheckins, handleCheckinTrigger, handleCheckinStatus } from './checkin'
import type { Env, Provider } from './types'

const app = new Hono<{ Bindings: Env }>()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())

// 首次请求时填充虚拟数据
let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedInitialData(c.env)
    seeded = true
  }
  return next()
})

// ===== 首页 =====
app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
})

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  return renderAdminPage(c)
})

// 系统状态
app.get('/admin/api/status', handleStatus)

// 提供商 CRUD
app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-key', handleTestKeyNew)
app.post('/admin/api/test-model', handleTestModelNew)

// 转发 Key 管理
app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

// OAuth 设备码管理
app.get('/admin/api/oauth/:id/status', handleOAuthStatus)
app.post('/admin/api/oauth/:id/connect', handleOAuthConnect)
app.post('/admin/api/oauth/:id/poll', handleOAuthPoll)
app.post('/admin/api/oauth/:id/disconnect', handleOAuthDisconnect)
app.get('/admin/api/oauth/:id/models', handleOAuthModels)

// Cline 一键授权（WorkOS 设备码流程，登录后自动把 refreshToken 存入账号池）
app.post('/admin/api/cline/oauth/:id/connect', handleClineOAuthConnect)
app.post('/admin/api/cline/oauth/:id/poll', handleClineOAuthPoll)

// 日志管理
app.get('/admin/api/logs', handleLogs)
app.delete('/admin/api/logs', handleLogsClear)
app.get('/admin/api/logs/config', handleLogConfig)
app.post('/admin/api/logs/config', handleLogConfig)

// 签到（浏览器面板用，需 session 认证）
app.get('/admin/api/checkin/status', handleCheckinStatus)
app.post('/admin/api/checkin', handleCheckinTrigger)

// ===== 对外管理 API（需管理 Token 验证，供手机脚本等外部调用） =====
app.use('/api/manage/*', managementAuthMiddleware)
app.get('/api/manage/providers', handleGetProviders)
app.post('/api/manage/providers/upsert', handleUpsertProvider)
app.delete('/api/manage/providers/:id', handleDeleteProvider)
// 签到（手机脚本手动触发，需管理 Token）
app.post('/api/manage/checkin', handleCheckinTrigger)
app.post('/api/manage/checkin/:id', handleCheckinTrigger)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)

// Anthropic Messages API — 必须在 /v1/* 通配之前注册
app.post('/v1/messages', handleAnthropicMessages)

// OpenAI Responses API — 必须在 /v1/* 通配之前注册
app.post('/v1/responses', handleResponses)

// WebSocket 桥接 — Trae 等客户端自定义模型直连网关时用 WS 传输（GET 升级请求无 body，
// 不能让 handleProxy 用 c.req.json() 读取，否则抛 "Unexpected end of JSON input" → 500 → 握手失败）。
// 必须在通用转发 handleProxy 之前注册。
app.all('/v1/*', async (c, next) => {
  const upgrade = (c.req.header('Upgrade') || '').toLowerCase()
  if (upgrade === 'websocket' || c.req.header('Sec-WebSocket-Key')) {
    return handleProxyWebSocket(c)
  }
  return next()
})

// 通用转发（Chat Completions 及其他）
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

// ===== Cron：定时任务（按 event.cron 分发） =====
// crons（见 wrangler.toml）：
//   "0 */2 * * *"   —— 每 2 小时刷新 OAuth token
//   "0 1,13 * * *"  —— 每日 09:00/21:00（北京时间）WorkBuddy 签到
// ⚠️ Cloudflare ES Module Workers 只认 default export 上的 handler：
//    scheduled 若写成 named export（export async function scheduled），运行时找不到
//    default.scheduled，cron 触发后会被静默丢弃 → 定时签到/token 刷新均不执行。
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  if (event.cron === '0 1,13 * * *') {
    // 签到
    const summary = await runAllCheckins(env)
    console.log(`[checkin] cron done: total=${summary.total} ok=${summary.success} already=${summary.already} fail=${summary.fail} skipped=${summary.skipped}`)
    return
  }
  // token 刷新（默认 / "0 */2 * * *"）
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth)
  const result = await refreshAllOauthTokens(env, oauthProviders)
  console.log(`[oauth] cron refresh done: ${result.ok} ok, ${result.fail} fail`)
}

// fetch 与 scheduled 必须都挂在 default export 上，Cloudflare 才会注册并调用。
// Hono 的 fetch 为实例箭头属性，解构后 this 仍绑定 app，可安全赋值。
export default {
  fetch: app.fetch,
  scheduled,
}
