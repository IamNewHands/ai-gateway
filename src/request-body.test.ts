import { describe, it, expect } from 'vitest'
import { RequestBodyError, MAX_AI_REQUEST_BYTES, MAX_RESPONSES_REQUEST_BYTES, MAX_ADMIN_REQUEST_BYTES, MAX_IMAGE_REQUEST_BYTES, MAX_IMAGE_BINARY_BYTES, base64ByteLength, readTextLimited, readJSONLimited, readStrictJSONLimited, readOptionalJSONLimited, readBytesLimited, readFormDataLimited } from './request-body'

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
  it('普通推理上限 8MiB，Responses 与之一致，管理入口与推理同值', () => {
    expect(MAX_AI_REQUEST_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_RESPONSES_REQUEST_BYTES).toBe(MAX_AI_REQUEST_BYTES)
    expect(MAX_ADMIN_REQUEST_BYTES).toBe(MAX_AI_REQUEST_BYTES)
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

describe('readStrictJSONLimited：空正文与非法 JSON 都算 INVALID_JSON', () => {
  it('合法 JSON → 解析成功', async () => {
    expect(await readStrictJSONLimited<{ a: number }>(req('{"a":1}'), MAX_ADMIN_REQUEST_BYTES)).toEqual({ a: 1 })
  })

  it('空正文 → INVALID_JSON（与 readJSONLimited 的 {} 兜底不同）', async () => {
    await expect(readStrictJSONLimited(req(null), MAX_ADMIN_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('非法 JSON → INVALID_JSON', async () => {
    await expect(readStrictJSONLimited(req('{oops'), MAX_ADMIN_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('超限 → REQUEST_TOO_LARGE（保留原始错误码，不被归一成 INVALID_JSON）', async () => {
    await expect(readStrictJSONLimited(req('{}', String(MAX_ADMIN_REQUEST_BYTES + 1)), MAX_ADMIN_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })
})

describe('readOptionalJSONLimited：只补上界，不改既有容错语义', () => {
  it('合法 JSON → 解析成功', async () => {
    expect(await readOptionalJSONLimited<{ a: number }>(req('{"a":1}'), MAX_ADMIN_REQUEST_BYTES)).toEqual({ a: 1 })
  })

  it('空正文 → 回退 {}（等价于既有 .catch(() => ({}))）', async () => {
    expect(await readOptionalJSONLimited(req(null), MAX_ADMIN_REQUEST_BYTES)).toEqual({})
  })

  it('非法 JSON → 回退 {}（不抛错，保持既有行为）', async () => {
    expect(await readOptionalJSONLimited(req('{oops'), MAX_ADMIN_REQUEST_BYTES)).toEqual({})
  })

  it('可指定自定义 fallback', async () => {
    expect(await readOptionalJSONLimited(req('{oops'), MAX_ADMIN_REQUEST_BYTES, { mode: 'default' }))
      .toEqual({ mode: 'default' })
  })

  it('超限 → 仍抛 REQUEST_TOO_LARGE（上界不可被容错吞掉）', async () => {
    await expect(readOptionalJSONLimited(req('{}', String(MAX_ADMIN_REQUEST_BYTES + 1)), MAX_ADMIN_REQUEST_BYTES))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('流式超限 → 仍抛 REQUEST_TOO_LARGE', async () => {
    await expect(readOptionalJSONLimited(chunkedReq(['aaaa', 'bbbb', 'cccc']), 8))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })
})

describe('图片入口常量与 base64ByteLength', () => {
  it('图片 wire 上限 8MiB，单图解码后 4MiB', () => {
    expect(MAX_IMAGE_REQUEST_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_IMAGE_BINARY_BYTES).toBe(4 * 1024 * 1024)
  })

  it('base64ByteLength 与实际解码长度一致（含三种 padding）', () => {
    // 仅取长度是 4 的倍数、可被 atob 接受的合法 base64 作为对照
    const cases = ['', 'AAAA', 'iVBORw0KGgo=', 'aGVsbG8gd29ybGQ=', 'QUJD', 'QUJDRA==', 'QUJDRQ==', 'QUJDREVG']
    for (const c of cases) {
      const expected = Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)).length
      expect(base64ByteLength(c)).toBe(expected)
    }
  })

  it('base64ByteLength 是 O(1) 估算：不做逐字符校验，非法/截断输入不报错', () => {
    // 与 strictBase64Bytes 的分工：此处只做体积预算，内容校验交给上游
    expect(base64ByteLength('!!!!')).toBe(3)
    expect(base64ByteLength('A')).toBe(0)
  })
})

describe('readBytesLimited：二进制有界读取（multipart 用）', () => {
  it('按字节返回，不做 UTF-8 解码（非 UTF-8 图片字节不报错）', async () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])
    const request = new Request('https://example.com/upload', { method: 'POST', body: raw })
    const out = await readBytesLimited(request, 1024)
    expect(Array.from(out)).toEqual(Array.from(raw))
  })

  it('分片总量超限 → REQUEST_TOO_LARGE', async () => {
    await expect(readBytesLimited(chunkedReq(['aaaa', 'bbbb', 'cccc']), 8))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('空正文 → 空数组', async () => {
    expect((await readBytesLimited(req(null), 1024)).length).toBe(0)
  })

  it('非法 maxBytes → RangeError', async () => {
    await expect(readBytesLimited(req('{}'), -1)).rejects.toBeInstanceOf(RangeError)
  })
})

describe('readFormDataLimited：有界 multipart 解析', () => {
  function multipartReq(parts: string, boundary: string): Request {
    return new Request('https://example.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: parts,
    })
  }

  it('限内 multipart → 字段与文件均可读取', async () => {
    const b = '----b1'
    const body =
      `--${b}\r\n` +
      'Content-Disposition: form-data; name="prompt"\r\n\r\n' +
      'a cat\r\n' +
      `--${b}\r\n` +
      'Content-Disposition: form-data; name="image"; filename="a.png"\r\n' +
      'Content-Type: image/png\r\n\r\n' +
      'PNGDATA\r\n' +
      `--${b}--\r\n`

    const form = await readFormDataLimited(multipartReq(body, b), 4096)
    expect(form.get('prompt')).toBe('a cat')
    const file = form.get('image') as unknown as File
    expect(file.size).toBe(7)
    expect(file.type).toBe('image/png')
  })

  it('超限 → REQUEST_TOO_LARGE（先于解析，不缓冲整段）', async () => {
    const b = '----b2'
    const body =
      `--${b}\r\n` +
      'Content-Disposition: form-data; name="image"; filename="a.png"\r\n\r\n' +
      'A'.repeat(4096) + '\r\n' +
      `--${b}--\r\n`

    await expect(readFormDataLimited(multipartReq(body, b), 512))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('声明长度超限 → REQUEST_TOO_LARGE（不读正文）', async () => {
    const b = '----b3'
    const request = new Request('https://example.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': '999999' },
      body: `--${b}--\r\n`,
    })
    await expect(readFormDataLimited(request, 512))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })

  it('内容不是合法 multipart → INVALID_MULTIPART（映射 400，而非 500）', async () => {
    const request = new Request('https://example.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=----b4' },
      body: 'this is definitely not multipart',
    })
    await expect(readFormDataLimited(request, 4096))
      .rejects.toMatchObject({ code: 'INVALID_MULTIPART' })
  })
})
