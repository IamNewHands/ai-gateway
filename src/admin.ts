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
import { isQoderProvider, fetchQoderModels } from './qoder/proxy'
import { isClineProvider, fetchClineModels, testClineChat, testClineRefreshToken, startClineOAuth, pollClineOAuth } from './cline/proxy'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import { startOauthDeviceFlow, pollOauthDeviceFlow, readOauthToken, deleteOauthToken, getOauthAccessToken, buildOauthHeaders, detectTokenRealm } from './oauth'
import type {
  Env,
  ApiResponse,
  Provider,
  ApiKeyEntry,
  Model,
  CreateProviderRequest,
  UpdateProviderRequest,
  UpsertProviderRequest,
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
    type: body.type,
    visionBridge: body.visionBridge,
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
  if (body.type !== undefined) updates.type = body.type
  if (body.visionBridge !== undefined) updates.visionBridge = body.visionBridge ?? undefined
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

/**
 * 对外管理 API：upsert + 合并。
 * - id 不存在 → 创建（需 name + baseUrl）
 * - id 存在 → 合并：name/baseUrl/apiType/authType/enabled 传了覆盖；
 *   apiKeys 按 key 字符串去重追加（保留原 enabled，永不删除）；
 *   models 按 id 去重追加（永不删除）；oauth 保留不动。
 * 供 /api/manage/providers/upsert 使用（需 managementAuthMiddleware）。
 */
export async function handleUpsertProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<UpsertProviderRequest>()
  if (!body.id) {
    return c.json<ApiResponse>({ success: false, message: 'id 为必填项' }, 400)
  }

  // opencode 未传地址时自动填充（与 handleCreateProvider 一致）
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  // 归一化入参 keys/models 为对象数组，确保 enabled 有值（normalizeArray 对象路径不补 enabled）
  const incomingKeys: ApiKeyEntry[] = (body.apiKeys || []).map((k) =>
    typeof k === 'string'
      ? { key: k, enabled: true }
      : { key: k.key, enabled: k.enabled !== undefined ? k.enabled : true }
  )
  const incomingModels: Model[] = (body.models || []).map((m) =>
    typeof m === 'string'
      ? { id: m, enabled: true }
      : { id: m.id, enabled: m.enabled !== undefined ? m.enabled : true }
  )

  const existing = await getProvider(c.env, body.id)

  // ===== 不存在 → 创建 =====
  if (!existing) {
    if (!body.name || !body.baseUrl) {
      return c.json<ApiResponse>({ success: false, message: '新建时 name、baseUrl 为必填项' }, 400)
    }
    const now = new Date().toISOString()
    const provider: Provider = {
      id: body.id,
      name: body.name,
      baseUrl: body.baseUrl.replace(/\/$/, ''),
      apiType: body.apiType || 'openai',
      authType: body.authType || 'api-key',
      apiKeys: incomingKeys,
      models: incomingModels,
      enabled: body.enabled !== undefined ? body.enabled : true,
      createdAt: now,
      updatedAt: now,
    }
    await addProvider(c.env, provider)
    return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
  }

  // ===== 存在 → 合并 =====
  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.enabled !== undefined) updates.enabled = body.enabled

  // keys 合并：以现有为底，按 key 字符串去重追加，保留原 enabled
  if (body.apiKeys !== undefined) {
    const merged: ApiKeyEntry[] = [...existing.apiKeys]
    const existingKeySet = new Set(merged.map((k) => k.key))
    for (const k of incomingKeys) {
      if (existingKeySet.has(k.key)) continue  // 已存在：保留原项，不覆盖、不重复
      merged.push({ key: k.key, enabled: k.enabled })
      existingKeySet.add(k.key)
    }
    updates.apiKeys = merged
  }

  // models 合并：以现有为底，按 id 去重追加
  if (body.models !== undefined) {
    const merged: Model[] = [...existing.models]
    const existingModelSet = new Set(merged.map((m) => m.id))
    for (const m of incomingModels) {
      if (existingModelSet.has(m.id)) continue
      merged.push({ id: m.id, enabled: m.enabled })
      existingModelSet.add(m.id)
    }
    updates.models = merged
  }

  // oauth 不在 updates 中 → updateProvider 浅合并时保留 existing.oauth
  const updated = await updateProvider(c.env, body.id, updates)
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
  // 同时删除 OAuth token 和设备码状态，避免残留数据干扰
  await deleteOauthToken(c.env, id)
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

  // 注意：不校验模型是否已保存到 KV。测试的目的是验证"这个模型 ID 能否在上游用"，
  // 用户在编辑表单里新加的模型（尚未点保存）也应能直接测试，避免"先保存才能测"的割裂体验。
  // modelId 仅作为字符串透传给上游 chat/completions，与是否已入库无关。

  // OAuth 提供商：用 KV 中的 access_token 测试，无需 API Key
  if (provider.authType === 'oauth-device' && provider.oauth) {
    const cfg = provider.oauth
    const token = await getOauthAccessToken(c.env, provider.id, cfg)
    if (!token) {
      return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
    }
    const tokenState = await readOauthToken(c.env, provider.id)
    const cookies = tokenState?.cookies
    // 域路由 + 401 自动切换：先尝试主域，401 时自动切换到备用域
    // CN token 不应尝试 Global 域（iss 不匹配，APISIX 必然 401）
    // aigateway 内部始终用 OpenAI chat/completions 格式与上游通信
    const endpoint = 'chat/completions'
    const tokenRealm = detectTokenRealm(token)
    const realms: Array<'cn' | 'global'> = tokenRealm === 'global' && cfg.globalBaseUrl
      ? ['global', 'cn']
      : tokenRealm === 'cn'
        ? ['cn']
        : ['cn', ...(cfg.globalBaseUrl ? ['global' as const] : [])]
    const testBody = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true })
    for (const realm of realms) {
      const realmBase = (realm === 'global' && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
      const origin = realm === 'global' && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
      const url = `${realmBase}/${endpoint}`
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: buildOauthHeaders(cfg, token, { origin, apiType: provider.apiType, cookies }),
          body: testBody,
          signal: AbortSignal.timeout(20000),
        })
        // 401 且有备用域 → 自动切换重试
        if (response.status === 401 && realms.length > 1 && realm !== realms[realms.length - 1]) {
          console.log(`[test-model] ${realm} 域返回 401，自动切换到下一个域`)
          continue
        }
        return c.json<ApiResponse>({ success: true, data: { success: response.ok, statusCode: response.status, message: response.ok ? '' : `HTTP ${response.status}` } })
      } catch (err) {
        if (realms.length > 1 && realm !== realms[realms.length - 1]) continue
        return c.json<ApiResponse>({ success: true, data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' } })
      }
    }
    return c.json<ApiResponse>({ success: true, data: { success: false, statusCode: 0, message: '所有域均请求失败' } })
  }

  // Cline：用 refreshToken 账号池发送最小请求测试模型
  if (isClineProvider(provider.id)) {
    const tokens = provider.apiKeys.filter(k => k.enabled).map(k => k.key)
    const result = await testClineChat(tokens, modelId)
    return c.json<ApiResponse>({ success: true, data: result })
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

  // Cline：校验 refreshToken 是否有效，成功时一并返回实测可用模型列表
  if (providerId && isClineProvider(providerId)) {
    const result = await testClineRefreshToken(apiKey || '')
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.success ? fetchClineModels().models : null,
      },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
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

  // Cline：用 refreshToken 发送最小请求测试模型可用性
  if (providerId && isClineProvider(providerId)) {
    const tokens = apiKey ? apiKey.split('\n').filter(Boolean) : []
    const result = await testClineChat(tokens, model)
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  // aigateway 内部始终用 OpenAI chat/completions 格式与上游通信
  const endpoint = 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
      hasCookies: !!(token?.cookies),
      cookiesPreview: token?.cookies ? token.cookies.substring(0, 100) : null,
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

/** Cline 一键授权：发起 WorkOS 设备码流程，返回授权链接与设备码（与原项目 cline_oauth.py 一致） */
export async function handleClineOAuthConnect(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isClineProvider(provider.id)) {
    return c.json<ApiResponse>({ success: false, message: '仅支持 Cline 提供商一键授权' }, 400)
  }
  const result = await startClineOAuth(c.env, id)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 500)
  }
  return c.json<ApiResponse>({ success: true, data: result.device })
}

/** Cline 一键授权：轮询 WorkOS 授权结果，成功后自动把 refreshToken 存入账号池 */
export async function handleClineOAuthPoll(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isClineProvider(provider.id)) {
    return c.json<ApiResponse>({ success: false, message: '仅支持 Cline 提供商一键授权' }, 400)
  }
  const result = await pollClineOAuth(c.env, provider)
  return c.json<ApiResponse>({
    success: result.status === 'success',
    message: result.message,
    data: result.status === 'success' ? { connected: true } : { connected: false },
  })
}

/**
 * 解析上游模型列表响应，兼容三种格式：
 * ① WorkBuddy：{ code, data: { agents:[{name,models:[]}], models:[{id,disabled}] } }
 * ② OpenAI：{ data: [{id}] }
 * ③ 根级 models 数组：{ models: [{id}] }
 */
function parseModelList(json: any): Array<{ id: string }> {
  const models: Array<{ id: string }> = []
  if (json?.data?.agents && Array.isArray(json.data.agents)) {
    const cliAgent = json.data.agents.find((a: any) => a && a.name === 'cli' && Array.isArray(a.models))
    const cliModelIds: string[] = cliAgent?.models || []
    const modelMeta = new Map<string, any>(
      (json.data.models || []).map((m: any) => [m?.id, m] as [string, any]).filter(([k]: [string, any]) => k)
    )
    if (cliModelIds.length > 0) {
      models.push(...cliModelIds
        .filter((mid) => modelMeta.has(mid) && !modelMeta.get(mid)?.disabled)
        .map((mid) => ({ id: mid })))
    }
    if (models.length === 0) {
      models.push(...(json.data.models || [])
        .filter((m: any) => m && m.id && !m.disabled)
        .map((m: any) => ({ id: m.id })))
    }
  } else if (Array.isArray(json?.data)) {
    models.push(...json.data.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
  } else if (Array.isArray(json?.models)) {
    models.push(...json.models.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
  }
  return models
}

/**
 * 拉取 OAuth 提供商的上游模型列表（登录后动态发现，替代写死的预设模型）。
 * - 401 自动域切换：Global token 打到 CN 域会被 APISIX 拒绝（反之亦然），
 *   当 JWT 域判断不确定或配置缺失时，自动尝试另一个域。
 * - 参考 cpa-plugin/models.go 的 callModelsAPI 实现。
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

  // QoderWork：模型发现走 COSY 签名的网关端点（GET /algo/api/v2/model/list），
  // 返回 {chat:[{key,display_name,enable}]}，只取启用模型。
  if (isQoderProvider(provider.id) || cfg.flowType === 'qoder' || (provider.baseUrl && provider.baseUrl.includes('qoder'))) {
    try {
      const result = await fetchQoderModels(c.env, provider)
      if (!result.ok) {
        const status = result.status && result.status >= 400 ? result.status : 502
        const dbg = result.debug || {}
        const debugInfo = [
          `identityJSON=${dbg.identityJSON || '(missing)'}`,
          `tempKey=${dbg.tempKey || '(missing)'}`,
          `sigInput=${dbg.sigInput || '(missing)'}`,
          `full=${JSON.stringify(dbg).substring(0, 3000)}`,
        ].join(' | ')
        return c.json<ApiResponse>({ success: false, message: result.message + ' --- 调试信息 --- ' + debugInfo, data: { providerId: provider.id } }, status as Parameters<typeof c.json>[1])
      }
      const models = result.models || []
      // 自动合并保存到 provider.models（按 id 去重追加，保留已有 enabled 状态）
      try {
        const existing = provider.models || []
        const existingIds = new Set(existing.map((m) => m.id))
        const merged = [...existing]
        for (const m of models) {
          if (!existingIds.has(m.id)) {
            merged.push({ id: m.id, enabled: true })
            existingIds.add(m.id)
          }
        }
        if (merged.length !== existing.length) {
          await updateProvider(c.env, id, { models: merged })
        }
      } catch (e) {
        console.warn(`[oauth-models] auto-save failed: ${(e as Error).message}`)
      }
      return c.json<ApiResponse>({ success: true, data: { data: models } })
    } catch (err) {
      console.error(`[oauth-models] qoder exception:`, err)
      const msg = (err as Error)?.stack || (err as Error)?.message || String(err)
      return c.json<ApiResponse>({ success: false, message: `Qoder 模型拉取异常: ${msg}` }, 500)
    }
  }

  const token = await getOauthAccessToken(c.env, provider.id, cfg)
  if (!token) {
    return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
  }
  const tokenState = await readOauthToken(c.env, provider.id)
  const cookies = tokenState?.cookies

  const debug: Record<string, unknown> = {
    realm: detectTokenRealm(token),
    tokenHeader: cfg.tokenHeader || 'x-api-key',
    tokenHeaderPrefix: cfg.tokenHeaderPrefix || '',
    hasCookies: !!cookies,
    cookiesPreview: cookies ? cookies.substring(0, 80) + '...' : '(none)',
    modelsUrl: cfg.modelsUrl || `${provider.baseUrl.replace(/\/$/, '')}/models`,
    baseUrl: provider.baseUrl,
    extraHeaders: cfg.extraHeaders,
    tokenExpiresAt: tokenState?.expires_at ? new Date(tokenState.expires_at).toISOString() : 'unknown',
  }

  const cleanBase = provider.baseUrl.replace(/\/$/, '')
  const realm = detectTokenRealm(token)

  // 构建候选端点：主域优先，备用域兜底（401 时自动切换）
  const cnEndpoint = {
    url: cfg.modelsUrl || `${cleanBase}/models`,
    origin: cfg.extraHeaders?.Origin as string | undefined,
    label: 'CN',
  }
  const globalUrl = cfg.globalModelsUrl
    || (cfg.globalBaseUrl ? `${cfg.globalBaseUrl.replace(/\/$/, '')}/models` : '')
  const globalEndpoint = globalUrl
    ? { url: globalUrl, origin: cfg.globalOrigin as string | undefined, label: 'Global' }
    : null

  // JWT 明确判定域时，对应端点优先；null/不确定时 CN 优先（baseUrl 默认 CN）
  // CN token 不应尝试 Global 域（iss 不匹配，APISIX 必然 401）
  const candidates = realm === 'global' && globalEndpoint
    ? [globalEndpoint, cnEndpoint]
    : realm === 'cn'
      ? [cnEndpoint]
      : [cnEndpoint, globalEndpoint].filter(Boolean) as typeof cnEndpoint[]

  const errors: string[] = []
  for (const ep of candidates) {
    try {
      const reqHeaders = buildOauthHeaders(cfg, token, { origin: ep.origin, cookies })
      debug['requestUrl'] = ep.url
      debug['requestHeaders'] = Object.keys(reqHeaders).reduce((acc, k) => {
        acc[k] = k.toLowerCase() === 'cookie' ? (reqHeaders[k] || '').substring(0, 80) + '...' : reqHeaders[k]
        return acc
      }, {} as Record<string, string>)

      const response = await fetch(ep.url, {
        method: 'GET',
        headers: reqHeaders,
        signal: AbortSignal.timeout(20000),
      })

      if (response.ok) {
        const json: any = await response.json().catch(() => null)
        if (!json) {
          return c.json<ApiResponse>({ success: false, message: '上游响应不是有效 JSON', data: debug }, 502)
        }
        const models = parseModelList(json)
        if (models.length === 0) {
          return c.json<ApiResponse>({ success: false, message: '上游未返回任何模型', data: debug }, 502)
        }
        // 自动合并保存到 provider.models（按 id 去重追加，保留已有 enabled 状态）
        // 避免"获取模型→测试"时因未手动保存而报"模型 xxx 不存在于提供商"
        try {
          const existing = provider.models || []
          const existingIds = new Set(existing.map((m) => m.id))
          const merged = [...existing]
          for (const m of models) {
            if (!existingIds.has(m.id)) {
              merged.push({ id: m.id, enabled: true })
              existingIds.add(m.id)
            }
          }
          if (merged.length !== existing.length) {
            await updateProvider(c.env, id, { models: merged })
          }
        } catch (e) {
          console.warn(`[oauth-models] auto-save failed: ${(e as Error).message}`)
        }
        return c.json<ApiResponse>({ success: true, data: { data: models } })
      }

      let detail = ''
      try { detail = (await response.text()).substring(0, 500) } catch { /* ignore */ }
      const errMsg = `[${ep.label}] HTTP ${response.status}${detail ? '：' + detail : ''}`
      errors.push(errMsg)

      if ((response.status === 401 || response.status === 400) && candidates.length > 1) {
        continue
      }

      return c.json<ApiResponse>({
        success: false,
        message: `上游返回 HTTP ${response.status}${detail ? '：' + detail : ''} --- 调试信息 --- ${JSON.stringify(debug)}`,
        data: { debug, allErrors: errors },
      }, 502)
    } catch (err) {
      const errMsg = `[${ep.label}] ${(err as Error).message || '请求异常'}`
      errors.push(errMsg)
      if (candidates.length > 1) continue
      return c.json<ApiResponse>({ success: false, message: (err as Error).message || '拉取模型列表失败', data: { debug, allErrors: errors } }, 502)
    }
  }

  return c.json<ApiResponse>({
    success: false,
    message: `所有域均请求失败: ${errors.join(' | ')}`,
    data: { debug, allErrors: errors },
  }, 502)
}

// ===== 日志系统 =====

export interface LogEntry {
  id: string
  time: string
  type: 'info' | 'error' | 'warn' | 'request' | 'response'
  message: string
  details?: string
}

const LOG_PREFIX = 'log:'
const LOG_TTL = 60 * 60 * 24 * 7 // 7 天

/** 写日志到 KV */
export async function writeLog(env: Env, type: LogEntry['type'], message: string, details?: string) {
  // 检查是否启用日志
  const enabled = await env.KV.get('config:log_enabled')
  if (enabled !== 'true') return

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const entry: LogEntry = {
    id,
    time: new Date().toISOString(),
    type,
    message,
    details: details ? details.substring(0, 4000) : undefined,
  }
  await env.KV.put(LOG_PREFIX + id, JSON.stringify(entry), { expirationTtl: LOG_TTL })
}

/** 获取日志列表（支持 limit / offset 分页） */
export async function handleLogs(c: Context<{ Bindings: Env }>) {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50'), 1), 200)
  const type = c.req.query('type') || ''
  const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0)

  // 用 cursor 循环拉取全部 key 名（KV.list 单次最多 1000 条，仅返回 key 名很快）。
  // key 名 = 'log:' + Date.now().toString(36) + 随机，字典序等价于时间序。
  const allNames: string[] = []
  let cursor: string | undefined
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    for (const k of list.keys) allNames.push(k.name)
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)
  allNames.reverse()  // 最新在前

  // 从 offset 开始向后读，按 type 过滤收集，直到满 limit 或读完。
  // 分批并行读取（25 条/批），避免一次性发起过多 subrequest。
  const BATCH = 25
  const logs: LogEntry[] = []
  for (let i = offset; i < allNames.length && logs.length < limit; i += BATCH) {
    const batch = allNames.slice(i, i + BATCH)
    const raws = await Promise.all(batch.map(n => c.env.KV.get(n)))
    for (const raw of raws) {
      if (!raw) continue
      try {
        const entry = JSON.parse(raw) as LogEntry
        if (!type || entry.type === type) {
          logs.push(entry)
        }
      } catch { /* skip corrupt entries */ }
    }
  }

  return c.json<ApiResponse>({ success: true, data: { logs: logs.slice(0, limit), total: allNames.length, offset } })
}

/** 清除日志 */
export async function handleLogsClear(c: Context<{ Bindings: Env }>) {
  const list = await c.env.KV.list({ prefix: LOG_PREFIX })
  for (const k of list.keys) {
    await c.env.KV.delete(k.name)
  }
  return c.json<ApiResponse>({ success: true, message: '日志已清除' })
}

/** 获取/设置日志开关状态 */
export async function handleLogConfig(c: Context<{ Bindings: Env }>) {
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    const enabled = body.enabled ? 'true' : 'false'
    await c.env.KV.put('config:log_enabled', enabled)
    return c.json<ApiResponse>({ success: true, data: { enabled: body.enabled } })
  }
  const enabled = await c.env.KV.get('config:log_enabled')
  return c.json<ApiResponse>({ success: true, data: { enabled: enabled === 'true' } })
}
