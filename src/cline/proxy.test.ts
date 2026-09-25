import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCooldownMs, fetchClineModels, isRunawayReasoningCutoff, isDegenerateReasoningDeltas, isWhitespaceOnlyReasoningDelta, normalizeReasoningDeltaForUI, pumpStreamAttempt, sanitizeClineMessages, isFreeClineModel, clineModelFallbackChain, buildUpstreamBody, proxyClineChatRequest, __resetClineCatalogCacheForTests, CLINE_MAX_TOKENS, CLINE_FREE_WHITELIST, DEFAULT_MODEL } from './proxy'
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

describe('clineModelFallbackChain（移植 169fd9d）', () => {
  it('点名模型优先，其后是默认免费档与目录免费模型，付费档不进链，且去重', () => {
    const chain = clineModelFallbackChain(PAID_MODEL, [
      { id: DEFAULT_MODEL, cost: 'free' },
      { id: 'stealth/space-bunny-alpha', cost: 'free' },
      { id: 'cline-pass/glm-5.3', cost: 'pass' },
    ])
    expect(chain[0]).toBe(PAID_MODEL)
    expect(chain).toContain(DEFAULT_MODEL)
    expect(chain).toContain('stealth/space-bunny-alpha')
    expect(chain).not.toContain('cline-pass/glm-5.3')
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('点名模型本身是免费档时不产生重复项', () => {
    const chain = clineModelFallbackChain(DEFAULT_MODEL, [{ id: DEFAULT_MODEL, cost: 'free' }])
    expect(chain.filter((m) => m === DEFAULT_MODEL)).toHaveLength(1)
  })
})

describe('402 余额耗尽与免费链降级', () => {
  it('402 计费档模型 → 沿免费链换模型并返回成功（移植 169fd9d）', async () => {
    const { bodies } = installFetch((body) =>
      body.model === PAID_MODEL
        ? jsonResp({ error: { code: 'insufficient_credits', message: 'Insufficient balance. Your Cline Credits balance is $0.01' } }, 402)
        : sseOkResp(),
    )
    const resp = await proxyClineChatRequest(
      undefined,
      clineProvider([REFRESH_TOKEN]),
      { model: PAID_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { stream: false },
    )
    expect(resp.status).toBe(200)
    // 第一次打计费档，第二次换成免费档
    expect(bodies.map((b) => b.model)).toEqual([PAID_MODEL, DEFAULT_MODEL])
    // 计费档带 max_tokens，免费档被剥离
    expect(bodies[0].max_tokens).toBe(CLINE_MAX_TOKENS)
    expect(bodies[1].max_tokens).toBeUndefined()
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> }
    expect(data.choices[0].message.content).toBe('hi')
  })

  it('整条链都 402 → 明确 402 upstream_plan_exhausted（不再静默透传上游原文）', async () => {
    installFetch(() => jsonResp({ error: { code: 'insufficient_credits', message: 'Insufficient balance' } }, 402))
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
  })

  it('5xx 不触发模型降级，原样透传（169fd9d 语义）', async () => {
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
