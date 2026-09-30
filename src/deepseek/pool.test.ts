/**
 * deepseek/pool.test.ts — token 池：KV 往返、注入去重、失效标记、轮转与并发上限。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Env } from '../types'
import {
  DEEPSEEK_DEFAULT_MAX_INFLIGHT,
  acquireDeepseekToken,
  addDeepseekToken,
  countReady,
  markDeepseekToken,
  readDeepseekPool,
  removeDeepseekToken,
  resetDeepseekRotatorForTest,
  toTokenView,
  writeDeepseekPool,
  type DeepseekTokenRecord,
} from './pool'

function mockKV() {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const mockEnv = (kv: ReturnType<typeof mockKV>) => ({ KV: kv } as unknown as Env)

const rec = (id: string, state: DeepseekTokenRecord['state'] = 'ready'): DeepseekTokenRecord => ({
  id,
  token: `tok-${id}`,
  headerDeviceId: `dev-${id}`,
  userAgent: 'UA',
  state,
  addedAt: 1,
})

beforeEach(() => resetDeepseekRotatorForTest())

describe('kv round trip', () => {
  it('treats a missing or corrupt key as an empty pool', async () => {
    const kv = mockKV()
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
    kv.map.set('deepseek:pool', 'not json')
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
    kv.map.set('deepseek:pool', JSON.stringify({ tokens: 'nope' }))
    expect(await readDeepseekPool(mockEnv(kv))).toEqual([])
  })

  it('persists and reads back', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('a')])
    expect((await readDeepseekPool(env)).map((t) => t.id)).toEqual(['a'])
  })
})

describe('add / remove', () => {
  it('adds a token, rejects duplicates without overwriting, and never stores blanks', async () => {
    const env = mockEnv(mockKV())
    const first = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })
    expect(first.ok).toBe(true)
    expect(first.record?.id).toBeTruthy()
    expect(first.record?.state).toBe('ready')

    const dup = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })
    expect(dup.ok).toBe(false)
    expect(dup.duplicate?.id).toBe(first.record?.id)

    expect((await addDeepseekToken(env, { token: '  ', headerDeviceId: 'd', userAgent: 'UA' })).ok).toBe(false)
    expect((await addDeepseekToken(env, { token: 't2', headerDeviceId: '', userAgent: 'UA' })).ok).toBe(false)
    expect(await readDeepseekPool(env)).toHaveLength(1)
  })

  it('removes by panel id and reports misses', async () => {
    const env = mockEnv(mockKV())
    const added = await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA', label: '主号' })
    const id = added.record!.id
    expect((await removeDeepseekToken(env, id))?.id).toBe(id)
    expect(await removeDeepseekToken(env, id)).toBeNull()
    expect(await readDeepseekPool(env)).toEqual([])
  })
})

describe('state transitions', () => {
  it('marks expired with a reason, and ok clears it', async () => {
    const env = mockEnv(mockKV())
    const id = (await addDeepseekToken(env, { token: 't1', headerDeviceId: 'd1', userAgent: 'UA' })).record!.id

    await markDeepseekToken(env, id, { state: 'expired', error: 'token expired' })
    let list = await readDeepseekPool(env)
    expect(list[0].state).toBe('expired')
    expect(list[0].lastError).toBe('token expired')
    expect(countReady(list)).toBe(0)

    await markDeepseekToken(env, id, { ok: true })
    list = await readDeepseekPool(env)
    expect(list[0].state).toBe('ready')
    expect(list[0].lastError).toBeUndefined()
    expect(list[0].lastOkAt).toBeGreaterThan(0)
  })

  it('reports misses for unknown ids', async () => {
    const env = mockEnv(mockKV())
    expect(await markDeepseekToken(env, 'nope', { ok: true })).toBeNull()
  })

  it('never exposes the full token in the panel view', async () => {
    const view = toTokenView({ ...rec('a'), token: 'abcdef123456' })
    expect(view.tokenTail).toBe('123456')
    expect(JSON.stringify(view)).not.toContain('abcdef123456')
  })
})

describe('rotation', () => {
  it('round-robins across ready tokens', () => {
    const tokens = [rec('a'), rec('b'), rec('c')]
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      const acq = acquireDeepseekToken('p', tokens)!
      picks.push(acq.record.id)
      acq.release()
    }
    expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('skips expired tokens entirely', () => {
    const tokens = [rec('a', 'expired'), rec('b'), rec('c', 'expired')]
    const acq = acquireDeepseekToken('p', tokens)!
    expect(acq.record.id).toBe('b')
    acq.release()
  })

  it('enforces the per-token in-flight cap and returns null when everything is busy', () => {
    const tokens = [rec('a')]
    const held = []
    for (let i = 0; i < DEEPSEEK_DEFAULT_MAX_INFLIGHT; i++) {
      const acq = acquireDeepseekToken('p', tokens)
      expect(acq).not.toBeNull()
      held.push(acq!)
    }
    expect(acquireDeepseekToken('p', tokens)).toBeNull()
    held[0].release()
    expect(acquireDeepseekToken('p', tokens)?.record.id).toBe('a')
  })

  it('returns null for an empty pool or an all-expired pool', () => {
    expect(acquireDeepseekToken('p', [])).toBeNull()
    expect(acquireDeepseekToken('p', [rec('a', 'expired')])).toBeNull()
  })

  it('keeps independent state per pool key', () => {
    const tokens = [rec('a'), rec('b')]
    expect(acquireDeepseekToken('p1', tokens)!.record.id).toBe('a')
    expect(acquireDeepseekToken('p2', tokens)!.record.id).toBe('a')
  })
})
