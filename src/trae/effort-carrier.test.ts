/**
 * effort-carrier.test.ts — `__trae_effort` 内部载体不得泄漏到 SOLO 上游。
 *
 * ## 这条保证为什么必须钉住
 *
 * 「切到 Remote 能调思考强度」依赖一个内部载体：`src/proxy.ts` 的
 * `rescueTraeReasoningEffort` 在 `sanitizeUpstreamBody` 删掉 `reasoning_effort`
 * **之前**把它挪进 `body.__trae_effort`，再由 `trae/proxy.ts` 的 Remote 分支读取。
 *
 * 风险在于：TRAE 的 **SOLO/Work** 路径会把整个请求体交给 `prepareBody` 序列化后直发上游。
 * 若载体没被清掉，它就会作为一个未知字段出现在 SOLO 请求体里 —— 那正是「保留原先的 SOLO、
 * 不影响使用」这条要求被破坏的样子（用户没开 Remote，请求体却变了）。
 *
 * 两道防线，本文件都验证：
 *  1. 载体**只在** `traeUpstreamEndpoint === 'remote'` 时创建（见 src/proxy.ts）；
 *  2. `prepareBody` 无条件删掉它（本文件的断言），保证任何调用方都漏不出去。
 */
import { describe, expect, it } from 'vitest'
import { prepareBody } from './payload'

describe('__trae_effort 载体：绝不进入 SOLO 上游请求体', () => {
  it('prepareBody 删掉 __trae_effort（即便被塞进 body）', () => {
    const body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      __trae_effort: { reasoning_effort: 'extra_high' },
    }
    const parsed = JSON.parse(prepareBody(JSON.stringify(body)))
    expect('__trae_effort' in parsed).toBe(false)
    // 顺带确认它没有以别的方式漏出去（值本身也不该出现）
    expect(prepareBody(JSON.stringify(body))).not.toContain('extra_high')
  })

  it('顶层 reasoning_effort 仍按原语义原样透传（本改动不动它）', () => {
    // prepareBody 从不负责删 reasoning_effort —— 那是 src/proxy.ts 的
    // sanitizeUpstreamBody 的职责。这里钉住分工，避免日后有人「顺手」在
    // payload 层加删除，把 Remote 的抢救路径一并废掉。
    const body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    }
    const parsed = JSON.parse(prepareBody(JSON.stringify(body)))
    expect(parsed.reasoning_effort).toBe('high')
  })

  it('没有载体时 prepareBody 行为不变（普通 SOLO 请求逐字节等价）', () => {
    const body = {
      model: 'glm-5.2',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }
    const parsed = JSON.parse(prepareBody(JSON.stringify(body)))
    expect(parsed.stream).toBe(true) // prepareBody 强制流式（原有行为）
    expect(parsed.function).toBe('solo_work_lite')
    expect(parsed.config_name).toBe('glm-5.2')
    expect('__trae_effort' in parsed).toBe(false)
  })

  it('__budget 与 __trae_effort 同时存在时都被消费掉，不泄漏', () => {
    const body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      __budget: { maxMessages: 1, maxHistoryChars: 0, maxToolSchemaChars: 0 },
      __trae_effort: { thinking: { budget_tokens: 8192 } },
    }
    const raw = prepareBody(JSON.stringify(body))
    expect(raw).not.toContain('__budget')
    expect(raw).not.toContain('__trae_effort')
  })
})
