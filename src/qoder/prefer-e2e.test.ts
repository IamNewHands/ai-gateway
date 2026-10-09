/**
 * prefer.test.ts — Qoder 面板「首选账号」的端到端接线（管理员接口层 + 转发路径）。
 *
 * 覆盖的真实缺陷（2026-10-07 用户报「qoder 也增加这个首选账号的功能」）：
 * `handleOAuthPoolSetPrefer` 的分支里早就有 `isQoderFlow(provider)`，但 uid 校验走的是
 * **WorkBuddy 池**（oauth:pool:）。Qoder 的池存在另一个 KV key（qoder:pool:），
 * 于是任何合法 Qoder uid 都会被判「账号不存在」——接口看起来支持 Qoder，实际永远用不了；
 * 同时 `/status` 也只在 WorkBuddy 分支返回 preferUid，面板拿不到当前值（下拉框永远是空的）。
 *
 * 这里断言的是「用户点得动的行为」：能用池内 uid 指定、乱填被拒、状态能回显，
 * 以及指定后**出站请求真的换了账号**。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { setProviders } from '../storage'
import { handleOAuthStatus, handleOAuthPoolSetPrefer } from '../admin'
import { handleProxy, handleAnthropicMessages } from '../proxy'
import { writeQoderPool, type QoderPoolAccount } from './pool'
import { formatCstWallClock } from '../credit-expiry'

function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { KV: kv } as unknown as AppEnv['Bindings']
}

function qoderProvider(over: Partial<Provider> = {}): Provider {
  return {
    id: 'qoder',
    name: 'QoderWork',
    authType: 'oauth-device',
    baseUrl: 'https://gateway.qoder.com.cn',
    oauth: { flowType: 'qoder' },
    apiKeys: [],
    models: [],
    enabled: true,
    ...over,
  } as unknown as Provider
}

function poolAccount(uid: string): QoderPoolAccount {
  return {
    uid,
    nickname: uid,
    token: { access_token: 'dt-' + uid, refresh_token: 'drt-' + uid, expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'cn',
  }
}

function makeApp() {
  const app = new Hono<AppEnv>()
  app.get('/admin/api/oauth/:id/status', handleOAuthStatus)
  app.post('/admin/api/oauth/:id/pool/prefer', handleOAuthPoolSetPrefer)
  return app
}

async function call(app: Hono<AppEnv>, path: string, init?: RequestInit, env?: AppEnv['Bindings']) {
  const res = await app.request(path, init, env as never)
  return (await res.json()) as { success: boolean; message?: string; data?: any }
}

describe('Qoder 面板首选账号：接口必须认 Qoder 自己的池', () => {
  it('用池内 uid 指定 → 成功并落库（修复前必然返回「账号不存在」）', async () => {
    const env = makeEnv()
    const app = makeApp()
    await setProviders(env as never, [qoderProvider()])
    await writeQoderPool(env, 'qoder', [poolAccount('u1'), poolAccount('u2')])

    const r = await call(app, '/admin/api/oauth/qoder/pool/prefer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'u2' }),
    }, env)
    expect(r.success, JSON.stringify(r)).toBe(true)
    expect(r.message).toContain('u2')

    // 状态接口把当前值回显给面板（否则下拉框永远是空的，用户以为没保存）
    const st = await call(app, '/admin/api/oauth/qoder/status', undefined, env)
    expect(st.data.preferUid).toBe('u2')
    expect(st.data.pool.map((a: any) => a.uid)).toEqual(['u1', 'u2'])
  })

  it('乱填 uid 仍被拒（校验没被放松成「什么都收」）', async () => {
    const env = makeEnv()
    const app = makeApp()
    await setProviders(env as never, [qoderProvider({ id: 'qoder-bad' })])
    await writeQoderPool(env, 'qoder-bad', [poolAccount('u1')])

    const r = await call(app, '/admin/api/oauth/qoder-bad/pool/prefer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'not-in-pool' }),
    }, env)
    expect(r.success).toBe(false)
    expect(r.message).toContain('账号不存在')
  })

  it('留空 = 恢复自动挑选，且状态接口回显为空（面板下拉回到「自动挑选」）', async () => {
    const env = makeEnv()
    const app = makeApp()
    await setProviders(env as never, [qoderProvider({ id: 'qoder-clear', preferOauthUid: 'u1' })])
    await writeQoderPool(env, 'qoder-clear', [poolAccount('u1')])

    const before = await call(app, '/admin/api/oauth/qoder-clear/status', undefined, env)
    expect(before.data.preferUid).toBe('u1')

    const r = await call(app, '/admin/api/oauth/qoder-clear/pool/prefer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: '' }),
    }, env)
    expect(r.success, JSON.stringify(r)).toBe(true)

    const after = await call(app, '/admin/api/oauth/qoder-clear/status', undefined, env)
    expect(after.data.preferUid).toBe('')
  })

  it('WorkBuddy 池（browser 流）不受影响：仍按 oauth 池校验', async () => {
    const env = makeEnv()
    const app = makeApp()
    const wb = qoderProvider({ id: 'wb', oauth: { flowType: 'browser' } as never })
    await setProviders(env as never, [wb])

    // oauth 池为空 → 任何 uid 都该被拒（说明没有把校验改成「哪个池有数据用哪个」）
    const r = await call(app, '/admin/api/oauth/wb/pool/prefer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'u1' }),
    }, env)
    expect(r.success).toBe(false)
  })
})

/**
 * 转发路径的端到端证明：面板存下的首选账号真的会改变**出站请求用的是哪个账号**。
 *
 * 为什么非要跑到 handleProxy：面板 → 接口 → provider 字段这三段都有单测，但「字段有没有
 * 真的被转发路径读走」只能从出站请求上看出来。出站请求带 `Cosy-User: <uid>`（cosy.ts），
 * 所以断言这个头就等于断言挑中了哪个账号。
 *
 * 池的构造刻意让「到期优先」与「指定账号」指向不同账号：soon 有 1 天内到期的包（自动规则会选它），
 * rich 积分高但近期不过期。这样断言才能区分「请求头 > 面板指定 > 到期优先」三层优先级。
 */
describe('Qoder 首选账号在转发路径上真的生效（出站 Cosy-User 断言）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const PID = 'qoder-prefer-e2e'

  function pooledAccount(uid: string, credits: number, daysToExpiry: number): QoderPoolAccount {
    return {
      ...poolAccount(uid),
      state: {
        credits,
        disabled: false,
        until: 0,
        errCount: 0,
        packages: [{ name: 'pkg', expireAt: formatCstWallClock(Date.now() + daysToExpiry * DAY)!, size: credits, used: 0 }],
      },
    }
  }

  async function run(over: { preferOauthUid?: string; header?: string }) {
    const env = makeEnv()
    const provider = qoderProvider({
      id: PID,
      models: [{ id: 'auto', enabled: true }] as never,
      preferOauthUid: over.preferOauthUid,
    })
    await setProviders(env as never, [provider])
    await writeQoderPool(env, PID, [
      pooledAccount('soon', 10, 1),    // 自动规则会选它（1 天内到期）
      pooledAccount('rich', 5000, 20), // 积分高，但窗口内没有待救积分
    ])

    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const h: Record<string, string> = {}
      const raw = (init?.headers || {}) as Record<string, string>
      for (const k of Object.keys(raw)) h[k.toLowerCase()] = String(raw[k])
      calls.push({ url: String(url), headers: h })
      // Qoder 上游是「信封帧」格式（{headers, body} 里再包一层 OpenAI chunk），
      // 直接吐裸 chunk 会被解析成空流 → 502 empty upstream stream
      const inner = JSON.stringify({
        id: 'chatcmpl-1', model: 'auto',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      })
      const body = 'data: ' + JSON.stringify({ headers: {}, body: inner }) + '\n\n'
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))

    const app = new Hono<AppEnv>()
    app.post('/v1/chat/completions', (c) => handleProxy(c))
    const req = new Request('https://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(over.header ? { 'X-Qoder-Account': over.header } : {}),
      },
      body: JSON.stringify({ model: `${PID}/auto`, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    const body = await res.clone().text()
    return {
      res,
      body,
      calls,
      // 出站请求里的 Cosy-User = 被挑中账号的 uid
      users: calls.map((c) => c.headers['cosy-user'] ?? ''),
    }
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('只面板指定：压过到期优先（rich 虽非「快过期」仍被选中）', async () => {
    const { res, users, body } = await run({ preferOauthUid: 'rich' })
    expect(res.status, body).toBe(200)
    expect(users).toContain('rich')
    expect(users).not.toContain('soon')
  })

  it('请求头与面板指定同时存在：请求头优先（本次请求级意图更具体）', async () => {
    const { res, users, body } = await run({ preferOauthUid: 'rich', header: 'soon' })
    expect(res.status, body).toBe(200)
    expect(users).toContain('soon')
    expect(users).not.toContain('rich')
  })

  it('两者都没有：回落到「7 天内到期的积分优先」自动挑选', async () => {
    const { res, users, body } = await run({})
    expect(res.status, body).toBe(200)
    expect(users).toContain('soon')
    expect(users).not.toContain('rich')
  })
})

/**
 * Anthropic（`/v1/messages`，Claude Code 走这条）路径的心跳端到端证明。
 *
 * 为什么必须单独测这条：`handleAnthropicQoder` 把 OpenAI SSE 逐行转成 Anthropic SSE，
 * 而它的循环只处理 `data:` 开头的行（`if (!trimmed.startsWith('data:')) continue`）——
 * 于是 qoder 层注入的 `: keep-alive` 注释行会在这一层被**丢掉**。
 * 只看 `qoder/proxy.ts` 的测试会以为心跳已经生效，而 Claude Code 用户实际一个心跳都收不到。
 *
 * 这个用例就是「不许只测一层」的证据：同一个上游静默，两条入口都必须有心跳。
 */
describe('Anthropic 入口的心跳：转换层不得把注释行吃掉', () => {
  const PID = 'qoder-beat-anthropic'

  /** 上游：先给一帧（让闸门放行建流），随后长时间静默。 */
  function slowUpstream() {
    const enc = new TextEncoder()
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
        const inner = JSON.stringify({
          id: 'c1', model: 'auto',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
        })
        c.enqueue(enc.encode('data: ' + JSON.stringify({ headers: {}, body: inner }) + '\n\n'))
      },
    })
    return { body, push: (s: string) => ctrl!.enqueue(enc.encode(s)), close: () => ctrl!.close() }
  }

  it('上游静默 → Anthropic 客户端收到 `: keep-alive`（修复前该行被转换循环丢弃）', async () => {
    vi.useFakeTimers()
    try {
      const env = makeEnv()
      await setProviders(env as never, [qoderProvider({
        id: PID,
        models: [{ id: 'auto', enabled: true }] as never,
      })])
      await writeQoderPool(env, PID, [poolAccount('u1')])

      const up = slowUpstream()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(up.body, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      })))

      const app = new Hono<AppEnv>()
      app.post('/v1/messages', (c) => handleAnthropicMessages(c))
      const req = new Request('https://gw.test/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `${PID}/auto`, stream: true, max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
      expect(res.status).toBe(200)

      const parts: string[] = []
      const dec = new TextDecoder()
      const consume = (async () => {
        const reader = res.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(dec.decode(value, { stream: true }))
        }
      })()
      // 上游静默：推进时间必须触发心跳（默认 5s，这里推 6s）
      await vi.advanceTimersByTimeAsync(6000)
      up.close()
      await vi.advanceTimersByTimeAsync(50)
      await consume
      const text = parts.join('')
      expect(text, 'Anthropic 客户端必须收到心跳注释行').toContain(': keep-alive')
    } finally { vi.useRealTimers() }
  })
})
