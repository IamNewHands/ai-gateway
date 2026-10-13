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
 *  - OpenAI `reasoning_effort`：minimal/low/medium/high/xhigh…
 *  - Anthropic `thinking.effort` / `thinking.level`
 *  - 本网关自己的 `reasoningEffort`（见 src/types.ts Provider.reasoningEffort）
 */
const EFFORT_ALIASES: Record<string, TraeEffortLevel> = {
  none: 'light',
  minimal: 'light',
  min: 'light',
  low: 'light',
  light: 'light',
  medium: 'high',
  mid: 'high',
  normal: 'high',
  default: 'high',
  high: 'high',
  xhigh: 'high',
  'x-high': 'high',
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
 * 该模型支持哪些档位。
 *
 * `support_thinking` 不为真 → 返回空数组（= 该模型不接受档位，一个字都不要写进请求）。
 * 这是本模块的**安全边界**：上游没声明支持就绝不投递，避免给上游塞它不认识的字段。
 */
export function supportedEffortLevels(config: TraeReasoningEffortConfig | undefined | null): TraeEffortLevel[] {
  if (!config || typeof config !== 'object') return []
  if (!config.support_thinking) return []
  const options = Array.isArray(config.options) ? config.options : []
  const normalized = new Set(options.map((o) => normalizeEffortLevel(o)).filter(Boolean))
  return TRAE_EFFORT_LEVELS.filter((level) => normalized.has(level))
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
