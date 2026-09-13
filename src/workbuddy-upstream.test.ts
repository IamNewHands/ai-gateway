import { describe, it, expect } from 'vitest'
import {
  classifyWorkbuddyUpstreamError,
  captureWorkbuddyReasoningEffort,
  applyWorkbuddyReasoningEffort,
  nextDay4AMMs,
  isModelRateLimit,
  parseSoftRateReset,
  isDeepSeekModel,
  injectDeepSeekThinking,
  backfillReasoningContent,
  injectWorkbuddyChatHeaders,
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

describe('isModelRateLimit & parseSoftRateReset 6004 限流解析（移植 workbuddy2api）', () => {
  it('识别 6004 模型级限流', () => {
    expect(isModelRateLimit('{"code": 6004, "msg": "error"}')).toBe(true)
    expect(isModelRateLimit('{"code":6004,"msg":"将在 2026-09-11 18:33:27 UTC+8 重置"}')).toBe(true)
    expect(isModelRateLimit('{"code":"6004"}')).toBe(true)
    expect(isModelRateLimit('{"code": 429}')).toBe(false)
  })

  it('从 6004 body 解析重置墙钟（UTC+8）', () => {
    const body = '{"code":6004,"msg":"将在 2026-09-11 18:33:27 UTC+8 重置"}'
    const resetMs = parseSoftRateReset(body)
    expect(resetMs).not.toBeNull()
    const expected = new Date('2026-09-11T18:33:27+08:00').getTime()
    expect(resetMs).toBe(expected)

    const bodyNoSuffix = '{"code":6004,"msg":"将在 2026-09-11 18:33:27 重置"}'
    expect(parseSoftRateReset(bodyNoSuffix)).toBe(expected)
  })

  it('非 6004 即使带重置字样也不返回重置时间', () => {
    const body = '{"code":11140,"msg":"将在 2026-09-11 18:33:27 UTC+8 重置"}'
    expect(parseSoftRateReset(body)).toBeNull()
  })

  it('classifyWorkbuddyUpstreamError 分类 6004 / bad_params / content_blocked', () => {
    expect(classifyWorkbuddyUpstreamError(429, '{"code":6004,"msg":"将在 2026-09-11 18:33:27 重置"}')).toBe('model_rate')
    expect(classifyWorkbuddyUpstreamError(400, 'Unmarshal chat params failed')).toBe('bad_params')
    expect(classifyWorkbuddyUpstreamError(400, '{"code":11101,"msg":"Unmarshal error"}')).toBe('bad_params')
    expect(classifyWorkbuddyUpstreamError(400, 'blocked by security policy')).toBe('content_blocked')
  })
})

describe('DeepSeek 思维链注入与历史消息回填（移植 workbuddy2api thinking.go）', () => {
  it('isDeepSeekModel 判定', () => {
    expect(isDeepSeekModel('deepseek-v4-flash')).toBe(true)
    expect(isDeepSeekModel('DeepSeek-R1')).toBe(true)
    expect(isDeepSeekModel('  deepseek-v3  ')).toBe(true)
    expect(isDeepSeekModel('claude-3-5-sonnet')).toBe(false)
    expect(isDeepSeekModel('qwen-max')).toBe(false)
  })

  it('injectDeepSeekThinking：非 DeepSeek 零改动', () => {
    const body: Record<string, unknown> = { model: 'gpt-4o', messages: [] }
    injectDeepSeekThinking(body)
    expect(body['thinking']).toBeUndefined()
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('injectDeepSeekThinking：无 thinking 自动注入 enabled + 默认 effort high', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash' }
    injectDeepSeekThinking(body)
    expect(body['thinking']).toEqual({ type: 'enabled' })
    expect(body['reasoning_effort']).toBe('high')
  })

  it('injectDeepSeekThinking：已有 effort 则保留不被覆盖', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash', reasoning_effort: 'medium' }
    injectDeepSeekThinking(body)
    expect(body['thinking']).toEqual({ type: 'enabled' })
    expect(body['reasoning_effort']).toBe('medium')
  })

  it('injectDeepSeekThinking：thinking.type 为 disabled 时删除 effort', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      reasoning_effort: 'high',
    }
    injectDeepSeekThinking(body)
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('backfillReasoningContent：会话无 reasoning 痕迹时不修改', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    }
    backfillReasoningContent(body)
    const msgs = body['messages'] as any[]
    expect(msgs[1].reasoning_content).toBeUndefined()
  })

  it('backfillReasoningContent：有 assistant 带 reasoning 痕迹时，所有 assistant 补齐 reasoning_content', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1', reasoning: 'think1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' }, // 缺少 reasoning
      ],
    }
    backfillReasoningContent(body)
    const msgs = body['messages'] as any[]
    expect(msgs[1].reasoning_content).toBe('think1')
    expect(msgs[3].reasoning_content).toBe('')
  })
})

describe('WorkBuddy 归属头与身份头注入 injectWorkbuddyChatHeaders', () => {
  it('注入四项归属头 + UID / EnterpriseID / Domain / DeviceToken', () => {
    const headers: Record<string, string> = {}
    const dummyToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1MTIzIiwiZW50ZXJwcmlzZV9pZCI6ImUxMjMiLCJkb21haW4iOiJleGFtcGxlLmNvbSIsIm5pY2tuYW1lIjoidGVzdHVzZXIifQ.sig'
    injectWorkbuddyChatHeaders(headers, dummyToken, 'cn', {
      device_token: 'dt-abc-123',
    })

    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('2.63.2')
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(headers['X-User-Id']).toBe('u123')
    expect(headers['X-Enterprise-Id']).toBe('e123')
    expect(headers['X-Domain']).toBe('example.com')
    expect(headers['X-Device-Token']).toBe('dt-abc-123')
    expect(headers['X-Refresh-Token']).toBeUndefined()
  })

  it('缺失信息时正确降级为 X-No-* 头并清除敏感 refresh token', () => {
    const headers: Record<string, string> = { 'X-Refresh-Token': 'leak-me' }
    injectWorkbuddyChatHeaders(headers, 'invalid-token', 'cn')

    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-No-User-Id']).toBe('1')
    expect(headers['X-No-Enterprise-Id']).toBe('1')
    expect(headers['X-No-Department-Info']).toBe('1')
    expect(headers['X-Refresh-Token']).toBeUndefined()
  })

  it('Global 域默认回落 X-Domain: workbuddy.ai', () => {
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, 'invalid-token', 'global')

    expect(headers['X-Domain']).toBe('workbuddy.ai')
    expect(headers['X-No-Department-Info']).toBeUndefined()
  })
})

