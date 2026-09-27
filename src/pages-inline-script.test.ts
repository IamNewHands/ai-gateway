/**
 * pages-inline-script.test.ts — 校验 pages.ts 渲染出的内联 <script> 是合法 JS。
 *
 * 为什么需要：pages.ts 是一个巨型 TS 模板字面量，客户端 JS 对 tsc 而言只是字符串，
 * 语法错误不会被 tsc 或 esbuild 发现，只会在浏览器控制台报 "xxx is not defined"，
 * 极难排查（见 pages.ts 文件头铁律 #5：改完必须 node --check 生成的 <script> 内容）。
 *
 * 本测试用 new Function() 等价地做同一件事：把每个 <script> 块内容交给 JS 解析器，
 * 任何语法错误（含 \\' 转义写错导致的字符串提前闭合）都会立即失败。
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from './types'
import { renderAdminPage } from './pages'
import { setProviders } from './storage'

function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
  }
  return { KV: kv } as unknown as AppEnv['Bindings']
}

/** 含 TRAE 提供商的播种数据：确保 TRAE 账号池面板（本次改动区域）被渲染出来。 */
function traeProvider(): Provider {
  return {
    id: 'trae',
    name: 'TRAE SOLO',
    baseUrl: 'https://trae-api-cn.mchost.guru',
    apiType: 'openai',
    apiKeys: [{ key: JSON.stringify({ uid: 'u1', accessToken: 't', refreshToken: 'r', expiresAt: 1 }), enabled: true }],
    models: [{ id: 'glm-5.2', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  }
}

async function render(providers: Provider[]): Promise<string> {
  const app = new Hono<AppEnv>()
  app.get('/admin', (c) => renderAdminPage(c))
  const env = makeEnv()
  await setProviders(env as never, providers)
  const res = await app.request('/admin', {}, env as never)
  return await res.text()
}

/**
 * 抽取所有「可执行 JS」的内联 <script> 块内容。
 * 排除两类非 JS 块：
 *  - 带 src 的外链脚本
 *  - 带 type 且非 JS 的块（如 <script type="text/plain" id="eff-dd-tpl"> 模板数据块，
 *    其内容是 HTML 片段，交给 JS 解析器必然报 "Unexpected token '<'"）
 */
function inlineScripts(html: string): string[] {
  const out: string[] = []
  // 结束标签允许 `</script >` / `</script/>`（HTML 解析器接受空白与斜杠，见
  // script-data-end-tag-open-state）；写成 `<\/script>` 会漏掉这类块，
  // 漏掉就等于少校验一段客户端脚本（CodeQL js/bad-tag-filter 亦会报）。
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*\/?>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || ''
    if (/\bsrc=/i.test(attrs)) continue
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase()
      const isJs = t === 'text/javascript' || t === 'application/javascript' || t === 'module'
      if (!isJs) continue
    }
    out.push(m[2])
  }
  return out
}

describe('管理页内联脚本语法（pages.ts 模板转义铁律 #5）', () => {
  it('渲染含 TRAE 提供商的页面：每个内联 <script> 都能被 JS 解析器接受', async () => {
    const html = await render([traeProvider()])
    const scripts = inlineScripts(html)
    // 至少要有内联脚本（主控制台脚本 + 数据注入）
    expect(scripts.length).toBeGreaterThan(0)
    for (let i = 0; i < scripts.length; i++) {
      // new Function 只解析不执行，等价于 node --check：语法错误即刻抛出
      expect(
        () => new Function(scripts[i]),
        `内联 script #${i} 存在语法错误（多半是 \\' 转义写成了单反斜杠）`
      ).not.toThrow()
    }
  })

  it('新增的 TRAE 积分明细渲染函数已进入客户端脚本，且折叠绑定标记存在', async () => {
    const html = await render([traeProvider()])
    const js = inlineScripts(html).join('\n')
    expect(js).toContain('function traePackExpireHtml')
    expect(js).toContain('function traePackDetailHtml')
    // 折叠按钮绑定标记：无账号时不会渲染 data-traepkg 元素，但绑定代码必须在
    expect(js).toContain('data-traepkg')
    // 到期时间三态渲染分支
    expect(js).toContain('长期')
    expect(js).toContain('已过期')
    expect(js).toContain('积分明细')
  })

  it('无 TRAE 提供商时同样语法合法（新增代码不依赖 TRAE 存在）', async () => {
    const html = await render([{
      id: 'plain', name: 'plain', baseUrl: 'https://example.com/v1', apiType: 'openai',
      apiKeys: [], models: [{ id: 'm1', enabled: true }], enabled: true, createdAt: 'a', updatedAt: 'a',
    }])
    for (const s of inlineScripts(html)) {
      expect(() => new Function(s)).not.toThrow()
    }
  })
})