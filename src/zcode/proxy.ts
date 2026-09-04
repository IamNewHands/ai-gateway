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