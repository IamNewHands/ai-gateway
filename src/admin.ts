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
  resolveProviderBaseUrl,
  getMcps,
  addMcp,
  updateMcp,
  deleteMcp,
  getUnimodels,
  addUnimodel,
  updateUnimodel,
  deleteUnimodel,
  getCacheEntries,
  deleteCacheEntry,
  clearCache,
  type CacheEntryView,
} from './storage'
import { testModelConnection } from './proxy'
import { isTraeProvider, testTraeModel } from './trae/proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { isQoderProvider, fetchQoderModels } from './qoder/proxy'
import { isClineProvider, fetchClineModels, syncClineModels, testClineChat, testClineRefreshToken, startClineOAuth, pollClineOAuth } from './cline/proxy'
import { isGeminiProvider, testGeminiModel, GEMINI_MODELS } from './gemini/proxy'
import { isCnbProvider, testCnbConnection, CNB_MODELS } from './cnb/proxy'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import { startOauthDeviceFlow, pollOauthDeviceFlow, readOauthToken, deleteOauthToken, getOauthAccessToken, buildOauthHeaders, detectTokenRealm, submitOauthGeminiCallback, submitOauthM365Callback, submitOauthM365ROPC, OAUTH_POOL_KV_PREFIX } from './oauth'
import { isOAuthPoolProvider, seedOauthPoolFromSingle, listOauthPoolStatus, removeOauthAccount } from './oauth-pool'
import { seedQoderPoolFromSingle, listQoderPoolStatus, removeQoderAccount } from './qoder/pool'
import { isM365Provider, M365_MODELS, testM365Model } from './m365/proxy'
import { listSessions as listM365Sessions, deleteSession as deleteM365Session } from './m365/session'
import { listConversations as listM365Conversations, whitelistConversation, unwhitelistConversation, getCleanupMode, setCleanupMode, getCleanupConfig, setCleanupConfig, deleteConversationRecord } from './m365/conversation-manager'
import { autoCleanupProvider } from './m365/auto-cleanup'
import { getM365AccountInfos, listM365Accounts, removeM365Account, m365PoolDiagnostic } from './m365/oauth'
import { clearAccountHealth, isAccountAvailable, accountCooldownSeconds } from './m365/account-health'
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
  McpServer,
  UniModel,
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
    ['globalDeviceCodeUrl', oauth.globalDeviceCodeUrl],
    ['globalDeviceTokenUrl', oauth.globalDeviceTokenUrl],
    ['globalRefreshTokenUrl', oauth.globalRefreshTokenUrl],
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
    cnbPool: body.cnbPool,
    cooldown: body.cooldown,
    allowUnlistedModels: body.allowUnlistedModels,
    thinkingInject: body.thinkingInject,
    cachePrefixInject: body.cachePrefixInject,
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
  if (body.cnbPool !== undefined) updates.cnbPool = body.cnbPool ?? undefined
  if (body.cooldown !== undefined) updates.cooldown = body.cooldown ?? undefined
  if (body.allowUnlistedModels !== undefined) updates.allowUnlistedModels = body.allowUnlistedModels
  if (body.thinkingInject !== undefined) updates.thinkingInject = body.thinkingInject ?? undefined
  if (body.cachePrefixInject !== undefined) updates.cachePrefixInject = body.cachePrefixInject ?? undefined
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
      toolBridge: body.toolBridge,
      cnbPool: body.cnbPool,
      cooldown: body.cooldown,
      thinkingInject: body.thinkingInject,
      cachePrefixInject: body.cachePrefixInject,
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
  if (body.toolBridge !== undefined) updates.toolBridge = body.toolBridge
  if (body.cnbPool !== undefined) updates.cnbPool = body.cnbPool
  if (body.cooldown !== undefined) updates.cooldown = body.cooldown
  if (body.thinkingInject !== undefined) updates.thinkingInject = body.thinkingInject
  if (body.cachePrefixInject !== undefined) updates.cachePrefixInject = body.cachePrefixInject
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

  // M365：走完整 ChatHub WS 链路发最小请求验证（网络代理配置异常时给出明确提示）
  if (isM365Provider(provider)) {
    const result = await testM365Model(c.env, provider, modelId)
    // 写系统日志，便于排查连通性失败根因（token 失效 / DO 会话 / ChatHub WS 异常等）
    if (!result.success) {
      try {
        await writeLog(c.env, 'error', `[m365-test-model] provider=${id} model=${modelId} → ${result.message}`)
      } catch { /* ignore */ }
    }
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

  // TRAE SOLO：账号池 + SOLO 协议测试（不能走通用 OpenAI /chat/completions——
  // 上游是 SOLO 私有协议，账号凭证在 provider.apiKeys，Bearer 直发必然失败）
  if (isTraeProvider(provider)) {
    const result = await testTraeModel(c.env, provider, modelId)
    return c.json<ApiResponse>({ success: true, data: result })
  }

  // CNB：免 Key（CSRF 凭证池），由凭证池 + 最小 chat 请求验证完整链路，不走通用 API Key
  if (isCnbProvider(provider)) {
    const result = await testCnbConnection(c.env, provider, modelId)
    return c.json<ApiResponse>({ success: true, data: result })
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
  if (!resolvedBase) {
    return c.json<ApiResponse>({ success: false, message: `提供商 "${provider.name}" 的 baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置` }, 400)
  }
  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(resolvedBase, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(resolvedBase, enabledKeys[0].key, modelId, provider.apiType)

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

  // Cloudflare Workers AI：OpenAI 兼容端点不支持 GET /models，
  // 改走原生模型搜索接口（同一 Bearer token），既能测试连通性也能拉取模型列表。
  if (providerId === 'cloudflare-ai') {
    const resolvedUrl = resolveProviderBaseUrl(c.env, url)
    if (!resolvedUrl) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置' }, 400)
    }
    // baseUrl: .../accounts/{ACCOUNT_ID}/ai/v1 → 原生搜索接口 .../ai/models/search
    const searchUrl = resolvedUrl.replace(/\/ai\/v1\/?$/, '/ai/models/search?per_page=100')
    try {
      const response = await fetch(searchUrl, {
        method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
      })
      let errBody = ''
      if (response.ok) {
        const body = (await response.json()) as { result?: Array<{ name?: string; id?: string }> }
        const models = (body.result || [])
          .map((m) => ({ id: m.name || m.id || '' }))
          .filter((m) => !!m.id)
        return c.json<ApiResponse>({
          success: true,
          data: { success: true, statusCode: 200, data: { data: models }, message: '' },
        })
      }
      try {
        const raw = await response.text()
        errBody = raw.substring(0, 1000)
        await writeLog(c.env, 'error', `[test-key] ${searchUrl} → ${response.status}`, errBody)
      } catch { /* ignore */ }
      return c.json<ApiResponse>({
        success: true,
        data: { success: false, statusCode: response.status, message: `HTTP ${response.status}: ${errBody}` },
      })
    } catch (err) {
      return c.json<ApiResponse>({
        success: true,
        data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
      })
    }
  }

  const resolvedUrl = resolveProviderBaseUrl(c.env, url)
  if (!resolvedUrl) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置' }, 400)
  }
  const cleanBase = resolvedUrl.replace(/\/$/, '')
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

  const resolvedUrl = resolveProviderBaseUrl(c.env, url)
  if (!resolvedUrl) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置' }, 400)
  }
  const cleanBase = resolvedUrl.replace(/\/$/, '')
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

// ===== MCP Server 管理（MCP 聚合网关） =====

/** 校验并归一化 httpHeaders：必须为普通对象，值统一转为字符串；非法返回 null */
function normalizeHttpHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = String(v)
  }
  return out
}

/** 校验 uni-model 候选模型列表：必须为数组、元素为非空字符串；非法的过滤并返回 */
function normalizeUnimodelModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
}

export async function handleGetMcps(c: Context<AppEnv>) {
  const mcps = await getMcps(c.env)
  return c.json<ApiResponse<McpServer[]>>({ success: true, data: mcps })
}

export async function handleCreateMcp(c: Context<AppEnv>) {
  const body = await c.req.json<Partial<McpServer>>()
  if (!body.name || !body.url) {
    return c.json<ApiResponse>({ success: false, message: 'name、url 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(body.url)) {
    return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
  }
  const httpHeaders = normalizeHttpHeaders(body.httpHeaders)
  if (!httpHeaders) {
    return c.json<ApiResponse>({ success: false, message: 'httpHeaders 必须是普通对象（如 {"Authorization":"Bearer xxx"}）' }, 400)
  }

  const mcps = await getMcps(c.env)
  if (mcps.some((m) => m.name === body.name)) {
    return c.json<ApiResponse>({ success: false, message: `MCP 名称 "${body.name}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const mcp: McpServer = {
    id: body.id || crypto.randomUUID(),
    name: body.name,
    url: body.url.replace(/\/$/, ''),
    httpHeaders,
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }
  await addMcp(c.env, mcp)
  return c.json<ApiResponse<McpServer>>({ success: true, data: mcp }, 201)
}

export async function handleUpdateMcp(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<Partial<McpServer>>()

  const updates: Partial<McpServer> = {}
  if (body.name !== undefined) {
    if (!body.name) return c.json<ApiResponse>({ success: false, message: 'name 不能为空' }, 400)
    const mcps = await getMcps(c.env)
    if (mcps.some((m) => m.name === body.name && m.id !== id)) {
      return c.json<ApiResponse>({ success: false, message: `MCP 名称 "${body.name}" 已存在` }, 409)
    }
    updates.name = body.name
  }
  if (body.url !== undefined) {
    if (!isSafeHttpUrl(body.url)) {
      return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
    }
    updates.url = body.url.replace(/\/$/, '')
  }
  if (body.httpHeaders !== undefined) {
    const httpHeaders = normalizeHttpHeaders(body.httpHeaders)
    if (!httpHeaders) return c.json<ApiResponse>({ success: false, message: 'httpHeaders 必须是普通对象' }, 400)
    updates.httpHeaders = httpHeaders
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled

  const updated = await updateMcp(c.env, id, updates)
  if (!updated) return c.json<ApiResponse>({ success: false, message: 'MCP 不存在' }, 404)
  return c.json<ApiResponse<McpServer>>({ success: true, data: updated })
}

export async function handleDeleteMcp(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteMcp(c.env, id)
  if (!deleted) return c.json<ApiResponse>({ success: false, message: 'MCP 不存在' }, 404)
  return c.json<ApiResponse>({ success: true })
}

// ===== 联合模型（uni-model）管理 =====

export async function handleGetUnimodels(c: Context<AppEnv>) {
  const unimodels = await getUnimodels(c.env)
  return c.json<ApiResponse<UniModel[]>>({ success: true, data: unimodels })
}

export async function handleCreateUnimodel(c: Context<AppEnv>) {
  const body = await c.req.json<Partial<UniModel>>()
  if (!body.name) {
    return c.json<ApiResponse>({ success: false, message: 'name 为必填项' }, 400)
  }
  const models = normalizeUnimodelModels(body.models)
  if (models.length === 0) {
    return c.json<ApiResponse>({ success: false, message: 'models 必须是非空数组（元素为 providerId/modelId）' }, 400)
  }

  const unimodels = await getUnimodels(c.env)
  if (unimodels.some((u) => u.name === body.name)) {
    return c.json<ApiResponse>({ success: false, message: `联合模型名称 "${body.name}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const unimodel: UniModel = {
    id: body.id || crypto.randomUUID(),
    name: body.name,
    models,
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }
  await addUnimodel(c.env, unimodel)
  return c.json<ApiResponse<UniModel>>({ success: true, data: unimodel }, 201)
}

export async function handleUpdateUnimodel(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<Partial<UniModel>>()

  const updates: Partial<UniModel> = {}
  if (body.name !== undefined) {
    if (!body.name) return c.json<ApiResponse>({ success: false, message: 'name 不能为空' }, 400)
    const unimodels = await getUnimodels(c.env)
    if (unimodels.some((u) => u.name === body.name && u.id !== id)) {
      return c.json<ApiResponse>({ success: false, message: `联合模型名称 "${body.name}" 已存在` }, 409)
    }
    updates.name = body.name
  }
  if (body.models !== undefined) {
    const models = normalizeUnimodelModels(body.models)
    if (models.length === 0) {
      return c.json<ApiResponse>({ success: false, message: 'models 必须是非空数组（元素为 providerId/modelId）' }, 400)
    }
    updates.models = models
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled

  const updated = await updateUnimodel(c.env, id, updates)
  if (!updated) return c.json<ApiResponse>({ success: false, message: '联合模型不存在' }, 404)
  return c.json<ApiResponse<UniModel>>({ success: true, data: updated })
}

export async function handleDeleteUnimodel(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteUnimodel(c.env, id)
  if (!deleted) return c.json<ApiResponse>({ success: false, message: '联合模型不存在' }, 404)
  return c.json<ApiResponse>({ success: true })
}

// ===== 内存缓存管理（P4）=====

export async function handleGetCache(c: Context<AppEnv>) {
  return c.json<ApiResponse<CacheEntryView[]>>({ success: true, data: getCacheEntries() })
}

export async function handleDeleteCache(c: Context<AppEnv>) {
  const key = c.req.param('key')
  if (!key) return c.json<ApiResponse>({ success: false, message: '缺少 key 参数' }, 400)
  const deleted = deleteCacheEntry(decodeURIComponent(key))
  if (!deleted) return c.json<ApiResponse>({ success: false, message: `缓存项 "${key}" 不存在` }, 404)
  return c.json<ApiResponse>({ success: true, message: `已清除缓存 "${key}"` })
}

export async function handleClearCache(c: Context<AppEnv>) {
  const { cleared, total } = clearCache()
  return c.json<ApiResponse>({ success: true, message: `已清空缓存（${cleared}/${total}）`, data: { cleared, total } })
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

  // 计算过期时间：自定义天数 > 自定义小时数 > 预设选项 > 永久
  let expiresAt: string | null = null
  let ttlSeconds = 0

  if (typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
    ttlSeconds = body.expiresInDays * 24 * 60 * 60
  } else if (typeof body.expiresInHours === 'number' && body.expiresInHours > 0) {
    ttlSeconds = body.expiresInHours * 60 * 60
  } else if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) ttlSeconds = ttl
  }

  if (ttlSeconds > 0) {
    expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
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
  const body = await c.req.json<{
    enabled?: boolean
    allowedModels?: string[]
    expiresIn?: string
    expiresInDays?: number
    expiresInHours?: number
  }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.allowedModels !== undefined) updates.allowedModels = body.allowedModels
  // 续期/修改过期时间：传了任一有效期字段时重算 expiresAt。
  // 语义为「从当前时间起重新计算新有效期」——已过期的 Key 也能直接续期恢复，
  // 无需删掉重加（新增会生成全新的 Key 字符串，客户端配置全要改）。
  // 优先级：自定义天数 > 自定义小时数 > 预设选项；'forever' 或全部无效 → 永久有效。
  if (body.expiresIn !== undefined || body.expiresInDays !== undefined || body.expiresInHours !== undefined) {
    let ttlSeconds = 0
    if (typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
      ttlSeconds = body.expiresInDays * 24 * 60 * 60
    } else if (typeof body.expiresInHours === 'number' && body.expiresInHours > 0) {
      ttlSeconds = body.expiresInHours * 60 * 60
    } else if (body.expiresIn && body.expiresIn !== 'forever') {
      const ttl = EXPIRY_OPTIONS[body.expiresIn]
      if (ttl) ttlSeconds = ttl
    }
    updates.expiresAt = ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null
  }
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== OAuth 设备码管理 =====

/** 查询某 OAuth 提供商的连接状态（token 是否存在/过期时间；池提供商额外返回账号池状态） */
export async function handleOAuthStatus(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device') {
    return c.json<ApiResponse>({ success: false, message: '该提供商未启用 OAuth 认证' }, 400)
  }

  const token = await readOauthToken(c.env, id)
  const data: Record<string, unknown> = {
    connected: !!token,
    expiresAt: token?.expires_at ?? null,
    updatedAt: token?.updated_at ?? null,
    // 只暴露是否有 Cookie，绝不返回 Cookie 片段（会话凭据）
    hasCookies: !!(token?.cookies),
    email: token?.email ?? null,
    projectId: token?.projectId ?? null,
    // M365：账号标识（来自 access_token JWT，非敏感凭据）
    oid: token?.oid ?? null,
    tid: token?.tid ?? null,
  }
  // M365：token 存于账号池（oauth:token:{id}:pool）。旧实现只取最久未用的首个账号，
  // 易误导（最久未用的账号往往已失效）。改为列出全部账号及其健康状态。
  if (isM365Provider(provider)) {
    const infos = await getM365AccountInfos(c.env, id)
    const accounts = []
    for (const info of infos) {
      const oid = info.oid || ''
      const available = info.connected ? (oid ? await isAccountAvailable(c.env, oid) : false) : false
      const cooldownSeconds = info.connected ? (oid ? await accountCooldownSeconds(c.env, oid) : 0) : 0
      accounts.push({
        connected: info.connected ?? false,
        email: info.email ?? null,
        oid: oid || null,
        tid: info.tid ?? null,
        tokenExpiresAt: info.expiresAt ?? null,
        available,
        cooldownSeconds,
        healthy: available && cooldownSeconds === 0,
      })
    }
    const first = infos[0] || null
    data.connected = first ? first.connected : false
    data.expiresAt = first?.expiresAt ?? null
    data.email = first?.email ?? null
    data.oid = first?.oid ?? null
    data.tid = first?.tid ?? null
    data.updatedAt = null
    data.hasCookies = false
    data.accountCount = infos.length
    data.accounts = accounts
  }
  // WorkBuddy 多账号池：返回池账号状态（脱敏）供面板展示
  if (isOAuthPoolProvider(provider)) {
    try { await seedOauthPoolFromSingle(c.env, id) } catch { /* ignore */ }
    data.pool = await listOauthPoolStatus(c.env, id)
  }
  // QoderWork 多账号池：返回池账号状态（脱敏）供面板展示
  if (provider.oauth?.flowType === 'qoder' || isQoderProvider(provider.id)) {
    try { await seedQoderPoolFromSingle(c.env, id) } catch { /* ignore */ }
    const qpool = await listQoderPoolStatus(c.env, id)
    data.pool = qpool
    data.connected = qpool.length > 0
    data.accountCount = qpool.length
  }
  return c.json<ApiResponse>({ success: true, data })
}

/** 删除 WorkBuddy / Qoder 池内指定 uid 账号。 */
export async function handleOAuthPoolRemove(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const isQoder = provider.oauth?.flowType === 'qoder' || isQoderProvider(provider.id)
  if (!isOAuthPoolProvider(provider) && !isQoder) {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是多账号池模式' }, 400)
  }
  const body = await c.req.json<{ uid?: string }>().catch(() => ({})) as { uid?: string }
  const uid = String(body?.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid 参数' }, 400)
  const removed = isQoder
    ? await removeQoderAccount(c.env, id, uid)
    : await removeOauthAccount(c.env, id, uid)
  if (!removed) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: '已从账号池删除 ' + uid })
}

/** 发起 OAuth 设备码授权流程，返回授权链接与用户码 */
export async function handleOAuthConnect(c: Context<AppEnv>) {
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

/** 断开 OAuth 连接，删除 KV 中的 token（池提供商一并清空账号池） */
export async function handleOAuthDisconnect(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  await deleteOauthToken(c.env, id)
  // WorkBuddy 多账号池：断开即清空池内全部账号
  const p = await getProvider(c.env, id).catch(() => null)
  if (p && isOAuthPoolProvider(p)) {
    await c.env.KV.delete(OAUTH_POOL_KV_PREFIX + id).catch(() => {})
  }
  // M365：一并清理该提供商的会话绑定（云端对话随账号断开失效）
  if (p && isM365Provider(p)) {
    await c.env.KV.delete(`m365:sessions:${id}`).catch(() => {})
  }
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

/**
 * 提交 M365 PKCE 授权回调：用户在浏览器完成微软授权后，把地址栏的回调 URL
 * （含 ?code=...&state=...）粘贴回后台，此处校验 state 并换 token。
 * 对应 startOauthDeviceFlow（flowType=m365-pkce）生成的授权链接。
 */
export async function handleOAuthM365Callback(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }
  if (provider.oauth.flowType !== 'm365-pkce') {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是 M365 PKCE 授权模式' }, 400)
  }

  const body = await c.req.json<{ callbackUrl?: string }>()
  const callbackUrl = String(body?.callbackUrl || '').trim()
  if (!callbackUrl) {
    return c.json<ApiResponse>({ success: false, message: 'callbackUrl 为必填项' }, 400)
  }

  const result = await submitOauthM365Callback(c.env, id, provider.oauth, callbackUrl)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 400)
  }
  return c.json<ApiResponse>({
    success: true,
    message: result.message,
    data: { email: result.email },
  })
}

/** M365 ROPC 登录：直接用企业订阅账号/密码换 token（flowType=m365-ropc） */
export async function handleOAuthM365ROPC(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }
  if (provider.oauth.flowType !== 'm365-ropc') {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是 M365 ROPC 授权模式' }, 400)
  }

  const body = await c.req.json<{ username?: string; password?: string }>()
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  if (!username || !password) {
    return c.json<ApiResponse>({ success: false, message: 'username 与 password 为必填项' }, 400)
  }

  const result = await submitOauthM365ROPC(c.env, id, provider.oauth, username, password)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 400)
  }
  return c.json<ApiResponse>({
    success: true,
    message: result.message,
    data: { email: result.email },
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
 * Cline 动态模型同步（item6）：从官方 recommended-models 拉最新模型并合并进 provider.models。
 * 返回新增/总数，供管理面板展示。
 */
export async function handleClineModelSync(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isClineProvider(provider.id)) {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是 Cline' }, 400)
  }
  const result = await syncClineModels(c.env, provider)
  return c.json<ApiResponse>({
    success: !result.error,
    data: result,
    message: result.error || (result.changed ? `同步完成，新增 ${result.added.length} 个模型` : '已是最新，无新增模型'),
  })
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

  // M365 Copilot：模型清单为静态（订阅账号无公开 models 端点），
  // 与 gemini 一致使用内置清单，登录成功后一键拉取自动合并保存。
  if (isM365Provider(provider)) {
    const models = M365_MODELS.map((m) => ({ id: m.id }))
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
      console.warn(`[oauth-models] m365 auto-save failed: ${(e as Error).message}`)
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
const DEFAULT_LOG_RETENTION_DAYS = 7 // 默认日志保留天数
// 搜索模式下 KV.get 次数上限（与 KV.list 页数合计 ≤950 subrequest，动态收紧，见 handleLogs）
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
let logEnabledCache = { at: 0, value: true }
const LOG_ENABLED_CACHE_TTL_MS = 5_000

/**
 * 日志开关判断（默认开启）：只有 KV 明确存 'false' 才关闭日志，
 * 'true'、缺失、空值或任何非 'false' 值均视为开启。
 * 修复"日志突然不记录"：原实现严格 === 'true'，一旦 KV 值异常/被覆盖
 * （如某次误写 '0'、'false 前导空格'、或 KV 为空）就会静默停止全部日志。
 */
async function isLogEnabled(env: Env): Promise<boolean> {
  if (Date.now() - logEnabledCache.at < LOG_ENABLED_CACHE_TTL_MS) return logEnabledCache.value
  const raw = await env.KV.get('config:log_enabled')
  const value = raw !== 'false' // 仅显式 'false' 视为关闭，其余均开启
  logEnabledCache = { at: Date.now(), value }
  return value
}

// 日志保留天数：KV config:log_retention_days 存储，5s 内存缓存，避免每请求 1 次 KV.get。
// 保留天数变化后最多 5 秒生效；超期日志由 KV expirationTtl 自动过期删除。
let logRetentionCache = { at: 0, days: DEFAULT_LOG_RETENTION_DAYS }

/** 读取日志保留天数（钳制到 1..365），带内存缓存 */
export async function getLogRetentionDays(env: Env): Promise<number> {
  if (Date.now() - logRetentionCache.at >= LOG_ENABLED_CACHE_TTL_MS) {
    const raw = await env.KV.get('config:log_retention_days')
    const n = Number(raw)
    logRetentionCache = {
      at: Date.now(),
      days: Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 365) : DEFAULT_LOG_RETENTION_DAYS,
    }
  }
  return logRetentionCache.days
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
  // 保留天数动态设置过期时间：超期日志由 KV 自动删除
  const days = await getLogRetentionDays(env)
  await env.KV.put(LOG_PREFIX + id, JSON.stringify(entry), { expirationTtl: days * 24 * 60 * 60 })
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

  // P5：KV.list 只拉 key 名（便宜）。
  // 注意：KV.list 按字典序升序返回（旧→新），新日志写在字典序末尾。
  // 旧实现按 MAX_KEY_SCAN=10 万条截断，一旦保留窗口内日志超过该数量，
  // 会漏掉字典序末尾的「最新日志」，导致系统日志停在旧窗口、看起来"突然不记录了"。
  // 因此必须遍历到 list_complete，保证最新日志一定能查到；
  // 只设 MAX_LIST_PAGES 防单请求 subrequest 超限（每页 1 次 KV.list）。
  const MAX_LIST_PAGES = 700 // 700 页 × 1000 = 70 万条，为后续 KV.get 留足 subrequest 余量
  const names: string[] = []
  let cursor: string | undefined
  let listPages = 0
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (const k of list.keys) names.push(k.name)
    listPages++
  } while (cursor && listPages < MAX_LIST_PAGES)
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
  // 控 subrequest：候选 key 上限 SEARCH_SCAN，并按已用 KV.list 页数动态收紧，
  // 保证 listPages + KV.get 总数不超 Workers 单请求 1000 subrequest 上限。
  const scan = byDate.slice(0, Math.min(SEARCH_SCAN, Math.max(0, 950 - listPages)))
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

/**
 * 清除日志。
 * - 带 expired=1：按保留天数清理——以当前时间为起点往前推，删除超过保留天数的日志。
 *   保留天数取 KV config:log_retention_days（与写日志时的过期策略一致），无需前端传日期。
 * - 不带参数：全量删除。
 * 均按 cursor 循环删除直至删完，设单次上限防止日志量过大时 subrequest 超限。
 */
export async function handleLogsClear(c: Context<AppEnv>) {
  const DELETE_CAP = 20000
  const expiredOnly = c.req.query('expired') === '1'
  let deleted = 0
  let skipped = 0
  if (expiredOnly) {
    const days = await getLogRetentionDays(c.env)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    let cursor: string | undefined
    do {
      const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
      cursor = list.list_complete ? undefined : list.cursor
      const targets = list.keys.filter((k) => {
        const ts = tsFromLogKey(k.name)
        return Number.isNaN(ts) ? false : ts < cutoff
      })
      for (let i = 0; i < targets.length; i += 50) {
        await Promise.all(targets.slice(i, i + 50).map((k) => c.env.KV.delete(k.name)))
      }
      deleted += targets.length
      skipped += list.keys.length - targets.length
    } while (cursor)
    return c.json<ApiResponse>({
      success: true,
      message: `已删除 ${deleted} 条超过保留天数（${days} 天）的日志${skipped ? `，保留范围内 ${skipped} 条` : ''}`,
    })
  }
  let cursor: string | undefined
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

/** 获取/设置日志开关状态 + 保留天数 */
export async function handleLogConfig(c: Context<AppEnv>) {
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    // enabled 字段可选：未传时保持现有值（兼容只改保留天数的调用）
    if (body.enabled !== undefined) {
      const enabled = body.enabled ? 'true' : 'false'
      await c.env.KV.put('config:log_enabled', enabled)
      logEnabledCache = { at: Date.now(), value: enabled === 'true' }  // 立即刷新缓存
    }
    // 保留天数：1..365，非法值忽略
    if (body.retentionDays !== undefined) {
      const n = Number(body.retentionDays)
      if (Number.isFinite(n) && n > 0) {
        const days = Math.min(Math.trunc(n), 365)
        await c.env.KV.put('config:log_retention_days', String(days))
        logRetentionCache = { at: Date.now(), days }  // 立即刷新缓存
      }
    }
    const enabled = await c.env.KV.get('config:log_enabled')
    const retention = await getLogRetentionDays(c.env)
    return c.json<ApiResponse>({ success: true, data: { enabled: enabled !== 'false', retentionDays: retention } })
  }
  const enabled = await c.env.KV.get('config:log_enabled')
  const retention = await getLogRetentionDays(c.env)
  return c.json<ApiResponse>({ success: true, data: { enabled: enabled !== 'false', retentionDays: retention } })
}

// ===== M365 SSE 调试日志开关（界面可配置，存储 KV，5s 内存缓存） =====
// KV config:m365_debug_sse：'true'/'false'。未设置时回退环境变量 M365_DEBUG_SSE。
let m365DebugCache = { at: 0, value: false }
const M365_DEBUG_CACHE_TTL_MS = 5_000

/** 读取 M365 SSE 调试日志开关（durable 侧亦复用，避免每 delta 一次 KV.get） */
export async function isM365DebugSseEnabled(env: Env): Promise<boolean> {
  if (Date.now() - m365DebugCache.at < M365_DEBUG_CACHE_TTL_MS) return m365DebugCache.value
  const raw = await env.KV.get('config:m365_debug_sse').catch(() => null)
  const value = raw === 'true' || (raw === null && env.M365_DEBUG_SSE === 'true')
  m365DebugCache = { at: Date.now(), value }
  return value
}

/** GET/POST /admin/api/m365/debug-sse —— 获取/设置 M365 SSE 调试日志开关 */
export async function handleM365DebugConfig(c: Context<AppEnv>) {
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    const enabled = !!body.enabled
    await c.env.KV.put('config:m365_debug_sse', enabled ? 'true' : 'false')
    m365DebugCache = { at: Date.now(), value: enabled }  // 立即刷新缓存
    return c.json<ApiResponse>({ success: true, data: { enabled } })
  }
  const enabled = await isM365DebugSseEnabled(c.env)
  return c.json<ApiResponse>({ success: true, data: { enabled } })
}

// ============================================================
//  M365 会话绑定管理  /v1/sessions
//  （对标原版会话管理：查询 / 按 session_id 查询 / 解除绑定）
// ============================================================

/** 校验 provider_id 是否为已存在的 M365 提供商；合法则返回它，否则返回 null */
async function resolveM365ProviderIdByStr(c: Context<AppEnv>, providerId: string): Promise<string | null> {
  if (!providerId) return null
  const p = await getProvider(c.env, providerId).catch(() => null)
  if (!p) return null
  if (p.authType !== 'oauth-device' || !isM365Provider(p)) return null
  return providerId
}

/**
 * GET /v1/sessions?provider_id=xxx      —— 列出该 provider 的会话绑定
 * POST /v1/sessions {provider_id, session_id} —— 按 session_id 查询指定绑定
 */
export async function handleM365Sessions(c: Context<AppEnv>) {
  // provider_id：query 优先，POST 也支持 body 传入
  let providerId = c.req.query('provider_id') || ''
  if (!providerId && c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body['provider_id'] === 'string') providerId = body['provider_id']
  }
  const resolved = await resolveM365ProviderIdByStr(c, providerId)
  if (!resolved) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const providerIdResolved = resolved
  try {
    // 租户隔离（#57）：只返回调用方 API Key 自己的会话绑定
    const tenant = c.get('proxyKeyHash') || ''
    const sessions = await listM365Sessions(c.env, providerIdResolved, tenant)
    if (c.req.method === 'POST') {
      const body = await c.req.json().catch(() => ({}))
      const sid = typeof body['session_id'] === 'string' ? body['session_id'] : ''
      if (sid) {
        const hit = sessions.find((s) => s.sessionId === sid)
        if (!hit) {
          return c.json({ error: { message: 'session not found', type: 'not_found' } }, 404)
        }
        return c.json({
          object: 'session',
          session_id: hit.sessionId,
          conversation_id: hit.conversationId,
          account_id: hit.accountId,
          matched_by: 'explicit',
          created_at: hit.createdAt,
          last_used_at: hit.lastUsedAt,
        })
      }
    }
    // GET：返回脱敏的会话绑定列表
    return c.json({
      object: 'list',
      data: sessions.map((s) => ({
        session_id: s.sessionId,
        conversation_id: s.conversationId,
        account_id: s.accountId,
        created_at: s.createdAt,
        last_used_at: s.lastUsedAt,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try { await writeLog(c.env, 'error', `[m365-sessions] provider=${providerIdResolved} list failed`, msg) } catch { /* ignore */ }
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** DELETE /v1/sessions/:id?provider_id=xxx —— 解除会话绑定 */
export async function handleM365SessionDelete(c: Context<AppEnv>) {
  const providerId = await resolveM365ProviderIdByStr(c, c.req.query('provider_id') || '')
  if (!providerId) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { message: '缺少 session id 参数', type: 'invalid_request_error' } }, 400)
  }
  try {
    // 租户隔离（#57）：仅当该 sessionId 属于调用方 API Key 时才解除，防止跨 Key 删除他人会话
    const tenant = c.get('proxyKeyHash') || ''
    const ok = await deleteM365Session(c.env, providerId, id, tenant)
    if (!ok) {
      return c.json({ error: { message: 'session not found', type: 'not_found' } }, 404)
    }
    return c.json({ success: true, deleted: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try { await writeLog(c.env, 'error', `[m365-sessions] provider=${providerId} delete failed`, msg) } catch { /* ignore */ }
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

// ============================================================
//  M365 对话管理  /admin/api/m365/conversations
//  （对标原版对话管理器：列表/白名单/清理配置/手动清理）
// ============================================================

/** GET /admin/api/m365/conversations?provider_id=xxx —— 列出该 provider 的对话记录 */
export async function handleM365Conversations(c: Context<AppEnv>) {
  const providerId = c.req.query('provider_id') || ''
  const resolved = await resolveM365ProviderIdByStr(c, providerId)
  if (!resolved) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  try {
    const conversations = await listM365Conversations(c.env, resolved)
    const mode = await getCleanupMode(c.env, resolved)
    const config = await getCleanupConfig(c.env, resolved)
    return c.json({
      success: true,
      data: conversations.map((c) => ({
        id: c.id,
        account_id: c.accountId,
        created_at: c.createdAt,
        last_used_at: c.lastUsedAt,
        title: c.title || '',
      })),
      config: { mode, keep_n: config.keepN, max_age_hours: config.maxAgeHours },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** POST /admin/api/m365/conversations/whitelist —— 白名单管理 {provider_id, conversation_id, action} */
export async function handleM365ConversationWhitelist(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => ({}))
  const providerId = typeof body['provider_id'] === 'string' ? body['provider_id'] : ''
  const resolved = await resolveM365ProviderIdByStr(c, providerId)
  if (!resolved) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const convId = typeof body['conversation_id'] === 'string' ? body['conversation_id'] : ''
  if (!convId) {
    return c.json({ error: { message: '缺少 conversation_id', type: 'invalid_request_error' } }, 400)
  }
  const action = body['action'] === 'remove' ? 'remove' : 'add'
  try {
    if (action === 'add') {
      await whitelistConversation(c.env, resolved, convId)
    } else {
      await unwhitelistConversation(c.env, resolved, convId)
    }
    return c.json({ success: true, action, conversation_id: convId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** GET|POST /admin/api/m365/conversations/config?provider_id=xxx —— 获取/设置清理配置 */
export async function handleM365ConversationConfig(c: Context<AppEnv>) {
  const providerId = c.req.query('provider_id') || ''
  const resolved = await resolveM365ProviderIdByStr(c, providerId)
  if (!resolved) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({}))
    const mode = body['mode']
    if (mode && (mode === 'after_response' || mode === 'keep_n' || mode === 'max_age' || mode === 'on_exit')) {
      await setCleanupMode(c.env, resolved, mode)
    }
    const keepN = typeof body['keep_n'] === 'number' ? body['keep_n'] : undefined
    const maxAgeHours = typeof body['max_age_hours'] === 'number' ? body['max_age_hours'] : undefined
    if (keepN !== undefined || maxAgeHours !== undefined) {
      const cfg = await getCleanupConfig(c.env, resolved)
      await setCleanupConfig(c.env, resolved, keepN ?? cfg.keepN, maxAgeHours ?? cfg.maxAgeHours)
    }
  }
  const mode = await getCleanupMode(c.env, resolved)
  const config = await getCleanupConfig(c.env, resolved)
  return c.json({ success: true, mode, keep_n: config.keepN, max_age_hours: config.maxAgeHours })
}

/** POST /admin/api/m365/conversations/cleanup?provider_id=xxx —— 手动触发清理 */
export async function handleM365ConversationCleanup(c: Context<AppEnv>) {
  const providerId = c.req.query('provider_id') || ''
  const resolved = await resolveM365ProviderIdByStr(c, providerId)
  if (!resolved) {
    return c.json({ error: { message: '缺少有效的 M365 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  try {
    const provider = await getProvider(c.env, resolved)
    if (!provider) {
      return c.json({ error: { message: 'provider not found', type: 'not_found' } }, 404)
    }
    const deleted = await autoCleanupProvider(c.env, provider as Provider)
    return c.json({ success: true, deleted })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** M365 Token 健康状态查询 */
export async function handleM365TokenHealth(c: Context<AppEnv>) {
  const providerId = c.req.param('id')
  if (!providerId) {
    return c.json({ error: { message: '缺少 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const provider = await getProvider(c.env, providerId).catch(() => null)
  if (!provider) {
    return c.json({ error: { message: '提供商不存在', type: 'not_found' } }, 404)
  }
  if (!isM365Provider(provider)) {
    return c.json({ error: { message: '该提供商不是 M365 类型', type: 'invalid_request_error' } }, 400)
  }
  try {
    const infos = await getM365AccountInfos(c.env, providerId)
    const accounts = []
    for (const info of infos) {
      const oid = info.oid || ''
      const available = info.connected ? (oid ? await isAccountAvailable(c.env, oid) : false) : false
      const cooldownSeconds = info.connected ? (oid ? await accountCooldownSeconds(c.env, oid) : 0) : 0
      accounts.push({
        connected: info.connected ?? false,
        email: info.email ?? null,
        oid: oid || null,
        tid: info.tid ?? null,
        tokenExpiresAt: info.expiresAt ?? null,
        available,
        cooldownSeconds,
        healthy: available && cooldownSeconds === 0,
      })
    }
    return c.json({
      success: true,
      data: {
        provider: providerId,
        accountCount: accounts.length,
        accounts,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** 手动清除 M365 账号冷却状态（可按 ?oid= 指定账号，缺省清除该 provider 下全部账号） */
export async function handleM365ClearCooldown(c: Context<AppEnv>) {
  const providerId = c.req.param('id')
  if (!providerId) {
    return c.json({ error: { message: '缺少 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const provider = await getProvider(c.env, providerId).catch(() => null)
  if (!provider) {
    return c.json({ error: { message: '提供商不存在', type: 'not_found' } }, 404)
  }
  if (!isM365Provider(provider)) {
    return c.json({ error: { message: '该提供商不是 M365 类型', type: 'invalid_request_error' } }, 400)
  }
  try {
    const oid = c.req.query('oid') || ''
    if (oid) {
      await clearAccountHealth(c.env, oid)
    } else {
      const infos = await getM365AccountInfos(c.env, providerId)
      for (const info of infos) {
        if (info.oid) await clearAccountHealth(c.env, info.oid)
      }
      // 旧版以 providerId 为键的健康也一并清理
      await clearAccountHealth(c.env, providerId)
    }
    return c.json({ success: true, message: oid ? '冷却状态已清除' : '全部账号冷却状态已清除' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** M365 账号池管理：GET 列出；DELETE 移除指定账号(?oid=) */
export async function handleM365Accounts(c: Context<AppEnv>) {
  const providerId = c.req.param('id')
  if (!providerId) {
    return c.json({ error: { message: '缺少 provider_id 参数', type: 'invalid_request_error' } }, 400)
  }
  const provider = await getProvider(c.env, providerId).catch(() => null)
  if (!provider) {
    return c.json({ error: { message: '提供商不存在', type: 'not_found' } }, 404)
  }
  if (!isM365Provider(provider)) {
    return c.json({ error: { message: '该提供商不是 M365 类型', type: 'invalid_request_error' } }, 400)
  }
  try {
    if (c.req.method === 'DELETE') {
      const oid = c.req.query('oid') || ''
      if (!oid) {
        return c.json({ error: { message: '缺少 oid 参数', type: 'invalid_request_error' } }, 400)
      }
      const removed = await removeM365Account(c.env, providerId, oid)
      // 联动清除该账号健康与相关会话
      await clearAccountHealth(c.env, oid).catch(() => {})
      return c.json({ success: removed, message: removed ? '账号已移除' : '未找到该账号' }, removed ? 200 : 404)
    }
    const infos = await getM365AccountInfos(c.env, providerId)
    const accounts = []
    for (const info of infos) {
      const oid = info.oid || ''
      accounts.push({
        connected: info.connected ?? false,
        email: info.email ?? null,
        oid: oid || null,
        tid: info.tid ?? null,
        tokenExpiresAt: info.expiresAt ?? null,
        healthy: oid ? await isAccountAvailable(c.env, oid) : false,
      })
    }
    return c.json({ success: true, data: { provider: providerId, accounts } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** M365 账号池底层存储诊断（只读）——排查"面板显示空"：池/旧单 token key 是否存在、账号数、oid 是否缺失、TTL 是否可能过期 */
export async function handleM365Diag(c: Context<AppEnv>) {
  try {
    const providers = (await getProviders(c.env)) as Provider[]
    const m365 = providers.filter((p) => isM365Provider(p))
    const results: Array<Awaited<ReturnType<typeof m365PoolDiagnostic>>> = []
    for (const p of m365) {
      results.push(await m365PoolDiagnostic(c.env, p.id))
    }
    return c.json({
      success: true,
      data: {
        totalM365Providers: m365.length,
        note: 'pool key 与 single key 均不存在 → 该 provider 账号存储缺失（30 天 KV TTL 过期或从未写入）。若 singleKeyExists=true 而 poolKeyExists=false，会在下次读取时自动迁移。',
        providers: results,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { message: msg, type: 'internal_error' } }, 500)
  }
}

/** 读取当前生效的思维引导提示词（含是否自定义标记） */
export async function handleGetThinkingPrompt(c: Context<AppEnv>) {
  const { getThinkingPrompt, isThinkingPromptCustom, DEFAULT_THINKING_PROMPT } = await import('./thinking')
  const [prompt, isCustom] = await Promise.all([getThinkingPrompt(c.env), isThinkingPromptCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { prompt, isCustom, defaultPrompt: DEFAULT_THINKING_PROMPT } })
}

/** 保存（或清空）思维引导提示词。body.prompt 为空 → 清空回退默认。 */
export async function handleSetThinkingPrompt(c: Context<AppEnv>) {
  const { setThinkingPrompt } = await import('./thinking')
  const body = await c.req.json<{ prompt?: string }>()
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  await setThinkingPrompt(c.env, prompt)
  return c.json<ApiResponse>({ success: true, message: '已保存' })
}

// ===== 缓存前缀设置（KV 存储，管理后台可编辑）=====

/** 读取当前生效的缓存前缀（含是否自定义标记） */
export async function handleGetCachePrefix(c: Context<AppEnv>) {
  const { getCachePrefix, isCachePrefixCustom, DEFAULT_CACHE_PREFIX } = await import('./cache-prefix')
  const [prefix, isCustom] = await Promise.all([getCachePrefix(c.env), isCachePrefixCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { prefix, isCustom, defaultPrefix: DEFAULT_CACHE_PREFIX } })
}

/** 保存（或清空）缓存前缀。body.prefix 为空 → 清空回退默认。 */
export async function handleSetCachePrefix(c: Context<AppEnv>) {
  const { setCachePrefix } = await import('./cache-prefix')
  const body = await c.req.json<{ prefix?: string }>()
  const prefix = typeof body?.prefix === 'string' ? body.prefix : ''
  await setCachePrefix(c.env, prefix)
  return c.json<ApiResponse>({ success: true, message: '已保存' })
}

// ===== 性能设置（超时分级，KV 存储，管理后台可编辑）=====

/** 读取当前性能设置（含是否自定义与内置默认值） */
export async function handleGetPerfSettings(c: Context<AppEnv>) {
  const { getPerfSettings, isPerfSettingsCustom, DEFAULT_PERF_SETTINGS } = await import('./perf')
  const [settings, isCustom] = await Promise.all([getPerfSettings(c.env), isPerfSettingsCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { settings, isCustom, defaults: DEFAULT_PERF_SETTINGS } })
}

/** 保存性能设置（部分字段合并，空对象 → 清空回退默认） */
export async function handleSetPerfSettings(c: Context<AppEnv>) {
  const { setPerfSettings } = await import('./perf')
  const body = await c.req.json<{ settings?: Partial<import('./perf').PerfSettings> }>()
  const settings = body?.settings ?? {}
  await setPerfSettings(c.env, settings)
  return c.json<ApiResponse>({ success: true, message: '已保存（最多 10s 生效）' })
}
