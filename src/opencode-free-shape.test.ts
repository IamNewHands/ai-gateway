import { describe, it, expect } from 'vitest'
import {
  filterSyntheticToolCalls,
  isOpenCodeFreeModel,
  proxyOpenCodeRequest,
  shapeOpenCodeFreeBody,
} from './opencode'

/**
 * OpenCode 免费档 agent 形状整形（2026-09-26 上游实测锁定）。
 *
 * 上游对免费档模型校验请求体：stream:true + tools 里同时存在 name=bash 与 name=read，
 * 否则 403 FreeTierError（"OpenCode's free tier can only be used from within OpenCode"）。
 * 本测试锁定整形逻辑、合成工具调用过滤、以及非流式折叠三条链路。
 */

const enc = new TextEncoder()

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

function dataLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((p) => p && p !== '[DONE]')
    .map((p) => JSON.parse(p) as Record<string, unknown>)
}

describe('isOpenCodeFreeModel', () => {
  it('免费档口径与 filterOpenCodeModels 一致', () => {
    expect(isOpenCodeFreeModel('big-pickle')).toBe(true)
    expect(isOpenCodeFreeModel('mimo-v2.6-flash-free')).toBe(true)
    expect(isOpenCodeFreeModel('claude-opus-5')).toBe(false)
  })
})

describe('shapeOpenCodeFreeBody', () => {
  it('免费模型 + 无 tools + 非流式：强制流式并补齐 bash/read', () => {
    const shape = shapeOpenCodeFreeBody(
      JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      'chat/completions',
    )
    const body = JSON.parse(shape.body as string) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    const names = (body['tools'] as Array<Record<string, unknown>>).map(
      (t) => ((t['function'] as Record<string, unknown>)['name']),
    )
    expect(names).toEqual(['bash', 'read'])
    expect(shape.collapseStream).toBe(true)
    expect(shape.syntheticTools).toEqual(['bash', 'read'])
  })

  it('免费模型 + 已含 bash/read + 已流式：原样返回，不做任何改动', () => {
    const raw = JSON.stringify({
      model: 'big-pickle',
      stream: true,
      tools: [
        { type: 'function', function: { name: 'bash', description: 'x', parameters: {} } },
        { type: 'function', function: { name: 'read', description: 'x', parameters: {} } },
      ],
    })
    const shape = shapeOpenCodeFreeBody(raw, 'chat/completions')
    expect(shape.body).toBe(raw)
    expect(shape.syntheticTools).toEqual([])
    expect(shape.collapseStream).toBe(false)
  })

  it('免费模型 + tools[bash,write]：只补 read（write 不能替代 read）', () => {
    const shape = shapeOpenCodeFreeBody(
      JSON.stringify({
        model: 'mimo-v2.6-flash-free',
        stream: true,
        tools: [
          { type: 'function', function: { name: 'bash', parameters: {} } },
          { type: 'function', function: { name: 'write', parameters: {} } },
        ],
      }),
      'chat/completions',
    )
    expect(shape.syntheticTools).toEqual(['read'])
    const body = JSON.parse(shape.body as string) as Record<string, unknown>
    expect((body['tools'] as unknown[]).length).toBe(3)
  })

  it('付费模型：请求体逐字透传（不加 stream、不加 tools）', () => {
    const raw = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] })
    const shape = shapeOpenCodeFreeBody(raw, 'chat/completions')
    expect(shape.body).toBe(raw)
    expect(shape.syntheticTools).toEqual([])
  })

  it('非 JSON / 空 body：原样返回', () => {
    expect(shapeOpenCodeFreeBody('not json', 'chat/completions').body).toBe('not json')
    expect(shapeOpenCodeFreeBody(undefined, 'chat/completions').body).toBeUndefined()
  })

  it('responses 路径：合成扁平形状的工具定义（name 在顶层）', () => {
    const shape = shapeOpenCodeFreeBody(
      JSON.stringify({ model: 'big-pickle', input: [], stream: true }),
      'responses',
    )
    const body = JSON.parse(shape.body as string) as Record<string, unknown>
    const tools = body['tools'] as Array<Record<string, unknown>>
    expect(tools.map((t) => t['name'])).toEqual(['bash', 'read'])
    expect(tools[0]['function']).toBeUndefined()
  })
})

describe('filterSyntheticToolCalls', () => {
  const SYNTHETIC_CALL = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n',
    '\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n',
    '\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
    '\n',
    'data: [DONE]\n',
  ]

  it('合成工具的 tool_calls 全被丢弃，finish_reason 降级为 stop', async () => {
    const out = await readText(filterSyntheticToolCalls(sseStream(SYNTHETIC_CALL), ['bash', 'read']))
    const frames = dataLines(out)
    expect(JSON.stringify(frames)).not.toContain('bash')
    expect(JSON.stringify(frames)).not.toContain('call_1')
    const finish = frames.map((f) => ((f['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason'])).filter(Boolean)
    expect(finish).toEqual(['stop'])
    expect(out).toContain('[DONE]')
  })

  it('真实工具的 tool_calls 保留，finish_reason 不变', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n',
      '\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      '\n',
    ]
    const out = await readText(filterSyntheticToolCalls(sseStream(frames), ['bash']))
    const parsed = dataLines(out)
    expect(JSON.stringify(parsed)).toContain('call_9')
    const finish = parsed.map((f) => ((f['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason'])).filter(Boolean)
    expect(finish).toEqual(['tool_calls'])
  })

  it('无合成工具时原流直返（不做逐行重写）', () => {
    const src = sseStream(['data: {}\n'])
    expect(filterSyntheticToolCalls(src, [])).toBe(src)
  })

  it('注释行与跨 chunk 的半行都能原样保留', async () => {
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(': keep-alive\n\ndata: {"choices":[{"index":0,"delta":{"cont'))
        c.enqueue(enc.encode('ent":"he"}}]}\n\ndata: [DONE]\n'))
        c.close()
      },
    })
    const out = await readText(filterSyntheticToolCalls(src, ['bash']))
    expect(out).toContain(': keep-alive')
    expect(out).toContain('"content":"he"')
    expect(out).toContain('[DONE]')
  })
})

describe('proxyOpenCodeRequest 免费档整形端到端', () => {
  const KEYS = [{ key: 'k1', enabled: true }]

  it('非流式客户端：上游收到 agent 形状，响应折回单个 chat.completion', async () => {
    let sent: Record<string, unknown> | null = null
    let sentHeaders: Headers | null = null
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      sentHeaders = new Headers(init?.headers)
      return new Response(
        sseStream([
          'data: {"id":"c1","model":"big-pickle","created":42,"choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const res = await proxyOpenCodeRequest({
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKeys: KEYS,
      mirrorUrls: [],
      method: 'POST',
      subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })

    expect(sent!['stream']).toBe(true)
    const toolNames = (sent!['tools'] as Array<Record<string, unknown>>).map(
      (t) => ((t['function'] as Record<string, unknown>)['name']),
    )
    expect(toolNames).toContain('bash')
    expect(toolNames).toContain('read')
    expect(sentHeaders!.get('Accept')).toContain('text/event-stream')
    expect(sentHeaders!.get('x-opencode-client')).toBe('cli')
    // 上游免费档校验的两条出站指纹：UA 版本 ≥ 1.18.0、ID 为 opencode 规范格式
    expect(sentHeaders!.get('User-Agent')).toContain('opencode/1.18.')
    expect(sentHeaders!.get('x-opencode-request')).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(sentHeaders!.get('x-opencode-session')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const payload = await res.json() as Record<string, unknown>
    expect(payload['object']).toBe('chat.completion')
    const choice = (payload['choices'] as Array<Record<string, unknown>>)[0]
    expect((choice['message'] as Record<string, unknown>)['content']).toBe('hello')
  })

  it('流式客户端：合成工具的 tool_call 被剔除，正文保留', async () => {
    const fetcher = (async () => new Response(
      sseStream([
        'data: {"id":"c1","model":"big-pickle","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n',
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    const res = await proxyOpenCodeRequest({
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKeys: KEYS,
      mirrorUrls: [],
      method: 'POST',
      subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })

    const text = await readText(res.body as ReadableStream<Uint8Array>)
    expect(text).toContain('"content":"ok"')
    expect(text).not.toContain('call_1')
    expect(text).toContain('"finish_reason":"stop"')
  })

  it('付费模型：请求体逐字透传，响应不做任何改写', async () => {
    let sentBody = ''
    const original = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] })
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body)
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const res = await proxyOpenCodeRequest({
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKeys: KEYS,
      mirrorUrls: [],
      method: 'POST',
      subPath: 'chat/completions',
      body: original,
      fetcher,
    })

    expect(sentBody).toBe(original)
    expect(await res.text()).toBe('{"ok":true}')
  })
})
