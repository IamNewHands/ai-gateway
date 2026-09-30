/**
 * deepseek/client.test.ts — 图片上传 + 就绪轮询（Go `wire_upload_test.go` 的 TS 对位）。
 *
 * 假 fetch 顶替 chat.deepseek.com：PoW 挑战现场造得可解（answer 42），于是
 * 「解 PoW → multipart 上传 → GET fetch_files 轮询」这条链在没有网络的情况下被完整覆盖。
 */

import { describe, expect, it } from 'vitest'
import { base64Decode, fromUtf8, toHex, utf8 } from './bytes'
import {
  DeepseekClient,
  FILE_STATUS_PATH,
  UPLOAD_FILE_PATH,
  type FetchLike,
} from './client'
import { hashV1 } from './pow'

/** 造一个可解的 PoW 挑战（answer 42，难度 1000 —— 解算毫秒级）。 */
function solvableChallenge(targetPath: string) {
  const salt = 'testsalt'
  const expireAt = 1700000000
  const answer = 42
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: toHex(hashV1(utf8(`testsalt_${expireAt}_${answer}`))),
    salt,
    expire_at: expireAt,
    difficulty: 1000,
    expire_after: 600000,
    signature: 'sig',
    target_path: targetPath,
  }
}

const envelope = (bizData: unknown) =>
  JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: bizData } })

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

interface Seen {
  path: string
  query: string
  headers: Record<string, string>
  body: unknown
}

interface UploadScript {
  /** fetch_files 依次返回的状态；用尽后重复最后一个（默认 'SUCCESS'）。 */
  statuses?: string[]
  /** upload_file 的 biz_data（默认 {id:'file-1'}）。 */
  uploadBizData?: unknown
  /** 覆盖 upload_file 的原始响应体（配合 uploadStatus 造错误）。 */
  uploadRaw?: string
  uploadStatus?: number
}

/** 假上游 fetch。 */
function makeFetch(script: UploadScript = {}) {
  const seen: Seen[] = []
  const statuses = script.statuses ?? []
  let statusCall = 0

  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url)
    const headers: Record<string, string> = {}
    const h = init.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
    seen.push({ path: u.pathname, query: u.search, headers, body: init.body })

    if (u.pathname === '/api/v0/chat/create_pow_challenge') {
      const target = (JSON.parse(String(init.body)) as { target_path: string }).target_path
      return json(envelope({ challenge: solvableChallenge(target) }))
    }
    if (u.pathname === UPLOAD_FILE_PATH) {
      if (script.uploadRaw !== undefined) {
        return json(script.uploadRaw, script.uploadStatus ?? 200)
      }
      return json(envelope('uploadBizData' in script ? script.uploadBizData : { id: 'file-1' }))
    }
    if (u.pathname === FILE_STATUS_PATH) {
      const status = statuses[Math.min(statusCall, statuses.length - 1)] ?? 'SUCCESS'
      statusCall++
      return json(envelope({ files: [{ id: 'file-1', status }] }))
    }
    return new Response('not found', { status: 404 })
  }

  return { fetchImpl, seen, statusCalls: () => statusCall }
}

const client = (fetchImpl: FetchLike) =>
  new DeepseekClient({
    baseUrl: 'https://chat.deepseek.com',
    account: { mobile: '13800000000', password: 'pw' },
    fetch: fetchImpl,
  })

const PNG = utf8('pngdata') // 7 字节，与 Go 版 x-file-size 断言同长

describe('uploadFile', () => {
  it('solves a fresh PoW and sends the app upload header set without a manual Content-Type', async () => {
    const { fetchImpl, seen } = makeFetch()
    const id = await client(fetchImpl).uploadFile('tok-a', PNG, 'image.png')
    expect(id).toBe('file-1')

    // 挑战请求的 target_path 就是上传路径（PoW 是路径绑定的）
    const challengeReq = seen.find((s) => s.path === '/api/v0/chat/create_pow_challenge')!
    expect((JSON.parse(String(challengeReq.body)) as { target_path: string }).target_path).toBe(
      UPLOAD_FILE_PATH,
    )

    const upload = seen.find((s) => s.path === UPLOAD_FILE_PATH)!
    expect(upload.headers['authorization']).toBe('Bearer tok-a')
    expect(upload.headers['x-thinking-enabled']).toBe('0')
    expect(upload.headers['x-file-size']).toBe('7')
    expect(upload.headers['x-model-type']).toBeUndefined() // Go 断言：必须缺席
    expect(upload.headers['content-type']).toBeUndefined() // 交给 fetch 带 multipart boundary
    // 安卓指纹块仍然在
    expect(upload.headers['x-client-platform']).toBe('android')
    expect(upload.headers['x-device-id']).toBeTruthy()
    expect(upload.headers['x-rangers-id']).toBeTruthy()

    // PoW 真的被解算了：重算 HashV1("<salt>_<expire_at>_<answer>") == challenge
    const pow = JSON.parse(fromUtf8(base64Decode(upload.headers['x-ds-pow-response']))) as {
      algorithm: string
      challenge: string
      salt: string
      answer: number
      signature: string
      target_path: string
      difficulty?: unknown
      expire_at?: unknown
    }
    expect(pow.target_path).toBe(UPLOAD_FILE_PATH)
    expect(pow.answer).toBe(42)
    expect(toHex(hashV1(utf8(`${pow.salt}_1700000000_${pow.answer}`)))).toBe(pow.challenge)
    expect(pow.difficulty).toBeUndefined() // 带上会被上游判为篡改挑战
    expect(pow.expire_at).toBeUndefined()
    expect(pow.signature).toBe('sig')
  })

  it('carries the bytes as a multipart part named "file" with the filename', async () => {
    const { fetchImpl, seen } = makeFetch()
    await client(fetchImpl).uploadFile('tok-a', PNG, 'image.png')

    const upload = seen.find((s) => s.path === UPLOAD_FILE_PATH)!
    expect(upload.body).toBeInstanceOf(FormData)
    const form = upload.body as FormData
    const part = form.get('file') as unknown as Blob & { name?: string }
    expect(part).toBeTruthy()
    expect(part.name).toBe('image.png')
    expect(part.type).toBe('application/octet-stream') // Go 的 CreateFormFile 也是这个
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG)
  })

  it('honours the contentType override on the part', async () => {
    const { fetchImpl, seen } = makeFetch()
    await client(fetchImpl).uploadFile('tok-a', PNG, 'image.png', 'image/png')
    const form = seen.find((s) => s.path === UPLOAD_FILE_PATH)!.body as FormData
    expect((form.get('file') as unknown as Blob).type).toBe('image/png')
  })

  it('maps a non-200 upload response to BizError carrying the http status', async () => {
    const { fetchImpl } = makeFetch({
      uploadRaw: JSON.stringify({ code: 0, msg: 'slow down', data: { biz_code: 0, biz_msg: '', biz_data: null } }),
      uploadStatus: 429,
    })
    await expect(client(fetchImpl).uploadFile('tok-a', PNG, 'image.png')).rejects.toMatchObject({
      name: 'BizError',
      httpStatus: 429,
    })
  })

  it('fails loudly when the upload body is not JSON', async () => {
    const { fetchImpl } = makeFetch({ uploadRaw: '<html>waf</html>', uploadStatus: 200 })
    await expect(client(fetchImpl).uploadFile('tok-a', PNG, 'image.png')).rejects.toThrow(
      /bad upload response/,
    )
  })
})

describe('uploadImageAndWait', () => {
  it('polls fetch_files until ready and returns the id', async () => {
    const { fetchImpl, seen, statusCalls } = makeFetch({ statuses: ['PENDING', 'PARSING', 'SUCCESS'] })
    const id = await client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', {
      pollIntervalMs: 5,
    })

    expect(id).toBe('file-1')
    expect(statusCalls()).toBe(3)
    const polls = seen.filter((s) => s.path === FILE_STATUS_PATH)
    expect(polls).toHaveLength(3)
    expect(polls.every((p) => p.query === '?file_ids=file-1')).toBe(true)
    expect(polls.every((p) => p.headers['authorization'] === 'Bearer tok-a')).toBe(true)
  })

  it('accepts COMPLETED and lower-case ready states', async () => {
    for (const status of ['completed', 'Success']) {
      const { fetchImpl } = makeFetch({ statuses: [status] })
      await expect(
        client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', { pollIntervalMs: 1 }),
      ).resolves.toBe('file-1')
    }
  })

  it('throws on a failed terminal status instead of polling forever', async () => {
    const { fetchImpl, statusCalls } = makeFetch({ statuses: ['PENDING', 'PARSE_FAILED'] })
    await expect(
      client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', { pollIntervalMs: 1 }),
    ).rejects.toThrow(/file file-1 failed to parse \(status PARSE_FAILED\)/)
    expect(statusCalls()).toBe(2)
  })

  it('throws a stuck-in-status error when the budget runs out (never an empty id)', async () => {
    const { fetchImpl, statusCalls } = makeFetch({ statuses: ['PENDING'] })
    await expect(
      client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', {
        totalTimeoutMs: 30,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/file file-1 stuck in PENDING/)
    expect(statusCalls()).toBeGreaterThanOrEqual(2)
  })

  it('stops polling when the signal aborts', async () => {
    const ac = new AbortController()
    const { fetchImpl, statusCalls } = makeFetch({ statuses: ['PENDING'] })
    const pending = client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', {
      pollIntervalMs: 20_000,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 5)
    await expect(pending).rejects.toThrow(/aborted/)
    expect(statusCalls()).toBe(1)
  })

  it('propagates the upload failure before ever polling', async () => {
    const { fetchImpl, seen } = makeFetch({ uploadBizData: null })
    await expect(
      client(fetchImpl).uploadImageAndWait('tok-a', PNG, 'image.png', { pollIntervalMs: 1 }),
    ).rejects.toThrow(/upload response missing id/)
    expect(seen.some((s) => s.path === FILE_STATUS_PATH)).toBe(false)
  })
})
