import { Context } from 'hono'
import { getProvider, getProviders } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { getOauthAccessToken, readOauthToken, refreshOauthToken, detectTokenRealm, buildOauthHeaders } from './oauth'

// ===== Key 健康状态类型和辅助函数 =====

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number  // 首次达到降权阈值的时间戳 (Date.now())
}
type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0) filtered[k] = v
  }
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    // 全部健康，删除 KV 条目
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
  }
}

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/**
 * 透传上游响应，保留 Content-Type（含 SSE text/event-stream）等关键头。
 * 修复 SSE 流式响应被截断/解码失败的问题：
 * - 不硬编码 application/json 作为 fallback（SSE 流的 Content-Type 是 text/event-stream）
 * - 添加 X-Accel-Buffering: no 防止中间代理缓冲 SSE 流
 * - 保留上游的 Transfer-Encoding 相关行为（Workers 自动处理 chunked）
 */
function passthroughResponse(response: Response): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  }
  const ct = response.headers.get('Content-Type')
  if (ct) headers['Content-Type'] = ct
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (response.ok) {
      return { success: true, message: '连接成功', statusCode: response.status }
    }

    let errorBody = ''
    try {
      const errorData = await response.json() as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = await response.text()
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
    }
  }
}

/** 处理 /v1/chat/completions 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model

    if (!model) {
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        error: {
          message: `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`,
          type: 'invalid_request_error',
        },
      }, 400)
    }

    const { providerId, modelId } = parsed

    // 转发 Key 模型权限检查
    const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
    if (proxyKey?.allowedModels && proxyKey.allowedModels.length > 0) {
      if (!proxyKey.allowedModels.includes(model)) {
        return c.json({
          error: { message: `模型 "${model}" 不在当前 Key 的允许列表中`, type: 'permission_error' },
        }, 403)
      }
    }

    const provider = await getProvider(c.env, providerId)

    if (!provider) {
      return c.json({
        error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error' },
      }, 404)
    }

    if (!provider.enabled) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled' },
      }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return c.json({
        error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' },
      }, 404)
    }
    if (!modelConfig.enabled) {
      return c.json({
        error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
      }, 403)
    }

    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    const forwardBody = { ...body, model: modelId }
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method: c.req.method,
        subPath,
        search: url.search,
        body: JSON.stringify(forwardBody),
        mirrorUrls: resolveOpenCodeUrls(c.env),
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    // OAuth 设备码提供商：使用 KV 中保存的 access_token 转发，401 时尝试刷新后重试
    if (provider.authType === 'oauth-device' && provider.oauth) {
      return await proxyOAuthRequest(c, provider, subPath, url.search, forwardBody)
    }

    if (enabledKeys.length === 0) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error' },
      }, 500)
    }

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/${subPath}${url.search}`

    // 按健康状态排序 key：健康→洗牌，不健康→末尾，冷却到期→试用，连续失败3次→降权排除
    const healthData = await readHealth(c.env, providerId)
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []

    if (enabledKeys.length === 1) {
      // 只有一个 key，跳过健康检查，直接使用
      healthy.push(0)
    } else {
      for (let i = 0; i < enabledKeys.length; i++) {
        const h = healthData[enabledKeys[i].key]
        if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
          // 兼容旧数据：无 demotedAt 视为现在刚降权，统一走冷却逻辑
          if (!h.demotedAt) {
            h.demotedAt = Date.now()
          }
          if (Date.now() - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
            probation.push(i)  // 冷却到期，进入试用组
          } else {
            demoted.push(i)    // 仍在冷却，继续保持降权
          }
        } else if (h && h.lastFailed) {
          unhealthy.push(i)
        } else {
          healthy.push(i)
        }
      }
    }

    // Fisher-Yates 洗牌（仅健康 key）
    for (let i = healthy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
    }

    const keyOrder = [...healthy, ...unhealthy, ...probation]

    // 所有 key 都在冷却中时，降级尝试 demoted key（修复旧数据缺失 demotedAt 的死循环）
    if (keyOrder.length === 0 && demoted.length > 0) {
      keyOrder.push(...demoted)
      console.log(`[proxy] ${providerId}: all keys demoted, falling back to ${demoted.length} key(s)`)
    }

    if (demoted.length > 0 || probation.length > 0) {
      console.log(`[proxy] ${providerId}: ${demoted.length} key(s) demoted, ${probation.length} key(s) on probation (cooldown expired)`)
    }

    let lastError: Response | null = null
    let healthUpdated = false

    for (const keyIndex of keyOrder) {
      const apiKey = enabledKeys[keyIndex].key
      try {
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (provider.apiType === 'anthropic') {
          forwardHeaders['x-api-key'] = apiKey
          forwardHeaders['anthropic-version'] = '2023-06-01'
        } else {
          forwardHeaders['Authorization'] = `Bearer ${apiKey}`
        }

        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(300000),
        })

        if (response.ok) {
          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          return passthroughResponse(response)
        }

        // 429 限流：跳过当前 key，不标记失败
        if (response.status === 429) {
          lastError = response
          continue
        }

        // 401/403/5xx 尝试下一个 key（标记失败）
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
          }
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          continue
        }

        // 其他错误（400/404 等）直接返回
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        // 网络错误也标记为失败
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
        }
        healthData[apiKey] = h
        healthUpdated = true
        lastError = new Response(JSON.stringify({
          error: { message: error.message || '请求失败', type: 'proxy_error' },
        }), { status: 502 })
        continue
      }
    }

    // 写回健康状态
    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    // 所有 key 均失败
    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      return c.json({
        error: {
          message: `所有 API Key 已用完，最后一次错误: HTTP ${lastError.status}`,
          type: 'key_exhausted',
          detail: errorBody.substring(0, 500),
        },
      }, (lastError.status || 502) as Parameters<typeof c.json>[1])
    }

    return c.json({
      error: { message: '没有可用的 API Key', type: 'configuration_error' },
    }, 500)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/**
 * OAuth 设备码提供商转发：取 token → 注入请求头 → 转发；401 时刷新 token 重试，
 * 刷新后仍 401 则自动切换域重试（Global ↔ CN）。
 * 参考 cpa-plugin/models.go 的域路由逻辑。
 */
async function proxyOAuthRequest(
  c: Context<{ Bindings: Env }>,
  provider: import('./types').Provider,
  subPath: string,
  search: string,
  forwardBody: object
): Promise<Response> {
  const cfg = provider.oauth!

  // 域路由：根据 token 的 JWT iss 决定走 CN (copilot.tencent.com) 还是 Global (www.workbuddy.ai)。
  const resolveRealm = (token: string): 'cn' | 'global' => {
    return detectTokenRealm(token) === 'global' ? 'global' : 'cn'
  }
  const buildForwardUrl = (realm: 'cn' | 'global') => {
    const realmBase = (realm === 'global' && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
    return `${realmBase}/${subPath}${search}`
  }
  const buildOrigin = (realm: 'cn' | 'global') => {
    return realm === 'global' && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
  }
  // 备用域（401 自动切换用）
  const altRealm = (realm: 'cn' | 'global'): 'cn' | 'global' | null => {
    if (realm === 'cn' && cfg.globalBaseUrl) return 'global'
    if (realm === 'global') return 'cn'
    return null
  }

  const doFetch = (token: string, realm?: 'cn' | 'global') => {
    const r = realm || resolveRealm(token)
    return fetch(buildForwardUrl(r), {
      method: c.req.method,
      headers: buildOauthHeaders(cfg, token, { origin: buildOrigin(r), apiType: provider.apiType }),
      body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(300000),
    })
  }

  try {
    let token = await getOauthAccessToken(c.env, provider.id, cfg)
    if (!token) {
      // 尝试用 refresh_token 刷新一次
      const refreshed = await refreshOauthToken(c.env, provider.id, cfg)
      if (refreshed) token = (await readOauthToken(c.env, provider.id))?.access_token ?? null
    }
    if (!token) {
      return c.json({
        error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' },
      }, 502)
    }

    const primaryRealm = resolveRealm(token)
    let response = await doFetch(token)

    // 401/403：可能 token 过期，刷新后重试一次
    if ((response.status === 401 || response.status === 403) && (await readOauthToken(c.env, provider.id))?.refresh_token) {
      const refreshed = await refreshOauthToken(c.env, provider.id, cfg)
      if (refreshed) {
        const fresh = (await readOauthToken(c.env, provider.id))?.access_token
        if (fresh) response = await doFetch(fresh)
      }
    }

    // 刷新后仍 401：自动切换域重试（Global ↔ CN）
    if (response.status === 401) {
      const alt = altRealm(primaryRealm)
      if (alt) {
        console.log(`[proxy-oauth] ${primaryRealm} 域 401，自动切换到 ${alt} 域重试`)
        const altResponse = await doFetch(token, alt)
        if (altResponse.ok || altResponse.status !== 401) {
          return passthroughResponse(altResponse)
        }
      }
    }

    return passthroughResponse(response)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: `OAuth 转发失败: ${error.message || '未知错误'}`, type: 'proxy_error' },
    }, 502)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀） */
export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  // 从中间件获取转发 Key（可能带有 allowedModels 过滤）
  const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
  const allowed = proxyKey?.allowedModels
  const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : null

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      const fullId = `${provider.id}/${model.id}`
      // 如果转发 Key 配置了 allowedModels，只返回允许的模型
      if (allowSet && !allowSet.has(fullId)) continue
      models.push({
        id: fullId,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}
