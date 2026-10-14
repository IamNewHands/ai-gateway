/**
 * remote-fallback.test.ts — Agent 档位「起了会话但不启动 executor」→ 同账号 Work 档位兜底。
 *
 * ## 现场（2026-10-14 真机）
 *
 * 切 Remote 后一直没内容。诊断日志显示：
 *   `phase=session agent=solo_agent_remote effort=high max_mode=on`
 *   `phase=raw-head head="event: heartbeat data: {\"status\":2,...}"`
 *   —— 然后**永远没有** `phase=first-event`。
 *
 * 即：会话建起来了，但上游只发心跳、executor 从不启动。
 * 对照源侧 `main.py` 发现漏了一条链：源侧在 `RemoteFirstEventTimeout` 时会用
 * `work_fallback_options`（**同账号、同模型名**）回落到 Work 档位重试一次。
 *
 * ## 两条硬约束（本文件重点验证）
 *
 * 1. 兜底必须在**返回 200 之前**发生 —— 响应头一发就再也换不了档位，
 *    所以必须先「预读首个模型事件」（`preflightFirstModelEvent`）。
 * 2. 兜底**不换模型** —— 只换 executor 档位，模型名一个字符都不变；
 *    Work 目录里没有该模型时会显式失败，而不是静默换一个。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preflightFirstModelEvent, streamRemoteEvents, RemoteFirstEventTimeout } from './remote'
import { proxyTraeChatRequest } from './proxy'
import type { TraeAccount, TraeRemoteEvent } from './types'

const UID = 'u_remote_fallback'
const ACCOUNT: TraeAccount = {
  accessToken: 'tok_fb',
  refreshToken: 'ref_fb',
  expiresAt: 0,
  uid: UID,
  deviceId: 'dev_fb',
}

async function* feed(list: TraeRemoteEvent[]): AsyncGenerator<TraeRemoteEvent> {
  for (const e of list) yield e
}
function ev(event: string, data: Record<string, any> = {}): TraeRemoteEvent {
  return { event, data }
}
async function collect(gen: AsyncGenerator<TraeRemoteEvent>): Promise<TraeRemoteEvent[]> {
  const out: TraeRemoteEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

afterEach(() => { vi.unstubAllGlobals() })

describe('preflightFirstModelEvent：把「档位起不来」暴露在建流之前', () => {
  it('只有心跳、随后流结束 → RemoteFirstEventTimeout', async () => {
    await expect(
      preflightFirstModelEvent(feed([ev('heartbeat', { status: 2 })]), 5000)
    ).rejects.toBeInstanceOf(RemoteFirstEventTimeout)
  })

  it('首个模型事件到达即返回；续流**先重放**预读帧（心跳不丢、不重排）', async () => {
    const { head, rest } = await preflightFirstModelEvent(
      feed([ev('heartbeat', { status: 2 }), ev('plan_item', { id: 'p1', content: 'hi' }), ev('done', {})]),
      5000
    )
    expect(head.event).toBe('plan_item')
    expect((await collect(rest)).map((e) => e.event)).toEqual(['heartbeat', 'plan_item', 'done'])
  })

  it('上游给了明确 HTTP 判决（带 status）→ 原样上抛，不当作「首事件失败」', async () => {
    // 账号级定责（401 禁用 / 429 软冷却 / 5xx 累计）不能被档位兜底盖掉。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    const probe = streamRemoteEvents(ACCOUNT, 's', 'm', { firstEventTimeoutMs: 5000 })
    await expect(preflightFirstModelEvent(probe, 5000)).rejects.toMatchObject({ status: 401, kind: 'session_dead' })
  })
})

describe('Remote 档位兜底：Agent 起不来 → 同账号 Work 档位', () => {
  const PROVIDER_ID = 'trae-remote-fb'

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

  function makeProvider(): any {
    return {
      id: PROVIDER_ID,
      name: 'TRAE Remote',
      baseUrl: 'https://trae-api-cn.mchost.guru',
      traeUpstreamEndpoint: 'remote',
      apiKeys: [{
        key: JSON.stringify({
          uid: UID,
          token: 'tok_fb',
          refreshToken: 'ref_fb',
          expiresAt: Date.now() + 3600_000,
        }),
        enabled: true,
      }],
      models: [{ id: 'glm-5.2', enabled: true }],
    }
  }

  /** `/models` 目录：Agent 与 Work **两个分组都给同一个模型** —— 兜底换档位不换模型。 */
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

  it('Agent 只发心跳 → 自动回落 Work 档位并拿到内容（全部发生在返回 200 之前）', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const u = String(url)
      if (u.includes('/models')) {
        calls.push('models')
        return modelsResponse()
      }
      if (u.includes('/chat_sessions') && String(init?.method || '') === 'POST') {
        calls.push('create')
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: 's1', message_id: 'm1' } }), { status: 200 })
      }
      if (u.includes('/events')) {
        // Work 档位的身份标记是 lite（见 remoteHeaders）
        if (String(init?.headers?.['X-Trae-Client-Type'] ?? '') === 'lite') {
          calls.push('events-work')
          return new Response(
            'event: plan_item\ndata: {"id":"p1","content":"work tier ok"}\n\nevent: done\ndata: {}\n\n',
            { status: 200 }
          )
        }
        calls.push('events-agent')
        // Agent 档位：只发心跳。真机是**永不结束**，这里用「立刻结束」把同一判据快速复现
        //（`streamRemoteEvents` 在没有模型事件就结束时同样抛 RemoteFirstEventTimeout）。
        return new Response('event: heartbeat\ndata: {"status":2}\n\n', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    const resp = await proxyTraeChatRequest(makeEnv(), makeProvider(), {
      model: 'glm-5.2',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    })

    expect(resp.status).toBe(200)
    const text = await resp.text()
    // 内容来自兜底后的 Work 档位
    expect(text).toContain('work tier ok')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('[DONE]')
    // 先试 Agent、再兜底 Work：两次建会话、两条事件流
    expect(calls.filter((c) => c === 'create')).toHaveLength(2)
    expect(calls).toContain('events-agent')
    expect(calls).toContain('events-work')
  })

  it('两次都起不来 → 不谎报成功（503，且不是「账号池无可用账号」的误判）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const u = String(url)
      if (u.includes('/models')) return modelsResponse()
      if (u.includes('/chat_sessions') && String(init?.method || '') === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: 's1', message_id: 'm1' } }), { status: 200 })
      }
      if (u.includes('/events')) return new Response('event: heartbeat\ndata: {"status":2}\n\n', { status: 200 })
      return new Response('{}', { status: 200 })
    }))

    const resp = await proxyTraeChatRequest(makeEnv(), makeProvider(), {
      model: 'glm-5.2',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(resp.status).toBe(503)
    const body = await resp.text()
    // transport 类定责：不把「上游没起来」说成「账号池没账号」（那会把排查引向账号）
    expect(body).toContain('upstream_unreachable')
  })
})
