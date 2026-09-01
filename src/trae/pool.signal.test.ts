import { describe, it, expect } from 'vitest'
import {
  parseConcurrency,
  typeConcurrencyHealth,
  isAccountConcurrencyIdle,
} from './pool'

describe('parseConcurrency：并发配置解析（账号级并发上限）', () => {
  it('未配置/非法值 → 关闭（<=1 表示单请求不并发但策略仍可用）', () => {
    expect(parseConcurrency(undefined)).toBe(0)
    expect(parseConcurrency(0)).toBe(0)
    expect(parseConcurrency(-1)).toBe(0)
    expect(parseConcurrency(NaN)).toBe(0)
  })
  it('合法正整数原样返回', () => {
    expect(parseConcurrency(1)).toBe(1)
    expect(parseConcurrency(4)).toBe(4)
  })
})

describe('typeConcurrencyHealth：按占用并发数判定账号可用性（acquire 决策）', () => {
  it('未配置并发(0) → 恒健康', () => {
    expect(typeConcurrencyHealth(0, 0)).toBe(true)
    expect(typeConcurrencyHealth(0, 9)).toBe(true)
  })
  it('已满 → 不可用', () => {
    expect(typeConcurrencyHealth(4, 4)).toBe(false)
  })
  it('占用 < 上限 → 可用', () => {
    expect(typeConcurrencyHealth(4, 3)).toBe(true)
    expect(typeConcurrencyHealth(4, 0)).toBe(true)
  })
})

describe('isAccountConcurrencyIdle：空闲会话回收判定（会话最后活跃距现在超 idle 阈值）', () => {
  const now = 1_000_000
  it('无活跃会话标记 → 视为非空闲（默认不回收）', () => {
    expect(isAccountConcurrencyIdle(undefined, 180_000, now)).toBe(false)
    expect(isAccountConcurrencyIdle({ activeSessions: 0 }, 180_000, now)).toBe(false)
  })
  it('在 idle 阈值内活跃 → 非空闲', () => {
    expect(isAccountConcurrencyIdle({ activeSessions: 2, lastActiveAt: now - 60_000 }, 180_000, now)).toBe(false)
  })
  it('超过 idle 阈值无活跃 → 空闲，可回收', () => {
    expect(isAccountConcurrencyIdle({ activeSessions: 1, lastActiveAt: now - 300_000 }, 180_000, now)).toBe(true)
  })
})