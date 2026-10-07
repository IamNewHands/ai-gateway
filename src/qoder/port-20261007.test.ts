/**
 * port-20261007.test.ts — qoder2api-hub 移植项的回归测试（第五轮）。
 *
 * 源：github.com/shuishuipingan/qoder2api-hub 水位线 a4e251e → a6bab92
 * （分析见 _port-analysis/qoder2api-round2-porting-analysis.md）。
 *
 * 覆盖三项已确认缺陷的修复后行为：
 *   H-1 机器身份门控（hub issue #10 / v1.2.1 330cf23）—— 头集合形态，用例在
 *       port-20260923.test.ts 与 device.test.ts 里（它们原本就断言出站头）。
 *   H-2 内层信封错误可见（hub v1.2.6 563346c task-34）。
 *   Q-1 工具历史结构化直传（hub v1.2.6 563346c task-32）。
 *
 * 断言的是**行为**而非实现细节：改实现只要行为不变，这里就不该红。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildQoderBody, useQoderStructuredToolHistory, qoderToolIdsComplete, qoderStructuredToolMode, type ChatMessage } from './body'
import {
  classifyQoderInnerError,
  qoderInnerErrorDetail,
  qoderInnerErrorClassified,
  noteQoderInnerError,
  qoderInnerErrorSnapshot,
  resetQoderInnerErrorStats,
} from './classify'
import { cosySessionFor } from './cosy'
import { proxyQoderChatRequest } from './proxy'
import type { Env, Provider } from '../types'

afterEach(() => {
  vi.unstubAllGlobals()
  resetQoderInnerErrorStats()
})

/** 上游信封帧（外层 statusCodeValue 恒 200，错误藏在 body 内层）。 */
function envelope(body: string, statusCodeValue = 200): string {
  return JSON.stringify({ headers: {}, body, statusCodeValue })
}

function sseBody(frames: string[]): string {
  return frames.map((f) => `data: ${f}\n\n`).join('')
}

const INNER_CONTENT_CHUNK = JSON.stringify({
  id: 'chatcmpl-1',
  model: 'auto',
  choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }],
})

/**
 * 上游藏在 HTTP 200 信封里的内层错误（hub task-34 实测原文）。
 * 关键：外层 statusCodeValue=200，故既有信封检查看不见它。
 */
const INNER_TOOL_PAIRING_ERROR = JSON.stringify({
  error: {
    code: 'provider_error',
    message: "invalid_request_error: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
  },
})

/** 走单次直发路径（注入会话，不经过池）。 */
async function callProxy(frames: string[], opts?: { stream?: boolean }) {
  const session = await cosySessionFor('dt-test-20261007', 'drt-test', 'uid-20261007', '测试')
  const fetchMock = vi.fn(async () =>
    new Response(sseBody(frames), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  const resp = await proxyQoderChatRequest({} as Env, { id: 'qoder' } as Provider, {
    model: 'auto',
    stream: opts?.stream ?? true,
    messages: [{ role: 'user', content: 'hi' }],
  }, { session: { session }, stream: opts?.stream ?? false })
  return { resp }
}

// ===== H-2：内层信封错误可见（hub task-34） =====
describe('H-2 内层信封错误：HTTP200 里藏着的失败不再静默', () => {
  it('非流式：内层错误 + 零正文 → 如实报错，不再返回 200 + 空 content', async () => {
    // 旧行为：aggregateQoderChunks 对没有 choices 的帧 continue → 帧被丢掉，
    // chunks.length > 0 于是通过空流闸门 → 客户端收到「200 + 空 content + finish_reason: stop」。
    const { resp } = await callProxy([envelope(INNER_TOOL_PAIRING_ERROR), envelope('[DONE]')], { stream: false })
    expect(resp.status).not.toBe(200)
    const body = await resp.text()
    expect(body).toContain('"error"')
    // 请求形状问题：必须明说重试无效，否则客户端会无限重试同一个畸形请求
    expect(body).toContain('invalid_request_error')
    expect(body).not.toContain('"finish_reason":"stop"')
  })

  it('非流式：内层错误**但已有正文** → 照常返回 200，正文不丢（不改有产出请求的行为）', async () => {
    const { resp } = await callProxy(
      [envelope(INNER_CONTENT_CHUNK), envelope(INNER_TOOL_PAIRING_ERROR), envelope('[DONE]')],
      { stream: false }
    )
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('你好')
    expect(body).toContain('chat.completion')
  })

  it('非流式：纯 tool_calls（content 为空）不算「零正文」，不得误报为上游错误', async () => {
    // 只有工具调用的回复 content 本来就是空串，那是正常产出——把空 content 一律当失败
    // 会把所有纯工具调用的非流式请求打成 502。
    const toolCallChunk = JSON.stringify({
      id: 'chatcmpl-tc',
      model: 'auto',
      choices: [{
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] },
        finish_reason: 'tool_calls',
      }],
    })
    const { resp } = await callProxy([envelope(toolCallChunk), envelope('[DONE]')], { stream: false })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('tool_calls')
    expect(body).toContain('call_1')
  })

  it('流式：内层错误仍原样透传给客户端（只加观测，不改行为）', async () => {
    const { resp } = await callProxy([envelope(INNER_TOOL_PAIRING_ERROR), envelope('[DONE]')], { stream: true })
    expect(resp.status).toBe(200)
    const text = await resp.text()
    // 流式路径原本就会把该 chunk 转发出去，这条用例钉住「移植没有把它吞掉」
    expect(text).toContain('must be a response')
  })

  it('内层错误按类别计数，且同类只告警一次（避免刷爆日志）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 上游会把同一个错误塞进多帧：计数要涨，日志只能有一条
    for (let i = 0; i < 5; i++) noteQoderInnerError(INNER_TOOL_PAIRING_ERROR, 'test')
    expect(qoderInnerErrorSnapshot().total).toBe(5)
    expect(qoderInnerErrorSnapshot().kinds.invalid_request).toBe(5)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('invalid_request')
    // 正常 chunk 不计数、不告警
    expect(noteQoderInnerError(INNER_CONTENT_CHUNK, 'test')).toBe('')
    expect(qoderInnerErrorSnapshot().total).toBe(5)
    warn.mockRestore()
  })

  it('内层错误形态解析：兼容 error 对象与 error 字符串，正常 chunk 返回 null', () => {
    expect(qoderInnerErrorDetail(INNER_TOOL_PAIRING_ERROR)?.kind).toBe('invalid_request')
    expect(qoderInnerErrorDetail(JSON.stringify({ error: 'rate limit exceeded' }))?.kind).toBe('rate_limit')
    expect(qoderInnerErrorDetail(INNER_CONTENT_CHUNK)).toBeNull()
    expect(qoderInnerErrorDetail('not json')).toBeNull()
    expect(qoderInnerErrorDetail(JSON.stringify({ choices: [] }))).toBeNull()
  })

  it('内层错误归类：内容审核优先于其它关键词（顺序有意义）', () => {
    // 内容审核文案里常同时出现别的关键词，若排在后面会被误判成 invalid_request
    expect(classifyQoderInnerError('provider_error', 'DataInspectionFailed: inappropriate content')).toBe('content_policy')
    expect(classifyQoderInnerError('10605', 'isQueued')).toBe('rate_limit')
    expect(classifyQoderInnerError('provider_error', "must be a response to a preceding message")).toBe('invalid_request')
    expect(classifyQoderInnerError('', 'unauthorized token expired')).toBe('auth')
    expect(classifyQoderInnerError('weird_code', 'something odd')).toBe('other')
    expect(classifyQoderInnerError('', '')).toBe('')
  })

  it('内层错误映射为分类时：请求形状问题不换号（否则会白烧其它账号配额）', () => {
    // content_policy / invalid_request 是**请求属性**，换号必然被同样拒绝
    expect(qoderInnerErrorClassified('invalid_request', 'provider_error', 'x').failover).toBe(false)
    expect(qoderInnerErrorClassified('invalid_request', 'provider_error', 'x').status).toBe(400)
    expect(qoderInnerErrorClassified('content_policy', '', 'x').failover).toBe(false)
    expect(qoderInnerErrorClassified('content_policy', '', 'x').status).toBe(400)
    // 限流/鉴权/其它是可换号的
    expect(qoderInnerErrorClassified('rate_limit', '', 'x').failover).toBe(true)
    expect(qoderInnerErrorClassified('rate_limit', '', 'x').status).toBe(429)
    expect(qoderInnerErrorClassified('auth', '', 'x').status).toBe(403)
    expect(qoderInnerErrorClassified('other', '', 'x').status).toBe(502)
    // 归类结果必须能被 classify 的 kind 消费（否则池循环拿不到语义）
    expect(['quota', 'rate_limit', 'auth', 'not_ready', 'unavailable', 'content_policy'])
      .toContain(qoderInnerErrorClassified('invalid_request', '', 'x').kind)
  })
})

// ===== Q-1：工具历史结构化直传（hub task-32） =====
describe('Q-1 工具历史结构化直传：tool_call_id 与 assistant.tool_calls 不再丢弃', () => {
  /** 一轮完整的「assistant 发起调用 → tool 返回结果」历史。 */
  const toolHistory: ChatMessage[] = [
    { role: 'user', content: '列出文件' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file1\nfile2' },
  ]

  /** 取出发给上游的 messages（模板 system 之后的部分）。 */
  function upstreamMessages(body: string): any[] {
    const parsed = JSON.parse(body)
    const msgs: any[] = Array.isArray(parsed.messages) ? parsed.messages : []
    return msgs.filter((m) => m.role !== 'system')
  }

  it('结构化：tool 保留 tool_call_id，assistant 保留 tool_calls（配对不断）', () => {
    const body = buildQoderBody(toolHistory, 'auto', undefined, undefined, true)
    const msgs = upstreamMessages(body)
    const tool = msgs.find((m) => m.role === 'tool')
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    expect(tool).toBeTruthy()
    expect(tool.tool_call_id).toBe('call_1')
    expect(tool.content).toBe('file1\nfile2')
    expect(assistant).toBeTruthy()
    expect(assistant.tool_calls[0].id).toBe('call_1')
    expect(assistant.tool_calls[0].function.name).toBe('Bash')
    expect(assistant.tool_calls[0].function.arguments).toBe('{"cmd":"ls"}')
  })

  it('结构化：content 为 null 时写成空字符串，绝不发 null（null 会让上游丢掉配对消息）', () => {
    const body = buildQoderBody(
      [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'X', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: null },
      ],
      'auto',
      undefined,
      undefined,
      true
    )
    const msgs = upstreamMessages(body)
    const assistant = msgs.find((m) => Array.isArray(m.tool_calls))
    const tool = msgs.find((m) => m.role === 'tool')
    expect(assistant.content).toBe('')
    expect(assistant.content).not.toBeNull()
    expect(tool.content).toBe('')
    expect(tool.content).not.toBeNull()
  })

  it('结构化：arguments 为对象时统一成 JSON 字符串（dict 会被两侧转换层按字符串处理）', () => {
    const body = buildQoderBody(
      [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'X', arguments: { cmd: 'ls' } } }] }],
      'auto',
      undefined,
      undefined,
      true
    )
    const assistant = upstreamMessages(body).find((m) => Array.isArray(m.tool_calls))
    expect(typeof assistant.tool_calls[0].function.arguments).toBe('string')
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ cmd: 'ls' })
  })

  it('结构化：缺 id 时整条回退扁平形态（fail-safe：宁可不发畸形请求）', () => {
    // 上游对「tool 配不上前一条 tool_calls」是直接拒绝的，所以 id 不齐就不能走结构化
    const incomplete: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'tool', content: 'out' },
    ]
    expect(qoderToolIdsComplete(incomplete)).toBe(false)
    expect(useQoderStructuredToolHistory(incomplete, 'auto')).toBe(false)
    // 即便强制 on，也不能发出畸形请求
    expect(useQoderStructuredToolHistory(incomplete, 'on')).toBe(false)
    // 扁平形态：tool 没有 tool_call_id、assistant 没有 tool_calls（旧行为）
    const msgs = upstreamMessages(buildQoderBody(incomplete, 'auto', undefined, undefined, false))
    expect(msgs.find((m) => m.role === 'tool')?.tool_call_id).toBeUndefined()
    expect(msgs.find((m) => m.role === 'assistant')?.tool_calls).toBeUndefined()
  })

  it('开关：auto 只在有工具历史时启用；off 一键回退；纯对话请求形态不变', () => {
    const plain: ChatMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]
    // 纯对话：auto 不启用（不改变无工具请求的任何行为）
    expect(useQoderStructuredToolHistory(plain, 'auto')).toBe(false)
    expect(useQoderStructuredToolHistory(toolHistory, 'auto')).toBe(true)
    // off 一键回退（出问题不用改代码/回滚部署）
    expect(useQoderStructuredToolHistory(toolHistory, 'off')).toBe(false)
    expect(useQoderStructuredToolHistory(toolHistory, 'on')).toBe(true)
    // 纯对话在 on 下也照常（只是没有工具分支可走）
    const msgs = upstreamMessages(buildQoderBody(plain, 'auto', undefined, undefined, true))
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('env 开关解析：缺省 auto，认得常见真/假写法，未知值回落 auto', () => {
    expect(qoderStructuredToolMode(undefined)).toBe('auto')
    expect(qoderStructuredToolMode({})).toBe('auto')
    expect(qoderStructuredToolMode({ QODER_STRUCTURED_TOOL_HISTORY: '' })).toBe('auto')
    expect(qoderStructuredToolMode({ QODER_STRUCTURED_TOOL_HISTORY: 'auto' })).toBe('auto')
    for (const v of ['on', '1', 'true', 'YES', 'enable', 'force']) {
      expect(qoderStructuredToolMode({ QODER_STRUCTURED_TOOL_HISTORY: v })).toBe('on')
    }
    for (const v of ['off', '0', 'false', 'NO', 'disable']) {
      expect(qoderStructuredToolMode({ QODER_STRUCTURED_TOOL_HISTORY: v })).toBe('off')
    }
    expect(qoderStructuredToolMode({ QODER_STRUCTURED_TOOL_HISTORY: 'garbage' })).toBe('auto')
  })

  it('非结构化（旧扁平路径）逐字节不变：只有 role/content 两个键', () => {
    // 这是「不影响原有功能」的回归锚点：默认路径的 messages 形状必须与移植前一致
    const body = buildQoderBody(toolHistory, 'auto', undefined, undefined, false)
    const msgs = upstreamMessages(body)
    for (const m of msgs) {
      expect(Object.keys(m).sort()).toEqual(['content', 'role'])
    }
  })
})
