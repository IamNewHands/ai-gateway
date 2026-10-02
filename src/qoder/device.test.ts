/**
 * device.test.ts — Qoder 真机设备身份的 KV 存储、归一与「存了就能发出去」。
 *
 * 为什么需要它：这些值决定签到能不能拿到「每日领取 100 Credits」活动，而三种失败在
 * 线上**都只表现为「无可用签到活动」**，本地看不出区别：
 *   1. 存进去的值被归一吃掉（只配了 machineToken，其余字段被写成空串发出去）；
 *   2. 全空时没清 KV，于是签到一直以为「已配真机身份」（日志报 native 却在发派生值）；
 *   3. KV 里是脏数据（人工改过 / 非法 JSON）时抛异常，把整次签到打挂。
 * 这里逐条钉住，并覆盖「粘贴 config.json → 保存 → 出站头」的完整链路。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  QODER_DEVICE_FIELDS,
  normalizeQoderDevice,
  hasQoderDevice,
  getQoderDevice,
  getQoderDeviceConfig,
  setQoderDevice,
} from './device'
import { KV_KEYS } from '../config'
import { QODER_DESKTOP_DEFAULTS, performQoderCheckin, type QoderDeviceIdentity } from './billing'
import type { Env } from '../types'

/** 假 KV：`get(k, 'json')` 与真 KV 同行为——内容不是合法 JSON 时**抛异常**（不是返回 null）。 */
function makeEnv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV: kv } as unknown as Env, store }
}

/** 跑一次签到，回出站头（只看 campaigns 那次请求）。 */
async function checkinHeadersFor(device: QoderDeviceIdentity | undefined) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  await performQoderCheckin('dt-c', 'global', 'uid-1', undefined, device)
  return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
}

afterEach(() => { vi.unstubAllGlobals() })

describe('normalizeQoderDevice：只认已知字段的 trim 后非空值', () => {
  it('trim 掉首尾空白，未知键直接丢弃（面板不会把垃圾带进 KV）', () => {
    expect(normalizeQoderDevice({ machineToken: '  tok  ', hack: 'x' }))
      .toEqual({ machineToken: 'tok' })
  })

  it('空值 / 非字符串 / 非对象一律不写入（宁可少一个字段，也不要发出空头）', () => {
    expect(normalizeQoderDevice(undefined)).toEqual({})
    expect(normalizeQoderDevice(null)).toEqual({})
    expect(normalizeQoderDevice('not-an-object')).toEqual({})
    expect(normalizeQoderDevice([])).toEqual({})
    expect(normalizeQoderDevice({ machineToken: '' })).toEqual({})
    expect(normalizeQoderDevice({ machineToken: '   ' })).toEqual({})
    expect(normalizeQoderDevice({ machineToken: 123 })).toEqual({})
  })

  it('八个字段全给时一个不少（与面板字段清单同集合）', () => {
    const all = Object.fromEntries(QODER_DEVICE_FIELDS.map((f) => [f.key, 'v-' + f.key]))
    expect(normalizeQoderDevice(all)).toEqual(all)
  })
})

describe('QODER_DEVICE_FIELDS：面板字段清单的唯一 owner', () => {
  it('8 个字段、key 不重复', () => {
    const keys = QODER_DEVICE_FIELDS.map((f) => f.key)
    expect(keys).toHaveLength(8)
    expect(new Set(keys).size).toBe(8)
  })

  it('每个 header 都是实际发出的 Cosy-* 头名（面板上显示的就是发出去的那个）', () => {
    for (const f of QODER_DEVICE_FIELDS) {
      expect(f.header).toMatch(/^Cosy-[A-Za-z]+$/)
    }
    expect(QODER_DEVICE_FIELDS.map((f) => f.header.toLowerCase()).sort()).toEqual([
      'cosy-clienttype', 'cosy-machinecode', 'cosy-machinehostname', 'cosy-machineid',
      'cosy-machineos', 'cosy-machinetoken', 'cosy-machinetype', 'cosy-version',
    ])
  })
})

describe('setQoderDevice / getQoderDeviceConfig：存了什么就读回什么', () => {
  it('往返一致', async () => {
    const { env } = makeEnv()
    await setQoderDevice(env, { machineToken: 'tok', machineCode: 'abc123' })
    expect(await getQoderDeviceConfig(env)).toEqual({ machineToken: 'tok', machineCode: 'abc123' })
  })

  it('留空的字段不落库：默认值只在发头时补，避免与 QODER_DESKTOP_DEFAULTS 形成两份真相', async () => {
    const { env, store } = makeEnv()
    await setQoderDevice(env, { machineToken: 'tok' })
    expect(JSON.parse(store.get(KV_KEYS.QODER_DEVICE)!)).toEqual({ machineToken: 'tok' })
  })

  it('全空 = 清空 KV（不留 `{}`，否则会被当成「已配置」）', async () => {
    const { env, store } = makeEnv()
    await setQoderDevice(env, { machineToken: 'tok' })
    expect(store.has(KV_KEYS.QODER_DEVICE)).toBe(true)
    await setQoderDevice(env, { machineToken: '   ', machineCode: '' })
    expect(store.has(KV_KEYS.QODER_DEVICE)).toBe(false)
    expect(await getQoderDevice(env)).toBeUndefined()
  })
})

describe('getQoderDevice：全空回退 uid 派生路径；脏数据不炸', () => {
  it('未配置 → undefined（签到据此标记 derived）', async () => {
    const { env } = makeEnv()
    expect(await getQoderDevice(env)).toBeUndefined()
  })

  it('只配一个字段也算已配置（真机身份是部分覆盖，不是全有或全无）', async () => {
    const { env } = makeEnv()
    await setQoderDevice(env, { machineToken: 'tok' })
    expect(await getQoderDevice(env)).toEqual({ machineToken: 'tok' })
  })

  it('KV 里是非法 JSON / 字符串 / 数组 → 一律回退空配置，不抛异常（否则整次签到打挂）', async () => {
    for (const raw of ['{not json', '"str"', '[]', '123']) {
      const { env } = makeEnv({ [KV_KEYS.QODER_DEVICE]: raw })
      await expect(getQoderDeviceConfig(env)).resolves.toEqual({})
      await expect(getQoderDevice(env)).resolves.toBeUndefined()
    }
  })

  it('hasQoderDevice 是「已配置」的唯一定义（面板 isCustom 与签到走哪条路同源）', () => {
    expect(hasQoderDevice(undefined)).toBe(false)
    expect(hasQoderDevice({})).toBe(false)
    expect(hasQoderDevice({ machineToken: '' })).toBe(false)
    expect(hasQoderDevice({ machineToken: 'tok' })).toBe(true)
  })
})

describe('端到端：粘贴提取脚本的 config.json → 保存 → 出站头带真机身份', () => {
  /**
   * 形状取自 2026-10-02 在装了 Qoder 桌面端的机器上跑 `01_extract.py` 得到的 config.json
   * （machineId 是 uuid、machineCode/machineType 是 18 位十六进制、version 是 build-manifest
   * 的 productVersion）。**真机 token 属凭据，不入库不入仓**，这里用占位符。
   */
  const extracted: QoderDeviceIdentity = {
    clientType: '10',
    machineOS: 'x86_64_windows',
    machineHostname: 'DESKTOP-TEST',
    machineId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    machineToken: 'dev-machine-token-placeholder',
    machineCode: '00112233445566aabb',
    machineType: 'aabbccddeeff001122',
    version: '0.4.3',
  }

  it('8 个字段原样出现在出站头里（含 cosy-machinecode）', async () => {
    const { env } = makeEnv()
    await setQoderDevice(env, extracted)
    const headers = await checkinHeadersFor(await getQoderDevice(env))
    expect(headers['cosy-clienttype']).toBe('10')
    expect(headers['cosy-machineos']).toBe('x86_64_windows')
    expect(headers['cosy-machinehostname']).toBe('DESKTOP-TEST')
    expect(headers['cosy-machineid']).toBe(extracted.machineId)
    expect(headers['cosy-machinetoken']).toBe(extracted.machineToken)
    expect(headers['cosy-machinecode']).toBe(extracted.machineCode)
    expect(headers['cosy-machinetype']).toBe(extracted.machineType)
    expect(headers['cosy-version']).toBe('0.4.3')
  })

  it('只配 machineToken：其余回退内置默认 + uid 派生值，绝不发空头', async () => {
    const { env } = makeEnv()
    await setQoderDevice(env, { machineToken: 'dev-machine-token-placeholder' })
    const headers = await checkinHeadersFor(await getQoderDevice(env))
    expect(headers['cosy-machinetoken']).toBe('dev-machine-token-placeholder')
    expect(headers['cosy-clienttype']).toBe(QODER_DESKTOP_DEFAULTS.clientType)
    expect(headers['cosy-machineos']).toBe(QODER_DESKTOP_DEFAULTS.machineOS)
    expect(headers['cosy-machinehostname']).toBe(QODER_DESKTOP_DEFAULTS.machineHostname)
    expect(headers['cosy-version']).toBe(QODER_DESKTOP_DEFAULTS.version)
    // 没配的三个身份字段走 uid 派生值 —— 有值但不是我们配的那个
    expect(headers['cosy-machineid']).toBeTruthy()
    expect(headers['cosy-machinetype']).toBeTruthy()
    expect(headers['cosy-machinecode']).toBeTruthy()
  })
})
