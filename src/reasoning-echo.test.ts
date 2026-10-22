/**
 * reasoning-echo.test.ts — agentrouter 思考模式的 thinking 回传补齐。
 *
 * 回归对象：2026-10-22 实测会话里 assistant 的思考回传缺失/为空，下一次请求被上游整轮拒：
 *
 *   The `content[].thinking` in the thinking mode must be passed back to the API.
 *
 * 两次线上实证决定了最终形状：
 * 1. 缺字段 → 400（`66a6fe8` 之前）；
 * 2. 补空串 `""` → 仍 400（`66a6fe8` 线上版，因为客户端 compat 本来就补空串）。
 * 所以本层补**非空占位串**，且只对 agentrouter 的 deepseek 模型生效——其他上游的请求体
 * 必须逐字节不变。
 */

import { describe, it, expect } from 'vitest'
import { ensureAssistantReasoningEcho, needsReasoningEcho } from './reasoning-echo'

const PLACEHOLDER = ' '

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

  it('缺口轮次补非空占位串，其余消息一字不动', () => {
    const body = conversation()
    ensureAssistantReasoningEcho(body)

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[3]['reasoning_content']).toBe(PLACEHOLDER)
    expect(messages[1]['reasoning_content']).toBe('想一下 A')
    expect(messages[5]['reasoning_content']).toBe('想一下 C')
    // 非 assistant 消息不新增字段
    for (const index of [0, 2, 4]) {
      expect('reasoning_content' in messages[index]).toBe(false)
    }
    expect(messages[0]['content']).toBe('看看仓库')
  })

  it('空串/纯空白的 reasoning_content 升级为非空占位串，正文保留', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'x', reasoning_content: '原文' },
        { role: 'assistant', content: 'y', reasoning_content: '' },
        { role: 'assistant', content: 'z', reasoning_content: '   ' },
      ],
    }
    ensureAssistantReasoningEcho(body)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]['reasoning_content']).toBe('原文')
    expect(messages[1]['reasoning_content']).toBe(PLACEHOLDER)
    expect(messages[2]['reasoning_content']).toBe(PLACEHOLDER)
  })

  it('OpenAI 兼容客户端的思考形态（字段在、内容空串）：整体升级为占位串', () => {
    // pi-ai 的 requiresReasoningContentOnAssistantMessages 补的就是空串——
    // 只看「非空痕迹」的门控会在这里整层失效（第一版线上没生效的原因）。
    const body = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a1', reasoning_content: '' },
        { role: 'tool', tool_call_id: 't', content: 'r' },
        { role: 'assistant', content: null, reasoning_content: '', tool_calls: [{ id: 't2' }] },
      ],
    }
    ensureAssistantReasoningEcho(body)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[1]['reasoning_content']).toBe(PLACEHOLDER)
    expect(messages[3]['reasoning_content']).toBe(PLACEHOLDER)
    expect('reasoning_content' in messages[0]).toBe(false)
    expect('reasoning_content' in messages[2]).toBe(false)
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
    expect(messages[1]['reasoning_content']).toBe(PLACEHOLDER)
  })

  it('纯非思考会话（无 reasoning 字段且未显式启用）：逐字节不变', () => {
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
    expect((body.messages as Array<Record<string, unknown>>)[0]['reasoning_content']).toBe(PLACEHOLDER)
  })

  it('幂等：重复调用结果一致', () => {
    const body = conversation()
    ensureAssistantReasoningEcho(body)
    const once = JSON.stringify(body)
    ensureAssistantReasoningEcho(body)
    expect(JSON.stringify(body)).toBe(once)
  })

  it('畸形输入不抛错', () => {
    for (const body of [{}, { messages: null }, { messages: 'x' }, { messages: [null, 1, 'a'] }]) {
      expect(() => ensureAssistantReasoningEcho(body as Record<string, unknown>)).not.toThrow()
    }
    expect(() => ensureAssistantReasoningEcho({ messages: [], thinking: 'enabled' })).not.toThrow()
  })
})
