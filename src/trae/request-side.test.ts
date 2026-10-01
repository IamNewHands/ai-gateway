import { describe, it, expect } from 'vitest'
import { classifyTraeError, isTraeRequestSideError } from './upstream'
import { readTraePool } from './pool'
import { proxyTraeChatRequest } from './proxy'

/** KV mock（同 work.test.ts 的形态）。 */
function makeEnv(): any {
  return {
    KV: {
      data: new Map<string, string>(),
      async get(key: string) { return this.data.get(key) || null },
      async put(key: string, val: string) { this.data.set(key, val) },
      async delete(key: string) { this.data.delete(key) },
    },
  }
}

const UID = 'u_req_side'
const PROVIDER_ID = 'trae-req-side'

function makeProvider(): any {
  return {
    id: PROVIDER_ID,
    name: 'TRAE request-side',
    type: 'trae',
    apiKeys: [{
      key: JSON.stringify({
        uid: UID,
        token: 'tok_req_side',
        refreshToken: 'ref_req_side',
        expiresAt: Date.now() + 3600_000,
      }),
      enabled: true,
    }],
  }
}

/** 上游返回一帧 SOLO 业务错误（event: error）的 200 SSE 响应（非流式路径聚合它）。 */
function soloErrorSse(code: number, message: string): Response {
  return new Response(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('isTraeRequestSideError：请求侧错误判据（同一 body 换任何账号必撞同一错误）', () => {
  it('4027 / invalid_parameter_error 判为请求侧（实测：developer 角色校验失败）', () => {
    expect(isTraeRequestSideError(
      4027,
      "tool call failed: invalid_parameter_error:developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
    )).toBe(true)
    expect(isTraeRequestSideError(4027, '')).toBe(true)
  })

  it('文案含 invalid_parameter / invalid parameter 同样判为请求侧（HTTP 形态）', () => {
    expect(isTraeRequestSideError(400, '{"code":400,"message":"invalid_parameter_error"}')).toBe(true)
    expect(isTraeRequestSideError(400, 'Invalid parameter: messages[0].role')).toBe(true)
  })

  it('账号级/额度/限流/服务端错误不判为请求侧（罚号与轮转语义保留）', () => {
    expect(isTraeRequestSideError(1005, 'plan limit')).toBe(false)
    expect(isTraeRequestSideError(4008, 'exceeded the quota')).toBe(false)
    expect(isTraeRequestSideError(429, 'too many requests')).toBe(false)
    expect(isTraeRequestSideError(500, 'internal error')).toBe(false)
    expect(isTraeRequestSideError(401, 'token expired')).toBe(false)
  })

  it('上下文超限判为请求侧（换账号必撞同一上限，罚号会把健康池刷空）', () => {
    expect(isTraeRequestSideError(400, '{"code":400,"message":"context_length_exceeded: reduce the length of the messages"}')).toBe(true)
    expect(isTraeRequestSideError(400, 'model_context_window_exceeded')).toBe(true)
    expect(isTraeRequestSideError(400, 'context_window_exceeded')).toBe(true)
    expect(isTraeRequestSideError(400, 'prompt_too_long')).toBe(true)
    expect(isTraeRequestSideError(413, 'Prompt is too long: 210000 tokens')).toBe(true)
    expect(isTraeRequestSideError(400, 'maximum context length is 200000 tokens')).toBe(true)
  })

  it('判据保持收窄：无关 4xx 仍归账号侧 client（不吞掉真故障）', () => {
    expect(classifyTraeError(400, '{"code":400,"message":"unknown_field"}')).toBe('client')
    expect(classifyTraeError(400, 'rate limit on this model')).toBe('client')
    // 分类不变：超限走 client_params（4xx 终态、不罚号），不是 client
    expect(classifyTraeError(400, 'context_length_exceeded')).toBe('client_params')
  })
})

describe('TRAE 请求侧错误：不罚号、不轮转（对齐 WorkBuddy bad_params 语义）', () => {
  it('非流式 SOLO 4027 → 回 400 终态，且账号 errCount/冷却保持不变', async () => {
    const originalFetch = globalThis.fetch
    let soloCalls = 0
    globalThis.fetch = async (input: any) => {
      if (String(input).includes('/api/agent/v3/llm_utils_chat')) {
        soloCalls++
        return soloErrorSse(4027, "tool call failed: invalid_parameter_error:developer is not one of ['system']")
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const provider = makeProvider()
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
        stream: false,
      })

      // 终态 4xx：不轮转（换任何账号都是同一个参数校验错误）
      expect(resp.status).toBe(400)
      expect(soloCalls).toBe(1)
      const body = await resp.json() as any
      expect(String(body?.error?.message || '')).toContain('4027')

      // 不罚号：账号未累计错误、未进入冷却（罚号会把整个池刷成不可用）
      const pool = await readTraePool(env, PROVIDER_ID)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP 400 invalid_parameter_error → 同样回 400 终态且不罚号', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any) => {
      if (String(input).includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(JSON.stringify({ code: 400, message: 'invalid_parameter_error: messages[1].role' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const provider = makeProvider()
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      expect(resp.status).toBe(400)
      const pool = await readTraePool(env, PROVIDER_ID)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP 400 上下文超限 → 4xx 终态（invalid_request_error）且不罚号', async () => {
    const originalFetch = globalThis.fetch
    let soloCalls = 0
    globalThis.fetch = async (input: any) => {
      if (String(input).includes('/api/agent/v3/llm_utils_chat')) {
        soloCalls++
        return new Response(JSON.stringify({
          code: 400,
          message: 'context_length_exceeded: reduce the length of the messages',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const provider = makeProvider()
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      // 终态 4xx：换账号无用（同一 body 必撞同一上下文上限）→ 不轮转
      expect(resp.status).toBe(400)
      expect(soloCalls).toBe(1)
      const body = await resp.json() as any
      expect(body?.error?.type).toBe('invalid_request_error')
      expect(body?.error?.code).toBe('client_params')
      // 不罚号（这是本修复的目的：超限不再把健康账号冷却 10 分钟）
      const pool = await readTraePool(env, PROVIDER_ID)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP 413 上下文超限 → 保留 413 状态码（不降级成 400）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any) => {
      if (String(input).includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(JSON.stringify({ message: 'Prompt is too long: 210000 tokens' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const provider = makeProvider()
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      expect(resp.status).toBe(413)
      const pool = await readTraePool(env, PROVIDER_ID)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('反例：服务端类流内错误仍按账号故障累计（判据必须收窄，不能吞掉真故障）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any) => {
      if (String(input).includes('/api/agent/v3/llm_utils_chat')) {
        return soloErrorSse(500, 'internal server error')
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const provider = makeProvider()
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      // 不是请求侧错误 → 不做 400 终态
      expect(resp.status).not.toBe(400)
      const pool = await readTraePool(env, PROVIDER_ID)
      expect(pool[UID]?.errCount ?? 0).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})