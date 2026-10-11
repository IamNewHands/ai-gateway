import { describe, it, expect } from 'vitest'
import { soloHeaders } from './upstream'
import { TRAE_CONSTANTS } from './constants'

/**
 * SOLO 请求头对齐（Trae2api-cn `4f9451e`）。
 *
 * ⚠️ 这组头是**未经验证的实验**，不是缺陷修复：目标侧不带它们也能跑通。用例只锁定
 * 「四个头确实带上、且原有头没被覆盖」这一事实，不主张收益。
 * 回退方式：删掉 `soloHeaders` 里那四行（本用例会同时失败，属预期）。
 */

const account = { uid: 'u1', accessToken: 'tok', machineId: 'm1', deviceId: 'd1' } as any

describe('soloHeaders：CN/SOLO 原生头对齐（实验项）', () => {
  it('四个新增头带上且取值正确', () => {
    const h = soloHeaders(account, true)
    expect(h['X-Device-Platform']).toBe('windows')
    expect(h['X-Version-Code']).toBe(TRAE_CONSTANTS.IdeVersionCode)
    expect(h['app-version']).toBe(TRAE_CONSTANTS.IdeVersion)
    expect(h['package-type']).toBe('stable_cn')
  })

  it('原有头与账号指纹头未被覆盖（不回归）', () => {
    const h = soloHeaders(account, true)
    expect(h['X-Device-Type']).toBe('windows')
    expect(h['X-App-Version']).toBe('default')
    expect(h['X-Ide-Version']).toBe(TRAE_CONSTANTS.IdeVersion)
    expect(h['X-Ide-Version-Code']).toBe(TRAE_CONSTANTS.IdeVersionCode)
    expect(h['X-Ide-Version-Type']).toBe('stable')
    expect(h['Request-Traffic-Type']).toBe('prod')
    expect(h['Authorization']).toBe('Cloud-IDE-JWT tok')
    expect(h['X-Uid']).toBe('u1')
    expect(h['X-Machine-Id']).toBe('m1')
    expect(h['X-Device-Id']).toBe('d1')
    expect(h.Accept).toBe('text/event-stream')
  })

  it('非流式调用只改 Accept，实验头一并在位', () => {
    const h = soloHeaders(account, false)
    expect(h.Accept).toBe('application/json')
    expect(h['package-type']).toBe('stable_cn')
  })

  it('刻意不复刻的传输 SDK / 账号元数据头保持缺席（避免无依据照抄）', () => {
    const h = soloHeaders(account, true)
    for (const absent of [
      'x-lscbd-aid',
      'x-lscbd-platform',
      'x-ss-dp',
      'x-plugin-channel',
      'x-bridge-transport',
      'x-ahanet-timeout',
      'x-lgw-req-sdk-type',
      'x-net-sdk-domain-dispatch',
      'x-ttnet-bypass-decompression',
      'x-ttnet-bypass-cookie',
    ]) {
      expect(h[absent]).toBeUndefined()
    }
  })
})
