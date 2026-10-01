/**
 * probe/worker.test.ts — 探针的**错误响应不得外泄内部细节**（CodeQL #79）。
 *
 * 背景：原实现把 `err.message` / `cause.message` 直接塞进 HTTP 响应体。探针是
 * `--temporary` 临时部署、URL 可能被转发出去的一次性 Worker，把上游/运行时的
 * 原始错误文本回给调用方等于免费情报（CWE-209）。
 *
 * 判定能力必须保住：探针要回答的是「40003/风控拒了 vs 连接层不通」，
 * 前者靠数字 bizCode，后者靠 cause.code —— 两者都不在 message 里。
 */

import { describe, it, expect } from 'vitest'
import { describeError } from './worker'
import { BizError, HttpStatusError } from '../src/deepseek/client'

describe('probe describeError（不外泄 message）', () => {
  it('BizError → 只回数字码，不回 msg 原文', () => {
    const err = new BizError({ bizCode: 40003, bizMsg: 'token leaked-in-this-text is invalid' })
    const out = describeError(err)
    expect(out.errorName).toBe('BizError')
    expect(out.bizCode).toBe(40003)
    // 关键断言：响应里任何字段都不得包含原始文案
    expect(JSON.stringify(out)).not.toContain('leaked-in-this-text')
  })

  it('HttpStatusError → 只回状态码，不回响应体片段', () => {
    const err = new HttpStatusError(503, 'upstream said: secret-snippet')
    const out = describeError(err)
    expect(out.errorName).toBe('HttpStatusError')
    expect(out.httpStatus).toBe(503)
    expect(JSON.stringify(out)).not.toContain('secret-snippet')
  })

  it('连接层错误 → 只回枚举式 cause.code（ENOTFOUND 等），不回自由文本', () => {
    const err = new Error('fetch failed: host secret-host.internal unreachable')
    ;(err as { cause?: unknown }).cause = { code: 'ENOTFOUND', message: 'dns lookup secret-host.internal failed' }
    const out = describeError(err)
    expect(out.causeCode).toBe('ENOTFOUND')
    expect(JSON.stringify(out)).not.toContain('secret-host.internal')
  })

  it('非 Error 值也能定性，且不把值本身序列化进去', () => {
    const out = describeError('plain-string-secret')
    expect(out.errorName).toBe('string')
    expect(JSON.stringify(out)).not.toContain('plain-string-secret')
  })

  it('无 cause 的普通 Error 不产生 causeCode（不猜）', () => {
    const out = describeError(new Error('boom'))
    expect(out.causeCode).toBeUndefined()
    expect(out.errorName).toBe('Error')
  })
})