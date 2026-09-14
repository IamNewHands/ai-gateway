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
  ensureWorkbuddyStreamOptions,
  ensureWorkbuddyMaxTokens,
  WORKBUDDY_DEFAULT_MAX_TOKENS,
  CST_OFFSET_MS,
  isAccountBanned,
  WORKBUDDY_CLIENT_VERSION,
  WORKBUDDY_CLI_VERSION,
  buildWorkbuddyUserAgent,
  workbuddyAcceptLanguage,
  workbuddyChatAccept,
  ensureGlobalFallbackSystem,
  GLOBAL_FALLBACK_SYSTEM,
  sanitizeFingerprintText,
  sanitizeWorkbuddyMessages,
  contentBlockedClientMessage,
  contentBlockedKeyword,
  CONTENT_BLOCKED_FALLBACK_KEYWORD,
  ContentBlockedError,
  WorkbuddyClientError,
  formatWorkbuddyClientErrorMessage,
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

describe('account_fault 账号级故障分类（移植 workbuddy2api accountFaultMarkers）', () => {
  // 报文取自源实现实测证据 handler_test.go:427 / handler_test.go:483
  const BODY_11140 = '{"error":{"data":{"code":11140,"msg":"request illegal"}}}'
  const BODY_14017 = '{"error":{"data":{"code":14017,"msg":"The trial version is not yet activated. Please log out of your current account and log in again to activate it immediately and start your free trial."}}}'

  it('11140 request illegal（HTTP 403）→ account_fault', () => {
    expect(classifyWorkbuddyUpstreamError(403, BODY_11140)).toBe('account_fault')
  })

  it('14017 trial not activated（HTTP 429）→ account_fault，而非 soft_rate', () => {
    // 这是本分类存在的核心理由：14017 带 429 状态码，若落到 status===429 兜底会被误归
    // soft_rate（"限流可指数退避等自愈"，与账号级故障语义相反）。
    expect(classifyWorkbuddyUpstreamError(429, BODY_14017)).toBe('account_fault')
  })

  it('14017 短文案 "trial not activated" → account_fault', () => {
    expect(classifyWorkbuddyUpstreamError(429, 'trial not activated')).toBe('account_fault')
    expect(classifyWorkbuddyUpstreamError(403, 'Trial Not Activated')).toBe('account_fault')
  })

  it('大小写不敏感：REQUEST ILLEGAL / Request Illegal 均命中', () => {
    expect(classifyWorkbuddyUpstreamError(403, 'REQUEST ILLEGAL')).toBe('account_fault')
    expect(classifyWorkbuddyUpstreamError(403, 'Request Illegal')).toBe('account_fault')
  })

  it('11140 的"模型级限流"变体保持 soft_rate（不能按 code 11140 判定）', () => {
    // 上游同一 code 11140 也承载模型级限流文案；该文案不含 request illegal，
    // 必须继续落到限流分类（切模型即可用），不得误判为账号封禁。
    const rateLimitBody = '{"error":{"data":{"code":11140,"msg":"The model provider is rate-limiting requests."}}}'
    expect(classifyWorkbuddyUpstreamError(429, rateLimitBody)).toBe('soft_rate')
  })

  it('account_fault 优先于 model_rate（6004）与 404/5xx', () => {
    // 账号级故障先判：即便报文同时含 6004，也应按账号故障处理
    expect(classifyWorkbuddyUpstreamError(429, `{"code":6004,"msg":"request illegal"}`)).toBe('account_fault')
    expect(classifyWorkbuddyUpstreamError(404, BODY_11140)).toBe('account_fault')
    expect(classifyWorkbuddyUpstreamError(500, BODY_14017)).toBe('account_fault')
  })

  it('hard_credit 与 session_dead 仍优先于 account_fault（顺序不变）', () => {
    // 余额关键词最严，必须最先判
    expect(classifyWorkbuddyUpstreamError(403, '余额不足 request illegal')).toBe('hard_credit')
    // session 死亡是需人工重登的终态，marker 更具体
    expect(classifyWorkbuddyUpstreamError(403, '12153 request illegal')).toBe('session_dead')
  })

  it('普通 4xx 不带账号故障文案时不受影响 → client', () => {
    expect(classifyWorkbuddyUpstreamError(400, 'bad request')).toBe('client')
    expect(classifyWorkbuddyUpstreamError(403, 'forbidden')).toBe('client')
  })

  it('isAccountBanned 区分 11140（硬禁用）与 14017（软冷却）', () => {
    expect(isAccountBanned(BODY_11140)).toBe(true)
    expect(isAccountBanned(BODY_14017)).toBe(false)
    expect(isAccountBanned('REQUEST ILLEGAL')).toBe(true)
    expect(isAccountBanned('')).toBe(false)
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

describe('nextDay4AMMs 下一个 CST 04:00（对齐 workbuddy2api pool.nextDay4AM）', () => {
  // 用带显式偏移的 ISO 串构造"某一时刻"，断言也用 ISO 串 —— 与运行环境时区无关。
  // 这样在 Workers（UTC）与本地开发机（任意时区）跑出的结果一致。
  const at = (iso: string) => new Date(iso).getTime()
  const expect4am = (iso: string) => at(iso)

  it('普通日：CST 17:00 → 次日 CST 04:00', () => {
    expect(nextDay4AMMs(at('2026-08-28T17:00:00+08:00'))).toBe(expect4am('2026-08-29T04:00:00+08:00'))
  })

  // 以下三条是源实现明确修过的 bug（workbuddy2api pool_test.go:586-590）：
  // 凌晨触发硬冷却时，当天 04:00 尚未到 → 应落在**当天**，而非次日（否则白冷约一天）。
  it('凌晨 02:30 → 当天 CST 04:00（不是次日，源实现修复点）', () => {
    expect(nextDay4AMMs(at('2026-08-28T02:30:00+08:00'))).toBe(expect4am('2026-08-28T04:00:00+08:00'))
  })

  it('凌晨 00:00 → 当天 CST 04:00', () => {
    expect(nextDay4AMMs(at('2026-08-28T00:00:00+08:00'))).toBe(expect4am('2026-08-28T04:00:00+08:00'))
  })

  it('凌晨 03:59:59 → 当天 CST 04:00（边界前一秒）', () => {
    expect(nextDay4AMMs(at('2026-08-28T03:59:59+08:00'))).toBe(expect4am('2026-08-28T04:00:00+08:00'))
  })

  it('正好 CST 04:00 → 次日 CST 04:00（边界：已到即算过了）', () => {
    expect(nextDay4AMMs(at('2026-08-28T04:00:00+08:00'))).toBe(expect4am('2026-08-29T04:00:00+08:00'))
  })

  it('CST 04:00:01 → 次日 CST 04:00', () => {
    expect(nextDay4AMMs(at('2026-08-28T04:00:01+08:00'))).toBe(expect4am('2026-08-29T04:00:00+08:00'))
  })

  it('CST 23:30 → 次日 CST 04:00', () => {
    expect(nextDay4AMMs(at('2026-08-28T23:30:00+08:00'))).toBe(expect4am('2026-08-29T04:00:00+08:00'))
  })

  // UTC 视角的同一时刻必须得到同一结果（证明实现不依赖运行环境时区）
  it('时区无关性：UTC 表示的同一时刻得到相同结果', () => {
    // CST 2026-08-28 02:30 == UTC 2026-08-27 18:30
    expect(nextDay4AMMs(at('2026-08-27T18:30:00Z'))).toBe(expect4am('2026-08-28T04:00:00+08:00'))
    // CST 2026-08-28 17:00 == UTC 2026-08-28 09:00
    expect(nextDay4AMMs(at('2026-08-28T09:00:00Z'))).toBe(expect4am('2026-08-29T04:00:00+08:00'))
  })

  // 关键回归防护：Workers 运行时本地时区是 UTC。若实现退化为本地时区构造，
  // 这两个断言会失败（会把结果算成 UTC 04:00 = CST 12:00）。
  it('回归防护：结果的小时数（CST 视角）恒为 4，而非 UTC 4 点', () => {
    for (const iso of [
      '2026-08-28T02:30:00+08:00',
      '2026-08-28T17:00:00+08:00',
      '2026-08-28T23:59:59+08:00',
    ]) {
      const got = nextDay4AMMs(at(iso))
      const cstHour = new Date(got + CST_OFFSET_MS).getUTCHours()
      expect(cstHour).toBe(4)
    }
  })

  it('月末跨月：CST 1 月 31 日 → 2 月 1 日 04:00', () => {
    expect(nextDay4AMMs(at('2026-01-31T12:00:00+08:00'))).toBe(expect4am('2026-02-01T04:00:00+08:00'))
  })

  it('28 天月：CST 2 月 28 日 → 3 月 1 日 04:00', () => {
    expect(nextDay4AMMs(at('2026-02-28T12:00:00+08:00'))).toBe(expect4am('2026-03-01T04:00:00+08:00'))
  })

  it('闰年月末：CST 2028-02-29 → 3 月 1 日 04:00', () => {
    expect(nextDay4AMMs(at('2028-02-29T12:00:00+08:00'))).toBe(expect4am('2028-03-01T04:00:00+08:00'))
  })

  it('跨年：CST 12 月 31 日 23:59:59 → 次年 1 月 1 日 04:00', () => {
    expect(nextDay4AMMs(at('2026-12-31T23:59:59+08:00'))).toBe(expect4am('2027-01-01T04:00:00+08:00'))
  })

  it('默认参数（当前时间）结果在未来，且距今不超过 24 小时', () => {
    const now = Date.now()
    const got = nextDay4AMMs()
    expect(got).toBeGreaterThan(now)
    expect(got - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
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
  const dummyToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1MTIzIiwiZW50ZXJwcmlzZV9pZCI6ImUxMjMiLCJkb21haW4iOiJleGFtcGxlLmNvbSIsIm5pY2tuYW1lIjoidGVzdHVzZXIifQ.sig'

  it('注入四项归属头 + UID / EnterpriseID / Domain / DeviceToken', () => {
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, dummyToken, 'cn', {
      device_token: 'dt-abc-123',
    })

    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe(WORKBUDDY_CLIENT_VERSION)
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(headers['X-User-Id']).toBe('u123')
    expect(headers['X-Enterprise-Id']).toBe('e123')
    expect(headers['X-Domain']).toBe('example.com')
    expect(headers['X-Device-Token']).toBe('dt-abc-123')
    expect(headers['X-Refresh-Token']).toBeUndefined()
  })

  it('注入风控闸门头 X-CodeBuddy-Request: 1（D1）', () => {
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, dummyToken, 'cn')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
  })

  it('注入 X-Requested-With: XMLHttpRequest（官方桌面端所有 API 均带）', () => {
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, dummyToken, 'cn')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('Accept-Language 按 realm 切（cn zh-CN / global en-US，D5）', () => {
    const cn: Record<string, string> = {}
    injectWorkbuddyChatHeaders(cn, dummyToken, 'cn')
    expect(cn['Accept-Language']).toBe('zh-CN')

    const gl: Record<string, string> = {}
    injectWorkbuddyChatHeaders(gl, dummyToken, 'global')
    expect(gl['Accept-Language']).toBe('en-US')
  })

  it('UA 三段式且平台段按 realm 切（global 送错会触发 403/11140）', () => {
    const cn: Record<string, string> = {}
    injectWorkbuddyChatHeaders(cn, dummyToken, 'cn')
    expect(cn['User-Agent']).toBe(
      `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} WorkBuddy/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`
    )

    const gl: Record<string, string> = {}
    injectWorkbuddyChatHeaders(gl, dummyToken, 'global')
    expect(gl['User-Agent']).toBe(
      `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} WorkBuddy AI/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`
    )
    // 关键：global 平台段必须是 WorkBuddy AI，不是 WorkBuddy
    expect(gl['User-Agent']).toContain('WorkBuddy AI/')
  })

  it('Accept 分流（D6）：chat 路径声明 event-stream，非 chat 路径保持 application/json', () => {
    const chat: Record<string, string> = { Accept: 'application/json' }
    injectWorkbuddyChatHeaders(chat, dummyToken, 'cn', undefined, undefined, { chatPath: true })
    expect(chat['Accept']).toBe('application/json, text/event-stream')

    // 非 chat 路径（如 models）不得被改成 event-stream
    const models: Record<string, string> = { Accept: 'application/json' }
    injectWorkbuddyChatHeaders(models, dummyToken, 'cn', undefined, undefined, { chatPath: false })
    expect(models['Accept']).toBe('application/json')
  })

  it('Accept 缺省按 chat 路径处理（绝大多数调用是 chat）', () => {
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, dummyToken, 'cn')
    expect(headers['Accept']).toBe('application/json, text/event-stream')
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

  it('Global 域声明无企业：不发 X-Enterprise-Id，改发 X-No-Enterprise-Id', () => {
    // 对齐 workbuddy2api injectGlobalChatHeaders：国际版客户端固定 X-No-Enterprise-Id=1，
    // 即使 token 里有 enterpriseId 也不回退。
    const headers: Record<string, string> = {}
    injectWorkbuddyChatHeaders(headers, dummyToken, 'global')
    expect(headers['X-No-Enterprise-Id']).toBe('1')
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Tenant-Id']).toBeUndefined()
  })

  it('Global 域 X-Domain 固定 workbuddy.ai（不回退登录会话原值）', () => {
    const headers: Record<string, string> = {}
    // dummyToken 的 domain claim 是 example.com，global 下应被覆盖为 workbuddy.ai
    injectWorkbuddyChatHeaders(headers, dummyToken, 'global')
    expect(headers['X-Domain']).toBe('workbuddy.ai')
  })
})

describe('ensureGlobalFallbackSystem（移植 workbuddy2api ensureConsoleSystem）', () => {
  it('首条非 system → 最前插入兜底 system', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }
    ensureGlobalFallbackSystem(body)
    const msgs = body['messages'] as any[]
    expect(msgs.length).toBe(2)
    expect(msgs[0]).toEqual({ role: 'system', content: GLOBAL_FALLBACK_SYSTEM })
    expect(msgs[1].role).toBe('user')
  })

  it('首条已是 system → 不注入', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'system', content: 'mine' }, { role: 'user', content: 'hi' }],
    }
    ensureGlobalFallbackSystem(body)
    const msgs = body['messages'] as any[]
    expect(msgs.length).toBe(2)
    expect(msgs[0].content).toBe('mine')
  })

  it('首条 system 判定大小写/空白不敏感', () => {
    for (const role of ['System', 'SYSTEM', ' system ']) {
      const body: Record<string, unknown> = { messages: [{ role, content: 'x' }] }
      ensureGlobalFallbackSystem(body)
      expect((body['messages'] as any[]).length).toBe(1)
    }
  })

  it('**关键语义修正**：system 出现在中间但首条非 system → 仍注入', () => {
    // 旧实现判的是 !msgs.some(m => m.role === 'system')，此形态不注入 → 撞上游 code 11-128。
    // 源头按**首条**判定，故必须注入。
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
        { role: 'user', content: 'again' },
      ],
    }
    ensureGlobalFallbackSystem(body)
    const msgs = body['messages'] as any[]
    expect(msgs.length).toBe(4)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(GLOBAL_FALLBACK_SYSTEM)
    // 原有的中间 system 保留
    expect(msgs[2].content).toBe('mid')
  })

  it('messages 缺失/空/非数组 → 不改动', () => {
    const a: Record<string, unknown> = {}
    ensureGlobalFallbackSystem(a)
    expect(a['messages']).toBeUndefined()

    const b: Record<string, unknown> = { messages: [] }
    ensureGlobalFallbackSystem(b)
    expect((b['messages'] as any[]).length).toBe(0)

    const c: Record<string, unknown> = { messages: 'not-array' }
    ensureGlobalFallbackSystem(c)
    expect(c['messages']).toBe('not-array')
  })

  it('首条为 null/畸形 → 视为非 system，注入', () => {
    const body: Record<string, unknown> = { messages: [null, { role: 'user', content: 'hi' }] }
    ensureGlobalFallbackSystem(body)
    const msgs = body['messages'] as any[]
    expect(msgs.length).toBe(3)
    expect(msgs[0].role).toBe('system')
  })

  it('幂等：连续调用两次只注入一条', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }
    ensureGlobalFallbackSystem(body)
    ensureGlobalFallbackSystem(body)
    const msgs = body['messages'] as any[]
    expect(msgs.length).toBe(2)
    expect(msgs[0].role).toBe('system')
  })
})

describe('指纹脱敏 sanitizeFingerprintText（移植 workbuddy2api sanitize.go）', () => {
  it('普通文本零改动（快速路径）', () => {
    const s = 'hello world, no fingerprint here'
    expect(sanitizeFingerprintText(s)).toBe(s)
  })

  it('身份句改写（for Claude → for Claude tool）', () => {
    const out = sanitizeFingerprintText("You are Claude Code, Anthropic's official CLI for Claude.")
    expect(out).toContain('official CLI tool for Claude')
  })

  it('**关键**：身份句匹配串不带结尾标点 → 桌面版（逗号接续）也覆盖', () => {
    // 源实现回归用例（sanitize_test.go:33）：带句号的整句只匹配 CLI 版，
    // 桌面版（claude-desktop-3p / Agent SDK）以逗号接后继内容会漏网 → 400 code=11128。
    const desktop = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
    const out = sanitizeFingerprintText(desktop)
    expect(out).toContain('official CLI tool for Claude')
    // 原有标点与后继内容保留
    expect(out).toContain(', running within the Claude Agent SDK.')
  })

  it('Main branch → Default branch 改写', () => {
    const out = sanitizeFingerprintText('Main branch (you will usually use this for PRs)')
    expect(out).toBe('Default branch (you will usually use this for PRs)')
  })

  it('Codex CLI 身份句改写', () => {
    const out = sanitizeFingerprintText('You are a coding agent running in the Codex CLI, a terminal-based coding assistant.')
    expect(out).toContain('Codex CLI tool, a terminal-based coding assistant')
  })

  it('反馈句整句改写（give → provide）', () => {
    const out = sanitizeFingerprintText('To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues')
    expect(out).toContain('To provide feedback')
  })

  it('**关键修正**：11128 → 11-128（用连字符，不用零宽空格）', () => {
    // 源实现明确"零宽空格无效，实测上游会归一化"；本仓旧实现用 \u200B —— 无效做法。
    const out = sanitizeFingerprintText('upstream returned code=11128 for this request')
    expect(out).not.toContain('11128')
    expect(out).toContain('11-128')
    expect(out).not.toContain('\u200B')
  })

  it('相邻错误码不误伤（11148 / 11101 / 11115 / 99999）', () => {
    for (const code of ['11148', '11101', '11115', '99999']) {
      const s = `error ${code}`
      expect(sanitizeFingerprintText(s)).toBe(s)
    }
  })

  it('剥离 x-anthropic-billing-header 键值段（键名即触发）', () => {
    const out = sanitizeFingerprintText('x-anthropic-billing-header:abc123; other text')
    expect(out).not.toContain('x-anthropic-billing-header')
    expect(out).toContain('other text')
  })

  it('剥离 x-anthropic-billing-header 大小写变体', () => {
    const out = sanitizeFingerprintText('X-Anthropic-Billing-Header:xyz; keep')
    expect(out.toLowerCase()).not.toContain('x-anthropic-billing-header')
    expect(out).toContain('keep')
  })

  it('循环清理尾随裸键值 cc_xxx=...', () => {
    const out = sanitizeFingerprintText('cc_version=1.2.3; cc_entrypoint=cli; real text')
    expect(out).not.toContain('cc_version')
    expect(out).not.toContain('cc_entrypoint')
    expect(out).toContain('real text')
  })

  it('结果被 trim', () => {
    expect(sanitizeFingerprintText('  11128  ')).toBe('11-128')
  })
})

describe('sanitizeWorkbuddyMessages 请求体脱敏', () => {
  it('净化字符串 content', () => {
    const body = { messages: [{ role: 'user', content: 'code=11128 here' }] }
    sanitizeWorkbuddyMessages(body)
    expect((body.messages[0] as any).content).toBe('code=11-128 here')
  })

  it('净化多模态数组的 text part，image part 不动', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'code=11128' },
          { type: 'image_url', image_url: { url: 'http://x/11128.png' } },
        ],
      }],
    }
    sanitizeWorkbuddyMessages(body)
    const parts = (body.messages[0] as any).content
    expect(parts[0].text).toBe('code=11-128')
    // image part 不动（URL 里的 11128 保留）
    expect(parts[1].image_url.url).toBe('http://x/11128.png')
  })

  it('**关键**：content 为 null 时仍净化 tool_calls.arguments（旧实现盲区）', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'run', arguments: '{"command":"echo 11128"}' },
        }],
      }],
    }
    sanitizeWorkbuddyMessages(body)
    const args = (body.messages[0] as any).tool_calls[0].function.arguments
    expect(args).not.toContain('11128')
    expect(args).toContain('11-128')
  })

  it('tool_calls 的 function.name 不在脱敏范围', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: '11128_tool', arguments: '{}' } }],
      }],
    }
    sanitizeWorkbuddyMessages(body)
    expect((body.messages[0] as any).tool_calls[0].function.name).toBe('11128_tool')
  })

  it('无 messages / 畸形输入不抛错', () => {
    expect(() => sanitizeWorkbuddyMessages({})).not.toThrow()
    expect(() => sanitizeWorkbuddyMessages({ messages: 'bad' })).not.toThrow()
    expect(() => sanitizeWorkbuddyMessages({ messages: [null, 1, 'x'] })).not.toThrow()
  })
})

describe('内容拦截防火墙文案（移植 workbuddy2api contentBlockedClientMessage）', () => {
  it('从信封 msg 抽取分类词（色情 / 暴力 / 政治…）', () => {
    expect(contentBlockedKeyword('{"msg":"内容涉及色情内容"}')).toBe('色情')
    expect(contentBlockedKeyword('{"msg":"violence detected"}')).toBe('violence')
    expect(contentBlockedKeyword('{"msg":"politics related"}')).toBe('politics')
  })

  it('分类词优先级按定义顺序（色情 > 暴力 > …）', () => {
    // 同时含多个词时取靠前者
    expect(contentBlockedKeyword('{"msg":"色情与暴力"}')).toBe('色情')
  })

  it('抽不到 → 兜底「违禁词」', () => {
    expect(contentBlockedKeyword('{"msg":"blocked by security policy"}')).toBe(CONTENT_BLOCKED_FALLBACK_KEYWORD)
    expect(contentBlockedKeyword('')).toBe(CONTENT_BLOCKED_FALLBACK_KEYWORD)
  })

  it('非 JSON body 用原文扫描', () => {
    expect(contentBlockedKeyword('contains 赌博 content')).toBe('赌博')
  })

  it('大小写不敏感（英文词）', () => {
    expect(contentBlockedKeyword('{"msg":"NSFW"}')).toBe('nsfw')
    expect(contentBlockedKeyword('{"msg":"Porn"}')).toBe('porn')
  })

  it('**关键**：客户端文案不含上游业务码/账号/冷却语义', () => {
    const upstreamBody = '{"error":{"data":{"code":11128,"msg":"内容涉及色情，账号已被冷却"}}}'
    const msg = contentBlockedClientMessage(upstreamBody)
    // 不泄漏业务码
    expect(msg).not.toContain('11128')
    // 不含账号/冷却措辞
    expect(msg).not.toContain('冷却')
    expect(msg).not.toContain('账号')
    // 含分类词与防火墙口径
    expect(msg).toContain('色情')
    expect(msg).toContain('内容防火墙规则')
  })

  it('文案格式与源实现一致', () => {
    const msg = contentBlockedClientMessage('{"msg":"暴力"}')
    expect(msg).toBe('触发网站风控违禁词，无法调用模型：内容命中网关内容防火墙规则[暴力]，已被拦截。请修改内容后重试。')
  })

  it('ContentBlockedError 携带改写后的客户端文案', () => {
    const err = new ContentBlockedError('{"msg":"赌博"}')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ContentBlockedError')
    // 分类词保留（告知用户原因），但不含上游业务码
    expect(err.clientMessage).toContain('赌博')
    expect(err.clientMessage).toContain('内容防火墙规则')
  })
})

describe('buildWorkbuddyUserAgent / workbuddyAcceptLanguage / workbuddyChatAccept 纯函数', () => {
  it('buildWorkbuddyUserAgent 三段式形态与 realm 平台段', () => {
    expect(buildWorkbuddyUserAgent('cn')).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(buildWorkbuddyUserAgent('global')).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
  })

  it('workbuddyAcceptLanguage 按 realm 切', () => {
    expect(workbuddyAcceptLanguage('cn')).toBe('zh-CN')
    expect(workbuddyAcceptLanguage('global')).toBe('en-US')
  })

  it('workbuddyChatAccept 恒为 event-stream 形式（上游被强制流式）', () => {
    expect(workbuddyChatAccept()).toBe('application/json, text/event-stream')
  })
})

describe('ensureWorkbuddyStreamOptions（移植 workbuddy2api payload.go D7）', () => {
  it('未带 stream_options → 注入 { include_usage: true }', () => {
    const body: Record<string, unknown> = { model: 'glm-5.2', messages: [] }
    ensureWorkbuddyStreamOptions(body)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('已带 stream_options 对象 → 不覆盖（含显式 include_usage:false）', () => {
    const body: Record<string, unknown> = {
      model: 'glm-5.2',
      stream_options: { include_usage: false },
    }
    ensureWorkbuddyStreamOptions(body)
    // 尊重调用方显式意图：false 不被改写成 true
    expect(body['stream_options']).toEqual({ include_usage: false })
  })

  it('已带 stream_options 对象且含额外字段 → 整个对象原样保留', () => {
    const body: Record<string, unknown> = {
      model: 'glm-5.2',
      stream_options: { include_usage: true, custom: 'keep' },
    }
    ensureWorkbuddyStreamOptions(body)
    expect(body['stream_options']).toEqual({ include_usage: true, custom: 'keep' })
  })

  it('stream_options 为 null → 注入标准对象（上游无法解析 null，等价于没给有效值）', () => {
    const body: Record<string, unknown> = { model: 'glm-5.2', stream_options: null }
    ensureWorkbuddyStreamOptions(body)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('stream_options 为非对象标量/数组 → 注入标准对象（防上游 400 code=11101）', () => {
    for (const bad of ['x', 1, true, [1, 2]]) {
      const body: Record<string, unknown> = { model: 'glm-5.2', stream_options: bad }
      ensureWorkbuddyStreamOptions(body)
      expect(body['stream_options']).toEqual({ include_usage: true })
    }
  })

  it('幂等：连续调用两次结果一致（不叠加/不嵌套）', () => {
    const body: Record<string, unknown> = { model: 'glm-5.2' }
    ensureWorkbuddyStreamOptions(body)
    const first = JSON.stringify(body['stream_options'])
    ensureWorkbuddyStreamOptions(body)
    expect(JSON.stringify(body['stream_options'])).toBe(first)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('不触碰 body 其他字段（纯增量）', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.7,
    }
    const before = JSON.stringify({ ...body })
    ensureWorkbuddyStreamOptions(body)
    const { stream_options: _so, ...rest } = body
    expect(JSON.stringify(rest)).toBe(before)
  })
})

describe('WorkbuddyClientError 与 formatWorkbuddyClientErrorMessage 客户端错误格式化', () => {
  it('WorkbuddyClientError 构造与属性', () => {
    const err = new WorkbuddyClientError(400, '{"code":11101,"msg":"Unmarshal error"}')
    expect(err.name).toBe('WorkbuddyClientError')
    expect(err.status).toBe(400)
    expect(err.upstreamText).toBe('{"code":11101,"msg":"Unmarshal error"}')
    expect(err.message).toContain('upstream client error 400')
  })

  it('formatWorkbuddyClientErrorMessage：正确解析 JSON msg 与 code', () => {
    const res = formatWorkbuddyClientErrorMessage(400, '{"code":11101,"msg":"Unmarshal chat params failed"}')
    expect(res.message).toBe('上游请求参数错误 (HTTP 400)：Unmarshal chat params failed')
    expect(res.code).toBe(11101)
  })

  it('formatWorkbuddyClientErrorMessage：正确解析 error.message 结构', () => {
    const res = formatWorkbuddyClientErrorMessage(400, '{"error":{"message":"context length exceeded","code":"invalid_request_error"}}')
    expect(res.message).toBe('上游请求参数错误 (HTTP 400)：context length exceeded')
    expect(res.code).toBe('invalid_request_error')
  })

  it('formatWorkbuddyClientErrorMessage：非 JSON 原文兜底', () => {
    const res = formatWorkbuddyClientErrorMessage(400, 'Bad Request: invalid payload')
    expect(res.message).toBe('上游请求参数错误 (HTTP 400)：Bad Request: invalid payload')
    expect(res.code).toBeUndefined()
  })

  it('formatWorkbuddyClientErrorMessage：空串兜底', () => {
    const res = formatWorkbuddyClientErrorMessage(400, '')
    expect(res.message).toBe('上游请求参数错误 (HTTP 400)：INVALID_REQUEST')
  })
})

describe('ensureWorkbuddyMaxTokens（WorkBuddy 出站 max_tokens 安全护栏）', () => {
  it('未提供 max_tokens 与 max_completion_tokens 时自动注入默认 32768', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash' }
    ensureWorkbuddyMaxTokens(body)
    expect(body['max_tokens']).toBe(WORKBUDDY_DEFAULT_MAX_TOKENS)
    expect(body['max_tokens']).toBe(32768)
  })

  it('已提供有效正数 max_tokens 时原样保留不被覆盖', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash', max_tokens: 4096 }
    ensureWorkbuddyMaxTokens(body)
    expect(body['max_tokens']).toBe(4096)
  })

  it('已提供有效正数 max_completion_tokens 时不额外注入 max_tokens', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash', max_completion_tokens: 8192 }
    ensureWorkbuddyMaxTokens(body)
    expect(body['max_tokens']).toBeUndefined()
    expect(body['max_completion_tokens']).toBe(8192)
  })

  it('非正数或无效 max_tokens 触发安全注入', () => {
    const body1: Record<string, unknown> = { model: 'glm-5.2', max_tokens: 0 }
    ensureWorkbuddyMaxTokens(body1)
    expect(body1['max_tokens']).toBe(32768)

    const body2: Record<string, unknown> = { model: 'glm-5.2', max_tokens: -100 }
    ensureWorkbuddyMaxTokens(body2)
    expect(body2['max_tokens']).toBe(32768)

    const body3: Record<string, unknown> = { model: 'glm-5.2', max_tokens: null }
    ensureWorkbuddyMaxTokens(body3)
    expect(body3['max_tokens']).toBe(32768)
  })

  it('支持自定义 defaultTokens 参数', () => {
    const body: Record<string, unknown> = { model: 'qwen-coder' }
    ensureWorkbuddyMaxTokens(body, 16384)
    expect(body['max_tokens']).toBe(16384)
  })

  it('幂等：连续调用两次结果完全一致', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-flash' }
    ensureWorkbuddyMaxTokens(body)
    ensureWorkbuddyMaxTokens(body)
    expect(body['max_tokens']).toBe(32768)
  })
})


