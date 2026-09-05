import { describe, it, expect } from 'vitest'
import { parseCooldownMs, fetchClineModels, isRunawayReasoningCutoff, isDegenerateReasoningDeltas, pumpStreamAttempt } from './proxy'

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

describe('推理退化检测 isDegenerateReasoningDeltas（2026-09-05 流式防护）', () => {
  // 样本取自 dsh-session-8711a1e7 日志的真实轮次
  it('病态：纯空白/换行洪泛（T5/S34：71 条 delta 95% 是空白）→ 判定退化', () => {
    const deltas = Array.from({ length: 71 }, (_, i) => (i % 3 === 0 ? '\n' : '  \n '))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('病态：一个字一个空格的碎片流（T5/S19 形态）→ 判定退化', () => {
    const deltas = Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? ' \n' : ' ('))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('病态：短碎片 + 高换行密度（T12/S34 形态）→ 判定退化', () => {
    const deltas = Array.from({ length: 21 }, (_, i) => (i % 5 === 0 ? 'close' : ' \n\n '))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('病态："全是空格的长文"形态（大量字符但可见字符占比极低）→ 判定退化', () => {
    const deltas = Array.from({ length: 30 }, () => 'a    '.repeat(10)) // 每条 50 字符仅 10 可见
    expect(isDegenerateReasoningDeltas(deltas)).toBe(true)
  })
  it('正常：连贯英文思考 token 流（127 条、7k 字符，T6/S23 形态）→ 不误伤', () => {
    const words = ['Now', ' I', ' see', ' the', ' issue', '.', ' The', ' `buildToolLedger`', ' uses', ' `toolCallFingerprint`', ' which', ' compiles', ' the', ' fingerprint', ' from', ' tool', ' calls', '.\n']
    const deltas = Array.from({ length: 127 }, (_, i) => words[i % words.length])
    expect(isDegenerateReasoningDeltas(deltas)).toBe(false)
  })
  it('正常：含代码块/列表的中文长思考（换行但连贯）→ 不误伤', () => {
    const deltas = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? '\n' : '先读取 `tool-ledger.ts` 的实现，再对比两边的差异。'))
    expect(isDegenerateReasoningDeltas(deltas)).toBe(false)
  })
  it('样本不足 16 条 → 不判定（正常短思考也可能都是小 token）', () => {
    expect(isDegenerateReasoningDeltas(['\n', ' ', ' \n'])).toBe(false)
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

  it('退化空转（空白洪泛超窗口）→ 拦截，返回 degenerate 不上游放行给客户端', async () => {
    let body = ''
    for (let i = 0; i < 60; i++) body += dataFrame({ reasoning_content: i % 3 === 0 ? '\n' : ' \n ' })
    body += dataFrame({}, 'length')
    body += doneFrame()
    const outcome = await pumpStreamAttempt(sseResp(body))
    expect(outcome.kind).toBe('degenerate')
  })

  it('退化空转（窗口内即结束的纯空白）→ 拦截为 degenerate', async () => {
    let body = ''
    for (let i = 0; i < 20; i++) body += dataFrame({ reasoning_content: ' \n\n' })
    body += dataFrame({}, 'stop')
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
