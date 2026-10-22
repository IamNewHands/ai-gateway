/**
 * tool-schema.test.ts — 出站工具 schema 的 `required` 归一。
 *
 * 回归对象：agentrouter `/v1/chat/completions` 对缺省 `required` 的工具 schema 回
 * `Invalid schema for function 'adhd_off': null is not of type "array"`（2026-10-22 实测，
 * 经本网关的 ai-gateway 路由转发）。`required` 本身在 JSON Schema 里可选，所以修法只能是
 * 出站前统一补 `required: []`，而不是让每个客户端各自补。
 */

import { describe, it, expect } from 'vitest'
import { ensureRequiredArrays, normalizeToolSchemas } from './tool-schema'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('normalizeToolSchemas', () => {
  it('无参数工具补 required: []（DSH 实际发出的形状）', () => {
    const body: Record<string, unknown> = {
      tools: [{ type: 'function', function: { name: 'adhd_off', parameters: { type: 'object', properties: {} } } }],
    }
    normalizeToolSchemas(body)
    expect(body).toEqual({
      tools: [
        { type: 'function', function: { name: 'adhd_off', parameters: { type: 'object', properties: {}, required: [] } } },
      ],
    })
  })

  it('required: null / 非字符串数组一律改写为 []', () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {}, required: null } } },
        { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {}, required: 'x' } } },
        { type: 'function', function: { name: 'c', parameters: { type: 'object', properties: {}, required: [1] } } },
      ],
    }
    normalizeToolSchemas(body)
    const tools = body['tools'] as Array<{ function: { parameters: { required: unknown } } }>
    for (const tool of tools) expect(tool.function.parameters.required).toEqual([])
  })

  it('已有合法 required 原样保留（不重排、不增删）', () => {
    const parameters = {
      type: 'object',
      properties: { text: { type: 'string' }, path: { type: 'string' } },
      required: ['text'],
    }
    const body: Record<string, unknown> = { tools: [{ type: 'function', function: { name: 'notify', parameters: clone(parameters) } }] }
    normalizeToolSchemas(body)
    const fn = (body['tools'] as any)[0].function
    expect(fn.parameters).toEqual(parameters)
  })

  it('嵌套 object 属性、数组 items、anyOf 分支都会递归补齐', () => {
    const body: Record<string, unknown> = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'nested',
            parameters: {
              type: 'object',
              properties: {
                region: { type: 'object', properties: { left: { type: 'number' } }, required: ['left'] },
                rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
                choice: { anyOf: [{ type: 'object', properties: {} }, { type: 'string' }] },
              },
            },
          },
        },
      ],
    }
    normalizeToolSchemas(body)
    const params = (body['tools'] as any)[0].function.parameters
    expect(params.required).toEqual([])
    expect(params.properties.region.required).toEqual(['left'])
    expect(params.properties.rows.items.required).toEqual([])
    expect(params.properties.choice.anyOf[0].required).toEqual([])
    expect(params.properties.choice.anyOf[1]).toEqual({ type: 'string' })
  })

  it('非 object 根不加 required（数组/标量根没有该语义）', () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: 'function', function: { name: 'str', parameters: { type: 'string' } } },
        { type: 'function', function: { name: 'arr', parameters: { type: 'array', items: { type: 'string' } } } },
      ],
    }
    normalizeToolSchemas(body)
    const tools = body['tools'] as any[]
    expect(tools[0].function.parameters).toEqual({ type: 'string' })
    expect(tools[1].function.parameters).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('Responses 形状（name 与 parameters 在顶层）同样处理', () => {
    const body: Record<string, unknown> = {
      tools: [{ type: 'function', name: 'toggle', parameters: { type: 'object', properties: {} } }],
    }
    normalizeToolSchemas(body)
    expect((body['tools'] as any)[0].parameters.required).toEqual([])
  })

  it('旧版 functions[] 形状同样处理', () => {
    const body: Record<string, unknown> = { functions: [{ name: 'old', parameters: { type: 'object', properties: {} } }] }
    normalizeToolSchemas(body)
    expect((body['functions'] as any)[0].parameters.required).toEqual([])
  })

  it('缺 parameters 时补一个空对象 schema', () => {
    const body: Record<string, unknown> = { tools: [{ type: 'function', function: { name: 'bare' } }] }
    normalizeToolSchemas(body)
    expect((body['tools'] as any)[0].function.parameters).toEqual({ type: 'object', properties: {}, required: [] })
  })

  it('不带工具的请求逐字节不变（不新增字段）', () => {
    for (const body of [{ model: 'agentrouter/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }, { prompt: 'x', n: 1 }]) {
      const before = JSON.stringify(body)
      normalizeToolSchemas(body as Record<string, unknown>)
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  it('幂等：重复调用结果一致', () => {
    const body: Record<string, unknown> = {
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: { b: { type: 'object', properties: {} } } } } }],
    }
    normalizeToolSchemas(body)
    const once = JSON.stringify(body)
    normalizeToolSchemas(body)
    expect(JSON.stringify(body)).toBe(once)
  })

  it('畸形输入不抛错（null / 标量 / 深层嵌套）', () => {
    expect(() => normalizeToolSchemas({ tools: [null, 1, 'x', { type: 'function' }] })).not.toThrow()
    expect(() => normalizeToolSchemas({ tools: 'not-an-array' })).not.toThrow()

    let deep: Record<string, unknown> = { type: 'object', properties: {} }
    for (let i = 0; i < 200; i++) deep = { type: 'object', properties: { child: deep } }
    expect(() => ensureRequiredArrays(deep)).not.toThrow()
  })
})
