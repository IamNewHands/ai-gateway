/**
 * model-context-catalog.test.ts — 移植自 workbuddy2api 32a3c13
 * （internal/upstream/context_catalog_test.go + internal/server/handler_context_length_test.go）。
 *
 * 核心不变量：context_length 零值不再透出假 131072；未知落 1M；
 * max_output_tokens 未知即省略（绝不编造输出上限）。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_CATALOG,
  contextWindowListing,
  maxOutputTokensListing,
} from './model-context-catalog'
import { TRAE_STATIC_MODELS } from './trae/constants'
import { toOpenAIModelEntries } from './trae/admin'

describe('contextWindowListing：三级查找', () => {
  it('远端正数权威——无视知识表直接透出（含与知识表不同的值、远端小值也不「纠正」）', () => {
    expect(contextWindowListing('glm-5.2', 262144)).toBe(262144)
    expect(contextWindowListing('glm-5.2', 32000)).toBe(32000)
    // 表外模型 + 远端值 → 也用远端值，不落 1M
    expect(contextWindowListing('totally-unknown-model', 999)).toBe(999)
  })

  it('远端为 0/负数/非有限值 → 视为无远端值，转查知识表', () => {
    expect(contextWindowListing('glm-5.1', 0)).toBe(200000)
    expect(contextWindowListing('glm-5.1', -1)).toBe(200000)
    expect(contextWindowListing('glm-5.1', Number.NaN)).toBe(200000)
    expect(contextWindowListing('glm-5.1', undefined)).toBe(200000)
  })

  it('知识表命中：按模型补齐真实量级（上游 context_catalog_test 同款用例）', () => {
    const cases: Array<[string, number, string]> = [
      ['glm-5.2', 1000000, 'fork 实测 CN 1M'],
      ['glm-5.1', 200000, 'fork 实测 200K'],
      ['kimi-k2.7', 256000, 'fork 实测 256K'],
      ['minimax-m3', 512000, 'fork 实测 512K'],
      ['deepseek-v4-pro', 1000000, 'fork 实测 1M'],
      ['deepseek-v4.1-flash', 1000000, '实测外推 + models.dev'],
      ['hy3', 192000, 'fork 实测 192K'],
      ['gpt-6-astra', 1050000, 'models.dev'],
      ['gpt-5.3-codex', 400000, 'models.dev'],
      ['auto', 168000, 'fork global 外推'],
    ]
    for (const [model, want, source] of cases) {
      expect(contextWindowListing(model, 0), `${model} (${source})`).toBe(want)
    }
  })

  it('表未命中 → 回落 1_000_000（不是 131072）', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000)
    expect(contextWindowListing('totally-unknown-model')).toBe(1_000_000)
    expect(contextWindowListing('totally-unknown-model', 0)).toBe(1_000_000)
    expect(contextWindowListing('')).toBe(1_000_000)
    expect(contextWindowListing('  ')).toBe(1_000_000)
  })

  it('匹配大小写不敏感，且支持最长边界前缀（trae 的 -Official / __dev 后缀）', () => {
    // trae 静态表里的混合大小写 id
    expect(contextWindowListing('DeepSeek-V4-Flash-Official')).toBe(1_000_000)
    expect(contextWindowListing('glm-5.2')).toBe(1_000_000)
    // 最长前缀优先：glm-5.3-flash 不得被 glm-5.3 抢走（两者同值，用长度断言表结构）
    expect(contextWindowListing('glm-5.3-flash')).toBe(MODEL_CONTEXT_CATALOG['glm-5.3-flash'].context)
    // 下划线边界
    expect(contextWindowListing('glm-5.2__dev')).toBe(1_000_000)
  })

  it('不做任意位置子串匹配：形近的未知模型仍落 1M，不被伪装成已知模型', () => {
    // 'glm-5' 不是表 key，'glm-50' 也不得被 'glm-5.1'/'glm-5.2' 命中
    expect(contextWindowListing('glm-50')).toBe(1_000_000)
    expect(contextWindowListing('autofoo')).toBe(1_000_000)
    expect(contextWindowListing('glm-5.30')).toBe(1_000_000)
  })

  it('知识表自身不含 131072 作为 context（回归锚点：假兜底已退役）', () => {
    for (const [model, cap] of Object.entries(MODEL_CONTEXT_CATALOG)) {
      expect(cap.context, `${model} context=131072 是旧假兜底泄漏`).not.toBe(131072)
    }
  })

  it('知识表完整性：context 必为正、maxOutput 不得为负', () => {
    for (const [model, cap] of Object.entries(MODEL_CONTEXT_CATALOG)) {
      expect(cap.context, `${model} context 必须为正`).toBeGreaterThan(0)
      expect(cap.maxOutput, `${model} maxOutput 必须 >= 0`).toBeGreaterThanOrEqual(0)
    }
  })

  it('知识表为 27 条（照抄上游 contextCapFallback）', () => {
    expect(Object.keys(MODEL_CONTEXT_CATALOG)).toHaveLength(27)
  })
})

describe('maxOutputTokensListing：未知返回 null（绝不编造输出上限）', () => {
  it('远端正数权威', () => {
    expect(maxOutputTokensListing('glm-5.2', 64000)).toBe(64000)
    expect(maxOutputTokensListing('totally-unknown-model', 123)).toBe(123)
  })

  it('知识表命中', () => {
    expect(maxOutputTokensListing('deepseek-v4-pro', 0)).toBe(384000)
    expect(maxOutputTokensListing('glm-5.1')).toBe(131072)
  })

  it('表条目存在但输出上限未知（maxOutput=0）→ null（省略字段）', () => {
    expect(maxOutputTokensListing('auto', 0)).toBeNull()
    expect(maxOutputTokensListing('kimi-k2.8-preview', 0)).toBeNull()
  })

  it('完全未知 → null（没有 1M 兜底，与 context_length 口径刻意不同）', () => {
    expect(maxOutputTokensListing('totally-unknown-model')).toBeNull()
    expect(maxOutputTokensListing('')).toBeNull()
    expect(maxOutputTokensListing('glm-50')).toBeNull()
  })
})

describe('trae 两处消费者：不再出现 131072', () => {
  it('TRAE_STATIC_MODELS 每条的 context_length 都不是 131072，且 max_output_tokens 只在已知时出现', () => {
    expect(TRAE_STATIC_MODELS.length).toBeGreaterThan(0)
    for (const m of TRAE_STATIC_MODELS) {
      expect(m.context_length, `${m.id} 不得为旧假兜底 131072`).not.toBe(131072)
      expect(m.context_length).toBe(contextWindowListing(m.id))
      if ('max_output_tokens' in m) {
        expect(m.max_output_tokens).toBe(maxOutputTokensListing(m.id))
      }
    }
  })

  it('TRAE_STATIC_MODELS 中表外模型落 1M（不是 131072）', () => {
    const unknown = TRAE_STATIC_MODELS.find((m) => m.id === 'browser_use_subagent')
    expect(unknown).toBeDefined()
    expect(unknown!.context_length).toBe(1_000_000)
  })

  it('TRAE_STATIC_MODELS 中真实命中的 id 取到表值（含 -Official / -code 前缀后缀）', () => {
    const byId = new Map(TRAE_STATIC_MODELS.map((m) => [m.id, m.context_length]))
    expect(byId.get('glm-5.2')).toBe(1_000_000)
    expect(byId.get('DeepSeek-V4-Pro')).toBe(1_000_000)
    expect(byId.get('DeepSeek-V4-Flash')).toBe(1_000_000)
    expect(byId.get('DeepSeek-V4-Flash-Official')).toBe(1_000_000)
    expect(byId.get('kimi-k3')).toBe(1_048_576)
    expect(byId.get('kimi-k2.6')).toBe(256_000)
    expect(byId.get('kimi-k2.7-code')).toBe(256_000)
    expect(byId.get('minimax-m3')).toBe(512_000)
  })

  it('toOpenAIModelEntries：远端零值走知识表，未知落 1M，输出上限未知则省略字段', () => {
    const entries = toOpenAIModelEntries([
      { id: 'glm-5.2', name: 'GLM', contextWindow: 0, maxTokens: 0 },
      { id: 'glm-5.1', name: 'GLM', contextWindow: 300000, maxTokens: 50000 },
      { id: 'totally-unknown-model', name: 'X', contextWindow: 0, maxTokens: 0 },
    ])
    expect(entries[0].context_length).toBe(1_000_000)
    expect(entries[0].max_output_tokens).toBe(131072)
    // 远端权威
    expect(entries[1].context_length).toBe(300000)
    expect(entries[1].max_output_tokens).toBe(50000)
    // 表外 → 1M；输出上限未知 → 字段缺席（不编造）
    expect(entries[2].context_length).toBe(1_000_000)
    expect('max_output_tokens' in entries[2]).toBe(false)
    for (const e of entries) expect(e.context_length).not.toBe(131072)
  })
})
