import { describe, it, expect, beforeEach, vi } from 'vitest'
import gateway from './index'
import { clearCache } from './storage'
import { MAX_IMAGE_REQUEST_BYTES, MAX_IMAGE_BINARY_BYTES } from './request-body'
import type { Env, Provider } from './types'

/**
 * 图片入口请求体上界（A 项修复的端到端回归）。
 *
 * 修复前 /v1/images/generations、/v1/images/edits（JSON 与 multipart 两条分支）都用裸
 * `c.req.json()` / `c.req.parseBody()`：超大请求体会被完整缓冲后才解析，而这两条路径
 * 完全不在 8MiB 有界读取的覆盖范围内。本测试经真实 Hono 路由断言上界生效，
 * 并断言合法小请求仍能走完全程（防止修复把正常调用一起挡掉）。
 */

const PID = 'm365-images-e2e'
const PROXY_KEY = 'sk_cf_images_e2e_key'

function makeProvider(): Provider {
  return {
    id: PID,
    name: 'M365 Images E2E',
    authType: 'oauth-device',
    baseUrl: 'https://m365.example/v1',
    apiKeys: [],
    models: [{ id: 'gpt-image-2', enabled: true }],
    enabled: true,
    oauth: { flowType: 'm365-pkce' },
  } as unknown as Provider
}

/** 合法账号池条目：oid/tid 齐备（跳过 JWT 解析），过期时间远在未来（跳过刷新） */
function makeAccount() {
  return {
    access_token: 'at-e2e',
    refresh_token: 'rt-e2e',
    expires_at: Date.now() + 3_600_000,
    updated_at: Date.now(),
    oid: 'oid-e2e',
    tid: 'tid-e2e',
  }
}

interface Harness {
  env: Env
  store: Map<string, string>
  sessionFetch: ReturnType<typeof vi.fn>
}

function makeEnv(opts: { withProvider?: boolean; withAccount?: boolean } = {}): Harness {
  const { withProvider = true, withAccount = true } = opts
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(withProvider ? [makeProvider()] : []))
  store.set('proxy:keys', JSON.stringify([{ id: 'k1', key: PROXY_KEY, name: 'e2e', enabled: true, createdAt: new Date().toISOString() }]))
  if (withAccount) store.set(`oauth:token:${PID}:pool`, JSON.stringify([makeAccount()]))

  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }

  // DO stub：返回一个 data: URL，短路 Designer 下载路径，直接得到 200
  const sessionFetch = vi.fn(async () => new Response(
    JSON.stringify({ images: ['data:image/png;base64,iVBORw0KGgo='] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))

  const env = {
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
    M365_SESSION: { get: () => ({ fetch: sessionFetch }), idFromName: (n: string) => n },
  } as unknown as Env

  return { env, store, sessionFetch }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function postJson(path: string, body: string): Request {
  return new Request(`https://gw.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROXY_KEY}` },
    body,
  })
}

function postMultipart(path: string, body: string, boundary: string): Request {
  return new Request(`https://gw.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${PROXY_KEY}` },
    body,
  })
}

/** 构造一个含指定字节数 image 字段的 multipart 体 */
function multipartWithImage(imageBytes: number, boundary: string): string {
  const head =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="prompt"\r\n\r\n' +
    'a cat\r\n' +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="image"; filename="a.png"\r\n' +
    'Content-Type: image/png\r\n\r\n'
  const tail = `\r\n--${boundary}--\r\n`
  return head + 'A'.repeat(imageBytes) + tail
}

beforeEach(() => {
  clearCache()
})

describe('A 修复：/v1/images/generations 请求体上界', () => {
  it('超过 8MiB 的 JSON 体 → 413 REQUEST_TOO_LARGE（修复前会被完整缓冲）', async () => {
    const { env } = makeEnv()
    // 合法 JSON 但体积超限：证明拦截依据是体积而非语法
    const padding = 'x'.repeat(MAX_IMAGE_REQUEST_BYTES + 1024)
    const body = JSON.stringify({ prompt: 'a cat', padding })

    const res = await gateway.fetch(postJson('/v1/images/generations', body), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('非法 JSON → 400 INVALID_JSON（体积合规但语法错误）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(postJson('/v1/images/generations', '{oops'), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('INVALID_JSON')
  })

  it('合法小请求仍走完全程 → 200（修复未误伤正常调用）', async () => {
    const { env, sessionFetch } = makeEnv()
    const res = await gateway.fetch(postJson('/v1/images/generations', JSON.stringify({ prompt: 'a cat' })), env, ctx)

    expect(res.status).toBe(200)
    const json = await res.json() as { data: Array<{ url?: string }> }
    expect(json.data).toHaveLength(1)
    // 真正抵达 DO（说明上界检查通过后请求未被改变）
    expect(sessionFetch).toHaveBeenCalledTimes(1)
  })

  it('缺少 M365 provider → 503（provider 检查先于请求体读取）', async () => {
    const { env } = makeEnv({ withProvider: false })
    const res = await gateway.fetch(postJson('/v1/images/generations', JSON.stringify({ prompt: 'a cat' })), env, ctx)
    expect(res.status).toBe(503)
  })
})

describe('A 修复：/v1/images/edits multipart 请求体上界', () => {
  const boundary = '----e2eBoundary'

  it('超过 8MiB 的 multipart 体 → 413 REQUEST_TOO_LARGE（修复前 parseBody 无上界）', async () => {
    const { env } = makeEnv()
    const body = multipartWithImage(MAX_IMAGE_REQUEST_BYTES + 1024, boundary)

    const res = await gateway.fetch(postMultipart('/v1/images/edits', body, boundary), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('multipart 体在限内且图片合规 → 200（有界读取后 multipart 仍能正常解析）', async () => {
    const { env, sessionFetch } = makeEnv()
    const body = multipartWithImage(64, boundary)

    const res = await gateway.fetch(postMultipart('/v1/images/edits', body, boundary), env, ctx)

    expect(res.status).toBe(200)
    expect(sessionFetch).toHaveBeenCalledTimes(1)
  })

  it('multipart 缺少 image 字段 → 400 image is required', async () => {
    const { env } = makeEnv()
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="prompt"\r\n\r\n' +
      'a cat\r\n' +
      `--${boundary}--\r\n`

    const res = await gateway.fetch(postMultipart('/v1/images/edits', body, boundary), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toBe('image is required')
  })
})

describe('A 修复：/v1/images/edits JSON 分支的单图体积上界', () => {
  it('base64 图片解码后超过 4MiB → 413 IMAGE_TOO_LARGE（wire 体仍在 8MiB 内）', async () => {
    const { env } = makeEnv()
    // 解码后 > 4MiB，base64 约 5.6MiB —— 低于 wire 上限，因此必须由单图守卫拦截
    const imageChars = Math.ceil((MAX_IMAGE_BINARY_BYTES + 1) / 3) * 4
    const body = JSON.stringify({ prompt: 'a cat', image: 'A'.repeat(imageChars) })
    expect(body.length).toBeLessThan(MAX_IMAGE_REQUEST_BYTES)

    const res = await gateway.fetch(postJson('/v1/images/edits', body), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('IMAGE_TOO_LARGE')
  })

  it('空 image 字符串 → 400 image is required for edits（空串由既有"必填"检查拦截）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(postJson('/v1/images/edits', JSON.stringify({ prompt: 'a cat', image: '' })), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toBe('image is required for edits')
  })

  it('非空但解码为 0 字节的 image → 400 image must be non-empty base64', async () => {
    const { env } = makeEnv()
    // ' ' 是非空字符串（绕过必填检查），但 base64 长度不足 4，解码后 0 字节
    const res = await gateway.fetch(postJson('/v1/images/edits', JSON.stringify({ prompt: 'a cat', image: ' ' })), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toBe('image must be non-empty base64')
  })

  it('合规小图 → 200 且抵达 DO（单图守卫未误伤）', async () => {
    const { env, sessionFetch } = makeEnv()
    const body = JSON.stringify({ prompt: 'a cat', image: 'iVBORw0KGgo=', image_type: 'image/png' })

    const res = await gateway.fetch(postJson('/v1/images/edits', body), env, ctx)

    expect(res.status).toBe(200)
    expect(sessionFetch).toHaveBeenCalledTimes(1)
  })

  it('未授权账号 → 401，且错误来自账号检查而非鉴权中间件（证明已越过体积检查）', async () => {
    const { env } = makeEnv({ withAccount: false })
    const body = JSON.stringify({ prompt: 'a cat', image: 'iVBORw0KGgo=' })

    const res = await gateway.fetch(postJson('/v1/images/edits', body), env, ctx)

    expect(res.status).toBe(401)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toContain('M365 account not authorized')
  })
})
