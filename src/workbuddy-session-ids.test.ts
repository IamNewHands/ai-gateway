import { describe, it, expect, beforeEach } from 'vitest'
import {
  newMessageId,
  isValidB3TraceId,
  resolveConversationId,
  contentText,
  contentSignature,
  turnKey,
  requestIdForKey,
  turnRequestId,
  buildChatMeta,
  injectConversationHeaders,
  extractSessionKey,
  stickyFallbackKey,
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
    // 移植 ebd7921 后两者口径一致：extractSessionKey 也不再回落 user_id
    expect(resolveConversationId({ metadata: { user_id: 'u1' } })).toBe('')
    expect(extractSessionKey({ metadata: { user_id: 'u1' } })).toBe('')
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

describe('extractSessionKey（只认 conversation 维度，剔除 user_id）', () => {
  it('识别顺序：metadata.conversation_id → conversationId → 顶层', () => {
    expect(extractSessionKey({ metadata: { conversation_id: 'a', conversationId: 'b', user_id: 'c' } })).toBe('a')
    expect(extractSessionKey({ metadata: { conversationId: 'b', user_id: 'c' } })).toBe('b')
    expect(extractSessionKey({ conversation_id: 'd' })).toBe('d')
    expect(extractSessionKey({ conversationId: 'e' })).toBe('e')
  })

  it('移植 ebd7921：metadata.user_id 不再是粘性键（回落空串 → 加权轮换）', () => {
    expect(extractSessionKey({ metadata: { user_id: 'c' } })).toBe('')
    expect(extractSessionKey({ user_id: 'c' })).toBe('')
    // user_id 不再抢占顶层 conversation_id（旧实现会返回 'c'）
    expect(extractSessionKey({ metadata: { user_id: 'c' }, conversation_id: 'd' })).toBe('d')
    expect(extractSessionKey({ metadata: { user_id: 'c' }, conversationId: 'e' })).toBe('e')
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

  it('最后一条 user 无可签名内容（空/null/空 parts）→ 空串，且不继续往前找', () => {
    const body = {
      messages: [
        { role: 'user', content: 'has text' },
        { role: 'user', content: null },
      ],
    }
    expect(turnKey(body)).toBe('')
  })

  // ===== a767465 内容签名：纯图片轮不再碎片化 =====

  it('纯图片末条 user → 非空轮级键，且同 body 恒同键（a767465 G1）', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/cat.png' } }] },
      ],
    }
    const a = turnKey(body)
    const b = turnKey(body)
    expect(a).not.toBe('') // RED：修复前为 '' → 聚合头退化请求级随机
    expect(a).toBe(b)
    expect(a).toMatch(/^u0:\[image_url:[0-9a-f]{8}\]$/)
  })

  it('图文混合键 ≠ 纯文本键 ≠ 纯图键（同图同序号下三形态互异）', () => {
    const mixed = turnKey({ messages: [{ role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] })
    const textOnly = turnKey({ messages: [{ role: 'user', content: '看图' }] })
    const imageOnly = turnKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] })
    expect(textOnly).toBe('u0:看图') // 纯文本路径键值零漂移（向后兼容契约）
    expect(mixed).not.toBe(textOnly)
    expect(mixed).not.toBe(imageOnly)
    expect(mixed).toContain('看图')
    expect(mixed).toContain('[image_url:')
  })

  it('不同图片 → 不同键（摘要区分内容）', () => {
    const a = turnKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] })
    const b = turnKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/dog.png' } },
    ] }] })
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
  })

  it('同图不同序号（跨轮）→ 不同键（序号入键的既有设计不回退）', () => {
    const a = turnKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] })
    const b = turnKey({ messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/cat.png' } }] },
    ] })
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
    expect(b.startsWith('u2:')).toBe(true)
  })

  it('全文本 parts 的签名 == contentText 结果（数组形态零漂移）', () => {
    const parts = [{ type: 'text', text: 'aa' }, { type: 'text', text: 'bb' }]
    expect(contentSignature(parts)).toBe(contentText(parts))
    expect(turnKey({ messages: [{ role: 'user', content: parts }] })).toBe('u0:aabb')
  })

  it('data: 超长 base64 只入短摘要（键长有界）', () => {
    const longUrl = 'data:image/png;base64,' + 'QUFBQQ'.repeat(4096)
    const k = turnKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: longUrl } },
    ] }] })
    expect(k).not.toBe('')
    expect(k.length).toBeLessThan(256) // 摘要化防键膨胀
  })

  it('contentSignature 边界：空/null/空数组/全空文本 part → 空串（不伪造）', () => {
    expect(contentSignature(null)).toBe('')
    expect(contentSignature(undefined)).toBe('')
    expect(contentSignature(123)).toBe('')
    expect(contentSignature([])).toBe('')
    expect(contentSignature([{ type: 'text', text: '' }])).toBe('')
    expect(contentSignature([null])).toBe('')
  })

  it('contentSignature 边界：非文本 part 时整体 trim（对齐源 TrimSpace）', () => {
    const sig = contentSignature([
      { type: 'text', text: '  看图  ' },
      { type: 'image_url', image_url: { url: 'x' } },
    ])
    expect(sig.startsWith(' ')).toBe(false)
    expect(sig.endsWith(' ')).toBe(false)
    expect(sig).toContain('看图')
    expect(sig).toContain('[image_url:')
  })

  it('contentSignature 畸形 part → 空串（对齐源 Unmarshal 失败即返 ""）', () => {
    expect(contentSignature(['plain-string'])).toBe('')
    expect(contentSignature([{ type: 'text', text: 42 }])).toBe('')
    expect(contentSignature([{ type: 7, text: 'x' }])).toBe('')
    expect(contentSignature([[]])).toBe('')
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

describe('buildChatMeta（conversationRequestId 四分支，含 b9ac0d3 统一轮级）', () => {
  beforeEach(() => { __resetSessionIdsForTests() })

  it('① 入站 X-Conversation-Request-ID 头透传优先', async () => {
    const meta = await buildChatMeta({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      sessionKey: 'sess-1',
      inboundConversationRequestId: 'inbound-abc',
    })
    expect(meta.conversationRequestId).toBe('inbound-abc')
  })

  // ===== b9ac0d3 / 源 issue #170：带会话键客户端统一轮级 =====

  it('② 会话键 + 同会话两轮（末条 user 不同）→ 出站 ID 必须不同（轮级，R1 RED）', async () => {
    const a = await buildChatMeta({
      body: { messages: [{ role: 'user', content: '第一问' }] },
      sessionKey: 'conv-t',
    })
    const b = await buildChatMeta({
      body: { messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '答' },
        { role: 'user', content: '第二问' },
      ] },
      sessionKey: 'conv-t',
    })
    expect(a.conversationRequestId).toMatch(/^[0-9a-f]{32}$/)
    expect(b.conversationRequestId).toMatch(/^[0-9a-f]{32}$/)
    expect(a.conversationRequestId).not.toBe(b.conversationRequestId)
  })

  it('② 会话键 + 同会话同轮文本 → 同键（轮内 tool-call 多步共享，R2）', async () => {
    const step1 = await buildChatMeta({
      body: { messages: [{ role: 'user', content: '跑一下' }] },
      sessionKey: 'conv-t',
    })
    const step2 = await buildChatMeta({
      body: { messages: [
        { role: 'user', content: '跑一下' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'pwsh' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '结果' },
      ] },
      sessionKey: 'conv-t',
    })
    expect(step1.conversationRequestId).toBe(step2.conversationRequestId)
  })

  it('② 会话键 + 轮转重试（同 body 重复调用）→ 同键（R3 回归）', async () => {
    const body = { messages: [{ role: 'user', content: '重试场景' }] }
    const a = await buildChatMeta({ body, sessionKey: 'conv-r' })
    const b = await buildChatMeta({ body, sessionKey: 'conv-r' })
    expect(a.conversationRequestId).toBe(b.conversationRequestId)
  })

  it('② 不同会话同轮文本 → 不同键（sessKey 入复合键防撞，R4）', async () => {
    const body = { messages: [{ role: 'user', content: '同样的问题' }] }
    const a = await buildChatMeta({ body, sessionKey: 'conv-a' })
    const b = await buildChatMeta({ body, sessionKey: 'conv-b' })
    expect(a.conversationRequestId).not.toBe(b.conversationRequestId)
  })

  it('② 会话键 + turnKey 空态（无 user 消息）→ 会话级兜底同值（R5）', async () => {
    const a = await buildChatMeta({
      body: { messages: [{ role: 'assistant', content: '续' }] },
      sessionKey: 'conv-e',
    })
    const b = await buildChatMeta({
      body: { messages: [{ role: 'assistant', content: '又续' }] },
      sessionKey: 'conv-e',
    })
    expect(a.conversationRequestId).toBe(b.conversationRequestId)
    expect(a.conversationRequestId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('③ 无会话键 → 轮级派生（同轮恒定，R6 回归）', async () => {
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

  it('③ 无会话键 + 纯图片轮 → 轮级键非空且同轮恒定（a767465 × b9ac0d3 交汇）', async () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] }
    const a = await buildChatMeta({ body })
    const b = await buildChatMeta({ body })
    expect(a.conversationRequestId).toBe(b.conversationRequestId)
  })

  it('会话键 + 纯图片轮 → 同轮同键、跨轮换键（两修复叠加）', async () => {
    const first = await buildChatMeta({
      body: { messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
      ] }] },
      sessionKey: 'conv-img',
    })
    const sameTurn = await buildChatMeta({
      body: { messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
      ] }] },
      sessionKey: 'conv-img',
    })
    const nextTurn = await buildChatMeta({
      body: { messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/cat.png' } }] },
        { role: 'assistant', content: '答' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/dog.png' } }] },
      ] },
      sessionKey: 'conv-img',
    })
    expect(first.conversationRequestId).toBe(sameTurn.conversationRequestId)
    expect(first.conversationRequestId).not.toBe(nextTurn.conversationRequestId)
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

describe('extractSessionKey 第 5 源 prompt_cache_key（移植 8058019）', () => {
  it('conversation 维度四键优先于 prompt_cache_key', () => {
    expect(extractSessionKey({ conversation_id: 'conv', prompt_cache_key: 'pck' })).toBe('conv')
    expect(extractSessionKey({ conversationId: 'conv', prompt_cache_key: 'pck' })).toBe('conv')
    expect(extractSessionKey({ metadata: { conversationId: 'meta' }, prompt_cache_key: 'pck' })).toBe('meta')
  })

  it('无 conversation 键时回落 prompt_cache_key；无则空串', () => {
    expect(extractSessionKey({ prompt_cache_key: 'pck-123' })).toBe('pck-123')
    expect(extractSessionKey({ prompt_cache_key: '' })).toBe('')
    expect(extractSessionKey({ prompt_cache_key: 42 })).toBe('')
  })
})

describe('stickyFallbackKey（移植 8058019 + 10eefa8）', () => {
  it('同首条 user 消息恒同键，追加历史不影响（会话级键）', async () => {
    const b1 = { messages: [{ role: 'user', content: 'hello session' }, { role: 'assistant', content: 'hi' }] }
    const b2 = {
      messages: [
        { role: 'user', content: 'hello session' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'second turn' },
      ],
    }
    const k1 = await stickyFallbackKey(b1)
    const k2 = await stickyFallbackKey(b2)
    expect(k1).toMatch(/^fb:[0-9a-f]{32}$/)
    expect(k2).toBe(k1)
  })

  it('首条 user 文本相同 → 同键；不同 → 换键（开新会话自然换键）', async () => {
    const a = { messages: [{ role: 'user', content: 'same first' }] }
    const b = { messages: [{ role: 'user', content: 'same first' }, { role: 'assistant', content: 'x' }] }
    const c = { messages: [{ role: 'user', content: 'different first' }] }
    const [ka, kb, kc] = await Promise.all([stickyFallbackKey(a), stickyFallbackKey(b), stickyFallbackKey(c)])
    expect(ka).toMatch(/^fb:[0-9a-f]{32}$/)
    expect(kb).toBe(ka)
    expect(kc).not.toBe(ka)
  })

  it('空白归一：首尾空白去重后同键（对齐 Go TrimSpace）', async () => {
    const a = { messages: [{ role: 'user', content: 'hello' }] }
    const b = { messages: [{ role: 'user', content: '  hello  ' }] }
    const [ka, kb] = await Promise.all([stickyFallbackKey(a), stickyFallbackKey(b)])
    expect(kb).toBe(ka)
  })

  it('多模态 part 拼接文本参与派生', async () => {
    const a = { messages: [{ role: 'user', content: [{ type: 'text', text: 'multi ' }, { type: 'text', text: 'modal' }] }] }
    const k = await stickyFallbackKey(a)
    expect(k).toMatch(/^fb:[0-9a-f]{32}$/)
  })

  it('user_id 抑制（10eefa8）：metadata.user_id / 顶层 user_id 恒返回空串', async () => {
    expect(await stickyFallbackKey({ metadata: { user_id: 'u1' }, messages: [{ role: 'user', content: 'x' }] })).toBe('')
    expect(await stickyFallbackKey({ user_id: 'u1', messages: [{ role: 'user', content: 'x' }] })).toBe('')
  })

  it('user_id 非字符串/空串不抑制', async () => {
    const k1 = await stickyFallbackKey({ metadata: { user_id: '' }, messages: [{ role: 'user', content: 'x' }] })
    const k2 = await stickyFallbackKey({ user_id: 42, messages: [{ role: 'user', content: 'x' }] })
    expect(k1).toMatch(/^fb:[0-9a-f]{32}$/)
    expect(k2).toMatch(/^fb:[0-9a-f]{32}$/)
  })

  it('无 user 消息 / 首条 user 无可签名内容 / 空态 → 空串', async () => {
    expect(await stickyFallbackKey(null)).toBe('')
    expect(await stickyFallbackKey({})).toBe('')
    expect(await stickyFallbackKey({ messages: [{ role: 'assistant', content: 'a' }] })).toBe('')
    expect(await stickyFallbackKey({ messages: [{ role: 'user', content: null }] })).toBe('')
    expect(await stickyFallbackKey({ messages: [{ role: 'user', content: [] }] })).toBe('')
  })

  // ===== a767465：首图会话的粘性盲区修复 =====

  it('首条 user 纯图片 → 派生非空粘性键，且同 body 恒同键（a767465 G1）', async () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] }
    const a = await stickyFallbackKey(body)
    const b = await stickyFallbackKey(body)
    expect(a).toMatch(/^fb:[0-9a-f]{32}$/) // RED：修复前为 '' → 逐请求换号
    expect(b).toBe(a)
  })

  it('首图会话推进（历史追加）不换键（#169 契约对图片形态同样成立）', async () => {
    const first = { messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] }
    const longer = { messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/cat.png' } }] },
      { role: 'assistant', content: '答' },
      { role: 'user', content: '继续' },
    ] }
    expect(await stickyFallbackKey(longer)).toBe(await stickyFallbackKey(first))
  })

  it('纯文本粘性键零漂移：签名化后仍与旧 contentText 口径同键（#169 回归）', async () => {
    const a = { messages: [{ role: 'user', content: '开场白' }] }
    const longer = { messages: [
      { role: 'user', content: '开场白' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ] }
    const [ka, kb] = await Promise.all([stickyFallbackKey(a), stickyFallbackKey(longer)])
    expect(ka).toMatch(/^fb:[0-9a-f]{32}$/)
    expect(kb).toBe(ka)
  })

  it('不同图片 → 不同粘性键', async () => {
    const a = await stickyFallbackKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
    ] }] })
    const b = await stickyFallbackKey({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://img.example/dog.png' } },
    ] }] })
    expect(a).not.toBe(b)
  })

  it('extractSessionKey 命中时不经 fallback 也不会冲突：两键空间独立', async () => {
    const body = { conversation_id: 'c1', messages: [{ role: 'user', content: 'x' }] }
    expect(extractSessionKey(body)).toBe('c1')
    expect(await stickyFallbackKey(body)).toMatch(/^fb:/)
  })
})
