import { describe, expect, it } from 'vitest'
import { unresolvedAssistantCommitment } from './tools'
import { ChatHubAttemptError, mayFailOverChatHubFailure } from './chathub'
import { AccountFlux } from './account-flux'
import {
  RESPONSE_ALIAS_TTL_SECONDS,
  MAX_CONSUMED_CALL_IDS,
  saveResponseAlias,
  getResponseAlias,
  consumeResponseCallId,
} from '../storage'
import type { Env } from '../types'

// ===== 未提交承诺检测（阶段 A-2）=====

describe('unresolvedAssistantCommitment（未提交承诺检测）', () => {
  it('英文"我将要执行"且无工具调用 → 判定为未提交承诺', () => {
    expect(unresolvedAssistantCommitment("I'll now run the build and fix any errors.", false)).toBe(true)
    expect(unresolvedAssistantCommitment('Let me create the config file for you.', false)).toBe(true)
    expect(unresolvedAssistantCommitment('I am going to deploy the worker shortly.', false)).toBe(true)
  })

  it('中文"我将要执行"且无工具调用 → 判定为未提交承诺', () => {
    expect(unresolvedAssistantCommitment('接下来我会执行构建并修复所有错误。', false)).toBe(true)
    expect(unresolvedAssistantCommitment('现在马上创建配置文件。', false)).toBe(true)
  })

  it('已有工具调用 → 不是未提交承诺', () => {
    expect(unresolvedAssistantCommitment("I'll now run the build.", true)).toBe(false)
  })

  it('含完成声明措辞 → 不判为未提交承诺（交给完成证据校验）', () => {
    expect(unresolvedAssistantCommitment('The deployment is completed successfully.', false)).toBe(false)
    expect(unresolvedAssistantCommitment('任务已经全部完成。', false)).toBe(false)
  })

  it('普通答复与空文本 → 不判为未提交承诺', () => {
    expect(unresolvedAssistantCommitment('Here is the summary of the repository.', false)).toBe(false)
    expect(unresolvedAssistantCommitment('', false)).toBe(false)
    expect(unresolvedAssistantCommitment('   ', false)).toBe(false)
  })
})

// ===== 重连/失败转移门禁（阶段 A-3）=====

describe('mayFailOverChatHubFailure（payload 已提交则禁止跨账号转移）', () => {
  it('payload 未提交的失败 → 允许失败转移', () => {
    const err = new ChatHubAttemptError('ws dial failed: HTTP 502', false)
    expect(err.invocationSubmitted).toBe(false)
    expect(err.reconnectSafe).toBe(true)
    expect(mayFailOverChatHubFailure(err)).toBe(true)
  })

  it('payload 已提交的失败 → 禁止失败转移（避免重复执行副作用）', () => {
    const err = new ChatHubAttemptError('ws closed before completion', true)
    expect(err.invocationSubmitted).toBe(true)
    expect(err.reconnectSafe).toBe(false)
    expect(mayFailOverChatHubFailure(err)).toBe(false)
  })

  it('客户端中止 / 总截止 / 进度超时 → 禁止失败转移', () => {
    expect(mayFailOverChatHubFailure(new Error('REQUEST_ABORTED'))).toBe(false)
    expect(mayFailOverChatHubFailure(new Error('CHAT_DEADLINE_EXCEEDED'))).toBe(false)
    expect(mayFailOverChatHubFailure(new Error('chathub response deadline exceeded before completion'))).toBe(false)
    expect(mayFailOverChatHubFailure(new Error('CHAT_PROGRESS_TIMEOUT'))).toBe(false)
  })

  it('普通可重试错误（未提交）→ 允许失败转移', () => {
    expect(mayFailOverChatHubFailure(new Error('upstream rate-limit notice'))).toBe(true)
    expect(mayFailOverChatHubFailure(new Error('ws dial failed: HTTP 503'))).toBe(true)
  })
})

// ===== Responses 别名强约束（阶段 C-6）=====

class MemoryKV {
  private store = new Map<string, { value: string; ttl?: number }>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl })
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  ttlOf(key: string): number | undefined {
    return this.store.get(key)?.ttl
  }
}

function envWithKv(kv: MemoryKV): Env {
  return { KV: kv } as unknown as Env
}

describe('Responses 别名强约束', () => {
  it('别名带 7 天 TTL', async () => {
    const kv = new MemoryKV()
    await saveResponseAlias(envWithKv(kv), 'resp_1', { sourceResponseId: 'resp_1', createdAt: Date.now(), consumedCallIds: [] })
    expect(kv.ttlOf('proxy:resp-alias:resp_1')).toBe(RESPONSE_ALIAS_TTL_SECONDS)
  })

  it('别名不可变：重复保存不覆盖原分支点', async () => {
    const kv = new MemoryKV()
    const env = envWithKv(kv)
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'origin', createdAt: 1, consumedCallIds: [] })
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'mutated', createdAt: 2, consumedCallIds: ['c1'] })
    const alias = await getResponseAlias(env, 'resp_1')
    expect(alias?.sourceResponseId).toBe('origin')
    expect(alias?.consumedCallIds).toEqual([])
  })

  it('call_id 一次性：重复消费被拒绝', async () => {
    const kv = new MemoryKV()
    const env = envWithKv(kv)
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'resp_1', createdAt: Date.now(), consumedCallIds: [] })
    expect(await consumeResponseCallId(env, 'resp_1', 'call_a')).toBe(true)
    expect(await consumeResponseCallId(env, 'resp_1', 'call_a')).toBe(false)
    expect(await consumeResponseCallId(env, 'resp_1', 'call_b')).toBe(true)
    const alias = await getResponseAlias(env, 'resp_1')
    expect(alias?.consumedCallIds).toEqual(['call_a', 'call_b'])
  })

  it('消费表有上限：最多保留 MAX_CONSUMED_CALL_IDS 条', async () => {
    const kv = new MemoryKV()
    const env = envWithKv(kv)
    const initial = Array.from({ length: MAX_CONSUMED_CALL_IDS }, (_, i) => `old_${i}`)
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'resp_1', createdAt: Date.now(), consumedCallIds: initial })
    await consumeResponseCallId(env, 'resp_1', 'newest')
    const alias = await getResponseAlias(env, 'resp_1')
    expect(alias?.consumedCallIds.length).toBe(MAX_CONSUMED_CALL_IDS)
    expect(alias?.consumedCallIds.at(-1)).toBe('newest')
  })

  it('不存在的别名消费 → 放行（避免记录故障阻断请求）', async () => {
    const kv = new MemoryKV()
    expect(await consumeResponseCallId(envWithKv(kv), 'missing', 'call_x')).toBe(true)
  })
})

// ===== 账号级串行 + 最小间隔（阶段 B-4）=====

describe('AccountFlux 同账号串行与最小间隔', () => {
  it('默认并发上限为 1：第二个并发 acquire 返回 busy', async () => {
    const flux = new AccountFlux({} as DurableObjectState, { M365_ACCOUNT_MIN_INTERVAL_MS: '0' } as unknown as Env)
    const first = await (await flux.fetch(acquireReq('oid-1'))).json() as { granted: boolean }
    expect(first.granted).toBe(true)
    const second = await (await flux.fetch(acquireReq('oid-1'))).json() as { granted: boolean; busy?: boolean }
    expect(second.granted).toBe(false)
    expect(second.busy).toBe(true)
  })

  it('释放后立即再取 → 因最小间隔被节流并给出 waitHintMs', async () => {
    const flux = new AccountFlux({} as DurableObjectState, { M365_ACCOUNT_MIN_INTERVAL_MS: '1000' } as unknown as Env)
    await flux.fetch(acquireReq('oid-2'))
    await flux.fetch(releaseReq('oid-2'))
    const again = await (await flux.fetch(acquireReq('oid-2'))).json() as { granted: boolean; throttled?: boolean; waitHintMs?: number }
    expect(again.granted).toBe(false)
    expect(again.throttled).toBe(true)
    expect(again.waitHintMs).toBeGreaterThan(0)
    expect(again.waitHintMs).toBeLessThanOrEqual(1000)
  })

  it('显式关闭节流（间隔 0）后，释放即可再取', async () => {
    const flux = new AccountFlux({} as DurableObjectState, { M365_ACCOUNT_MIN_INTERVAL_MS: '0' } as unknown as Env)
    await flux.fetch(acquireReq('oid-3'))
    await flux.fetch(releaseReq('oid-3'))
    const again = await (await flux.fetch(acquireReq('oid-3'))).json() as { granted: boolean }
    expect(again.granted).toBe(true)
  })

  it('并发上限可配置：设 2 时允许两个在途', async () => {
    const flux = new AccountFlux({} as DurableObjectState, { M365_ACCOUNT_MIN_INTERVAL_MS: '0', M365_ACCOUNT_DEFAULT_CONCURRENCY: '2' } as unknown as Env)
    expect((await (await flux.fetch(acquireReq('oid-4'))).json() as { granted: boolean }).granted).toBe(true)
    expect((await (await flux.fetch(acquireReq('oid-4'))).json() as { granted: boolean }).granted).toBe(true)
    expect((await (await flux.fetch(acquireReq('oid-4'))).json() as { busy?: boolean }).busy).toBe(true)
  })

  it('分摊游标逐次递增：跨会话均匀轮转不同健康账号', async () => {
    const flux = new AccountFlux({} as DurableObjectState, {} as unknown as Env)
    const cursors: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const r = await (await flux.fetch(cursorReq())).json() as { cursor: number }
      cursors.push(r.cursor)
    }
    expect(cursors).toEqual([0, 1, 2])
    // 3 个健康账号时，游标取模依次命中 0/1/2，实现均匀分摊
    expect(cursors.map((c) => c % 3)).toEqual([0, 1, 2])
  })
})

function acquireReq(oid: string): Request {
  return new Request('https://flux.local/acquire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oid }),
  })
}

function releaseReq(oid: string): Request {
  return new Request('https://flux.local/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oid }),
  })
}

function cursorReq(): Request {
  return new Request('https://flux.local/spread-cursor', { method: 'POST' })
}
