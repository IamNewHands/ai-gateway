import { describe, it, expect, beforeEach, vi } from 'vitest'
import gateway from './index'
import { clearCache } from './storage'
import type { Env, Provider } from './types'

/**
 * 管理/控制类入口请求体上界（修复 2 的端到端回归）。
 *
 * 修复前这些入口全部使用裸 `c.req.json()`：超大请求体会被完整缓冲后才解析，
 * 完全不在有界读取的覆盖范围内。本测试经真实 Hono 路由断言上界生效。
 *
 * 本文件刻意只依赖 `./index` 并硬编码 8MiB 字面量，因此可以在**修复前**的源码上运行
 * （`git stash` 后执行）以证明每个超限用例在修复前确实不返回 413 —— 否则这些用例
 * 只是同义反复，无法证明修复真的改变了行为。
 */

const MB = 1024 * 1024
const LIMIT = 8 * MB
const PROXY_KEY = 'sk_cf_admin_e2e_key'
const SESSION_ID = 'sess-admin-e2e'

interface Harness {
  env: Env
  store: Map<string, string>
}

/** 与 auth.ts hashPassword 等价：SHA-256 hex 前 32 位（即 /v1/sessions 的租户标识） */
async function tenantOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

function makeProvider(): Provider {
  return {
    id: 'm365-sessions-e2e',
    name: 'M365 Sessions E2E',
    authType: 'oauth-device',
    baseUrl: 'https://m365.example/v1',
    apiKeys: [],
    models: [],
    enabled: true,
    oauth: { flowType: 'm365-pkce' },
  } as unknown as Provider
}

function makeEnv(): Harness {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify([makeProvider()]))
  store.set('proxy:keys', JSON.stringify([{ id: 'k1', key: PROXY_KEY, name: 'e2e', enabled: true, createdAt: new Date().toISOString() }]))
  // 管理后台 session：adminAuthMiddleware 只需 getSession 命中即可
  store.set(`admin:session:${SESSION_ID}`, JSON.stringify({ username: 'admin', expiresAt: Date.now() + 600_000 }))

  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }

  const env = {
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
  } as unknown as Env

  return { env, store }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

/** 超限但语法合法的 JSON：证明拦截依据是体积而非语法 */
function oversizedJson(): string {
  return JSON.stringify({ pad: 'x'.repeat(LIMIT + 1024) })
}

function post(path: string, body: string, headers: Record<string, string>): Request {
  return new Request(`https://gw.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })
}

const asAdmin = { Cookie: `session_id=${SESSION_ID}` }
const asProxyKey = { Authorization: `Bearer ${PROXY_KEY}` }

beforeEach(() => {
  clearCache()
})

describe('修复 2：/admin/login（未鉴权公网入口）请求体上界', () => {
  it('超过 8MiB 的 JSON 体 → 413 REQUEST_TOO_LARGE（修复前会完整缓冲）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/login', oversizedJson(), {}), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('非法 JSON → 400（不因改用有界读取而变成 500）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/login', '{oops', {}), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('INVALID_JSON')
  })

  it('合法小请求仍走原路径 → 未配置管理员账号时为 500（未被误伤）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/login', JSON.stringify({ username: 'a', password: 'b' }), {}), env, ctx)

    expect(res.status).toBe(500)
  })
})

describe('修复 2：/v1/mcp（JSON-RPC 端点）请求体上界', () => {
  it('超过 8MiB 的 JSON 体 → 413（修复前会解析后报 Invalid Request）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/v1/mcp', oversizedJson(), asProxyKey), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('非法 JSON → 400 且仍是 JSON-RPC 的 -32700 Parse error（契约未被破坏）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/v1/mcp', '{oops', asProxyKey), env, ctx)

    expect(res.status).toBe(400)
    const json = await res.json() as { error?: { code?: number }; code?: number }
    const code = json.error?.code ?? json.code
    expect(code).toBe(-32700)
  })

  it('超限不伪装成 Parse error（-32700 只表示语法错误）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/v1/mcp', oversizedJson(), asProxyKey), env, ctx)
    const text = await res.text()

    expect(text).not.toContain('-32700')
    expect(text).toContain('REQUEST_TOO_LARGE')
  })
})

describe('修复 2：管理面写接口请求体上界', () => {
  it('POST /admin/api/providers 超限 → 413（修复前会完整缓冲后解析）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/api/providers', oversizedJson(), asAdmin), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('POST /admin/api/logs/config 超限 → 413', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/api/logs/config', oversizedJson(), asAdmin), env, ctx)

    expect(res.status).toBe(413)
    const json = await res.json() as { error: { code?: string } }
    expect(json.error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('POST /admin/api/checkin 超限 → 413（在触发任何签到动作之前拒绝）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/api/checkin', oversizedJson(), asAdmin), env, ctx)

    expect(res.status).toBe(413)
  })

  it('POST /admin/api/logs/config 合法小请求仍返回 200（上界未误伤正常调用）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/admin/api/logs/config', JSON.stringify({ retentionDays: 7 }), asAdmin), env, ctx)

    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { retentionDays: number } }
    expect(json.success).toBe(true)
    expect(json.data.retentionDays).toBe(7)
  })
})

describe('修复 2：/v1/sessions 请求体只读一次（有界读取消费原始流）', () => {
  it('POST 带 provider_id + session_id 时命中显式绑定 → matched_by=explicit', async () => {
    const { env, store } = makeEnv()
    const tenant = await tenantOf(PROXY_KEY)
    // 预置一条属于本租户的会话绑定
    store.set('m365:sessions:m365-sessions-e2e', JSON.stringify([{
      sessionId: 'sid-1',
      conversationId: 'conv-1',
      accountId: 'acc-1',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      tenant,
    }]))

    const res = await gateway.fetch(
      post('/v1/sessions', JSON.stringify({ provider_id: 'm365-sessions-e2e', session_id: 'sid-1' }), asProxyKey),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { object: string; session_id: string; matched_by: string }
    expect(json.matched_by).toBe('explicit')
    expect(json.session_id).toBe('sid-1')
  })

  it('POST 未命中 session_id → 404 session not found（证明 body 真的被读到了）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(
      post('/v1/sessions', JSON.stringify({ provider_id: 'm365-sessions-e2e', session_id: 'nope' }), asProxyKey),
      env,
      ctx,
    )

    expect(res.status).toBe(404)
  })

  it('超限请求体 → 413（该入口同样受上界保护）', async () => {
    const { env } = makeEnv()
    const res = await gateway.fetch(post('/v1/sessions', oversizedJson(), asProxyKey), env, ctx)

    expect(res.status).toBe(413)
  })
})
