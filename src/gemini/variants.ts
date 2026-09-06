/**
 * variants.ts — Gemini 规范模型 → 真实变体 ID 解析（移植自 Antigravity-Manager
 * src-tauri/src/proxy/common/variant_mapping.rs）。
 *
 * 背景：cloudcode-pa v1internal 上游只接受"真实"模型 ID。客户端可配置规范族 ID
 * （如 gemini-3.7-flash），转发前必须解析为真实变体（-low/-medium/-high 等），
 * 并用已校准的 thinkingBudget / maxOutputTokens 替换客户端传值。
 *
 * 档位推断（infer_tier）：budget < 2000 → Low；< 7000 → Medium；≥ 7000 或无 budget → High。
 * reasoning_effort（low/medium/high）显式指定时优先于 budget。
 */

export type VariantTier = 'low' | 'medium' | 'high'

export interface GeminiRealModelSpec {
  /** 上游 model 字段用的真实 ID */
  id: string
  /** 已校准的 thinkingBudget */
  thinkingBudget: number
  /** 已校准的 maxOutputTokens */
  maxOutputTokens: number
  /** 响应是否含 thoughts */
  includeThoughts: boolean
}

interface AliasPolicy {
  /** honor = 跟随推断档位；fixed = 固定档位 */
  policy: 'honor' | 'fixed'
  tier?: VariantTier
}

interface CanonicalFamily {
  canonicalId: string
  tiers: Record<VariantTier, GeminiRealModelSpec>
  aliases: Record<string, AliasPolicy>
}

// ── 已校准真实模型规格（来自上游 spec，AM variant_mapping.rs 逐条对齐）──
const SPEC_37_FLASH_LOW: GeminiRealModelSpec = { id: 'gemini-3.7-flash-low', thinkingBudget: 1000, maxOutputTokens: 65536, includeThoughts: true }
const SPEC_37_FLASH_MEDIUM: GeminiRealModelSpec = { id: 'gemini-3.7-flash-medium', thinkingBudget: 4000, maxOutputTokens: 65536, includeThoughts: true }
const SPEC_37_FLASH_HIGH: GeminiRealModelSpec = { id: 'gemini-3.7-flash-high', thinkingBudget: 10000, maxOutputTokens: 65536, includeThoughts: true }

const SPEC_35_FLASH_EXTRA_LOW: GeminiRealModelSpec = { id: 'gemini-3.5-flash-extra-low', thinkingBudget: 1000, maxOutputTokens: 65536, includeThoughts: true }
const SPEC_35_FLASH_LOW: GeminiRealModelSpec = { id: 'gemini-3.5-flash-low', thinkingBudget: 4000, maxOutputTokens: 65536, includeThoughts: true }
const SPEC_3_FLASH_AGENT: GeminiRealModelSpec = { id: 'gemini-3-flash-agent', thinkingBudget: 10000, maxOutputTokens: 65536, includeThoughts: true }

const SPEC_31_PRO_LOW: GeminiRealModelSpec = { id: 'gemini-3.1-pro-low', thinkingBudget: 1001, maxOutputTokens: 65535, includeThoughts: true }
const SPEC_PRO_AGENT: GeminiRealModelSpec = { id: 'gemini-pro-agent', thinkingBudget: 10001, maxOutputTokens: 65535, includeThoughts: true }

const SPEC_31_FLASH_LITE: GeminiRealModelSpec = { id: 'gemini-3.1-flash-lite', thinkingBudget: 0, maxOutputTokens: 16384, includeThoughts: false }
const SPEC_CLAUDE_SONNET_46: GeminiRealModelSpec = { id: 'claude-sonnet-4-6', thinkingBudget: 1024, maxOutputTokens: 64000, includeThoughts: true }
const SPEC_CLAUDE_OPUS_46: GeminiRealModelSpec = { id: 'claude-opus-4-6-thinking', thinkingBudget: 1024, maxOutputTokens: 64000, includeThoughts: true }
const SPEC_GPT_OSS_120B: GeminiRealModelSpec = { id: 'gpt-oss-120b-medium', thinkingBudget: 8192, maxOutputTokens: 32768, includeThoughts: true }

export const GEMINI_FAMILIES: CanonicalFamily[] = [
  {
    canonicalId: 'gemini-3.8-flash',
    tiers: { low: SPEC_37_FLASH_LOW, medium: SPEC_37_FLASH_MEDIUM, high: SPEC_37_FLASH_HIGH },
    aliases: {
      'gemini-3.8-flash-high': { policy: 'honor' },
      'gemini-3.8-flash-medium': { policy: 'fixed', tier: 'medium' },
      'gemini-3.8-flash-low': { policy: 'fixed', tier: 'low' },
      'gemini-3.8-flash-tiered': { policy: 'honor' },
    },
  },
  {
    canonicalId: 'gemini-3.7-flash',
    tiers: { low: SPEC_37_FLASH_LOW, medium: SPEC_37_FLASH_MEDIUM, high: SPEC_37_FLASH_HIGH },
    aliases: {
      'gemini-3.7-flash-high': { policy: 'honor' },
      'gemini-3.7-flash-medium': { policy: 'fixed', tier: 'medium' },
      'gemini-3.7-flash-low': { policy: 'fixed', tier: 'low' },
      'gemini-3.7-flash-tiered': { policy: 'honor' },
      'gemini-3.6-flash-high': { policy: 'honor' },
      'gemini-3.6-flash-medium': { policy: 'fixed', tier: 'medium' },
      'gemini-3.6-flash-low': { policy: 'fixed', tier: 'low' },
      'gemini-3.6-flash': { policy: 'honor' },
      'gemini-3.6-flash-tiered': { policy: 'honor' },
    },
  },
  {
    canonicalId: 'gemini-3.5-flash',
    tiers: { low: SPEC_35_FLASH_EXTRA_LOW, medium: SPEC_35_FLASH_LOW, high: SPEC_3_FLASH_AGENT },
    aliases: {
      'gemini-3.5-flash-high': { policy: 'honor' },
      'gemini-3.5-flash-medium': { policy: 'fixed', tier: 'medium' },
      'gemini-3.5-flash-low': { policy: 'fixed', tier: 'low' },
      'gemini-3.5-flash-extra-low': { policy: 'fixed', tier: 'low' },
      'gemini-3-flash': { policy: 'honor' },
      'gemini-3-flash-agent': { policy: 'honor' },
      'gemini-3.5-flash-tiered': { policy: 'honor' },
    },
  },
  {
    canonicalId: 'gemini-3.1-pro',
    tiers: { low: SPEC_31_PRO_LOW, medium: SPEC_PRO_AGENT, high: SPEC_PRO_AGENT },
    aliases: {
      'gemini-3.1-pro-high': { policy: 'honor' },
      'gemini-3.1-pro-medium': { policy: 'honor' },
      'gemini-pro': { policy: 'honor' },
      'gemini-pro-agent': { policy: 'honor' },
      'gemini-3.1-pro-low': { policy: 'fixed', tier: 'low' },
      'gemini-3.1-pro-tiered': { policy: 'honor' },
    },
  },
]

export function resolveNonVariantModel(model: string): GeminiRealModelSpec | null {
  const key = String(model || '').trim().toLowerCase()
  if (['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-thinking'].includes(key)) {
    return SPEC_31_FLASH_LITE
  }
  if (key === 'claude-sonnet-4-6' || key === 'claude-3-7-sonnet' || key === 'claude-3.7-sonnet') {
    return SPEC_CLAUDE_SONNET_46
  }
  if (['claude-opus-4-6-thinking', 'claude-opus-4-6', 'claude-3-7-opus'].includes(key)) {
    return SPEC_CLAUDE_OPUS_46
  }
  if (key === 'gpt-oss-120b-medium' || key === 'gpt-oss-120b') {
    return SPEC_GPT_OSS_120B
  }
  return null
}

export function inferTier(thinkingBudget?: number): VariantTier {
  if (typeof thinkingBudget !== 'number') return 'high'
  if (thinkingBudget < 2000) return 'low'
  if (thinkingBudget < 7000) return 'medium'
  return 'high'
}

/**
 * 规范模型 → 真实变体模型。
 * @param model 规范/别名/真实 ID（不区分大小写）
 * @param opts.effort 客户端 reasoning_effort（low/medium/high），显式档位优先
 * @param opts.thinkingBudget 客户端 thinking budget（量级用于推断档位）
 * @returns 命中变体族时返回真实规格（id 已替换）；非变体模型返回 null（原样透传）
 */
export function resolveGeminiRealModel(
  model: string,
  opts?: { effort?: string; thinkingBudget?: number }
): GeminiRealModelSpec | null {
  const key = String(model || '').trim().toLowerCase()
  if (!key) return null

  // 1. 优先检查非变体模型
  const nonVariant = resolveNonVariantModel(key)
  if (nonVariant) return nonVariant

  // 2. 变体族推断
  const tier: VariantTier = (opts?.effort === 'low' || opts?.effort === 'medium' || opts?.effort === 'high')
    ? opts.effort
    : inferTier(opts?.thinkingBudget)

  for (const family of GEMINI_FAMILIES) {
    if (family.canonicalId === key) {
      return family.tiers[tier]
    }
    const alias = family.aliases[key]
    if (alias) {
      const resolved = alias.policy === 'honor' ? tier : (alias.tier as VariantTier)
      return family.tiers[resolved]
    }
  }
  return null
}
