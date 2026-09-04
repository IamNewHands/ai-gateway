/**
 * proxy.ts — ZCode / Z.ai Coding Plan 上游转发。
 *
 * ZCode 是智谱 AI（Z.ai/BigModel）的桌面编码代理，通过 GLM Coding Plan
 * 订阅提供 GLM 系列模型的 API 访问。本模块处理：
 *   1. ZCode 身份头注入（User-Agent / X-Title / HTTP-Referer）
 *   2. 静态模型列表
 *   3. 测试连接
 *
 * 上游端点：
 *   BigModel（CN）：
 *     - Coding Plan OpenAI:  https://open.bigmodel.cn/api/coding/paas/v4
 *     - 通用 OpenAI:         https://open.bigmodel.cn/api/paas/v4
 *     - Anthropic:           https://open.bigmodel.cn/api/anthropic
 *   Z.AI（Global）：
 *     - Coding Plan OpenAI:  https://api.z.ai/api/coding/paas/v4
 *     - 通用 OpenAI:         https://api.z.ai/api/paas/v4
 *     - Anthropic:           https://api.z.ai/api/anthropic
 *
 * 认证方式：标准 API Key（Bearer Token）
 *   - BigModel:  `{apiKey}`
 *   - Z.AI:      `{apiKey}.{secretKey}`（复合 key）
 */

import type { Env, Provider } from '../types'

export const ZCODE_PROVIDER_ID = 'zcode'
export const ZCODE_APP_VERSION = '3.2.2'

/** 身份头注入（使上游识别为 ZCode 客户端，部分模型可能仅对 ZCode 开放）。 */
export function buildZcodeHeaders(): Record<string, string> {
  return {
    'User-Agent': `ZCode/${ZCODE_APP_VERSION}`,
    'X-Title': 'Z Code',
    'HTTP-Referer': 'https://zcode.z.ai',
    'X-ZCode-Proxy': 'ai-gateway',
  }
}

/** 提供商判断（id 精确匹配）。 */
export function isZcodeProvider(providerId: string): boolean {
  return providerId === ZCODE_PROVIDER_ID
}

/** 判断提供商是否配置为 Anthropic 协议（apiType === 'anthropic'）。 */
export function isZcodeAnthropic(provider: Provider): boolean {
  return isZcodeProvider(provider.id) && provider.apiType === 'anthropic'
}

/** 预设模板（BigModel CN 默认）。 */
export function zcodePreset(provider: 'bigmodel' | 'zai' = 'bigmodel'): {
  name: string
  id: string
  baseUrl: string
  apiType: string
  models: string[]
} {
  return provider === 'zai'
    ? {
        name: 'ZCode / Z.AI Coding Plan',
        id: ZCODE_PROVIDER_ID,
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        apiType: 'openai',
        models: ZCODE_MODELS,
      }
    : {
        name: 'ZCode / BigModel Coding Plan',
        id: ZCODE_PROVIDER_ID,
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiType: 'openai',
        models: ZCODE_MODELS,
      }
}

/**
 * ZCode / Z.ai 已知 GLM 模型列表。
 * Coding Plan 订阅包含的模型，实际可用模型以账号权限为准。
 */
export const ZCODE_MODELS: string[] = [
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-flash',
  'glm-4-air',
  'glm-4-airx',
  'glm-4-plus',
  'glm-4-long',
  'glm-4',
  'codegeex-4',
  'chatglm-turbo',
]

/**
 * 测试连接：发送最小 chat 请求验证 ZCode API Key 是否有效。
 * 由于 ZCode 是标准 OpenAI 兼容 API，直接使用通用测试逻辑即可，
 * 这里作为独立函数仅用于管理后台 handleTestModel 分支鉴别。
 */
export async function testZcodeModel(
  _env: Env,
  provider: Provider,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const enabledKeys = (provider.apiKeys || []).filter((k) => k.enabled)
  if (enabledKeys.length === 0) {
    return { success: false, message: '未配置 API Key' }
  }

  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${enabledKeys[0].key}`,
    ...buildZcodeHeaders(),
  }

  try {
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

    const errText = await response.text().catch(() => '')
    let errorMsg = `HTTP ${response.status}`
    try {
      const errJson = JSON.parse(errText)
      errorMsg = errJson?.error?.message || errJson?.message || errorMsg
    } catch { /* 非 JSON 响应 */ }
    return { success: false, message: errorMsg.substring(0, 200), statusCode: response.status }
  } catch (err) {
    return { success: false, message: `连接失败: ${(err as Error).message?.substring(0, 200) || '未知错误'}` }
  }
}

// ===== 动态模型拉取 =====
// 说明：Coding Plan 可用模型随账号订阅等级变化（Lite/Pro/Max 计费 credit 不同），
// 上游提供标准 OpenAI 兼容 GET {baseUrl}/models 端点，应按账号实际可用动态拉取，
// 静态 ZCODE_MODELS 仅作为无 Key / 拉取失败时的兜底清单。

const ZCODE_MODELS_CACHE_PREFIX = 'zcode:models:'
const ZCODE_MODELS_TTL_SUCCESS_SEC = 60 * 60      // 成功缓存 1h
const ZCODE_MODELS_TTL_FAILURE_SEC = 5 * 60       // 失败负缓存 5min

export interface ZcodeModelsResult {
  ok: boolean
  message: string
  models: Array<{ id: string }>
  /** dynamic = 上游实时拉取 | static = 失败回退静态清单 | cache = KV 缓存 */
  from: 'dynamic' | 'static' | 'cache'
}

/**
 * 动态拉取上游模型列表：GET {baseUrl}/models（带 ZCode 身份头 + Bearer Key）。
 * KV 缓存策略：成功 1h / 失败 5min，避免频繁请求上游。
 */
export async function fetchZcodeModels(
  env: Env,
  provider: Provider
): Promise<ZcodeModelsResult> {
  const cacheKey = ZCODE_MODELS_CACHE_PREFIX + provider.id

  interface CacheEntry { models?: string[]; fetchedAt?: number; failAt?: number }
  let cache: CacheEntry | null = null
  try {
    const raw = await env.KV.get(cacheKey)
    if (raw) cache = JSON.parse(raw) as CacheEntry
  } catch { /* ignore */ }

  const now = Date.now()
  if (cache?.models && cache.fetchedAt && now - cache.fetchedAt < ZCODE_MODELS_TTL_SUCCESS_SEC * 1000) {
    return {
      ok: true,
      message: `缓存命中，共 ${cache.models.length} 个模型`,
      models: cache.models.map((id) => ({ id })),
      from: 'cache',
    }
  }
  if (cache?.failAt && now - cache.failAt < ZCODE_MODELS_TTL_FAILURE_SEC * 1000) {
    return {
      ok: true,
      message: `上游拉取冷却中，回退静态清单（${ZCODE_MODELS.length} 个）`,
      models: ZCODE_MODELS.map((id) => ({ id })),
      from: 'static',
    }
  }

  const enabledKeys = (provider.apiKeys || []).filter((k) => k.enabled)
  if (enabledKeys.length === 0) {
    return { ok: false, message: '未配置启用的 API Key，无法拉取模型', models: ZCODE_MODELS.map((id) => ({ id })), from: 'static' }
  }

  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/models`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${enabledKeys[0].key}`,
        ...buildZcodeHeaders(),
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!response.ok) {
      const errText = (await response.text().catch(() => '')).substring(0, 300)
      try {
        await env.KV.put(cacheKey, JSON.stringify({ failAt: now }), { expirationTtl: ZCODE_MODELS_TTL_FAILURE_SEC })
      } catch { /* ignore */ }
      return {
        ok: false,
        message: `上游返回 HTTP ${response.status}: ${errText}`,
        models: ZCODE_MODELS.map((id) => ({ id })),
        from: 'static',
      }
    }

    const data = await response.json() as { data?: Array<{ id?: string } | string> } | Array<{ id?: string } | string>
    let modelIds: string[] = []
    const rawList = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : [])
    for (const m of rawList) {
      const id = typeof m === 'string' ? m : (m && typeof m.id === 'string' ? m.id : '')
      if (id) modelIds.push(id)
    }

    if (modelIds.length > 0) {
      try {
        await env.KV.put(cacheKey, JSON.stringify({ models: modelIds, fetchedAt: now }), { expirationTtl: ZCODE_MODELS_TTL_SUCCESS_SEC })
      } catch { /* ignore */ }
      return {
        ok: true,
        message: `从上游拉取 ${modelIds.length} 个模型`,
        models: modelIds.map((id) => ({ id })),
        from: 'dynamic',
      }
    }

    // 上游返回空：不算硬失败，但也不缓存成功，回退静态
    return {
      ok: true,
      message: `上游返回空列表，回退静态清单（${ZCODE_MODELS.length} 个）`,
      models: ZCODE_MODELS.map((id) => ({ id })),
      from: 'static',
    }
  } catch (err) {
    try {
      await env.KV.put(cacheKey, JSON.stringify({ failAt: now }), { expirationTtl: ZCODE_MODELS_TTL_FAILURE_SEC })
    } catch { /* ignore */ }
    return {
      ok: false,
      message: `请求异常: ${(err as Error).message || '未知错误'}`,
      models: ZCODE_MODELS.map((id) => ({ id })),
      from: 'static',
    }
  }
}