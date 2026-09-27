/**
 * 回归用例：TRAE 推理退化（思考死循环）防护。
 *
 * 现场（用户实测，DSH 思考面板）：`Go.` / `Writing.` / `OK.` / `Let me output the calls.`
 * 之类的短句反复刷屏，正文与工具调用迟迟不产出，只能靠用户手打「继续，不要过度思考」打断。
 * 判据复用 `workbuddy-sse.ts` 的**行重复**检测器（其测试夹具用的正是同形文本），
 * 因为 `src/cline/proxy.ts` 的空白占比判据对「短句重复」结构性漏判。
 *
 * 本文件守住的四件事：
 *  1. 退化必须被抑制（不再刷思考面板）且被定责（upstream_runaway + length，而不是 stop 假成功）；
 *  2. 熔断后立刻停读上游（不存在的尾巴绝不下发）——直接对应「白烧积分」；
 *  3. **正常思考不得被误杀**（长且多样的推理必须原样透传）；
 *  4. 已产出正文/工具调用时不得熔断（不能因为思考脏了就丢掉可用答案）。
 */
import { describe, it, expect } from 'vitest'
import { aggregateSoloSse, aggregateWorkSse, soloStreamToOpenAIStream, workStreamToOpenAIStream, type SoloStreamEndInfo } from './sse'
import type { TraeRunawayInfo } from './runaway'

/** 与线上现场同形的退化文本（workbuddy-sse.test.ts:454 的同款夹具）。 */
const LOOP = 'Writing.\n\nLet me output the calls.\n\nGo.\n\nNow.\n\nOK.\n\n'

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

/** 解析所有 `data:` JSON 帧（跳过 [DONE]）。 */
function framesOf(sse: string): any[] {
  const out: any[] = []
  for (const frame of sse.split('\n\n')) {
    const data = frame.replace(/^data:\s*/, '').trim()
    if (!data.startsWith('{')) continue
    try { out.push(JSON.parse(data)) } catch { /* ignore */ }
  }
  return out
}

/** 带 reasoning_content 的帧数（用于验证抑制生效）。 */
function reasoningFrameCount(sse: string): number {
  return framesOf(sse).filter((f) => typeof f?.choices?.[0]?.delta?.reasoning_content === 'string').length
}

function countOf(sse: string, needle: string): number {
  return sse.split(needle).length - 1
}

function soloOutput(ev: Record<string, unknown>): string {
  return `event: output\ndata: ${JSON.stringify(ev)}\n\n`
}

function workPlanItem(thought: string): string {
  return `event: plan_item\ndata: ${JSON.stringify({ payload: { reasoning_content: thought } })}\n\n`
}

describe('Trae SOLO 流式：推理退化必须被抑制并熔断', () => {
  it('短句重复空转 → 抑制推理 + upstream_runaway + length 收尾 + 停读上游', async () => {
    // 每块 2080 字符：第 1 块放行，第 2 块命中连续 3 窗退化 → 抑制，
    // 第 3 块累计 grace 2080（未达 4096），第 4 块累计 4160 → 提前熔断并取消读取。
    const chunks = [
      soloOutput({ reasoning_content: LOOP.repeat(40) }),
      soloOutput({ reasoning_content: LOOP.repeat(40) }),
      soloOutput({ reasoning_content: LOOP.repeat(40) }),
      soloOutput({ reasoning_content: LOOP.repeat(40) }),
      soloOutput({ reasoning_content: 'TAIL-MUST-NOT-APPEAR' }),
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ]
    const truncations: SoloStreamEndInfo[] = []
    const runaways: TraeRunawayInfo[] = []

    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(chunks),
      'deepseek-v4.1-flash',
      undefined,
      (info) => truncations.push(info),
      (info) => runaways.push(info),
    ))

    // 定责：可重试失败而不是 stop 假成功
    expect(errorFrameOf(sse)?.type).toBe('upstream_runaway')
    expect(runaways).toHaveLength(1)
    expect(runaways[0].kind).toBe('degenerate_loop')
    expect(runaways[0].contentChars).toBe(0)
    expect(runaways[0].reasoningChars).toBeGreaterThan(0)
    // 退化**不**走 onTruncated（那是「上游截断」的归因口径，两者不可混报）
    expect(truncations).toHaveLength(0)

    // 收尾形态：恰好一套（length + 单 [DONE]），且带网关标记
    expect(sse).toContain('"finish_reason":"length"')
    expect(sse).not.toContain('"finish_reason":"stop"')
    expect(countOf(sse, '[DONE]')).toBe(1)
    expect(framesOf(sse).some((f) => f.x_trae_runaway === 'degenerate_loop')).toBe(true)

    // 抑制生效：只有第 1 块推理被下发
    expect(reasoningFrameCount(sse)).toBe(1)
    // 熔断后停读上游：后续块的文本绝不下发
    expect(sse).not.toContain('TAIL-MUST-NOT-APPEAR')
  })

  it('反例：长且多样的正常推理原样透传，不误杀', async () => {
    const normal = Array.from({ length: 60 }, (_, i) => `第${i}步：检查 src/module${i}.ts 的分支与返回类型`).join('\n\n')
    const runaways: TraeRunawayInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf([
        soloOutput({ reasoning_content: normal }),
        soloOutput({ reasoning_content: '\n\n继续核对第 61 步的边界条件' }),
        soloOutput({ response: '正常答案' }),
        'event: done\ndata: {"finish_reason":"stop"}\n\n',
      ]),
      'deepseek-v4.1-flash',
      undefined,
      undefined,
      (info) => runaways.push(info),
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(runaways).toHaveLength(0)
    expect(reasoningFrameCount(sse)).toBe(2)
    expect(sse).toContain('正常答案')
    expect(sse).toContain('"finish_reason":"stop"')
  })

  it('已产出正文时不熔断：退化推理被抑制，答案照常送达', async () => {
    const runaways: TraeRunawayInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf([
        soloOutput({ reasoning_content: LOOP.repeat(40) }),
        soloOutput({ reasoning_content: LOOP.repeat(40) }),
        soloOutput({ reasoning_content: LOOP.repeat(40) }),
        soloOutput({ response: '可用答案' }),
        'event: done\ndata: {"finish_reason":"stop"}\n\n',
      ]),
      'deepseek-v4.1-flash',
      undefined,
      undefined,
      (info) => runaways.push(info),
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(runaways).toHaveLength(0)
    expect(sse).toContain('可用答案')
    expect(sse).toContain('"finish_reason":"stop"')
    // 抑制仍生效：退化推理不再刷屏
    expect(reasoningFrameCount(sse)).toBe(1)
  })

  it('推理预算耗尽（无重复但只思考不产出）→ budget_exhausted 熔断', async () => {
    // 1000 行各不相同（避开行重复判据），累计 7 万字符 > 65536 预算
    const varied = Array.from({ length: 1000 }, (_, i) => `思考${i}：${'x'.repeat(60)}`).join('\n')
    const chunks = [
      soloOutput({ reasoning_content: varied.slice(0, 10000) }),
      soloOutput({ reasoning_content: varied.slice(10000, 20000) }),
      soloOutput({ reasoning_content: varied.slice(20000, 30000) }),
      soloOutput({ reasoning_content: varied.slice(30000, 40000) }),
      soloOutput({ reasoning_content: varied.slice(40000, 50000) }),
      soloOutput({ reasoning_content: varied.slice(50000, 60000) }),
      soloOutput({ reasoning_content: varied.slice(60000, 70000) }),
      soloOutput({ reasoning_content: 'x'.repeat(10000) }),
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ]
    const runaways: TraeRunawayInfo[] = []
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf(chunks),
      'deepseek-v4.1-flash',
      undefined,
      undefined,
      (info) => runaways.push(info),
    ))

    expect(errorFrameOf(sse)?.type).toBe('upstream_runaway')
    expect(runaways).toHaveLength(1)
    expect(runaways[0].kind).toBe('budget_exhausted')
    expect(runaways[0].reasoningChars).toBeGreaterThanOrEqual(65536)
    expect(sse).toContain('"finish_reason":"length"')
    expect(countOf(sse, '[DONE]')).toBe(1)
  })

  it('反例：正常带 done 的普通回答不注入任何错误帧', async () => {
    const sse = await drain(soloStreamToOpenAIStream(
      upstreamOf([
        soloOutput({ reasoning_content: '先读文件，再改代码。' }),
        soloOutput({ response: '完成' }),
        'event: done\ndata: {"finish_reason":"stop"}\n\n',
      ]),
      'deepseek-v4.1-flash',
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(sse).toContain('"finish_reason":"stop"')
    expect(reasoningFrameCount(sse)).toBe(1)
  })
})

describe('Trae Work 流式：plan_item 思考文本退化同样熔断', () => {
  it('重复的 plan_item 思考（UI 去重后只显示一次）仍须被判定并熔断', async () => {
    const chunks = [
      workPlanItem(LOOP.repeat(40)),
      workPlanItem(LOOP.repeat(40)),
      workPlanItem(LOOP.repeat(40)),
      workPlanItem(LOOP.repeat(40)),
      workPlanItem('TAIL-MUST-NOT-APPEAR'),
      'data: [DONE]\n\n',
    ]
    const runaways: TraeRunawayInfo[] = []
    const sse = await drain(workStreamToOpenAIStream(
      upstreamOf(chunks),
      'DeepSeek-V4-Flash-Official',
      undefined,
      (info) => runaways.push(info),
    ))

    expect(errorFrameOf(sse)?.type).toBe('upstream_runaway')
    expect(runaways).toHaveLength(1)
    expect(runaways[0].kind).toBe('degenerate_loop')
    expect(sse).toContain('"finish_reason":"length"')
    expect(countOf(sse, '[DONE]')).toBe(1)
    expect(framesOf(sse).some((f) => f.x_trae_runaway === 'degenerate_loop')).toBe(true)
    expect(sse).not.toContain('TAIL-MUST-NOT-APPEAR')
  })

  it('反例：正常 plan_item 思考 + done 正文，不熔断', async () => {
    const runaways: TraeRunawayInfo[] = []
    const sse = await drain(workStreamToOpenAIStream(
      upstreamOf([
        workPlanItem('先定位入口，再核对配置项。'),
        `event: done\ndata: ${JSON.stringify({ payload: { last_assistant_response: JSON.stringify(['完成']) } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
      'DeepSeek-V4-Flash-Official',
      undefined,
      (info) => runaways.push(info),
    ))

    expect(errorFrameOf(sse)).toBeNull()
    expect(runaways).toHaveLength(0)
    expect(sse).toContain('"finish_reason":"stop"')
    expect(sse).toContain('完成')
  })
})

describe('Trae 非流式聚合：退化推理不得当成功返回', () => {
  it('SOLO 聚合：只有退化推理、无正文 → truncated=degenerate_reasoning', () => {
    const text = [1, 2, 3, 4, 5].map(() => soloOutput({ reasoning_content: LOOP.repeat(40) })).join('')
      + 'event: done\ndata: {"finish_reason":"stop"}\n\n'
    const agg = aggregateSoloSse(text)

    expect(agg.resp).toBeNull()
    expect(agg.err).toBeNull()
    expect(agg.truncated?.kind).toBe('degenerate_reasoning')
    expect(agg.truncated?.sawToolCalls).toBe(false)
  })

  it('SOLO 聚合：退化推理 + 有效正文 → 保留正文、剔除退化推理', () => {
    const text = [1, 2, 3, 4, 5].map(() => soloOutput({ reasoning_content: LOOP.repeat(40) })).join('')
      + soloOutput({ response: '正文答案' })
      + 'event: done\ndata: {"finish_reason":"stop"}\n\n'
    const agg = aggregateSoloSse(text)

    expect(agg.truncated).toBeNull()
    expect(agg.resp?.choices?.[0]?.message?.content).toBe('正文答案')
    expect(agg.resp?.choices?.[0]?.message?.reasoning_content).toBeUndefined()
    expect(agg.resp?.choices?.[0]?.finish_reason).toBe('stop')
  })

  it('SOLO 聚合反例：正常推理原样保留', () => {
    const normal = Array.from({ length: 30 }, (_, i) => `第${i}步：核对分支与返回类型`).join('\n\n')
    const agg = aggregateSoloSse(soloOutput({ reasoning_content: normal }) + soloOutput({ response: '答案' }) + 'event: done\ndata: {"finish_reason":"stop"}\n\n')

    expect(agg.truncated).toBeNull()
    expect(agg.resp?.choices?.[0]?.message?.reasoning_content).toBe(normal)
  })

  it('Work 聚合：只有退化推理、无正文 → truncated=degenerate_reasoning', () => {
    const text = [1, 2, 3, 4, 5].map(() => workPlanItem(LOOP.repeat(40))).join('') + 'data: [DONE]\n\n'
    const agg = aggregateWorkSse(text, 'DeepSeek-V4-Flash-Official')

    expect(agg.resp).toBeNull()
    expect(agg.err).toBeNull()
    expect(agg.truncated?.kind).toBe('degenerate_reasoning')
  })

  it('Work 聚合：退化推理 + 有效正文 → 保留正文、剔除退化推理', () => {
    const text = [1, 2, 3, 4, 5].map(() => workPlanItem(LOOP.repeat(40))).join('')
      + 'event: output\ndata: {"payload":{"response":"正文答案"}}\n\n'
      + 'event: done\ndata: {"payload":{}}\n\n'
    const agg = aggregateWorkSse(text, 'DeepSeek-V4-Flash-Official')

    expect(agg.truncated).toBeNull()
    expect(agg.resp?.choices?.[0]?.message?.content).toBe('正文答案')
    expect(agg.resp?.choices?.[0]?.message?.reasoning_content).toBeUndefined()
  })
})
