import { describe, it, expect } from 'vitest'
import { parseCooldownMs, fetchClineModels, isRunawayReasoningCutoff } from './proxy'

describe('Cline 冷却时长解析（item3）', () => {
  it('解析 "Try again in 2h 51m" 为毫秒', () => {
    expect(parseCooldownMs('Try again in 2h 51m')).toBe((2 * 3600 + 51 * 60) * 1000)
  })
  it('解析 "30min" / "15s"', () => {
    expect(parseCooldownMs('30m')).toBe(30 * 60 * 1000)
    expect(parseCooldownMs('Try again in 30m')).toBe(30 * 60 * 1000)
    expect(parseCooldownMs('try again in 15 seconds')).toBe(15 * 1000)
  })
  it('解析 "1 hour"', () => {
    expect(parseCooldownMs('Try again in 1 hour')).toBe(3600 * 1000)
  })
  it('无匹配返回 null', () => {
    expect(parseCooldownMs('please wait a moment')).toBeNull()
    expect(parseCooldownMs('')).toBeNull()
    expect(parseCooldownMs(null as unknown as string)).toBeNull()
  })
  it('超过 6h 封顶（item3 防止账号被过久冻结）', () => {
    const capped = parseCooldownMs('Try again in 10h')
    expect(capped).not.toBeNull()
    expect(capped as number).toBe(6 * 3600 * 1000)
  })
})

describe('Cline 模型清单（回归保护）', () => {
  it('fetchClineModels 返回 OpenAI 模型列表结构', () => {
    const r = fetchClineModels()
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.models)).toBe(true)
    expect(r.models.length).toBeGreaterThan(0)
    expect(r.models[0]).toHaveProperty('id')
  })
})

describe('推理空转截断判定 isRunawayReasoningCutoff', () => {
  it('length 截断且无正文/无工具调用 → 判定为空转', () => {
    expect(isRunawayReasoningCutoff('', [], 'length')).toBe(true)
    expect(isRunawayReasoningCutoff('   \n\n', [], 'length')).toBe(true) // 仅空白
  })
  it('length 截断但已有正文 → 不判空转（是正常被截断的长回答）', () => {
    expect(isRunawayReasoningCutoff('有正文内容', [], 'length')).toBe(false)
    expect(isRunawayReasoningCutoff('代码/正文', [], 'length')).toBe(false)
  })
  it('length 截断但已有工具调用 → 不判空转', () => {
    expect(isRunawayReasoningCutoff('', [{ id: 'call_1' }], 'length')).toBe(false)
  })
  it('非 length 结束原因 → 一律不判空转', () => {
    expect(isRunawayReasoningCutoff('', [], 'stop')).toBe(false)
    expect(isRunawayReasoningCutoff('', [], 'tool_calls')).toBe(false)
    expect(isRunawayReasoningCutoff('', [], '')).toBe(false)
  })
})
