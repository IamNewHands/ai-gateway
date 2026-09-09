import { describe, expect, it } from 'vitest'
import {
  canonicalModel,
  modelCatalog,
  modelTone,
  estimatePromptTokens,
  countPromptTokenClasses,
  modelPromptCharacterLimit,
  modelMaxInputTokens,
  codexModelCatalog,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT,
} from './models'

describe('M365 model profiles', () => {
  it('defaults to the low-latency GPT-5.6 Sol model', () => {
    expect(canonicalModel(undefined)).toBe('gpt-5.6-sol')
    expect(canonicalModel(null)).toBe('gpt-5.6-sol')
    expect(canonicalModel('')).toBe('gpt-5.6-sol')
  })

  it('canonicalizes supported aliases without accepting historical unsupported models', () => {
    expect(canonicalModel(' GPT-5.6 ')).toBe('gpt-5.6-sol')
    expect(canonicalModel('m365-copilot')).toBe('gpt-5.6-sol')
    expect(canonicalModel('gpt-5.5-think-deeper')).toBe('gpt-5.5-reasoning')
    expect(canonicalModel('gpt-5.6-think-deeper')).toBe('gpt-5.6-reasoning')
    expect(canonicalModel('claude')).toBe('claude-sonnet')
    expect(canonicalModel('claude-sonnet-5')).toBe('claude-sonnet')
    expect(() => canonicalModel('gpt-4o')).toThrow('UNSUPPORTED_MODEL')
    expect(() => canonicalModel(56)).toThrow('UNSUPPORTED_MODEL')
  })

  it('maps GPT models and reasoning effort to verified ChatHub tones', () => {
    expect(modelTone('gpt-5.5', 'low')).toBe('Gpt_5_5_Chat')
    expect(modelTone('gpt-5.5', 'medium')).toBe('Gpt_5_5_Reasoning')
    expect(modelTone('gpt-5.5-reasoning', 'none')).toBe('Gpt_5_5_Reasoning')
    expect(modelTone('gpt-5.6-sol')).toBe('Gpt_5_6_Chat')
    expect(modelTone('gpt-5.6-sol', 'minimal')).toBe('Gpt_5_6_Chat')
    expect(modelTone('gpt-5.6-sol', 'high')).toBe('Gpt_5_6_Reasoning')
    expect(modelTone('gpt-5.6-reasoning', 'low')).toBe('Gpt_5_6_Reasoning')
    expect(modelTone('gpt-6-astra', 'none')).toBe('Gpt_6_Astra')
  })

  it('maps Claude models and malformed effort values deterministically', () => {
    expect(modelTone('claude-sonnet', 'low')).toBe('Claude_Sonnet')
    expect(modelTone('claude-sonnet', 'high')).toBe('Claude_Sonnet_Reasoning')
    expect(modelTone('claude-sonnet', { effort: 'high' })).toBe('Claude_Sonnet')
    expect(modelTone('claude-sonnet-reasoning', 'none')).toBe('Claude_Sonnet_Reasoning')
    expect(() => modelTone('gpt-4o')).toThrow('UNSUPPORTED_MODEL')
  })

  it('publishes only the canonical M365 model catalog', () => {
    expect(modelCatalog().map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.5-reasoning',
      'gpt-5.6-sol',
      'gpt-5.6-reasoning',
      'gpt-6-astra',
      'claude-sonnet',
      'claude-sonnet-reasoning',
    ])
  })

  it('calculates prompt character and token limits accurately', () => {
    expect(modelPromptCharacterLimit('gpt-5.6-sol')).toBe(288_000)
    expect(modelMaxInputTokens('gpt-5.6-sol')).toBe(96_000)
    expect(modelMaxInputTokens('claude-sonnet')).toBe(136_000)
    expect(CODEX_AUTO_COMPACT_TOKEN_LIMIT).toBe(90_000)
  })

  it('counts token classes and estimates prompt tokens correctly', () => {
    const text = 'Hello world! 你好世界 🚀'
    const counts = countPromptTokenClasses(text)
    expect(counts.asciiWordCharacters).toBe(10) // 'Helloworld'
    expect(counts.asciiSyntaxCharacters).toBe(1) // '!'
    expect(counts.nonAsciiCharacters).toBe(4) // '你好世界'
    expect(counts.emojiCharacters).toBe(1) // '🚀'

    const estimated = estimatePromptTokens(text)
    // ceil(10/4) + ceil(1/2) + 4 + 1*2 = 3 + 1 + 4 + 2 = 10
    expect(estimated).toBe(10)
  })

  it('generates codex model catalog with responses lite detection', () => {
    const legacy = codexModelCatalog('0.150.0')
    expect(legacy.models[0].use_responses_lite).toBe(false)
    expect(legacy.models[0].tool_mode).toBe('direct')

    const modern = codexModelCatalog('0.152.0')
    expect(modern.models[0].use_responses_lite).toBe(true)
    expect(modern.models[0].tool_mode).toBe('code_mode_only')
    expect(modern.models[0].multi_agent_version).toBe('v2')
  })
})
