import { describe, it, expect, vi } from 'vitest'
import { aggregateSoloSse, aggregateWorkSse, soloStreamToOpenAIStream, type SoloDoneAudit, type SoloStreamEndInfo } from './sse'
import { proxyTraeChatRequest } from './proxy'
import { readTraePool, setTraeWorkCredits } from './pool'
import { chatStream, type TraeConnectTiming } from './upstream'
import { TRAE_CHAT_CONNECT_TIMEOUT_MS, TRAE_CONNECT_DEADLINES_MS } from './constants'

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

describe('Trae SOLO 非流式聚合：未发 done 不得再聚合为 stop', () => {
  it('有正文但无 done → truncated=no_done，finish_reason 不再是 stop', () => {
    const agg = aggregateSoloSse(
      'event: output\ndata: {"response":"结论是"}\n\nevent: token_usage\ndata: {"prompt_tokens":10,"completion_tokens":2}\n\n'
    )

    expect(agg.err).toBeNull()
    expect(agg.truncated).not.toBeNull()
    expect(agg.truncated!.kind).toBe('no_done')
    expect(agg.truncated!.contentChars).toBe(3)
    expect(agg.truncated!.sawUsage).toBe(true)
    // 正文仍可取出（调用方可自行决定是否丢弃），但收尾信号不再谎报 stop
    expect(agg.resp!.choices[0].message.content).toBe('结论是')
    expect(agg.resp!.choices[0].finish_reason).toBe('length')
  })

  it('读体抛错（调用方标记）→ truncated=read_error', () => {
    const agg = aggregateSoloSse('event: output\ndata: {"response":"半句"}\n\n', { readError: true })

    expect(agg.truncated!.kind).toBe('read_error')
    expect(agg.resp!.choices[0].finish_reason).toBe('length')
  })

  it('反例：正常 done → truncated=null 且 finish_reason 保留上游值', () => {
    const agg = aggregateSoloSse(
      'event: output\ndata: {"response":"完整回答"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n'
    )

    expect(agg.truncated).toBeNull()
    expect(agg.resp!.choices[0].finish_reason).toBe('stop')
  })

  it('反例：done 自带 length（真实上限截断）→ 不误报，原值保留', () => {
    const agg = aggregateSoloSse(
      'event: output\ndata: {"response":"被上限截断"}\n\nevent: done\ndata: {"finish_reason":"length"}\n\n'
    )

    expect(agg.truncated).toBeNull()
    expect(agg.resp!.choices[0].finish_reason).toBe('length')
  })

  it('Work 聚合：无 done 且无 [DONE] → truncated=no_done；两种收尾信号任一出现 → null', () => {
    const bad = aggregateWorkSse('event: output\ndata: {"text":"半句"}\n\n', 'glm-5.2')
    expect(bad.truncated).not.toBeNull()
    expect(bad.truncated!.kind).toBe('no_done')
    expect(bad.truncated!.contentChars).toBe(2)
    expect(bad.resp!.choices[0].finish_reason).toBe('length')

    // Work 侧两个自然收尾信号：event: done 与 SSE 层 [DONE]
    const viaDone = aggregateWorkSse('event: output\ndata: {"text":"完整"}\n\nevent: done\ndata: {}\n\n', 'glm-5.2')
    expect(viaDone.truncated).toBeNull()
    expect(viaDone.resp!.choices[0].finish_reason).toBe('stop')

    const viaSseDone = aggregateWorkSse('event: output\ndata: {"text":"完整"}\n\ndata: [DONE]\n\n', 'glm-5.2')
    expect(viaSseDone.truncated).toBeNull()
  })

  it('反例：上游 error 事件优先于截断判定（err 非空时 truncated 为 null）', () => {
    const agg = aggregateSoloSse('event: error\ndata: {"code":1005,"message":"plan limit"}\n\n')

    expect(agg.err?.code).toBe(1005)
    expect(agg.truncated).toBeNull()
  })
})

describe('Trae 连接层失败与聚合截断：Work 兜底与 503 定责', () => {
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

  // Work 通道样本必须带自然收尾（event: done / [DONE]）：少了它聚合层会（正确地）
  // 判定为截断——这正是本次修复要抓的情形，不能拿它当「成功响应」的样本。
  const workSse = 'event: output\ndata: {"text": "Answered via Work Failover"}\n\nevent: done\ndata: {}\n\n'

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

  // ===== 非流式聚合截断（上游 200 + 有正文但没有 done）=====
  // 修复前：aggregate*Sse 留下默认 finish_reason='stop'，proxy 直接回 200 半句话。

  const soloPartial = 'event: output\ndata: {"response":"结论是"}\n\n'
  const workTruncated = 'event: output\ndata: {"text":"Work 也断了"}\n\n'
  const workComplete = 'event: output\ndata: {"text":"Work 兜底完整回答"}\n\nevent: done\ndata: {}\n\n'

  it('SOLO 非流式没收到 done → 降级 Work 通道，不把半句话当成功返回', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        return new Response(workComplete, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(soloPartial, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-agg-work-ok`
      const provider = makeProvider(pid)
      await setTraeWorkCredits(env, pid, UID, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      expect(calls[0]).toContain('/api/agent/v3/llm_utils_chat')
      expect(calls[1]).toContain('/api/agent/v3/create_agent_task')
      expect(resp.status).toBe(200)
      const json = await resp.json() as any
      expect(json.choices[0].message.content).toBe('Work 兜底完整回答')
      expect(json.choices[0].message.content).not.toContain('结论是')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('SOLO 与 Work 非流式都截断 → 503 upstream_unreachable，账号与 Work 通道都不被罚', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        return new Response(workTruncated, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(soloPartial, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-agg-work-fail`
      const provider = makeProvider(pid)
      await setTraeWorkCredits(env, pid, UID, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')
      expect(String(body.error.message)).toContain('未发送')
      expect(String(body.error.message)).not.toContain('all accounts unavailable')

      // 截断不定性为账号故障：SOLO errCount 与 Work workErrCount 都不累计
      const pool = await readTraePool(env, pid)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
      expect(pool[UID]?.workErrCount ?? 0).toBe(0)
      expect(pool[UID]?.workUntil ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('带 tools（Work 兜底被禁用）时 SOLO 非流式截断 → 503 upstream_unreachable，不是「账号池无可用」', async () => {
    const originalFetch = globalThis.fetch
    let workCallCount = 0
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        workCallCount++
        return new Response(workComplete, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(soloPartial, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-agg-tools`
      const provider = makeProvider(pid)
      await setTraeWorkCredits(env, pid, UID, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      })

      // 自定义 tools 场景不走 Work 通道（工具 schema 无法映射），因此这里不该有 Work 调用
      expect(workCallCount).toBe(0)
      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')
      expect(String(body.error.message)).not.toContain('all accounts unavailable')

      const pool = await readTraePool(env, pid)
      expect(pool[UID]?.errCount ?? 0).toBe(0)
      expect(pool[UID]?.until ?? 0).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * 收尾审计（`onAudit` / `SoloDoneAudit`）回归：`fd301f9`（只治「没发 done」）上线后
 * 线上仍复现半句截断，且截断带着 `finish=stop` 到达客户端——必须能区分
 * 「上游只产出了这么多」与「上游 done 之后还在发正文（客户端按 [DONE] 丢弃）」。
 */
describe('Trae SOLO 收尾审计：done 次数与 done 之后的内容', () => {
  async function auditOf(chunks: string[]): Promise<SoloDoneAudit> {
    const audits: SoloDoneAudit[] = []
    await drain(soloStreamToOpenAIStream(
      upstreamOf(chunks),
      'deepseek-v4.1-flash',
      undefined,
      undefined,
      undefined,
      (info) => audits.push(info)
    ))
    expect(audits).toHaveLength(1)
    return audits[0]
  }

  it('正常收尾：dones=1，done 之后无任何内容', async () => {
    const info = await auditOf([
      'event: output\ndata: {"response":"完整回答"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ])
    expect(info.dones).toBe(1)
    expect(info.postDoneContentChars).toBe(0)
    expect(info.postDoneReasoningChars).toBe(0)
    expect(info.postDoneToolCalls).toBe(0)
    expect(info.contentChars).toBe(4)
  })

  it('done 之后仍有正文/思考 → 审计看得见（这些帧客户端收不到）', async () => {
    const info = await auditOf([
      'event: output\ndata: {"response":"半句"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
      'event: output\ndata: {"response":"被丢掉的尾巴"}\n\n',
      'event: output\ndata: {"reasoning_content":"后续思考"}\n\n',
    ])
    expect(info.dones).toBe(1)
    expect(info.postDoneContentChars).toBe(6)
    expect(info.postDoneReasoningChars).toBe(4)
    // 全程累计与收尾日志同口径
    expect(info.contentChars).toBe(8)
    expect(info.reasoningChars).toBe(4)
  })

  it('上游收尾两次 → dones=2（第二套收尾同样只会被客户端丢弃）', async () => {
    const info = await auditOf([
      'event: output\ndata: {"response":"正文"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ])
    expect(info.dones).toBe(2)
    expect(info.postDoneContentChars).toBe(0)
  })

  it('没发 done 的流：审计仍触发且 dones=0（与 onTruncated 同一事实，调用方据此去重）', async () => {
    const info = await auditOf(['event: output\ndata: {"response":"半句"}\n\n'])
    expect(info.dones).toBe(0)
    expect(info.contentChars).toBe(2)
  })
})

/**
 * transport 换号无信息增益：`transport` 与账号健康无关（`applyChatError` 对它刻意不罚号），
 * 撞的始终是同一条「网关↔上游建连」。故撞满 `MAX_TRANSPORT_ATTEMPTS`(1) 即跳出，不再拿健康
 * 账号白耗一个建连超时（实测坏路径 connect 恰好撞满上限、0.5s 后重试即成功）。
 *
 * 两个 owner 都要覆盖：
 *  - SOLO 主循环（proxyTraeChatRequest）：3 个账号在池里，但只允许撞 1 次；
 *  - Work 循环（executeWorkRequest）：transport 既不罚号（workErrCount 保持 0），也只撞 1 次。
 */
describe('Trae transport：撞满 1 次即跳出（换号无信息增益）', () => {
  const PROVIDER_ID = 'trae-transport-cap'
  const UIDS = ['u_cap_1', 'u_cap_2', 'u_cap_3']

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

  /** 3 个账号：足够证明「不是账号池挑不出第 3 个」，而是刻意不撞第 3 次。 */
  function makeProvider(id: string): any {
    return {
      id,
      name: 'TRAE transport cap',
      type: 'trae',
      apiKeys: UIDS.map((uid) => ({
        key: JSON.stringify({
          uid,
          token: `tok_${uid}`,
          refreshToken: `ref_${uid}`,
          // 毫秒口径（远大于秒口径的 now+24h）→ needsTraeRefresh 为 false，测试只打转发端点
          expiresAt: Date.now() + 3600_000,
        }),
        enabled: true,
      })),
    }
  }

  it('SOLO 与 Work 双双 transport → SOLO 只撞 1 次（池里还有第 2、3 个账号也不撞）', async () => {
    const originalFetch = globalThis.fetch
    let soloCalls = 0
    let workCalls = 0
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        workCalls++
        throw new Error('The operation was aborted')
      }
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        soloCalls++
        throw new Error('The operation was aborted')
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-solo`
      const provider = makeProvider(pid)
      for (const uid of UIDS) await setTraeWorkCredits(env, pid, uid, 50)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      // 修复前是 3（MAX_ROTATE）；2026-10-08 前是 2；现在是第 1 次 transport 即定性，跳出
      expect(soloCalls).toBe(1)
      // Work 兜底同样撞满 1 次即停
      expect(workCalls).toBe(1)
      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')
      expect(String(body.error.message)).not.toContain('all accounts unavailable')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('Work 通道 transport 不罚号：workErrCount/errCount 全为 0、不进冷却', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('The operation was aborted') }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-work`
      const provider = makeProvider(pid)
      for (const uid of UIDS) await setTraeWorkCredits(env, pid, uid, 50)

      // 显式 Work 模型 → 直通 executeWorkRequest，不经过 SOLO 主循环
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'DeepSeek-V4-Flash-Official',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      expect(resp.status).toBe(503)
      const pool = await readTraePool(env, pid)
      for (const uid of UIDS) {
        // 连接层故障不是账号故障：既不计 SOLO errCount，也不计 workErrCount
        expect(pool[uid]?.errCount ?? 0).toBe(0)
        expect(pool[uid]?.until ?? 0).toBe(0)
        expect(pool[uid]?.workErrCount ?? 0).toBe(0)
        expect(pool[uid]?.workUntil ?? 0).toBe(0)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * Token 预刷新（`exchangeToken` → `doJson`）阶段的连接层失败。
 *
 * 缺陷（本轮修）：`doJson` / `doJsonText` 原先抛**裸** Error（无 `kind`），于是 proxy 的
 * refresh catch 走 `else` 分支把网络抖动当成账号故障冷却 10 分钟——正是 CODING_NOTES
 * 「连接层/收尾层失败不是账号故障，禁止罚号」的反面，且两个循环（SOLO / Work）都有这一处。
 *
 * 修法：`doJson` / `doJsonText` 的 fetch catch 打 `kind='transport'`；两处 refresh catch 加
 * transport 分支——不冷却、只计数、撞满 `MAX_TRANSPORT_ATTEMPTS` 即跳出。
 *
 * 用 `expiresAt: 0` 强制 `needsTraeRefresh` 为真，使请求在**刷新阶段**就失败（不碰转发端点）。
 */
describe('Trae token 预刷新：连接层失败不罚号、撞满 1 次即跳出', () => {
  const PROVIDER_ID = 'trae-refresh-transport'
  const UIDS = ['u_rf_1', 'u_rf_2', 'u_rf_3']

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

  /** expiresAt: 0 → needsTraeRefresh 恒为真（每轮必先刷新 token）。 */
  function makeProvider(id: string): any {
    return {
      id,
      name: 'TRAE refresh transport',
      type: 'trae',
      apiKeys: UIDS.map((uid) => ({
        key: JSON.stringify({
          uid,
          token: `tok_${uid}`,
          refreshToken: `ref_${uid}`,
          expiresAt: 0,
        }),
        enabled: true,
      })),
    }
  }

  const EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken'

  it('SOLO 循环：刷新阶段 transport → 只撞 1 次、不冷却账号、503 upstream_unreachable', async () => {
    const originalFetch = globalThis.fetch
    let exchangeCalls = 0
    let forwardCalls = 0
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes(EXCHANGE)) {
        exchangeCalls++
        throw new Error('The operation was aborted')
      }
      forwardCalls++
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-solo`
      const provider = makeProvider(pid)

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        // 带 tools → Work 兜底禁用，把断言锁在 SOLO 循环这一处
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      })

      // 修复前是 3（MAX_ROTATE）；2026-10-08 前是 2；现在是第 1 次 transport 即定性，跳出
      expect(exchangeCalls).toBe(1)
      // 刷新就失败 → 从未打到转发端点
      expect(forwardCalls).toBe(0)
      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')

      // 核心：网络抖动不再被当成账号故障（修复前这里是 errMs 冷却 + reason='refresh: ...'）
      const pool = await readTraePool(env, pid)
      for (const uid of UIDS) {
        expect(pool[uid]?.errCount ?? 0).toBe(0)
        expect(pool[uid]?.until ?? 0).toBe(0)
        expect(pool[uid]?.reason ?? '').not.toContain('refresh')
        expect(pool[uid]?.workErrCount ?? 0).toBe(0)
        expect(pool[uid]?.workUntil ?? 0).toBe(0)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('Work 循环：刷新阶段 transport → 同样只撞 1 次、不罚号（含 workErrCount）', async () => {
    const originalFetch = globalThis.fetch
    let exchangeCalls = 0
    let workCalls = 0
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) { workCalls++; return new Response('x', { status: 200 }) }
      if (url.includes(EXCHANGE)) {
        exchangeCalls++
        throw new Error('The operation was aborted')
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const env = makeEnv()
      const pid = `${PROVIDER_ID}-work`
      const provider = makeProvider(pid)

      // 显式 Work 模型 → 先走 executeWorkRequest（Work 循环自己的 refresh catch）
      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'DeepSeek-V4-Flash-Official',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })

      // 三个刷新阶段各封顶 1 次：Work 主路径 1 + SOLO 兜底路径 1 + 函数末尾 Work 兜底 1。
      // 未封顶时每段都是 3（MAX_ROTATE）→ 合计 9；封顶 2 次时合计 6。
      expect(exchangeCalls).toBe(3)
      // 刷新全部失败 → 从未打到 Work 转发端点
      expect(workCalls).toBe(0)
      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')

      const pool = await readTraePool(env, pid)
      for (const uid of UIDS) {
        expect(pool[uid]?.errCount ?? 0).toBe(0)
        expect(pool[uid]?.until ?? 0).toBe(0)
        expect(pool[uid]?.workErrCount ?? 0).toBe(0)
        expect(pool[uid]?.workUntil ?? 0).toBe(0)
        expect(pool[uid]?.reason ?? '').not.toContain('refresh')
        expect(pool[uid]?.workReason ?? '').not.toContain('refresh')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * 连接层失败可见性回归（2026-10-07，`trae/deepseek-v4.1-flash`，DSH 会话 `session-5890068d`）。
 *
 * 真相（会话记录实测 30 次失败，每次尝试 61.6–64.0s）：不是账号池问题、也不是客户端重试延迟，
 * 而是网关自己的 `TRAE_CHAT_CONNECT_TIMEOUT_MS`(30s) 掐断了「建连 + 响应头」阶段；带 tools 时
 * Work 兜底被跳过，于是白等 62s（≈2×30s）才回 503。而这条路径原先**一条日志都不落**，
 * 面板「系统日志」完全查不到，只能靠翻 DSH 会话记录反推。
 *
 * 本组锁三件事：
 *  1. abort 文案自描述（`connect timeout <ms>`，毫秒数即当前常量值），不再是一句含糊的
 *     `The operation was aborted`；
 *  2. `TraeConnectTiming` 出口：失败侧 connectMs 达标且 connectTimeout=true，成功侧 connectMs 有值
 *     ——「成功样本的 connect 分布」是判断 30s 常量是否过紧的唯一依据（别凭感觉放宽）；
 *  3. 失败必须落 KV：每条尝试一行 `[trae-transport]`，收尾一行聚合结论（与 cline `[cline-attempt]` 同口径）。
 */
describe('Trae 连接层失败可见性：connect 耗时采样与 [trae-transport] 落 KV', () => {
  const VIS_UIDS = ['u_vis_1', 'u_vis_2']

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
      name: 'TRAE visibility',
      type: 'trae',
      apiKeys: VIS_UIDS.map((uid) => ({
        key: JSON.stringify({
          uid,
          token: `tok_${uid}`,
          refreshToken: `ref_${uid}`,
          expiresAt: Date.now() + 3600_000,
        }),
        enabled: true,
      })),
    }
  }

  /** KV 里的全部条目原文（池状态等非日志 JSON 也返回，由断言自行过滤）。 */
  function kvTexts(env: any): string[] {
    return [...env.KV.data.values()].map((v: string) => String(v))
  }

  const account = (uid: string) => ({
    accessToken: 'tok',
    refreshToken: 'ref',
    expiresAt: Date.now() + 3600_000,
    uid,
  })

  it('chatStream 到点 abort → 文案自描述含 connect timeout，connectTimeout=true 且 connectMs 达标', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const originalFetch = globalThis.fetch
    // 按规范语义模拟：signal 被 abort 时 fetch 以 signal.reason 拒绝。
    // （workerd 是否把 reason 透传成拒绝原因未在本地验证；不透传时文案退回修复前形态，行为不变。）
    globalThis.fetch = ((_input: any, init?: any) => new Promise((_resolve, reject) => {
      const sig = init?.signal
      const onAbort = () => reject(sig?.reason instanceof Error ? sig.reason : new Error('The operation was aborted'))
      if (sig?.aborted) onAbort()
      else sig?.addEventListener('abort', onAbort)
    })) as any
    try {
      const timing: TraeConnectTiming = {}
      const pending = chatStream(account('u_timeout'), { messages: [{ role: 'user', content: 'hi' }] }, timing)
      const assertion = expect(pending).rejects.toThrow(new RegExp(`connect timeout ${TRAE_CHAT_CONNECT_TIMEOUT_MS}ms`))
      await vi.advanceTimersByTimeAsync(TRAE_CHAT_CONNECT_TIMEOUT_MS + 100)
      await assertion
      expect(timing.connectTimeout).toBe(true)
      expect(timing.connectMs).toBeGreaterThanOrEqual(TRAE_CHAT_CONNECT_TIMEOUT_MS)
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('chatStream 成功 → connectMs 被填、且不被标记为超时（成功侧 connect= 分布的数据源）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('event: done\ndata: {}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as any
    try {
      const timing: TraeConnectTiming = {}
      const resp = await chatStream(account('u_ok'), { messages: [{ role: 'user', content: 'hi' }] }, timing)
      expect(resp.status).toBe(200)
      expect(typeof timing.connectMs).toBe('number')
      expect(timing.connectMs).toBeGreaterThanOrEqual(0)
      expect(timing.connectTimeout).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('带 tools + 2 账号：上游自己断（timeout=false）→ 不走阶梯重发，1 条 phase=solo 日志 + 1 条 attempts=1 聚合行，且绝不试 Work', async () => {
    const originalFetch = globalThis.fetch
    let workCalls = 0
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes('/api/agent/v3/create_agent_task')) {
        workCalls++
        return new Response('x', { status: 200 })
      }
      throw new Error('The operation was aborted')
    }) as any
    try {
      const env = makeEnv()
      const provider = makeProvider('trae-visibility')

      const resp = await proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      })

      expect(resp.status).toBe(503)
      // 带 tools → 不试 Work：生产事故里「62s ≈ 2×30s」的形态
      expect(workCalls).toBe(0)

      const logs = kvTexts(env)
      const solo = logs.filter((t) => t.includes('[trae-transport]') && t.includes('phase=solo'))
      // 阶梯只对「网关自己的定时器掐断」（timeout=true）重发；这里是 fetch 当场抛错（timeout=false），
      // 属于「上游/网络自己断」→ 保持改前语义：一次即收手，不拿第二次白撞。
      expect(solo).toHaveLength(1)
      expect(solo[0]).toContain('attempt=1/2')
      expect(solo[0]).toContain('stage=10000ms')
      expect(solo[0]).toContain('timeout=false')
      for (const t of solo) {
        expect(t).toContain('connect=')  // 连接阶段耗时：判断死线是否过紧的唯一依据
        expect(t).toContain('uid=')
        expect(t).toContain('err=chat transport error')
      }

      const summary = logs.filter((t) => t.includes('[trae-transport]') && t.includes('end=503'))
      expect(summary).toHaveLength(1)
      expect(summary[0]).toContain('attempts=1')
      expect(summary[0]).toContain('tools=true')
      expect(summary[0]).toContain('workFallback=false')
      expect(logs.some((t) => t.includes('phase=work'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * 建连死线阶梯（2026-10-09，`TRAE_CONNECT_DEADLINES_MS`）。
 *
 * 真相：坏连接是「死」不是「慢」（60s 实验已证），等满上限毫无收益，唯一有信息量的动作是
 * 「换一条连接」。线上会话 session-1e29c762 实测每次坏连接让客户端白等 32–34s 并各收一次 503，
 * 而它 0.5s 后的重试全成功 ⇒ 第 1 段（10s）一撞就立刻在原账号换新连接重发。
 *
 * 本组锁三件事：
 *  1. 第 1 段撞满 → **原账号**（Authorization 不变）换新连接重发，第 2 段成功即 200，
 *     且只留 1 条 `[trae-transport]`（stage=10000ms）——坏窗口不再向客户端报错；
 *  2. 两段都撞满 → 503，逐段死线 10000ms / 30000ms 各一条日志，聚合 `attempts=2`；
 *  3. 不变量：默认单段上限恒等于阶梯最后一段（保证「不走阶梯」的调用点行为不变）。
 */
describe('Trae 建连死线阶梯：第一段快失败 → 原账号换连接重发', () => {
  const LADDER_ID = 'trae-ladder'
  const LADDER_UIDS = ['u_lad_1', 'u_lad_2']

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
      name: 'TRAE ladder',
      type: 'trae',
      apiKeys: LADDER_UIDS.map((uid) => ({
        key: JSON.stringify({
          uid,
          token: `tok_${uid}`,
          refreshToken: `ref_${uid}`,
          expiresAt: Date.now() + 3600_000,
        }),
        enabled: true,
      })),
    }
  }

  /** 永不回响应头的连接：只有 signal abort 才拒绝（模拟生产里的死连接）。 */
  function hangingFetch(onAuth: (auth: string) => void) {
    return (_input: any, init?: any) => new Promise((_resolve, reject) => {
      onAuth(String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ''))
      const sig = init?.signal
      const onAbort = () => reject(sig?.reason instanceof Error ? sig.reason : new Error('The operation was aborted'))
      if (sig?.aborted) onAbort()
      else sig?.addEventListener('abort', onAbort)
    })
  }

  it('第 1 段（10s）撞满 → 同账号换新连接重发 → 第 2 段成功，客户端拿到 200 而非 503', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const originalFetch = globalThis.fetch
    const auths: string[] = []
    let call = 0
    globalThis.fetch = ((input: any, init?: any) => {
      if (String(input).includes('/api/agent/v3/create_agent_task')) {
        return Promise.resolve(new Response('x', { status: 200 }))
      }
      call++
      // 第 1 次：死连接（只在我们 10s 死线到点时才拒绝）；第 2 次：好连接，几秒内回响应头。
      if (call === 1) return hangingFetch((a) => auths.push(a))(input, init)
      auths.push(String(init?.headers?.Authorization ?? ''))
      return Promise.resolve(new Response(
        'event: output\ndata: {"response":"重发成功"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ))
    }) as any
    try {
      const env = makeEnv()
      const provider = makeProvider(`${LADDER_ID}-ok`)
      const pending = proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      })
      await vi.advanceTimersByTimeAsync(TRAE_CONNECT_DEADLINES_MS[0] + 100)
      const resp = await pending

      expect(resp.status).toBe(200)
      const body = await resp.json() as any
      expect(body.choices[0].message.content).toBe('重发成功')

      // 两次请求必须是**同一个账号**（只换连接，不换号——transport 与账号健康无关）
      expect(auths).toHaveLength(2)
      expect(auths[0]).toBe(auths[1])

      const solo = [...env.KV.data.values()].map(String).filter((t) => t.includes('[trae-transport]') && t.includes('phase=solo'))
      expect(solo).toHaveLength(1)          // 只有第 1 段失败过一次，重发成功不落失败日志
      expect(solo[0]).toContain('attempt=1/2')
      expect(solo[0]).toContain('stage=10000ms')
      expect(solo[0]).toContain('timeout=true')
      // 成功路径的 connect 采样走 [trae-stream] end= 日志（仅流式路径落），非流式不落；非流式的
      // 「第 2 段实际耗时」由上面 auths 两次 + 200 结果共同证明，不另设日志。
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('两段都撞满 → 503，逐段死线 10000ms/30000ms 各落一条，聚合 attempts=2', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const originalFetch = globalThis.fetch
    const auths: string[] = []
    globalThis.fetch = ((input: any, init?: any) => {
      if (String(input).includes('/api/agent/v3/create_agent_task')) {
        return Promise.resolve(new Response('x', { status: 200 }))
      }
      return hangingFetch((a) => auths.push(a))(input, init)
    }) as any
    try {
      const env = makeEnv()
      const provider = makeProvider(`${LADDER_ID}-dead`)
      const pending = proxyTraeChatRequest(env, provider, {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      })
      await vi.advanceTimersByTimeAsync(TRAE_CONNECT_DEADLINES_MS[0] + 100)
      await vi.advanceTimersByTimeAsync(TRAE_CONNECT_DEADLINES_MS[1] + 100)
      const resp = await pending

      expect(resp.status).toBe(503)
      const body = await resp.json() as any
      expect(body.error.code).toBe('upstream_unreachable')

      // 池里有第 2 个账号，但阶梯重发只用原账号：不拿健康号去撞同一条链路
      expect(auths).toHaveLength(2)
      expect(auths[0]).toBe(auths[1])

      const logs = [...env.KV.data.values()].map(String)
      const solo = logs.filter((t) => t.includes('[trae-transport]') && t.includes('phase=solo'))
      expect(solo).toHaveLength(2)
      expect(solo[0]).toContain('attempt=1/2')
      expect(solo[0]).toContain('stage=10000ms')
      expect(solo[1]).toContain('attempt=2/2')
      expect(solo[1]).toContain('stage=30000ms')
      for (const t of solo) expect(t).toContain('timeout=true')

      const summary = logs.filter((t) => t.includes('[trae-transport]') && t.includes('end=503'))
      expect(summary).toHaveLength(1)
      expect(summary[0]).toContain('attempts=2')
      expect(summary[0]).toContain('tools=true')
      expect(logs.some((t) => t.includes('phase=work'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('不变量：默认单段上限恒等于阶梯最后一段（不走阶梯的调用点行为不变）', () => {
    expect(TRAE_CONNECT_DEADLINES_MS.length).toBeGreaterThanOrEqual(2)
    expect(TRAE_CHAT_CONNECT_TIMEOUT_MS).toBe(TRAE_CONNECT_DEADLINES_MS[TRAE_CONNECT_DEADLINES_MS.length - 1])
    // 逐段放宽：后面的段必须 ≥ 前面的段，否则「重发」会越来越紧
    for (let i = 1; i < TRAE_CONNECT_DEADLINES_MS.length; i++) {
      expect(TRAE_CONNECT_DEADLINES_MS[i]).toBeGreaterThanOrEqual(TRAE_CONNECT_DEADLINES_MS[i - 1])
    }
    // 最后一段必须 ≥ 原 30s：只有如此才能保证「改前能成功的请求，改后仍然成功」
    expect(TRAE_CHAT_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(30000)
  })
})
