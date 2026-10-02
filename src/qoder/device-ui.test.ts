/**
 * device-ui.test.ts — 管理后台「Qoder 设备身份」区块的渲染与接线。
 *
 * 为什么需要它：本区块是**全局**配置（不挂在任何提供商卡片上），所以它「渲染了没有」不能靠
 * 有没有 qoder 提供商来推断。历史上本仓出过同类事故（deepseek-app 的 token 注入面板只在
 * 已存在的提供商详情页渲染，结果「添加提供商」界面上没有入口 → 功能等于不可用，见
 * pages-inline-script.test.ts 里那条预设下拉断言）。这里把入口、8 个输入框、客户端函数名
 * 与接口路径一起钉住。
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { renderAdminPage } from '../pages'
import { setProviders } from '../storage'
import { QODER_DEVICE_FIELDS } from './device'

function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
  }
  return { KV: kv } as unknown as AppEnv['Bindings']
}

async function render(providers: Provider[]): Promise<string> {
  const app = new Hono<AppEnv>()
  app.get('/admin', (c) => renderAdminPage(c))
  const env = makeEnv()
  await setProviders(env as never, providers)
  const res = await app.request('/admin', {}, env as never)
  return await res.text()
}

/** 抽取内联可执行脚本（与 pages-inline-script.test.ts 同口径）。 */
function inlineScripts(html: string): string[] {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || ''
    if (/\bsrc=/i.test(attrs)) continue
    const t = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] || '').toLowerCase()
    if (t && t !== 'text/javascript' && t !== 'application/javascript' && t !== 'module') continue
    out.push(m[2])
  }
  return out
}

describe('管理后台「Qoder 设备身份」区块', () => {
  it('无任何提供商时也渲染（全局配置，不该依赖 qoder 提供商存在）', async () => {
    const html = await render([])
    expect(html).toContain('id="qoder-device"')
    expect(html).toContain('Qoder 设备身份')
    for (const f of QODER_DEVICE_FIELDS) {
      expect(html, `缺少输入框 ${f.header}`).toContain('id="qd-' + f.key + '"')
    }
  })

  it('导航入口齐全（桌面侧栏 + 移动端导航），否则用户找不到这个页面', async () => {
    const html = await render([])
    expect(html).toContain('href="#qoder-device"')
    // 侧栏一个、移动端一个
    expect((html.match(/href="#qoder-device"/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('字段说明写出「哪个文件里的值」和「留空会怎样」——没有它用户无从下手', async () => {
    const html = await render([])
    expect(html).toContain('runtime-info.exe')
    expect(html).toContain('auth.machine-id')
    expect(html).toContain('build-manifest.json')
    // 四个没有内置值的字段必须明说「无内置值」，否则用户以为留空是安全的
    expect((html.match(/无内置值/g) || []).length).toBe(4)
    // 有内置值的字段把默认值显示成 placeholder
    expect(html).toMatch(/id="qd-clientType"[^>]*placeholder="10"/)
    expect(html).toContain('deviceIdentity')
  })

  it('客户端函数与接口路径都在脚本里（少了就是「按钮点了没反应」）', async () => {
    const js = inlineScripts(await render([])).join('\n')
    for (const fn of ['qoderDeviceFillFromJson', 'loadQoderDevice', 'saveQoderDevice', 'resetQoderDevice']) {
      expect(js).toContain('function ' + fn)
    }
    expect(js).toContain("'/admin/api/qoder-device'")
    // JSON 粘贴框与「从 JSON 填充」按钮
    expect(js).toContain("document.getElementById('qoder-device-json')")
    expect(await render([])).toContain('qoderDeviceFillFromJson()')
    // 展开/刷新时自动加载，否则回显是空的（用户会以为没保存上）
    expect(js).toContain('maybeLoadQoderDevice')
    expect(js).toContain('setTimeout(loadQoderDevice, 100)')
  })
})

/**
 * 「从 JSON 填充」的行为验证（DOM 替身驱动客户端代码）。
 *
 * 为什么必须跑行为而不只查存在性：用户手上就一份 `config.json`，这个按钮是他唯一的输入路径。
 * 键名归一写错（比如没去掉 `COSY_` 前缀、没认 `productVersion`）时按钮**不报错也不填充**，
 * 表现成「我明明粘了，怎么什么都没进去」，从语法/存在性断言里完全看不出来。
 */
function makeQoderDevApi(html: string) {
  const js = inlineScripts(html).join('\n')
  const m = js.match(/\/\* QODER_DEV_BEGIN \*\/([\s\S]*?)\/\* QODER_DEV_END \*\//)
  if (!m) throw new Error('未找到 QODER_DEV 标记块：面板填充块被删除或改名了？')
  const inputs = new Map<string, { id: string; value: string }>()
  for (const f of QODER_DEVICE_FIELDS) inputs.set('qd-' + f.key, { id: 'qd-' + f.key, value: '' })
  const ta = { value: '' }
  const out = { textContent: '', style: { color: '' } }
  const document = {
    getElementById: (id: string) => (id === 'qoder-device-json' ? ta : (id === 'qoder-device-result' ? out : inputs.get(id) ?? null)),
  }
  const toasts: string[] = []
  const factory = new Function(
    'document', 'toast',
    m[1] + '\nreturn {' +
      ' fill: qoderDeviceFillFromJson,' +
      ' key: qoderDeviceKey,' +
      ' setFields: function (f) { qoderDeviceFields = f } }'
  )
  const api = factory(document, (msg: string) => { toasts.push(String(msg)) })
  return {
    ...api,
    ta, out, toasts,
    val: (key: string) => inputs.get('qd-' + key)?.value ?? null,
    all: () => QODER_DEVICE_FIELDS.map((f) => inputs.get('qd-' + f.key)!.value),
  }
}

describe('「从 JSON 填充」：键名归一与填充行为', () => {
  it('键名归一同时接受 config.json 的 camelCase、COSY_* 大写与 productVersion', async () => {
    const api = makeQoderDevApi(await render([]))
    expect(api.key('machineToken')).toBe('machinetoken')
    expect(api.key('COSY_MACHINE_TOKEN')).toBe('machinetoken')
    expect(api.key('cosy-machine-code')).toBe('machinecode')
    expect(api.key('  MachineOS  ')).toBe('machineos')
    expect(api.key('productVersion')).toBe('version')
    expect(api.key('version')).toBe('version')
    expect(api.key(null)).toBe('')
    expect(api.key(undefined)).toBe('')
  })

  it('整段粘贴 config.json（含 device 块）→ 8 个字段全部填上', async () => {
    const api = makeQoderDevApi(await render([]))
    api.setFields(QODER_DEVICE_FIELDS)
    api.ta.value = JSON.stringify({
      device: {
        clientType: '10',
        machineOS: 'x86_64_windows',
        machineHostname: 'HUAWEI-MACBOOK',
        machineId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        machineToken: 'dev-machine-token-placeholder',
        machineCode: '00112233445566aabb',
        machineType: 'aabbccddeeff001122',
        version: '0.4.3',
      },
    })
    api.fill()
    expect(api.all()).toEqual([
      '10', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'dev-machine-token-placeholder',
      'aabbccddeeff001122', '00112233445566aabb', 'x86_64_windows', 'HUAWEI-MACBOOK', '0.4.3',
    ])
    expect(api.out.textContent).toContain('已填充 8 个字段')
    expect(api.toasts).toEqual([])
  })

  it('只贴 device 块本身、或贴 COSY_* 形式的键，同样能填充', async () => {
    const bare = makeQoderDevApi(await render([]))
    bare.setFields(QODER_DEVICE_FIELDS)
    bare.ta.value = '{"machineToken":"tok","machineCode":"abc"}'
    bare.fill()
    expect(bare.val('machineToken')).toBe('tok')
    expect(bare.val('machineCode')).toBe('abc')
    // 没给的字段保持原值（不清空用户已填的内容）
    expect(bare.val('clientType')).toBe('')

    const envStyle = makeQoderDevApi(await render([]))
    envStyle.setFields(QODER_DEVICE_FIELDS)
    envStyle.ta.value = '{"COSY_MACHINE_TOKEN":"tok2","COSY_VERSION":"0.4.3"}'
    envStyle.fill()
    expect(envStyle.val('machineToken')).toBe('tok2')
    expect(envStyle.val('version')).toBe('0.4.3')
  })

  it('非空值 trim 后填入（粘贴时常见的尾随空白不会变成头里的脏字符）', async () => {
    const api = makeQoderDevApi(await render([]))
    api.setFields(QODER_DEVICE_FIELDS)
    api.ta.value = '{"machineToken":"  tok  ","machineCode":"   "}'
    api.fill()
    expect(api.val('machineToken')).toBe('tok')
    expect(api.val('machineCode')).toBe('')
  })

  it('非法 JSON / 没有 device 对象 / 一个字段都没识别到 → 明确报错，不假装填充成功', async () => {
    const bad = makeQoderDevApi(await render([]))
    bad.setFields(QODER_DEVICE_FIELDS)
    bad.ta.value = '{not json'
    bad.fill()
    expect(bad.toasts[0]).toContain('JSON 解析失败')
    expect(bad.all().every((v: string) => v === '')).toBe(true)

    const other = makeQoderDevApi(await render([]))
    other.setFields(QODER_DEVICE_FIELDS)
    other.ta.value = '{"accounts":[{"uid":"u1"}]}'
    other.fill()
    expect(other.out.textContent).toContain('没识别到任何字段')
    expect(other.toasts[0]).toContain('没识别到任何字段')
  })
})
