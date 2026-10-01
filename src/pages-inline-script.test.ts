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
  // 结束标签按 HTML 解析器的实际行为匹配：`</script` 之后空格、斜杠、制表/换行或任意属性杂字符
  // 直到 `>` 都算合法结束标签（script-data-end-tag-open-state → before-attribute-name），
  // 所以用 `[^>]*`；只写 `</script>`（或只放行 `\s*\/?>`）会漏掉 `</script >`、`</script\t\n bar>`
  // 这类块 —— 漏掉就等于少校验一段客户端脚本（CodeQL js/bad-tag-filter 亦会报）。
  const re = /<script([^>]*)>([\s\S]*?)<\/script[^>]*>/gi
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

/**
 * 抽取客户端「7 天内到期」判定纯函数块（WB_EXPIRY_BEGIN/END 标记之间），
 * 用桩 escapeHtml 实例化后直接跑行为断言。
 *
 * 为什么要单独跑：这段是后端挑号规则（src/credit-expiry.ts：CST 墙钟解释 + remain>0 +
 * 7 天窗口含边界）在浏览器侧的镜像。只做"存在性 + 语法"检查的话，口径漂移
 * （比如把窗口写成 3 天、把 remain 判定漏掉）在 UI 上完全看不出来，但徽章会误导使用者。
 */
function wbExpiryApi(html: string): any {
  const js = inlineScripts(html).join('\n')
  const m = js.match(/\/\* WB_EXPIRY_BEGIN \*\/([\s\S]*?)\/\* WB_EXPIRY_END \*\//)
  if (!m) throw new Error('未找到 WB_EXPIRY 标记块：客户端到期判定块被删除或改名了？')
  const factory = new Function(
    'escapeHtml',
    m[1] + '\nreturn { wbParseCstWallClock, wbPackExpiring7d, wbPackExpireHtml, wbExpiringBadge, wbPackageDisplayList, traePackDisplayList, WB_EXPIRY_WINDOW_MS }'
  )
  return factory((s: unknown) => String(s))
}

describe('WorkBuddy 面板「即将到期」标记（客户端口径 = 后端挑号口径）', () => {
  const DAY = 24 * 60 * 60 * 1000
  /** 构造一个包：expireInMs=null → 长期（expireAt 空串），CST 墙钟串由 epoch 反推。 */
  const pkg = (expireInMs: number | null, over: { name?: string; size?: number; used?: number } = {}) => {
    const at = expireInMs === null ? '' : (() => {
      const d = new Date(Date.now() + expireInMs + 8 * 3600_000)
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    })()
    return { name: over.name ?? '包', expireAt: at, size: over.size ?? 100, used: over.used ?? 0 }
  }

  it('到期串按 CST(+08:00) 解释，而不是浏览器本地/UTC', async () => {
    const api = wbExpiryApi(await render([traeProvider()]))
    expect(api.wbParseCstWallClock('2026-09-30 23:59:59')).toBe(Date.UTC(2026, 8, 30, 15, 59, 59))
    expect(api.wbParseCstWallClock('2026-09-30 23:59:59 UTC+8')).toBe(Date.UTC(2026, 8, 30, 15, 59, 59))
    expect(Number.isNaN(api.wbParseCstWallClock(''))).toBe(true)
    expect(Number.isNaN(api.wbParseCstWallClock(undefined))).toBe(true)
  })

  it('窗口 7 天含边界；8 天外、长期、已用尽、已过期都不计入', async () => {
    const api = wbExpiryApi(await render([traeProvider()]))
    const now = Date.now()
    const soon = api.wbPackExpiring7d([
      pkg(2 * DAY, { name: 'soon' }),
      pkg(api.WB_EXPIRY_WINDOW_MS + 3600_000, { name: 'out' }), // 窗口外
      pkg(null, { name: 'long' }),                              // 长期
      pkg(1 * DAY, { name: 'empty', size: 10, used: 10 }),       // 已用尽
      pkg(-1 * DAY, { name: 'expired' }),                       // 已过期
    ], now)
    expect(soon.map((p: any) => p.name)).toEqual(['soon'])
    // 边界：正好 7 天（略减 1 分钟抵消取整）仍算窗口内
    const edge = api.wbPackExpiring7d([pkg(api.WB_EXPIRY_WINDOW_MS - 60_000, { name: 'edge' })], now)
    expect(edge).toHaveLength(1)
  })

  it('按到期升序返回，徽章显示数量与最早到期包的信息', async () => {
    const api = wbExpiryApi(await render([traeProvider()]))
    const pkgs = [pkg(5 * DAY, { name: 'later' }), pkg(1 * DAY, { name: 'sooner' })]
    const soon = api.wbPackExpiring7d(pkgs)
    expect(soon.map((p: any) => p.name)).toEqual(['sooner', 'later'])
    const badge = api.wbExpiringBadge(pkgs)
    expect(badge).toContain('⏳ 2 个包 7 天内到期')
    expect(badge).toContain('sooner')
    // 无待救积分（长期 + 已用尽）→ 不渲染徽章
    expect(api.wbExpiringBadge([pkg(null), pkg(1 * DAY, { size: 5, used: 5 })])).toBe('')
    expect(api.wbExpiringBadge(undefined)).toBe('')
  })

  it('到期时间单元格四态：长期 / 已过期 / 7 天内琥珀+优先消耗 / 更远期无色', async () => {
    const api = wbExpiryApi(await render([traeProvider()]))
    expect(api.wbPackExpireHtml('')).toContain('长期')
    expect(api.wbPackExpireHtml(pkg(-1 * DAY).expireAt)).toContain('已过期')
    const soonHtml = api.wbPackExpireHtml(pkg(2 * DAY).expireAt)
    expect(soonHtml).toContain('d97706')
    expect(soonHtml).toContain('优先消耗')
    const farHtml = api.wbPackExpireHtml(pkg(30 * DAY).expireAt)
    expect(farHtml).toContain('inherit')
    expect(farHtml).not.toContain('优先消耗')
  })

  it('WorkBuddy 账号行已接上徽章与新的到期渲染（折叠表 + 池状态优先）', async () => {
    // 用 browser 登录流提供商渲染：WorkBuddy 池面板（含新文案）只在该分支出现
    const html = await render([{
      ...traeProvider(),
      id: 'workbuddy',
      name: 'WorkBuddy',
      authType: 'oauth-device',
      oauth: { flowType: 'browser' },
    } as Provider])
    const js = inlineScripts(html).join('\n')
    expect(js).toContain('function wbExpiringBadge')
    expect(js).toContain('function wbPackExpireHtml')
    // 数据源：池状态 a.packages 优先，回退签到结果 ci.packages
    expect(js).toContain('Array.isArray(a.packages) ? a.packages')
    expect(js).toContain('wbExpiringBadge(pkgs)')
    expect(js).toContain('wbPackExpireHtml(p.expireAt)')
    // 静态说明文案已声明新规则
    expect(html).toContain('7 天内到期的积分优先消耗')
  })

  it('展示列表：已用完的包被隐藏，快到期的排最上面（两个面板同口径）', async () => {
    const api = wbExpiryApi(await render([traeProvider()]))

    // ---- WorkBuddy：size>0 且无剩余 = 已用完 → 隐藏；容量未下发（size 0）不隐藏 ----
    const wbPacks = [
      pkg(30 * DAY, { name: '远期' }),
      pkg(2 * DAY, { name: '即将到期' }),
      pkg(null, { name: '长期' }),
      pkg(1 * DAY, { name: '用完了', size: 100, used: 100 }),
      pkg(1 * DAY, { name: '超额用完', size: 100, used: 130 }),
      pkg(3 * DAY, { name: '容量未下发', size: 0, used: 0 }),
    ]
    const wb = api.wbPackageDisplayList(wbPacks)
    expect(wb.total).toBe(6)
    expect(wb.hidden).toBe(2)
    // 到期升序、长期最后；容量未下发（无到期键 → 长期）排在长期组
    expect(wb.rows.map((p: any) => p.name)).toEqual(['即将到期', '容量未下发', '远期', '长期'])
    // 不改入参（renderOauthPoolAccounts 复用同一数组算徽章）
    expect(wbPacks).toHaveLength(6)
    // 全部用完 → 展示列表为空（面板据此显示「已全部用完」而不是空表）
    expect(api.wbPackageDisplayList([pkg(1 * DAY, { size: 10, used: 10 })]).rows).toEqual([])

    // ---- TRAE：limit>0 且剩余<=0 = 已用完 → 隐藏；limit 未下发（0）不隐藏 ----
    const traePacks = [
      { name: '远期', limit: 100, used: 0, rem: 100, isWork: false, expireAt: 3000 },
      { name: '即将到期', limit: 100, used: 0, rem: 100, isWork: false, expireAt: 1000 },
      { name: '长期', limit: 100, used: 0, rem: 100, isWork: false, expireAt: 0 },
      { name: '用完了', limit: 100, used: 100, rem: 0, isWork: false, expireAt: 1200 },
      { name: '容量未下发', limit: 0, used: 0, rem: 0, isWork: true, expireAt: 2000 },
    ]
    const tr = api.traePackDisplayList(traePacks)
    expect(tr.total).toBe(5)
    expect(tr.hidden).toBe(1)
    expect(tr.rows.map((p: any) => p.name)).toEqual(['即将到期', '容量未下发', '远期', '长期'])
    expect(traePacks).toHaveLength(5)

    // 空 / 缺省 / 脏数据不炸
    expect(api.wbPackageDisplayList(null)).toEqual({ rows: [], hidden: 0, total: 0 })
    expect(api.traePackDisplayList(undefined)).toEqual({ rows: [], hidden: 0, total: 0 })
  })

  it('两个面板已改用展示列表（隐藏已用完 + 到期优先排序 + 隐藏计数提示）', async () => {
    const html = await render([{
      ...traeProvider(), id: 'workbuddy', name: 'WorkBuddy', authType: 'oauth-device', oauth: { flowType: 'browser' },
    } as Provider])
    const js = inlineScripts(html).join('\n')
    expect(js).toContain('const pkgDisp = wbPackageDisplayList(pkgs)')
    expect(js).toContain('const disp = traePackDisplayList(packs)')
    expect(js).toContain('个已隐藏')
    expect(js).toContain('个包已全部用完')
  })
})

/**
 * DeepSeek App（token 注入型）面板：上游硬卡密码登录，凭据只能从浏览器取一次。
 * 面板必须把「怎么取 token」讲清楚，否则这个 provider 无法被使用。
 */
function deepseekProvider(): Provider {
  return {
    id: 'deepseek-app',
    name: 'DeepSeek App',
    baseUrl: 'https://chat.deepseek.com',
    apiType: 'openai',
    apiKeys: [],
    models: [{ id: 'deepseek-flash', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  }
}

describe('DeepSeek App token 注入面板', () => {
  it('为 deepseek-app 渲染面板，且把取 token 的四步写进界面', async () => {
    const html = await render([deepseekProvider()])
    expect(html).toContain('id="ds-fs-deepseek-app"')
    // 四步指引的要点必须在页面上（少一步用户就取不到凭据）
    expect(html).toContain('Local Storage')
    expect(html).toContain('userToken')
    expect(html).toContain('deepseek-device-id:chat')
    // 按钮绑定
    expect(html).toContain("deepseekTokenAdd('deepseek-app')")
    expect(html).toContain("deepseekTokenList('deepseek-app')")
    // 列表容器（展开时自动加载依赖它）
    expect(html).toContain('id="ds-list-deepseek-app"')
  })

  it('客户端函数与展开自动加载钩子都在脚本里', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    for (const fn of ['deepseekTokenList', 'deepseekTokenAdd', 'deepseekTokenVerify', 'deepseekTokenRemove']) {
      expect(js).toContain(`function ${fn}`)
    }
    expect(js).toContain("document.getElementById('ds-list-' + id)")
    // 面板走的是管理接口，不能拼错路径
    expect(js).toContain("'/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens'")
    expect(js).toContain("'/tokens/verify'")
    expect(js).toContain("'/tokens/remove'")
  })

  it('含 DeepSeek 提供商时内联脚本仍能通过 JS 解析（\\\' 转义铁律）', async () => {
    const html = await render([deepseekProvider(), traeProvider()])
    const scripts = inlineScripts(html)
    expect(scripts.length).toBeGreaterThan(0)
    for (let i = 0; i < scripts.length; i++) {
      expect(() => new Function(scripts[i]), `内联 script #${i} 语法错误`).not.toThrow()
    }
  })

  it('非 DeepSeek 提供商不渲染该面板（不误伤别的 provider）', async () => {
    const html = await render([{
      id: 'plain', name: 'plain', baseUrl: 'https://example.com/v1', apiType: 'openai',
      apiKeys: [], models: [{ id: 'm1', enabled: true }], enabled: true, createdAt: 'a', updatedAt: 'a',
    }])
    expect(html).not.toContain('id="ds-fs-plain"')
    // 但函数仍在脚本里（共享脚本），语法必须合法
    for (const s of inlineScripts(html)) expect(() => new Function(s)).not.toThrow()
  })
})

/**
 * 「厂商预设」下拉里必须有 deepseek-app。
 *
 * 事故背景（2026-09-30 线上）：deepseek-app 的 token 注入面板只在**已存在的**提供商
 * 详情页渲染，而它当时没被加进 PROVIDER_PRESETS —— 于是「添加提供商」界面上根本没有
 * 这个入口，用户无从创建，功能等于不可用。这类「模块齐了但入口没接」的缺口不会被
 * 类型检查发现，只能由断言下拉内容来兜住。
 */
describe('厂商预设下拉必须包含 deepseek-app（添加入口不可缺失）', () => {
  it('SSR 下拉里出现 DeepSeek App 选项', async () => {
    const html = await render([deepseekProvider()])
    // 预设 select 的 option 由 PROVIDER_PRESETS 渲染，value 用预设键名
    expect(html).toContain('<option value="deepseek-app">')
    expect(html).toContain('DeepSeek App')
  })

  it('预置了唯一的模型 deepseek-flash，避免用户手填错 ID', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    // 预设数据注入到客户端脚本，供 applyProviderPreset 消费
    expect(js).toContain('"deepseek-app"')
    expect(js).toContain('deepseek-flash')
    // 选中预设后要给出「创建后去详情页注入 token」的提示，而不是让 Key 留空无解释
    expect(js).toContain('function applyDeepseekKeyHint')
  })

  it('选中预设后填好 ID / 地址，创建时无需手填', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    // baseUrl 必须落在 isDeepseekAppProviderUI / isDeepseekAppProvider 的判定域内
    expect(js).toContain('https://chat.deepseek.com')
  })
})