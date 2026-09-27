/**
 * packs.test.ts — 权益包到期时间明细（积分明细面板数据源）。
 *
 * 覆盖两层：
 *  1. 上游解析：entitlement_base_info.end_time / start_time → expireAt / startAt（秒归一化）
 *  2. 池排序：compareTraePacks 把最快过期的包排最前、长期有效排最后
 *
 * 需求背景（2026-09-27）：面板原先只显示「总积分」，看不到各权益包的到期时间；
 * 上游 ide_user_ent_usage 的 entitlement_base_info.end_time 一直有下发但此前被丢弃。
 */
import { describe, it, expect } from 'vitest'
import { fetchUserEntUsageDetails } from './upstream'
import { compareTraePacks } from './pool'
import type { TraeAccount, TraeEntPackInfo } from './types'

const testAccount: TraeAccount = {
  uid: 'u_pack_1',
  accessToken: 'tok_pack',
  refreshToken: 'ref_pack',
  expiresAt: Date.now() + 10000,
  deviceId: 'dev_pack',
}

function mockEntUsage(packList: unknown[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ user_entitlement_pack_list: packList }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('Trae 权益包：到期时间解析（entitlement_base_info.end_time）', () => {
  it('解析秒级 end_time / start_time 到 expireAt / startAt，并保留包身份字段', async () => {
    const restore = mockEntUsage([
      {
        entitlement_base_info: {
          name: '权益包(checkin_20260830_3946579063222572)',
          entitlement_id: 'checkin_20260830_3946579063222572',
          end_time: 1763038285,
          start_time: 1760446285,
          product_type: 1,
          quota: { credits_limit: 200 },
        },
        usage: { credits_amount: 57.0156 },
        status: 1,
      },
    ])
    try {
      const details = await fetchUserEntUsageDetails(testAccount)
      expect(details.packs.length).toBe(1)
      const p = details.packs[0]
      expect(p.expireAt).toBe(1763038285)
      expect(p.startAt).toBe(1760446285)
      expect(p.status).toBe(1)
      expect(p.productType).toBe(1)
      expect(p.entitlementId).toBe('checkin_20260830_3946579063222572')
      expect(p.rem).toBeCloseTo(142.9844, 4)
    } finally {
      restore()
    }
  })

  it('毫秒级 end_time 归一化为秒（>1e12 视为 ms）', async () => {
    const restore = mockEntUsage([
      {
        entitlement_base_info: {
          name: '毫秒包',
          end_time: 1763038285000,
          start_time: 1760446285000,
          quota: { credits_limit: 100 },
        },
        usage: { credits_amount: 0 },
      },
    ])
    try {
      const details = await fetchUserEntUsageDetails(testAccount)
      expect(details.packs[0].expireAt).toBe(1763038285)
      expect(details.packs[0].startAt).toBe(1760446285)
    } finally {
      restore()
    }
  })

  it('end_time 为 0 / 缺失 / 非法 → expireAt 为 0（面板渲染「长期」，不编造到期时间）', async () => {
    const restore = mockEntUsage([
      { entitlement_base_info: { name: '无到期字段', quota: { credits_limit: 10 } }, usage: { credits_amount: 0 } },
      { entitlement_base_info: { name: '零值到期', end_time: 0, quota: { credits_limit: 10 } }, usage: { credits_amount: 0 } },
      { entitlement_base_info: { name: '非法到期', end_time: 'abc', quota: { credits_limit: 10 } }, usage: { credits_amount: 0 } },
      { entitlement_base_info: { name: '负值到期', end_time: -5, quota: { credits_limit: 10 } }, usage: { credits_amount: 0 } },
    ])
    try {
      const details = await fetchUserEntUsageDetails(testAccount)
      expect(details.packs.map((p) => p.expireAt)).toEqual([0, 0, 0, 0])
    } finally {
      restore()
    }
  })

  it('status / productType 未下发时为 undefined（不写假 0 误导面板）', async () => {
    const restore = mockEntUsage([
      { entitlement_base_info: { name: '裸包', quota: { credits_limit: 10 } }, usage: { credits_amount: 0 } },
    ])
    try {
      const details = await fetchUserEntUsageDetails(testAccount)
      expect(details.packs[0].status).toBeUndefined()
      expect(details.packs[0].productType).toBeUndefined()
    } finally {
      restore()
    }
  })
})

describe('Trae 权益包：面板排序（compareTraePacks）', () => {
  const pack = (name: string, expireAt?: number): TraeEntPackInfo => ({
    name, limit: 100, used: 0, rem: 100, isWork: false, expireAt,
  })

  it('按到期时间升序：最快过期的排最前', () => {
    const list = [pack('c', 3000), pack('a', 1000), pack('b', 2000)]
    expect([...list].sort(compareTraePacks).map((p) => p.name)).toEqual(['a', 'b', 'c'])
  })

  it('长期有效（expireAt 为 0/缺省）排在所有有到期时间之后', () => {
    const list = [pack('长期1', 0), pack('过期包', 1000), pack('缺省'), pack('长期2', 5000)]
    const sorted = [...list].sort(compareTraePacks).map((p) => p.name)
    // 有到期时间的按到期升序在前
    expect(sorted.slice(0, 2)).toEqual(['过期包', '长期2'])
    // 无到期时间的两个（0 与缺省）整体排最后，二者相对顺序由名称 tie-break 决定
    expect(sorted.slice(2).sort()).toEqual(['缺省', '长期1'].sort())
  })

  it('同到期时刻按名称升序，保证多次刷新顺序不抖动', () => {
    const list = [pack('z', 1000), pack('a', 1000), pack('m', 1000)]
    expect([...list].sort(compareTraePacks).map((p) => p.name)).toEqual(['a', 'm', 'z'])
  })

  it('不修改入参数组（listTraeStatus 依赖纯排序）', () => {
    const list = [pack('c', 3000), pack('a', 1000)]
    const before = list.map((p) => p.name)
    ;[...list].sort(compareTraePacks)
    expect(list.map((p) => p.name)).toEqual(before)
  })
})