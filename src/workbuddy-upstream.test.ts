import { describe, it, expect } from 'vitest'
import {
  classifyWorkbuddyUpstreamError,
  captureWorkbuddyReasoningEffort,
  applyWorkbuddyReasoningEffort,
  nextDay4AMMs,
} from './workbuddy-upstream'

describe('classifyWorkbuddyUpstreamError 错误分类（移植 workbuddy2api Classify）', () => {
  it('402 → hard_credit', () => {
    expect(classifyWorkbuddyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('余额关键词（中英文 / 大小写不敏感）→ hard_credit，且优先于状态码', () => {
    expect(classifyWorkbuddyUpstreamError(500, 'oops: Insufficient Credit')).toBe('hard_credit')
    expect(classifyWorkbuddyUpstreamError(400, '积分不足')).toBe('hard_credit')
    expect(classifyWorkbuddyUpstreamError(400, '额度用尽')).toBe('hard_credit')
    expect(classifyWorkbuddyUpstreamError(400, '余额不足')).toBe('hard_credit')
    expect(classifyWorkbuddyUpstreamError(503, 'quota exceeded for user')).toBe('hard_credit')
  })

  it('本仓既有检测保留：1005 / plan 关键词 → hard_credit（行为兼容）', () => {
    expect(classifyWorkbuddyUpstreamError(400, 'code=1005 plan exhausted')).toBe('hard_credit')
    expect(classifyWorkbuddyUpstreamError(400, 'your plan has ended')).toBe('hard_credit')
  })

  it('session 死亡关键词 → session_dead', () => {
    expect(classifyWorkbuddyUpstreamError(403, 'Offline user session not found')).toBe('session_dead')
    expect(classifyWorkbuddyUpstreamError(500, 'biz 12153')).toBe('session_dead')
  })

  it('429 → soft_rate；404 → not_found；其他 5xx → server', () => {
    expect(classifyWorkbuddyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyWorkbuddyUpstreamError(404, '')).toBe('not_found')
    expect(classifyWorkbuddyUpstreamError(500, 'internal error')).toBe('server')
    expect(classifyWorkbuddyUpstreamError(502, 'bad gateway body')).toBe('server')
    expect(classifyWorkbuddyUpstreamError(504, 'timeout')).toBe('server')
  })

  it('其他 4xx → client（不处罚账号，仅换号）', () => {
    expect(classifyWorkbuddyUpstreamError(400, 'bad request')).toBe('client')
    expect(classifyWorkbuddyUpstreamError(413, 'too large')).toBe('client')
    expect(classifyWorkbuddyUpstreamError(422, 'unprocessable')).toBe('client')
  })

  it('<400 兜底 → client', () => {
    expect(classifyWorkbuddyUpstreamError(200, 'weird')).toBe('client')
  })
})

describe('reasoning_effort 捕获与降级（移植 workbuddy2api normalizeReasoningEffort）', () => {
  it('捕获 snake/camel 字段（仅非空字符串）', () => {
    expect(captureWorkbuddyReasoningEffort({ reasoning_effort: 'high' })).toEqual({
      key: 'reasoning_effort',
      value: 'high',
    })
    expect(captureWorkbuddyReasoningEffort({ reasoningEffort: 'low' })).toEqual({
      key: 'reasoningEffort',
      value: 'low',
    })
    expect(captureWorkbuddyReasoningEffort({})).toBeNull()
    expect(captureWorkbuddyReasoningEffort({ reasoning_effort: '' })).toBeNull()
    expect(captureWorkbuddyReasoningEffort({ reasoning_effort: 3 })).toBeNull()
    expect(captureWorkbuddyReasoningEffort({ reasoning_effort: { effort: 'high' } })).toBeNull()
  })

  it('请求档位被支持 → 按原字段名原样恢复（透传）', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'low' }, ['low', 'high'])
    expect(body['reasoning_effort']).toBe('low')
  })

  it('请求档位不支持 → 降级为 ≤请求档位的最高支持档', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'high' }, ['low', 'medium'])
    expect(body['reasoning_effort']).toBe('medium')
  })

  it('max 请求 → 取 ≤max 的最高支持档', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'max' }, ['low', 'high'])
    expect(body['reasoning_effort']).toBe('high')
  })

  it('支持档全部高于请求档 → 取最低支持档（floored，偏离最小）', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'low' }, ['high'])
    expect(body['reasoning_effort']).toBe('high')
  })

  it('能力未声明（undefined / 空数组）→ 不恢复（保持 sanitize 删除后的既有行为）', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'high' }, undefined)
    expect(body['reasoning_effort']).toBeUndefined()
    const body2: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body2, { key: 'reasoning_effort', value: 'high' }, [])
    expect(body2['reasoning_effort']).toBeUndefined()
  })

  it('未知档位（rank 表外，如 ultra）→ 不恢复', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'ultra' }, ['low', 'high'])
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('camel 字段名按原字段恢复，且不污染 snake 字段', () => {
    const body: Record<string, unknown> = {}
    applyWorkbuddyReasoningEffort(body, { key: 'reasoningEffort', value: 'max' }, ['low', 'high'])
    expect(body['reasoningEffort']).toBe('high')
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('captured 为 null 时 no-op', () => {
    const body: Record<string, unknown> = { model: 'glm-5.2' }
    applyWorkbuddyReasoningEffort(body, null, ['low'])
    expect(Object.keys(body)).toEqual(['model'])
  })

  it('支持列表内无效档位被忽略（大小写归一 + 容错）', () => {
    const body: Record<string, unknown> = {}
    // ['HIGH'] 应参与档位比较（归一化后 rank=4 > high 请求 → floored 到最低有效档）
    applyWorkbuddyReasoningEffort(body, { key: 'reasoning_effort', value: 'medium' }, ['HIGH', 'bogus'])
    expect(body['reasoning_effort']).toBe('HIGH')
  })
})

describe('nextDay4AMMs 次日 04:00（对齐 workbuddy2api CooldownUntilTomorrow4AM）', () => {
  it('当天 23:30 → 次日 04:00', () => {
    const from = new Date(2026, 0, 15, 23, 30).getTime()
    expect(nextDay4AMMs(from)).toBe(new Date(2026, 0, 16, 4, 0, 0, 0).getTime())
  })

  it('当天 03:00 → 次日 04:00（固定次日 4 点，而非当天 4 点）', () => {
    const from = new Date(2026, 0, 15, 3, 0).getTime()
    expect(nextDay4AMMs(from)).toBe(new Date(2026, 0, 16, 4, 0, 0, 0).getTime())
  })

  it('当天 05:00 → 次日 04:00', () => {
    const from = new Date(2026, 0, 15, 5, 0).getTime()
    expect(nextDay4AMMs(from)).toBe(new Date(2026, 0, 16, 4, 0, 0, 0).getTime())
  })

  it('月末跨月：1 月 31 日 → 2 月 1 日 04:00', () => {
    const from = new Date(2026, 0, 31, 5, 0).getTime()
    expect(nextDay4AMMs(from)).toBe(new Date(2026, 1, 1, 4, 0, 0, 0).getTime())
  })

  it('跨年：12 月 31 日 → 次年 1 月 1 日 04:00', () => {
    const from = new Date(2026, 11, 31, 23, 0).getTime()
    expect(nextDay4AMMs(from)).toBe(new Date(2027, 0, 1, 4, 0, 0, 0).getTime())
  })

  it('默认参数（当前时间）结果在未来', () => {
    expect(nextDay4AMMs()).toBeGreaterThan(Date.now())
  })
})
