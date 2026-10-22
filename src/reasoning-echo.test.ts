/**
 * reasoning-echo.test.ts — agentrouter 思考模式的 thinking 回传补齐。
 *
 * 回归对象：2026-10-22 实测会话里 30 条 assistant 有 29 条带思考，唯独中间一条模型没吐
 * 思考文本，下一次请求被上游整轮拒：
 *
 *   The `content[].thinking` in the thinking mode must be passed back to the API.
 *
 * 修法：对该上游的 assistant 消息缺 `reasoning_content` 时补空串，且**只**对 agentrouter
 * 的 deepseek 模型生效——其他上游的请求体必须逐字节不变。
 */

import { describe, it, expect } from 'vitest'
import { ensureAssistantReasoningEcho, needsReasoningEcho } from './reasoning-echo'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('needsReasoningEcho', () => {
  it('agentrouter 的 deepseek 模型才生效', () => {
    expect(needsReasoningEcho({ id: 'agentrouter' }, 'deepseek-v4-flash')).toBe(true)
    expect(needsReasoningEcho({ id: 'agentrouter' }, 'deepseek-v4.1-flash')).toBe(true)
  })

  it('agentrouter 的非 deepseek 模型不生效', () => {
    expect(needsReasoningEcho({ id: 'agentrouter' }, 'gpt-6-astra')).toBe(false)
    expect(needsReasoningEcho({ id: 'agentrouter' }, 'gpt-6.1-sol')).toBe(false)
  })

  it('按 baseUrl 主机识别 agentrouter（预设重建的提供商 id 可能不同）', () => {
    expect(needsReasoningEcho({ id: 'custom-1', baseUrl: 'https://ps.air-outer.com/v1' }, 'deepseek-v4-flash')).toBe(true)
    expect(needsReasoningEcho({ baseUrl: 'https://ps.air-outer.com' }, 'deepseek-v4-flash')).toBe(true)
  })

  it('主机伪装与其他提供商一律不生效', () => {
    for (const baseUrl of [
      'https://ps.air-outer.com.evil.com/v1',
      'https://evil.com/?u=ps.air-outer.com',
      'https://ps.air-outer.com.cn/v1',
    ]) {
      expect(needsReasoningEcho({ id: 'custom-1', baseUrl }, 'deepseek-v4-flash'), baseUrl).toBe(false)
    }
    expect(needsReasoningEcho({ id: 'ai-gateway', baseUrl: 'https://ai-gateway.example.cc.cd/v1' }, 'deepseek-v4-flash')).toBe(false)
    expect(needsReasoningEcho({}, 'deepseek-v4-flash')).toBe(false)
  })
})

describe('ensureAssistantReasoningEcho', () => {
  // 复刻实测形状：三条 assistant 有思考，中间一条没有（就是它触发了 400）
  const conversation = () => ({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '看看仓库' },
      { role: 'assistant', content: 'A', reasoning_content: '想一下 A', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: 'B', tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: 'ok' },
      { role: 'assistant', content: 'C', reasoning_content: '想一下 C' },
    ],
  })

  it('缺口轮次补空串，其余消息一字不动', () => {
    const body = conversation()
    ensureAssistantReasoningEcho(body)

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[3]['reasoning_content']).toBe('')
    expect(messages[1]['reasoning_content']).toBe('想一下 A')
    expect(messages[5]['reasoning_content']).toBe('想一下 C')
    // 非 assistant 消息不新增字段
    for (const index of [0, 2, 4]) {
      expect('reasoning_content' in messages[index]).toBe(false)
    }
    expect(messages[0]['content']).toBe('看看仓库')
  })

  it('已有 reasoning_content（含空串）原样保留，不覆盖', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'x', reasoning_content: '原文' },
        { role: 'assistant', content: 'y', reasoning_content: '' },
      ],
    }
    ensureAssistantReasoningEcho(body)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]['reasoning_content']).toBe('原文')
    expect(messages[1]['reasoning_content']).toBe('')
  })

  it('只有 reasoning 字段的客户端：用同源文本回填 reasoning_content', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'x', reasoning: '思考正文' },
        { role: 'assistant', content: 'y' },
      ],
    }
    ensureAssistantReasoningEcho(body)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]['reasoning_content']).toBe('思考正文')
    expect(messages[1]['reasoning_content']).toBe('')
  })

  it('纯非思考会话（无痕迹且未显式启用）：逐字节不变', () => {
    const body = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    }
    const before = JSON.stringify(body)
    ensureAssistantReasoningEcho(body)
    expect(JSON.stringify(body)).toBe(before)
  })

  it('显式 thinking.enabled：即使历史没有痕迹也补齐', () => {
    const body = {
      thinking: { type: 'enabled' },
      messages: [{ role: 'assistant', content: 'hello' }],
    }
    ensureAssistantReasoningEcho(body)
    expect((body.messages as Array<Record<string, unknown>>)[0]['reasoning_content']).toBe('')
  })

  it('空白 reasoning 不算痕迹（避免把空白当已回传）', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'x', reasoning_content: '   ' },
        { role: 'assistant', content: 'y' },
      ],
    }
    // 无有效痕迹 → 门控不亮，请求体不变（上游对空白串的行为不在本层推断）
    const before = JSON.stringify(body)
    ensureAssistantReasoningEcho(body)
    expect(JSON.stringify(body)).toBe(before)
  })

  it('畸形输入不抛错', () => {
    for (const body of [{}, { messages: null }, { messages: 'x' }, { messages: [null, 1, 'a'] }]) {
      expect(() => ensureAssistantReasoningEcho(body as Record<string, unknown>)).not.toThrow()
    }
    expect(() => ensureAssistantReasoningEcho({ messages: [], thinking: 'enabled' })).not.toThrow()
    expect(clone({ ok: 1 })).toEqual({ ok: 1 })
  })
})
