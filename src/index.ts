import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
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
  handleLogs,
  handleLogsClear,
  handleLogConfig,
  writeLog,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession, getProviders } from './storage'
import { refreshAllOauthTokens } from './oauth'
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

app.get('/admin', async (c) => renderAdminPage(c))

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

// 日志管理
app.get('/admin/api/logs', handleLogs)
app.delete('/admin/api/logs', handleLogsClear)
app.get('/admin/api/logs/config', handleLogConfig)
app.post('/admin/api/logs/config', handleLogConfig)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)
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

export default app

// ===== Cron：定时刷新 OAuth token =====
export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth)
  const result = await refreshAllOauthTokens(env, oauthProviders)
  console.log(`[oauth] cron refresh done: ${result.ok} ok, ${result.fail} fail`)
}
