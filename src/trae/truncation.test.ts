import { describe, it, expect } from 'vitest'
import { soloStreamToOpenAIStream, type SoloStreamEndInfo } from './sse'
import { proxyTraeChatRequest } from './proxy'
import { readTraePool, setTraeWorkCredits } from './pool'

/**
 * 回归用例：静默截断/连接层失败不得再被伪装成正常收尾。
 *
 * 事故样本（2026-09-27，trae/deepseek-v4.1-flash，DSH 会话 session-e83b2ca2）：
 *  1. 回复停在半句，DSH 记到 finish=stop + turn/end=completed —— 因为 sse.ts 兜底把
 *     「上游没发 done 就断」合成成 stop，客户端无任何依据报错或重试；
 *  2. 同一时段 503 no_healthy_account，文案称账号池 cooling/disabled，实际是网关↔上游
 *     30s 建连超时连撞两个账号（62s ≈ 2×TRAE_CHAT_CONNECT_TIMEOUT_MS），账号未被罚。
 */

/** 收集流输出（Uint8Array → string）。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value)
  }
  return out
}

function upstreamOf(chunks: string[], err?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      if (err) controller.error(err)
      else controller.close()
    },
  })
}

/** 取 SSE 帧里的 error 对象（无则 null）。 */
function errorFrameOf(sse: string): any | null {
  for (const frame of sse.split('\n\n')) {
    const data = frame.replace(/^data:\s*/, '').trim()
    if (!data.startsWith('{')) continue
    try {
      const obj = JSON.parse(data)
      if (obj && obj.error) return obj.error
    } catch { /* 非 JSON 帧忽略 */ }
  }
  return null
}

describe('Trae SOLO 流式收尾：上游未发 done 不得静默收尾', () => {
  it('有正文但无 done → 补 upstream_no_finish 错误帧，并保留收尾与 [DONE]', async () => {
    const seen: SoloStreamEndInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(['event: output\ndata: {"response":"结论是"}\n\nevent: token_usage\ndata: {"prompt_tokens":10,"completion_tokens":2}\n\n']),
      'deepseek-v4.1-flash',
      undefined,
      (info) => seen.push(info)
    ))

    const err = errorFrameOf(sse)
    expect(err?.type).toBe('upstream_no_finish')
    expect(String(err?.message)).toContain('未发送 done')
    // 宽松客户端兼容：收尾 chunk 与 [DONE] 必须照发（修复前行为不变）
    expect(sse).toContain('"finish_reason":"stop"')
    expect(sse).toContain('[DONE]')
    // 诊断回调：内容规模可用于判断是「刚开流就断」还是「输出到一半断」
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('no_done')
    expect(seen[0].contentChars).toBe(3)
    expect(seen[0].sawUsage).toBe(true)
  })

  it('上游读体抛错 → 补 upstream_interrupted（与干净 EOF 区分）', async () => {
    const seen: SoloStreamEndInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(['event: output\ndata: {"response":"半句"}\n\n'], new Error('socket hang up')),
      'deepseek-v4.1-flash',
      undefined,
      (info) => seen.push(info)
    ))

    expect(errorFrameOf(sse)?.type).toBe('upstream_interrupted')
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('read_error')
    expect(sse).toContain('[DONE]')
  })

  it('反例：上游正常 done → 不注入任何错误帧', async () => {
    const seen: SoloStreamEndInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(['event: output\ndata: {"response":"完整回答"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n']),
      'deepseek-v4.1-flash',
      undefined,
      (info) => seen.push(info)
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(seen).toHaveLength(0)
    expect(sse).toContain('"finish_reason":"stop"')
  })

  it('反例：done 自带 length（真实截断）→ 原值保留，不被改写也不误报错误帧', async () => {
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(['event: output\ndata: {"response":"被上限截断"}\n\nevent: done\ndata: {"finish_reason":"length"}\n\n']),
      'deepseek-v4.1-flash'
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(sse).toContain('"finish_reason":"length"')
    expect(sse).not.toContain('"finish_reason":"stop"')
  })
})

describe('Trae SOLO 连接层失败（transport）：Work 兜底与文案定责', () => {
  const UID = 'u_transport'
  const PROVIDER_ID = 'trae-transport'

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

  function makeProvider(id: string): any {
    return {
      id,
      name: 'TRAE transport',
      type: 'trae',
      apiKeys: [{
        key: JSON.stringify({
          uid: UID,
          token: 'tok_transport',
          refreshToken: 'ref_transport',
          expiresAt: Date.now() + 3600_000,
        }),
        enabled: true,
      }],
    }
  }

  const workSse = 'event: output\ndata: {"text": "Answered via Work Failover"}\n\n'

  it('SOLO 建连失败（fetch 抛错）→ 立即降级 Work 通道并成功响应', async () => {
    const originalFetch = globalThis.fetch
    // 记录调用顺序：只断言「先 SOLO 失败、接着 Work 兜底」，不断言总次数
    // （Work 成功后还会异步触发积分探测，mock 下也会命中同一 host）
    const calls: string[] = []
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        return new Response(workSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        // 模拟 TRAE_CHAT_CONNECT_TIMEOUT_MS 到点 abort
        throw new Error('The operation was aborted')
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-work-ok`
      const provider = makeProvider(pid)
      await setTraeWorkCredits(env, pid, UID, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2', // 静态已知模型（事故里用的 deepseek-v4.1-flash 由线上 provider.models 提供）
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0]).toContain('/api/agent/v3/llm_utils_chat')
      expect(calls[1]).toContain('/api/agent/v3/create_agent_task')
      expect(resp.status).toBe(200)
      const json = await resp.json() as any
      expect(json.choices[0].message.content).toBe('Answered via Work Failover')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('SOLO 与 Work 都连不上 → 503 报真因 upstream_unreachable，且账号不被罚', async () => {
    const originalFetch = globalThis.fetch
    let workCallCount = 0
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        workCallCount++
        throw new Error('The operation was aborted')
      }
      throw new Error('The operation was aborted')
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-work-fail`
      const provider = makeProvider(pid)
      await setTraeWorkCredits(env, pid, UID, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2', // 静态已知模型（事故里用的 deepseek-v4.1-flash 由线上 provider.models 提供）
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      expect(workCallCount).toBeGreaterThan(0)
      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      // 不再把连接层故障说成「账号池 cooling/disabled」
      expect(body.error.code).toBe('upstream_unreachable')
      expect(String(body.error.message)).toContain('连接超时')
      expect(String(body.error.message)).not.toContain('all accounts unavailable')

      // 账号未被惩罚：transport 不计 errCount、不进冷却
      const pool = await readTraePool(env, pid)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
