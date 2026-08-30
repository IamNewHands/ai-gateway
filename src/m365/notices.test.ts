import { describe, it, expect } from 'vitest'
import { classifyChatHubNotice } from './chathub'
import { markAccountFailure } from './account-health'
import type { Env } from '../types'

/** 内存版 KV 桩，供 markAccountFailure 落盘测试 */
function makeEnv() {
  const store = new Map<string, string>()
  const KV = {
    get: async (k: string): Promise<string | null> => store.get(k) ?? null,
    put: async (k: string, v: string, _opts?: unknown): Promise<void> => { store.set(k, v) },
    delete: async (k: string): Promise<void> => { store.delete(k) },
  }
  return { env: ({ KV } as unknown) as Env, store }
}

describe('classifyChatHubNotice（8-27 扩充限流词表）', () => {
  const newPhrases = [
    'temporarily unable to respond to this volume of requests',
    'temporarily unable to respond to this many requests',
    '请求量过大，请稍后重试',
    '请稍后重试。暂时无法响应',
    'please retry again later',
    'please try again later',
  ]
  for (const p of newPhrases) {
    it(`命中新增限流短语: ${p}`, () => {
      expect(classifyChatHubNotice(p)).toBe('rate_limit')
    })
  }

  it('旧词表短语仍命中', () => {
    expect(classifyChatHubNotice('too many requests')).toBe('rate_limit')
    expect(classifyChatHubNotice('太多请求')).toBe('rate_limit')
  })

  it('非限流文本不误报', () => {
    expect(classifyChatHubNotice('这是一个正常的回答内容')).toBeNull()
  })
})

describe('markAccountFailure：metering 节流固定 15min 冷却', () => {
  it('无 Retry-After 的 metering 节流 → 冷却约 15min 且复位退避计数', async () => {
    const { env } = makeEnv()
    await markAccountFailure(env, 'acc-1', 'upstream metering throttle: capability access denied')
    const raw = await env.KV.get('m365:health:acc-1')
    expect(raw).toBeTruthy()
    const s = JSON.parse(raw!)
    const remaining = s.cooldownUntil - Date.now()
    expect(remaining).toBeGreaterThan(14 * 60 * 1000)
    expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000)
    expect(s.rlFailures).toBe(0)
  })

  it('metering 节流带上游 Retry-After → 采用 Retry-After', async () => {
    const { env } = makeEnv()
    await markAccountFailure(env, 'acc-2', 'upstream metering throttle: capability access denied', 120)
    const s = JSON.parse((await env.KV.get('m365:health:acc-2'))!)
    const remaining = s.cooldownUntil - Date.now()
    expect(remaining).toBeGreaterThan(119 * 1000)
    expect(remaining).toBeLessThanOrEqual(120 * 1000)
  })

  it('普通限流仍走指数退避（首次 30s，计数累加）', async () => {
    const { env } = makeEnv()
    await markAccountFailure(env, 'acc-3', 'too many requests')
    const s = JSON.parse((await env.KV.get('m365:health:acc-3'))!)
    const remaining = s.cooldownUntil - Date.now()
    expect(remaining).toBeLessThanOrEqual(30 * 1000)
    expect(remaining).toBeGreaterThan(29 * 1000)
    expect(s.rlFailures).toBe(1)
  })
})
