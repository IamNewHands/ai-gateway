/**
 * pool.test.ts — Qoder 池状态机里「签到成功却仍被跳过」的那条路径。
 *
 * 线上现象（2026-10-02 用户反馈）：账号卡片显示「积分=400 已禁用（鉴权失败：{"code":"10605",…}）」，
 * 但同一账号当天签到成功。原因是两件事叠在一起：
 *   1. c7b79c8 之前，上游排队满（10605 / isQueued）被误判成鉴权故障 → 旧代码写下
 *      `disabled: true` + reason「鉴权失败：<原始 JSON>」（该文案只有旧代码写得出来，
 *      新代码是「鉴权失败（会话已失效，需重新登录）：…」）；
 *   2. reenableQoderIfCredits 当时带 `&& !st.disabled` 守卫 → 签到成功也不解冻。
 * 结果：token 明明有效、积分明明恢复了，转发却永远跳过这个账号，400 积分一直用不上。
 *
 * 这里钉住「成功签到 = token 有效的直接反证 → 冷却与禁用都必须清掉」，同时守住反向边界：
 * 没有积分（remain <= 0）时**不能**顺手解冻，否则只会让它立刻被挑中再撞一次额度耗尽。
 */
import { describe, it, expect } from 'vitest'
import {
  cooldownQoderAccount,
  disableQoderAccount,
  listQoderPoolStatus,
  noteQoderError,
  pickQoderAccount,
  reenableQoderIfCredits,
  writeQoderPool,
  type QoderPoolAccount,
} from './pool'
import type { Env } from '../types'

/** 假 KV：只实现池读写用到的 get/put/delete。 */
function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV: kv } as unknown as Env, store }
}

/** 一个健康账号（token 未过期、有 refresh_token）。 */
function account(over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid: 'u1',
    nickname: 'u1',
    token: { access_token: 'dt-test', refresh_token: 'drt-test', expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'global',
    ...over,
  }
}

describe('reenableQoderIfCredits：成功签到必须同时清掉 disabled（历史误判残留）', () => {
  it('历史误判留下的 disabled + 旧文案 reason：签到恢复积分后一并清除', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-1'
    await writeQoderPool(env, pid, [account()])
    // 复刻线上 KV 里的残留状态：旧代码（c7b79c8 之前）把 10605 排队写成了永久禁用
    await disableQoderAccount(env, pid, 'u1', '鉴权失败：{"code":"10605","message":"{\\"isQueued\\":true}"}')

    let st = await listQoderPoolStatus(env, pid)
    expect(st[0].disabled).toBe(true)
    expect(st[0].reason).toContain('10605')
    // 被禁用 → 挑号永远跳过它（用户看到的「400 积分用不上」）
    expect(await pickQoderAccount(env, pid, new Set())).toBeNull()

    await reenableQoderIfCredits(env, pid, 'u1', 400)

    st = await listQoderPoolStatus(env, pid)
    expect(st[0].credits).toBe(400)
    expect(st[0].disabled).toBe(false)
    expect(st[0].reason).toBe('')
    expect(st[0].cooling).toBe(false)
    // 解冻后立刻可被挑中——这才是「积分恢复」的实际含义
    const picked = await pickQoderAccount(env, pid, new Set())
    expect(picked?.uid).toBe('u1')
  })

  it('冷却中的账号：签到恢复积分后清冷却 + errCount，不只是清 disabled', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-2'
    await writeQoderPool(env, pid, [account()])
    await cooldownQoderAccount(env, pid, 'u1', 12 * 60 * 60 * 1000, '额度耗尽（402）')
    await noteQoderError(env, pid, 'u1', { planMs: 1000, softMs: 1000, errThreshold: 5, errMs: 1000 })

    await reenableQoderIfCredits(env, pid, 'u1', 100)

    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.cooling).toBe(false)
    expect(st.until).toBe(0)
    expect(st.errCount).toBe(0)
    expect(st.credits).toBe(100)
  })

  it('remain <= 0 不解冻（否则会立刻被挑中再撞一次额度耗尽）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-3'
    await writeQoderPool(env, pid, [account()])
    await disableQoderAccount(env, pid, 'u1', 'token 刷新失败（需重新登录）')

    await reenableQoderIfCredits(env, pid, 'u1', 0)

    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.disabled).toBe(true)
    expect(st.reason).toBe('token 刷新失败（需重新登录）')
    expect(st.credits).toBe(0)
  })

  it('uid 不在池里：静默返回，不抛（签到路径不能被池状态写坏打挂）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-4'
    await writeQoderPool(env, pid, [account()])
    await expect(reenableQoderIfCredits(env, pid, 'nobody', 100)).resolves.toBeUndefined()
    expect((await listQoderPoolStatus(env, pid)).length).toBe(1)
  })
})
