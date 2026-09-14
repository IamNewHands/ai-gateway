import { describe, it, expect, beforeEach } from 'vitest'
import {
  newMessageId,
  isValidB3TraceId,
  resolveConversationId,
  contentText,
  turnKey,
  requestIdForKey,
  turnRequestId,
  buildChatMeta,
  injectConversationHeaders,
  extractSessionKey,
  __resetSessionIdsForTests,
  __resetTurnSaltForTests,
} from './workbuddy-session-ids'

describe('newMessageId / isValidB3TraceId', () => {
  it('newMessageId 恒为 32 位小写 hex', () => {
    for (let i = 0; i < 20; i++) {
      const id = newMessageId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('newMessageId 每次不同（随机性）', () => {
    const set = new Set(Array.from({ length: 50 }, () => newMessageId()))
    expect(set.size).toBe(50)
  })

  it('isValidB3TraceId 只认 16/32 位 hex', () => {
    expect(isValidB3TraceId('a'.repeat(16))).toBe(true)
    expect(isValidB3TraceId('a'.repeat(32))).toBe(true)
    expect(isValidB3TraceId('A1B2'.repeat(8))).toBe(true)
    // 长度不对
    expect(isValidB3TraceId('a'.repeat(15))).toBe(false)
    expect(isValidB3TraceId('a'.repeat(31))).toBe(false)
    expect(isValidB3TraceId('')).toBe(false)
    // 非 hex（含横线的 UUID 形态）
    expect(isValidB3TraceId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(isValidB3TraceId('g'.repeat(32))).toBe(false)
  })
})

describe('resolveConversationId（只认 conversationId，绝不回落 user_id）', () => {
  it('识别顺序：metadata.conversation_id 优先', () => {
    expect(resolveConversationId({
      metadata: { conversation_id: 'snake-meta', conversationId: 'camel-meta' },
      conversation_id: 'top-snake',
      conversationId: 'top-camel',
    })).toBe('snake-meta')
  })

  it('metadata.conversationId 次之', () => {
    expect(resolveConversationId({
      metadata: { conversationId: 'camel-meta' },
      conversation_id: 'top-snake',
    })).toBe('camel-meta')
  })

  it('顶层 conversation_id / conversationId', () => {
    expect(resolveConversationId({ conversation_id: 'top-snake' })).toBe('top-snake')
    expect(resolveConversationId({ conversationId: 'top-camel' })).toBe('top-camel')
  })

  it('**不**回落 metadata.user_id（避免污染后台按对话聚合）', () => {
    // 这是与 extractSessionKey 的关键差异
    expect(resolveConversationId({ metadata: { user_id: 'u1' } })).toBe('')
    expect(extractSessionKey({ metadata: { user_id: 'u1' } })).toBe('u1')
  })

  it('空/畸形输入返回空串（不抛错）', () => {
    expect(resolveConversationId(null)).toBe('')
    expect(resolveConversationId(undefined)).toBe('')
    expect(resolveConversationId({})).toBe('')
    expect(resolveConversationId({ metadata: null })).toBe('')
    expect(resolveConversationId({ metadata: 'str' })).toBe('')
    expect(resolveConversationId({ conversation_id: 123 })).toBe('')
    expect(resolveConversationId({ conversation_id: '' })).toBe('')
  })
})

describe('extractSessionKey（允许回落 user_id）', () => {
  it('识别顺序：metadata.conversation_id → conversationId → user_id → 顶层', () => {
    expect(extractSessionKey({ metadata: { conversation_id: 'a', conversationId: 'b', user_id: 'c' } })).toBe('a')
    expect(extractSessionKey({ metadata: { conversationId: 'b', user_id: 'c' } })).toBe('b')
    expect(extractSessionKey({ metadata: { user_id: 'c' } })).toBe('c')
    expect(extractSessionKey({ conversation_id: 'd' })).toBe('d')
    expect(extractSessionKey({ conversationId: 'e' })).toBe('e')
  })

  it('空/畸形输入返回空串', () => {
    expect(extractSessionKey(null)).toBe('')
    expect(extractSessionKey({})).toBe('')
    expect(extractSessionKey({ metadata: [] })).toBe('')
  })
})

describe('contentText（多模态 parts 拼接）', () => {
  it('字符串原样返回', () => {
    expect(contentText('hello')).toBe('hello')
    expect(contentText('')).toBe('')
  })

  it('数组拼接各 part 的 text', () => {
    expect(contentText([
      { type: 'text', text: 'aa' },
      { type: 'image_url', image_url: { url: 'x' } },
      { type: 'text', text: 'bb' },
    ])).toBe('aabb')
  })

  it('null / 未知形态 / 纯图片 → 空串', () => {
    expect(contentText(null)).toBe('')
    expect(contentText(undefined)).toBe('')
    expect(contentText(123)).toBe('')
    expect(contentText([{ type: 'image_url', image_url: { url: 'x' } }])).toBe('')
  })
})

describe('turnKey（最后一条 user 消息的序号+文本）', () => {
  it('取**最后一条** user 消息（对齐"对话轮"语义）', () => {
    const body = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'second' },
      ],
    }
    // 索引 3、文本 second
    expect(turnKey(body)).toBe('u3:second')
  })

  it('同轮内追加 tool 结果不改键（一次 user send 内恒定）', () => {
    const base = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: '' },
    ]
    const k1 = turnKey({ messages: [...base] })
    const k2 = turnKey({ messages: [...base, { role: 'tool', content: 'result' }] })
    const k3 = turnKey({ messages: [...base, { role: 'tool', content: 'result' }, { role: 'assistant', content: 'x' }] })
    expect(k1).toBe(k2)
    expect(k2).toBe(k3)
    expect(k1).toBe('u0:do it')
  })

  it('用户发下一条消息 → 换键', () => {
    const k1 = turnKey({ messages: [{ role: 'user', content: 'q1' }] })
    const k2 = turnKey({ messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }] })
    expect(k1).not.toBe(k2)
  })

  it('序号入键：不同轮里内容相同的提问不混并', () => {
    const k1 = turnKey({ messages: [{ role: 'user', content: '继续' }] })
    const k2 = turnKey({ messages: [
      { role: 'user', content: '继续' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: '继续' },
    ] })
    expect(k1).toBe('u0:继续')
    expect(k2).toBe('u2:继续')
    expect(k1).not.toBe(k2)
  })

  it('最后一条 user 无文本（纯图片）→ 空串，且不继续往前找', () => {
    const body = {
      messages: [
        { role: 'user', content: 'has text' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
      ],
    }
    expect(turnKey(body)).toBe('')
  })

  it('多模态 content 拼接后入键', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }] }],
    }
    expect(turnKey(body)).toBe('u0:hi there')
  })

  it('无 messages / 无 user / 畸形输入 → 空串', () => {
    expect(turnKey(null)).toBe('')
    expect(turnKey({})).toBe('')
    expect(turnKey({ messages: [] })).toBe('')
    expect(turnKey({ messages: [{ role: 'assistant', content: 'a' }] })).toBe('')
    expect(turnKey({ messages: 'not-array' })).toBe('')
  })
})

describe('requestIdForKey（会话级稳定缓存）', () => {
  beforeEach(() => { __resetSessionIdsForTests() })

  it('同 key 恒同值（32 hex）', () => {
    const a = requestIdForKey('sess-1')
    const b = requestIdForKey('sess-1')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  it('异 key 各自独立', () => {
    expect(requestIdForKey('s1')).not.toBe(requestIdForKey('s2'))
  })

  it('空 key 每次新值（无会话则无"会话内稳定"语义）', () => {
    expect(requestIdForKey('')).not.toBe(requestIdForKey(''))
  })
})

describe('turnRequestId（轮级纯派生）', () => {
  it('同轮键恒同值（32 hex）', async () => {
    const a = await turnRequestId('u0:hi')
    const b = await turnRequestId('u0:hi')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  it('异轮键各自独立', async () => {
    expect(await turnRequestId('u0:hi')).not.toBe(await turnRequestId('u0:ho'))
  })

  it('空键每次新值', async () => {
    expect(await turnRequestId('')).not.toBe(await turnRequestId(''))
  })

  it('纯派生：不依赖会话级缓存（同一键在清缓存后仍同值）', async () => {
    const before = await turnRequestId('u0:stable')
    __resetSessionIdsForTests()
    expect(await turnRequestId('u0:stable')).toBe(before)
  })

  it('惰性盐重置后生成不同派生 ID（隔离校验）', async () => {
    const before = await turnRequestId('u0:salt-test')
    __resetTurnSaltForTests()
    const after = await turnRequestId('u0:salt-test')
    // 盐重置后重新惰性生成新盐，哈希不同
    expect(after).not.toBe(before)
    expect(after).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('buildChatMeta（conversationRequestId 三级回退）', () => {
  beforeEach(() => { __resetSessionIdsForTests() })

  it('① 入站 X-Conversation-Request-ID 头透传优先', async () => {
    const meta = await buildChatMeta({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      sessionKey: 'sess-1',
      inboundConversationRequestId: 'inbound-abc',
    })
    expect(meta.conversationRequestId).toBe('inbound-abc')
  })

  it('② 无入站头但会话键非空 → 会话级稳定值', async () => {
    const m1 = await buildChatMeta({ body: { messages: [] }, sessionKey: 'sess-1' })
    const m2 = await buildChatMeta({ body: { messages: [] }, sessionKey: 'sess-1' })
    expect(m1.conversationRequestId).toBe(m2.conversationRequestId)
    expect(m1.conversationRequestId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('③ 无会话键 → 轮级派生（同轮恒定）', async () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    const m1 = await buildChatMeta({ body })
    const m2 = await buildChatMeta({ body })
    expect(m1.conversationRequestId).toBe(m2.conversationRequestId)
  })

  it('③ 无会话键且无 user 消息 → 请求级随机（每次不同）', async () => {
    const m1 = await buildChatMeta({ body: { messages: [{ role: 'assistant', content: 'a' }] } })
    const m2 = await buildChatMeta({ body: { messages: [{ role: 'assistant', content: 'a' }] } })
    expect(m1.conversationRequestId).not.toBe(m2.conversationRequestId)
  })

  it('conversationId 与 traceId 透传', async () => {
    const meta = await buildChatMeta({
      body: { conversationId: 'conv-1', messages: [] },
      inboundTraceId: 'trace-xyz',
    })
    expect(meta.conversationId).toBe('conv-1')
    expect(meta.traceId).toBe('trace-xyz')
  })
})

describe('injectConversationHeaders（9 个头）', () => {
  it('注入完整头族', () => {
    const headers: Record<string, string> = {}
    injectConversationHeaders(headers, {
      conversationId: 'conv-1',
      conversationRequestId: 'a'.repeat(32),
      traceId: 'trace-1',
    })

    expect(headers['X-Conversation-ID']).toBe('conv-1')
    expect(headers['X-Conversation-Request-ID']).toBe('a'.repeat(32))
    expect(headers['X-Conversation-Message-ID']).toMatch(/^[0-9a-f]{32}$/)
    // X-Request-ID 与 message id 同值
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
    expect(headers['X-Root-Request-ID']).toBe('a'.repeat(32))
    expect(headers['X-Trace-ID']).toBe('trace-1')
    expect(headers['X-B3-TraceId']).toBe('a'.repeat(32))
    expect(headers['X-B3-SpanId']).toBe(headers['X-Conversation-Message-ID'].slice(0, 16))
    expect(headers['X-B3-Sampled']).toBe('1')
  })

  it('conversationId 为空 → 不发 X-Conversation-ID（透传优先，不伪造）', () => {
    const headers: Record<string, string> = {}
    injectConversationHeaders(headers, { conversationId: '', conversationRequestId: 'b'.repeat(32) })
    expect(headers['X-Conversation-ID']).toBeUndefined()
  })

  it('conversationRequestId 为空 → 本级补 32 hex（聚合主键必发）', () => {
    const headers: Record<string, string> = {}
    injectConversationHeaders(headers, { conversationId: '', conversationRequestId: '' })
    expect(headers['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('traceId 为空 → X-Trace-ID 回落 conversationRequestId', () => {
    const headers: Record<string, string> = {}
    injectConversationHeaders(headers, { conversationId: '', conversationRequestId: 'c'.repeat(32) })
    expect(headers['X-Trace-ID']).toBe('c'.repeat(32))
  })

  it('非法 B3 TraceId（如带横线 UUID）→ X-B3-TraceId 回落 messageId', () => {
    const headers: Record<string, string> = {}
    const badConvReq = '550e8400-e29b-41d4-a716-446655440000'
    injectConversationHeaders(headers, { conversationId: '', conversationRequestId: badConvReq })
    // 聚合主键仍用原值（不是 B3 头，不受 B3 规范约束）
    expect(headers['X-Conversation-Request-ID']).toBe(badConvReq)
    // B3 TraceId 必须是合法 hex → 回落 messageId
    expect(headers['X-B3-TraceId']).toBe(headers['X-Conversation-Message-ID'])
    expect(isValidB3TraceId(headers['X-B3-TraceId'])).toBe(true)
  })

  it('messageId 每次调用新生成（消息级独立），conversationRequestId 恒定', () => {
    const h1: Record<string, string> = {}
    const h2: Record<string, string> = {}
    const meta = { conversationId: '', conversationRequestId: 'd'.repeat(32) }
    injectConversationHeaders(h1, meta)
    injectConversationHeaders(h2, meta)
    // 聚合主键跨调用恒定（换号/重试复用）
    expect(h1['X-Conversation-Request-ID']).toBe(h2['X-Conversation-Request-ID'])
    expect(h1['X-Root-Request-ID']).toBe(h2['X-Root-Request-ID'])
    // 消息级 ID 每次不同
    expect(h1['X-Conversation-Message-ID']).not.toBe(h2['X-Conversation-Message-ID'])
    expect(h1['X-Request-ID']).not.toBe(h2['X-Request-ID'])
    expect(h1['X-B3-SpanId']).not.toBe(h2['X-B3-SpanId'])
  })
})
