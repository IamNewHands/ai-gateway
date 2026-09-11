import { describe, it, expect } from 'vitest'
import { RequestBodyError, MAX_AI_REQUEST_BYTES, MAX_RESPONSES_REQUEST_BYTES, MAX_COMPACTION_REQUEST_BYTES, readTextLimited, readJSONLimited } from './request-body'

function req(body: string | null, contentLength?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (contentLength !== undefined) headers.set('Content-Length', contentLength)
  return new Request('https://example.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: body === null ? undefined : body,
  })
}

function chunkedReq(chunks: string[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Request('https://example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    // @ts-expect-error duplex is required by undici for streamed request bodies
    duplex: 'half',
  })
}

describe('request-body 常量（同原版 request-body.ts）', () => {
  it('普通推理上限 8MiB，Responses 与之一致，压缩 16MiB', () => {
    expect(MAX_AI_REQUEST_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_RESPONSES_REQUEST_BYTES).toBe(MAX_AI_REQUEST_BYTES)
    expect(MAX_COMPACTION_REQUEST_BYTES).toBe(16 * 1024 * 1024)
  })
})

describe('readTextLimited：Content-Length 预检', () => {
  it('声明长度超限 → REQUEST_TOO_LARGE，且不读取正文', async () => {
    await expect(readTextLimited(req('{}', String(MAX_AI_REQUEST_BYTES + 1)), MAX_AI_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('声明长度非法 → INVALID_JSON', async () => {
    await expect(readTextLimited(req('{}', 'not-a-number'), MAX_AI_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('声明长度合规 → 正常读取', async () => {
    expect(await readTextLimited(req('hello', '5'), MAX_AI_REQUEST_BYTES)).toBe('hello')
  })

  it('空正文返回空串', async () => {
    expect(await readTextLimited(req(null), MAX_AI_REQUEST_BYTES)).toBe('')
  })
})

describe('readTextLimited：流式累计上界（无 Content-Length）', () => {
  it('分片总量超限 → REQUEST_TOO_LARGE（不依赖长度头）', async () => {
    await expect(readTextLimited(chunkedReq(['aaaa', 'bbbb', 'cccc']), 8))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('分片总量在限内 → 拼接正确（含多字节字符）', async () => {
    expect(await readTextLimited(chunkedReq(['你', '好', '世界']), 64)).toBe('你好世界')
  })

  it('非法 maxBytes → RangeError', async () => {
    await expect(readTextLimited(req('{}'), -1)).rejects.toBeInstanceOf(RangeError)
  })
})

describe('readJSONLimited：有界解析', () => {
  it('合法 JSON → 解析成功', async () => {
    expect(await readJSONLimited<{ a: number }>(req('{"a":1}', '7'), MAX_AI_REQUEST_BYTES)).toEqual({ a: 1 })
  })

  it('空正文按 {} 处理', async () => {
    expect(await readJSONLimited<Record<string, unknown>>(req(null), MAX_AI_REQUEST_BYTES)).toEqual({})
  })

  it('非法 JSON → INVALID_JSON', async () => {
    await expect(readJSONLimited(req('{oops'), MAX_AI_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('超限 → REQUEST_TOO_LARGE（保留原始错误码）', async () => {
    await expect(readJSONLimited(req('{}', String(MAX_AI_REQUEST_BYTES + 1)), MAX_AI_REQUEST_BYTES))
      .rejects.toBeInstanceOf(RequestBodyError)
  })
})
