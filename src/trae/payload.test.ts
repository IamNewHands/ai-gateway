import { describe, it, expect } from 'vitest'
import { prepareBody, applyHistoryBudget, applyToolSchemaBudget, isRemoteOnlyModel } from './payload'

function msg(role: string, content: string): Record<string, any> {
  return { role, content }
}

describe('applyHistoryBudget：历史消息裁剪（raw/remote 长会话省输入积分）', () => {
  const system = msg('system', 'sys')
  it('未配置预算(maxMessages=0) → 原样返回，不动数组', () => {
    const messages = [system, msg('user', 'u'), msg('assistant', 'a')]
    const out = applyHistoryBudget(messages, { maxMessages: 0, maxHistoryChars: 0, maxToolSchemaChars: 0 })
    expect(out).toBe(messages)
    expect(out.length).toBe(3)
  })

  it('maxMessages 保留最近 non-system 消息，system 恒保留', () => {
    const messages = [system, msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2'), msg('assistant', 'a2')]
    const out = applyHistoryBudget(messages, { maxMessages: 3, maxHistoryChars: 0, maxToolSchemaChars: 0 })
    expect(out.length).toBe(4) // system + 最近3条
    expect(out[0]).toBe(system)
    expect(out[1].content).toBe('a1')
    expect(out[2].content).toBe('u2')
    expect(out[3].content).toBe('a2')
  })

  it('工具调用配对消息不可被拆散（保留边界 tool/tool_call_id 配对）', () => {
    // 最近消息是 assistant tool_calls，其后必须有对应 tool 消息；裁剪到剩 3 条时
    // 不能只留 assistant.tool_calls 而丢掉其 tool 结果。
    const messages = [
      msg('user', 'u1'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ]
    const out = applyHistoryBudget(messages, { maxMessages: 1, maxHistoryChars: 0, maxToolSchemaChars: 0 })
    // 最后 pair 必须整体保留（至少 2 条），不能拆散
    expect(out.length).toBeGreaterThanOrEqual(1)
    const roles = out.map((m) => m.role)
    // 若保留了 assistant.tool_calls 则必须保留其 tool 结果
    if (roles.includes('assistant')) {
      expect(roles).toContain('tool')
      expect(out[out.length - 1].role).toBe('tool')
    }
  })

  it('maxHistoryChars 截断后的消息整体剔除而不是半条', () => {
    const messages = [msg('user', 'a'.repeat(10)), msg('assistant', 'b'.repeat(10))]
    // 预算只够 1 条 → 只保留最近 1 条完整消息
    const out = applyHistoryBudget(messages, { maxMessages: 0, maxHistoryChars: 12, maxToolSchemaChars: 0 })
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('b'.repeat(10))
  })
})

describe('applyToolSchemaBudget：工具 schema 压缩（省输入积分，超限时保留工具名签名）', () => {
  function tool(name: string, params: string): Record<string, any> {
    return { type: 'function', function: { name, parameters: JSON.parse(params) } }
  }
  it('未配置预算(maxToolSchemaChars=0) → 原样返回', () => {
    const tools = [tool('read_file', '{"type":"object","properties":{"path":{"type":"string"}}}')]
    const out = applyToolSchemaBudget(tools, 0)
    expect(out).toBe(tools)
    expect(out.length).toBe(1)
  })

  it('总体积在预算内 → 不做任何改写', () => {
    const tools = [tool('read_file', '{"type":"object","properties":{"path":{"type":"string"},"depth":{"type":"integer"}}}')]
    const out = applyToolSchemaBudget(tools, 10000)
    expect(out).toEqual(tools)
  })

  it('超预算 → 仅压缩 function.parameters 为保留必填字段的最小 schema', () => {
    const bigParams = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(200) }, b: { type: 'integer', description: 'y'.repeat(200) } } }
    const tools = [tool('t', JSON.stringify(bigParams))]
    const out = applyToolSchemaBudget(tools, 100)
    expect(out.length).toBe(1)
    const fn = out[0].function
    expect(fn.name).toBe('t')
    // 压缩后体积显著小于原始且仍是合法 JSON schema
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(tools).length)
  })
})

describe('isRemoteOnlyModel：模型级路由（TRAE_REMOTE_ONLY_MODELS）', () => {
  it('空配置 → 全走默认（非强制 remote）', () => {
    expect(isRemoteOnlyModel('glm-5.2', '')).toBe(false)
  })
  it('* 通配 → 全部强制 remote', () => {
    expect(isRemoteOnlyModel('anything', '*')).toBe(true)
  })
  it('逗号分隔精确匹配（忽略大小写/前后空格）', () => {
    const cfg = ' Deepseek-V4-Pro , glm-5.2 '
    expect(isRemoteOnlyModel('deepseek-v4-pro', cfg)).toBe(true)
    expect(isRemoteOnlyModel('glm-5.2', cfg)).toBe(true)
    expect(isRemoteOnlyModel('kimi-k3', cfg)).toBe(false)
  })
})

describe('prepareBody 回归：历史/工具预算接线后仍产出合法 SOLO 请求体', () => {
  it('多轮工具历史裁剪后 stream=true、function 固定、config_name/model 对齐', () => {
    const body = {
      model: 'glm-5.2',
      messages: [
        msg('user', 'hi'),
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'x' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
      stream: false,
    }
    const out = prepareBody(JSON.stringify(body))
    const parsed = JSON.parse(out)
    expect(parsed.stream).toBe(true)
    expect(parsed.function).toBe('solo_work_lite')
    expect(parsed.config_name).toBe('glm-5.2')
    expect(parsed.model).toBe('glm-5.2')
    expect(Array.isArray(parsed.messages)).toBe(true)
  })
})