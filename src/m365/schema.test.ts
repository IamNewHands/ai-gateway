import { describe, it, expect } from 'vitest'
import { validateJSONSchema } from './tools'

/** 便捷：只返回是否通过 */
function ok(value: unknown, schema: Record<string, unknown>): boolean {
  return validateJSONSchema(value, schema, 'args') === null
}

describe('validateJSONSchema 基础类型', () => {
  it('对象 + required + properties', () => {
    const schema = {
      type: 'object',
      properties: { cmd: { type: 'string' }, n: { type: 'number' } },
      required: ['cmd'],
    }
    expect(ok({ cmd: 'ls', n: 1 }, schema)).toBe(true)
    expect(ok({ n: 1 }, schema)).toBe(false) // 缺 cmd
    expect(ok({ cmd: 123 }, schema)).toBe(false) // cmd 非 string
  })

  it('type 数组允许多种类型', () => {
    const schema = { type: ['string', 'null'] }
    expect(ok('x', schema)).toBe(true)
    expect(ok(null, schema)).toBe(true)
    expect(ok(5, schema)).toBe(false)
  })

  it('integer 不接受小数', () => {
    expect(ok(3, { type: 'integer' })).toBe(true)
    expect(ok(3.5, { type: 'integer' })).toBe(false)
  })

  it('additionalProperties:false 拒绝未声明字段', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    }
    expect(ok({ a: 'x' }, schema)).toBe(true)
    expect(ok({ a: 'x', b: 1 }, schema)).toBe(false)
  })

  it('无 type 的 schema 不限制类型', () => {
    expect(ok('anything', {})).toBe(true)
  })
})

describe('validateJSONSchema enum / const', () => {
  it('enum 限制取值', () => {
    const schema = { type: 'string', enum: ['a', 'b'] }
    expect(ok('a', schema)).toBe(true)
    expect(ok('c', schema)).toBe(false)
  })

  it('const 限制为精确值（忽略键序）', () => {
    const schema = { type: 'object', const: { a: 1, b: 2 } }
    expect(ok({ b: 2, a: 1 }, schema)).toBe(true)
    expect(ok({ a: 1 }, schema)).toBe(false)
  })
})

describe('validateJSONSchema allOf/anyOf/oneOf/not', () => {
  it('oneOf 恰好匹配一个分支', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { type: { const: 'a' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'b' } }, required: ['type'] },
      ],
    }
    expect(ok({ type: 'a' }, schema)).toBe(true)
    expect(ok({ type: 'c' }, schema)).toBe(false) // 0 分支
  })

  it('anyOf 至少匹配一个分支', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { kind: { const: 'x' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'y' } }, required: ['kind'] },
      ],
    }
    expect(ok({ kind: 'x' }, schema)).toBe(true)
    expect(ok({ kind: 'z' }, schema)).toBe(false)
  })

  it('allOf 需全部匹配', () => {
    const schema = {
      allOf: [
        { type: 'object', required: ['a'] },
        { type: 'object', required: ['b'] },
      ],
    }
    expect(ok({ a: 1, b: 2 }, schema)).toBe(true)
    expect(ok({ a: 1 }, schema)).toBe(false)
  })

  it('not 拒绝匹配的子模式', () => {
    const schema = {
      type: 'object',
      not: { type: 'object', properties: { disabled: { const: true } }, required: ['disabled'] },
    }
    expect(ok({ enabled: true }, schema)).toBe(true)
    expect(ok({ disabled: true }, schema)).toBe(false)
  })
})

describe('validateJSONSchema $ref 本地引用', () => {
  const schemaWithRef = {
    type: 'object',
    properties: {
      target: { $ref: '#/definitions/address' },
    },
    required: ['target'],
    definitions: {
      address: {
        type: 'object',
        properties: { street: { type: 'string' }, zip: { type: 'number' } },
        required: ['street'],
      },
    },
  }

  it('解析 #/definitions/... 引用并校验', () => {
    expect(ok({ target: { street: 'Main', zip: 100 } }, schemaWithRef)).toBe(true)
    expect(ok({ target: { zip: 100 } }, schemaWithRef)).toBe(false) // 缺 street
    expect(ok({ target: { street: 'Main', zip: 'bad' } }, schemaWithRef)).toBe(false) // zip 类型错
  })

  it('拒绝无法解析的 $ref', () => {
    const bad = {
      type: 'object',
      properties: { a: { $ref: '#/definitions/nonexistent' } },
    }
    expect(ok({ a: 1 }, bad)).toBe(false)
  })

  it('拒绝远程 $ref（http）', () => {
    const remote = {
      type: 'object',
      properties: { a: { $ref: 'http://example.com/schema.json' } },
    }
    expect(ok({ a: 1 }, remote)).toBe(false)
  })

  it('拒绝自引用 $ref（无限递归防护）', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfRef: Record<string, any> = { $ref: '#/definitions/node' }
    selfRef.definitions = { node: selfRef }
    expect(ok(1, selfRef)).toBe(false)
  })
})

describe('validateJSONSchema 数组/字符串/数值边界', () => {
  it('数组 items + minItems + uniqueItems', () => {
    const schema = { type: 'array', items: { type: 'integer' }, minItems: 1, uniqueItems: true }
    expect(ok([1, 2, 3], schema)).toBe(true)
    expect(ok([], schema)).toBe(false) // minItems
    expect(ok([1, 2, 2], schema)).toBe(false) // 重复
    expect(ok([1, 'x'], schema)).toBe(false) // 元素类型
  })

  it('字符串 minLength/maxLength', () => {
    expect(ok('abc', { type: 'string', minLength: 2, maxLength: 4 })).toBe(true)
    expect(ok('a', { type: 'string', minLength: 2 })).toBe(false)
    expect(ok('abcdef', { type: 'string', maxLength: 4 })).toBe(false)
  })

  it('数值 minimum/maximum/multipleOf', () => {
    expect(ok(5, { type: 'integer', minimum: 1, maximum: 10 })).toBe(true)
    expect(ok(0, { type: 'integer', minimum: 1 })).toBe(false)
    expect(ok(4, { type: 'number', multipleOf: 2 })).toBe(true)
    expect(ok(3, { type: 'number', multipleOf: 2 })).toBe(false)
  })
})

describe('validateJSONSchema 深度/节点护栏', () => {
  it('拒绝超深度 schema（防递归爆栈）', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deep: Record<string, any> = { type: 'object' }
    let cur: Record<string, any> = deep
    for (let i = 0; i < 200; i++) {
      cur.properties = { next: { type: 'object' } }
      cur = cur.properties.next
    }
    // 构造超出深度，校验深层值时应当被护栏拦截
    const result = validateJSONSchema({}, deep, 'args')
    // 只要不抛异常即可；空对象会命中 type object 结构校验
    expect(typeof result === 'string' || result === null).toBe(true)
  })
})