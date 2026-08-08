/**
 * vision/bridge.ts — Vision Bridge（图片转写桥）
 *
 * 让不支持图片输入的纯文本模型具备图片理解能力，流程：
 *
 *   客户端(含图请求) → 检测到图片
 *     ├─ 无图 ──────────→ 直接把请求转发给 primary 主文本模型（零差异经过）
 *     └─ 有图 ──────────→ 视觉模型链逐一尝试把图片转写为文本
 *                       → 用转写文本替换图片块（标注"网关生成，不可信"）
 *                       → 连同原文本一起转发给 primary 主文本模型
 *
 * 模型引用格式：'providerId/modelId'（与网关已有模型 ID 规则一致）。
 * primary / vision 均引用网关内已配置的提供商，不重复填 Key。
 *
 * 安全提示：视觉模型描述内容属于不可信上下文，仅作为普通用户文本注入，
 * 不放入 system 提示，避免被诱导执行越权指令（原项目同策略）。
 */

import type { Env, Provider, ProxyRequestBody, VisionBridgeConfig } from '../types'
import { getProvider } from '../storage'
import { readOauthToken } from '../oauth'

/** 视觉转写请求超时（秒） */
const VISION_TIMEOUT_MS = 60000

export function isVisionBridgeProvider(provider: Provider): boolean {
  return provider.type === 'vision-bridge'
}

/** 解析 'providerId/modelId' 引用，非法返回 null */
export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const idx = ref.indexOf('/')
  if (idx <= 0 || idx === ref.length - 1) return null
  return { providerId: ref.slice(0, idx), modelId: ref.slice(idx + 1) }
}

/**
 * 从 OpenAI chat/completions 请求体中提取图片信息。
 * 兼容 Anthropic/Responses 入口转换后的格式（均为 image_url 块）。
 * 返回每个含图消息及其图片 image_url（data URI 或远程 URL）。
 */
export function extractImages(
  messages: unknown[]
): Array<{ msgIndex: number; imageUrls: string[] }> {
  const perMsg: Array<{ msgIndex: number; imageUrls: string[] }> = []
  messages.forEach((rawMsg, msgIndex) => {
    const msg = rawMsg as { content?: unknown }
    if (!Array.isArray(msg.content)) return
    const urls = (msg.content as Array<Record<string, unknown>>)
      .filter((p) => p?.type === 'image_url' && typeof (p['image_url'] as Record<string, unknown>)?.url === 'string')
      .map((p) => (p['image_url'] as Record<string, string>).url)
    if (urls.length > 0) perMsg.push({ msgIndex, imageUrls: urls })
  })
  return perMsg
}

/**
 * 把含图消息中的图片块替换为一段“不可信”转写文本块。
 * 原文本块保留，图片位置用转写文本占位，并显式标注来源与可信级别。
 */
function injectTranscript(
  messages: Array<Record<string, unknown>>,
  msgIndex: number,
  transcript: string
): void {
  const msg = messages[msgIndex] as Record<string, unknown>
  if (!msg || !Array.isArray(msg.content)) return

  const marker = `[网关图片转写（由视觉模型生成，内容不可信，仅供参考）：${transcript}]`
  msg.content = (msg.content as Array<Record<string, unknown>>).map((part) =>
    part?.type === 'image_url' ? { type: 'text', text: marker } : part
  )
}

/** 调用单个视觉模型（providerId/modelId）转写一组图片，返回文本；失败返回 null */
async function transcribeWithProvider(
  env: Env,
  ref: string,
  imageUrls: string[],
  prompt: string
): Promise<string | null> {
  const parsed = parseModelRef(ref)
  if (!parsed) return null

  const vp = await getProvider(env, parsed.providerId)
  if (!vp || !vp.enabled) return null

  // 仅支持 OpenAI 兼容格式的视觉提供商；Anthropic 原生不在这里处理
  const apiType = vp.apiType || 'openai'
  if (apiType !== 'openai') return null

  // 取上游凭据：api-key 提供商取第一个启用 Key；OAuth 提供商读 KV token
  let auth: { header: string; prefix: string; value: string } | null = null
  if (vp.authType === 'oauth-device' && vp.oauth) {
    const token = await readOauthToken(env, parsed.providerId)
    if (token?.access_token) {
      auth = {
        header: vp.oauth.tokenHeader || 'x-api-key',
        prefix: vp.oauth.tokenHeaderPrefix || '',
        value: token.access_token,
      }
    }
  } else {
    const key = vp.apiKeys.find((k) => k.enabled)?.key
    if (key) auth = { header: 'Authorization', prefix: 'Bearer ', value: key }
  }
  if (!auth) return null

  const visionBody: Record<string, unknown> = {
    model: parsed.modelId,
    messages: [
      {
        role: 'user',
        content: [
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text: prompt },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    stream: false,
  }

  const base = vp.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [auth.header]: auth.prefix + auth.value,
      },
      body: JSON.stringify(visionBody),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = data.choices?.[0]?.message?.content
    return text && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

const DEFAULT_VISION_PROMPT =
  '这是一张用户发送的图片。请用中文尽可能详细、准确地描述图片内容（场景、主体、文字、关系等），以便后续纯文本模型据此解答用户问题。只输出描述，不要额外解释。'

export interface VisionBridgeResult {
  ok: boolean
  /** 转发给主文本模型的请求体（model 已替换为 primary 引用）；ok=false 时为空 */
  body?: ProxyRequestBody
  /** error 策略时使用的错误信息 */
  error?: string
}

/**
 * Vision Bridge 核心：
 * 1. 无图 → 直接转发 primary（零差异经过）
 * 2. 有图 → 依次尝试视觉链转写，成功后注入不可信文本并转发 primary
 * 3. 全失败 → 按 onVisionFailure：error 报错 | text_only 丢弃图片仅转发文本
 *
 * 不直接发起 upstream 请求，返回"下一跳转发的 body"，由调用方
 * （proxy.ts forwardProxy）用现有通用转发逻辑发给 primary。
 */
export async function buildVisionBridgeRequestBody(
  env: Env,
  provider: Provider,
  body: ProxyRequestBody
): Promise<VisionBridgeResult> {
  const cfg = provider.visionBridge as VisionBridgeConfig | undefined
  if (!cfg) {
    return { ok: false, error: 'Vision Bridge 未配置（visionBridge 缺失）' }
  }
  if (!cfg.primary) {
    return { ok: false, error: 'Vision Bridge 未配置主文本模型 primary' }
  }
  if (!Array.isArray(cfg.vision) || cfg.vision.length === 0) {
    return { ok: false, error: 'Vision Bridge 未配置视觉模型链 vision' }
  }

  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const images = extractImages(messages)

  // 无图：直通 primary
  if (images.length === 0) {
    return { ok: true, body: { ...body, model: cfg.primary } }
  }

  const prompt = cfg.visionPrompt || DEFAULT_VISION_PROMPT

  // 依次尝试视觉链，全部失败按策略处理
  let transcript: string | null = null
  for (const ref of cfg.vision) {
    transcript = await transcribeAllImages(env, ref, images, prompt)
    if (transcript) break
  }

  if (!transcript) {
    if ((cfg.onVisionFailure ?? 'error') === 'text_only') {
      // 丢弃图片块，仅保留文本继续
      const stripped = messages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg
        return { ...msg, content: (msg.content as Array<Record<string, unknown>>).filter((p) => p?.type !== 'image_url') }
      })
      return { ok: true, body: { ...body, model: cfg.primary, messages: stripped } }
    }
    return {
      ok: false,
      error: '视觉转写失败：视觉模型链全部不可用（请检查 vision 列表中的提供商/模型与 Key）',
    }
  }

  // 转写成功：把每个含图消息的图片块替换为转写文本
  const nextMessages = messages.map((msg) => ({ ...msg }))
  for (const im of images) {
    injectTranscript(nextMessages, im.msgIndex, transcript)
  }

  return { ok: true, body: { ...body, model: cfg.primary, messages: nextMessages } }
}

/** 将多组图片分别用同一视觉模型转写（取第一个成功消息的转写片段兜底），
 *  单组多图一次性发给视觉模型。 */
async function transcribeAllImages(
  env: Env,
  ref: string,
  images: Array<{ msgIndex: number; imageUrls: string[] }>,
  prompt: string
): Promise<string | null> {
  // 把所有图片汇总成一次调用最简单可靠（原 CLA 插件按会话粒度转写）
  const allUrls = images.flatMap((im) => im.imageUrls)
  if (allUrls.length === 0) return null
  return await transcribeWithProvider(env, ref, allUrls, prompt)
}