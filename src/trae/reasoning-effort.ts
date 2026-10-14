/**
 * reasoning-effort.ts — OpenAI/Anthropic 思考强度 → TRAE 原生档位映射。
 * 移植自 Trae2api-cn `src/reasoning_effort.py`。
 *
 * ## 为什么只有 Remote 用得上
 *
 * TRAE 把档位存在 `custom_model` 对象里（`reasoning_effort_level` 或 `reasoning_effort`，
 * **二选一，绝不同时**）。源侧 `apply_reasoning_effort` 的唯一调用点在
 * `trae_remote_client.py:891` —— 也就是说 **SOLO / IDE 端点根本不带 `custom_model`**，
 * 客户端设的思考强度在那两条路上必然被忽略。
 *
 * 这就是「切到 Remote 能调思考强度」的全部技术依据：不是 Remote 更聪明，
 * 而是它多了一个能承载档位的字段。
 *
 * ## 档位与钳制
 *
 * 上游只有三档：`light` < `high` < `extra_high`。客户端可能送来 `low`/`medium`/`max`
 * 之类的别名，先归一化再**向下钳制**到该模型真正支持的档位（取 ≤ 请求档位的最高者，
 * 都超了就取最低支持档）。绝不向上越级——那会发一个上游没声明的值。
 */
import type { TraeReasoningEffortConfig } from './types'

/** 上游档位，由弱到强。索引即强度序，钳制算法依赖这个顺序。 */
export const TRAE_EFFORT_LEVELS = ['light', 'high', 'extra_high'] as const

export type TraeEffortLevel = (typeof TRAE_EFFORT_LEVELS)[number]

/**
 * 客户端别名 → 上游档位。
 *
 * 覆盖三种客户端口径：
 *  - OpenAI `reasoning_effort`：minimal/low/medium/high
 *  - Anthropic `thinking.effort` / `thinking.level`
 *  - 本网关自己的 `reasoningEffort`（见 src/types.ts Provider.reasoningEffort）
 *
 * ## 为什么 `high` 必须落到 `extra_high`（2026-10-14 修）
 *
 * DeepSeek Harness 的档位是**按模型声明**的，本地 profile 给 `trae/deepseek-v4.1-flash`
 * 声明的就是三档（`C:\Users\shiro\.dsh\profiles\desktop\cordis.patch.yml`）：
 *
 * ```yaml
 * reasoningEfforts:
 *   low: low
 *   medium: medium
 *   high: high
 * ```
 *
 * 也就是说线上只会出现 `low` / `medium` / `high` 三个字面值。而「default」那一档
 * **不下发字段**（DSH 用 `PROVIDER_DEFAULT_REASONING_VALUE` 表示「未指定」），
 * 所以它不该在别名表里占位 —— 否则「默认」会被静默解释成某个具体档位。
 *
 * 旧的映射把 `medium` 和 `high` 都折成 `high`，后果是：**用户能选三档，上游只收到两档，
 * 而且 `extra_high` 永远选不到** —— 思考强度的上限被我们自己的别名表砍掉了。
 * 现在三档对三档，一一对应，不塌陷：
 *
 * | 客户端 | 上游 |
 * |---|---|
 * | `low` / `minimal` / `none` | `light` |
 * | `medium` / `normal` | `high` |
 * | `high` / `xhigh` / `max` | `extra_high` |
 *
 * OpenAI 官方口径是 minimal/low/medium/high 四档，上游只有三档，所以 4→3 的塌陷
 * 必须发生在**最弱端**（`minimal` 与 `low` 合并），而不是最强端。
 */
const EFFORT_ALIASES: Record<string, TraeEffortLevel> = {
  // 最弱档。上游没有「关掉思考」，最低档就是它的等价物。
  none: 'light',
  minimal: 'light',
  min: 'light',
  low: 'light',
  light: 'light',
  // 中间档
  medium: 'high',
  mid: 'high',
  normal: 'high',
  // 最强档
  high: 'extra_high',
  xhigh: 'extra_high',
  'x-high': 'extra_high',
  extra_high: 'extra_high',
  'extra-high': 'extra_high',
  very_high: 'extra_high',
  max: 'extra_high',
  maximum: 'extra_high',
}

/** 归一化一个档位字符串；不认识 → ''（不猜）。 */
export function normalizeEffortLevel(value: unknown): TraeEffortLevel | '' {
  const text = String(value ?? '').trim().toLowerCase().replace(/ /g, '_')
  return EFFORT_ALIASES[text] ?? ''
}

/**
 * Anthropic `thinking.budget_tokens` → 档位（源侧 `_budget_level`）。
 *
 * 阈值与源侧一致（<4096 light / <16384 high / 其余 extra_high）。刻意**不**把
 * `budget_tokens=0` 当 light：0 表示「没要求」，交给调用方的其它字段决定。
 */
export function effortLevelFromBudget(budget: unknown): TraeEffortLevel | '' {
  const tokens = Number(budget)
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens < 4096) return 'light'
  if (tokens < 16384) return 'high'
  return 'extra_high'
}

/**
 * 从请求体里读出客户端要的档位。
 *
 * 读取顺序（先具体后笼统）：`reasoning_effort` / `reasoningEffort` / `thinking_effort`
 * → `reasoning.effort` → `thinking.effort`|`thinking.level` → `thinking.budget_tokens`。
 */
export function requestedEffortLevel(body: unknown): TraeEffortLevel | '' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const obj = body as Record<string, any>
  for (const key of ['reasoning_effort', 'reasoningEffort', 'thinking_effort']) {
    const level = normalizeEffortLevel(obj[key])
    if (level) return level
  }
  const reasoning = obj['reasoning']
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const level = normalizeEffortLevel((reasoning as Record<string, any>)['effort'])
    if (level) return level
  }
  const thinking = obj['thinking']
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const t = thinking as Record<string, any>
    const level = normalizeEffortLevel(t['effort'] ?? t['level'])
    if (level) return level
    const byBudget = effortLevelFromBudget(t['budget_tokens'] ?? t['budgetTokens'])
    if (byBudget) return byBudget
  }
  return ''
}

/**
 * 上游目录里**声明**的档位名 → `TraeEffortLevel`。
 *
 * 必须先按**原生**档位名解释，再退回客户端别名。原因：`high` 既是上游原生档位名、
 * 又是客户端别名，而两者含义不同 —— 原生 `high` 是中间档，客户端 `high` 是最强档。
 *
 * 若统一走客户端别名表，`options: ['light','high','extra_high']` 会被读成
 * `['light','extra_high']`，于是 `clampEffortLevel` 认为「该模型没有中间档」，
 * 把 `medium` 的请求钳到 `light` —— 既静默降了档，又让「模型支持哪些档位」这个
 * **安全边界**失真（反过来还可能把上游没声明的档位发出去）。
 */
function declaredEffortLevel(value: unknown): TraeEffortLevel | '' {
  const text = String(value ?? '').trim().toLowerCase().replace(/ /g, '_')
  if (text === 'light' || text === 'high' || text === 'extra_high') return text
  // 兜底：容忍目录里写客户端别名（如 `medium`）
  return normalizeEffortLevel(text)
}

/**
 * 该模型支持哪些档位。
 *
 * `support_thinking` 不为真 → 返回空数组（= 该模型不接受档位，一个字都不要写进请求）。
 * 这是本模块的**安全边界**：上游没声明支持就绝不投递，避免给上游塞它不认识的字段。
 */
export function supportedEffortLevels(config: TraeReasoningEffortConfig | undefined | null): TraeEffortLevel[] {
  if (!config || typeof config !== 'object') return []
  if (!config.support_thinking) return []
  const options = Array.isArray(config.options) ? config.options : []
  const normalized = new Set(options.map((o) => declaredEffortLevel(o)).filter(Boolean))
  return TRAE_EFFORT_LEVELS.filter((level) => normalized.has(level))
}

/**
 * 客户端**原始**档位字面值（诊断用）。
 *
 * 为什么要单独暴露它：`requestedEffortLevel` 会把 `high` 归一成 `extra_high`，
 * 于是日志里只看得到归一化后的结果 —— **无法证明客户端到底发了什么词**。
 * 排查「我选了 high 怎么没变强」时，第一个要确认的就是「上游收到的原始值是什么」。
 * 优先级与 `requestedEffortLevel` 完全一致，保证两者指向同一个字段。
 */
export function rawRequestedEffort(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const obj = body as Record<string, any>
  for (const key of ['reasoning_effort', 'reasoningEffort', 'thinking_effort']) {
    const raw = String(obj[key] ?? '').trim()
    if (raw) return raw
  }
  const reasoning = obj['reasoning']
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const raw = String((reasoning as Record<string, any>)['effort'] ?? '').trim()
    if (raw) return raw
  }
  const thinking = obj['thinking']
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const t = thinking as Record<string, any>
    const raw = String(t['effort'] ?? t['level'] ?? '').trim()
    if (raw) return raw
    const budget = Number(t['budget_tokens'] ?? t['budgetTokens'])
    if (Number.isFinite(budget) && budget > 0) return `budget_tokens=${budget}`
  }
  return ''
}

/**
 * 客户端是否**明确要求关掉思考**（OpenAI 语义的 `reasoning_effort: "none"`）。
 *
 * 为什么必须与 `requestedEffortLevel` 分开判：上游档位表里没有「关」，所以 `none`
 * 在上游侧被降级成最低档 `light`（见 EFFORT_ALIASES）。但「上游只能降到最低档」与
 * 「客户端要看思考过程」是**两件事** —— 不能因为归一化出了 `light` 就把
 * `reasoning_content` 下发给一个明确说了不要思考的客户端。
 */
export function reasoningDisabledByRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const obj = body as Record<string, any>
  const isNone = (value: unknown): boolean => String(value ?? '').trim().toLowerCase() === 'none'
  for (const key of ['reasoning_effort', 'reasoningEffort', 'thinking_effort']) {
    if (isNone(obj[key])) return true
  }
  const reasoning = obj['reasoning']
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    if (isNone((reasoning as Record<string, any>)['effort'])) return true
  }
  const thinking = obj['thinking']
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const t = thinking as Record<string, any>
    if (isNone(t['effort']) || isNone(t['level'])) return true
  }
  return false
}

/**
 * 向下钳制：取 ≤ 请求档位的最高支持档；都超了就取最低支持档。
 * 请求档位为空或模型不支持任何档位 → ''（不施加）。
 */
export function clampEffortLevel(requested: TraeEffortLevel | '', supported: TraeEffortLevel[]): TraeEffortLevel | '' {
  if (!requested || supported.length === 0) return ''
  const rank = TRAE_EFFORT_LEVELS.indexOf(requested)
  const eligible = supported.filter((level) => TRAE_EFFORT_LEVELS.indexOf(level) <= rank)
  return eligible.length > 0 ? eligible[eligible.length - 1] : supported[0]
}

/**
 * 把档位写进 `custom_model`（返回新对象，不改入参）。
 *
 * **键名互斥**是硬约束：模型对象里已经有 `reasoning_effort_level` 就写它、删掉
 * `reasoning_effort`，反之亦然。两个同时出现时上游行为未定义（源侧同样只保留一个）。
 *
 * 返回 `[新 custom_model, 实际生效的档位]`；未施加时档位为 `''`。
 */
export function applyReasoningEffort(
  customModel: Record<string, any> | null | undefined,
  body: unknown
): [Record<string, any> | null | undefined, TraeEffortLevel | ''] {
  if (!customModel || typeof customModel !== 'object') return [customModel, '']
  const config = customModel['reasoning_effort_config'] as TraeReasoningEffortConfig | undefined
  const level = clampEffortLevel(requestedEffortLevel(body), supportedEffortLevels(config))
  if (!level) return [{ ...customModel }, '']
  const updated: Record<string, any> = { ...customModel }
  if ('reasoning_effort_level' in updated) {
    updated['reasoning_effort_level'] = level
    delete updated['reasoning_effort']
  } else {
    updated['reasoning_effort'] = level
    delete updated['reasoning_effort_level']
  }
  return [updated, level]
}
