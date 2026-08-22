/**
 * cache-prefix.ts — 缓存前缀注入（提升上游提示词缓存命中率、节省 token）。
 *
 * 背景：Anthropic / OpenAI / DeepSeek / 通义 / Kimi 等主流厂商都做「前缀缓存」——
 * 请求开头 N 个 token 与缓存一致时按缓存价计费（通常只有原价的 10%~50%）。
 * 这里对指定模型（provider.cachePrefixInject 勾选的模型 ID）在转发前向 messages 头部
 * 注入一段「逐字节恒定」的 system 前缀，让每次请求拥有稳定的长前缀，从而
 * 最大化上游前缀缓存的命中率，降低 token 成本。
 *
 * 与 thinking.ts（思维引导）解耦：两者相互独立、可同时勾选；缓存前缀注入在前
 * （最外层稳定前缀），思维引导注入在后。幂等检测统一识别任意网关注入标记
 * （首行为 [gateway- 开头），重试 / 递归转发不会重复注入。
 *
 * 提示词可编辑：存于 KV（KV_KEYS.CACHE_PREFIX），管理后台可改；未设置时用内置默认。
 */

import { KV_KEYS } from './config'
import type { Env, Provider } from './types'

/** system 消息开头的标记，用于幂等检测与日志定位 */
export const CACHE_PREFIX_MARK = '[gateway-cache-prefix]'

/**
 * 内置默认缓存前缀（管理后台未自定义时生效）。
 * 要求：
 * - 逐字节恒定（写死常量，编辑后才会变化）；
 * - 内容中性、对大多数任务无副作用（不改变回答风格，只约束通用协作规范）；
 * - 长度适中，作为稳定前缀的一部分足够被上游缓存。
 */
export const DEFAULT_CACHE_PREFIX = `${CACHE_PREFIX_MARK}
你是一个通用 AI 助手，经由 AI Gateway 提供能力。以下是稳定不变的协作约定：

- 准确性：基于提供的上下文与你的知识作答；信息不足时明确说明，绝不编造。
- 直接：先给出结论或直接答案，再补充必要的论据、步骤或示例。
- 简洁：能一句话说明白就不用三句；避免重复、空话与不必要的铺垫。
- 格式：结构化内容使用 Markdown（标题、列表、表格、代码块）；代码应完整、可直接运行。
- 多轮：延续对话时参考历史上下文，不重复已确认的信息，聚焦于当前问题。
- 边界：不参与违法、有害、泄露隐私的请求；涉及权限边界时礼貌拒绝并说明原因。

（本段为网关固定前缀，用于提升提示词缓存命中率；无需复述，直接回答用户问题即可。）`

// ===== 提示词 KV 读写（带 10s 内存缓存，与 storage.ts / thinking.ts 约定一致）=====
const PREFIX_CACHE_TTL_MS = 10_000
const prefixCache = new Map<string, { text: string; at: number }>()

/** 读取当前生效的缓存前缀：KV 有则用之，否则回退内置默认。 */
export async function getCachePrefix(env: Env): Promise<string> {
  const cached = prefixCache.get(KV_KEYS.CACHE_PREFIX)
  if (cached && Date.now() - cached.at <= PREFIX_CACHE_TTL_MS) return cached.text
  const raw = await env.KV.get(KV_KEYS.CACHE_PREFIX)
  const text = raw ?? DEFAULT_CACHE_PREFIX
  prefixCache.set(KV_KEYS.CACHE_PREFIX, { text, at: Date.now() })
  return text
}

/** 覆盖保存缓存前缀。传 undefined/空 → 清空（回退默认）。 */
export async function setCachePrefix(env: Env, text: string): Promise<void> {
  const trimmed = text?.trim() ?? ''
  if (trimmed.length === 0) {
    await env.KV.delete(KV_KEYS.CACHE_PREFIX)
    prefixCache.delete(KV_KEYS.CACHE_PREFIX)
    return
  }
  await env.KV.put(KV_KEYS.CACHE_PREFIX, trimmed)
  prefixCache.set(KV_KEYS.CACHE_PREFIX, { text: trimmed, at: Date.now() })
}

/** 是否已自定义（KV 存在非默认值）。用于后台决定是否显示「恢复默认」。 */
export async function isCachePrefixCustom(env: Env): Promise<boolean> {
  const raw = await env.KV.get(KV_KEYS.CACHE_PREFIX)
  return !!raw?.trim() && raw !== DEFAULT_CACHE_PREFIX
}

// ===== 注入逻辑 =====

/** 是否已存在网关注入的固定前缀（缓存前缀或思维引导），用于幂等去重 */
function hasGatewayInjection(messages: unknown[]): boolean {
  return messages.some((m) => {
    const content = (m as { content?: unknown })?.content
    return typeof content === 'string' && content.startsWith('[gateway-')
  })
}

/**
 * 若 provider.cachePrefixInject 包含 modelId，则在 body.messages 头部注入缓存前缀 system 消息。
 * 前缀文本从 KV 读取（可编辑，未设置用默认）。
 * 未配置 / 未勾选该模型 / 无 messages / 已注入过任一网关前缀 → 原样返回（幂等，零影响）。
 * 直接原地改写 body，无返回。
 */
export async function applyCachePrefixInjection(
  env: Env,
  provider: Provider,
  modelId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const injectModels = provider.cachePrefixInject
  if (!Array.isArray(injectModels) || injectModels.length === 0) return
  if (!injectModels.includes(modelId)) return

  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return

  // 幂等：已存在任一网关固定前缀（缓存前缀或思维引导）则不重复注入
  if (hasGatewayInjection(messages)) return

  const prompt = await getCachePrefix(env)
  messages.unshift({ role: 'system', content: prompt })

  // 调试观测点：记录注入的前缀指纹（首行标记 + 长度），便于验证「改前缀后实时生效」
  try {
    const { writeLog } = await import('./admin')
    await writeLog(env, 'info', `[cache-prefix] 已向 model=${modelId} 注入缓存前缀`, `len=${prompt.length} head=${prompt.split('\n')[0]?.slice(0, 40) ?? ''}`)
  } catch { /* 日志失败不影响注入 */ }
}
