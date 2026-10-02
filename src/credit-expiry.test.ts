/**
 * credit-expiry.test.ts — 「7 天内到期积分优先」共享判定单测。
 *
 * 需求背景（2026-09-28）：多账号池挑号原按积分高低；积分带到期时间，需优先消耗
 * 7 天内到期的积分，窗口内没有才回落积分高低规则。
 */
import { describe, it, expect } from 'vitest'
import {
  CREDIT_EXPIRY_WINDOW_MS,
  formatCstWallClock,
  packageExpiryEntry,
  parseCstWallClock,
  soonestExpiringAt,
  soonestPackageExpiryAt,
  type CreditExpiryEntry,
} from './credit-expiry'
import type { PackageInfo } from './types'

const DAY = 24 * 60 * 60 * 1000

describe('parseCstWallClock：上游墙钟字符串按 CST(+08:00) 解释', () => {
  it('"YYYY-MM-DD HH:mm:ss" 按 CST 解析（而非 Workers 本地的 UTC）', () => {
    // CST 2026-09-30 23:59:59 == UTC 2026-09-30 15:59:59
    expect(parseCstWallClock('2026-09-30 23:59:59')).toBe(Date.UTC(2026, 8, 30, 15, 59, 59))
  })

  it('容忍 UTC+8 后缀、T 分隔、秒缺省', () => {
    const expectMs = Date.UTC(2026, 0, 2, 8, 0, 0) // CST 2026-01-02 16:00:00
    expect(parseCstWallClock('2026-01-02 16:00:00 UTC+8')).toBe(expectMs)
    expect(parseCstWallClock('2026-01-02T16:00:00')).toBe(expectMs)
    expect(parseCstWallClock('2026-01-02 16:00')).toBe(expectMs)
  })

  it('带显式偏移的 ISO 串交给 Date.parse（不再叠加 +8）', () => {
    expect(parseCstWallClock('2026-01-02T16:00:00+08:00')).toBe(Date.UTC(2026, 0, 2, 8, 0, 0))
    expect(parseCstWallClock('2026-01-02T08:00:00Z')).toBe(Date.UTC(2026, 0, 2, 8, 0, 0))
  })

  it('空串 / 非字符串 / 非法格式 → null（长期或未知，不参与优先）', () => {
    expect(parseCstWallClock('')).toBeNull()
    expect(parseCstWallClock('   ')).toBeNull()
    expect(parseCstWallClock(undefined)).toBeNull()
    expect(parseCstWallClock(0)).toBeNull()
    expect(parseCstWallClock('abc')).toBeNull()
    expect(parseCstWallClock('2026-09-30')).toBeNull()
  })
})

describe('soonestExpiringAt：窗口内最早到期且有剩余的积分', () => {
  const now = Date.UTC(2026, 8, 1, 0, 0, 0)
  const entry = (expireAt: number | null, remain: number): CreditExpiryEntry => ({ expireAt, remain })

  it('多个窗口内到期包 → 取最早的那个', () => {
    expect(soonestExpiringAt([entry(now + 5 * DAY, 10), entry(now + 2 * DAY, 10)], now)).toBe(now + 2 * DAY)
  })

  it('边界：正好 7 天后到期算窗口内，7 天零 1 毫秒算窗口外', () => {
    expect(soonestExpiringAt([entry(now + CREDIT_EXPIRY_WINDOW_MS, 1)], now)).toBe(now + CREDIT_EXPIRY_WINDOW_MS)
    expect(soonestExpiringAt([entry(now + CREDIT_EXPIRY_WINDOW_MS + 1, 1)], now)).toBeNull()
  })

  it('窗口外 + 长期有效 + 缺省 → 全部不参与（回落原积分规则）', () => {
    expect(soonestExpiringAt([entry(now + 8 * DAY, 100), entry(null, 100), entry(0, 100), entry(undefined as unknown as number, 100)], now)).toBeNull()
  })

  it('已过期（<= now）不参与：包已不可用，不是"即将作废"', () => {
    expect(soonestExpiringAt([entry(now - 1, 100), entry(now, 100)], now)).toBeNull()
  })

  it('剩余 <= 0 不参与：空包不该被当成待救积分', () => {
    expect(soonestExpiringAt([entry(now + DAY, 0), entry(now + DAY, -3)], now)).toBeNull()
  })

  it('跳过无效条目，仍能从其余条目里选出最早到期', () => {
    const entries = [null, entry(Number.NaN, 10), entry(now + 3 * DAY, 5)] as CreditExpiryEntry[]
    expect(soonestExpiringAt(entries, now)).toBe(now + 3 * DAY)
  })

  it('空输入 / null / undefined → null', () => {
    expect(soonestExpiringAt([], now)).toBeNull()
    expect(soonestExpiringAt(null, now)).toBeNull()
    expect(soonestExpiringAt(undefined, now)).toBeNull()
  })

  it('窗口可覆盖（供测试与未来按 provider 配置）', () => {
    expect(soonestExpiringAt([entry(now + 3 * DAY, 1)], now, 2 * DAY)).toBeNull()
    expect(soonestExpiringAt([entry(now + 3 * DAY, 1)], now, 4 * DAY)).toBe(now + 3 * DAY)
  })
})

describe('formatCstWallClock：parseCstWallClock 的逆运算（供只拿到 ms 的上游落成同一形态）', () => {
  it('按 +08:00 输出，且往返解析回原时刻（整秒）', () => {
    const ms = Date.UTC(2026, 8, 30, 15, 59, 59) // CST 2026-09-30 23:59:59
    expect(formatCstWallClock(ms)).toBe('2026-09-30 23:59:59')
    expect(parseCstWallClock(formatCstWallClock(ms))).toBe(ms)
  })

  it('跨日/跨月的 +8 进位正确（UTC 16:00 → 次日 CST 00:00）', () => {
    expect(formatCstWallClock(Date.UTC(2026, 8, 30, 16, 0, 0))).toBe('2026-10-01 00:00:00')
  })

  it('非有限 / <= 0 → 空串（长期或未知，不参与到期优先）', () => {
    expect(formatCstWallClock(0)).toBe('')
    expect(formatCstWallClock(-1)).toBe('')
    expect(formatCstWallClock(Number.NaN)).toBe('')
    expect(formatCstWallClock(Number.POSITIVE_INFINITY)).toBe('')
    expect(formatCstWallClock(undefined)).toBe('')
    expect(formatCstWallClock(null)).toBe('')
  })
})

describe('soonestPackageExpiryAt：PackageInfo 形态（workbuddy / qoder 共用）', () => {
  const now = Date.UTC(2026, 8, 1, 0, 0, 0)
  const pack = (expireAt: string, size: number, used: number, name = '包'): PackageInfo => ({ name, expireAt, size, used })

  it('remain = size − used；窗口内最早到期的胜出', () => {
    const soon = formatCstWallClock(now + 2 * DAY)!
    const late = formatCstWallClock(now + 5 * DAY)!
    expect(soonestPackageExpiryAt([pack(late, 100, 0), pack(soon, 100, 0)], now)).toBe(now + 2 * DAY)
  })

  it('已用尽 / 长期 / 已过期 / 空输入 → null', () => {
    expect(soonestPackageExpiryAt([pack(formatCstWallClock(now + DAY)!, 100, 100)], now)).toBeNull()
    expect(soonestPackageExpiryAt([pack('', 100, 0)], now)).toBeNull()
    expect(soonestPackageExpiryAt([pack(formatCstWallClock(now - DAY)!, 100, 0)], now)).toBeNull()
    expect(soonestPackageExpiryAt([], now)).toBeNull()
    expect(soonestPackageExpiryAt(undefined, now)).toBeNull()
  })

  it('packageExpiryEntry：size/used 缺省或非法 → remain 0（不把"容量未知"当成待救积分）', () => {
    expect(packageExpiryEntry({ name: 'x', expireAt: formatCstWallClock(now + DAY)! })).toEqual({
      expireAt: now + DAY,
      remain: 0,
    })
    expect(packageExpiryEntry({ name: 'x', expireAt: '', size: 10, used: 3 })).toEqual({ expireAt: null, remain: 7 })
  })
})
