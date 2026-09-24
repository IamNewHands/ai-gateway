import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetOpenCodeKeyHealthForTests,
  applyOpenCodeReasoningEffort,
  canonicalOpenCodeSessionId,
  openCodeAffinitySignal,
  proxyOpenCodeRequest,
  testOpenCodeKey,
} from './opencode'

/**
 * 第二批移植（opencode2api → ai-gateway OpenCode 提供商）的回归测试：
 * P0-1 折叠异常语义 / P0-2 会话亲和 / P1-1 per-key 冷却 / P1-2a 403 懒整形 / P1-3 单 key 诊断 / P1-5 effort 默认值。
 */

const enc = new TextEncoder()
const KEYS = [{ key: 'key-aaaa', enabled: true }, { key: 'key-bbbb', enabled: true }]
const BASE = 'https://opencode.ai/zen/v1'

interface RecordedCall {
  url: string
  body: string
  authorization: string
}

/** 记录每次出站调用并按 index 返回预设响应的 stub fetcher */
function makeFetcher(handler: (call: RecordedCall, index: number) => Response) {
  const calls: RecordedCall[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: RecordedCall = {
      url: String(url),
      body: String(init?.body ?? ''),
      authorization: headers.get('Authorization') ?? '',
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

const FREETIER = { type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } }

const DONE_FRAMES = [
  'data: {"id":"c1","model":"big-pickle","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n',
]

beforeEach(() => {
  __resetOpenCodeKeyHealthForTests()
})

describe('canonicalOpenCodeSessionId', () => {
  it('已是 canonical 形状的会话 ID 原样保留（保住上游 prompt cache 亲和）', async () => {
    const real = 'ses_0d40c74ca001DRbKK0WJdc6KfN'
    expect(await canonicalOpenCodeSessionId(real)).toBe(real)
  })

  it('任意信号确定性映射成 canonical 形状', async () => {
    const a = await canonicalOpenCodeSessionId('conv-123')
    const b = await canonicalOpenCodeSessionId('conv-123')
    const c = await canonicalOpenCodeSessionId('conv-456')
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('openCodeAffinitySignal', () => {
  it('previous_response_id 优先', () => {
    expect(openCodeAffinitySignal(JSON.stringify({
      previous_response_id: 'resp_1',
      messages: [{ role: 'user', content: 'hi' }],
    }))).toBe('resp_1')
  })

  it('无 previous_response_id 时取首条 user 内容', () => {
    expect(openCodeAffinitySignal(JSON.stringify({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hello' }],
    }))).toBe('hello')
  })

  it('Responses 的字符串 input 可用；无信号返回空串', () => {
    expect(openCodeAffinitySignal(JSON.stringify({ input: 'plain' }))).toBe('plain')
    expect(openCodeAffinitySignal(JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }))).toBe('')
    expect(openCodeAffinitySignal('not json')).toBe('')
    expect(openCodeAffinitySignal(undefined)).toBe('')
  })
})

describe('applyOpenCodeReasoningEffort', () => {
  it('客户端未声明时注入提供商默认档位', () => {
    const out = JSON.parse(applyOpenCodeReasoningEffort(JSON.stringify({ model: 'big-pickle' }), 'high')!) as Record<string, unknown>
    expect(out['reasoning_effort']).toBe('high')
  })

  it('客户端已显式声明时不覆盖（含嵌套 reasoning.effort）', () => {
    const flat = JSON.stringify({ model: 'm', reasoning_effort: 'low' })
    expect(applyOpenCodeReasoningEffort(flat, 'high')).toBe(flat)
    const camel = JSON.stringify({ model: 'm', reasoningEffort: 'low' })
    expect(applyOpenCodeReasoningEffort(camel, 'high')).toBe(camel)
    const nested = JSON.stringify({ model: 'm', reasoning: { effort: 'low' } })
    expect(applyOpenCodeReasoningEffort(nested, 'high')).toBe(nested)
  })

  it('非法档位不写入（避免上游 400 literal_error）', () => {
    const raw = JSON.stringify({ model: 'm' })
    expect(applyOpenCodeReasoningEffort(raw, 'bogus')).toBe(raw)
    expect(applyOpenCodeReasoningEffort(raw, undefined)).toBe(raw)
  })
})

describe('P0-1 非流式折叠的异常终止语义', () => {
  it('上游直接断流（无 DONE / 无 finish_reason）→ 502 upstream_error，不伪装成 200 空回复', async () => {
    const { fetcher } = makeFetcher(() => sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
    ]))
    const res = await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(res.status).toBe(502)
    const payload = await res.json() as { error: { type: string; message: string } }
    expect(payload.error.type).toBe('upstream_error')
    expect(payload.error.message).toContain('before completion')
  })

  it('流内 error 事件 → 502，且带出上游错误原文', async () => {
    const { fetcher } = makeFetcher(() => sseResponse([
      'data: {"error":{"message":"upstream boom","type":"server_error"}}\n\n',
      'data: [DONE]\n',
    ]))
    const res = await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).toContain('upstream boom')
  })

  it('正常收尾仍折回 200 chat.completion', async () => {
    const { fetcher } = makeFetcher(() => sseResponse(DONE_FRAMES))
    const res = await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { object: string }).object).toBe('chat.completion')
  })
})

describe('P0-2 会话亲和决定 key 起点', () => {
  it('同一会话信号稳定命中同一个 key', async () => {
    const run = async () => {
      const { fetcher, calls } = makeFetcher(() => sseResponse(DONE_FRAMES))
      await proxyOpenCodeRequest({
        baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
        body: JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        affinityKey: 'stable-conversation',
        fetcher,
      })
      return calls[0].authorization
    }
    expect(await run()).toBe(await run())
  })

  it('不同会话信号会分散到不同 key（起点由哈希决定）', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const { fetcher, calls } = makeFetcher(() => sseResponse(DONE_FRAMES))
      await proxyOpenCodeRequest({
        baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
        body: JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        affinityKey: `conv-${i}`,
        fetcher,
      })
      seen.add(calls[0].authorization)
    }
    expect(seen.size).toBe(2)
  })

  it('无会话信号时保持原有顺序（key#1 优先）', async () => {
    const { fetcher, calls } = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true }),
      fetcher,
    })
    expect(calls[0].authorization).toBe('Bearer key-aaaa')
  })
})

describe('P1-1 per-key 冷却', () => {
  it('401 的 key 被冷却，下一次请求直接跳过它', async () => {
    const first = makeFetcher((call) =>
      call.authorization === 'Bearer key-aaaa'
        ? jsonResponse(401, { error: { message: 'Invalid API key.' } })
        : sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: first.fetcher,
    })
    expect(first.calls.map((c) => c.authorization)).toEqual(['Bearer key-aaaa', 'Bearer key-bbbb'])

    const second = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: second.fetcher,
    })
    expect(second.calls.map((c) => c.authorization)).toEqual(['Bearer key-bbbb'])
  })

  it('成功会清零失败计数，冷却不会无限增长', async () => {
    const fail = makeFetcher(() => jsonResponse(401, { error: { message: 'Invalid API key.' } }))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions', body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: fail.fetcher,
    })
    // 单 key 全部冷却时按最早到期顶班：仍会尝试该 key，成功后应清零
    const ok = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions', body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: ok.fetcher,
    })
    const again = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions', body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: again.fetcher,
    })
    expect(again.calls.length).toBe(1)
  })

  it('403 FreeTierError 不冷却 key（免费档形状问题不该打死整个提供商）', async () => {
    const first = makeFetcher(() => jsonResponse(403, FREETIER))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: first.fetcher,
    })
    const second = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: KEYS, mirrorUrls: [], method: 'POST', subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true }), fetcher: second.fetcher,
    })
    expect(second.calls[0].authorization).toBe('Bearer key-aaaa')
  })
})

describe('P1-2a 403 FreeTierError 懒整形兜底', () => {
  const paidBody = () => JSON.stringify({
    model: 'some-paid-model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })

  it('名字不含 free 的模型被上游判免费档时，用强制整形体原地重试一次并成功', async () => {
    const { fetcher, calls } = makeFetcher((_call, index) =>
      index === 0 ? jsonResponse(403, FREETIER) : sseResponse(DONE_FRAMES))
    const res = await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions', body: paidBody(), fetcher,
    })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
    // 第一次原样透传
    expect(JSON.parse(calls[0].body)).not.toHaveProperty('tools')
    // 第二次带上 agent 形状
    const retryBody = JSON.parse(calls[1].body) as Record<string, unknown>
    expect(retryBody['stream']).toBe(true)
    const names = (retryBody['tools'] as Array<Record<string, unknown>>).map(
      (t) => ((t['function'] as Record<string, unknown>)['name']))
    expect(names).toEqual(['bash', 'read'])
  })

  it('非 FreeTierError 的 403 不触发重试', async () => {
    const { fetcher, calls } = makeFetcher(() => jsonResponse(403, { error: { message: 'forbidden by policy' } }))
    const res = await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions', body: paidBody(), fetcher,
    })
    expect(res.status).toBe(403)
    expect(calls.length).toBe(1)
  })

  it('免费模型本身已整形，不会多打一次重试', async () => {
    const { fetcher, calls } = makeFetcher(() => sseResponse(DONE_FRAMES))
    await proxyOpenCodeRequest({
      baseUrl: BASE, apiKeys: [{ key: 'key-aaaa', enabled: true }], mirrorUrls: [], method: 'POST',
      subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(calls.length).toBe(1)
  })
})

describe('P1-3 testOpenCodeKey 单 key 诊断分类', () => {
  const call = (fetcher: typeof fetch) => testOpenCodeKey(BASE, 'key-aaaa', 'big-pickle', fetcher)

  it('200 → usable', async () => {
    const { fetcher, calls } = makeFetcher(() => sseResponse(DONE_FRAMES))
    const result = await call(fetcher)
    expect(result.status).toBe('usable')
    // 诊断请求必须带 agent 形状，否则免费档模型永远判不出 usable
    const body = JSON.parse(calls[0].body) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['tools']).toBeDefined()
  })

  it('401 → rejected；429 → rate_limited；5xx → upstream_error', async () => {
    const r401 = await call(makeFetcher(() => jsonResponse(401, { error: { message: 'Invalid API key.' } })).fetcher)
    expect(r401.status).toBe('rejected')
    const r429 = await call(makeFetcher(() => jsonResponse(429, { error: { message: 'rate limited' } })).fetcher)
    expect(r429.status).toBe('rate_limited')
    const r500 = await call(makeFetcher(() => jsonResponse(500, { error: { message: 'boom' } })).fetcher)
    expect(r500.status).toBe('upstream_error')
  })

  it('403 FreeTierError → request_error（不是 key 的问题）', async () => {
    const result = await call(makeFetcher(() => jsonResponse(403, FREETIER)).fetcher)
    expect(result.status).toBe('request_error')
  })

  it('网络异常 → transport_error；无模型 → unavailable', async () => {
    const throwing = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    expect((await call(throwing)).status).toBe('transport_error')
    expect((await testOpenCodeKey(BASE, 'k', '', throwing)).status).toBe('unavailable')
  })

  it('只发一次请求：不轮换、不走镜像、不重试', async () => {
    const { fetcher, calls } = makeFetcher(() => jsonResponse(401, { error: { message: 'Invalid API key.' } }))
    await call(fetcher)
    expect(calls.length).toBe(1)
  })
})
