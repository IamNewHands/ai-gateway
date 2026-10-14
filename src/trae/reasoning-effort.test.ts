/**
 * reasoning-effort.test.ts — 思考强度 → TRAE 原生档位。
 *
 * 这层是「切到 Remote 能调思考强度」的全部依据，所以三条边界必须钉住：
 *  1. **向下钳制**：绝不发上游没声明的档位（越级下发会被上游忽略或报错）；
 *  2. **键名互斥**：`reasoning_effort_level` 与 `reasoning_effort` 只写一个；
 *  3. **不支持就不写**：模型没声明 `support_thinking` 时一个键都不加。
 */
import { describe, expect, it } from 'vitest'
import {
  applyReasoningEffort,
  clampEffortLevel,
  effortLevelFromBudget,
  normalizeEffortLevel,
  rawRequestedEffort,
  reasoningDisabledByRequest,
  requestedEffortLevel,
  supportedEffortLevels,
} from './reasoning-effort'

describe('normalizeEffortLevel：客户端别名 → 上游三档', () => {
  it('OpenAI / Anthropic 常见别名全部归一到 light|high|extra_high', () => {
    expect(normalizeEffortLevel('none')).toBe('light')
    expect(normalizeEffortLevel('minimal')).toBe('light')
    expect(normalizeEffortLevel('low')).toBe('light')
    expect(normalizeEffortLevel('medium')).toBe('high')
    expect(normalizeEffortLevel('extra_high')).toBe('extra_high')
    expect(normalizeEffortLevel('max')).toBe('extra_high')
  })

  /**
   * 回归点（2026-10-14 修）：DeepSeek Harness 的本地 profile 给
   * `trae/deepseek-v4.1-flash` 声明的档位就是 low / medium / high 三档
   *（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `reasoningEfforts`），
   * 所以这三个词**必须**落到三个不同的上游档。
   *
   * 旧映射把 medium 与 high 都折成 high，等于把 `extra_high` 从客户端彻底藏起来 ——
   * 用户以为选到了最强档，实际发出去的还是中间档。
   */
  it('DSH 三档 low/medium/high 一一对应到 light/high/extra_high（不塌陷）', () => {
    expect(normalizeEffortLevel('low')).toBe('light')
    expect(normalizeEffortLevel('medium')).toBe('high')
    expect(normalizeEffortLevel('high')).toBe('extra_high')
    // 三档互不相同 = 「客户端能选几档，上游就收到几档」的充要条件。
    expect(new Set([
      normalizeEffortLevel('low'),
      normalizeEffortLevel('medium'),
      normalizeEffortLevel('high'),
    ]).size).toBe(3)
  })

  it('xhigh / very_high 与 high 同义，都归到最强档', () => {
    expect(normalizeEffortLevel('xhigh')).toBe('extra_high')
    expect(normalizeEffortLevel('very_high')).toBe('extra_high')
  })

  /**
   * `default` 必须**不**被识别为档位：DSH 选「default」时根本不下发字段
   *（`PROVIDER_DEFAULT_REASONING_VALUE`）。若我们把它当成一个具体档位，
   * 「默认」就会被静默解释成某个强度，面板默认档也随之失效。
   */
  it('"default" 不是档位 → 空串，交给面板默认档决定', () => {
    expect(normalizeEffortLevel('default')).toBe('')
  })

  it('大小写与空格不敏感（" Extra-High " → extra_high）', () => {
    expect(normalizeEffortLevel(' Extra-High ')).toBe('extra_high')
  })

  it('不认识的值返回空串——不猜，避免把一个未知档位硬塞给上游', () => {
    expect(normalizeEffortLevel('turbo')).toBe('')
    expect(normalizeEffortLevel('')).toBe('')
    expect(normalizeEffortLevel(null)).toBe('')
    expect(normalizeEffortLevel(undefined)).toBe('')
  })
})

describe('effortLevelFromBudget：Anthropic budget_tokens 折算', () => {
  it('按阈值分档（<4096 light / <16384 high / 其余 extra_high）', () => {
    expect(effortLevelFromBudget(1024)).toBe('light')
    expect(effortLevelFromBudget(4095)).toBe('light')
    expect(effortLevelFromBudget(4096)).toBe('high')
    expect(effortLevelFromBudget(16383)).toBe('high')
    expect(effortLevelFromBudget(16384)).toBe('extra_high')
  })

  it('0 / 负数 / 非法值 → 空串（0 表示「没要求」，不是 light）', () => {
    expect(effortLevelFromBudget(0)).toBe('')
    expect(effortLevelFromBudget(-1)).toBe('')
    expect(effortLevelFromBudget('abc')).toBe('')
  })
})

describe('requestedEffortLevel：从请求体读档位', () => {
  it('读 OpenAI 的 reasoning_effort', () => {
    expect(requestedEffortLevel({ reasoning_effort: 'medium' })).toBe('high')
  })

  it('读 camelCase reasoningEffort 与 thinking_effort', () => {
    expect(requestedEffortLevel({ reasoningEffort: 'max' })).toBe('extra_high')
    expect(requestedEffortLevel({ thinking_effort: 'low' })).toBe('light')
  })

  it('读 reasoning.effort', () => {
    expect(requestedEffortLevel({ reasoning: { effort: 'high' } })).toBe('extra_high')
  })

  it('读 Anthropic thinking.effort / thinking.level', () => {
    expect(requestedEffortLevel({ thinking: { effort: 'extra_high' } })).toBe('extra_high')
    expect(requestedEffortLevel({ thinking: { level: 'low' } })).toBe('light')
  })

  it('thinking.budget_tokens 折算（没有 effort 时）', () => {
    expect(requestedEffortLevel({ thinking: { budget_tokens: 8192 } })).toBe('high')
  })

  it('非对象 / 都没有 → 空串', () => {
    expect(requestedEffortLevel(null)).toBe('')
    expect(requestedEffortLevel('high')).toBe('')
    expect(requestedEffortLevel({ temperature: 0.5 })).toBe('')
  })
})

describe('supportedEffortLevels：模型声明的档位', () => {
  it('support_thinking 不为真 → 空数组（安全边界：不支持就一个键都不写）', () => {
    expect(supportedEffortLevels({ options: ['light', 'high'] })).toEqual([])
    expect(supportedEffortLevels({ support_thinking: false, options: ['light'] })).toEqual([])
    expect(supportedEffortLevels(null)).toEqual([])
  })

  it('只保留可识别档位，并按强度排序（上游顺序可能乱）', () => {
    expect(supportedEffortLevels({ support_thinking: true, options: ['high', 'bogus', 'light'] }))
      .toEqual(['light', 'high'])
  })

  it('接受客户端别名形式的声明（medium → high）', () => {
    expect(supportedEffortLevels({ support_thinking: true, options: ['low', 'medium'] }))
      .toEqual(['light', 'high'])
  })

  /**
   * 回归点（2026-10-14）：目录里声明的 `high` 是**上游原生**档位（中间档），
   * 不能被当成客户端别名 `high`（最强档）折成 `extra_high`。
   *
   * 折错的后果不只是档位失真：`supportedEffortLevels` 是钳制的输入，也是「哪些档位
   * 可以发给上游」的安全边界。把它读成 `['light','extra_high']` 之后，`medium` 的请求
   * 会被钳到 `light`（实测踩过），而反过来也可能让上游没声明的档位被放行。
   */
  it('原生档位名优先于客户端别名：声明 ["light","high","extra_high"] 就是三档全支持', () => {
    expect(supportedEffortLevels({
      support_thinking: true,
      options: ['light', 'high', 'extra_high'],
    })).toEqual(['light', 'high', 'extra_high'])
    // 三档都在 → `medium`（客户端中间档）应钳到原生的 `high`，而不是掉到 `light`
    expect(clampEffortLevel('high', supportedEffortLevels({
      support_thinking: true,
      options: ['light', 'high', 'extra_high'],
    }))).toBe('high')
  })

  it('声明只有原生 light/high 时，最强档请求被钳到 high（绝不越级到 extra_high）', () => {
    const supported = supportedEffortLevels({ support_thinking: true, options: ['light', 'high'] })
    expect(supported).toEqual(['light', 'high'])
    expect(clampEffortLevel('extra_high', supported)).toBe('high')
  })
})

describe('clampEffortLevel：向下钳制', () => {
  const supported = ['light', 'high'] as const

  it('请求档位在支持集内 → 原样', () => {
    expect(clampEffortLevel('high', [...supported])).toBe('high')
  })

  it('请求超过最高支持档 → 取最高支持档（绝不越级）', () => {
    expect(clampEffortLevel('extra_high', [...supported])).toBe('high')
  })

  it('请求低于最低支持档 → 取最低支持档', () => {
    expect(clampEffortLevel('light', ['high', 'extra_high'])).toBe('high')
  })

  it('未请求 / 无支持档 → 空串', () => {
    expect(clampEffortLevel('', [...supported])).toBe('')
    expect(clampEffortLevel('high', [])).toBe('')
  })
})

describe('applyReasoningEffort：写进 custom_model', () => {
  const config = { support_thinking: true, options: ['light', 'high', 'extra_high'] }

  it('已有 reasoning_effort_level 时只写它，并删掉 reasoning_effort（键名互斥）', () => {
    const [model, level] = applyReasoningEffort(
      { reasoning_effort_level: 'light', reasoning_effort: 'light', reasoning_effort_config: config },
      { reasoning_effort: 'extra_high' }
    )
    expect(level).toBe('extra_high')
    expect(model!['reasoning_effort_level']).toBe('extra_high')
    expect('reasoning_effort' in model!).toBe(false)
  })

  it('没有 reasoning_effort_level 时写 reasoning_effort，并删掉 level（互斥的另一半）', () => {
    const [model, level] = applyReasoningEffort(
      { reasoning_effort_config: config },
      { reasoning_effort: 'low' }
    )
    expect(level).toBe('light')
    expect(model!['reasoning_effort']).toBe('light')
    expect('reasoning_effort_level' in model!).toBe(false)
  })

  it('模型不支持思考 → 不施加、不改任何键', () => {
    const [model, level] = applyReasoningEffort(
      { reasoning_effort_config: { support_thinking: false, options: ['high'] } },
      { reasoning_effort: 'high' }
    )
    expect(level).toBe('')
    expect('reasoning_effort' in model!).toBe(false)
    expect('reasoning_effort_level' in model!).toBe(false)
  })

  it('客户端没请求档位 → 不施加（面板默认档由调用方补进请求体）', () => {
    const [, level] = applyReasoningEffort({ reasoning_effort_config: config }, {})
    expect(level).toBe('')
  })

  it('不改入参（返回副本）', () => {
    const original = { reasoning_effort_config: config }
    const [model] = applyReasoningEffort(original, { reasoning_effort: 'high' })
    expect('reasoning_effort' in original).toBe(false)
    expect(model!['reasoning_effort']).toBe('extra_high')
  })

  it('custom_model 为空 → 原样返回，档位为空（Remote 的 auto 策略没有 custom_model）', () => {
    const [model, level] = applyReasoningEffort(null, { reasoning_effort: 'high' })
    expect(model).toBeNull()
    expect(level).toBe('')
  })
})

describe('rawRequestedEffort：客户端真发的那个词（诊断用）', () => {
  it('原样返回，不做归一化 —— 证明「上游收到的原始值」', () => {
    expect(rawRequestedEffort({ reasoning_effort: 'high' })).toBe('high')
    expect(rawRequestedEffort({ reasoning_effort: 'MEDIUM' })).toBe('MEDIUM')
    expect(rawRequestedEffort({ reasoning: { effort: 'low' } })).toBe('low')
    expect(rawRequestedEffort({ thinking: { level: 'extra_high' } })).toBe('extra_high')
  })

  it('只有 budget_tokens 时回报预算本身（没有档位字面值可报）', () => {
    expect(rawRequestedEffort({ thinking: { budget_tokens: 8192 } })).toBe('budget_tokens=8192')
  })

  it('没有档位字段 → 空串；无法识别的值也要回报（区分「没发」与「发了不认」）', () => {
    expect(rawRequestedEffort({})).toBe('')
    expect(rawRequestedEffort(null)).toBe('')
    expect(rawRequestedEffort({ reasoning_effort: 'turbo' })).toBe('turbo')
  })
})

describe('reasoningDisabledByRequest：客户端是否明确说「不要思考」', () => {
  it('reasoning_effort: none → 视为关掉（各字段名都认）', () => {
    expect(reasoningDisabledByRequest({ reasoning_effort: 'none' })).toBe(true)
    expect(reasoningDisabledByRequest({ reasoningEffort: 'NONE' })).toBe(true)
    expect(reasoningDisabledByRequest({ thinking_effort: 'none' })).toBe(true)
    expect(reasoningDisabledByRequest({ reasoning: { effort: 'none' } })).toBe(true)
    expect(reasoningDisabledByRequest({ thinking: { level: 'none' } })).toBe(true)
  })

  /**
   * 回归点：`none` 会被归一化成最低档 `light`，所以**不能**用
   * `requestedEffortLevel(body) !== ''` 来判断「要不要下发 reasoning_content」——
   * 那会把「不要思考」误读成「要一点点思考」，给一个明确拒绝了思考的客户端塞满
   * reasoning_content。两个判定必须各自独立成立。
   */
  it('none 归一化成 light，但「关掉」的判定独立成立（两者不可互相替代）', () => {
    const body = { reasoning_effort: 'none' }
    expect(requestedEffortLevel(body)).toBe('light')
    expect(reasoningDisabledByRequest(body)).toBe(true)
  })

  it('其它档位 / 未指定 / 只给预算 → 都不是「关掉」', () => {
    expect(reasoningDisabledByRequest({ reasoning_effort: 'low' })).toBe(false)
    expect(reasoningDisabledByRequest({ reasoning_effort: 'high' })).toBe(false)
    expect(reasoningDisabledByRequest({})).toBe(false)
    expect(reasoningDisabledByRequest(null)).toBe(false)
    expect(reasoningDisabledByRequest({ thinking: { budget_tokens: 8192 } })).toBe(false)
  })
})
