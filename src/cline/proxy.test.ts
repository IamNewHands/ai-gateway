import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCooldownMs, fetchClineModels, isRunawayReasoningCutoff, isDegenerateReasoningDeltas, isWhitespaceOnlyReasoningDelta, normalizeReasoningDeltaForUI, pumpStreamAttempt, sanitizeClineMessages, isFreeClineModel, buildUpstreamBody, clineMaxOutputLimit, clineMaxTokensClamp, proxyClineChatRequest, __resetClineCatalogCacheForTests, CLINE_MAX_TOKENS, CLINE_FREE_WHITELIST, CLINE_CHAT_CONNECT_TIMEOUT_MS, CLINE_MAX_TRANSPORT_ATTEMPTS, CLINE_PROBE_MAX_MS, CLINE_KEEPALIVE_MS, DEFAULT_MODEL } from './proxy'
import type { Provider } from '../types'

/** 读取一个 Response 的完整文本（用于流式结果断言）。 */
async function readAll(resp: Response): Promise<string> {
  const reader = resp.body!.getReader()
  const dec = new TextDecoder()
  let s = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    s += dec.decode(value, { stream: true })
  }
  return s
}

function sseResp(body: string): Response {
  return new Response(body, { status: 200 })
}

function dataFrame(delta: Record<string, unknown>, finish?: string): string {
  const choice: Record<string, unknown> = { index: 0 }
  if (finish) choice.finish_reason = finish
  if (Object.keys(delta).length) choice.delta = delta
  return `data: ${JSON.stringify({ id: 'x', choices: [choice] })}\n\n`
}

function doneFrame(): string {
  return 'data: [DONE]\n\n'
}

describe('Cline 冷却时长解析（item3）', () => {
  it('解析 "Try again in 2h 51m" 为毫秒', () => {
    expect(parseCooldownMs('Try again in 2h 51m')).toBe((2 * 3600 + 51 * 60) * 1000)
  })
  it('解析 "30min" / "15s"', () => {
    expect(parseCooldownMs('30m')).toBe(30 * 60 * 1000)
    expect(parseCooldownMs('Try again in 30m')).toBe(30 * 60 * 1000)
    expect(parseCooldownMs('try again in 15 seconds')).toBe(15 * 1000)
  })
  it('解析 "1 hour"', () => {
    expect(parseCooldownMs('Try again in 1 hour')).toBe(3600 * 1000)
  })
  it('无匹配返回 null', () => {
    expect(parseCooldownMs('please wait a moment')).toBeNull()
    expect(parseCooldownMs('')).toBeNull()
    expect(parseCooldownMs(null as unknown as string)).toBeNull()
  })
  it('超过 6h 封顶（item3 防止账号被过久冻结）', () => {
    const capped = parseCooldownMs('Try again in 10h')
    expect(capped).not.toBeNull()
    expect(capped as number).toBe(6 * 3600 * 1000)
  })
})

describe('Cline 模型清单（回归保护）', () => {
  it('fetchClineModels 返回 OpenAI 模型列表结构', () => {
    const r = fetchClineModels()
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.models)).toBe(true)
    expect(r.models.length).toBeGreaterThan(0)
    expect(r.models[0]).toHaveProperty('id')
  })
})

describe('推理空转截断判定 isRunawayReasoningCutoff', () => {
  it('length 截断且无正文/无工具调用 → 判定为空转', () => {
    expect(isRunawayReasoningCutoff('', [], 'length')).toBe(true)
    expect(isRunawayReasoningCutoff('   \n\n', [], 'length')).toBe(true) // 仅空白
  })
  it('length 截断但已有正文 → 不判空转（是正常被截断的长回答）', () => {
    expect(isRunawayReasoningCutoff('有正文内容', [], 'length')).toBe(false)
    expect(isRunawayReasoningCutoff('代码/正文', [], 'length')).toBe(false)
  })
  it('length 截断但已有工具调用 → 不判空转', () => {
    expect(isRunawayReasoningCutoff('', [{ id: 'call_1' }], 'length')).toBe(false)
  })
  it('非 length 结束原因 → 一律不判空转', () => {
    expect(isRunawayReasoningCutoff('', [], 'stop')).toBe(false)
    expect(isRunawayReasoningCutoff('', [], 'tool_calls')).toBe(false)
    expect(isRunawayReasoningCutoff('', [], '')).toBe(false)
  })
})

describe('推理退化检测 isDegenerateReasoningDeltas（2026-09-05 流式防护 v2）', () => {
  // 样本取自真实会话日志校准
  it('病态：纯空白/换行洪泛（空白占 95% 的乱码长文）→ 判定退化', () => {
    // 250+ 字符，几乎全是空白/换行（T5/S34 / "3.2 万条 reasoning 95% 空白" 形态）
    const deltas = Array.from({ length: 60 }, () => '\n  \n   \n  \n ')
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('病态：单字符乱码铺满 250+ 字符 → 判定退化', () => {
    const deltas = Array.from({ length: 90 }, (_, i) => (i % 5 === 0 ? '\uFFFD ' : '\n  \n '))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('正常：一词一行但内容连贯（本次被 v1 误杀的 T18/S7 形态）→ 不误伤（关键回归）', () => {
    // glm 把每个思考 token 单独成行：空白占比 ~0.4，但内容是连贯技术推理
    const prose = ['The ', 'user ', 'installed ', '`gh` ', 'CLI. ', 'The ', '422 ', 'root ', 'cause ', 'was ', 'clear ']
    const deltas: string[] = []
    for (let i = 0; i < 70; i++) {
      const w = prose[i % prose.length]
      // 每段后跟换行，模拟"一词一行"
      deltas.push(w.replace(/ /g, '\n'))
    }
    expect(isDegenerateReasoningDeltas(deltas)).toBe(false)
  })
  it('正常：连贯英文思考 token 流（T6/S23 形态，换行稀疏）→ 不误伤', () => {
    const words = ['Now', ' I', ' see', ' the', ' issue', '.', ' The', ' `buildToolLedger`', ' uses', ' `toolCallFingerprint`', ' which', ' compiles', ' the', ' fingerprint', '.\n']
    const deltas = Array.from({ length: 90 }, (_, i) => words[i % words.length])
    expect(isDegenerateReasoningDeltas(deltas)).toBe(false)
  })
  it('正常：中文长思考（无英文词、换行少）→ 不误伤', () => {
    const deltas = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? '\n' : '先读取 tool-ledger.ts 的实现，再对比两边的差异并规划重写。'))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(false)
  })
  it('短片段（<250 字符）不做退化判定 → 不误拦短思考', () => {
    expect(isDegenerateReasoningDeltas(['\n\n\n\n\n\n'])).toBe(false) // 短空白自限
    expect(isDegenerateReasoningDeltas([])).toBe(false)
  })
})

describe('流式转发 pumpStreamAttempt（2026-09-05 流式语义回归保护）', () => {
  it('正常思考→放行：Response 立即返回并完整透传 reasoning + 正文（不整轮缓冲卡住）', async () => {
    // 模拟一个正常 glm 会话：若干小 reasoning token，然后正文，然后 finish。
    let body = ''
    for (const t of ['Now', ' I', ' see', ' the', ' issue', '.', ' Let', ' me', ' plan', '.\n']) {
      body += dataFrame({ reasoning_content: t })
    }
    for (const c of ['Hello', ' world', '!']) body += dataFrame({ content: c })
    body += dataFrame({}, 'stop')
    body += doneFrame()

    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('Now')
    expect(text).toContain('Hello')
    expect(text).toContain('stop')
    expect(text).toContain('[DONE]')
  })

  it('退化空转（空白洪泛 ≥250 字符）→ 拦截，返回 degenerate 不把垃圾放行给客户端', async () => {
    let body = ''
    for (let i = 0; i < 160; i++) body += dataFrame({ reasoning_content: ' \n ' }) // ~480 字符，空白为主
    body += dataFrame({}, 'length')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('degenerate')
  })

  it('退化空转（长纯空白即结束）→ 拦截为 degenerate（不烧预算）', async () => {
    let body = ''
    for (let i = 0; i < 160; i++) body += dataFrame({ reasoning_content: '\n \n' })
    body += dataFrame({}, 'length')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('degenerate')
  })

  it('短且正常（窗口内就结束、不足 24 条）→ 放行缓冲内容，不误拦', async () => {
    let body = ''
    for (const t of ['Clone', ' the', ' repo', '.', ' Let', ' me', ' start', '.']) {
      body += dataFrame({ reasoning_content: t })
    }
    body += dataFrame({ content: 'Done' })
    body += dataFrame({}, 'stop')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('Done')
  })
})

// 探测期时间上限 + 续流心跳（2026-10-05，移植 luawei1/cline2api `a055b13`）：
// 探测期此前一个字节都不写给客户端，Response 直到判定完成才构造——慢首 token
// （长 reasoning / 上游排队）会被中间层读超时掐成 524。现在到点即放行，
// 退化保护交给续流阶段的滚动监控（routeToStream 抑制 + upstream_runaway）。
describe('探测期上限与续流心跳（防 524）', () => {
  /** 可控上游：enqueue 决定何时吐帧，close 决定何时 EOF。 */
  function controlledUpstream() {
    const enc = new TextEncoder()
    let c: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(cc) { c = cc },
    })
    return {
      resp: new Response(stream, { status: 200 }),
      push: (s: string) => c!.enqueue(enc.encode(s)),
      close: () => c!.close(),
    }
  }

  it('上游迟迟不吐内容 → 探测到 CLINE_PROBE_MAX_MS 就放行（Response 不再被扣住）', async () => {
    vi.useFakeTimers()
    try {
      const up = controlledUpstream()
      const pending = pumpStreamAttempt(up.resp)
      await vi.advanceTimersByTimeAsync(CLINE_PROBE_MAX_MS + 50)
      const outcome = await pending
      expect(outcome.kind).toBe('healthy')
      expect(outcome.response).toBeDefined()
      up.push(dataFrame({ content: 'hi' }) + dataFrame({}, 'stop') + doneFrame())
      up.close()
      expect(await readAll(outcome.response!)).toContain('"content":"hi"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('到点时若空白洪泛证据已足，仍按 degenerate 拦截（退化保护不被上限削弱）', async () => {
    vi.useFakeTimers()
    try {
      const up = controlledUpstream()
      // 先灌够退化判定的空白字符量（≥250 且空白占比 ≥0.55）
      for (let i = 0; i < 100; i++) up.push(dataFrame({ reasoning_content: ' \n ' }))
      const pending = pumpStreamAttempt(up.resp)
      await vi.advanceTimersByTimeAsync(CLINE_PROBE_MAX_MS + 50)
      const outcome = await pending
      expect(outcome.kind).toBe('degenerate')
    } finally {
      vi.useRealTimers()
    }
  })

  it('慢思考（正常 reasoning、无正文）到点放行，续流期补 : keep-alive 心跳', async () => {
    vi.useFakeTimers()
    try {
      const up = controlledUpstream()
      const pending = pumpStreamAttempt(up.resp)
      await vi.advanceTimersByTimeAsync(CLINE_PROBE_MAX_MS + 50)
      const outcome = await pending
      expect(outcome.kind).toBe('healthy')
      // 上游此后长时间静默：应出现心跳注释行，且不含任何 data 帧
      await vi.advanceTimersByTimeAsync(CLINE_KEEPALIVE_MS * 2 + 50)
      up.push(dataFrame({ content: 'hi' }) + dataFrame({}, 'stop') + doneFrame())
      up.close()
      const text = await readAll(outcome.response!)
      expect(text).toContain(': keep-alive')
      expect(text).not.toContain('upstream_no_finish')
    } finally {
      vi.useRealTimers()
    }
  })

  it('上游持续出帧时不产生心跳（不会在正文中间插注释行）', async () => {
    vi.useFakeTimers()
    try {
      const up = controlledUpstream()
      const pending = pumpStreamAttempt(up.resp)
      up.push(dataFrame({ content: 'a' }))
      const outcome = await pending
      expect(outcome.kind).toBe('healthy')
      // 与生产一致：客户端一直在读（TransformStream 的写要等读方才 resolve）
      const parts: string[] = []
      const dec = new TextDecoder()
      const consume = (async () => {
        const reader = outcome.response!.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(dec.decode(value, { stream: true }))
        }
      })()
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(0) // 让续流任务把这一帧写出去（刷新 lastEmitAt）
        await vi.advanceTimersByTimeAsync(CLINE_KEEPALIVE_MS - 1000)
        up.push(dataFrame({ content: 'b' }))
      }
      await vi.advanceTimersByTimeAsync(0)
      up.push(dataFrame({}, 'stop') + doneFrame())
      up.close()
      await vi.advanceTimersByTimeAsync(0)
      await consume
      expect(parts.join('')).not.toContain(': keep-alive')
      expect(parts.join('')).toContain('"content":"a"')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('单词间换行碎片过滤 isWhitespaceOnlyReasoningDelta（2026-09-06 会话日志确认的 glm 一词一行形态）', () => {
  it('纯空白单换行/空格 delta → 噪声', () => {
    expect(isWhitespaceOnlyReasoningDelta('\n')).toBe(true)
    expect(isWhitespaceOnlyReasoningDelta(' ')).toBe(true)
    expect(isWhitespaceOnlyReasoningDelta(' \n ')).toBe(true)
    expect(isWhitespaceOnlyReasoningDelta('')).toBe(false)
    expect(isWhitespaceOnlyReasoningDelta(null)).toBe(false)
    expect(isWhitespaceOnlyReasoningDelta(' TLS')).toBe(false)
  })
  it('纯空白双换行也属于供应商排版噪声，正文双换行仍交给归一化处理', () => {
    expect(isWhitespaceOnlyReasoningDelta('\n\n')).toBe(true)
    expect(isWhitespaceOnlyReasoningDelta('\n \n')).toBe(true)
    expect(isWhitespaceOnlyReasoningDelta('.\n\n')).toBe(false)
  })
  it('流式端到端：token+独立"\\n"交替的思考流 → 健康放行，但纯空白 delta 不再直播到客户端', async () => {
    // 模拟 glm 实测形态：每个 token 后跟一条独立的 "\n" delta（会话日志 reasoning-chunks 证实）
    let body = ''
    for (const t of [' TLS', '\n', ' S', '\n', 'NI', '\n', ' mismatch', '\n']) {
      body += dataFrame({ reasoning_content: t })
    }
    body += dataFrame({ reasoning_content: '\n\n' }) // 段落分隔，必须保留
    body += dataFrame({ content: 'ok' })
    body += dataFrame({}, 'stop')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('TLS')
    expect(text).not.toContain('reasoning_content":"\\n\\n"') // 独立双换行同样视为供应商排版噪声
    expect(text).not.toContain('reasoning_content":"\\n"') // 单词间 "\n" delta 已被过滤
    expect(text).not.toContain('reasoning_content":" "') // 空格 delta 同样被过滤
  })
})

describe('粘标点换行归一化 normalizeReasoningDeltaForUI（2026-09-06 log4 确认的第二形态）', () => {
  it('尾部单个换行 → 折叠成空格（分句连排成段）', () => {
    expect(normalizeReasoningDeltaForUI('.\n')).toBe('. ')
    expect(normalizeReasoningDeltaForUI(',\n')).toBe(', ')
    expect(normalizeReasoningDeltaForUI(' (')).toBe(' (')
    expect(normalizeReasoningDeltaForUI(' TLS')).toBe(' TLS')
  })
  it('尾部多个换行 → 折叠成空格，避免供应商逐句双换行形成空白段落', () => {
    expect(normalizeReasoningDeltaForUI('—\n\n')).toBe('— ')
    expect(normalizeReasoningDeltaForUI('...\n\n\n')).toBe('... ')
    expect(normalizeReasoningDeltaForUI('a\n \n')).toBe('a ')
  })
  it('纯空白段落分隔 delta 归一化为空格，流式调用方会将其作为噪声抑制', () => {
    expect(normalizeReasoningDeltaForUI('\n\n')).toBe(' ')
  })
  it('流式端到端：".\\n" 粘标点帧 → 客户端收到 ". "（换行不再切行），退化判定用原始 delta 不受影响', async () => {
    let body = ''
    for (const t of ['Try', '.\n', ' then', ',\n', ' verify', '—\n\n']) {
      body += dataFrame({ reasoning_content: t })
    }
    body += dataFrame({ content: 'ok' })
    body += dataFrame({}, 'stop')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('reasoning_content":". "') // ".\n" → ". "
    expect(text).toContain('reasoning_content":", "') // ",\n" → ", "
    expect(text).toContain('reasoning_content":"— "') // 尾部双换行同样折叠为空格
    expect(text).not.toContain('reasoning_content":"—\\n\\n"')
    expect(text).not.toContain('reasoning_content":".\\n"')
  })
})

describe('reasoning_details 双字段帧（2026-09-06 Novita 池实测形态）', () => {
  /** 构造 Novita 风格帧：delta.reasoning + delta.reasoning_details 双字段，无 reasoning_content */
  function novitaFrame(reasoning: string): string {
    return 'data: ' + JSON.stringify({
      id: 'gen-x', object: 'chat.completion.chunk', created: 0, model: 'z-ai/glm-5.3-flash', provider: 'Novita',
      choices: [{
        index: 0, finish_reason: null, native_finish_reason: null,
        delta: { content: '', role: 'assistant', reasoning, reasoning_details: [{ type: 'reasoning.text', text: reasoning, format: 'unknown', index: 0 }] },
      }],
    }) + '\n\n'
  }
  it('归一化必须同步写穿 reasoning_details[].text（DSH 思考流读的是它）', async () => {
    let body = ''
    for (const t of [' thinking', '.\n', ' more', ',\n', ' done', '—\n\n\n']) {
      body += novitaFrame(t)
    }
    body += dataFrame({ content: 'ok' })
    body += dataFrame({}, 'stop')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    // text 与 reasoning 双字段同步归一化
    expect(text).toContain('text":". "')
    expect(text).toContain('text":", "')
    expect(text).toContain('text":"— "') // 三换行折叠为空格并同步写穿 reasoning_details
    expect(text).not.toContain('text":"—\\n\\n"')
    expect(text).not.toContain('"text":".\\n"')
    expect(text).not.toContain('"text":".\\n\\n\\n"')
  })
})

describe('上游中途断流（upstream_interrupted 错误帧）', () => {
  it('上游流中途 error → 客户端收到 upstream_interrupted 错误帧后流正常关闭（不再静默截断）', async () => {
    // 前 3 帧正常，第 4 帧模拟网络重置（reader 抛异常）
    let n = 0
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        n++
        if (n <= 3) c.enqueue(enc.encode(dataFrame({ reasoning_content: `t${n}` })))
        else c.error(new Error('network reset'))
      },
    })
    const outcome = await pumpStreamAttempt(new Response(body, { status: 200 }))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('t1')
    expect(text).toContain('upstream_interrupted')
  })
})

describe('reasoning 双换行回归（2026-09-10 Cline 分片漂移）', () => {
  it('普通短句尾部双换行不再形成一词一段', async () => {
    let body = ''
    for (const t of ['First sentence.\n\n', 'Second sentence.\n\n', 'Third sentence.']) {
      body += dataFrame({ reasoning_content: t })
    }
    body += dataFrame({ content: 'ok' })
    body += dataFrame({}, 'stop')
    body += doneFrame()

    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('reasoning_content":"First sentence. "')
    expect(text).toContain('reasoning_content":"Second sentence. "')
    expect(text).not.toContain('reasoning_content":"First sentence.\\n\\n"')
    expect(text).not.toContain('reasoning_content":"Second sentence.\\n\\n"')
  })
})

// ============================================================================
// cline2api 双上游移植（2026-09-24）新增覆盖
// 详见 _port-analysis/cline2api-0924-porting-analysis.md
//  - cline2api-workers v1.1.8 `43a2930`：免费档剥离 max_tokens
//  - luawei1/cline2api `1184f91`：非免费档 < 16 兜默认
//  - luawei1/cline2api `169fd9d`：模型级不可用时沿免费链降级，非 429/402 原样透传
//  - luawei1/cline2api `49fdb8a`：空名 tool_call / 孤儿 tool 结果清洗
// ============================================================================

/** 每个用例用独立 provider id，避免模块级账号池（含冷却状态）跨用例污染。 */
let providerSeq = 0
function clineProvider(keys: string[]): Provider {
  return {
    id: 'cline-test-' + ++providerSeq,
    name: 'Cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    apiType: 'openai',
    apiKeys: keys.map((k) => ({ key: k, enabled: true })),
  } as unknown as Provider
}

const REFRESH_TOKEN = 'rt-abcdefghijklmnop'
const PAID_MODEL = 'z-ai/glm-5.3-flash'

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 一段最小可用 SSE：一条正文 delta + finish_reason=stop + [DONE]。 */
const SSE_OK = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
]

function sseOkResp(): Response {
  return new Response(SSE_OK.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

interface FetchHarness {
  /** 每次 chat/completions 的上游请求体，按顺序。 */
  bodies: Array<Record<string, unknown>>
}

/** 安装 fetch 替身：目录端点 + auth refresh + chat 三路分流。 */
function installFetch(chat: (body: Record<string, unknown>, callIndex: number) => Response): FetchHarness {
  const bodies: Array<Record<string, unknown>> = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('recommended-models')) {
      return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
    }
    if (url.endsWith('/v1/models')) {
      return jsonResp({ data: [] })
    }
    if (url.includes('/auth/refresh')) {
      return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
    }
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      bodies.push(body)
      return chat(body, bodies.length - 1)
    }
    throw new Error('unexpected url: ' + url)
  })
  vi.stubGlobal('fetch', fn)
  return { bodies }
}

beforeEach(() => {
  __resetClineCatalogCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeClineMessages（移植 49fdb8a 步骤①② + 复用 cleanupOrphanToolCalls）', () => {
  it('丢弃空名 tool_call，保留合法 tool_call', () => {
    const out = sanitizeClineMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'a1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          { id: 'a2', type: 'function', function: { name: '', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a1', content: 'ok' },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(3)
    const tcs = out[1].tool_calls as Array<Record<string, unknown>>
    expect(tcs).toHaveLength(1)
    expect((tcs[0].function as Record<string, unknown>).name).toBe('Bash')
  })

  it('全部为空名时移除 tool_calls 字段', () => {
    const out = sanitizeClineMessages([
      { role: 'assistant', tool_calls: [{ id: 'a2', type: 'function', function: { name: '', arguments: '{}' } }] },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    expect('tool_calls' in out[0]).toBe(false)
  })

  it('丢弃孤儿 tool 结果（无对应合法 tool_call）', () => {
    const out = sanitizeClineMessages([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
      { role: 'tool', tool_call_id: '', content: 'no id' },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })

  it('顺序正确：空名 tool_call 被丢弃后，其 tool 结果也一并清掉（不会变成新孤儿）', () => {
    const out = sanitizeClineMessages([
      { role: 'assistant', tool_calls: [{ id: 'a2', type: 'function', function: { name: '', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a2', content: 'result of malformed call' },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
  })

  it('正常历史原样保留', () => {
    const input = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a1', content: 'data' },
    ]
    expect(sanitizeClineMessages(input)).toHaveLength(4)
  })

  it('非数组入参原样返回', () => {
    expect(sanitizeClineMessages(undefined)).toBeUndefined()
    expect(sanitizeClineMessages('nope')).toBe('nope')
  })
})

describe('isFreeClineModel（免费判定必须用列表成员，不能用前缀）', () => {
  it('free 列表成员判定优先于前缀', () => {
    const freeSet = new Set(['stealth/space-bunny-alpha'])
    // 无 cline-free/ 前缀，但确实在 free 列表里 —— 这是 2026-09-24 实测发现的形态
    expect(isFreeClineModel('stealth/space-bunny-alpha', freeSet)).toBe(true)
    // 有 cline-free/ 前缀，但不在 free 列表里 → 以列表为准
    expect(isFreeClineModel('cline-free/whatever', freeSet)).toBe(false)
  })

  it('无 free 列表时回落前缀与白名单启发式', () => {
    expect(isFreeClineModel('cline-free/deepseek-v4.1-flash')).toBe(true)
    expect(isFreeClineModel('cline-pass/glm-5.3')).toBe(false)
    expect(isFreeClineModel(CLINE_FREE_WHITELIST[0])).toBe(true)
  })
})

describe('buildUpstreamBody max_tokens 通道分档', () => {
  const freeSet = new Set([DEFAULT_MODEL])

  it('免费档剥离 max_tokens 与 max_completion_tokens（43a2930）', () => {
    expect(buildUpstreamBody({ model: DEFAULT_MODEL, max_tokens: 4096 }, true, 's1', freeSet).max_tokens).toBeUndefined()
    expect(buildUpstreamBody({ model: DEFAULT_MODEL, max_completion_tokens: 4096 }, true, 's1', freeSet).max_tokens).toBeUndefined()
  })

  it('非免费档保留客户端 max_tokens', () => {
    expect(buildUpstreamBody({ model: PAID_MODEL, max_tokens: 4096 }, true, 's1', freeSet).max_tokens).toBe(4096)
  })

  it('非免费档低于硬下限 16 兜到默认（1184f91）', () => {
    for (const raw of [0, 1, 8, 15]) {
      expect(buildUpstreamBody({ model: PAID_MODEL, max_tokens: raw }, true, 's1', freeSet).max_tokens).toBe(CLINE_MAX_TOKENS)
    }
    expect(buildUpstreamBody({ model: PAID_MODEL, max_tokens: 16 }, true, 's1', freeSet).max_tokens).toBe(16)
    expect(buildUpstreamBody({ model: PAID_MODEL, max_tokens: 1024 }, true, 's1', freeSet).max_tokens).toBe(1024)
  })

  it('非免费档未带 max_tokens 时兜默认护栏', () => {
    expect(buildUpstreamBody({ model: PAID_MODEL }, true, 's1', freeSet).max_tokens).toBe(CLINE_MAX_TOKENS)
  })

  it('messages 经过 sanitizeClineMessages 清洗', () => {
    const body = buildUpstreamBody(
      { model: DEFAULT_MODEL, messages: [{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: '' } }] }] },
      true,
      's1',
      freeSet,
    )
    const msgs = body.messages as Array<Record<string, unknown>>
    expect('tool_calls' in msgs[0]).toBe(false)
  })
})

// reasoning_effort=none 必须删字段而不是原样下发（Cline 上游无此枚举）：
// 移植 luawei1/cline2api `proxy.go:870-874` + issue #9。只有 Chat Completions 直连
// 路径会带着 "none" 到达这里——Anthropic / Responses 入口先被 sanitizeUpstreamBody 删掉。
describe('buildUpstreamBody reasoning_effort=none 不下发（移植 cline2api proxy.go:870）', () => {
  const freeSet = new Set([DEFAULT_MODEL])

  it('none 被删字段，且不回落到默认档（回落会把「关」变「开」）', () => {
    const body = buildUpstreamBody({ model: PAID_MODEL, reasoning_effort: 'none' }, true, 's1', freeSet)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('驼峰 reasoningEffort=none 同样被删', () => {
    const body = buildUpstreamBody({ model: PAID_MODEL, reasoningEffort: 'none' }, true, 's1', freeSet)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('合法档位原样下发（low/medium/high）', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(buildUpstreamBody({ model: PAID_MODEL, reasoning_effort: effort }, true, 's1', freeSet).reasoning_effort).toBe(effort)
    }
  })

  it('未指定时仍是默认护栏档（medium）', () => {
    expect(buildUpstreamBody({ model: PAID_MODEL }, true, 's1', freeSet).reasoning_effort).toBe('medium')
  })

  it('none 时出站 JSON 里不含该键（不会被不可枚举标记之外的东西带出去）', () => {
    const body = buildUpstreamBody({ model: PAID_MODEL, reasoning_effort: 'none' }, true, 's1', freeSet)
    expect(JSON.stringify(body)).not.toContain('reasoning_effort')
  })
})

// 输出预算的模型级硬上限（2026-10-05，移植 luawei1/cline2api `3f72255`）：
// Cline 官方接口不带 maxTokens 元数据，客户端默认的 128000 会原样透传，超过模型硬上限时
// 上游 400，而 400 属于「原样透传、不换模型」分支（proxyClineChatRequest 的「只服务点名模型」注释）——
// 用户直接吃硬失败，且日志里看不出是预算超限。上游 A/B：128000 必现 400，65536 全成功。
describe('max_tokens 模型级硬上限封顶（移植 3f72255）', () => {
  const freeSet = new Set([DEFAULT_MODEL])

  it('客户端 128000 + 命中硬上限表 → 封到表值，并记录封顶事实', () => {
    const body = buildUpstreamBody({ model: 'cline-free/gemini-3.8-flash', max_tokens: 128000 }, true, 's1', freeSet)
    expect(body.max_tokens).toBe(65536)
    expect(clineMaxTokensClamp(body)).toEqual({ from: 128000, to: 65536 })
  })

  it('路由前缀不影响匹配（基名比对）：cline-free/ google/ 两种写法都封顶', () => {
    for (const id of ['gemini-3.8-flash', 'cline-free/gemini-3.8-flash', 'google/gemini-3.8-flash', 'cline-pass/gemini-3.8-flash']) {
      expect(clineMaxOutputLimit(id)).toBe(65536)
    }
  })

  it('未收录模型一律不封顶（不误伤长输出模型）', () => {
    const body = buildUpstreamBody({ model: PAID_MODEL, max_tokens: 128000 }, true, 's1', freeSet)
    expect(body.max_tokens).toBe(128000)
    expect(clineMaxTokensClamp(body)).toBeNull()
    expect(clineMaxOutputLimit(PAID_MODEL)).toBeNull()
  })

  it('未超上限的值原样透传，不记封顶', () => {
    const body = buildUpstreamBody({ model: 'cline-free/gemini-3.8-flash', max_tokens: 32768 }, true, 's1', freeSet)
    expect(body.max_tokens).toBe(32768)
    expect(clineMaxTokensClamp(body)).toBeNull()
  })

  it('低于硬下限的兜底值也再受上限约束（32768 < 65536，不受影响）', () => {
    const body = buildUpstreamBody({ model: 'cline-free/gemini-3.8-flash', max_tokens: 8 }, true, 's1', freeSet)
    expect(body.max_tokens).toBe(CLINE_MAX_TOKENS)
    expect(clineMaxTokensClamp(body)).toBeNull()
  })

  it('封顶标记不可枚举，不会泄漏到上游请求体', () => {
    const body = buildUpstreamBody({ model: 'cline-free/gemini-3.8-flash', max_tokens: 128000 }, true, 's1', freeSet)
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('__maxTokensClamp')
  })

  it('端到端：响应带 X-Cline-Max-Tokens-Clamped 头', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: 'cline-free/gemini-3.8-flash', max_tokens: 128000, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.headers.get('X-Cline-Max-Tokens-Clamped')).toBe('128000->65536')
    await resp.text()
  })
})

describe('只服务点名模型：402/429/5xx/400 一律原样报错，不换模型', () => {
  // 用户决定（2026-10-02）：**不做任何模型级自动替换**。曾经的免费链降级（402/429 → 换免费
  // 模型，移植 169fd9d）与 transport 换候选（456d6ce）已退役；本 describe 是回归保护——
  // 任何一条自动换模型路径复活都会红（断言请求体里只出现点名的那个模型）。
  it('402 计费档模型 → 原样 402 upstream_plan_exhausted，请求体只出现点名模型', async () => {
    const { bodies } = installFetch(() =>
      jsonResp({ error: { code: 'insufficient_credits', message: 'Insufficient balance. Your Cline Credits balance is $0.01' } }, 402),
    )
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(402)
    const data = (await resp.json()) as { error: { type: string; message: string } }
    expect(data.error.type).toBe('upstream_plan_exhausted')
    expect(data.error.message).toContain('insufficient_credits')
    // 关键：不再落到免费档
    expect(bodies.map((b) => b.model)).toEqual([PAID_MODEL])
  })

  it('429 原样透传，不换模型', async () => {
    const { bodies } = installFetch(() => jsonResp({ error: 'rate limited upstream' }, 429))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(429)
    expect(new Set(bodies.map((b) => b.model))).toEqual(new Set([PAID_MODEL]))
    // 429 会按退避重试多次（3×500~1000ms），默认 5s 超时不够
  }, 20000)

  it('点名模型在所有账号上冷却中 → 502 upstream_unavailable，且不再打上游', async () => {
    const { bodies } = installFetch(() =>
      jsonResp({ error: { code: 'insufficient_credits', message: 'Insufficient balance' } }, 402),
    )
    const provider = clineProvider([REFRESH_TOKEN])
    // 一次 402 会把「账号 × 该模型」冷却 12h（CLINE_COOLDOWN_PLAN_MS）
    const first = await proxyClineChatRequest(
      undefined,
      provider,
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(first.status).toBe(402)
    const callsAfterFirst = bodies.length
    const second = await proxyClineChatRequest(
      undefined,
      provider,
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(second.status).toBe(502)
    const data = (await second.json()) as { error: { type: string; message: string } }
    expect(data.error.type).toBe('upstream_unavailable')
    expect(data.error.message).toContain(PAID_MODEL)
    // 冷却中直接报错，不再空转打上游（此前会换下一个模型继续打）
    expect(bodies.length).toBe(callsAfterFirst)
  })

  it('5xx 不触发模型降级，原样透传', async () => {
    const { bodies } = installFetch(() => jsonResp({ error: 'boom' }, 500))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(500)
    expect(bodies).toHaveLength(1)
  })

  it('400 不触发模型降级', async () => {
    const { bodies } = installFetch(() => jsonResp({ error: 'bad request' }, 400))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(400)
    expect(bodies).toHaveLength(1)
  })

  it('点名免费档成功时不降级，且请求体无 max_tokens', async () => {
    const { bodies } = installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(200)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe(DEFAULT_MODEL)
    expect(bodies[0].max_tokens).toBeUndefined()
  })
})

// Cline 流式拦截的归因日志（[cline-attempt]）：三轮全失败时客户端只拿到三合一 502 文案，
// 分辨不了退化 / 零帧 / 截断无 finish / 探测期读错误，线上排查只能靠猜。
// 归因同时落 console 与 KV 系统日志（管理面板「系统日志」可搜 `[cline-attempt]`）。
describe('Cline 流式拦截归因日志（[cline-attempt]）', () => {
  /** 抓 console.warn/log 输出，等待微任务队列排空（部分日志在异步回调里打）。 */
  async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
    const out: string[] = []
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')) })
    const spyLog = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')) })
    try {
      await fn()
      await new Promise((r) => setTimeout(r, 0)) // 让 clone().text().then 回调跑完
    } finally {
      spyWarn.mockRestore()
      spyLog.mockRestore()
    }
    return out
  }

  // 流式三轮拦截的归因（2026-10-02）：客户端此前只拿到三合一 502 文案，无法分辨
  // 退化 / 零帧 / 截断无 finish / 探测期读错误，线上排查只能靠猜。
  it('流式三轮全拦截 → 每轮打 [cline-attempt] 归因行，聚合 502 可定性', async () => {
    const logs = await captureLogs(async () => {
      // 上游 200 空流（零帧）→ 预期三条 detail=probe-eof-no-frames
      installFetch(() => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      const resp = await proxyClineChatRequest(
        undefined,
        clineProvider([REFRESH_TOKEN]),
        { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        { stream: true },
      )
      expect(resp.status).toBe(502)
      const data = (await resp.json()) as { error: { type: string } }
      expect(data.error.type).toBe('upstream_runaway')
    })
    const attempts = logs.filter((l) => l.includes('[cline-attempt]') && l.includes('attempt='))
    expect(attempts).toHaveLength(3)
    expect(attempts.map((l) => /attempt=(\d)\/3/.exec(l)?.[1])).toEqual(['1', '2', '3'])
    for (const l of attempts) {
      expect(l).toContain('kind=empty')
      expect(l).toContain('detail=probe-eof-no-frames')
      expect(l).toContain('frames=0')
      expect(l).toContain('sawFinish=false')
    }
    expect(attempts[0]).toContain(`model=${DEFAULT_MODEL}`)
    // 聚合结论行：一条日志说清三轮分别空在哪一种，不用翻三条
    const summary = logs.filter((l) => l.includes('[cline-attempt]') && l.includes('三轮全拦截'))
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain('probe-eof-no-frames')
  }, 20000)

  // 2026-10-02 追加：归因只进 console 时用户只能在 CF 仪表盘查，管理面板「系统日志」看不到。
  // 改为同时落 KV，用户自己发起一次请求就能在面板搜 [cline-attempt] 定性。
  it('拦截归因落 KV 系统日志（面板可搜），console 与 KV 双出口', async () => {
    const puts: Array<{ key: string; value: string }> = []
    const env = {
      KV: {
        get: async () => null, // log_enabled / log_retention_days 缺省 → 开启 + 默认保留天数
        put: async (key: string, value: string) => { puts.push({ key, value }) },
      },
    }
    await captureLogs(async () => {
      installFetch(() => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      const resp = await proxyClineChatRequest(
        env,
        clineProvider([REFRESH_TOKEN]),
        { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        { stream: true },
      )
      expect(resp.status).toBe(502)
      await resp.json()
    })
    const entries = puts.map((p) => JSON.parse(p.value) as { type: string; message: string; details?: string })
    expect(entries.every((e) => e.type === 'warn')).toBe(true)
    const attempts = entries.filter((e) => e.message.includes('[cline-attempt]') && e.message.includes('attempt='))
    expect(attempts).toHaveLength(3)
    expect(attempts.map((e) => /attempt=(\d)\/3/.exec(e.message)?.[1])).toEqual(['1', '2', '3'])
    for (const e of attempts) {
      expect(e.message).toContain('detail=probe-eof-no-frames')
      expect(e.message).toContain('frames=0')
      expect(e.details).toContain('"frames":0')
    }
    const summary = entries.find((e) => e.message.includes('三轮全拦截'))
    expect(summary).toBeTruthy()
    expect(summary!.message).toContain('probe-eof-no-frames')
    expect(summary!.details).toContain('probe-eof-no-frames')
  }, 20000)

  // 用户明确决定（2026-10-02）：**不做自动切换免费路由**——只服务点名的模型；它产不出流就
  // 按既有语义试满 3 轮，仍失败直接把 502 交给客户端，由客户端决定重试或换模型。
  // 这条测试是回归保护：别再把「三轮全拦截」接进链上 continue（网关不得偷偷换模型）。
  it('流式三轮全拦截 → 只报错，绝不把请求转给链上其它候选模型', async () => {
    __resetClineCatalogCacheForTests()
    const CANDIDATE_1 = 'cline-free/deepseek-v4.1-flash'
    const CANDIDATE_2 = 'cline-free/gemini-3.8-flash'
    const calls: string[] = []
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('recommended-models')) {
        return jsonResp({ recommended: [], free: [{ id: CANDIDATE_1 }, { id: CANDIDATE_2 }], clinePass: [] })
      }
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}')) as { model: string }
        calls.push(body.model)
        // 首选模型复刻线上形状：空壳帧 + [DONE]，全程无 finish_reason
        if (body.model === CANDIDATE_1) {
          return new Response(dataFrame({}) + doneFrame(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        }
        // 候选 2 是健康的，但按用户决定**不该被调用**
        return sseOkResp()
      }
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: CANDIDATE_1, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(502)
    const data = (await resp.json()) as { error: { type: string } }
    expect(data.error.type).toBe('upstream_runaway')
    // 点名模型试满 3 轮，且链上其它候选一个都没碰
    expect(calls).toEqual([CANDIDATE_1, CANDIDATE_1, CANDIDATE_1])
    expect(calls).not.toContain(CANDIDATE_2)
  }, 30000)
})

// opts.stream 语义回归（2026-09-27）：wantStream 曾写成 `opts ? !!opts.stream : body.stream`，
// 于是 opts 存在但不带 stream 字段时被当成「非流式」（6833ed7 加的诊断插桩正是这样传 opts），
// 流式客户端收到 application/json 聚合体 → pi-ai 按 SSE 解析到 0 个 chunk →
// "Stream ended without finish_reason"(TRANSPORT) 白重试 5 次。判据必须是 opts.stream 本身。
describe('opts.stream 语义（opts 不带 stream 时不得改变流式判定）', () => {
  it('body.stream=true + opts 存在但无 stream 字段 → 仍走 SSE，不被聚合成 JSON', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      {},
    )
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream')
    const text = await readAll(resp)
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('data: [DONE]')
  })

  it('opts.stream=false 显式覆盖 body.stream=true → 仍聚合为非流式 JSON', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      { stream: false },
    )
    expect(resp.headers.get('Content-Type')).toContain('application/json')
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> }
    expect(data.choices[0].message.content).toBe('hi')
  })

  it('不传 opts 时按 body.stream 判定（回归保护）', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    )
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream')
    await readAll(resp)
  })
})

// 上游 200 流「干净结束」但全程没发 finish_reason：此前直接 w.close()，客户端只看到半截流，
// DSH 归类 TRANSPORT 的 Stream ended without finish_reason 并白重试 5 次
// （2026-09-25 实测一轮 6 次全挂、约 77 秒）。现在补一帧具名错误。
describe('上游流未发 finish_reason 的截断兜底（2026-09-25）', () => {
  it('有正文但无 finish_reason → 补 upstream_no_finish，正文不丢', async () => {
    const outcome = await pumpStreamAttempt(sseResp(dataFrame({ content: 'hi' })))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('upstream_no_finish')
  })

  it('探测期就见到 finish_reason（缓冲帧直写、不过 routeToStream）→ 不补错误帧', async () => {
    const body = dataFrame({ reasoning_content: 'think' }) + dataFrame({}, 'stop')
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).not.toContain('upstream_no_finish')
  })

  it('放行之后才收到 finish_reason → 不补错误帧', async () => {
    const body = dataFrame({ content: 'hi' }) + dataFrame({}, 'stop') + doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).not.toContain('upstream_no_finish')
  })

  it('上游异常断开仍走 upstream_interrupted（不被新分支抢走）', async () => {
    const enc = new TextEncoder()
    let step = 0
    // 用 pull 而非 start 里 enqueue+error：controller.error 会清空已入队分片，
    // 那样探测期就拿不到正文帧、直接判 empty，测不到 flush 之后的 catch 分支。
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        if (step++ === 0) {
          c.enqueue(enc.encode(dataFrame({ content: 'hi' })))
          return
        }
        c.error(new Error('boom'))
      },
    })
    const outcome = await pumpStreamAttempt(new Response(broken, { status: 200 }))
    expect(outcome.kind).toBe('healthy')
    const text = await readAll(outcome.response!)
    expect(text).toContain('upstream_interrupted')
    expect(text).not.toContain('upstream_no_finish')
  })

  // 探测期就截断：此刻还没写给客户端任何字节，可以安全丢弃重试（真正的自愈那一半）。
  it('探测期只有 reasoning、无 finish_reason → 判 empty 交给上层重试，不交给客户端', async () => {
    const outcome = await pumpStreamAttempt(sseResp(dataFrame({ reasoning_content: 'think' })))
    expect(outcome.kind).toBe('empty')
    expect(outcome.response).toBeUndefined()
    // 归因字段（2026-10-02）：干净 EOF 且见过帧但无 finish_reason → 截断，不是零帧空流
    expect(outcome.detail).toBe('probe-eof-no-finish')
    expect(outcome.stats).toMatchObject({ frames: 1, content: 0, reasoning: 5, buffered: 1, sawFinish: false, probeReadError: false })
  })

  it('上游 200 但一个 data 帧都没有 → 判 empty，detail 与截断区分开（frames=0）', async () => {
    const outcome = await pumpStreamAttempt(new Response('', { status: 200 }))
    expect(outcome.kind).toBe('empty')
    expect(outcome.detail).toBe('probe-eof-no-frames')
    expect(outcome.stats).toMatchObject({ frames: 0, buffered: 0, sawFinish: false, probeReadError: false })
  })

  // 2026-10-02 线上实测形状：上游 200 → **1 个零正文帧** → 干净 EOF（无 finish_reason），
  // frames=1 / content=0 / reasoning=0 说不出那帧是什么。frameSkeleton 负责定性：
  // 错误帧（上游报错）/ role-only 帧（模型拒答）/ usage-only 帧（只结算）处置完全不同。
  it('零正文空壳帧 → frameSkeleton 摘出形状，错误帧连上游原文一起摘出（不落正文）', async () => {
    // 空 delta 帧 + [DONE]：与线上 frames=1 / buffered=2 / sawFinish=false 完全同形
    const outcome = await pumpStreamAttempt(sseResp(dataFrame({}) + doneFrame()))
    expect(outcome.kind).toBe('empty')
    expect(outcome.detail).toBe('probe-eof-no-finish')
    expect(outcome.stats).toMatchObject({ frames: 1, content: 0, reasoning: 0, buffered: 2, sawFinish: false })
    expect(outcome.stats?.frameSkeleton).toBe('keys=id,choices')

    // 上游把错误塞进 200 的 SSE 里：形状必须能看出来，否则只能当「空响应」白重试
    const errOutcome = await pumpStreamAttempt(
      sseResp('data: {"error":{"message":"free quota exhausted"}}\n\n' + doneFrame()),
    )
    expect(errOutcome.kind).toBe('empty')
    expect(errOutcome.detail).toBe('probe-eof-no-finish')
    expect(errOutcome.stats?.frameSkeleton).toContain('keys=error')
    expect(errOutcome.stats?.frameSkeleton).toContain('upstreamError=free quota exhausted')
  })

  it('截断 → proxyStreamChat 冷却换号重试，第 2 次完整流才交给客户端', async () => {
    installFetch((_b, i) =>
      i === 0
        ? new Response(dataFrame({ reasoning_content: 'partial-think' }), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        : sseOkResp(),
    )
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(200)
    const text = await readAll(resp)
    expect(text).toContain('"content":"hi"')
    expect(text).not.toContain('partial-think')
  })
})

// 传输层定责（2026-09-27）：建连/首字节阶段失败此前被原样包成
// `500 {"message":"The operation was aborted","type":"api_error"}`——无 code、无分类，
// DSH 把 "500" 归成 SERVER 并按其 500ms 起步的退避白重试 5 次，而单次尝试要烧 90s
// 建连超时（实测会话 f634b209：step/start → 91.0s → 183.5s → 292.0s → 385.1s）。
// 现在按 trae 口径回 503 upstream_unreachable，并把 cline 建连超时收到 30s。
describe('传输层故障定责（503 upstream_unreachable + 30s 建连超时）', () => {
  it('建连抛错（网络/DNS/TLS）→ 503 upstream_unreachable，不报 500 api_error', async () => {
    installFetch(() => { throw new Error('The operation was aborted') })
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(503)
    const data = (await resp.json()) as { error: { type: string; code: string; message: string } }
    expect(data.error.code).toBe('upstream_unreachable')
    expect(data.error.type).toBe('api_error')
    // 文案必须点明「非账号池问题」——否则排查方向又会被引到账号上
    expect(data.error.message).toContain('非账号池问题')
    expect(data.error.message).toContain('The operation was aborted')
  })

  it('非流式路径同样定责 503（不因 wantStream 分支漏掉）', async () => {
    installFetch(() => { throw new Error('The operation was aborted') })
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(503)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('upstream_unreachable')
  })

  it('账号池故障（refreshToken 刷新全失败）保持 500，不被误报成传输故障', async () => {
    // 账号存在但刷新 token 失败 → getAccessToken 抛「所有账号刷新 token 均失败」。
    // 这类是池/鉴权问题，与「网关↔上游连不上」不同因，必须保持原 500 api_error 出口。
    const fn = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('recommended-models')) return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ error: 'invalid_grant' }, 400)
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(500)
    const data = (await resp.json()) as { error: { type: string; code?: string; message: string } }
    expect(data.error.type).toBe('api_error')
    expect(data.error.code).toBeUndefined()
    expect(data.error.message).not.toContain('upstream_unreachable')
  })

  it('账号池为空 → 502 upstream_unavailable（池问题不伪装成网络故障）', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(502)
    const data = (await resp.json()) as { error: { type: string; code?: string } }
    expect(data.error.type).toBe('upstream_unavailable')
    expect(data.error.code).toBeUndefined()
  })

  it('建连超时常量为 60s（平衡思考模型首包排队与失败止损）', () => {
    expect(CLINE_CHAT_CONNECT_TIMEOUT_MS).toBe(60_000)
    expect(CLINE_MAX_TRANSPORT_ATTEMPTS).toBe(2)
  })

  it('建连超时真的传给上游 fetch（signal 会在到点 abort）', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('recommended-models')) return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
      if (url.includes('/chat/completions')) {
        seen.push(init?.signal ?? undefined)
        return sseOkResp()
      }
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(200)
    await readAll(resp)
    // streamFetchWithTimeout 用 AbortController 的 signal 传给 fetch；拿到响应头后已 clearTimeout，
    // 故此处只断言 signal 存在且未被 abort（60s 未到）。
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]!.aborted).toBe(false)
  })

  it('60s 到点真的 abort 且撞满 2 次跳出 → 503 upstream_unreachable', async () => {
    vi.useFakeTimers()
    try {
      let chatCalls = 0
      const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('recommended-models')) return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
        if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
        if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
        if (url.includes('/chat/completions')) {
          chatCalls++
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) return
            if (signal.aborted) return reject(new Error('The operation was aborted'))
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true })
          })
        }
        throw new Error('unexpected url: ' + url)
      })
      vi.stubGlobal('fetch', fn)
      const pending = proxyClineChatRequest(
        undefined,
        clineProvider([REFRESH_TOKEN]),
        { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        { stream: true },
      )
      // 推进到 59s：还没到点，请求仍挂起
      await vi.advanceTimersByTimeAsync(59_000)
      expect(chatCalls).toBe(1)
      // 越过第 1 次 60s 超时（+2s）+ sleep 500-1000ms（+2s）+ 第 2 次 60s 超时（+60s）
      await vi.advanceTimersByTimeAsync(65_000)
      const resp = await pending
      expect(resp.status).toBe(503)
      const data = (await resp.json()) as { error: { code: string } }
      expect(data.error.code).toBe('upstream_unreachable')
      expect(chatCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('单次 transport 错误（网络抖动）内部自动重试 1 次并成功自愈', async () => {
    let chatCalls = 0
    const fn = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('recommended-models')) return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
      if (url.includes('/chat/completions')) {
        chatCalls++
        if (chatCalls === 1) throw new Error('The operation was aborted')
        return sseOkResp()
      }
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(200)
    await readAll(resp)
    expect(chatCalls).toBe(2)
  })

  // 用户决定（2026-10-02）：transport 故障**不再**切下一个候选模型（456d6ce 的容灾已退役）。
  // 只服务点名的模型：撞满内部 transport 重试就报 503，由客户端决定重试或自己换模型。
  it('transport 故障撞满内部重试 → 503 upstream_unreachable，绝不换模型', async () => {
    __resetClineCatalogCacheForTests()
    const CANDIDATE_1 = 'cline-free/deepseek-v4.1-flash'
    const CANDIDATE_2 = 'cline-free/gemini-3.8-flash'
    const calls: string[] = []
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('recommended-models')) {
        return jsonResp({ recommended: [], free: [{ id: CANDIDATE_1 }, { id: CANDIDATE_2 }], clinePass: [] })
      }
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}')) as { model: string }
        calls.push(body.model)
        if (body.model === CANDIDATE_1) {
          throw new Error('The operation was aborted')
        }
        return sseOkResp()
      }
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: CANDIDATE_1, messages: [{ role: 'user', content: 'hi' }] },
      { stream: true },
    )
    expect(resp.status).toBe(503)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('upstream_unreachable')
    // 点名模型撞满 2 次 transport 后直接报错，候选 2 一次都没被调用
    expect(calls).toEqual([CANDIDATE_1, CANDIDATE_1])
    expect(calls).not.toContain(CANDIDATE_2)
  })
})

// 非流式聚合的「截断即失败」语义（2026-10-05，移植 luawei1/cline2api `a055b13`）：
// 此前 3 次尝试都判为空后落到 `chatCompletionFromAgg`，而它把缺失的 finish_reason
// 兜成 "stop" → 客户端收到 200 + `content:""` + `finish_reason:"stop"`，
// 一个「成功但什么都没说」的回复，既不可归因也不可重试。
// 现在对齐 opencode 侧 `aggregateOpenCodeStream` 的 sawDone 口径（src/opencode.ts:805）。
describe('非流式截断与流内错误帧（不谎报 finish_reason=stop）', () => {
  it('空流 + 无 [DONE]/finish_reason → 502 upstream_truncated（不是 200/stop）', async () => {
    installFetch(() => sseResp(''))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(502)
    const data = (await resp.json()) as { error: { type: string } }
    expect(data.error.type).toBe('upstream_truncated')
  })

  it('有部分正文但中途截断 → 同样 502，不把半截内容当成功交付', async () => {
    installFetch(() => sseResp(dataFrame({ content: 'half-an-' })))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(502)
    const data = (await resp.json()) as { error: { type: string } }
    expect(data.error.type).toBe('upstream_truncated')
  })

  it('截断只试一次就定责，不连烧 3 次账号、也不冷却账号', async () => {
    const { bodies } = installFetch(() => sseResp(dataFrame({ content: 'half' })))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(502)
    expect(bodies).toHaveLength(1)
  })

  it('200 里塞的 SSE 错误帧 → 502 upstream_stream_error，带上上游原文', async () => {
    installFetch(() =>
      sseResp('data: {"error":{"message":"Upstream idle timeout exceeded"}}\n\n'),
    )
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(502)
    const data = (await resp.json()) as { error: { type: string; message: string } }
    expect(data.error.type).toBe('upstream_stream_error')
    expect(data.error.message).toContain('Upstream idle timeout exceeded')
  })

  // 含 3 次重试 + 退避 sleep，超过默认 5s 上限
  it('只有 [DONE] 没有 finish_reason 帧 → 算正常收尾，仍走既有空回复重试语义', async () => {
    const { bodies } = installFetch(() => sseResp(doneFrame()))
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    // 3 次都是「正常收尾但空」→ 保持旧行为：重试到上限后回 200 空回复（reasoning 兜底位留空）
    expect(resp.status).toBe(200)
    expect(bodies.length).toBe(3)
    const data = (await resp.json()) as { choices: Array<{ finish_reason: string; message: { content: string } }> }
    expect(data.choices[0].finish_reason).toBe('stop')
    expect(data.choices[0].message.content).toBe('')
  }, 20000)

  it('正常流（正文 + finish_reason + [DONE]）不受影响', async () => {
    installFetch(() => sseOkResp())
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(200)
    const data = (await resp.json()) as { choices: Array<{ finish_reason: string; message: { content: string } }> }
    expect(data.choices[0].finish_reason).toBe('stop')
    expect(data.choices[0].message.content).toBe('hi')
  })
})

// 客户端主动断开不罚模型（2026-10-05，移植 luawei1/cline2api `4265b29`）：
// Esc 中断 / 客户端重连不是模型失败。断开时中止上游 fetch、放弃本轮（499 空响应），
// 且不记账号/模型冷却——否则单账号池下用户点名的模型被拉黑，后续请求被静默
// 赶到回退链上，表现为「配置了模型却总走 fallback」。
describe('客户端断开不罚模型（移植 4265b29）', () => {
  it('signal 已 abort → 立刻放弃，不打上游、不冷却', async () => {
    const { bodies } = installFetch(() => sseOkResp())
    const ctrl = new AbortController()
    ctrl.abort()
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      { stream: true, signal: ctrl.signal },
    )
    expect(resp.status).toBe(499)
    expect(bodies).toHaveLength(0)
  })

  it('流式途中断开：上游 fetch 被 abort，本轮不再重试第二次', async () => {
    let calls = 0
    const enc = new TextEncoder()
    const ctrl = new AbortController()
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('recommended-models')) return jsonResp({ recommended: [], free: [{ id: DEFAULT_MODEL }], clinePass: [] })
      if (url.endsWith('/v1/models')) return jsonResp({ data: [] })
      if (url.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'tok-1', expiresAt: Date.now() + 3_600_000 } })
      if (url.includes('/chat/completions')) {
        calls++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              // 吐一帧 reasoning 后静默——模拟「模型正在想，客户端此时按了 Esc」
              c.enqueue(enc.encode(dataFrame({ reasoning_content: 'thinking' })))
              const signal = init?.signal
              signal?.addEventListener('abort', () => {
                try { c.error(new Error('aborted')) } catch { /* already closed */ }
              }, { once: true })
              if (signal?.aborted) c.error(new Error('aborted'))
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fn)
    const pending = proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      { stream: true, signal: ctrl.signal },
    )
    // 探测期上游在静默，等过 CLINE_PROBE_MAX_MS 放行后客户端断开
    await new Promise((r) => setTimeout(r, CLINE_PROBE_MAX_MS + 200))
    ctrl.abort()
    const resp = await pending
    expect([499, 200]).toContain(resp.status)
    // 关键：断开后不因「空响应」重试第二轮
    expect(calls).toBe(1)
    if (resp.status === 200) await resp.body?.cancel()
  }, 20000)
})
