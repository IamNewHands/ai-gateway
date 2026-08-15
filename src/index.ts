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
  handleOAuthGeminiCallback,
  handleOAuthM365Callback,
  handleOAuthM365ROPC,
  handleClineOAuthConnect,
  handleClineOAuthPoll,
  handleLogs,
  handleLogsClear,
  handleLogConfig,
  writeLog,
  handleGetMcps,
  handleCreateMcp,
  handleUpdateMcp,
  handleDeleteMcp,
  handleGetUnimodels,
  handleCreateUnimodel,
  handleUpdateUnimodel,
  handleDeleteUnimodel,
  handleGetCache,
  handleDeleteCache,
  handleClearCache,
  handleM365Sessions,
  handleM365SessionDelete,
} from './admin'
import { handleMcpJsonRpc } from './mcp-gateway'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession, getProviders } from './storage'
import {
  handleAnalyticsOverview,
  handleAnalyticsTrend,
  handleAnalyticsBreakdown,
  handleUsageLogs,
} from './analytics/admin-api'
import { refreshAllOauthTokens } from './oauth'
import { runAllCheckins, handleCheckinTrigger, handleCheckinStatus } from './checkin'
import { M365Session } from './m365/durable'
import type { AppEnv, Env, Provider } from './types'

export { M365Session }

const app = new Hono<AppEnv>()

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
// S5：logout 改 POST-only——GET 会被链接型 CSRF 触发（SameSite=Lax 对顶层导航 GET 仍带 Cookie）
app.post('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)
// S5：CSRF 防护——管理面写操作校验 Origin 与 Host 同源。
// 同源 fetch/表单都带 Origin；跨站提交（含旧浏览器无 Origin）另有 SameSite=Lax 兜底。
app.use('/admin/*', async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  const origin = c.req.header('Origin')
  if (origin) {
    let originHost: string
    try { originHost = new URL(origin).host }
    catch { return c.json({ success: false, message: '请求来源不合法' }, 403) }
    const host = c.req.header('Host') || ''
    if (originHost !== host) {
      return c.json({ success: false, message: '跨站请求被拒绝（CSRF 防护）' }, 403)
    }
  }
  return next()
})

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
// S5：模型拉取有副作用（请求上游并自动合并保存到 provider.models），改 POST 防链接型 CSRF
app.post('/admin/api/oauth/:id/models', handleOAuthModels)
// Gemini 授权回调：浏览器授权后把地址栏 URL 粘贴回后台提交（POST { callbackUrl }）
app.post('/admin/api/oauth/:id/callback', handleOAuthGeminiCallback)
// M365 PKCE 授权回调（POST { callbackUrl }）与 M365 ROPC 账号密码登录（POST { username, password }）
app.post('/admin/api/oauth/:id/m365-callback', handleOAuthM365Callback)
app.post('/admin/api/oauth/:id/m365-ropc', handleOAuthM365ROPC)

// Cline 一键授权（WorkOS 设备码流程，登录后自动把 refreshToken 存入账号池）
app.post('/admin/api/cline/oauth/:id/connect', handleClineOAuthConnect)
app.post('/admin/api/cline/oauth/:id/poll', handleClineOAuthPoll)

// Analytics Engine 总览与详细日志
app.get('/admin/api/analytics/overview', handleAnalyticsOverview)
app.get('/admin/api/analytics/trend', handleAnalyticsTrend)
app.get('/admin/api/analytics/breakdown', handleAnalyticsBreakdown)
app.get('/admin/api/usage-logs', handleUsageLogs)

// 日志管理
app.get('/admin/api/logs', handleLogs)
app.delete('/admin/api/logs', handleLogsClear)
app.get('/admin/api/logs/config', handleLogConfig)
app.post('/admin/api/logs/config', handleLogConfig)

// MCP Server 管理（MCP 聚合网关）
app.get('/admin/api/mcps', handleGetMcps)
app.post('/admin/api/mcps', handleCreateMcp)
app.put('/admin/api/mcps/:id', handleUpdateMcp)
app.delete('/admin/api/mcps/:id', handleDeleteMcp)

// 联合模型（uni-model）管理
app.get('/admin/api/unimodels', handleGetUnimodels)
app.post('/admin/api/unimodels', handleCreateUnimodel)
app.put('/admin/api/unimodels/:id', handleUpdateUnimodel)
app.delete('/admin/api/unimodels/:id', handleDeleteUnimodel)

// 内存缓存管理（P4）
app.get('/admin/api/cache', handleGetCache)
app.delete('/admin/api/cache', handleClearCache)
app.delete('/admin/api/cache/:key', handleDeleteCache)

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

// MCP 聚合网关（JSON-RPC，OpenAI 兼容端点之外的独立协议）
app.post('/v1/mcp', handleMcpJsonRpc)

// Anthropic Messages API — 必须在 /v1/* 通配之前注册
app.post('/v1/messages', handleAnthropicMessages)

// OpenAI Responses API — 必须在 /v1/* 通配之前注册
app.post('/v1/responses', handleResponses)

// M365 会话绑定管理（GET/POST 查询、DELETE 解除）—— 需在通用转发 handleProxy 之前注册
app.all('/v1/sessions', handleM365Sessions)
app.delete('/v1/sessions/:id', handleM365SessionDelete)

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
  // 请求体 JSON 解析失败（原生 Request.json() 会抛 SyntaxError）：返回 400 而非 500。
  // 覆盖 admin/auth 等所有 `await c.req.json()` 无 try/catch 的路径（R6）。
  if (err instanceof SyntaxError && /Unexpected (end of JSON input|token)/i.test(err.message)) {
    return c.json({ error: { message: '请求体 JSON 格式错误', type: 'bad_request' } }, 400)
  }
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
