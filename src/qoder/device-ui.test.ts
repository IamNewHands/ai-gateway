/**
 * device-ui.test.ts — 「Qoder 真机设备身份」配置块的渲染与接线。
 *
 * 2026-10-02 改版：该配置**从独立菜单搬进 Qoder 提供商卡片**（用户要求「不要单独建菜单」）。
 * 两个后果必须在测试里钉死，否则线上表现是「功能没了」而不是报错：
 *   1. 配置块随 Qoder 提供商卡片渲染 —— 没有 qoder 提供商时它不会出现（这是本次改版的
 *      已知取舍：入口跟着提供商走。见下面那条显式断言，避免以后有人误判成回归）；
 *   2. 数据仍是**机器级全局配置**（KV qoder:device），所以一个卡片保存后另一张卡片看到同一份。
 *      客户端作用域因此按容器 `[data-qoder-device]` 找，而不是固定 id `qd-<key>`
 *      —— 旧写法在页面上出现第二个 Qoder 提供商时会撞 id，两个卡片互相覆盖。
 *
 * 历史同类事故（本仓真实发生过）：deepseek-app 的 token 注入面板只在已存在的提供商详情页
 * 渲染，结果「添加提供商」界面上没有入口 → 功能等于不可用。故这里把入口位置、8 个输入框、
 * 客户端函数名与接口路径一起钉住。
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { renderAdminPage } from '../pages'
import { setProviders } from '../storage'
import { QODER_DEVICE_FIELDS, normalizeQoderDevice } from './device'

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

/** Qoder 提供商：配置块只在这个卡片里渲染（`p.oauth.flowType === 'qoder'`）。 */
function qoderProvider(): Provider {
  return {
    id: 'qoder',
    name: 'QoderWork',
    baseUrl: 'https://gateway.qoder.com.cn',
    apiType: 'openai',
    apiKeys: [],
    models: [{ id: 'qfmodel', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
    authType: 'oauth-device',
    oauth: { flowType: 'qoder' },
  } as unknown as Provider
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

describe('「Qoder 设备身份」配置块（挂在 Qoder 提供商卡片里）', () => {
  it('渲染在 Qoder 提供商卡片的 Qoder 池 fieldset 内，8 个输入框带 data-key', async () => {
    const html = await render([qoderProvider()])
    expect(html).toContain('data-qoder-device="qoder"')
    for (const f of QODER_DEVICE_FIELDS) {
      expect(html, `缺少输入框 ${f.header}`).toContain('data-key="' + f.key + '"')
    }
    // 位置：必须在 qdp-fs-qoder 这个 fieldset 内部（不是页面别处的浮动区块）
    const start = html.indexOf('id="qdp-fs-qoder"')
    const blockAt = html.indexOf('data-qoder-device="qoder"')
    const end = html.indexOf('</fieldset>', start)
    expect(start).toBeGreaterThan(-1)
    expect(blockAt).toBeGreaterThan(start)
    expect(blockAt).toBeLessThan(end)
  })

  it('独立菜单与独立区块已彻底移除（否则等于有两份入口、两份真相）', async () => {
    const html = await render([qoderProvider()])
    expect(html).not.toContain('href="#qoder-device"')
    expect(html).not.toContain('id="qoder-device"')
    expect(html).not.toContain('id="qd-clientType"')
    // 旧的固定 id 一律不该再出现（改回固定 id 就会在第二个 Qoder 提供商上撞车）
    expect(html).not.toContain('id="qd-')
  })

  it('没有 Qoder 提供商时不渲染该配置块（入口跟着提供商走——本次改版的已知取舍）', async () => {
    const html = await render([])
    // 只断言「配置块」不存在；客户端脚本里的 [data-qoder-device] 选择器与
    // '.qoder-device-input' 字符串当然还在，所以按标记的**渲染形态**断言
    expect(html).not.toContain('data-qoder-device="')
    expect(html).not.toContain('class="fx1 qoder-device-input"')
    // 但接口仍在（老客户端/脚本调用不受影响）
    expect(html).toContain('/admin/api/qoder-device')
  })

  it('字段说明写出「哪个文件里的值」和「留空会怎样」——没有它用户无从下手', async () => {
    const html = await render([qoderProvider()])
    expect(html).toContain('runtime-info.exe')
    expect(html).toContain('auth.machine-id')
    expect(html).toContain('build-manifest.json')
    // 四个没有内置值的字段必须明说「无内置值」，否则用户以为留空是安全的
    expect((html.match(/无内置值/g) || []).length).toBe(4)
    // 有内置值的字段把默认值显示成 placeholder
    expect(html).toMatch(/data-key="clientType"[^>]*placeholder="10"/)
    expect(html).toContain('deviceIdentity')
    // 全局语义必须写明：多张 Qoder 卡片共用同一份（写在折叠标题里，收起时也看得见）
    expect(html).toContain('所有 Qoder 提供商共用一份')
    expect(html).toContain('机器级常量')
  })

  it('客户端函数与接口路径都在脚本里（少了就是「按钮点了没反应」）', async () => {
    const html = await render([qoderProvider()])
    const js = inlineScripts(html).join('\n')
    for (const fn of ['qoderDeviceFillFromJson', 'loadQoderDevices', 'loadQoderDeviceBlock', 'saveQoderDevice', 'resetQoderDevice']) {
      expect(js).toContain('function ' + fn)
    }
    expect(js).toContain("'/admin/api/qoder-device'")
    // 作用域按容器找，不再用固定 id
    expect(js).toContain("closest('[data-qoder-device]')")
    expect(js).toContain("querySelector('.qoder-device-json')")
    expect(js).not.toContain("getElementById('qd-")
    // 页面加载即自动回显，否则用户会以为没保存上
    expect(js).toContain('setTimeout(loadQoderDevices, 100)')
  })
})

/**
 * 「从 JSON 填充」的行为验证（DOM 替身驱动客户端代码）。
 *
 * 为什么必须跑行为而不只查存在性：用户手上就一份 `config.json`，这个按钮是他唯一的输入路径。
 * 键名归一写错（比如没去掉 `COSY_` 前缀、没认 `productVersion`）时按钮**不报错也不填充**，
 * 表现成「我明明粘了，怎么什么都没进去」，从语法/存在性断言里完全看不出来。
 *
 * 替身按真实 DOM 契约搭：函数只通过 `btn.closest('[data-qoder-device]')` 拿到作用域容器，
 * 再从容器里 `querySelector('.qoder-device-json')` 与 `querySelectorAll('.qoder-device-input')`，
 * 输入框的自有键名来自 SSR 写下的 `data-key`。
 */
function makeQoderDevApi(html: string) {
  const js = inlineScripts(html).join('\n')
  const m = js.match(/\/\* QODER_DEV_BEGIN \*\/([\s\S]*?)\/\* QODER_DEV_END \*\//)
  if (!m) throw new Error('未找到 QODER_DEV 标记块：面板填充块被删除或改名了？')
  // 输入框集合 = SSR 实际渲染出来的那一组（data-key 由 QODER_DEVICE_FIELDS 生成）
  const inputs = QODER_DEVICE_FIELDS.map((f) => ({
    key: f.key,
    value: '',
    getAttribute: (n: string) => (n === 'data-key' ? f.key : null),
  }))
  const ta = { value: '' }
  const out = { textContent: '', style: { color: '' } }
  const block = {
    querySelector: (sel: string) => (sel === '.qoder-device-json' ? ta : (sel === '.qoder-device-result' ? out : null)),
    querySelectorAll: (sel: string) => (sel === '.qoder-device-input' ? inputs : []),
  }
  const btn = { closest: (sel: string) => (sel === '[data-qoder-device]' ? block : null) }
  const toasts: string[] = []
  const factory = new Function(
    'toast',
    m[1] + '\nreturn {' +
      ' fill: qoderDeviceFillFromJson,' +
      ' key: qoderDeviceKey,' +
      ' payload: qoderDevicePayload,' +
      ' apply: qoderDeviceApply }'
  )
  const api = factory((msg: string) => { toasts.push(String(msg)) })
  return {
    ...api,
    ta, out, toasts, btn, block,
    val: (key: string) => inputs.find((i) => i.key === key)?.value ?? null,
    all: (): string[] => inputs.map((i) => i.value),
  }
}

describe('「从 JSON 填充」：键名归一与填充行为', () => {
  it('键名归一同时接受 config.json 的 camelCase、COSY_* 大写与 productVersion', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
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
    const api = makeQoderDevApi(await render([qoderProvider()]))
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
    api.fill(api.btn)
    expect(api.all()).toEqual([
      '10', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'dev-machine-token-placeholder',
      'aabbccddeeff001122', '00112233445566aabb', 'x86_64_windows', 'HUAWEI-MACBOOK', '0.4.3',
    ])
    expect(api.out.textContent).toContain('已填充 8 个字段')
    expect(api.toasts).toEqual([])
  })

  it('只贴 device 块本身、或贴 COSY_* 形式的键，同样能填充', async () => {
    const bare = makeQoderDevApi(await render([qoderProvider()]))
    bare.ta.value = '{"machineToken":"tok","machineCode":"abc"}'
    bare.fill(bare.btn)
    expect(bare.val('machineToken')).toBe('tok')
    expect(bare.val('machineCode')).toBe('abc')
    // 没给的字段保持原值（不清空用户已填的内容）
    expect(bare.val('clientType')).toBe('')

    const envStyle = makeQoderDevApi(await render([qoderProvider()]))
    envStyle.ta.value = '{"COSY_MACHINE_TOKEN":"tok2","COSY_VERSION":"0.4.3"}'
    envStyle.fill(envStyle.btn)
    expect(envStyle.val('machineToken')).toBe('tok2')
    expect(envStyle.val('version')).toBe('0.4.3')
  })

  it('非空值 trim 后填入（粘贴时常见的尾随空白不会变成头里的脏字符）', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
    api.ta.value = '{"machineToken":"  tok  ","machineCode":"   "}'
    api.fill(api.btn)
    expect(api.val('machineToken')).toBe('tok')
    expect(api.val('machineCode')).toBe('')
  })

  it('非法 JSON / 没有 device 对象 / 一个字段都没识别到 → 明确报错，不假装填充成功', async () => {
    const bad = makeQoderDevApi(await render([qoderProvider()]))
    bad.ta.value = '{not json'
    bad.fill(bad.btn)
    expect(bad.toasts[0]).toContain('JSON 解析失败')
    expect(bad.all().every((v: string) => v === '')).toBe(true)

    const other = makeQoderDevApi(await render([qoderProvider()]))
    other.ta.value = '{"accounts":[{"uid":"u1"}]}'
    other.fill(other.btn)
    expect(other.out.textContent).toContain('没识别到任何字段')
    expect(other.toasts[0]).toContain('没识别到任何字段')
  })

  it('拿不到作用域容器（按钮不在卡片里）→ 静默返回，不抛异常打断其它按钮', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
    expect(() => api.fill({ closest: () => null })).not.toThrow()
    expect(() => api.fill(null)).not.toThrow()
  })
})

/**
 * 「保存 → 回填」的端到端契约（2026-10-02 真实事故的回归测试）。
 *
 * 事故：客户端把键名归一成全小写（clienttype）后发出，后端 normalizeQoderDevice 只认
 * QODER_DEVICE_FIELDS 的 camelCase key → 整包被丢弃 → 归一结果为空 → setQoderDevice 判定
 * 「用户清空了」而**删掉 KV**。用户看到的只有「填好点保存，刷新后一片空白」，
 * 而存在性/语法断言全都通过——所以这里必须跑真实的载荷 → 归一 → 回填链路。
 */
describe('保存与回填：出站键名必须与后端已知键逐字相同', () => {
  const FILLED: Record<string, string> = {
    clientType: '10',
    machineId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    machineToken: 'dev-machine-token-placeholder',
    machineType: 'aabbccddeeff001122',
    machineCode: '00112233445566aabb',
    machineOS: 'x86_64_windows',
    machineHostname: 'HUAWEI-MACBOOK',
    version: '0.4.3',
  }

  it('载荷键名 = data-key 原值（camelCase），后端归一后 8 个字段一个不丢', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
    api.ta.value = JSON.stringify({ device: FILLED })
    api.fill(api.btn)

    const payload = api.payload(api.block) as Record<string, string>
    expect(Object.keys(payload).sort()).toEqual([...QODER_DEVICE_FIELDS.map((f) => f.key)].sort())
    // 归一后必须还是 8 个 —— 若键名被归一成 clienttype，这里会变成 0（KV 随后被删）
    const norm = normalizeQoderDevice(payload)
    expect(Object.keys(norm).length).toBe(QODER_DEVICE_FIELDS.length)
    expect(norm).toEqual(FILLED)
  })

  it('保存成功后回填：清空输入框 → 用后端返回值重填 → 8 个值原样回来', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
    api.ta.value = JSON.stringify({ device: FILLED })
    api.fill(api.btn)
    const norm = normalizeQoderDevice(api.payload(api.block))
    // 模拟刷新后重新加载：先清空，再用「KV 里存的归一结果」回填
    api.apply(api.block, {})
    expect(api.all().every((v: string) => v === '')).toBe(true)
    api.apply(api.block, norm)
    expect(api.all()).toEqual(QODER_DEVICE_FIELDS.map((f) => FILLED[f.key]))
  })

  it('后端返回脏数据/缺字段时按空串回填，不把 undefined 写进输入框', async () => {
    const api = makeQoderDevApi(await render([qoderProvider()]))
    api.apply(api.block, { machineToken: 'tok' })
    expect(api.val('machineToken')).toBe('tok')
    expect(api.all().filter((v: string) => v === 'undefined').length).toBe(0)
    expect(api.all().filter((v: string) => v === '')).toHaveLength(QODER_DEVICE_FIELDS.length - 1)
  })
})

/**
 * 内置提取脚本：用户会忘记怎么提取，所以脚本必须跟着界面走。
 *
 * 断言的是**解码后**（浏览器 textContent 语义）的脚本文本，因为这段脚本嵌在 pages.ts 的
 * 模板字面量里，`\u`/`\S` 这类反斜杠会被 JS 转义规则吃掉或报错——只有把解码结果拿出来比对，
 * 才能确认注册表路径与 exe 路径没被吃掉（`'HKCU:\Software\...'` 写成单反斜杠时，
 * JS 会静默把 `\S` 变成 `S`，脚本照跑但路径全错）。
 */
function extractScript(html: string): string {
  const m = html.match(/<pre class="qoder-extract-script"[^>]*>([\s\S]*?)<\/pre>/)
  if (!m) throw new Error('未找到内置提取脚本 <pre>：被删或 class 改名了？')
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

describe('内置提取脚本（防止后续忘记怎么提取）', () => {
  it('脚本在页面里，且关键路径的反斜杠没被模板转义吃掉', async () => {
    const script = extractScript(await render([qoderProvider()]))
    expect(script).toContain("'Programs\\Qoder'")
    expect(script).toContain("'Programs\\Qoder CN'")
    expect(script).toContain("'resources\\umid\\runtime-info.exe'")
    expect(script).toContain("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'")
    expect(script).toContain("'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'")
    expect(script).toContain("'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'")
    // 调用运算符必须还原成 &（源里写的是 &amp;，textContent 会解回 &）
    expect(script).toContain('& $exe --account-stdin')
    expect(script).not.toContain('&amp;')
    // 空管道是**承重结构**：--account-stdin 会读 stdin，交互式控制台下 stdin 是键盘，
    // 没有它脚本会一直卡在「刚打印完 exe 路径」那里（2026-10-02 用户实测卡死）。
    expect(script).toContain("'' | & $exe --account-stdin")
  })

  /**
   * 反斜杠总数的兜底断言。
   *
   * 为什么需要它：这段脚本嵌在 pages.ts 的**模板字面量**里，`\u` 会直接编译报错，但
   * `\Q` / `\S` / `\P` 这类会**静默丢掉反斜杠**——`'Programs\Qoder'` 变成 `'ProgramsQoder'`，
   * 脚本照常运行、语法检查全过、只是路径找不到（2026-10-02 真实踩到：本地跑真机脚本成功，
   * 而从页面里取出的那份报 "runtime-info.exe not found"）。上面逐条断言能定位到具体是哪一行，
   * 这条总数断言则保证**新加的任何一行**带反斜杠的路径都不会悄悄漏掉转义。
   *
   * 改脚本时若这里失败：先把新路径里的每个 `\` 都写成 `\\`，再更新下面的数字。
   */
  it('反斜杠总数固定：任何一行新路径漏写 \\\\ 都会在这里失败', async () => {
    const script = extractScript(await render([qoderProvider()]))
    const count = (script.match(/\\/g) || []).length
    expect(count, '反斜杠数量对不上：多半是新加的 Windows 路径漏写了一个 \\，被模板字面量吃掉了').toBe(25)
  })

  it('脚本输出与面板期望的 JSON 结构一致：device 块 + 8 个已知键', async () => {
    const script = extractScript(await render([qoderProvider()]))
    expect(script).toContain('$device = [ordered]@{')
    expect(script).toContain('[pscustomobject]@{ device = $device } | ConvertTo-Json')
    for (const f of QODER_DEVICE_FIELDS) {
      expect(script, `脚本没覆盖字段 ${f.key}`).toContain(f.key)
    }
    // 三个数据来源都要在：runtime-info.exe / auth.machine-id / build-manifest.json
    expect(script).toContain('runtime-info.exe')
    expect(script).toContain('auth.machine-id')
    expect(script).toContain('build-manifest.json')
  })

  it('脚本保持纯 ASCII（PS 5.1 读无 BOM 的 UTF-8 中文会乱码成语法错误）', async () => {
    const script = extractScript(await render([qoderProvider()]))
    // eslint-disable-next-line no-control-regex
    expect(script).not.toMatch(/[^\x00-\x7F]/)
  })

  it('「复制脚本」按钮接上了读 <pre> 的函数（脚本内容不经过 JS 字符串，避免二次转义）', async () => {
    const html = await render([qoderProvider()])
    const js = inlineScripts(html).join('\n')
    expect(html).toContain('copyQoderExtractScript(this)')
    expect(js).toContain('function copyQoderExtractScript')
    expect(js).toContain("querySelector('.qoder-extract-script')")
    // 复制的是 textContent（已还原实体），不是 innerHTML
    expect(js).toContain('copyText(pre.textContent, btn)')
  })
})

/**
 * 折叠与状态可见性：配置块默认收起（用户要求），但「配没配」必须一眼可见——
 * 徽章若放进折叠体里，收起后就再也看不出当前生效的是真机身份还是派生值。
 */
describe('设备身份折叠与状态徽章', () => {
  it('两层折叠（外层配置块 + 内层提取说明），各自有独立的折叠目标 id', async () => {
    const html = await render([qoderProvider()])
    expect(html).toContain("toggleCollapse('qdwrap-qoder'")
    expect(html).toContain('id="qdwrap-qoder" class="hd"')
    expect(html).toContain("toggleCollapse('qdext-qoder'")
    expect(html).toContain('id="qdext-qoder" class="hd"')
    // 默认收起：aria-expanded=false + 内容容器带 hd
    expect(html).toMatch(/aria-expanded="false"[^>]*><i class="fas fa-chevron-right collapse-icon"[^>]*><\/i> 真机设备身份/)
  })

  it('状态徽章在折叠体之外（收起时仍能看到「已配置/未配置」）', async () => {
    const html = await render([qoderProvider()])
    const badgeAt = html.indexOf('class="mu qoder-device-state"')
    const bodyAt = html.indexOf('id="qdwrap-qoder" class="hd"')
    expect(badgeAt).toBeGreaterThan(-1)
    expect(bodyAt).toBeGreaterThan(-1)
    expect(badgeAt).toBeLessThan(bodyAt)
  })

  it('失效判断与恢复路径写在说明里（用户会问「这值会过期吗」）', async () => {
    const html = await render([qoderProvider()])
    expect(html).toContain('不会按时间过期')
    expect(html).toContain('重新提取一次覆盖保存即可')
    expect(html).toContain('showCampaign:false')
  })
})
