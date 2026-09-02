import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { qoderExpiryUnix } from '../oauth'

const DAY = 24 * 60 * 60
const DAY_MS = DAY * 1000

describe('qoderExpiryUnix（对齐 keirouter qoderExpiresIn：秒语义）', () => {
  let now: number

  beforeEach(() => {
    now = 1_700_000_000_000 // 固定一个 epoch ms
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires_in 单位是秒：2592000s（30 天）→ now + 2592000*1000 ms', () => {
    const unix = qoderExpiryUnix({ expires_in: 30 * DAY })
    expect(unix).toBe(now + 30 * DAY_MS)
  })

  it('expires_in 低于 1 天的值被忽略，回退 30 天', () => {
    expect(qoderExpiryUnix({ expires_in: 60 })).toBe(now + 30 * DAY_MS)
    expect(qoderExpiryUnix({ expires_in: 3600 })).toBe(now + 30 * DAY_MS)
  })

  it('缺省无 expires 字段 → 30 天', () => {
    expect(qoderExpiryUnix({})).toBe(now + 30 * DAY_MS)
  })

  it('expires_at 为 number（毫秒时间戳）优先，且要求剩余 > 1 天', () => {
    const atMs = now + 15 * DAY_MS
    expect(qoderExpiryUnix({ expires_at: atMs })).toBe(now + 15 * DAY_MS)
    // 剩余 < 1 天的 expires_at 被忽略 → 回退 expires_in
    expect(qoderExpiryUnix({ expires_at: now + 3600_000, expires_in: 20 * DAY })).toBe(now + 20 * DAY_MS)
  })

  it('expires_at 为 RFC3339 字符串优先', () => {
    const atMs = now + 12 * DAY_MS
    const atStr = new Date(atMs).toISOString()
    expect(qoderExpiryUnix({ expires_at: atStr, expires_in: 20 * DAY })).toBe(now + 12 * DAY_MS)
  })

  it('expires_at 非法字符串被忽略', () => {
    expect(qoderExpiryUnix({ expires_at: 'not-a-date', expires_in: 25 * DAY })).toBe(now + 25 * DAY_MS)
  })
})