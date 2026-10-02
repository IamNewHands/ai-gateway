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
import { renderAdminPage, CLINE_UP_UI_VERSION } from './pages'
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

/** 含 Cline 提供商的播种数据：面板区块（上游渠道与固定）只在 cline 提供商上渲染。 */
function clineProvider(): Provider {
  return {
    id: 'cline',
    name: 'Cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    apiType: 'openai',
    apiKeys: [{ key: 'rt-cline-test', enabled: true }],
    models: [{ id: 'cline-free/deepseek-v4.1-flash', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  } as unknown as Provider
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

/**
 * 抽取客户端「Cline 上游渠道」纯映射块（CLINE_UP_BEGIN/END 标记之间）。
 *
 * 为什么单独跑：状态→徽章映射与成本文案是面板使用者的**判断依据**——把「限流」显示成不可用
 * 会让人白白换渠道，把校验成本算错会让人误以为可以随手全跑（校验是逐渠道真实请求且串行，
 * 会占用 Cline 队列）。只做语法/存在性检查看不出这类口径漂移。
 */
function clineUpApi(html: string): any {
  const js = inlineScripts(html).join('\n')
  const m = js.match(/\/\* CLINE_UP_BEGIN \*\/([\s\S]*?)\/\* CLINE_UP_END \*\//)
  if (!m) throw new Error('未找到 CLINE_UP 标记块：客户端渠道映射块被删除或改名了？')
  const factory = new Function(m[1] + '\nreturn { clineUpBadge, clineUpCostText, clineUpPinSummary, clineUpState, clineUpNextState, clineUpApplyState, clineUpChannelBadge, clineUpChannelTitle, clineUpExcludeUnresolved }')
  return factory()
}

describe('Cline 面板「上游渠道与固定」客户端映射', () => {
  it('限流显示为可用但暂忙（黄色），不能显示成不可用——否则会误导用户换渠道', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpBadge('ok')).toEqual(['bd-on', '可用'])
    expect(api.clineUpBadge('limited')).toEqual(['bd-warn', '限流'])
    expect(api.clineUpBadge('bad')).toEqual(['bd-danger', '不可钉'])
    expect(api.clineUpBadge('auth')).toEqual(['bd-danger', '认证失败'])
    // 未知状态不猜可用：默认是中性徽章而不是绿色
    expect(api.clineUpBadge('nonsense')[0]).toBe('bd-off')
  })

  it('校验成本按「渠道数 × 队列间隔」换算，并说明会阻塞其它 Cline 请求', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpCostText(0, 800)).toBe('')
    expect(api.clineUpCostText(16, 800)).toContain('16 次')
    expect(api.clineUpCostText(16, 800)).toContain('13 秒')
    expect(api.clineUpCostText(16, 800)).toContain('排队')
    // 间隔缺省回落 800ms（与后端 MIN_GAP_MS 一致）
    expect(api.clineUpCostText(10)).toContain('8 秒')
  })

  it('固定摘要区分「只用这几个/优先」并带排序（面板回显用）', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpPinSummary(null)).toBe('')
    expect(api.clineUpPinSummary({ upstreams: [] })).toBe('')
    expect(api.clineUpPinSummary({ upstreams: ['alibaba'] })).toBe('alibaba · 只用这几个')
    expect(api.clineUpPinSummary({ upstreams: ['alibaba'], pinMode: 'preferred' })).toBe('alibaba · 优先')
    expect(api.clineUpPinSummary({ upstreams: ['alibaba'], pinMode: 'strict', sort: 'cost' })).toBe('alibaba · 只用这几个 · cost')
    // 多选：只列第一个 + 总数，避免十几个渠道把摘要撑爆
    expect(api.clineUpPinSummary({ upstreams: ['a', 'b', 'c'], pinMode: 'preferred' })).toBe('a 等 3 个 · 优先')
  })

  it('固定摘要必须回显排除项（否则用户改完排除会以为没保存上）', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpPinSummary({ exclude: ['wafer', 'novita'] })).toBe('不指定渠道 · 排除 2 个')
    expect(api.clineUpPinSummary({ upstreams: ['alibaba'], exclude: ['wafer'] })).toBe('alibaba · 只用这几个 · 排除 1 个')
    // 与后端同口径：exclude 优先于 upstreams —— 同一个渠道既勾选又排除时，勾选作废
    expect(api.clineUpPinSummary({ upstreams: ['wafer'], exclude: ['wafer'] })).toBe('不指定渠道 · 排除 1 个')
  })

  it('点徽章三态循环：自动 → 勾选 → 排除 → 自动（两个列表互斥）', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpState({}, 'a')).toBe('auto')
    expect(api.clineUpState({ upstreams: ['a'] }, 'a')).toBe('allow')
    expect(api.clineUpState({ exclude: ['a'] }, 'a')).toBe('deny')
    expect(api.clineUpNextState('auto')).toBe('allow')
    expect(api.clineUpNextState('allow')).toBe('deny')
    expect(api.clineUpNextState('deny')).toBe('auto')

    expect(api.clineUpApplyState({}, 'a', 'allow')).toEqual({ upstreams: ['a'], exclude: [] })
    // 勾选 → 排除：先从 upstreams 摘掉再进 exclude —— 互斥，不可能同时出现在两边
    expect(api.clineUpApplyState({ upstreams: ['a', 'b'], exclude: ['c'] }, 'a', 'deny'))
      .toEqual({ upstreams: ['b'], exclude: ['c', 'a'] })
    // 排除 → 自动：两个列表里都摘掉
    expect(api.clineUpApplyState({ upstreams: ['a'], exclude: ['b'] }, 'b', 'auto'))
      .toEqual({ upstreams: ['a'], exclude: [] })
  })

  it('徽章状态类与序号：勾选带序号、排除划线、自动中性', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpChannelBadge('ok', 'auto', 0)).toEqual(['bd-on', '可用'])
    expect(api.clineUpChannelBadge('ok', 'allow', 2)).toEqual(['bd-on is-allowed', '2 可用'])
    expect(api.clineUpChannelBadge('limited', 'deny', 0)).toEqual(['bd-warn is-excluded', '✕ 限流'])
    // 悬停说明必须写出「再点一下会变成什么」，否则三态循环只能靠试
    expect(api.clineUpChannelTitle('allow', 'x')).toContain('勾选')
    expect(api.clineUpChannelTitle('allow', 'x')).toContain('永不使用')
  })

  it('「配了排除但清单缺失 → 排除未生效」必须能在面板上标出来（留档 7 天过期就属于这种）', async () => {
    const api = clineUpApi(await render([traeProvider()]))
    expect(api.clineUpExcludeUnresolved({ exclude: ['wafer'] }, { upstreams: ['alibaba'] })).toBe(false)
    expect(api.clineUpExcludeUnresolved({ exclude: ['wafer'] }, { upstreams: [] })).toBe(true)
    expect(api.clineUpExcludeUnresolved({ exclude: ['wafer'] }, undefined)).toBe(true)
    // 没配排除就不该报警
    expect(api.clineUpExcludeUnresolved({ upstreams: ['alibaba'] }, { upstreams: [] })).toBe(false)
    expect(api.clineUpExcludeUnresolved(null, {})).toBe(false)
  })

  // 2026-10-06 用户反馈：「固定到 / 模式 / 排序 三个字段选字框里字显示不全」。
  // 根因是全局 select{width:100%} 撞上 .tbl td{min-width:0}，在 auto 表格布局里被压到比选中项还窄。
  it('面板表格里的下拉按内容自适应，且控件列按内容定宽（否则选中项又被裁）', async () => {
    const html = await render([traeProvider()])
    const js = inlineScripts(html).join('\n')
    expect(html).toMatch(/\.tbl select[^{]*\{[^}]*width:\s*auto/)
    expect(html).toMatch(/\.tbl td\.cell-fit[^{]*\{[^}]*width:\s*1%/)
    // 规则不能是死的：模型行里的控件单元格都得带上 cell-fit（模型/模式/排序/操作）
    expect((js.match(/class="cell-fit"/g) || []).length).toBeGreaterThanOrEqual(4)
    // 三种渠道状态必须一眼可分（勾选实心边 / 排除划线），否则「看不出哪个被排除了」会反复出现
    expect(html).toMatch(/button\.bd\.is-excluded[^{]*\{[^}]*text-decoration:\s*line-through/)
    expect(html).toMatch(/button\.bd\.is-allowed[^{]*\{[^}]*box-shadow/)
  })

  it('面板带脚本版本戳（没有它就无法判断浏览器是否加载了新脚本）', async () => {
    const html = await render([clineProvider()])
    expect(html).toContain('面板脚本 ' + CLINE_UP_UI_VERSION)
    // 非 cline 提供商不该渲染这个区块（不误伤别的 provider）
    expect(await render([traeProvider()])).not.toContain('面板脚本 ' + CLINE_UP_UI_VERSION)
  })
})

/**
 * 面板渲染与保存的 DOM 替身 harness。
 *
 * 为什么必须写：面板的「点击 → 改状态 → 重渲染 → 即时 PUT → 用服务端结果回渲染」全在客户端，
 * tsc 与内联脚本语法检查都看不出「保存时读 DOM 而不是读状态」「保存后不回渲染」这类错。
 * 2026-10-06 用户报的「模式/排序/排除保存后不生效」正属于这一类，而当时 8 个用例全绿——
 * 因为它们只覆盖了纯映射函数。这里直接断言**渲染出的 HTML** 与 **PUT 的载荷**。
 */
function makePanel(html: string) {
  const js = inlineScripts(html).join('\n')
  const ui = js.match(/\/\* CLINE_UP_UI_BEGIN \*\/([\s\S]*?)\/\* CLINE_UP_UI_END \*\//)
  const pure = js.match(/\/\* CLINE_UP_BEGIN \*\/([\s\S]*?)\/\* CLINE_UP_END \*\//)
  if (!ui || !pure) throw new Error('未找到 CLINE_UP / CLINE_UP_UI 标记块：面板渲染/保存块被删除或改名了？')

  const box = { innerHTML: '', querySelectorAll: (_sel: string) => [] as any[] }
  const status = { textContent: '' }
  const document = {
    getElementById: (id: string) => (id === 'cu-tb-cline' ? box : (id === 'cu-st-cline' ? status : null)),
  }
  const net = {
    /** 默认 null = 回显请求载荷（模拟「存下来的就是发上去的」）；用例可覆盖成归一后的结果。 */
    reply: null as any,
    calls: [] as Array<{ url: string; body: any }>,
  }
  // 徽章按钮替身：从渲染出的 HTML 里抠出 data-cu-* 属性，渲染时挂上的 onclick 会被保留在
  // 这些对象上（每次 querySelectorAll 返回同一批引用），测试才能真的「点」它们。
  let badgeEls: any[] = []
  box.querySelectorAll = (sel: string) => {
    if (sel !== '[data-cu-ch]') return []
    const out: any[] = []
    const re = /data-cu-row="(\d+)" data-cu-ch="(\d+)"/g
    let mm: RegExpExecArray | null
    while ((mm = re.exec(box.innerHTML)) !== null) {
      const attrs: Record<string, string> = { 'data-cu-row': mm[1], 'data-cu-ch': mm[2] }
      out.push({ getAttribute: (k: string) => attrs[k] ?? null })
    }
    badgeEls = out
    return out
  }
  const fetchStub = (url: string, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'))
    net.calls.push({ url, body })
    const reply = net.reply ?? { success: true, data: { clinePinByModel: body.clinePinByModel } }
    return Promise.resolve({ json: async () => reply })
  }
  const factory = new Function(
    'document', 'fetch', 'escapeHtml',
    pure[1] + '\n' + ui[1] + '\nreturn {' +
      ' setData: function (d) { _clineUpData["cline"] = d },' +
      ' pins: function () { return _clineUpData["cline"].pins },' +
      ' render: clineUpstreamsRender, save: clineUpstreamsSave, bulk: clineUpstreamsBulk,' +
      ' queue: queueProviderWrite }'
  )
  const api = factory(document, fetchStub, (s: string) => String(s))
  return { api, box, status, net, badges: () => badgeEls }
}

describe('Cline 面板：渲染回显与即时保存（DOM 替身驱动客户端代码）', () => {
  const probe = (upstreams: string[]) => ({ M: { upstreams, pipeline: 'planner' } })
  /** 排空微任务：保存链有 4 层 then，只 await 一个 Promise.resolve() 清不掉 in-flight 标记。 */
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('渲染回显：勾选带序号、排除带划线态、模式/排序按服务端数据选中', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({
      models: ['M'],
      pins: { M: { upstreams: ['alibaba', 'novita'], pinMode: 'preferred', sort: 'cost', exclude: ['wafer'] } },
      probes: probe(['alibaba', 'novita', 'wafer']),
      checks: {},
    })
    p.api.render('cline')
    const html = p.box.innerHTML
    // 用户报的「重进看不出哪个被排除了」：排除态必须回到渲染结果里
    expect(html).toContain('bd-off is-excluded')
    expect(html).toContain('✕ 未知')
    expect(html).toMatch(/is-allowed/)
    expect(html).toMatch(/value="preferred" selected/)
    expect(html).toMatch(/value="cost" selected/)
    // 勾选序号 = 优先顺序（多选时用户要能看出网关先试谁）
    expect(html).toContain('1 未知')
    expect(html).toContain('2 未知')
  })

  it('点徽章 = 三态循环 + 即时保存；PUT 载荷是本地整表（含刚点出来的排除）', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({ models: ['M'], pins: {}, probes: probe(['alibaba', 'wafer']), checks: {} })
    p.api.render('cline')
    expect(p.badges()).toHaveLength(2)

    p.badges()[1].onclick() // wafer：自动 → 勾选
    await flush()
    expect(p.api.pins().M.upstreams).toEqual(['wafer'])
    expect(p.net.calls[0].body).toEqual({ clinePinByModel: { M: { upstreams: ['wafer'], pinMode: 'strict' } } })

    p.badges()[1].onclick() // wafer：勾选 → 排除
    await flush()
    expect(p.api.pins().M.exclude).toEqual(['wafer'])
    // 载荷里必须没有 upstreams：勾选与排除互斥，切到排除时勾选要被摘掉
    expect(p.net.calls[1].body).toEqual({ clinePinByModel: { M: { exclude: ['wafer'] } } })

    p.badges()[1].onclick() // wafer：排除 → 自动
    await flush()
    expect(p.net.calls[2].body).toEqual({ clinePinByModel: {} })
  })

  it('保存后用**服务端返回的**结果回渲染（面板显示的是存下来的，不是我以为的）', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({
      models: ['M'],
      pins: { M: { upstreams: ['alibaba'], pinMode: 'strict' } },
      probes: probe(['alibaba']),
      checks: {},
    })
    // 服务端归一后多出 sort、少掉 pinMode —— 面板必须照服务端的来
    p.net.reply = { success: true, data: { clinePinByModel: { M: { upstreams: ['alibaba'], sort: 'cost' } } } }
    await p.api.save('cline')
    expect(p.box.innerHTML).toMatch(/value="cost" selected/)
    expect(p.box.innerHTML).toMatch(/value="strict" selected/)
    expect(p.status.textContent).toContain('已保存')
  })

  it('保存失败：不回渲染、状态行明确说「改动未存」（不能假装成功）', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({ models: ['M'], pins: { M: { exclude: ['wafer'] } }, probes: probe(['wafer']), checks: {} })
    p.net.reply = { success: false, message: '提供商不存在' }
    await p.api.save('cline')
    expect(p.status.textContent).toContain('保存失败')
    expect(p.status.textContent).toContain('改动未存')
  })

  it('全选按可用状态排序（顺序 = 推荐优先级），清空回到自动', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({
      models: ['M'],
      pins: { M: { exclude: ['wafer'] } },
      probes: probe(['baseten', 'alibaba', 'wafer']),
      checks: { M: { baseten: { status: 'bad' }, alibaba: { status: 'ok' } } },
    })
    p.net.reply = { success: true, data: {} }
    p.api.bulk('cline', 'all')
    expect(p.api.pins().M.upstreams).toEqual(['alibaba', 'wafer', 'baseten'])
    expect(p.api.pins().M.exclude).toEqual([])
    await flush()

    p.api.bulk('cline', 'clear')
    expect(p.api.pins().M.upstreams).toEqual([])
    expect(p.api.pins().M.exclude).toEqual([])
  })

  // 2026-10-06 用户实测：「选完模式页面自动保存了，再点下面的保存更改，这次改动就丢了」。
  // 根因不是字段被覆盖，而是**丢更新**：服务端 PUT 是整份 providers 数组的读-改-写
  // （storage.ts updateProvider: getProvidersFresh → merge → setProviders），同页面两次并发 PUT
  // 中后写的那次带着先读的旧快照，把对方刚改的字段整块抹掉。修法：providers blob 的所有写者
  // 共用一条串行队列（面板即时保存 / 卡片「保存更改」/ 启用开关）。
  it('providers 的两次写必须串行：后一次要等前一次完成（否则并发 PUT 会丢更新）', async () => {
    const p = makePanel(await render([traeProvider()]))
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })

    const first = p.api.queue(async () => { order.push('a-start'); await gate; order.push('a-end') })
    const second = p.api.queue(async () => { order.push('b-start') })
    await flush()
    expect(order).toEqual(['a-start']) // 第二次必须还没开始

    release()
    await Promise.all([first, second])
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })

  it('面板即时保存走同一条写队列（被前一次写挡住时不发 PUT，放行后只发一次）', async () => {
    const p = makePanel(await render([traeProvider()]))
    p.api.setData({ models: ['M'], pins: { M: { upstreams: ['alibaba'] } }, probes: probe(['alibaba']), checks: {} })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const blocker = p.api.queue(() => gate)
    await flush()

    p.api.save('cline')
    await flush()
    expect(p.net.calls).toHaveLength(0) // 队列被占，PUT 还没发出去

    release()
    await blocker
    await flush()
    expect(p.net.calls).toHaveLength(1)
    expect(p.net.calls[0].body).toEqual({ clinePinByModel: { M: { upstreams: ['alibaba'], pinMode: 'strict' } } })
  })
})

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

  it('渲染「默认关闭深度思考」开关，且说明优先级', async () => {
    const html = await render([deepseekProvider()])
    expect(html).toContain('id="ds-thinkoff-deepseek-app"')
    expect(html).toContain('默认关闭深度思考')
    // 优先级必须写在界面上：否则用户勾了之后不知道个别请求还能开回来
    expect(html).toContain('客户端显式声明')
  })

  it('开关状态回显已保存的值（勾上后刷新仍是勾上）', async () => {
    const on = await render([{ ...deepseekProvider(), deepseekThinkingOff: true } as Provider])
    expect(on).toMatch(/id="ds-thinkoff-deepseek-app"[^>]*checked/)
    const off = await render([deepseekProvider()])
    expect(off).not.toMatch(/id="ds-thinkoff-deepseek-app"[^>]*checked/)
  })

  it('保存时把开关值发给后端（否则勾选丢失）', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    expect(js).toContain("document.getElementById('ds-thinkoff-' + id)")
    expect(js).toContain('deepseekThinkingOff')
  })

  /**
   * 处罚 park 的面板呈现。
   *
   * 为什么必须渲染：被封禁的 token 是**永久**停用，只有人工能解除。如果界面不显示
   * 「已封禁」和「解除停用」按钮，用户看到的只是「请求一直失败」，没有任何出路提示。
   */
  it('池列表渲染处罚状态与「解除停用」按钮（封禁只能人工解除）', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    expect(js).toContain('function deepseekTokenUnpark')
    expect(js).toContain("'/tokens/unpark'")
    expect(js).toContain('解除停用')
    // 三种处罚要分别显示成中文，而不是把 kind 原样吐出来
    expect(js).toContain('已封禁')
    expect(js).toContain('已禁言')
    expect(js).toContain('设备风险')
    // 永久 park 必须明确说「永久」，否则用户会等一个永远不来的解禁
    expect(js).toContain('永久')
    // 只有 park 的条目才出现解除按钮
    expect(js).toContain('t.parked ?')
  })

  it('池摘要里显示「已停用」计数与 park 提示', async () => {
    const js = inlineScripts(await render([deepseekProvider()])).join('\n')
    expect(js).toContain('已停用')
    expect(js).toContain('sum.parked')
  })

  it('面板说明里讲清「自动停用」机制与封禁需人工解除', async () => {
    const html = await render([deepseekProvider()])
    expect(html).toContain('禁言/封禁/判设备风险')
    expect(html).toContain('解除停用')
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