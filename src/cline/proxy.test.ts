import { describe, it, expect } from 'vitest'
import { parseCooldownMs, fetchClineModels } from './proxy'

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