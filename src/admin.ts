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
import { isGeminiProvider, testGeminiModel, GEMINI_MODELS } from './gemini/proxy'
import { isCnbProvider, testCnbConnection, CNB_MODELS } from './cnb/proxy'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import { startOauthDeviceFlow, pollOauthDeviceFlow, readOauthToken, deleteOauthToken, getOauthAccessToken, buildOauthHeaders, detectTokenRealm, submitOauthGeminiCallback } from './oauth'
import type {
  AppEnv,
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

/**
 * SSRF 防护：校验待 fetch 的 URL 是否安全（baseUrl / 测试 URL / OAuth 端点）。
 * - 只允许 http/https
 * - 拒绝带用户名/密码凭据的 URL
 * - 拒绝指向本机/内网/保留地址段的 IP 字面量（IPv4 / IPv6）
 * - 拒绝 localhost 等常见本机域名
 * 说明：纯域名无法在 Worker 端做 DNS 反查，依赖平台出网隔离兜底 DNS 重绑定。
 */
export function isSafeHttpUrl(value: string): boolean {
  if (!value || value.length > 2048) return false
  let u: URL
  try { u = new URL(value) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  // 常见本机/内网域名直接拒绝
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') ||
      host === 'metadata.google.internal') return false
  // IP 字面量 → 按网段判断；否则（正常域名）放行
  return !/^[\d.]+$/.test(host) ? true : !isPrivateIp(host)
}

function isPrivateIp(host: string): boolean {
  if (host.includes(':')) {
    // IPv6（可能带 []）；::ffff:a.b.c.d 映射回 IPv4 判断
    let v6 = host
    if (v6.startsWith('[') && v6.endsWith(']')) v6 = v6.slice(1, -1)
    const low = v6.toLowerCase()
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
    if (low === '::' || low === '::1') return true
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true // 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return true // ULA
    return false
  }
  const parts = host.split('.').map((n) => parseInt(n, 10))
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 127) return true            // 本机/保留
  if (a === 10) return true                        // 10/8
  if (a === 169 && b === 254) return true          // 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true          // 192.168/16
  if (a === 192 && b === 0) return true            // 192.0.0.0/24（保留，含 192.0.0.9/10 任意播）
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试网段
  if (a >= 224) return true                        // 组播/广播/保留
  return false
}

/** 校验 OAuth 中会被服务端 fetch 的端点 URL；不合法返回错误文案，全部合法返回 null */
function validateOAuthUrls(oauth?: OAuthDeviceConfig): string | null {
  if (!oauth) return null
  const names: Array<[string, string | undefined]> = [
    ['deviceCodeUrl', oauth.deviceCodeUrl],
    ['deviceTokenUrl', oauth.deviceTokenUrl],
    ['refreshTokenUrl', oauth.refreshTokenUrl],
    ['modelsUrl', oauth.modelsUrl],
    ['globalBaseUrl', oauth.globalBaseUrl],
    ['globalModelsUrl', oauth.globalModelsUrl],
  ]
  for (const [name, v] of names) {
    if (v && !isSafeHttpUrl(v)) return `OAuth ${name} 必须是合法的 http/https 公网地址`
  }
  return null
}

export async function handleStatus(c: Context<AppEnv>) {
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

/** S8a：对外管理 API 脱敏——只保留 Key 末尾 4 位，绝不把完整 apiKey 泄出到 /api/manage/* */
function maskApiKeys(providers: Provider[]): Provider[] {
  return providers.map((p) => ({
    ...p,
    apiKeys: p.apiKeys.map((k) => ({ enabled: k.enabled, key: k.key.length > 4 ? `****${k.key.slice(-4)}` : '****' })),
  }))
}

export async function handleGetProviders(c: Context<AppEnv>) {
  const providers = await getProviders(c.env)
  // /api/manage/*（外部管理 API）一律脱敏；/admin/api/*（浏览器后台）保持原样以便编辑
  if (new URL(c.req.url).pathname.startsWith('/api/manage/')) {
    return c.json<ApiResponse<Provider[]>>({ success: true, data: maskApiKeys(providers) })
  }
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<AppEnv>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(body.baseUrl)) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
  }
  const oauthErr = validateOAuthUrls(body.oauth)
  if (oauthErr) {
    return c.json<ApiResponse>({ success: false, message: oauthErr }, 400)
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
    toolBridge: body.toolBridge,
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

export async function handleUpdateProvider(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) {
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
    }
    updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  }
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.oauth !== undefined) {
    const oauthErr = validateOAuthUrls(body.oauth)
    if (oauthErr) return c.json<ApiResponse>({ success: false, message: oauthErr }, 400)
    updates.oauth = body.oauth
  }
  if (body.type !== undefined) updates.type = body.type ?? undefined
  if (body.visionBridge !== undefined) updates.visionBridge = body.visionBridge ?? undefined
  if (body.toolBridge !== undefined) updates.toolBridge = body.toolBridge ?? undefined
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
export async function handleUpsertProvider(c: Context<AppEnv>) {
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
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
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
  if (body.baseUrl !== undefined) {
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
    }
    updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  }
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

export async function handleDeleteProvider(c: Context<AppEnv>) {
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

export async function handleTestModel(c: Context<AppEnv>) {
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

  // Gemini：走 cloudcode-pa 上游（OAuth token + project_id），发送最小请求验证
  if (isGeminiProvider(provider)) {
    const result = await testGeminiModel(c.env, provider, modelId)
    return c.json<ApiResponse>({ success: true, data: result })
  }

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

export async function handleTestKeyNew(c: Context<AppEnv>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  // CNB 免 Key：允许无 apiKey，由 providerId 判定
  let cnbProvider: Provider | null = null
  if (providerId) {
    const p = await getProvider(c.env, providerId)
    if (p && isCnbProvider(p)) cnbProvider = p
  }
  if (!url || (!apiKey && !(providerId && (isOpenCodeProvider(providerId) || cnbProvider)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(url)) {
    return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
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

  // CNB：CSRF 凭证连通性测试（免 Key）
  if (cnbProvider) {
    const result = await testCnbConnection(c.env, cnbProvider)
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
      method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    let errBody = ''
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    } else {
      // 读取上游错误体，写入日志便于排查（如 400/401 的具体原因）
      try {
        const raw = await response.text()
        errBody = raw.substring(0, 1000)
        await writeLog(c.env, 'error', `[test-key] ${cleanBase}/models → ${response.status}`, errBody)
      } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: {
        success: response.ok,
        statusCode: response.status,
        data,
        message: response.ok ? '' : `HTTP ${response.status}: ${errBody}`,
      },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<AppEnv>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !(isOpenCodeProvider(providerId || '') || (providerId && isCnbProvider({ id: providerId } as Provider))))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(url)) {
    return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
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

  // CNB：CSRF 凭证 + 最小 chat 请求测试模型可用性（完整链路）
  if (providerId) {
    const provider = await getProvider(c.env, providerId)
    if (provider && isCnbProvider(provider)) {
      const result = await testCnbConnection(c.env, provider, model)
      return c.json<ApiResponse>({
        success: true,
        data: { success: result.success, statusCode: result.statusCode || 0, message: result.message, data: result.data },
      })
    }
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

    let errBody = ''
    if (!response.ok) {
      // 读取上游错误体并写日志，便于排查 4xx/5xx 具体原因
      try {
        const raw = await response.text()
        errBody = raw.substring(0, 1000)
        await writeLog(c.env, 'error', `[test-model] ${cleanBase}/${endpoint} model=${model} → ${response.status}`, errBody)
      } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: {
        success: response.ok,
        statusCode: response.status,
        message: response.ok ? '' : `HTTP ${response.status}: ${errBody}`,
      },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<AppEnv>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<AppEnv>) {
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

export async function handleDeleteProxyKey(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<AppEnv>) {
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
export async function handleOAuthStatus(c: Context<AppEnv>) {
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
      // 只暴露是否有 Cookie，绝不返回 Cookie 片段（会话凭据）
      hasCookies: !!(token?.cookies),
      email: token?.email ?? null,
      projectId: token?.projectId ?? null,
    },
  })
}

/** 发起 OAuth 设备码授权流程，返回授权链接与用户码 */
export async function handleOAuthConnect(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  // CNB：cnb.cool 无公开模型列表端点（实测 /ai/models 等均返回 404 HTML），
  // 与 Gemini 一致使用内置静态清单，一键拉取后自动合并保存。
  if (isCnbProvider(provider)) {
    const models = CNB_MODELS.map((m) => ({ id: m }))
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
      console.warn(`[oauth-models] cnb auto-save failed: ${(e as Error).message}`)
    }
    return c.json<ApiResponse>({ success: true, data: { data: models } })
  }

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
export async function handleOAuthPoll(c: Context<AppEnv>) {
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
export async function handleOAuthDisconnect(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  await deleteOauthToken(c.env, id)
  return c.json<ApiResponse>({ success: true, message: '已断开 OAuth 连接' })
}

/**
 * 提交 Gemini 授权回调 URL：用户在浏览器完成 Google 授权后，把地址栏的
 * 回调 URL（含 ?code=...&state=...）粘贴回后台，此处校验 state 并换 token。
 * 对应 startOauthGeminiFlow 生成的授权链接。
 */
export async function handleOAuthGeminiCallback(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }
  if (provider.oauth.flowType !== 'gemini') {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是 Gemini 授权模式' }, 400)
  }

  const body = await c.req.json<{ callbackUrl?: string }>()
  const callbackUrl = String(body?.callbackUrl || '').trim()
  if (!callbackUrl) {
    return c.json<ApiResponse>({ success: false, message: 'callbackUrl 为必填项' }, 400)
  }

  const result = await submitOauthGeminiCallback(c.env, id, provider.oauth, callbackUrl)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 400)
  }
  return c.json<ApiResponse>({
    success: true,
    message: result.message,
    data: { email: result.email, projectId: result.projectId },
  })
}

/** Cline 一键授权：发起 WorkOS 设备码流程，返回授权链接与设备码（与原项目 cline_oauth.py 一致） */
export async function handleClineOAuthConnect(c: Context<AppEnv>) {
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
export async function handleClineOAuthPoll(c: Context<AppEnv>) {
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
export async function handleOAuthModels(c: Context<AppEnv>) {
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

  // Gemini：模型列表为静态清单（参考 geminicli/internal/models/models.go），
  // 无需请求上游；登录成功后一键拉取即可自动合并保存。
  if (isGeminiProvider(provider)) {
    const models = GEMINI_MODELS.map((m) => ({ id: m.id }))
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
      console.warn(`[oauth-models] gemini auto-save failed: ${(e as Error).message}`)
    }
    return c.json<ApiResponse>({ success: true, data: { data: models } })
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
    tokenHeaderPrefix: cfg.tokenHeaderPrefix || '（前缀值不打印）',
    hasCookies: !!cookies,
    modelsUrl: cfg.modelsUrl || `${provider.baseUrl.replace(/\/$/, '')}/models`,
    baseUrl: provider.baseUrl,
    // extraHeaders 可能含 Origin/Referer 之外的敏感值（如 client_secret），只记头名
    extraHeaderNames: cfg.extraHeaders ? Object.keys(cfg.extraHeaders) : undefined,
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
      // 只记请求头名与是否有 Cookie（值长度），绝不打印 token / cookie 值
      debug['requestHeaders'] = Object.keys(reqHeaders).reduce((acc, k) => {
        const v = reqHeaders[k] || ''
        const lk = k.toLowerCase()
        if (lk === 'cookie') acc[k] = `yes (${v.length} chars)`
        else if (lk === 'x-api-key' || lk === 'authorization') acc[k] = v.length > 0 ? '***' : ''
        else acc[k] = v
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
// 搜索模式下 KV.get 次数上限：KV.list(≤5 次) + 990 次 KV.get ≈ 995 subrequest，
// 留余量低于 Workers 单请求 1000 subrequest 上限。
const SEARCH_SCAN = 990

/**
 * 从日志 key 名解析写入时间戳（毫秒）。
 * key 格式 = 'log:' + Date.now().toString(36) + Math.random().toString(36).slice(2,8)
 * 去掉 'log:' 前缀和 6 位随机后缀，剩余即 base36 时间戳。解析失败返回 NaN。
 * 用于搜索时按日期预过滤 key 名，免去对不相关时间段日志的 KV.get。
 */
function tsFromLogKey(name: string): number {
  const ts36 = name.slice(LOG_PREFIX.length, name.length - 6)
  const ts = parseInt(ts36, 36)
  return Number.isFinite(ts) ? ts : NaN
}

/**
 * 日志内容脱敏：日志里绝不落盘密钥原文。
 * 覆盖：Bearer token、sk_cf_* 类转发 Key、API Key、x-api-key / Authorization 值、
 * Cookie（会话凭据）、token / refresh_token / secret 类的 JSON 值。
 */
function sanitizeLogText(text: string): string {
  if (!text) return text
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1***')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/gi, 'sk_***')
    .replace(/("?(?:x-api-key|authorization|api[-_]?key|refresh_token|access_token|client_secret|token)"?\s*[:=]\s*")[^"]{6,}(")/gi, '$1***$3')
    .replace(/(cookie[^=:=]*[:=]\s*"?)["',;][^"',;]{4,}["',;]/gi, '$1***')
    .replace(/(Set-Cookie[^,;]*=)[^,;]{4,}/gi, '$1***')
}

// ===== 日志 KV 写入 =====
// P4：log_enabled 开关做内存缓存（5s TTL），消除每请求 1 次 KV.get；开关切换时同步刷新。
let logEnabledCache = { at: 0, value: false }
const LOG_ENABLED_CACHE_TTL_MS = 5_000

async function isLogEnabled(env: Env): Promise<boolean> {
  if (Date.now() - logEnabledCache.at < LOG_ENABLED_CACHE_TTL_MS) return logEnabledCache.value
  const enabled = await env.KV.get('config:log_enabled')
  logEnabledCache = { at: Date.now(), value: enabled === 'true' }
  return logEnabledCache.value
}

/** 写日志到 KV */
export async function writeLog(env: Env, type: LogEntry['type'], message: string, details?: string) {
  // 检查是否启用日志
  if (!(await isLogEnabled(env))) return

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const entry: LogEntry = {
    id,
    time: new Date().toISOString(),
    type,
    message: sanitizeLogText(message),
    details: details ? sanitizeLogText(details).substring(0, 4000) : undefined,
  }
  await env.KV.put(LOG_PREFIX + id, JSON.stringify(entry), { expirationTtl: LOG_TTL })
}

/** 安全解析分页参数：非数字/缺失时回退默认值（R8：parseInt 遇 NaN 会污染 slice/limit） */
const toInt = (raw: string | null | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 获取日志列表（支持 limit / offset 分页 + type / keyword / 日期范围搜索）。
 * 无搜索条件时只读本页窗口的 key（P5：subrequest 最小化）；
 * 有搜索条件时先用 key 名时间戳做日期预过滤（免 KV.get），再对命中 key 读取过滤——
 * 日期搜索可覆盖全部日志，关键词搜索扫描上限 SEARCH_SCAN 控 subrequest 在 1000 内。
 */
export async function handleLogs(c: Context<AppEnv>) {
  const limit = Math.min(Math.max(toInt(c.req.query('limit'), 50), 1), 200)
  const type = c.req.query('type') || ''
  const offset = Math.max(toInt(c.req.query('offset'), 0), 0)
  // 搜索条件：关键词（小写匹配 message+details）、日期范围（按 entry.time 绝对时间戳比较）
  const keyword = (c.req.query('keyword') || '').trim().toLowerCase().slice(0, 100)
  const startRaw = c.req.query('start') || ''
  const endRaw = c.req.query('end') || ''
  const startTime = startRaw ? new Date(startRaw).getTime() : NaN
  const endTime = endRaw ? new Date(endRaw).getTime() : NaN
  const hasFilter = !!(type || keyword || !Number.isNaN(startTime) || !Number.isNaN(endTime))

  // P5：KV.list 只拉 key 名（便宜）。无论是否搜索都拉到 5000 上限——
  // 搜索时需用 key 名时间戳预过滤，拉全部 key 名才能覆盖完整日期范围。
  const TOTAL_CAP = 5000
  const names: string[] = []
  let cursor: string | undefined
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (const k of list.keys) names.push(k.name)
  } while (cursor && names.length < TOTAL_CAP)
  // key 名 = 'log:' + Date.now().toString(36) + 随机，字典序正序 = 旧→新；取最新在前
  names.reverse()
  const kvTotal = names.length

  // 无搜索：只读 offset..offset+limit 窗口的 key（原逻辑，type 过滤保持向后兼容）
  if (!hasFilter) {
    const logs: LogEntry[] = []
    const slice = names.slice(offset, offset + limit)
    for (let i = 0; i < slice.length; i += 25) {
      const raws = await Promise.all(slice.slice(i, i + 25).map((n) => c.env.KV.get(n)))
      for (const raw of raws) {
        if (!raw) continue
        try {
          const entry = JSON.parse(raw) as LogEntry
          if (!type || entry.type === type) logs.push(entry)
        } catch { /* skip corrupt entries */ }
      }
    }
    return c.json<ApiResponse>({ success: true, data: { logs: logs.slice(0, limit), total: kvTotal, offset } })
  }

  // 搜索：先用 key 名时间戳做日期预过滤（免 KV.get），大幅减少需读取的 key 数
  const startMs = Number.isNaN(startTime) ? -Infinity : startTime
  const endMs = Number.isNaN(endTime) ? Infinity : endTime
  const byDate = names.filter((n) => {
    const ts = tsFromLogKey(n)
    // 解析失败的 key 保留（保险，后续用 entry.time 兜底过滤）
    if (Number.isNaN(ts)) return true
    return ts >= startMs && ts <= endMs
  })
  // 控 subrequest：候选 key 上限 SEARCH_SCAN（list 已用 ≤5，990 get = 995，留余量）
  const scan = byDate.slice(0, SEARCH_SCAN)
  const matched: LogEntry[] = []
  for (let i = 0; i < scan.length; i += 25) {
    const raws = await Promise.all(scan.slice(i, i + 25).map((n) => c.env.KV.get(n)))
    for (const raw of raws) {
      if (!raw) continue
      try {
        const entry = JSON.parse(raw) as LogEntry
        if (type && entry.type !== type) continue
        // 日期已在 key 名预过滤，但解析失败的 key 仍需用 entry.time 兜底精确过滤
        if (!Number.isNaN(startTime) || !Number.isNaN(endTime)) {
          const ts = new Date(entry.time).getTime()
          if (!Number.isNaN(startTime) && ts < startTime) continue
          if (!Number.isNaN(endTime) && ts > endTime) continue
        }
        if (keyword) {
          const hay = ((entry.message || '') + '\n' + (entry.details || '')).toLowerCase()
          if (!hay.includes(keyword)) continue
        }
        matched.push(entry)
      } catch { /* skip corrupt entries */ }
    }
  }
  return c.json<ApiResponse>({
    success: true,
    data: {
      logs: matched.slice(offset, offset + limit),
      total: matched.length,
      offset,
      scanned: scan.length,
      kvTotal,
      truncated: byDate.length > scan.length,
    },
  })
}

/** 清除日志 */
export async function handleLogsClear(c: Context<AppEnv>) {
  // R8：KV.list 默认只返回一页（最多 1000 个 key），旧实现只删了第一页——
  // 改为按 cursor 循环删除直至全部删完，并设单次上限防止日志量过大时
  // subrequest 超限或无限循环。
  const DELETE_CAP = 20000
  let cursor: string | undefined
  let deleted = 0
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (let i = 0; i < list.keys.length; i += 50) {
      await Promise.all(list.keys.slice(i, i + 50).map((k) => c.env.KV.delete(k.name)))
    }
    deleted += list.keys.length
  } while (cursor && deleted < DELETE_CAP)
  return c.json<ApiResponse>({
    success: true,
    message: deleted >= DELETE_CAP ? `已清除 ${deleted} 条（达到单次上限，可再次执行）` : '日志已清除',
  })
}

/** 获取/设置日志开关状态 */
export async function handleLogConfig(c: Context<AppEnv>) {
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    const enabled = body.enabled ? 'true' : 'false'
    await c.env.KV.put('config:log_enabled', enabled)
    logEnabledCache = { at: Date.now(), value: enabled === 'true' }  // 立即刷新缓存
    return c.json<ApiResponse>({ success: true, data: { enabled: body.enabled } })
  }
  const enabled = await c.env.KV.get('config:log_enabled')
  return c.json<ApiResponse>({ success: true, data: { enabled: enabled === 'true' } })
}
