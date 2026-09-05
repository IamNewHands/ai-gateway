import { describe, it, expect } from 'vitest'
import { parseCooldownMs, fetchClineModels, isRunawayReasoningCutoff, isDegenerateReasoningDeltas } from './proxy'

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
