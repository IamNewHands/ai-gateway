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
