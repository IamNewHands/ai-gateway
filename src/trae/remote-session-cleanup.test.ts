/**
 * remote-session-cleanup.test.ts — 上游会话回收（账号并发槽位的唯一防线）。
 *
 * ## 现场（2026-10-14 真机）
 *
 * 切 Remote 后「会话建好了、executor 从不启动」，日志只有 `phase=session` + 心跳；
 * 同期上游 429：
 *   `{"code":991502,"reason":"solo_agent_parallel_limit","limit":2,"running":2}`
 * 即账号并发槽位（上游上限 2）被占满。占满的原因之一就是我们自己漏回收。
 *
 * ## 本文件钉住四条
 *
 * 1. **非流式成功也要回收** —— 曾经漏了这一处：没有流就没有 `onDone` / `onClose` 可挂，
 *    于是每个非流式 Remote 请求都泄漏一个上游会话。
 * 2. **只回收一次** —— `onDone`（模型说完）与 `onClose`（流收尾）都会触发，必须去重。
 * 3. **回收要登记到 `waitUntil`** —— 响应结束后未登记的异步任务会被 Workers 直接丢弃，
 *    回收静默失败就退化成泄漏（这正是「看着有回收代码、槽位照样积满」的成因）。
 * 4. **没收到 `done` 时不提前回收** —— 截断/中断的会话仍由流收尾路径兜底，不能靠 `onDone`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyTraeChatRequest } from './proxy'
import { effectiveRemoteConcurrency } from './remote'
import { webStreamToOpenAIStream } from './web-sse'
import type { TraeRemoteEvent } from './types'

const UID = 'u_remote_cleanup'
const PROVIDER_ID = 'trae-remote-cleanup'

async function* feed(list: TraeRemoteEvent[]): AsyncGenerator<TraeRemoteEvent> {
  for (const e of list) yield e
}

afterEach(() => { vi.unstubAllGlobals() })

function makeEnv(): any {
  return {
    KV: {
      data: new Map<string, string>(),
      async get(k: string) { return this.data.get(k) || null },
      async put(k: string, v: string) { this.data.set(k, v) },
      async delete(k: string) { this.data.delete(k) },
    },
  }
}

/** 单档位（显式 Work）：不触发档位兜底，一条会话走到底，便于数回收次数。 */
function makeProvider(): any {
  return {
    id: PROVIDER_ID,
    name: 'TRAE Remote',
    baseUrl: 'https://trae-api-cn.mchost.guru',
    traeUpstreamEndpoint: 'remote',
    traeRemoteAgentType: 'work',
    apiKeys: [{
      key: JSON.stringify({
        uid: UID,
        token: 'tok_cleanup',
        refreshToken: 'ref_cleanup',
        expiresAt: Date.now() + 3600_000,
      }),
      enabled: true,
    }],
    models: [{ id: 'glm-5.2', enabled: true }],
  }
}

function modelsResponse(): Response {
  const model = {
    name: 'glm-5.2',
    config_name: 'glm-5.2',
    model_name: 'glm-5.2',
    config_source: 1,
    reasoning_effort_config: { support_thinking: true, options: ['light', 'high', 'extra_high'] },
  }
  return new Response(JSON.stringify({
    code: 0,
    data: {
      list: [
        { function: 'solo_agent_remote', models: [model] },
        { function: 'solo_work_remote', models: [model] },
      ],
    },
  }), { status: 200 })
}

/** 正常一轮：一个 plan_item + done。返回调用流水，便于数 `/stop` 次数。 */
function stubHappyPath(calls: string[], eventsBody: string): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url)
    if (u.includes('/models')) { calls.push('models'); return modelsResponse() }
    // ⚠️ 必须先判 /stop：`POST /chat_sessions/{id}/stop` 同样含 `/chat_sessions`，
    // 顺序写反会把「回收」记成「建会话」。
    if (u.includes('/stop')) { calls.push('stop'); return new Response('{}', { status: 200 }) }
    if (u.includes('/chat_sessions') && String(init?.method || '') === 'POST') {
      calls.push('create')
      return new Response(JSON.stringify({ code: 0, data: { chat_session_id: 's1', message_id: 'm1' } }), { status: 200 })
    }
    if (u.includes('/events')) { calls.push('events'); return new Response(eventsBody, { status: 200 }) }
    return new Response('{}', { status: 200 })
  }))
}

const HAPPY_EVENTS = 'event: plan_item\ndata: {"id":"p1","content":"cleanup ok"}\n\nevent: done\ndata: {}\n\n'

describe('上游会话回收：非流式路径（本轮补的漏）', () => {
  it('非流式成功也回收会话，且只回收一次', async () => {
    const calls: string[] = []
    stubHappyPath(calls, HAPPY_EVENTS)

    const resp = await proxyTraeChatRequest(makeEnv(), makeProvider(), {
      model: 'glm-5.2',
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    })

    expect(resp.status).toBe(200)
    expect(JSON.stringify(await resp.json())).toContain('cleanup ok')
    // 回归点：没有流 → 没有 onDone/onClose，只能靠成功路径显式回收。
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
  })
})

describe('上游会话回收：流式路径', () => {
  it('done 与流收尾都会触发回收，但只发一次 /stop，且登记到 waitUntil', async () => {
    const calls: string[] = []
    stubHappyPath(calls, HAPPY_EVENTS)
    const waited: Promise<unknown>[] = []

    const resp = await proxyTraeChatRequest(makeEnv(), makeProvider(), {
      model: 'glm-5.2',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }, { waitUntil: (p: Promise<unknown>) => { waited.push(p) } })

    expect(resp.status).toBe(200)
    expect(await resp.text()).toContain('cleanup ok')

    // onDone（模型说完）与 onClose（流收尾）都会调 stopOnce，去重后上游只该被停一次。
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    // 回收必须挂在请求生命周期上：否则响应结束后子请求被丢弃 = 静默泄漏。
    expect(waited.length).toBeGreaterThanOrEqual(1)
    await Promise.all(waited)
  })

  it('没有 ctx 时退回 fire-and-forget，不抛错也不影响流', async () => {
    const calls: string[] = []
    stubHappyPath(calls, HAPPY_EVENTS)

    const resp = await proxyTraeChatRequest(makeEnv(), makeProvider(), {
      model: 'glm-5.2',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    })

    expect(resp.status).toBe(200)
    expect(await resp.text()).toContain('[DONE]')
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
  })
})

describe('onDone 的触发条件', () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    for (;;) { const r = await reader.read(); if (r.done) break }
  }

  it('收到 done 时立刻回调（用于抢在响应结束前回收）', async () => {
    const seen: string[] = []
    await drain(webStreamToOpenAIStream(
      feed([
        { event: 'plan_item', data: { id: 'p1', content: 'hi' } },
        { event: 'done', data: {} },
      ]),
      'glm-5.2',
      { onDone: () => seen.push('done') }
    ))
    expect(seen).toEqual(['done'])
  })

  it('没有 done（被截断）时不提前回收 —— 交给流收尾路径兜底', async () => {
    const seen: string[] = []
    await drain(webStreamToOpenAIStream(
      feed([{ event: 'plan_item', data: { id: 'p1', content: 'half' } }]),
      'glm-5.2',
      { onDone: () => seen.push('done') }
    ))
    expect(seen).toEqual([])
  })
})

describe('每账号并发上限：默认生效（槽位防线的另一半）', () => {
  /**
   * 回归点（2026-10-14）：`provider.traeConcurrency` 默认是 0（不限），而 Remote 的会话
   * 在整条事件流期间都占住上游槽位 —— 槽位满了上游不报错、只让新会话排队（executor
   * 不启动）。所以面板没配时也必须收敛到上游实测上限，否则「不配 = 不设防」。
   */
  it('面板未配置（0）→ 收敛到上游实测上限 2，而不是「不限」', () => {
    expect(effectiveRemoteConcurrency(0)).toBe(2)
  })

  it('面板配得比上游上限大 → 取上游上限（配更大没有意义，上游照样排队）', () => {
    expect(effectiveRemoteConcurrency(5)).toBe(2)
    expect(effectiveRemoteConcurrency(2)).toBe(2)
  })

  it('面板配得更小 → 尊重面板（更保守是安全的）', () => {
    expect(effectiveRemoteConcurrency(1)).toBe(1)
  })

  it('负数 / NaN 按「未配置」处理，不会算出 0 个槽位把自己锁死', () => {
    expect(effectiveRemoteConcurrency(-1)).toBe(2)
    expect(effectiveRemoteConcurrency(Number.NaN)).toBe(2)
  })
})
