/**
 * model-context-catalog.ts — context_length / max_output_tokens 字段级静态兜底知识表。
 *
 * 出处：workbuddy2api（Go）提交 `32a3c13`（2026-09-16，Sliverkiss）
 *   「feat(server): context_length 字段级知识表兜底——零值不再透出假 131072，未知落 1M」
 *   上游对应文件：`internal/upstream/context_catalog.go`（本文件逐条照抄其知识表数值与语义）。
 *
 * 数据来源三级（与上游同模式）：
 *   1. 远端动态值（本仓 trae 的 `TraeModelInfo.contextWindow` / `maxTokens`，
 *      来自 get_detail_param 的 max_input_tokens / max_output_tokens）权威，优先；
 *   2. 本文件按模型的知识表（远端零值时补齐）；
 *   3. 仍未知的 context_length → 1M 兜底（宁可高估不低估：高估代价是客户端不截断、
 *      上游报错可重试；低估代价是下游客户端（Codex/ZCode/Claude Code 按
 *      context_length 提前截断）白白丢上下文）。max_output_tokens 未知 → 返回 null，
 *      调用方省略该字段（输出上限无「宁可高估」的安全侧，不编造）。
 *
 * 上游「一处定义、CN/global 两域共用」的理由是 context_length 是模型固有属性；
 * 本仓同理：trae 静态表与 trae 动态条目共用同一张表，无按 realm/provider 分表必要。
 *
 * 值来源两类，逐条注释标注（照抄上游注释）：
 *   - 实测：上游 fork 706412584 直连 CN /console/enterprises/personal/models 的
 *     maxInputTokens（2026-09-13 实测；global 侧为同 id 外推）；
 *   - models.dev：https://models.dev/ 收录值（2026-09-16 查询，取多 provider 共识值；
 *     官方源如 moonshotai/zai 优先）。未收录或歧义大者不编造。
 */

/** 知识表也未收录的模型的 context_length 兜底：1M（上游 DefaultContextWindow）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

/** 一个模型的上下文能力（字段级兜底条目，对应上游 `contextCap`）。 */
export interface ModelContextCap {
  /** 上下文窗口（必为正，否则条目无意义） */
  context: number
  /** 输出上限；0 = 未知 → max_output_tokens 字段省略（不编造） */
  maxOutput: number
}

/**
 * context_length / max_output_tokens 知识表（照抄上游 `contextCapFallback`，27 条）。
 * 每条注释标注来源：实测 = fork 706412584 直连 CN 实测 maxInputTokens（global 侧同 id 外推）；
 * models.dev = 2026-09-16 收录共识值；估算 = 同族外推。
 */
export const MODEL_CONTEXT_CATALOG: Record<string, ModelContextCap> = {
  // ---- GLM 家族（z-ai）----
  'glm-5.2': { context: 1_000_000, maxOutput: 131_072 }, // 实测（CN 1M；models.dev 共识 1M/131072）
  'glm-5.1': { context: 200_000, maxOutput: 131_072 }, // 实测（CN 200K；models.dev 共识 200K/131072）
  'glm-5.3': { context: 1_000_000, maxOutput: 131_072 }, // 实测外推 + models.dev 共识 1M/131072
  'glm-5.3-flash': { context: 1_000_000, maxOutput: 131_072 }, // models.dev 共识 1M/131072
  'glm-5v-turbo': { context: 200_000, maxOutput: 131_072 }, // 实测（CN 200K；models.dev 共识 200K/131072）

  // ---- Kimi 家族（moonshot）----
  'kimi-k2.7': { context: 256_000, maxOutput: 65_536 }, // 实测（CN 256K）；输出 65536 为 models.dev kimi-k2.7-code 同族估算
  'kimi-k2.6': { context: 256_000, maxOutput: 262_144 }, // 实测（CN 256K）；输出 models.dev 官方 262144
  'kimi-k2.5': { context: 164_000, maxOutput: 262_144 }, // 实测（global 侧同 id 外推 164K）；输出 models.dev 共识 262144
  'kimi-k3': { context: 1_048_576, maxOutput: 131_072 }, // models.dev 官方（moonshotai 1M/128K）
  'kimi-k2.8-preview': { context: 1_048_576, maxOutput: 0 }, // models.dev（Kimi K2.8 Preview 1M；输出上限未收录，省略）

  // ---- MiniMax / 混元（tencent）----
  'minimax-m3': { context: 512_000, maxOutput: 512_000 }, // 实测（CN 512K）；输出 models.dev 共识 512000
  hy3: { context: 192_000, maxOutput: 64_000 }, // 实测（CN 192K/64K，repo hy3 抓取样本同值）
  'hy3-preview': { context: 262_144, maxOutput: 64_000 }, // models.dev（共识 262144/64000）
  'hy4-preview': { context: 1_000_000, maxOutput: 64_000 }, // 实测外推 + models.dev（~1M/64000）
  'hy4-preview-x': { context: 1_000_000, maxOutput: 64_000 }, // 实测外推（1M）；输出同族 hy4-preview 估算

  // ---- DeepSeek 家族 ----
  'deepseek-v4-pro': { context: 1_000_000, maxOutput: 384_000 }, // 实测（CN 1M；models.dev 共识 1M/384000）
  'deepseek-v4-flash': { context: 1_000_000, maxOutput: 384_000 }, // 实测（CN 1M；models.dev 共识 1M/384000）
  'deepseek-v4.1-flash': { context: 1_000_000, maxOutput: 384_000 }, // 实测外推 + models.dev 共识 1M/384000

  // ---- OpenAI / Google（global 域家族）----
  'gpt-6-astra': { context: 1_050_000, maxOutput: 128_000 }, // models.dev（全 provider 一致 1050000/128000）
  'gpt-5.6-sol': { context: 1_050_000, maxOutput: 128_000 }, // models.dev 共识
  'gpt-5.6-terra': { context: 1_050_000, maxOutput: 128_000 }, // models.dev 共识
  'gpt-5.6-luna': { context: 1_050_000, maxOutput: 128_000 }, // models.dev 共识
  'gpt-5.5': { context: 1_050_000, maxOutput: 128_000 }, // models.dev 共识
  'gpt-5.4': { context: 1_050_000, maxOutput: 128_000 }, // models.dev 共识
  'gpt-5.3-codex': { context: 400_000, maxOutput: 128_000 }, // models.dev（全 provider 一致 400000/128000）
  'gemini-3.5-flash': { context: 1_048_576, maxOutput: 65_536 }, // models.dev 共识

  // ---- global 域路由别名/别名模型 ----
  auto: { context: 168_000, maxOutput: 0 }, // 实测外推（fork global 静态表 168K）；输出上限未知，省略
}

/** 知识表按 key 长度降序（最长前缀优先，避免 `glm-5.3` 抢走 `glm-5.3-flash`）。 */
const CATALOG_KEYS_BY_LENGTH: string[] = Object.keys(MODEL_CONTEXT_CATALOG).sort((a, b) => b.length - a.length)

/** 模型名归一化：去空白 + 小写（表 key 全小写；trae 的 `DeepSeek-V4-Pro` 等混合大小写需归一）。 */
function normalizeModelName(model: string): string {
  return (model || '').trim().toLowerCase()
}

/**
 * 查知识表（大小写不敏感的两级匹配）：
 *   1. 全名精确匹配 —— 与上游 `contextCapFallback[model]` 同语义，是权威路径；
 *   2. 最长「边界前缀」匹配 —— trae 的 id 常带后缀（`DeepSeek-V4-Flash-Official`、
 *      `kimi-k2.7-code`、`glm-5.2__dev`），精确匹配会全部落空并错误回落到 1M。
 *      要求前缀后紧跟 `-` `_` `.` `:` `/` `@` 之一或字符串结束，避免 `auto` 命中
 *      `autofoo`、`glm-5.3` 命中 `glm-5.30` 这类误匹配。
 * 刻意不做任意位置子串匹配：`glm-5` 会命中 `glm-5.2`、`gpt-5.4` 会命中 `gpt-5.40`，
 * 会把「未知模型」伪装成「已知模型」，与上游「未收录即不编造」的口径冲突。
 */
function lookupCap(model: string): ModelContextCap | undefined {
  const m = normalizeModelName(model)
  if (!m) return undefined
  const exact = MODEL_CONTEXT_CATALOG[m]
  if (exact) return exact
  for (const key of CATALOG_KEYS_BY_LENGTH) {
    if (!m.startsWith(key)) continue
    const next = m.charAt(key.length)
    if (next === '' || next === '-' || next === '_' || next === '.' || next === ':' || next === '/' || next === '@') {
      return MODEL_CONTEXT_CATALOG[key]
    }
  }
  return undefined
}

/**
 * 模型在 /v1/models 的 context_length（三级查找）：
 * remote（上游 max_input_tokens）>0 时权威；否则查知识表；仍未收录 → DEFAULT_CONTEXT_WINDOW
 * （1M，宁可高估不低估）。绝不再透出假 131072。
 */
export function contextWindowListing(model: string, remote?: number): number {
  if (typeof remote === 'number' && Number.isFinite(remote) && remote > 0) return remote
  const cap = lookupCap(model)
  if (cap && cap.context > 0) return cap.context
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 模型在 /v1/models 的 max_output_tokens（三级查找）：
 * remote（上游 max_output_tokens）>0 时权威；否则查知识表；仍未收录 → null
 * （调用方省略字段，不编造输出上限）。与 contextWindowListing 的 1M 兜底刻意不同：
 * 输出上限无「宁可高估」的安全侧，未知即省略。
 */
export function maxOutputTokensListing(model: string, remote?: number): number | null {
  if (typeof remote === 'number' && Number.isFinite(remote) && remote > 0) return remote
  const cap = lookupCap(model)
  if (cap && cap.maxOutput > 0) return cap.maxOutput
  return null
}
