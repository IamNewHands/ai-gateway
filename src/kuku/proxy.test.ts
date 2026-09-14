import { describe, expect, it, vi } from 'vitest'
import type { Provider } from '../types'
import { proxyKukuChatRequest } from './proxy'

function provider(): Provider {
  return {
    id: 'kuku',
    name: 'Kuku',
    baseUrl: 'https://kuku.baidu.com',
    type: 'kuku',
    apiKeys: [{ key: 'BDUSS=secret-cookie', enabled: true }],
    models: [{ id: 'glm-5.3', enabled: true }],
    enabled: true,
    createdAt: '',
    updatedAt: '',
  }
}

function mockUpstream(sse = [
  'data: {"type":"TEXT_BLOCK_DELTA","data":{"delta":"hello"}}\n\n',
  'data: {"type":"TEXT_BLOCK_DELTA","data":{"delta":" world"}}\n\n',
  'data: {"type":"REPLY_END"}\n\n',
].join('')) {
  const paths: string[] = []
  const signals: Array<AbortSignal | null | undefined> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    signals.push(init?.signal)
    if (url.pathname.endsWith('/common/userreport')) {
      return Response.json({ errno: 0, data: { bdstoken: 'token', uinfo: 'user', uk: 42 } })
    }
    if (url.pathname.endsWith('/sendmsg')) {
      return Response.json({ status: { code: 0 }, data: { session_id: 'session', reply_id: 'reply' } })
    }
    if (url.pathname.endsWith('/idallochstr')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/sessionswitch')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/getchatcontent')) {
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('unexpected request', { status: 500 })
  })
  return { fetchMock: fetchMock as unknown as typeof fetch, paths, signals }
}

const body = {
  model: 'glm-5.3',
  messages: [{ role: 'user', content: 'hello' }],
}

describe('proxyKukuChatRequest', () => {
  it('executes the complete upstream sequence and aggregates non-streaming output', async () => {
    const upstream = mockUpstream()
    const response = await proxyKukuChatRequest(provider(), { ...body, stream: false }, upstream.fetchMock)

    expect(response.status).toBe(200)
    expect((await response.json() as any).choices[0].message.content).toBe('hello world')
    expect(upstream.paths).toEqual([
      '/api/genflowpro/common/userreport',
      '/wenchain/genflowpro/sendmsg',
      '/wenchain/genflow/idallochstr',
      '/api/genflowpro/workspace/sessionswitch',
      '/wenchain/genflowpro/sse/getchatcontent',
    ])
  })

  it('converts upstream deltas and termination to OpenAI SSE', async () => {
    const upstream = mockUpstream()
    const response = await proxyKukuChatRequest(provider(), { ...body, stream: true }, upstream.fetchMock)
    const text = await response.text()

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
  })

  it('passes the client abort signal to every upstream request', async () => {
    const upstream = mockUpstream()
    const controller = new AbortController()

    const response = await proxyKukuChatRequest(
      provider(),
      { ...body, stream: false },
      upstream.fetchMock,
      controller.signal,
    )

    expect(response.status).toBe(200)
    expect(upstream.signals).toHaveLength(5)
    expect(upstream.signals.every((signal) => signal === controller.signal)).toBe(true)
  })

  it('rejects tools and multimodal messages before any upstream request', async () => {
    const tools = mockUpstream()
    const toolsResponse = await proxyKukuChatRequest(provider(), { ...body, tools: [] }, tools.fetchMock)
    expect(toolsResponse.status).toBe(400)
    expect(tools.paths).toEqual([])

    const image = mockUpstream()
    const imageResponse = await proxyKukuChatRequest(provider(), {
      ...body,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }],
    }, image.fetchMock)
    expect(imageResponse.status).toBe(400)
    expect(image.paths).toEqual([])
  })

  it('returns a sanitized 502 for upstream HTTP and protocol failures', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream denied', { status: 403 })) as unknown as typeof fetch
    const response = await proxyKukuChatRequest(provider(), { ...body, stream: false }, fetchMock)
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(text).toContain('upstream_error')
    expect(text).not.toContain('secret-cookie')

    const errorEvent = mockUpstream('data: {"type":"ERROR","message":"denied"}\n\n')
    const eventResponse = await proxyKukuChatRequest(provider(), { ...body, stream: false }, errorEvent.fetchMock)
    expect(eventResponse.status).toBe(502)
    expect(await eventResponse.text()).not.toContain('secret-cookie')
  })
})
