import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
} from './storage'
import { testModelConnection } from './proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import { startOauthDeviceFlow, pollOauthDeviceFlow, readOauthToken, deleteOauthToken, getOauthAccessToken, buildOauthHeaders } from './oauth'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  OAuthDeviceConfig,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    authType: body.authType || 'api-key',
    oauth: body.oauth,
    apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
      : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.oauth !== undefined) updates.oauth = body.oauth
if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  // OAuth 提供商：用 KV 中的 access_token 测试，无需 API Key
  if (provider.authType === 'oauth-device' && provider.oauth) {
    const cfg = provider.oauth
    const token = await getOauthAccessToken(c.env, provider.id, cfg)
    if (!token) {
      return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
    }
    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const endpoint = provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildOauthHeaders(cfg, token),
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true }),
        signal: AbortSignal.timeout(20000),
      })
      // OAuth 上游（如 WorkBuddy）强制 stream，2xx 即视为连通
      return c.json<ApiResponse>({ success: true, data: { success: response.ok, statusCode: response.status, message: response.ok ? '' : `HTTP ${response.status}` } })
    } catch (err) {
      return c.json<ApiResponse>({ success: true, data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' } })
    }
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(provider.baseUrl, enabledKeys[0].key, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { 'Authorization': `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  if (!url || (!apiKey && !(providerId && isOpenCodeProvider(providerId)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.data,
      },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !isOpenCodeProvider(providerId || ''))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean; allowedModels?: string[] }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.allowedModels !== undefined) updates.allowedModels = body.allowedModels
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== OAuth 设备码管理 =====

/** 查询某 OAuth 提供商的连接状态（token 是否存在/过期时间） */
export async function handleOAuthStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device') {
    return c.json<ApiResponse>({ success: false, message: '该提供商未启用 OAuth 认证' }, 400)
  }

  const token = await readOauthToken(c.env, id)
  return c.json<ApiResponse>({
    success: true,
    data: {
      connected: !!token,
      expiresAt: token?.expires_at ?? null,
      updatedAt: token?.updated_at ?? null,
    },
  })
}

/** 发起 OAuth 设备码授权流程，返回授权链接与用户码 */
export async function handleOAuthConnect(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const result = await startOauthDeviceFlow(c.env, id, provider.oauth)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 500)
  }
  return c.json<ApiResponse>({ success: true, data: result.device })
}

/** 轮询 OAuth 设备码授权结果 */
export async function handleOAuthPoll(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const result = await pollOauthDeviceFlow(c.env, id, provider.oauth)
  return c.json<ApiResponse>({
    success: result.status === 'success',
    message: result.message,
    data: result.status === 'success' ? { connected: true } : { connected: false },
  })
}

/** 断开 OAuth 连接，删除 KV 中的 token */
export async function handleOAuthDisconnect(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  await deleteOauthToken(c.env, id)
  return c.json<ApiResponse>({ success: true, message: '已断开 OAuth 连接' })
}

/**
 * 拉取 OAuth 提供商的上游模型列表（登录后动态发现，替代写死的预设模型）。
 * - 优先使用 cfg.modelsUrl；留空则回退 ${baseUrl}/models（OpenAI 标准）
 * - 兼容三种响应格式：WorkBuddy（data.agents[cli].models）、OpenAI（data[]）、根级 models[]
 */
export async function handleOAuthModels(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const cfg = provider.oauth
  const token = await getOauthAccessToken(c.env, provider.id, cfg)
  if (!token) {
    return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
  }

  const cleanBase = provider.baseUrl.replace(/\/$/, '')
  const modelsUrl = cfg.modelsUrl || `${cleanBase}/models`

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: buildOauthHeaders(cfg, token),
      signal: AbortSignal.timeout(20000),
    })

    if (!response.ok) {
      let detail = ''
      try { detail = (await response.text()).substring(0, 200) } catch { /* ignore */ }
      return c.json<ApiResponse>({
        success: false,
        message: `上游返回 HTTP ${response.status}${detail ? '：' + detail : ''}`,
      })
    }

    const json: any = await response.json().catch(() => null)
    if (!json) {
      return c.json<ApiResponse>({ success: false, message: '上游响应不是有效 JSON' })
    }

    const models: Array<{ id: string }> = []

    // ① WorkBuddy 格式：{ code, data: { agents:[{name,models:[]}], models:[{id,disabled}] } }
    if (json?.data?.agents && Array.isArray(json.data.agents)) {
      const cliAgent = json.data.agents.find((a: any) => a && a.name === 'cli' && Array.isArray(a.models))
      const cliModelIds: string[] = cliAgent?.models || []
      const modelMeta = new Map<string, any>(
        (json.data.models || []).map((m: any) => [m?.id, m]).filter(([k]) => k)
      )
      if (cliModelIds.length > 0) {
        // CLI 可用模型 = cli agent 声明的模型，且在 models 元数据中存在、未被禁用
        models.push(...cliModelIds
          .filter((mid) => modelMeta.has(mid) && !modelMeta.get(mid)?.disabled)
          .map((mid) => ({ id: mid })))
      }
      // 兜底：没有 cli agent 时，用全部未禁用模型
      if (models.length === 0) {
        models.push(...(json.data.models || [])
          .filter((m: any) => m && m.id && !m.disabled)
          .map((m: any) => ({ id: m.id })))
      }
    }
    // ② OpenAI 格式：{ data: [{id}] }
    else if (Array.isArray(json?.data)) {
      models.push(...json.data.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
    }
    // ③ 根级 models 数组：{ models: [{id}] }
    else if (Array.isArray(json?.models)) {
      models.push(...json.models.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
    }

    if (models.length === 0) {
      return c.json<ApiResponse>({ success: false, message: '上游未返回任何模型' })
    }

    // 响应结构对齐 test-key，便于前端 renderModelGrid 复用
    return c.json<ApiResponse>({ success: true, data: { data: models } })
  } catch (err) {
    return c.json<ApiResponse>({ success: false, message: (err as Error).message || '拉取模型列表失败' })
  }
}
