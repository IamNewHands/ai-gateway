/**
 * M365-2api（Folozz）吸收移植回归（2026-09-07）：
 * P1  CoT 消息不进入正文快照（isChainOfThoughtMessage，移植 C chathub.ts:1759-1762）
 * P2a <thought>/<thinking> 标签剥离兜底（extractThoughtTags，移植 C chathub.ts:1896-1901）
 * P3  extractRemainingAllowance 配额余量提取（移植 C chathub.ts:296-328）
 * P3  normalizeModelName 模型名归一化（移植 C canonicalModel 容错子集）
 * P2c session-candidates：normalizeInstructionText / rootConversationFingerprint /
 *      stableSessionCandidateBody / sessionCandidateFromRequest（移植 C session-resolver.ts）
 * P3  events.ts 微软系域名图片 URL 判定（移植 C multimodal.ts）
 */
import { describe, expect, it } from 'vitest'
import { extractThoughtTags, isChainOfThoughtMessage, extractRemainingAllowance } from './chathub'
import { normalizeModelName } from './proxy'
import {
  normalizeInstructionText,
  rootConversationFingerprint,
  stableSessionCandidateBody,
  sessionCandidateFromRequest,
} from './session-candidates'
import { imageURLs } from './events'

describe('P1: isChainOfThoughtMessage（移植 C chathub.ts:1759-1762）', () => {
  it('识别 addToChainOfThought 与 ChainOfThoughtSummary 标记的推理消息', () => {
    expect(isChainOfThoughtMessage({ author: 'bot', messageType: '', text: 'step 1', addToChainOfThought: true })).toBe(true)
    expect(isChainOfThoughtMessage({ author: 'bot', messageType: '', contentOrigin: 'ChainOfThoughtSummary', text: 'sum' })).toBe(true)
    expect(isChainOfThoughtMessage({ author: 'bot', messageType: '', text: 'normal answer' })).toBe(false)
    expect(isChainOfThoughtMessage({ author: 'bot', messageType: 'Chat', text: 'x' })).toBe(false)
  })
})

describe('P2a: extractThoughtTags（移植 C chathub.ts:1896-1901）', () => {
  it('剥离 <thought> 标签并归入 reasoning', () => {
    const r = extractThoughtTags('<thought>我正在核对工具结果</thought>答案是 42。')
    expect(r.reasoning).toBe('我正在核对工具结果')
    expect(r.text).toBe('答案是 42。')
  })
  it('剥离 <thinking> 标签（大小写不敏感）', () => {
    const r = extractThoughtTags('Before <thinking>step</thinking> after')
    expect(r.reasoning).toBe('step')
    // 仅两端 trim（同 C 语义），标签处若原本带空格会留下双空格，故按空白折叠断言
    expect(r.text.replace(/\s+/g, ' ').trim()).toBe('Before after')
    expect(r.text).not.toContain('<thinking>')
  })
  it('无标签或空 reasoning 时原样返回', () => {
    expect(extractThoughtTags('plain text')).toEqual({ text: 'plain text', reasoning: '' })
    expect(extractThoughtTags('<thought>  </thought>body')).toEqual({ text: '<thought>  </thought>body', reasoning: '' })
  })
})

describe('P3: extractRemainingAllowance（移植 C chathub.ts:296-328）', () => {
  it('顶层数值直接收录', () => {
    expect(extractRemainingAllowance({ remainingAllowance: 12 })).toEqual({ remainingAllowance: 12 })
  })
  it('嵌套对象取 remainingAllowance/remaining/balance', () => {
    const r = extractRemainingAllowance({
      metering: { designer: { remainingAllowance: 3 } },
      quotas: { imageGen: { remaining: 5 }, chat: { balance: 9 } },
    })
    expect(r?.['designer']).toBe(3)
    expect(r?.['imageGen']).toBe(5)
    expect(r?.['chat']).toBe(9)
  })
  it('无可提取余量时返回 null', () => {
    expect(extractRemainingAllowance(null)).toBeNull()
    expect(extractRemainingAllowance({})).toBeNull()
    expect(extractRemainingAllowance('x')).toBeNull()
    expect(extractRemainingAllowance({ foo: 'bar', metering: {} })).toBeNull()
  })
})

describe('P3: normalizeModelName（移植 C canonicalModel 容错子集）', () => {
  it('剥离 [1M]/(200k) 括号后缀与空白', () => {
    expect(normalizeModelName('claude-3-7-sonnet-20250219 [1M]')).toBe('claude-3-7-sonnet-20250219')
    expect(normalizeModelName('gpt-4o (200k)')).toBe('gpt-4o')
    expect(normalizeModelName('gpt-5.2 [200K]')).toBe('gpt-5.2')
  })
  it('无后缀模型名保持不变', () => {
    expect(normalizeModelName('claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet-20250219')
    expect(normalizeModelName('')).toBe('')
  })
})

describe('P2c: session-candidates（移植 C session-resolver.ts）', () => {
  describe('normalizeInstructionText', () => {
    it('剥离 IDE 注入的动态日期时间', () => {
      const a = normalizeInstructionText('You are a helper. Current date: 2026-09-07. Be concise.')
      const b = normalizeInstructionText('You are a helper. Current date: 2026-09-08. Be concise.')
      expect(a).toBe(b)
    })
    it('保留确定性指令', () => {
      expect(normalizeInstructionText('Always cite sources.')).toBe('Always cite sources.')
    })
  })

  describe('rootConversationFingerprint', () => {
    it('system+首条 user 跨轮稳定（含动态日期噪声剥离）', () => {
      const mk = (sys: string) => ([
        { role: 'system', content: sys },
        { role: 'user', content: '帮我写测试' },
        { role: 'assistant', content: '好的' },
      ])
      const fp1 = rootConversationFingerprint(mk('You are a coder. Today\'s date is 2026-09-07.'))
      const fp2 = rootConversationFingerprint(mk('You are a coder. Today\'s date is 2026-09-08.'))
      expect(fp1).toBe(fp2)
    })
    it('不同首条 user 得到不同指纹', () => {
      const mk = (u: string) => ([{ role: 'system', content: 'sys' }, { role: 'user', content: u }])
      expect(rootConversationFingerprint(mk('A'))).not.toBe(rootConversationFingerprint(mk('B')))
    })
  })

  describe('stableSessionCandidateBody 候选链顺序', () => {
    it('m365_session_id 优先于其他 body 字段', () => {
      const id = stableSessionCandidateBody({ m365_session_id: 'a', session_key: 'b' })
      expect(id).toBe('a')
    })
    it('取 metadata 内会话字段', () => {
      expect(stableSessionCandidateBody({ metadata: { thread_id: 't1' } })).toBe('t1')
    })
    it('无显式字段时回退根指纹，并可用 user 前缀隔离', () => {
      const id = stableSessionCandidateBody({ user: 'u1', messages: [{ role: 'user', content: 'hello' }] })
      expect(id).toContain('u1::')
      expect(id).toContain('user:hello')
    })
  })

  describe('sessionCandidateFromRequest', () => {
    it('命中常见 header 与 query', () => {
      const req = new Request('https://x/chat/completions?conversation_id=cid', { headers: { 'X-Conversation-Id': 'hdr' } })
      // header 优先于 query
      expect(sessionCandidateFromRequest(req)).toBe('hdr')
      const req2 = new Request('https://x/chat?session_id=q1')
      expect(sessionCandidateFromRequest(req2)).toBe('q1')
      const req3 = new Request('https://x/chat')
      expect(sessionCandidateFromRequest(req3)).toBe('')
    })
  })
})

describe('P3: events.ts 微软系域名图片 URL 判定（移植 C multimodal.ts）', () => {
  it('识别 Windows/Bing 生成的、扩展名在 query 的图片 URL', () => {
    const urls = imageURLs([{ messages: [{ text: '', contentType: 'SearchResults', contentOrigin: '' }], contentUrl: 'https://www.bing.com/images/create?view=detailv2&id=abc&pid=imgpg&FORM=GCRIMPS' }])
    expect(urls.length).toBeGreaterThan(0)
  })
  it('识别 sharepoint/windows.net 下含 /th 的图片 URL', () => {
    const urls = imageURLs([{ thumbnailUrl: 'https://my.sharepoint.com/personal/x/_layouts/15/Thumbnail?docId=1' }])
    expect(urls.length).toBeGreaterThan(0)
  })
  it('不误收非图片外部 URL', () => {
    const urls = imageURLs([{ url: 'https://example.com/page?foo=1' }])
    expect(urls).toEqual([])
  })
})
