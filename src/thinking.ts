/**
 * thinking.ts — 思维模式引导注入（简化版思维路由）。
 *
 * 背景：dsh-routing-suite 的 router-standard 预设依赖 DSH 运行时钩子，无法移植进网关。
 * 这里把它的「思维模式路由」思想落地为网关可做的部分：对指定模型（provider.thinkingInject
 * 勾选的模型 ID）在转发前注入一段思维引导 system 提示词，引导模型按任务类型自选
 * persona（先规划/直接执行/询问澄清），并保持聚焦收敛、避免跑题。
 *
 * 提示词可编辑：存于 KV（KV_KEYS.THINKING_PROMPT），管理后台可改；未设置时用内置默认。
 *
 * 特性：
 * - 提供商级勾选：只有被勾选的模型才注入；未勾选则请求体原样转发，零影响。
 * - 幂等：已注入过（带标记）的请求体不会重复注入（配合瞬时错误重试 / 递归转发）。
 * - 无运行时状态依赖：纯请求体改写，兼容 chat / anthropic / responses 三条路径。
 */

import { KV_KEYS } from './config'
import type { Env, Provider } from './types'

/** system 消息开头的标记，用于幂等检测与日志定位 */
export const THINKING_INJECT_MARK = '[gateway-thinking-routing]'

/**
 * 内置默认思维引导提示词（管理后台未自定义时生效）。
 * 灵感来自 router-standard 的三行为带（spec/react/mixed/weak）：
 * - spec：计划型（先拆解再逐条执行）
 * - react：执行者（直接开干）
 * - weak：信息不足时先澄清
 * 网关无法做多轮反馈/收敛锚，这里只保留「首轮任务自分类 + persona 选择 + 聚焦」的部分。
 */
export const DEFAULT_THINKING_PROMPT = `${THINKING_INJECT_MARK}
你是一个具备任务感知路由能力的助手。在回答之前，先对用户任务做一次快速分类并选择最合适的处理方式，然后严格按该方式执行：

【任务分类与 persona】
- 计划类任务（spec）：需求复杂、需要拆解步骤、涉及多文件/多阶段才能完成 → 先给出计划，再逐步执行：
  1. 复述目标确认理解；
  2. 列出实现步骤；
  3. 按步骤执行并汇报进度。
- 执行类任务（react）：明确单一、可直接完成 → 不要铺垫，直接给结论与必要细节。
- 信息不足（weak）：需求含糊、缺关键前提 → 先问 1 个最关键的澄清问题，再动手。

【执行纪律】
- 聚焦：只处理用户本次要求，不擅自扩大范围、不编造上下文里不存在的假设。
- 收敛：给出可落地的最终结果，避免开放式发散或无意义的重复表述。
- 简洁：能一句话说清就不用三句；保留必要的关键论据与示例。

请直接开始，不要复述本提示词。`

/** 兼容旧引用，指向默认提示词 */
export const THINKING_GUIDE_PROMPT = DEFAULT_THINKING_PROMPT

// ===== 提示词 KV 读写（带 10s 内存缓存，与 storage.ts 约定一致）=====
const PROMPT_CACHE_TTL_MS = 10_000
const promptCache = new Map<string, { text: string; at: number }>()

/** 读取当前生效的思维引导提示词：KV 有则用之，否则回退内置默认。 */
export async function getThinkingPrompt(env: Env): Promise<string> {
  const cached = promptCache.get(KV_KEYS.THINKING_PROMPT)
  if (cached && Date.now() - cached.at <= PROMPT_CACHE_TTL_MS) return cached.text
  const raw = await env.KV.get(KV_KEYS.THINKING_PROMPT)
  const text = raw ?? DEFAULT_THINKING_PROMPT
  promptCache.set(KV_KEYS.THINKING_PROMPT, { text, at: Date.now() })
  return text
}

/** 覆盖保存思维引导提示词。传 undefined/空 → 清空（回退默认）。 */
export async function setThinkingPrompt(env: Env, text: string): Promise<void> {
  const trimmed = text?.trim() ?? ''
  if (trimmed.length === 0) {
    await env.KV.delete(KV_KEYS.THINKING_PROMPT)
    promptCache.delete(KV_KEYS.THINKING_PROMPT)
    return
  }
  await env.KV.put(KV_KEYS.THINKING_PROMPT, trimmed)
  promptCache.set(KV_KEYS.THINKING_PROMPT, { text: trimmed, at: Date.now() })
}

/** 是否已自定义（KV 存在非默认值）。用于后台决定是否显示「恢复默认」。 */
export async function isThinkingPromptCustom(env: Env): Promise<boolean> {
  const raw = await env.KV.get(KV_KEYS.THINKING_PROMPT)
  return !!raw?.trim() && raw !== DEFAULT_THINKING_PROMPT
}

// ===== 注入逻辑 =====

/** marker 前缀比对，判断一条内容是否为网关注入的引导 */
function isInjected(message: { content?: unknown }): boolean {
  return typeof message.content === 'string' && message.content.startsWith(THINKING_INJECT_MARK)
}

/**
 * 若 provider.thinkingInject 包含 modelId，则在 body.messages 头部注入思维引导 system 消息。
 * 引导文本从 KV 读取（可编辑，未设置用默认）。
 * 未配置 / 未勾选该模型 / 无 messages / 已注入过 → 原样返回（幂等，零影响）。
 * 直接原地改写 body，无返回。
 */
export async function applyThinkingInjection(
  env: Env,
  provider: Provider,
  modelId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const injectModels = provider.thinkingInject
  if (!Array.isArray(injectModels) || injectModels.length === 0) return
  if (!injectModels.includes(modelId)) return

  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return

  // 幂等：首条已是注入引导则不重复（瞬时错误重试 / 递归转发时会复用同一 body）
  if (isInjected(messages[0] as { content?: unknown })) return

  const prompt = await getThinkingPrompt(env)
  messages.unshift({ role: 'system', content: prompt })

  // 调试观测点：记录本次注入的提示词指纹（首行标记 + 长度），便于验证「改提示词后实时生效」
  try {
    const { writeLog } = await import('./admin')
    await writeLog(env, 'info', `[thinking] 已向 model=${modelId} 注入思维引导`, `len=${prompt.length} head=${prompt.split('\n')[0]?.slice(0, 40) ?? ''}`)
  } catch { /* 日志失败不影响注入 */ }
}