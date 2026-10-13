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
  requestedEffortLevel,
  supportedEffortLevels,
} from './reasoning-effort'

describe('normalizeEffortLevel：客户端别名 → 上游三档', () => {
  it('OpenAI / Anthropic 常见别名全部归一到 light|high|extra_high', () => {
    expect(normalizeEffortLevel('none')).toBe('light')
    expect(normalizeEffortLevel('minimal')).toBe('light')
    expect(normalizeEffortLevel('low')).toBe('light')
    expect(normalizeEffortLevel('medium')).toBe('high')
    expect(normalizeEffortLevel('high')).toBe('high')
    expect(normalizeEffortLevel('xhigh')).toBe('high')
    expect(normalizeEffortLevel('extra_high')).toBe('extra_high')
    expect(normalizeEffortLevel('max')).toBe('extra_high')
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
    expect(requestedEffortLevel({ reasoning: { effort: 'high' } })).toBe('high')
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
    expect(model!['reasoning_effort']).toBe('high')
  })

  it('custom_model 为空 → 原样返回，档位为空（Remote 的 auto 策略没有 custom_model）', () => {
    const [model, level] = applyReasoningEffort(null, { reasoning_effort: 'high' })
    expect(model).toBeNull()
    expect(level).toBe('')
  })
})
