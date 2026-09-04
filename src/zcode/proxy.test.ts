/**
 * proxy.test.ts — ZCode 模块单元测试
 */
import { describe, it, expect } from 'vitest'
import { isZcodeProvider, isZcodeAnthropic, buildZcodeHeaders, ZCODE_MODELS, ZCODE_PROVIDER_ID, zcodePreset } from './proxy'
import type { Provider } from '../types'

describe('ZCode 提供商判断', () => {
  it('isZcodeProvider 精确匹配', () => {
    expect(isZcodeProvider(ZCODE_PROVIDER_ID)).toBe(true)
    expect(isZcodeProvider('zcode')).toBe(true)
    expect(isZcodeProvider('trae')).toBe(false)
    expect(isZcodeProvider('opencode')).toBe(false)
    expect(isZcodeProvider('')).toBe(false)
  })

  it('isZcodeAnthropic 判断 Anthropic 协议', () => {
    const openaiProv: Provider = {
      id: 'zcode', name: 'ZCode', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiType: 'openai', apiKeys: [], models: [], enabled: true,
      createdAt: '', updatedAt: '',
    }
    expect(isZcodeAnthropic(openaiProv)).toBe(false)

    const anthropicProv: Provider = {
      ...openaiProv,
      apiType: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    }
    expect(isZcodeAnthropic(anthropicProv)).toBe(true)
  })

  it('非 zcode 的 provider 返回 false', () => {
    const traeProv: Provider = {
      id: 'trae', name: 'Trae', baseUrl: 'https://trae-api-cn.mchost.guru',
      apiType: 'openai', apiKeys: [], models: [], enabled: true,
      createdAt: '', updatedAt: '',
    }
    expect(isZcodeAnthropic(traeProv)).toBe(false)
  })
})

describe('ZCode 身份头构造', () => {
  it('buildZcodeHeaders 返回正确的身份头', () => {
    const headers = buildZcodeHeaders()
    expect(headers).toHaveProperty('User-Agent')
    expect(headers['User-Agent']).toMatch(/^ZCode\//)
    expect(headers).toHaveProperty('X-Title', 'Z Code')
    expect(headers).toHaveProperty('HTTP-Referer', 'https://zcode.z.ai')
    expect(headers).toHaveProperty('X-ZCode-Proxy', 'ai-gateway')
  })
})

describe('ZCode 模型清单', () => {
  it('ZCODE_MODELS 包含主要 GLM 模型', () => {
    expect(ZCODE_MODELS.length).toBeGreaterThan(0)
    expect(ZCODE_MODELS).toContain('glm-5.3')
    expect(ZCODE_MODELS).toContain('glm-5.2')
    expect(ZCODE_MODELS).toContain('glm-4.7')
    expect(ZCODE_MODELS).toContain('codegeex-4')
  })

  it('模型 ID 不重复', () => {
    const unique = new Set(ZCODE_MODELS)
    expect(unique.size).toBe(ZCODE_MODELS.length)
  })
})

describe('ZCode 预设模板', () => {
  it('bigmodel 预设使用 Coding Plan 端点', () => {
    const preset = zcodePreset('bigmodel')
    expect(preset.id).toBe('zcode')
    expect(preset.baseUrl).toContain('open.bigmodel.cn')
    expect(preset.baseUrl).toContain('/api/coding/paas/v4')
    expect(preset.apiType).toBe('openai')
    expect(preset.models.length).toBeGreaterThan(0)
  })

  it('zai 预设使用 Z.AI 端点', () => {
    const preset = zcodePreset('zai')
    expect(preset.id).toBe('zcode')
    expect(preset.baseUrl).toContain('api.z.ai')
    expect(preset.baseUrl).toContain('/api/coding/paas/v4')
    expect(preset.apiType).toBe('openai')
    expect(preset.models.length).toBeGreaterThan(0)
  })

  it('默认预设为 bigmodel', () => {
    const preset = zcodePreset()
    expect(preset.baseUrl).toContain('open.bigmodel.cn')
  })
})