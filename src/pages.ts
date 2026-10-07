import { Context } from 'hono'
import { getProviders, getProxyKeys, getMcps, getUnimodels } from './storage'
import { SITE_CONFIG, OPENCODE_DEFAULT_URL } from './config'
import type { AppEnv, OAuthDeviceConfig } from './types'
import { CSS_CONTENT } from './pages.css'
import { baseUrlHostIs } from './url-host'
import { SHARED_JS, renderSiteFooter } from './shared.js'
import { ANALYTICS_JS } from './analytics-ui.js'
import { QODER_DEVICE_FIELDS } from './qoder/device'

// ============================================================================
// ⚠️ SSR 内联 JS 转义铁律（多次踩坑，改本文件前必读）
//
// 本文件是把 TypeScript 模板字符串（反引号）整体渲染成 <script> 内联脚本，
// 任何转义失误都会导致【整块脚本语法错误 → 后台所有按钮/函数失效】，且错误
// 只在浏览器控制台报 "xxx is not defined"，极难排查。铁律如下：
//
// 1. 想要渲染后 JS 里出现 \'（JS 字符串内的转义单引号），源文件必须写 \\'
//    （两个反斜杠）。写单反斜杠 \' 会在模板字符串里被解释成裸单引号 '，
//    使渲染出的 JS 单引号字符串提前闭合 → SyntaxError。
//    例：onclick="mcpSave(\\'' + id + '\\')"   ✅
//        onclick="mcpSave(\'' + id + '\')"    ❌（必炸）
//
// 2. 向 <script> 注入数据 JSON，一律用 serializeForScript()，禁止裸 JSON.stringify：
//    - 不转义 < 时，数据里的 </script> 会直接截断 HTML script 块；
//      <!-- 会开启 HTML 注释吞掉后续脚本。
//    - 数据里的 U+2028/U+2029（JS 行/段分隔符）会令字符串字面量非法。
//    例：const X = ${serializeForScript(data)};   ✅
//        const X = ${JSON.stringify(data)};       ❌
//
// 3. 页面 JS 内容中不得出现裸反引号 ` 或裸 ${（会被当作 TS 模板字符串边界/插值）。
//
// 4. 字符串值进 HTML 用 escapePageHtml()；进内联 JS 属性（onclick/onchange）
//    用 escapePageJs() / escapePageJsx()；不要混用。
//
// 5. 改完本文件脚本部分，务必重新渲染管理页并用 `node --check` 校验生成的
//    <script> 内容，或至少核对新写的 \' 均为 \\'。
//
// 以上同样适用于 ${SHARED_JS} / ${ANALYTICS_JS} 注入的 shared.js.ts / analytics-ui.js.ts。
// ============================================================================

// 前端页面模板：仅重构视觉与交互，保持后端路由、KV 结构和 API 契约不变。
const escapePageHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/**
 * JS 字符串字面量上下文转义（用于 onclick/onchange 等内联事件属性里的单引号字符串）。
 * 注意：escapePageHtml 只转 HTML 实体，属性解析时实体被还原，`'` 会破坏 JS 字符串——
 * 因此内联 JS 里的字符串插值必须用本函数（转义 \ ' " 与换行/制表符）。
 */
const escapePageJs = (value: unknown) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\t/g, '\\t')

/**
 * JS 字符串 → 内联事件属性 双转义：
 * 先按 JS 字符串转义（防 `'`/`"` 破坏 JS 字符串），再按 HTML 转义
 * （防 `"`/`'` 提前结束双/单引号 HTML 属性）。二者缺一不可。
 */
const escapePageJsx = (value: unknown) => escapePageHtml(escapePageJs(value))

/** 是否 TRAE SOLO 提供商（id 固定或用 trae 域，与 src/trae/proxy.ts isTraeProvider 对齐） */
const isTraeProviderUI = (p: { id?: string; baseUrl?: string }) =>
  p.id === 'trae' || (typeof p.baseUrl === 'string' && p.baseUrl.includes('trae'))

/** 是否 DeepSeek App 提供商（id 固定或用 chat.deepseek.com 域，与 src/deepseek/proxy.ts 对齐）。
 * 域名判定必须解析后比对 hostname（url-host.ts）：`includes('chat.deepseek.com')` 会把
 * `https://chat.deepseek.com.evil.com` 也认成自家上游。 */
const isDeepseekAppProviderUI = (p: { id?: string; baseUrl?: string }) =>
  p.id === 'deepseek-app' || baseUrlHostIs(p.baseUrl, 'chat.deepseek.com')

/** 是否商汤日日新（SenseNova）提供商（id 固定或用 token.sensenova.cn 域，与 src/admin.ts 对齐） */
const isSensenovaProviderUI = (p: { id?: string; baseUrl?: string }) =>
  p.id === 'sensenova' || (typeof p.baseUrl === 'string' && p.baseUrl.includes('token.sensenova.cn'))

/** 是否 CNB 提供商（id 固定或用 cnb.cool 域，与 src/cnb/proxy.ts isCnbProvider 对齐）。仅 CNB 需要工具桥。 */
const isCnbProviderUI = (p: { id?: string; baseUrl?: string }) =>
  p.id === 'cnb' || (typeof p.baseUrl === 'string' && p.baseUrl.includes('cnb.cool'))

/**
 * Cline 账号行：token 与「有效性徽章 + 账号名」同处一行（窗口窄时账号部分自动折行）。
 *
 * 为什么不做成两个 .field-row 上下叠：token 输入框会被拉满整行，一行只放一个
 * 字段太浪费横向空间（见 2026-10-02 反馈）。为什么不能简单塞进默认 .field-row：
 * 那条 CSS 是 `flex-wrap: nowrap`，nowrap 下 flex 项被压缩而不是换行，账号部分
 * 会把 token 输入框挤成一条缝——所以这里用 .cline-key-row 覆盖成 wrap，
 * 并给 token/账号两个输入框各自的 flex 基准（见 pages.css.ts）。
 */
/**
 * Cline 账号的运行状态徽章：冷却（额度耗尽 / 限流 / 凭据失效 / 推理空转）与「已禁用」。
 *
 * 为什么要单独一个徽章而不是再接一段文字：`kst-` 只说明「这条 token 能不能换 accessToken」，
 * 而用户真正要回答的是「这个账号现在能不能被用来转发」——一个 token 完全有效、但正在因为
 * 免费额度耗尽被冷却 12 小时的账号，旧的账号行里看不出任何异常（2026-10-02 反馈）。
 *
 * 为什么初始渲染只画「已禁用」：启用开关是页面上的本地事实，不用等任何请求；而冷却状态来自
 * KV 留档，只有点过「检测全部账号」才拿得到——拿不到就不画，绝不用猜测的绿/灰充数。
 */
const clineRunBadgeHtml = (pid: string, idx: number, enabled: boolean) =>
  enabled
    ? `<span class="bd bd-off" id="krun-${pid}-${idx}" style="display:none" title="该账号被冷却时在此显示原因与剩余时间"></span>`
    : `<span class="bd bd-off" id="krun-${pid}-${idx}" title="该密钥已禁用，不参与转发；勾选左侧开关即可启用">已禁用</span>`

const clineAcctFieldsHtml = (pid: string, idx: number, label?: string, enabled = true) =>
  `<span class="bd bd-off" id="kst-${escapePageHtml(pid)}-${idx}" title="点「测试」或「检测全部账号」后显示该 RefreshToken 是否仍可用">未检测</span>` +
  clineRunBadgeHtml(escapePageHtml(pid), idx, enabled) +
  `<input type="text" class="cline-lbl" id="klbl-${escapePageHtml(pid)}-${idx}" value="${escapePageHtml(label || '')}" placeholder="账号（自动关联邮箱；关联不到可手填）" aria-label="账号名（仅显示用）" onblur="clineSaveLabel('${escapePageJsx(pid)}',${idx})">` +
  `<span class="mu" style="font-size:12px" id="kmsg-${escapePageHtml(pid)}-${idx}"></span>`

/**
 * apiKey 单行。data-kidx 只挂在外层容器上：getKeys() 按 [data-kidx] 逐行收集，
 * 一行里出现两个带 data-kidx 的元素会让同一个 token 被收集两次。
 */
const keyRowHtml = (p: { id?: string }, k: { key: string; enabled: boolean; label?: string }, ki: number) => {
  const pid = escapePageHtml(p.id)
  const isCline = p.id === 'cline'
  const controls =
    `<input type="password" value="${escapePageHtml(k.key)}" class="${isCline ? 'cline-tok' : 'fx1'}" id="k-${pid}-${ki}" placeholder="API Key" aria-label="API Key">` +
    `<button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button>` +
    `<label class="tg"><input type="checkbox" ${k.enabled ? 'checked' : ''} id="ken-${pid}-${ki}" aria-label="启用 Key"><span class="sl"></span></label>` +
    `<button class="btn btn-gh btn-xs" onclick="testKeyRow('${escapePageJsx(p.id)}',${ki})" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button>` +
    `<button class="icon-btn" onclick="rmKeyRow('${escapePageJsx(p.id)}',${ki})" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button>`
  if (p.id !== 'cline') {
    return `<div class="fc mb-3 field-row" data-kidx="${ki}">${controls}</div>`
  }
  return `<div class="fc mb-3 field-row cline-key-row" data-kidx="${ki}">${controls}${clineAcctFieldsHtml(p.id!, ki, k.label, k.enabled)}` +
    `<span class="trt" id="ktr-${pid}-${ki}" aria-live="polite"></span></div>`
}

/**
 * 面板脚本版本戳：**改这一块的客户端行为就 bump 它**。
 * 为什么需要：面板 JS 是内联在页面里的，改完要等 CF 部署 + 浏览器刷新才生效；没有版本戳时
 * 「行为没变」到底是没部署、没刷新，还是代码就是错的，只能靠来回猜（2026-10-06 已经为这个
 * 浪费过一轮）。用户只要比对刷新前后这一行是否变化，就能自证加载的是不是新脚本。
 */
export const CLINE_UP_UI_VERSION = '2026-10-06-acct-state-2'

/**
 * Cline「上游渠道与固定」区块（移植 cline-pass-switcher 的控制台能力）。
 *
 * 交互基线（为什么这样排）：
 *  - 「探测」与「校验」刻意分成两个动作。探测是整模型一次请求——发一个不存在的渠道名让网关
 *    在路由层回吐清单，零 token、约 0.3s；校验则是**每个渠道一次真实最小请求**，而且免费通道
 *    并发 >1 会返回空响应，必须串行（间隔 800ms），16 个渠道约占用队列 13s、期间其它 Cline
 *    请求排队。所以校验一律由用户显式发起，并在确认框里写明将要发起的请求数，绝不"顺手全跑"。
 *  - 表格由脚本按接口数据渲染；「显示已留档」只读 KV，不打上游。
 *  - 渠道徽章是**三态开关**（勾选 → 排除 → 自动），取代了早期的「固定到」单选下拉：多选是
 *    真实需求（只用这几个 / 优先这几个），而单选下拉表达不了；两个列表天然互斥，也就不可能
 *    配出「既勾选又排除」的矛盾状态。排除是否决权，网关两侧都不认 exclude/ignore 字段
 *    （源项目实测被静默忽略），由后端结合渠道清单换算成 only 白名单下发——清单缺失时排除会
 *    失效，面板必须显式标出（见 clineUpExcludeUnresolved）。
 *  - **没有「保存」按钮**：改动即时 PUT 保存，成功后用服务端归一结果回渲染。批式保存的失败模式
 *    （漏点、请求被中断、归一化丢弃）在用户侧一律表现为「保存不生效」且无从判断，索性消掉这一步。
 *  - 保存走通用 PUT /admin/api/providers/:id：clinePinByModel 是**整表替换**语义，所以每次都提交
 *    完整的表（没有设置的模型即视为回到网关自动选）。
 */
const clineUpstreamSectionHtml = (p: { id?: string }) => {
  const pid = escapePageHtml(p.id)
  const js = escapePageJsx(p.id)
  return `<div class="collapse-section">` +
    `<button class="collapse-btn" onclick="toggleAdvOauth('cu-fs-${js}', this)" type="button" aria-expanded="false">` +
    `<i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 上游渠道与固定（把模型钉在指定渠道上）</button>` +
    `<fieldset class="form-group hd" id="cu-fs-${pid}"><legend>上游渠道与固定</legend>` +
    `<div class="fc mt-1 field-row">` +
    `<button class="btn btn-s btn-xs" onclick="clineUpstreamsLoad('${js}')" title="读取留档的渠道清单与渠道设置；不打上游"><i class="fas fa-list" aria-hidden="true"></i><span>显示已留档</span></button>` +
    `<button class="btn btn-s btn-xs" onclick="clineUpstreamsProbeAll('${js}')" title="逐个模型发一次假渠道请求，让网关回吐可用渠道清单（零 token、每模型约 0.3 秒）"><i class="fas fa-satellite-dish" aria-hidden="true"></i><span>探测全部渠道</span></button>` +
    `<button class="btn btn-gh btn-xs" onclick="clineUpstreamsValidateAll('${js}')" title="对每个模型已探测到的渠道逐个发最小真实请求实测可用性；点击后会先告知请求数与预计耗时"><i class="fas fa-vial" aria-hidden="true"></i><span>校验全部渠道</span></button>` +
    `<button class="btn btn-s btn-xs" onclick="clineUpstreamsVerifyAll('${js}')" title="验证已保存的钉住是否真的生效：对每个已配钉住的模型发 1 次最小真实请求，读回上游实际走的渠道（消耗少量 token）"><i class="fas fa-shield-halved" aria-hidden="true"></i><span>验证钉住</span></button>` +
    `<button class="btn btn-gh btn-xs" onclick="clineUpstreamsBulk('${js}','all')" title="把每个模型已探测到的渠道按可用状态排序全部勾选（顺序 = 推荐优先级）"><i class="fas fa-check-double" aria-hidden="true"></i><span>全选</span></button>` +
    `<button class="btn btn-gh btn-xs" onclick="clineUpstreamsBulk('${js}','clear')" title="清空全部勾选与排除（回到网关自动选）"><i class="fas fa-eraser" aria-hidden="true"></i><span>清空</span></button>` +
    `<span class="mu" id="cu-st-${pid}" aria-live="polite" style="font-size:12px"></span></div>` +
    `<div id="cu-tb-${pid}"></div>` +
    `<span class="form-helper">钉住发生在 Cline 网关之后的路由层。<b>改动即时保存，不需要点保存按钮</b>（状态行会显示「已保存」）。<b>点渠道徽章切换三态</b>：勾选 → 排除 → 自动。勾选的渠道带序号（序号 = 优先顺序）：<b>只用这几个</b>模式下网关只在这几个里选、不再兜底（全挂即失败）；<b>优先</b>模式下它们最优先、其余仍可兜底。排除 = 永不使用（划线），是<b>否决权</b>，优先级高于勾选。一个都不勾 = 网关自动选。<b>「验证钉住」是唯一能证明"上游真的照做了"的动作</b>：它发 1 次最小真实请求，读回上游实际走的渠道——日志里的 <code>[cline-pin]</code> 只能证明网关把偏好发出去了，证明不了上游认了它（规划器管道会静默丢弃）。校验中「限流」只代表当前共享池暂时繁忙，渠道本身可用。每个模型徽章下方还有一行<b>真实流量画像</b>：网关把每条真实请求里上游回吐的实际渠道自动留档（<b>不需要点任何按钮</b>），手动「验证钉住」只是抽样一次，这行才是全量——它同时能发现「配置生效了、但该渠道自己挂了所以实际走了兜底渠道」。<span class="mu" style="font-size:11px">面板脚本 ${CLINE_UP_UI_VERSION}</span></span>` +
    `</fieldset></div>`
}

/**
 * 是否 WorkBuddy/CodeBuddy 提供商（browser 登录流，或 id 以 workbuddy 开头，
 * 与 src/proxy.ts isWorkbuddyProvider 对齐）。
 * 仅这类上游消费 oauth.effortPolicy（reasoning_effort 档位声明，见 applyWorkbuddyReasoningEffort），
 * 其余提供商的模型行「effort」下拉不生效，故不展示。
 */
const isWorkbuddyProviderUI = (p: { id?: string; authType?: string; oauth?: { flowType?: string } }) =>
  Boolean((p.authType === 'oauth-device' && p.oauth?.flowType === 'browser') ||
    (typeof p.id === 'string' && p.id.startsWith('workbuddy')))

/** OAuth 登录流程类型（未配置 oauth 时为空串） */
const oauthFlowUI = (p: { oauth?: { flowType?: string } }) => (p.oauth && p.oauth.flowType) || ''

/**
 * 该提供商的 OAuth 是否使用 Global 域（海外账户）配置。
 * 仅 browser（WorkBuddy）与 qoder（QoderWork）两条流程读取 globalBaseUrl / globalModelsUrl /
 * globalOrigin / globalDeviceCodeUrl / globalDeviceTokenUrl / globalRefreshTokenUrl
 * （见 src/oauth.ts browserCodeUrl/browserTokenUrl/browserRefreshUrl 与 qoder 分支；src/proxy.ts 域路由）。
 */
const usesGlobalRealmUI = (p: { oauth?: { flowType?: string } }) => {
  const flow = oauthFlowUI(p)
  return flow === 'browser' || flow === 'qoder'
}

/**
 * 「登录域」下拉的文案按流程区分。
 * 原实现把 WorkBuddy 的域名（codebuddy.cn / workbuddy.ai）写死在共用模板里，
 * QoderWork 提供商因此显示成 WorkBuddy 的域名——提示与真实端点不符。
 */
const realmCopyFor = (p: { oauth?: { flowType?: string } }) => {
  if (oauthFlowUI(p) === 'qoder') {
    return {
      cnLabel: 'qoder.com.cn',
      globalLabel: 'qoder.com',
      helper: '国际版账号必须选「国际版」：授权链接走 qoder.com，token 轮询/刷新与签到走 openapi.qoder.sh。',
      globalDeviceCodePlaceholder: 'https://qoder.com/device/selectAccounts',
      globalDeviceTokenPlaceholder: 'https://openapi.qoder.sh/api/v1/deviceToken/poll',
      globalRefreshTokenPlaceholder: 'https://openapi.qoder.sh/api/v1/deviceToken/refresh',
    }
  }
  return {
    cnLabel: 'codebuddy.cn',
    globalLabel: 'workbuddy.ai',
    helper: '国际版账号必须选「国际版」，登录链接与轮询将走 www.workbuddy.ai。',
    globalDeviceCodePlaceholder: 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI',
    globalDeviceTokenPlaceholder: 'https://www.workbuddy.ai/v2/plugin/auth/token',
    globalRefreshTokenPlaceholder: 'https://www.workbuddy.ai/v2/plugin/auth/token/refresh',
  }
}

/** Client Secret 唯一消费方是 Gemini OAuth（src/oauth.ts geminiClientCreds），其余流程不读取。 */
const usesClientSecretUI = (p: { oauth?: { flowType?: string } }) => oauthFlowUI(p) === 'gemini'

/** reasoning_effort 全部合法档位（与 src/workbuddy-upstream.ts EFFORT_RANK 对齐） */
const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 模型行内「reasoning_effort 支持档位」多选下拉（编辑表单 SSR 模型行用；pol = 该模型已保存档位）
 *  hidden=true 时仅加 hd 类隐藏：仍保留在 DOM 中，collectEffortPolicyEdit 可继续读到已存档位，
 *  避免「非 WorkBuddy 提供商保存后 effortPolicy 被静默清空」。 */
function effDdEditHtml(pid: string, mi: number, pol: readonly string[], hidden = false): string {
  const sum = pol.length ? pol.join(' + ') : 'effort 不启用'
  const boxes = EFFORT_LEVELS.map((lv) =>
    `<label class="eff-item"><input type="checkbox" class="eff-cb" value="${lv}"${pol.includes(lv) ? ' checked' : ''} aria-label="${lv}">${lv}</label>`
  ).join('')
  return `<details class="eff-dd${hidden ? ' hd' : ''}" title="reasoning_effort 支持档位（多选；仅 WorkBuddy/CodeBuddy 上游生效）：请求档位在支持列表内透传，不支持则自动降级为 ≤请求档位的最高支持档"><summary class="eff-sum" id="effs-${escapePageHtml(pid)}-${mi}">${escapePageHtml(sum)}</summary><div class="eff-pop" id="eff-${escapePageHtml(pid)}-${mi}">${boxes}</div></details>`
}

/** 新建表单的 effort 下拉模板（注入 #eff-dd-tpl，浏览器 JS 克隆进每条模型行） */
function effDdNewHtml(): string {
  const boxes = EFFORT_LEVELS.map((lv) =>
    `<label class="eff-item"><input type="checkbox" class="eff-cb" value="${lv}" aria-label="${lv}">${lv}</label>`
  ).join('')
  return `<details class="eff-dd" title="reasoning_effort 支持档位（多选；仅 WorkBuddy/CodeBuddy 上游生效）：请求档位在支持列表内透传，不支持则自动降级为 ≤请求档位的最高支持档"><summary class="eff-sum">effort 不启用</summary><div class="eff-pop">${boxes}</div></details>`
}

/**
 * OpenCode 提供商默认 reasoning 档位下拉（与 src/opencode.ts OPENCODE_REASONING_EFFORTS 对齐）。
 * 语义是「强制默认值」而非「支持档位」：客户端已显式声明 reasoning_effort / reasoning.effort
 * 时不覆盖；选 none = 显式关闭思考；空 = 不设置、原样透传。
 */
const OPENCODE_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function opencodeEffortSelectHtml(selectId: string, selected: string | undefined): string {
  const opts = ['<option value="">（不设置，原样透传）</option>']
    .concat(OPENCODE_EFFORT_LEVELS.map((lv) => `<option value="${lv}"${selected === lv ? ' selected' : ''}>${lv}</option>`))
    .join('')
  return `<label class="switch-label" style="display:flex;align-items:center;gap:.5rem"><span>默认 reasoning 档位（仅 OpenCode 提供商消费）——客户端显式声明时忽略；<code>none</code> = 显式关闭思考。</span><select id="${escapePageHtml(selectId)}" style="max-width:12rem">${opts}</select></label>`
}

// UX8：厂商预设与 OAuth 预置模板——单一数据源。
// SSR 下拉 option 与客户端 applyProviderPreset / applyOauthPreset* 共用，
// 注入为页面 script 常量，消除服务端/客户端两套重复预设表。
const PROVIDER_PRESETS: Record<string, { name: string; id: string; baseUrl: string; apiType: string; authType?: string; oauthPreset?: string; models?: string[]; toolBridge?: boolean; type?: 'kuku'; kukuThinkMode?: number }> = {
  deepseek:     { name: 'DeepSeek',           id: 'deepseek',     baseUrl: 'https://api.deepseek.com',                          apiType: 'openai' },
  // DeepSeek App：凭据不是 API Key，而是浏览器里取的 userToken（token 注入型，见 DEEPSEEK-APP-PORT.md）。
  // 上游只有一个模型，预置填好避免用户手填错 ID / 地址（两处判定见 isDeepseekAppProviderUI）。
  'deepseek-app': { name: 'DeepSeek App (token 注入)', id: 'deepseek-app', baseUrl: 'https://chat.deepseek.com', apiType: 'openai',
    models: ['deepseek-flash'],
  },
  openai:       { name: 'OpenAI',             id: 'openai',       baseUrl: 'https://api.openai.com/v1',                         apiType: 'openai' },
  anthropic:    { name: 'Anthropic',          id: 'anthropic',    baseUrl: 'https://api.anthropic.com',                         apiType: 'anthropic' },
  zhipu:        { name: '智谱 AI',             id: 'zhipu',        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              apiType: 'openai' },
  qwen:         { name: '通义千问',            id: 'qwen',         baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiType: 'openai' },
  moonshot:     { name: 'Kimi',               id: 'moonshot',     baseUrl: 'https://api.moonshot.cn/v1',                        apiType: 'openai' },
  baichuan:     { name: '百川',               id: 'baichuan',     baseUrl: 'https://api.baichuan-ai.com/v1',                    apiType: 'openai' },
  lingyi:       { name: '零一万物',            id: 'lingyi',       baseUrl: 'https://api.lingyiwanwu.com/v1',                    apiType: 'openai' },
  stepfun:      { name: '阶跃星辰',            id: 'stepfun',      baseUrl: 'https://api.stepfun.com/v1',                        apiType: 'openai' },
  siliconflow:  { name: '硅基流动',            id: 'siliconflow',  baseUrl: 'https://api.siliconflow.cn/v1',                     apiType: 'openai' },
  volcengine:   { name: '火山方舟',            id: 'volcengine',   baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',          apiType: 'openai' },
  qianfan:      { name: '百度千帆',            id: 'qianfan',      baseUrl: 'https://qianfan.baidubce.com/v2',                   apiType: 'openai' },
  kuku:         { name: 'Kuku GenFlow Pro',   id: 'kuku',         baseUrl: 'https://kuku.baidu.com',                            apiType: 'openai', type: 'kuku', kukuThinkMode: 3,
    models: ['auto', 'glm-5.3'],
  },
  openrouter:   { name: 'OpenRouter',         id: 'openrouter',   baseUrl: 'https://openrouter.ai/api/v1',                      apiType: 'openai' },
  sensenova:    { name: '商汤日日新 (SenseNova)', id: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1',                    apiType: 'openai',
    models: ['sensenova-6.8-flash-lite', 'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k3'],
  },
  'cloudflare-ai': { name: 'Cloudflare Workers AI', id: 'cloudflare-ai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1', apiType: 'openai',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/zai-org/glm-4.7-flash', '@cf/google/gemma-4-26b-a4b-it', '@cf/nvidia/nemotron-3-120b-a12b', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'],
  },
  together:     { name: 'Together AI',        id: 'together',     baseUrl: 'https://api.together.xyz/v1',                       apiType: 'openai' },
  groq:         { name: 'Groq',               id: 'groq',         baseUrl: 'https://api.groq.com/openai/v1',                    apiType: 'openai' },
  deepinfra:    { name: 'DeepInfra',          id: 'deepinfra',    baseUrl: 'https://api.deepinfra.com/v1/openai',               apiType: 'openai' },
  mistral:      { name: 'Mistral AI',         id: 'mistral',      baseUrl: 'https://api.mistral.ai/v1',                         apiType: 'openai' },
  xai:          { name: 'xAI (Grok)',         id: 'xai',          baseUrl: 'https://api.x.ai/v1',                               apiType: 'openai' },
  workbuddy:    { name: 'WorkBuddy (OAuth)',  id: 'workbuddy',    baseUrl: 'https://copilot.tencent.com/v2',                    apiType: 'openai', authType: 'oauth-device', oauthPreset: 'workbuddy' },
  qoder:        { name: 'QoderWork (OAuth)',  id: 'qoder',        baseUrl: 'https://gateway.qoder.com.cn',                      apiType: 'openai', authType: 'oauth-device', oauthPreset: 'qoder' },
  gemini:       { name: 'Gemini CLI (OAuth)', id: 'gemini',       baseUrl: 'https://cloudcode-pa.googleapis.com',               apiType: 'openai', authType: 'oauth-device', oauthPreset: 'gemini' },
  'gemini-api':   { name: 'Gemini (官方 API Key)', id: 'gemini-api',  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiType: 'openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash'],
  },
  cline:        { name: 'Cline (白嫖模型)',    id: 'cline',        baseUrl: 'https://api.cline.bot/api/v1',                      apiType: 'openai',
    // 2026-09-24 实测（recommended-models）：free 档 5 项 + cline-pass 付费档。
    // 旧的 poolside/laguna-s-2.1:free、cline-free/glm-5.2 已不在免费列表内。
    models: ['cline-free/deepseek-v4.1-flash', 'cline-free/gemini-3.8-flash', 'cline-free/mimo-v2.6-flash', 'cline-free/muse-spark-1.3-contributor', 'stealth/space-bunny-alpha', 'cline-pass/glm-5.3', 'cline-pass/deepseek-v4.1-flash', 'cline-pass/qwen3.8-max'],
  },
  cnb:          { name: 'CNB (免费 deepseek-v4)', id: 'cnb',       baseUrl: 'https://cnb.cool',                                   apiType: 'openai', toolBridge: true,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  zcode:        { name: 'ZCode / BigModel Coding Plan', id: 'zcode', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',      apiType: 'openai',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5', 'glm-4.5-flash', 'glm-4-air', 'glm-4-airx', 'glm-4-plus', 'glm-4', 'codegeex-4'],
  },
  visionbridge: { name: 'Vision Bridge (图片转写桥)', id: 'visionbridge', baseUrl: 'https://example.com/v1', apiType: 'openai' },
  m365:         { name: 'M365 Copilot (OAuth)',   id: 'm365',         baseUrl: 'https://substrate.office.com',                     apiType: 'openai', authType: 'oauth-device', oauthPreset: 'm365' },
  trae:         { name: 'TRAE SOLO (多账号反代)', id: 'trae',         baseUrl: 'https://trae-api-cn.mchost.guru',                  apiType: 'openai',
    models: ['glm-5.2', 'glm-5-turbo', 'glm-5', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Flash-Official', 'DeepSeek-V4', 'kimi-k3', 'kimi-k2.7-code', 'qwen-3.7-plus', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.0-Code', 'minimax-m3'],
  },
}

const OAUTH_PRESETS: Record<string, { label: string; flowType: string; deviceCodeUrl: string; deviceTokenUrl: string; refreshTokenUrl: string; clientId: string; clientSecret?: string; scope?: string; tokenHeader: string; tokenHeaderPrefix: string; extraHeaders: Record<string, string>; _baseUrl?: string; _modelsUrl?: string; _globalBaseUrl?: string; _globalModelsUrl?: string; _globalOrigin?: string; _globalDeviceCodeUrl?: string; _globalDeviceTokenUrl?: string; _globalRefreshTokenUrl?: string; _redirectUri?: string }> = {
  workbuddy: {
    label: 'WorkBuddy（浏览器登录）',
    flowType: 'browser',
    deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI',
    deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
    refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
    clientId: '',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {
      'Origin': 'https://www.codebuddy.cn',
      'Referer': 'https://www.codebuddy.cn/',
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    },
    _baseUrl: 'https://copilot.tencent.com/v2',
    _modelsUrl: 'https://copilot.tencent.com/console/enterprises/personal/models',
    _globalBaseUrl: 'https://www.workbuddy.ai/v2',
    _globalModelsUrl: 'https://www.workbuddy.ai/console/enterprises/personal/models',
    _globalOrigin: 'https://www.workbuddy.ai',
    // 国际版 OAuth 登录端点：与 CN 同协议，换 www.workbuddy.ai 域
    _globalDeviceCodeUrl: 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI',
    _globalDeviceTokenUrl: 'https://www.workbuddy.ai/v2/plugin/auth/token',
    _globalRefreshTokenUrl: 'https://www.workbuddy.ai/v2/plugin/auth/token/refresh',
  },
  qoder: {
    label: 'QoderWork（Qoder 设备授权）',
    flowType: 'qoder',
    deviceCodeUrl: 'https://qoder.com.cn/device/selectAccounts',
    deviceTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
    refreshTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh',
    clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
    scope: '',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {},
    _baseUrl: 'https://openapi.qoder.com.cn',
    _modelsUrl: 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
    // 国际版端点（对齐 keirouter）：授权 qoder.com / 推理 api3.qoder.sh / token openapi.qoder.sh
    _globalBaseUrl: 'https://openapi.qoder.sh',
    _globalModelsUrl: 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1',
    _globalOrigin: 'https://qoder.com',
    _globalDeviceCodeUrl: 'https://qoder.com/device/selectAccounts',
    _globalDeviceTokenUrl: 'https://openapi.qoder.sh/api/v1/deviceToken/poll',
    _globalRefreshTokenUrl: 'https://openapi.qoder.sh/api/v1/deviceToken/refresh',
  },
  gemini: {
    label: 'Gemini（官方 OAuth）',
    flowType: 'gemini',
    deviceCodeUrl: '',
    deviceTokenUrl: '',
    refreshTokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: 'openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {},
    _baseUrl: 'https://cloudcode-pa.googleapis.com',
    _redirectUri: 'http://127.0.0.1:8089/oauth2callback',
  },
  m365: {
    label: 'M365 Copilot（微软 OAuth）',
    flowType: 'm365-pkce',
    deviceCodeUrl: '',
    deviceTokenUrl: '',
    refreshTokenUrl: '',
    clientId: 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1',
    scope: 'openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {},
    _baseUrl: 'https://substrate.office.com',
    _redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
  },
}

/**
 * 根据已保存的 OAuth 配置反推匹配的预置模板名称（用于编辑表单回显选中项）。
 * 预置模板本身不作为字段存储，但 deviceCodeUrl 是每个预置的唯一标识，
 * 据此即可稳定反推。返回 'workbuddy' | 'qoder' | ''（空 = 自定义/未匹配）。
 */
const detectOauthPreset = (oauth?: OAuthDeviceConfig): string => {
  if (oauth?.flowType === 'gemini') return 'gemini'
  const url = oauth?.deviceCodeUrl || ''
  if (!url) return ''
  if (url.includes('copilot.tencent.com/v2/plugin/auth/state')) return 'workbuddy'
  if (url.includes('qoder.com.cn/device/selectAccounts')) return 'qoder'
  return ''
}

const H = (title: string) => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="oklch(98.5% 0.004 250)">
  <title>${title} — ${SITE_CONFIG.title}</title>
  <link rel="icon" href="${SITE_CONFIG.favicon}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${SITE_CONFIG.faCdn}">
  <style>${CSS_CONTENT}</style>
</head>`

// ===== 登录页 =====

export async function renderLoginPage(c: Context<AppEnv>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('登录')}
<body class="site-page auth-page">
<header class="topbar topbar--auth">
  <div class="shell topbar__inner">
    <a class="brand" href="/admin" aria-label="管理控制台">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
    </a>
  </div>
</header>

<main class="auth-shell">
  <section class="auth-context" aria-labelledby="auth-context-title">
    <p class="eyebrow"><span aria-hidden="true"></span>CONTROL PLANE ACCESS</p>
    <h1 id="auth-context-title">管理提供商、模型和转发密钥。</h1>
  </section>

  <section class="auth-form-wrap" aria-labelledby="login-title">
    <form class="auth-form" id="login-form" novalidate>
      <div class="auth-form__heading">
        <span class="auth-form__icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
        <div><h2 id="login-title">管理员登录</h2><p>使用部署时配置的账号继续。</p></div>
      </div>

      <div id="er" class="al al-e hd" role="alert" aria-live="assertive">
        <i class="fas fa-exclamation-circle" aria-hidden="true"></i><span id="em"></span>
      </div>

      <div class="fg">
        <label for="u">用户名</label>
        <div class="input-wrap"><i class="far fa-user" aria-hidden="true"></i><input type="text" id="u" name="username" placeholder="admin" autocomplete="username" aria-required="true" aria-describedby="login-helper"></div>
      </div>
      <div class="fg">
        <label for="p">密码</label>
        <div class="input-wrap"><i class="fas fa-key" aria-hidden="true"></i><input type="password" id="p" name="password" placeholder="部署环境变量中的密码" autocomplete="current-password" aria-required="true" aria-describedby="login-helper"><button class="password-toggle" id="password-toggle" type="button" aria-label="显示密码"><i class="far fa-eye" aria-hidden="true"></i></button></div>
      </div>
      <p id="login-helper" class="form-helper">登录成功后将进入管理控制台。</p>
      <button class="btn btn-p btn-submit" id="login-button" type="submit"><span class="button-label"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录管理控制台</span><span class="button-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>正在验证</span></button>
    </form>
  </section>
</main>

<script>
(function () {
  var form = document.getElementById('login-form')
  var username = document.getElementById('u')
  var password = document.getElementById('p')
  var errorBox = document.getElementById('er')
  var errorMessage = document.getElementById('em')
  var submit = document.getElementById('login-button')
  var toggle = document.getElementById('password-toggle')

  function showError(message) {
    errorMessage.textContent = message
    errorBox.classList.remove('hd')
    username.setAttribute('aria-invalid', 'true')
    password.setAttribute('aria-invalid', 'true')
  }
  function clearError() {
    errorBox.classList.add('hd')
    username.removeAttribute('aria-invalid')
    password.removeAttribute('aria-invalid')
  }

  toggle.addEventListener('click', function () {
    var show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    toggle.querySelector('i').className = show ? 'far fa-eye-slash' : 'far fa-eye'
    password.focus({ preventScroll: true })
  })

  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    clearError()
    var u = username.value.trim()
    var p = password.value
    if (!u || !p) {
      showError('请填写用户名和密码后再登录。')
      ;(!u ? username : password).focus()
      return
    }
    submit.disabled = true
    submit.setAttribute('data-state', 'loading')
    try {
      var response = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      })
      var data = await response.json()
      if (data.success) {
        submit.setAttribute('data-state', 'success')
        window.location.href = '/admin'
        return
      }
      showError(data.message || '登录失败，请检查账号配置。')
    } catch (error) {
      showError('无法连接服务，请检查网络后重试。')
    }
    submit.disabled = false
    submit.removeAttribute('data-state')
  })
})()
</script>
</body></html>`)
}

// ===== 管理后台 =====

/**
 * 安全序列化 JSON 用于内联 <script> 注入：
 * - `<` → \u003c：防止数据中的 `</script>` 截断脚本块、`<!--` 注释挖洞
 * - U+2028 / U+2029 → \u2028 / \u2029：行/段分隔符在 JS 字符串字面量中属非法字符（ES2019 起才合法），
 *   会导致整个脚本块语法错误——表现为后台所有按钮失效（函数全部未定义）
 */
const serializeForScript = (data: unknown): string =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

export async function renderAdminPage(c: Context<AppEnv>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)
  const mcps = await getMcps(c.env)
  const unimodels = await getUnimodels(c.env)
  const enabledProvidersCount = providers.filter((provider) => provider.enabled).length
  const modelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = providers.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)
  const enabledProxyKeysCount = proxyKeys.filter((key) => key.enabled).length

  // 全部已启用模型引用（providerId/modelId），供 Vision Bridge 识图模型勾选（可跨厂商）
  const allModelRefs = providers.flatMap((provider) => provider.models.filter((m) => m.enabled).map((m) => `${provider.id}/${m.id}`))
  // P6：识图模型引用列表不再于 SSR 阶段为每个提供商重放全库（O(N×M) 页面膨胀），
  // 改为输出空容器，客户端展开「识图模型配置」时按需填充（数据源 VB_MODELS 只输出一次）。
  const vbRadioContainer = (id: string, name: string, checked: string) =>
    `<div id="${id}" data-vb-radio="1" data-name="${escapePageHtml(name)}" data-checked="${escapePageHtml(checked)}"></div>`
  const vbCheckContainer = (id: string, checked: string[]) =>
    `<div id="${id}" data-vb-check="1" data-checked="${escapePageHtml(JSON.stringify(checked))}"></div>`

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('管理')}
<body class="site-page admin-page">
<div class="admin-shell">
  <aside class="admin-rail" aria-label="控制台导航">
    <a class="brand admin-rail__brand" href="/">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span><strong>${SITE_CONFIG.title}</strong><small>CONTROL PLANE</small></span>
    </a>
    <nav class="admin-nav">
      <a class="admin-nav__link is-active" href="#overview"><i class="fas fa-chart-pie" aria-hidden="true"></i><span>概览</span></a>
      <p class="admin-nav__group" aria-hidden="true">接入资源</p>
      <a class="admin-nav__link" href="#providers"><i class="fas fa-server" aria-hidden="true"></i><span>提供商</span><b>${providers.length}</b></a>
      <a class="admin-nav__link" href="#proxy-keys"><i class="fas fa-key" aria-hidden="true"></i><span>转发 Key</span><b>${proxyKeys.length}</b></a>
      <p class="admin-nav__group" aria-hidden="true">观测分析</p>
      <a class="admin-nav__link" href="#analytics"><i class="fas fa-chart-bar" aria-hidden="true"></i><span>使用统计</span></a>
      <a class="admin-nav__link" href="#usage-logs"><i class="fas fa-clipboard-list" aria-hidden="true"></i><span>详细日志</span></a>
      <a class="admin-nav__link" href="#logs"><i class="fas fa-list-alt" aria-hidden="true"></i><span>系统日志</span></a>
      <p class="admin-nav__group" aria-hidden="true">模型能力</p>
      <a class="admin-nav__link" href="#mcps"><i class="fas fa-boxes" aria-hidden="true"></i><span>MCP 网关</span><b>${mcps.length}</b></a>
      <a class="admin-nav__link" href="#unimodels"><i class="fas fa-layer-group" aria-hidden="true"></i><span>联合模型</span><b>${unimodels.length}</b></a>
      <a class="admin-nav__link" href="#thinking"><i class="fas fa-brain" aria-hidden="true"></i><span>思维引导</span></a>
      <p class="admin-nav__group" aria-hidden="true">缓存与性能</p>
      <a class="admin-nav__link" href="#cache"><i class="fas fa-memory" aria-hidden="true"></i><span>内存缓存</span></a>
      <a class="admin-nav__link" href="#cache-prefix"><i class="fas fa-database" aria-hidden="true"></i><span>缓存前缀</span></a>
      <a class="admin-nav__link" href="#perf"><i class="fas fa-tachometer-alt" aria-hidden="true"></i><span>性能设置</span></a>
    </nav>
    <div class="admin-rail__foot">
      <a href="javascript:void(0)" onclick="doLogout()" class="admin-nav__link"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>

  <div class="admin-main">
    <header class="admin-topbar">
      <a class="brand" href="/admin"><span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span><span class="brand__name">${SITE_CONFIG.title}</span></a>
      <nav aria-label="移动端控制台导航"><a href="#overview">概览</a><a href="#providers">提供商</a><a href="#proxy-keys">Key</a><a href="#analytics">统计</a><a href="#usage-logs">日志</a><a href="#logs">系统日志</a><a href="#mcps">MCP</a><a href="#unimodels">联合</a><a href="#thinking">思维引导</a><a href="#cache">缓存</a><a href="#cache-prefix">缓存前缀</a><a href="#perf">性能</a></nav>
      <a class="icon-btn" href="javascript:void(0)" onclick="doLogout()" aria-label="退出登录"><i class="fas fa-sign-out-alt" aria-hidden="true"></i></a>
    </header>

    <main class="admin-content">
      <div id="toast" class="hd toast" role="status" aria-live="polite"></div>

      <section id="overview" class="admin-overview" aria-labelledby="admin-title">
        <div class="admin-heading">
          <div><p class="eyebrow"><span aria-hidden="true"></span>GATEWAY STATUS</p><h1 id="admin-title">管理控制台</h1><p>配置提供商、模型与客户端访问凭据。变更将写入 Cloudflare KV。</p></div>
        </div>
        <div class="admin-metrics" aria-label="配置统计">
          <div><span>${providers.length}</span><p>提供商</p><small>${enabledProvidersCount} 个已启用</small></div>
          <div><span>${modelsCount}</span><p>模型</p><small>${enabledModelsCount} 个可用</small></div>
          <div><span>${proxyKeys.length}</span><p>转发 Key</p><small>${enabledProxyKeysCount} 个可用</small></div>
          <div><span class="status-dot status-dot--online"><i aria-hidden="true"></i>已配置</span><p>存储</p><small>Cloudflare KV</small></div>
        </div>
        <!-- P2：概览驾驶舱聚合 KPI（客户端拉取 /admin/api/overview 填充） -->
        <div id="overview-kpi" class="overview-kpi" aria-label="运营概况"></div>
      </section>

      <section id="providers" class="workspace-section" aria-labelledby="providers-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="providers-title">提供商</h2><p>管理上游地址、协议、API Key 和模型。</p></div>
          <button class="btn btn-p" onclick="showAdd()"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button>
        </div>

        <div class="af-w">
          <div id="af" class="hd add-form-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-plus" aria-hidden="true"></i></span><div><h3>添加新提供商</h3><p>先配置基本信息，再测试 Key 与模型连接。</p></div></div><button class="icon-btn" type="button" onclick="hideAdd()" aria-label="关闭添加表单"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="fr">
              <div class="fg"><label for="anm">名称</label><input type="text" id="anm" placeholder="DeepSeek"></div>
              <div class="fg"><label for="aid">提供商 ID</label><input type="text" id="aid" placeholder="deepseek"><span class="form-helper">用于模型前缀，创建后不可修改。</span></div>
            </div>
            <div class="fg"><label for="apreset">厂商预设</label><select id="apreset" class="select-sm" onchange="applyProviderPreset(this.value)"><option value="">— 自定义 —</option>${Object.entries(PROVIDER_PRESETS).map(([name, pre]) => `<option value="${name}">${escapePageHtml(pre.name)}</option>`).join('')}</select><span class="form-helper">选择后自动填充名称/地址/格式，只需填 API Key 即可测试。</span></div>
            <div class="fg"><label for="aurl">API 地址</label><input type="url" id="aurl" placeholder="https://api.deepseek.com"></div>
            <div class="fg"><label for="afmt">API 格式</label><select id="afmt" class="select-sm"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></div>
            <div class="fg"><label for="aat">认证方式</label><select id="aat" class="select-sm" onchange="toggleAuthType()"><option value="api-key">API Key</option><option value="oauth-device">OAuth 设备码登录</option></select></div>
            <div id="oauth-new" class="hd form-group">
              <fieldset class="form-group"><legend>OAuth 配置</legend>
                <div class="fg"><label>登录流程类型</label><select id="ao8" class="select-sm" onchange="syncNewScopedFields()"><option value="device">设备码（RFC 8628）</option><option value="browser">浏览器登录（WorkBuddy）</option><option value="qoder">Qoder 设备授权（QoderWork）</option><option value="gemini">Gemini 授权码（Gemini CLI）</option><option value="m365-pkce">M365 授权码（PKCE）</option><option value="m365-ropc">M365 账号密码（ROPC）</option></select></div>
                <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPreset(this.value)"><option value="">— 选择 —</option>${Object.entries(OAUTH_PRESETS).map(([k, pre]) => `<option value="${k}">${escapePageHtml(pre.label)}</option>`).join('')}</select><span class="form-helper">选好模板点「创建并发起连接」即可，端点等高级参数已由模板填充。</span></div>
                <div class="collapse-section">
                  <button class="collapse-btn" onclick="toggleAdvOauth('ao-adv-fs', this)" type="button" aria-expanded="false"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 高级 OAuth 配置（端点 / 凭据 / Global 域，模板已填好，一般无需修改）</button>
                  <div id="ao-adv-fs" class="hd">
                    <div class="fg hd" id="ao15-row"><label>登录域（browser / qoder 模式）</label><select id="ao15" class="select-sm" onchange="syncGlobalOauthNew()"><option value="cn">国内版（codebuddy.cn / qoder.com.cn）</option><option value="global">国际版（workbuddy.ai / qoder.com）</option></select><span class="form-helper">按上面选的流程取域名：WorkBuddy 走 codebuddy.cn / workbuddy.ai，QoderWork 走 qoder.com.cn / qoder.com。</span></div>
                    <div class="fg"><label>发起端点 (deviceCodeUrl)</label><input type="url" id="ao1" placeholder="https://.../auth/device/code"></div>
                    <div class="fg"><label>轮询端点 (deviceTokenUrl)</label><input type="url" id="ao2" placeholder="https://.../auth/device/token"></div>
                    <div class="fg"><label>Token 刷新端点 (refreshTokenUrl)</label><input type="url" id="ao3" placeholder="https://.../auth/oauth_token/refresh"></div>
                    <div class="fg"><label>Client ID</label><input type="text" id="ao4" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                    <div class="fg hd" id="ao14-row"><label>Client Secret（可选）</label><input type="text" id="ao14" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"><span class="form-helper">仅「Gemini 授权码」流程使用；其余流程用不到 client_secret。</span></div>
                    <div class="fg"><label>Scope（可选）</label><input type="text" id="ao5" placeholder="如 user"></div>
                    <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="ao6" placeholder="x-api-key"></div>
                    <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="ao9" placeholder="如 Bearer （含尾空格）"></div>
                    <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="ao7" rows="3" placeholder='{"x-app-name":"my-app","x-app-version":"1.0.0"}'></textarea></div>
                    <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="ao10" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"><span class="form-helper">登录后从此地址动态拉取可用模型；WorkBuddy 等自定义 API 需填写。</span></div>
                    <div id="ao-global-rows" class="hd">
                    <div class="fg"><label>Global 域配置（海外账户，可选）</label><span class="form-helper">仅「浏览器登录（WorkBuddy）」与「Qoder 设备授权」两条流程使用：Token 为海外域时按以下端点路由，留空则不区分域。WorkBuddy 预设会自动填充。</span></div>
                    <div class="fg"><label>Global 域 baseUrl</label><input type="url" id="ao11" placeholder="https://www.workbuddy.ai/v2"></div>
                    <div class="fg"><label>Global 域模型 URL</label><input type="url" id="ao12" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                    <div class="fg"><label>Global 域 Origin</label><input type="url" id="ao13" placeholder="https://www.workbuddy.ai"></div>
                    <div class="fg"><label>Global 域发起端点</label><input type="url" id="ao16" placeholder="https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI"><span class="form-helper">登录域选「国际版」时使用，留空回退国内端点。</span></div>
                    <div class="fg"><label>Global 域轮询端点</label><input type="url" id="ao17" placeholder="https://www.workbuddy.ai/v2/plugin/auth/token"></div>
                    <div class="fg"><label>Global 域刷新端点</label><input type="url" id="ao18" placeholder="https://www.workbuddy.ai/v2/plugin/auth/token/refresh"></div>
                    </div>
                  </div>
                </div>
                <div class="fc mt-1 field-row"><button class="btn btn-p" onclick="createProv({afterCreate:function(id){location.href='/admin?connect='+encodeURIComponent(id)}})"><i class="fas fa-plug" aria-hidden="true"></i>创建并发起连接</button><span class="form-helper">先创建提供商，保存后自动弹出 OAuth 登录链接；登录成功会自动拉取模型。</span></div>
              </fieldset>
            </div>
            <fieldset class="form-group" id="akeys-fs"><legend id="akey-legend">上游 API Keys</legend><div id="akeys"><div class="fc mb-4 field-row"><input type="password" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewAKey(this)" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addAKeyRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加 Key</button><span id="akey-hint" class="form-helper"></span></fieldset>
            <div class="fg hd" id="akuku-row"><label for="akuku-think">Kuku 思考模式</label><input type="number" id="akuku-think" min="0" max="10" value="3"><span class="form-helper">仅 Kuku GenFlow Pro 生效，允许 0 到 10。</span></div>
            <div class="fg hd" id="akuku-qr"><button class="btn btn-p btn-sm" onclick="kukuQrLogin()" type="button"><i class="fas fa-qrcode" aria-hidden="true"></i> 扫码登录自动写 Cookie</button><span class="form-helper">用手机百度 App 扫下方二维码（App 需已登录目标百度账号），后台自动写入 BDUSS Cookie，无需手工粘贴。</span></div>
            <fieldset class="form-group" id="amodels-fs"><legend>模型 ID</legend><div id="amodels"><div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><label class="tg" title="对该模型启用思维引导注入（转发前注入固定思维引导 system 提示词）"><input type="checkbox" class="cti" aria-label="启用思维引导注入"><span class="sl"></span></label><label class="tg" title="对该模型启用缓存前缀注入（转发前注入固定缓存前缀以提升缓存命中率）"><input type="checkbox" class="ccp" aria-label="启用缓存前缀注入"><span class="sl"></span></label><script type="text/plain" id="eff-dd-tpl">${effDdNewHtml()}</script><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addMdlRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加模型</button><span class="form-helper">每个模型行上「启用模型」开关旁的开关依次为「思维引导注入」「缓存前缀注入」，勾选后该模型转发前会被注入对应固定提示词；不勾选则原样转发。「effort」下拉声明该模型的 reasoning_effort 支持档位（多选），仅对 WorkBuddy / CodeBuddy 提供商显示——其余上游不消费该配置。</span></fieldset>
            <div class="collapse-section">
              <button class="collapse-btn" onclick="toggleVbCollapse('avb-fs', this)" type="button" aria-expanded="false">
                <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 识图模型配置（可选）
              </button>
              <fieldset class="form-group hd" id="avb-fs"><legend>识图模型配置（可选）</legend><span class="form-helper">让不支持图片的模型支持图片：请求含图时自动调用下方勾选的识图模型转写为文本。识图模型可从已维护的所有模型中选择（同厂商或跨厂商）。两种用法：①「主文本模型」留空 → 本提供商下所有模型自动共享识图能力；②「主文本模型」选了其它提供商/模型 → 本提供商作为图片转写桥，所有模型转发到该主文本模型。</span>
                <div class="fg"><label>主文本模型（留空 = 转发到本提供商自身模型）</label>${vbRadioContainer('avb-primary', 'avb-primary', '')}</div>
                <div class="fg"><label>识图模型（视觉模型链，勾选后请求含图时按勾选顺序依次转写，全部失败按下方策略处理）</label>${vbCheckContainer('avb-vision', [])}</div>
                <div class="fg"><label>视觉转写失败策略</label><select id="avb-fail" class="select-sm"><option value="error">error（返回错误）</option><option value="text_only">text_only（丢弃图片仅转发文本）</option></select></div>
              </fieldset>
            </div>
            <div class="fg hd" id="agbu-row"><label for="agbu">Gemini 推理中转地址（可选）</label><input type="url" id="agbu" placeholder="https://your-us-relay.example.com"><span class="form-helper">仅登录流程为「Gemini 授权码」的提供商生效。Google 对部分地区拒绝对 cloudcode-pa.googleapis.com 的推理调用（HTTP 400 User location is not supported）；配置美国中转地址后，网关把 generateContent / countTokens 推理请求经该节点中转。OAuth 认证端点不走此地址，仍直连 Google。留空 = 直连内置默认地址。</span></div>
            <div class="collapse-section hd" id="atb-cs">
              <button class="collapse-btn" onclick="toggleAdvOauth('atb-fs', this)" type="button" aria-expanded="false">
                <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 工具桥（XYML 提示词注入，仅 CNB 需要，可选）
              </button>
              <fieldset class="form-group hd" id="atb-fs"><legend>工具桥</legend><label class="switch-label"><span>启用工具桥（XYML 提示词注入 + 流式解析回 tool_calls，仅 CNB 需要）</span><span class="tg"><input type="checkbox" id="atb"><span class="sl"></span></span></label></fieldset>
            </div>
            <div class="collapse-section">
              <button class="collapse-btn" onclick="toggleAdvOauth('aum-fs', this)" type="button" aria-expanded="false">
                <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 模型策略（未配置模型透传，可选）
              </button>
              <fieldset class="form-group hd" id="aum-fs"><legend>模型策略</legend><label class="switch-label"><span>允许未配置模型透传——开启后请求该提供商的任意 modelId 都直接转发（跳过「未配置」校验），适合模型频繁上架、不想每次手动加模型的提供商（如 OpenRouter）。</span><span class="tg"><input type="checkbox" id="aum"><span class="sl"></span></span></label>${opencodeEffortSelectHtml('re', undefined)}</fieldset>
            </div>
            <div class="panel-actions"><label class="switch-label"><span>创建后立即启用</span><span class="tg"><input type="checkbox" checked id="aen"><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="hideAdd()">取消</button><button class="btn btn-p" onclick="createProv()"><i class="fas fa-check" aria-hidden="true"></i>创建提供商</button></div></div>
            <div id="atestR" class="mt-1" aria-live="polite"></div>
          </div>
          <aside id="amc" class="hd mdl-list-panel"><div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span><div><h3>可用模型</h3><p>点击“+”添加到配置。</p></div></div></div><div id="amcl"></div></aside>
        </div>

        <div class="gp provider-list" id="plist">
          ${providers.length ? providers.map(p=>`
          <article class="pi" data-id="${escapePageHtml(p.id)}">
            <div class="ps" onclick="tog('${escapePageJsx(p.id)}')" role="button" tabindex="0" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();tog('${escapePageJsx(p.id)}')}" aria-controls="dt-${escapePageHtml(p.id)}">
              <div class="l"><i class="fas fa-chevron-right provider-chevron" aria-hidden="true" id="ch-${escapePageHtml(p.id)}"></i><span class="provider-avatar" aria-hidden="true">${escapePageHtml(p.name.charAt(0).toUpperCase() || 'A')}</span><div><h3>${escapePageHtml(p.name)}</h3><div class="pu"><code>${escapePageHtml(p.id)}</code><span>${(p.apiType||'openai')==='anthropic'?'Anthropic':'OpenAI'}</span><span>${p.apiKeys.length} Keys</span><span>${p.models.length} 模型</span></div></div></div>
              <div class="fc fx-s0" onclick="event.stopPropagation()"><label class="tg"><input type="checkbox" ${p.enabled?'checked':''} id="en-${escapePageHtml(p.id)}" onchange="togglePb('${escapePageJsx(p.id)}',this.checked)" aria-label="启用 ${escapePageHtml(p.name)}"><span class="sl"></span></label><span class="bd ${p.enabled?'bd-on':'bd-off'}">${p.enabled?'已启用':'未启用'}</span></div>
            </div>
            <div class="pd" id="dt-${escapePageHtml(p.id)}">
              <div class="detail-heading"><div><h3>编辑 ${escapePageHtml(p.name)}</h3><p>保存后，新配置会用于后续转发请求。</p></div><span class="protocol-chip">${(p.apiType||'openai')==='anthropic'?'ANTHROPIC':'OPENAI'}</span></div>
              <div class="fr"><div class="fg"><label>名称</label><input type="text" id="nm-${escapePageHtml(p.id)}" value="${escapePageHtml(p.name)}"></div><div class="fg"><label>ID</label><input type="text" value="${escapePageHtml(p.id)}" disabled></div></div>
              <div class="fg"><label>API 地址</label><input type="url" id="url-${escapePageHtml(p.id)}" value="${escapePageHtml(p.baseUrl)}"></div>
              ${(p.oauth&&p.oauth.flowType==='gemini')?`
              <div class="fg" id="gbu-row-${escapePageHtml(p.id)}"><label for="gbu-${escapePageHtml(p.id)}">Gemini 推理中转地址（可选）</label><input type="url" id="gbu-${escapePageHtml(p.id)}" value="${escapePageHtml(p.geminiBaseUrl||'')}" placeholder="https://your-us-relay.example.com"><span class="form-helper">配置美国中转地址后，网关把 generateContent / countTokens 推理请求经该节点中转以规避地区限制（HTTP 400 User location is not supported）。OAuth 认证仍直连 Google。留空 = 直连内置默认地址。</span></div>
              <div class="fg" id="gquota-row-${escapePageHtml(p.id)}"><label>账号额度（5 小时窗口 / 周窗口）</label><div class="fr" style="align-items:center;gap:8px;"><button class="btn btn-s" onclick="geminiQuota('${escapePageJsx(p.id)}')"><i class="fas fa-gauge-high" aria-hidden="true"></i>查询额度</button><span id="gquota-tier-${escapePageHtml(p.id)}" class="pu"></span></div><div id="gquota-out-${escapePageHtml(p.id)}" class="form-helper" style="white-space:pre-wrap;"></div></div>`:''}
              <div class="fg"><label>API 格式</label><select id="at-${escapePageHtml(p.id)}" class="select-sm"><option value="openai" ${(p.apiType||'openai')==='openai'?'selected':''}>OpenAI 兼容</option><option value="anthropic" ${p.apiType==='anthropic'?'selected':''}>Anthropic 兼容</option></select></div>
              <div class="fg"><label>认证方式</label><select id="auth-${escapePageHtml(p.id)}" class="select-sm" onchange="toggleAuthTypeEdit('${escapePageJsx(p.id)}')"><option value="api-key" ${(p.authType||'api-key')==='api-key'?'selected':''}>API Key</option><option value="oauth-device" ${p.authType==='oauth-device'?'selected':''}>OAuth 设备码登录</option></select></div>
              <div id="oauth-edit-${escapePageHtml(p.id)}" class="${p.authType==='oauth-device'?'form-group':'hd form-group'}">
                <fieldset class="form-group"><legend>OAuth 配置</legend>
                  <div class="fg"><label>登录流程类型</label><select id="eao8-${escapePageHtml(p.id)}" class="select-sm" onchange="syncEditScopedFields('${escapePageJsx(p.id)}')"><option value="device" ${((p.oauth&&p.oauth.flowType)||'device')==='device'?'selected':''}>设备码（RFC 8628）</option><option value="browser" ${(p.oauth&&p.oauth.flowType)==='browser'?'selected':''}>浏览器登录（WorkBuddy）</option><option value="qoder" ${(p.oauth&&p.oauth.flowType)==='qoder'?'selected':''}>Qoder 设备授权（QoderWork）</option><option value="gemini" ${(p.oauth&&p.oauth.flowType)==='gemini'?'selected':''}>Gemini 授权码（Gemini CLI）</option><option value="m365-pkce" ${(p.oauth&&p.oauth.flowType)==='m365-pkce'?'selected':''}>M365 授权码（PKCE）</option><option value="m365-ropc" ${(p.oauth&&p.oauth.flowType)==='m365-ropc'?'selected':''}>M365 账号密码（ROPC）</option></select></div>
                  <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPresetEdit('${escapePageJsx(p.id)}',this.value)"><option value="" ${detectOauthPreset(p.oauth)===''?'selected':''}>— 选择 —</option>${Object.entries(OAUTH_PRESETS).map(([k, pre]) => `<option value="${k}" ${detectOauthPreset(p.oauth)===k?'selected':''}>${escapePageHtml(pre.label)}</option>`).join('')}</select></div>
                  <div class="collapse-section">
                    <button class="collapse-btn" onclick="toggleAdvOauth('eao-adv-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 高级 OAuth 配置（端点 / 凭据 / Global 域，一般无需修改）</button>
                    <div id="eao-adv-${escapePageHtml(p.id)}" class="hd">
                      <div class="fg ${usesGlobalRealmUI(p)?'':'hd'}" id="eao15-row-${escapePageHtml(p.id)}"><label>登录域（browser / qoder 模式）</label><select id="eao15-${escapePageHtml(p.id)}" class="select-sm" onchange="syncGlobalOauthEdit('${escapePageJsx(p.id)}')"><option value="cn" ${(p.oauth&&p.oauth.loginRealm)!=='global'?'selected':''}>国内版（${realmCopyFor(p).cnLabel}）</option><option value="global" ${(p.oauth&&p.oauth.loginRealm)==='global'?'selected':''}>国际版（${realmCopyFor(p).globalLabel}）</option></select><span class="form-helper">${realmCopyFor(p).helper}</span></div>
                      <div class="fg"><label>发起端点</label><input type="url" id="eao1-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceCodeUrl)||'')}" placeholder="https://.../auth/device/code"></div>
                      <div class="fg"><label>轮询端点</label><input type="url" id="eao2-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceTokenUrl)||'')}" placeholder="https://.../auth/device/token"></div>
                      <div class="fg"><label>Token 刷新端点</label><input type="url" id="eao3-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.refreshTokenUrl)||'')}" placeholder="https://.../auth/oauth_token/refresh"></div>
                      <div class="fg"><label>Client ID</label><input type="text" id="eao4-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientId)||'')}" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                      <div class="fg ${usesClientSecretUI(p)?'':'hd'}" id="eao14-row-${escapePageHtml(p.id)}"><label>Client Secret（可选）</label><input type="text" id="eao14-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientSecret)||'')}" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"><span class="form-helper">仅「Gemini 授权码」流程使用；其余流程用不到 client_secret。</span></div>
                      <div class="fg"><label>Scope（可选）</label><input type="text" id="eao5-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.scope)||'')}" placeholder="如 user"></div>
                      <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="eao6-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeader)||'x-api-key')}" placeholder="x-api-key"></div>
                      <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="eao9-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeaderPrefix)||'')}" placeholder="如 Bearer （含尾空格）"></div>
                      <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="eao7-${escapePageHtml(p.id)}" rows="3" placeholder='{"x-app-name":"my-app"}'>${escapePageHtml((p.oauth&&JSON.stringify(p.oauth.extraHeaders||{}))||'')}</textarea></div>
                      <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="eao10-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.modelsUrl)||'')}" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"></div>
                      <div id="eao-global-rows-${escapePageHtml(p.id)}" class="${usesGlobalRealmUI(p)?'':'hd'}">
                      <div class="fg"><label>Global 域 baseUrl（海外账户，可选）</label><input type="url" id="eao11-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalBaseUrl)||'')}" placeholder="https://www.workbuddy.ai/v2"></div>
                      <div class="fg"><label>Global 域模型 URL（可选）</label><input type="url" id="eao12-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalModelsUrl)||'')}" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                      <div class="fg"><label>Global 域 Origin（可选）</label><input type="url" id="eao13-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalOrigin)||'')}" placeholder="https://www.workbuddy.ai"></div>
                      <div class="fg"><label>Global 域发起端点（可选）</label><input type="url" id="eao16-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalDeviceCodeUrl)||'')}" placeholder="${realmCopyFor(p).globalDeviceCodePlaceholder}"><span class="form-helper">登录域选「国际版」时使用，留空回退国内端点。</span></div>
                      <div class="fg"><label>Global 域轮询端点（可选）</label><input type="url" id="eao17-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalDeviceTokenUrl)||'')}" placeholder="${realmCopyFor(p).globalDeviceTokenPlaceholder}"></div>
                      <div class="fg"><label>Global 域刷新端点（可选）</label><input type="url" id="eao18-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalRefreshTokenUrl)||'')}" placeholder="${realmCopyFor(p).globalRefreshTokenPlaceholder}"></div>
                      </div>
                      <div class="fg"><label>单账号并发上限（WorkBuddy 池，可选）</label><input type="number" id="eao20-${escapePageHtml(p.id)}" min="0" value="${(p.oauth&&p.oauth.maxInFlight)??''}" placeholder="默认 3"><span class="form-helper">单账号最大在途并发请求数。0/留空 = 不限（仍计数）。调低可防账号被高并发打爆放大 5xx。</span></div>
                      <div class="fg"><label>国际版单号并发上限（可选）</label><input type="number" id="eao21-${escapePageHtml(p.id)}" min="0" value="${(p.oauth&&p.oauth.maxInFlightGlobal)??''}" placeholder="默认回落单号并发"><span class="form-helper">国际版（workbuddy.ai）账号单独的在途并发上限；0/留空 = 不分档（国际版与国内版同用上面「单号并发」）。global 域 WAF 风控更紧，可单独收紧此值。</span></div>
                    </div>
                  </div>
                  <div class="fc mt-1 field-row"><button class="btn btn-s" onclick="oauthConnect('${escapePageJsx(p.id)}')"><i class="fas fa-plug" aria-hidden="true"></i>发起连接</button><button class="btn btn-gh" onclick="fetchOauthModels('${escapePageJsx(p.id)}')"><i class="fas fa-cloud-download-alt" aria-hidden="true"></i>获取模型</button><button class="btn btn-gh" onclick="oauthStatus('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>状态</button><button class="btn btn-gh" onclick="oauthDisconnect('${escapePageJsx(p.id)}')"><i class="fas fa-unlink" aria-hidden="true"></i>断开</button><span id="oauth-st-${escapePageHtml(p.id)}" class="oauth-status"></span></div>
                  ${(p.oauth&&p.oauth.flowType==='browser')?`
                  <fieldset class="form-group" id="wbp-fs-${escapePageHtml(p.id)}"><legend>WorkBuddy 多账号池</legend><span class="form-helper">浏览器登录流每次成功登录都会把该账号加入账号池（按 uid 去重，多登一个 = 多个账号）。转发挑号：<b>7 天内到期的积分优先消耗</b>（到期越早越优先），窗口内没有待救积分时才按三因子加权（积分 / 闲置补偿 / 成功率）挑选；账号行上的「⏳ N 个包 7 天内到期」徽章与权益包明细里琥珀色的到期时间就是该规则的依据（到期时间按北京时间 CST 判定）。「权益包明细」里<b>已用完的包自动隐藏</b>，其余按到期升序排列（快过期的在最上面）。429/404/余额耗尽/401 等按策略冷却或禁用并轮换其他账号；无健康账号时从冷却账号选最早到期者顶班；每日签到后积分恢复自动解冻。冷却参数留空 = 默认（plan 12h / 429 60s / 连续 5 次错误冷却 10m）。reasoning_effort 透传/降级支持档位在下方「模型」列表每行的「effort」下拉里配置。</span>
                    <div class="fc mt-1 field-row" style="flex-wrap:wrap;gap:6px"><button class="btn btn-s" onclick="oauthPoolStatus('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>刷新账号池</button><button class="btn btn-s" onclick="oauthConnect('${escapePageJsx(p.id)}')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录新账号</button><button class="btn btn-gh btn-xs" onclick="oauthPoolExportModal('${escapePageJsx(p.id)}')"><i class="fas fa-file-export" aria-hidden="true"></i>导出凭证/Token</button><button class="btn btn-p" onclick="triggerDailyTasks('${escapePageJsx(p.id)}')"><i class="fas fa-tasks" aria-hidden="true"></i>一键日常（签到+活跃+旅行）</button><button class="btn btn-gh btn-xs" onclick="triggerActivityReport('${escapePageJsx(p.id)}')"><i class="fas fa-comments" aria-hidden="true"></i>活跃上报</button><button class="btn btn-gh btn-xs" onclick="triggerCatTravel('${escapePageJsx(p.id)}')"><i class="fas fa-cat" aria-hidden="true"></i>猫猫旅行</button><span id="wbp-st-${escapePageHtml(p.id)}" class="oauth-status"></span></div>
                    <div id="wbp-acc-${escapePageHtml(p.id)}" class="mt-1"></div>
                    <div class="fc mt-1 field-row" style="gap:8px"><input type="number" id="cd-plan-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.planMs?Math.round(p.cooldown.planMs/60000):''}" style="width:88px" placeholder="plan冷却" title="余额/权益耗尽（402）的硬冷却时长（分钟）。到期到次日 04:00，签到恢复后自动解冻。"><input type="number" id="cd-soft-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.softMs?Math.round(p.cooldown.softMs/1000):''}" style="width:88px" placeholder="429冷却" title="429 限流 / WAF 403 / 404 / 5xx（无 Retry-After 头时）的默认软冷却时长（秒）。"><input type="number" id="cd-err-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errThreshold?p.cooldown.errThreshold:''}" style="width:76px" placeholder="错误阈值" title="连续 5xx 错误次数阈值：达到后把该账号冷却 errMs 分钟。偶发 502 若携带 Retry-After 头会优先按其时长软冷却、不再触发本计数。"><input type="number" id="cd-errms-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errMs?Math.round(p.cooldown.errMs/60000):''}" style="width:88px" placeholder="错误冷却" title="达到错误阈值后的账号级冷却时长（分钟）。"><span class="mu" style="font-size:12px">冷却参数（保存后生效）</span></div>
                  </fieldset>`:''}
                  ${(p.oauth&&p.oauth.flowType==='qoder')||p.id==='qoder'?`
                  <fieldset class="form-group" id="qdp-fs-${escapePageHtml(p.id)}"><legend>Qoder 多账号池</legend><span class="form-helper">设备授权流每次成功登录都会把该账号加入账号池（按 user_id 去重，多登一个 = 多个账号）。转发挑号：<b>7 天内到期的积分优先消耗</b>（到期越早越优先），窗口内没有待救积分时才按剩余积分最多者挑选；账号行上的「⏳ N 个包 7 天内到期」徽章与额度包明细里琥珀色的到期时间就是该规则的依据（到期时间按北京时间 CST 判定，数据来自最近一次签到，或点「刷新账号池」时即时探测）。「额度包明细」分「套餐额度」（到期 = 套餐到期，即基础额度作废时刻）与「签到/赠送额度」（到期 = 最近一次领取的那笔 30 天有效期）两项，<b>已用完的包自动隐藏</b>，其余按到期升序排列（快过期的在最上面）。额度耗尽/429/鉴权失败按策略冷却或禁用并自动轮换下一个账号；每日签到后积分恢复自动解冻（<b>签到成功也一并清除「需重新登录」的禁用标记</b>——签到通过鉴权就是 token 有效的直接证据）。冷却参数留空 = 默认（额度耗尽 12h / 429 60s / 连续 5 次错误冷却 10m）。</span>
                    <div class="fc mt-1 field-row"><button class="btn btn-s" onclick="qoderPoolStatus('${escapePageJsx(p.id)}')" title="重新读取池状态，并顺便向每个账号探一次额度（会更新「额度包明细」与到期天数）"><i class="fas fa-sync" aria-hidden="true"></i>刷新账号池</button><button class="btn btn-s" onclick="oauthConnect('${escapePageJsx(p.id)}')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录新账号</button><button class="btn btn-gh btn-xs" onclick="oauthPoolExportModal('${escapePageJsx(p.id)}')"><i class="fas fa-file-export" aria-hidden="true"></i>导出凭证/Token</button><button class="btn btn-p" onclick="triggerCheckin('${escapePageJsx(p.id)}')"><i class="fas fa-calendar-check" aria-hidden="true"></i>立即签到</button><span id="qdp-st-${escapePageHtml(p.id)}" class="oauth-status"></span></div>
                    <div id="qdp-acc-${escapePageHtml(p.id)}" class="mt-1"></div>
                    <div class="fc mt-1 field-row" style="gap:8px"><input type="number" id="cd-plan-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.planMs?Math.round(p.cooldown.planMs/60000):''}" style="width:88px" placeholder="额度耗尽冷却" title="额度/权益耗尽（402）的硬冷却时长（分钟）。到期到次日 04:00，签到恢复后自动解冻。"><input type="number" id="cd-soft-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.softMs?Math.round(p.cooldown.softMs/1000):''}" style="width:88px" placeholder="429冷却" title="429 限流的默认软冷却时长（秒）。"><input type="number" id="cd-err-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errThreshold?p.cooldown.errThreshold:''}" style="width:76px" placeholder="错误阈值" title="连续错误次数阈值：达到后把该账号冷却「错误冷却」时长。"><input type="number" id="cd-errms-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errMs?Math.round(p.cooldown.errMs/60000):''}" style="width:88px" placeholder="错误冷却" title="达到错误阈值后的账号级冷却时长（分钟）。"><span class="mu" style="font-size:12px">冷却参数（保存后生效）</span></div>
                    <div class="qoder-device-block" data-qoder-device="${escapePageHtml(p.id)}" style="margin-top:10px;border-top:1px solid var(--border,#e5e7eb);padding-top:8px">
                      <div class="collapse-section">
                        <div class="fc field-row" style="align-items:center;justify-content:space-between;gap:8px">
                          <button class="collapse-btn" onclick="toggleCollapse('qdwrap-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false" aria-controls="qdwrap-${escapePageHtml(p.id)}"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 真机设备身份（全局配置，所有 Qoder 提供商共用一份）</button>
                          <span class="mu qoder-device-state" style="font-size:12px;white-space:nowrap"></span>
                        </div>
                        <div id="qdwrap-${escapePageHtml(p.id)}" class="hd">
                          <span class="form-helper">官方 2026-09-26 起要求请求携带设备标识才下发「每日领取 100 Credits」；uid 派生的假身份<b>不报错</b>，但活动列表里会静默少掉这条活动（表现就是「无可用签到活动」）。这份身份是<b>机器级常量</b>：抄一次长期回放，<b>不会按时间过期</b>，只有「重装 Qoder 桌面端 / 换机器 / 上游改校验规则」才会失效——失效的表现同样是活动列表变空（签到日志里 <code>showCampaign:false</code>，或活动里不再出现「每日领取 100 Credits」），<b>重新提取一次覆盖保存即可</b>，不需要改代码。存 KV，保存后下次签到生效。</span>
                          <div class="collapse-section" style="margin-top:6px">
                            <button class="collapse-btn" onclick="toggleCollapse('qdext-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false" aria-controls="qdext-${escapePageHtml(p.id)}"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 怎么提取（首次配置 / 失效后重取；点这里复制脚本）</button>
                            <div id="qdext-${escapePageHtml(p.id)}" class="hd">
                              <span class="form-helper">在<b>装了 Qoder 桌面端的那台 Windows 机器</b>上：① 点下面「复制脚本」；② 存成 <code>qoder-device.ps1</code>（记事本直接保存即可，脚本全 ASCII，任何编码都能跑）；③ 运行 <code>powershell -ExecutionPolicy Bypass -File qoder-device.ps1</code>（或右键「使用 PowerShell 运行」）；④ 把输出的 JSON 整段贴到下面的框里。脚本只<b>读</b>本机 Qoder 的安装目录与数据目录（<code>runtime-info.exe</code> / <code>auth.machine-id</code> / <code>build-manifest.json</code>），<b>不联网、不写任何文件</b>，输出就是网关要发的 8 个 <code>Cosy-*</code> 头。</span>
                              <div class="fc mt-1 field-row"><button class="btn btn-gh btn-xs" onclick="copyQoderExtractScript(this)"><i class="fas fa-copy" aria-hidden="true"></i>复制脚本</button><span class="form-helper">PowerShell 5.1+（Win10/11 自带），不需要 Python。</span></div>
                              <pre class="qoder-extract-script" style="max-height:300px;overflow:auto;white-space:pre;font-size:11px;line-height:1.45;background:var(--bg-soft,#f8fafc);border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:8px;margin:6px 0 0"># Qoder real-device identity extractor (Windows PowerShell 5.1+, no 3rd-party deps, read-only)
# Usage:  powershell -ExecutionPolicy Bypass -File qoder-device.ps1
# Output: the JSON block at the end -> copy it whole into the gateway admin panel.
# NOTE: ASCII only on purpose. Windows PowerShell 5.1 reads BOM-less UTF-8 as the legacy ANSI
#       codepage, so non-ASCII text here would corrupt into syntax errors depending on how the
#       file was saved. Keep every line ASCII and it runs no matter the encoding.
$ErrorActionPreference = 'Continue'

# 1) locate runtime-info.exe (shipped inside the Qoder install dir under resources\\umid\\)
$roots = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\\Qoder'),
  (Join-Path $env:LOCALAPPDATA 'Programs\\Qoder CN'),
  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles')) 'Qoder'),
  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles')) 'Qoder CN'),
  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Qoder'),
  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Qoder CN')
)
$uninst = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$roots += (Get-ItemProperty $uninst -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*Qoder*' -and $_.InstallLocation } |
  Select-Object -ExpandProperty InstallLocation)
$exe = $null
foreach ($r in $roots) {
  if (-not $r) { continue }
  $p = Join-Path $r 'resources\\umid\\runtime-info.exe'
  if (Test-Path $p) { $exe = (Resolve-Path $p).Path; break }
}
if (-not $exe) {
  Write-Host '[X] runtime-info.exe not found. Is the Qoder desktop app installed on this machine?'
  Write-Host '    You can also add its install dir to $roots at the top of this script.'
  exit 1
}
Write-Host ('[OK] runtime-info.exe: ' + $exe)

# 2) run it (no account on stdin; the last stdout line is the device JSON).
#    The empty pipe below is LOAD-BEARING: --account-stdin makes the exe read stdin, and in an
#    interactive console stdin is the keyboard, so it blocks forever waiting for input (the
#    script just sits there after printing the exe path). '' gives it an immediate EOF - the
#    same thing Python's subprocess(input=b"") does. Do not "clean up" this pipe.
$ri = @{}
$raw = '' | &amp; $exe --account-stdin 2>$null
$line = ($raw | Where-Object { $_.Trim() } | Select-Object -Last 1)
if ($line) {
  try { $ri = $line | ConvertFrom-Json } catch { Write-Host ('[X] runtime-info output is not JSON: ' + $line); exit 1 }
}

# 3) machineId: auth.machine-id inside the client data dir (intl com.qoder.app.* / cn com.qodercn.app.*)
$machineId = ''
$dirs = Get-ChildItem (Join-Path $env:APPDATA 'com.qoder*.app.*') -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending
foreach ($d in $dirs) {
  $f = Join-Path $d.FullName 'auth.machine-id'
  if (Test-Path $f) { $machineId = (Get-Content $f -Raw).Trim(); if ($machineId) { break } }
}

# 4) version: productVersion from build-manifest.json in the install dir (client version)
$version = ''
$mf = Join-Path (Split-Path (Split-Path $exe -Parent) -Parent) 'build-manifest.json'
if (Test-Path $mf) { $version = (Get-Content $mf -Raw | ConvertFrom-Json).productVersion }

# 5) arch + hostname (avoid $host: it is a read-only built-in variable)
$arch = 'x86_64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'aarch64' }
$pcName = $env:COMPUTERNAME

$device = [ordered]@{
  clientType      = '10'
  machineOS       = ($arch + '_windows')
  machineHostname = $pcName
  machineId       = $machineId
  machineToken    = "$($ri.machineToken)"
  machineCode     = "$($ri.machineCode)"
  machineType     = "$($ri.machineType)"
  version         = $version
}

Write-Host ''
Write-Host '--- copy the JSON below into the admin panel (real-device identity) ---'
$json = [pscustomobject]@{ device = $device } | ConvertTo-Json -Depth 4
Write-Host ''
Write-Host '--- copy the JSON below into the admin panel (real-device identity) ---'
$json
Write-Host ''
Write-Host ('[check] lengths -> machineId ' + $device.machineId.Length + ' / machineToken ' + $device.machineToken.Length + ' / machineCode ' + $device.machineCode.Length + ' / machineType ' + $device.machineType.Length)
if (-not $device.machineToken) { Write-Host '[!] machineToken is empty: runtime-info.exe returned no identity. Do NOT save yet - an identity without it gets no daily campaign.' }
if (-not $device.machineId) { Write-Host '[!] machineId is empty: auth.machine-id not found. Has the desktop app been signed in on this machine?' }

# Also write the JSON next to this script. A double-clicked / "Run with PowerShell" .ps1 closes
# its window the instant the script ends, so the printed JSON is easy to miss completely
# (reported 2026-10-02: "it exits immediately and I never saw the result"). A file cannot be lost.
# UTF-8 WITHOUT BOM on purpose: a BOM would ride along when the file content is pasted into the
# panel and break its JSON.parse.
$outFile = Join-Path (Split-Path -Parent $PSCommandPath) 'qoder-device.json'
try {
  [System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host ('[saved] also written to: ' + $outFile)
} catch {
  Write-Host ''
  Write-Host ('[!] could not write ' + $outFile + ' - just copy the JSON printed above instead')
}

# Keep the window open while a human is watching. Skipped when stdin is redirected, so piping
# and automation never block on Read-Host.
$waitForHuman = $false
try { $waitForHuman = -not [Console]::IsInputRedirected } catch { $waitForHuman = $false }
if ($waitForHuman) {
  Write-Host ''
  Read-Host 'Press Enter to close'
}</pre>
                            </div>
                          </div>
                          <label class="fg" style="margin-top:8px">
                            <span>粘贴提取脚本输出的 JSON（整段 <code>config.json</code> 或只贴 <code>device</code> 块）</span>
                            <textarea class="fx1 qoder-device-json" rows="4" style="white-space:pre-wrap;font-family:monospace;font-size:12px" placeholder='{"device":{"clientType":"10","machineId":"...","machineToken":"...","machineType":"...","machineCode":"...","machineOS":"x86_64_windows","machineHostname":"...","version":"0.4.3"}}' spellcheck="false"></textarea>
                          </label>
                          <div class="fc mt-1 field-row">
                            <button class="btn btn-gh btn-xs" onclick="qoderDeviceFillFromJson(this)"><i class="fas fa-file-import" aria-hidden="true"></i>从 JSON 填充</button>
                            <span class="form-helper">键名大小写/下划线不敏感，<code>COSY_MACHINE_TOKEN</code>、<code>productVersion</code> 这类写法也认。</span>
                          </div>
                          <div class="form-grid">
                            ${QODER_DEVICE_FIELDS.map((f) => `
                            <label class="fg">
                              <span>${escapePageHtml(f.header)}</span>
                              <input type="text" class="fx1 qoder-device-input" data-key="${escapePageHtml(f.key)}" autocomplete="off" spellcheck="false" placeholder="${escapePageHtml(f.placeholder)}">
                              <small class="form-helper" style="display:block">${escapePageHtml(f.hint)}</small>
                            </label>`).join('')}
                          </div>
                          <div class="fc mt-1 field-row">
                            <button class="btn btn-p btn-xs" onclick="saveQoderDevice(this)"><i class="fas fa-save" aria-hidden="true"></i>保存</button>
                            <button class="btn btn-gh btn-xs" onclick="resetQoderDevice(this)"><i class="fas fa-undo" aria-hidden="true"></i>清空</button>
                            <span class="form-helper">留空字段的后果：<code>Cosy-ClientType / MachineOS / MachineHostname / Version</code> 回退内置默认值；<code>MachineId / MachineToken / MachineType / MachineCode</code> 回退 uid 派生值——<b>派生值拿不到每日活动</b>。保存后签到日志里 <code>deviceIdentity</code> 会从 <code>derived</code> 变成 <code>native</code>。</span>
                          </div>
                          <div class="mu mt-1 qoder-device-result" aria-live="polite"></div>
                        </div>
                      </div>
                    </div>
                  </fieldset>`:''}
                  ${(p.oauth&&(p.oauth.flowType==='m365-pkce'||p.oauth.flowType==='m365-ropc'))?`
                  <fieldset class="form-group" id="m365-fs-${escapePageHtml(p.id)}"><legend>M365 账号池</legend><span class="form-helper">本提供商可挂多个订阅账号（授权码/账密各连一次即入池）。网关按健康自动选择，限流/超限自动切换。每个账号默认串行（并发上限 1，可选 M365_ACCOUNT_DEFAULT_CONCURRENCY 调整），两次调用间至少间隔 1 秒。</span>
                    <div class="fc mt-1 field-row"><button class="btn btn-s" onclick="oauthConnect('${escapePageJsx(p.id)}')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>连接新账号</button><button class="btn btn-s" onclick="m365Render('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>刷新账号池</button><button class="btn btn-s" onclick="m365ConversationsModal('${escapePageJsx(p.id)}')"><i class="fas fa-comments" aria-hidden="true"></i>云端会话管理</button></div>
                    <div class="fc mt-1 field-row"><label class="tg" title="启用会话级多账号分摊 (Account Spread)"><input type="checkbox" id="m365-spread-${escapePageHtml(p.id)}" ${p.accountSpread?'checked':''}><span class="sl"></span></label><span style="font-size:13px;margin-left:6px">会话级多账号分摊 (Account Spread)</span><span class="mu" style="font-size:12px;margin-left:8px">开启后跨请求轮询不同健康账号分摊负载</span></div>
                    <div id="m365-acc-${escapePageHtml(p.id)}" class="mt-1"><p class="mu">展开后自动加载账号池。</p></div>
                  </fieldset>`:''}
                </fieldset>
              </div>
              <fieldset class="form-group ${p.authType==='oauth-device'?'hd':''}" id="keys-fs-${escapePageHtml(p.id)}"><legend id="key-legend-${escapePageHtml(p.id)}">${isTraeProviderUI(p)?'TRAE 账号凭证（每个账号一行 JSON）':(p.id==='cline'?'Cline RefreshTokens（每个账号一行）':'上游 API Keys')}</legend><div id="keys-${escapePageHtml(p.id)}">${p.apiKeys.map((k, ki)=>keyRowHtml(p, k, ki)).join('')}</div><div class="fc mt-1 field-row"><input type="password" id="nk-${escapePageHtml(p.id)}" placeholder="${isTraeProviderUI(p)?'新的 TRAE 凭证 JSON（或点「登录账号」自动写入）':(p.id==='cline'?'新的 RefreshToken（一个账号一行）':'新的 API Key')}" class="fx1"><button class="btn btn-s btn-xs" onclick="addKeyRow('${escapePageJsx(p.id)}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div>${p.id==='cline'?`<div class="fc mt-1 field-row"><button class="btn btn-s btn-xs" onclick="clineCheckAccounts('${escapePageJsx(p.id)}')" title="逐个用 refreshToken 换一次 accessToken，判断是否仍可用并关联账号邮箱"><i class="fas fa-heart-pulse" aria-hidden="true"></i>检测全部账号</button><span class="mu" id="cline-chk-${escapePageHtml(p.id)}" aria-live="polite" style="font-size:12px"></span></div>`:''}<span id="key-hint-${escapePageHtml(p.id)}" class="form-helper">${isTraeProviderUI(p)?'TRAE SOLO 账号凭证为登录后自动写入的 JSON（也可粘贴 trae 登录脚本落盘的 trae-*.json 内容）。每行一个账号、按剩余积分自动挑选，额度用尽自动冷却轮换；禁用该 Key 即停用账号。':(p.id==='cline'?'Cline 使用 Cline 账号的 refreshToken（长期钥匙）。每个账号一行，额度用完自动切换；留空禁用某个账号。点「检测全部账号」会用每个 token 换一次 accessToken：徽章显示是否仍可用，并自动把上游返回的邮箱填进「账号」框；上游关联不到（或 token 已失效）时可手工填账号名便于分辨，只用于显示。':' ')}</span></fieldset>
              ${p.type === 'kuku' ? `<div class="fg"><label for="kuku-think-${escapePageHtml(p.id)}">Kuku 思考模式</label><input type="number" id="kuku-think-${escapePageHtml(p.id)}" min="0" max="10" value="${p.kukuThinkMode ?? 3}"><span class="form-helper">允许 0 到 10，默认 3。</span></div>
              <div class="fg"><button class="btn btn-p btn-sm" onclick="kukuQrLogin('${escapePageJsx(p.id)}')" type="button"><i class="fas fa-qrcode" aria-hidden="true"></i> 扫码登录自动写 Cookie</button><span class="form-helper">用手机百度 App 扫码，后台自动写入 BDUSS Cookie（已保存的提供商将直接更新 Key）。</span></div>` : ''}
              <fieldset class="form-group" id="models-fs-${escapePageHtml(p.id)}" data-effort="${isWorkbuddyProviderUI(p)?'1':'0'}"><legend>模型</legend><div id="ml-${escapePageHtml(p.id)}">${p.models.map((m,mi)=>{ const pol=((p.oauth&&p.oauth.effortPolicy)||{})[m.id]||[]; return `<div class="fc mb-3 field-row" data-idx="${mi}"><input type="text" value="${escapePageHtml(m.id)}" class="fx1" id="mid-${escapePageHtml(p.id)}-${mi}" placeholder="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" ${m.enabled?'checked':''} id="men-${escapePageHtml(p.id)}-${mi}" aria-label="启用模型"><span class="sl"></span></label><label class="tg" title="启用思维引导注入"><input type="checkbox" ${(p.thinkingInject||[]).includes(m.id)?'checked':''} id="mit-${escapePageHtml(p.id)}-${mi}" aria-label="启用思维引导注入"><span class="sl"></span></label><label class="tg" title="启用缓存前缀注入"><input type="checkbox" ${(p.cachePrefixInject||[]).includes(m.id)?'checked':''} id="mcp-${escapePageHtml(p.id)}-${mi}" aria-label="启用缓存前缀注入"><span class="sl"></span></label>${effDdEditHtml(p.id, mi, pol, !isWorkbuddyProviderUI(p))}<button class="btn btn-gh btn-xs" onclick="testMdl('${escapePageJsx(p.id)}','${escapePageJsx(m.id)}',${mi})" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="rmMdl('${escapePageJsx(p.id)}',${mi})" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>`}).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nmid-${escapePageHtml(p.id)}" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s btn-xs" onclick="addMdl('${escapePageJsx(p.id)}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div><span class="form-helper">每个模型行「启用模型」开关旁的开关依次为「思维引导注入」「缓存前缀注入」，勾选后该模型转发前会被注入对应固定提示词；不勾选则原样转发。「effort」下拉声明该模型的 reasoning_effort 支持档位（多选），仅对 WorkBuddy / CodeBuddy 提供商显示——其余上游不消费该配置。</span></fieldset>
              ${isTraeProviderUI(p)?`
              <fieldset class="form-group" id="trae-fs-${escapePageHtml(p.id)}"><legend>TRAE 账号池（SOLO / Work 双通道）</legend><span class="form-helper">多账号双积分反代：自动隔离通用积分 (SOLO) 与 Work 专属积分。正常调用优先消耗通用积分；当遇到 4008 额度耗尽或 429 限流时，系统自动无缝降级到 Work 专有通道。支持一键刷新双通道积分与每日自动签到补积分。</span>
                <div class="fc mt-1 field-row">
                  <button class="btn btn-s" onclick="traeLogin('${escapePageJsx(p.id)}')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录账号</button>
                  <button class="btn btn-s" onclick="traeCheckin('${escapePageJsx(p.id)}')"><i class="fas fa-calendar-check" aria-hidden="true"></i>全部签到</button>
                  <button class="btn btn-s" onclick="traeRefreshCredits('${escapePageJsx(p.id)}')"><i class="fas fa-coins" aria-hidden="true"></i>刷新积分</button>
                  <button class="btn btn-s" onclick="traeModels('${escapePageJsx(p.id)}')"><i class="fas fa-cloud-download-alt" aria-hidden="true"></i>拉取模型</button>
                  <button class="btn btn-gh" onclick="traeStatus('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>刷新状态</button>
                </div>
                <div id="trae-st-${escapePageHtml(p.id)}" class="oauth-status" aria-live="polite"></div>
                <div id="trae-acc-${escapePageHtml(p.id)}" class="mt-1"></div>
                <div class="fc mt-1 field-row" style="gap:8px"><input type="number" id="cd-plan-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.planMs?Math.round(p.cooldown.planMs/60000):''}" style="width:88px" placeholder="plan冷却" title="余额/权益耗尽（402）的硬冷却时长（分钟）。到期到次日 04:00，签到恢复后自动解冻。"><input type="number" id="cd-soft-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.softMs?Math.round(p.cooldown.softMs/1000):''}" style="width:88px" placeholder="429冷却" title="429 限流的默认软冷却时长（秒）。"><input type="number" id="cd-err-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errThreshold?p.cooldown.errThreshold:''}" style="width:76px" placeholder="错误阈值" title="连续错误次数阈值：达到后把该账号冷却「错误冷却」时长。"><input type="number" id="cd-errms-${escapePageHtml(p.id)}" value="${p.cooldown&&p.cooldown.errMs?Math.round(p.cooldown.errMs/60000):''}" style="width:88px" placeholder="错误冷却" title="达到错误阈值后的账号级冷却时长（分钟）。"><span class="mu" style="font-size:12px">冷却参数（留空 = 默认 plan 12h / 429 60s / 连续 3 次错误冷却 10m）</span></div>
                <div class="collapse-section">
                  <button class="collapse-btn" onclick="toggleVbCollapse('trae-budget-adv-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false">
                    <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 省钱预算（历史裁剪 / 工具压缩，可选）
                  </button>
                  <div id="trae-budget-adv-${escapePageHtml(p.id)}" class="hd">
                    <fieldset class="form-group"><legend>省钱预算</legend><span class="form-helper">开启后，在上方模型列表里勾选了「命中省钱预算」的模型，转发前会被裁剪历史、压缩工具 schema，从而降低上游输入积分；勾选 = 仅所选模型生效；关闭开关 = 完全保持现有转发，零影响。</span>
                      <label class="switch-label"><span>启用省钱预算（TRAE 长会话裁剪）</span><span class="tg"><input type="checkbox" id="trae-budget-${escapePageHtml(p.id)}" ${p.traeEnableRemoteBudget?'checked':''}><span class="sl"></span></span></label>
                      <div id="trae-trm-${escapePageHtml(p.id)}" class="hd" data-rmodels="${escapePageHtml(p.traeRemoteOnlyModels||'')}"></div>
                      <div class="fg"><label>历史最多保留条数（留空 = 默认 20）</label><input type="number" id="trae-mm-${escapePageHtml(p.id)}" value="${p.traeMaxMessages??''}" placeholder="20"></div>
                      <div class="fg"><label>历史总字符数上限（留空 = 不限）</label><input type="number" id="trae-mhc-${escapePageHtml(p.id)}" value="${p.traeMaxHistoryChars??''}" placeholder="0（不限）"></div>
                      <div class="fg"><label>单个工具 schema 上限（留空 = 默认 10000）</label><input type="number" id="trae-mtsc-${escapePageHtml(p.id)}" value="${p.traeMaxToolSchemaChars??''}" placeholder="10000"></div>
                    </fieldset>
                  </div>
                </div>
              </fieldset>`:''}
              ${isDeepseekAppProviderUI(p)?`
              <fieldset class="form-group" id="ds-fs-${escapePageHtml(p.id)}"><legend>DeepSeek App token 池（浏览器注入）</legend>
                <span class="form-helper">上游把密码登录硬卡成风控（真实浏览器同样返回 RISK_DEVICE_DETECTED），所以凭据只能从浏览器里取一次：① 浏览器登录 <b>chat.deepseek.com</b>；② F12 → Application → Local Storage → https://chat.deepseek.com；③ 取 <b>userToken</b> 的值（形如 {"value":"&lt;64 字符&gt;","__version":…}，只填 value 里那 64 字符，整段贴进来也能识别）；④ 取 <b>deepseek-device-id:chat</b> 的值（UUID）。token 会过期：失效的条目会标红，按提示重新注入即可。<br>账号被上游<b>禁言/封禁/判设备风险</b>时会自动「停用」该条（封禁 = 永久，禁言/风险按窗口到期自动恢复），期间完全不打上游——这是防止上游续期甚至升级处罚的关键；封禁只能人工点「解除停用」。</span>
                <div class="fc mt-1 field-row" style="gap:8px">
                  <input type="password" id="ds-tok-${escapePageHtml(p.id)}" class="fx1" placeholder="userToken 的 value（64 字符）" aria-label="DeepSeek token">
                </div>
                <div class="fc mt-1 field-row" style="gap:8px">
                  <input type="text" id="ds-dev-${escapePageHtml(p.id)}" class="fx1" placeholder="deepseek-device-id:chat（UUID）" aria-label="DeepSeek device id">
                  <input type="text" id="ds-label-${escapePageHtml(p.id)}" style="width:150px" placeholder="备注（可选）" aria-label="备注">
                </div>
                <div class="fc mt-1 field-row" style="gap:8px">
                  <button class="btn btn-s" onclick="deepseekTokenAdd('${escapePageJsx(p.id)}')"><i class="fas fa-plus" aria-hidden="true"></i>注入并判活</button>
                  <button class="btn btn-gh" onclick="deepseekTokenList('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>刷新池状态</button>
                </div>
                <div id="ds-st-${escapePageHtml(p.id)}" class="oauth-status" aria-live="polite"></div>
                <div id="ds-list-${escapePageHtml(p.id)}" class="mt-1"></div>
              </fieldset>
              <fieldset class="form-group" id="ds-think-fs-${escapePageHtml(p.id)}"><legend>深度思考模式</legend>
                <label class="switch-label"><span>默认关闭深度思考（走快路径，适合翻译/改写等轻量任务）</span><span class="tg"><input type="checkbox" id="ds-thinkoff-${escapePageHtml(p.id)}" ${p.deepseekThinkingOff?'checked':''}><span class="sl"></span></span></label>
                <span class="form-helper">上游默认<b>开</b>思考：思考期间首字节明显更慢，且思考内容会以 <code>reasoning_content</code> 一起返回。勾上后本提供商默认发 <code>thinking_enabled:false</code>。<br><b>优先级：客户端显式声明 &gt; 本开关 &gt; 内置默认（开）</b>——客户端发 <code>thinking:{type:"enabled"}</code> 或非 none 的 <code>reasoning_effort</code> 时本开关不生效，所以需要思考的个别请求仍可单独开。<br>翻译场景建议：勾上本开关，并确认客户端不主动传 reasoning 参数。</span>
              </fieldset>`:''}
              <div class="collapse-section">
                <button class="collapse-btn" onclick="toggleVbCollapse('vb-fs-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false">
                  <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 识图模型配置（可选）
                </button>
                <fieldset class="form-group hd" id="vb-fs-${escapePageHtml(p.id)}"><legend>识图模型配置（可选）</legend><span class="form-helper">勾选识图模型后，本提供商所有模型都自动支持图片：请求含图时先由识图模型转写为文本再按原模型转发（留空主文本模型）。若选了主文本模型，则本提供商作为图片转写桥，全部请求转发到该主文本模型。全部取消勾选即恢复普通转发。</span>
                  <div class="fg"><label>主文本模型（留空 = 转发到本提供商自身模型）</label>${vbRadioContainer('vb-primary-' + escapePageHtml(p.id), 'vb-primary-' + escapePageHtml(p.id), (p.visionBridge&&p.visionBridge.primary)||'')}</div>
                  <div class="fg"><label>识图模型（视觉模型链，勾选后请求含图时按勾选顺序依次转写，全部失败按下方策略处理）</label>${vbCheckContainer('vb-vision-' + escapePageHtml(p.id), (p.visionBridge&&p.visionBridge.vision)||[])}</div>
                  <div class="fg"><label>视觉转写失败策略</label><select id="vb-fail-${escapePageHtml(p.id)}" class="select-sm"><option value="error" ${!p.visionBridge||p.visionBridge.onVisionFailure==='error'?'selected':''}>error（返回错误）</option><option value="text_only" ${p.visionBridge&&p.visionBridge.onVisionFailure==='text_only'?'selected':''}>text_only（丢弃图片仅转发文本）</option></select></div>
                </fieldset>
              </div>
              <div class="collapse-section${isCnbProviderUI(p)?'':' hd'}" id="atb-cs-${escapePageHtml(p.id)}">
                <button class="collapse-btn" onclick="toggleAdvOauth('atb-fs-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false">
                  <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 工具桥（XYML 提示词注入，仅 CNB 需要，可选）
                </button>
                <fieldset class="form-group hd" id="atb-fs-${escapePageHtml(p.id)}"><legend>工具桥</legend><label class="switch-label"><span>启用工具桥（XYML 提示词注入 + 流式解析回 tool_calls，仅 CNB 需要）</span><span class="tg"><input type="checkbox" id="atb-${escapePageHtml(p.id)}" ${p.toolBridge?'checked':''}><span class="sl"></span></span></label></fieldset>
              </div>
              <div class="collapse-section">
                <button class="collapse-btn" onclick="toggleAdvOauth('aum-fs-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false">
                  <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 模型策略（未配置模型透传，可选）${p.allowUnlistedModels?'<span class="bd bd-on" style="margin-left:6px">透传已启用</span>':''}
                </button>
                <fieldset class="form-group hd" id="aum-fs-${escapePageHtml(p.id)}"><legend>模型策略</legend><label class="switch-label"><span>允许未配置模型透传——开启后请求该提供商的任意 modelId 都直接转发（跳过「未配置」校验），适合模型频繁上架、不想每次手动加模型的提供商（如 OpenRouter）。</span><span class="tg"><input type="checkbox" id="aum-${escapePageHtml(p.id)}" ${p.allowUnlistedModels?'checked':''}><span class="sl"></span></span></label>${opencodeEffortSelectHtml('re-' + p.id, p.reasoningEffort)}</fieldset>
              </div>
              <div class="collapse-section">
                <button class="collapse-btn" onclick="toggleAdvOauth('psys-fs-${escapePageJsx(p.id)}', this)" type="button" aria-expanded="false">
                  <i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 系统提示词体系（模式 / 自有提示词，可选）${p.promptMode==='custom'?'<span class="bd bd-on" style="margin-left:6px">custom 已启用</span>':''}
                </button>
                <fieldset class="form-group hd" id="psys-fs-${escapePageHtml(p.id)}"><legend>系统提示词体系</legend><div class="fc mt-1 field-row" style="align-items:flex-start"><label style="width:110px;font-size:13px;padding-top:6px">提示词模式</label><select id="pmode-${escapePageHtml(p.id)}" style="flex:1"><option value="passthrough" ${(p.promptMode||'passthrough')==='passthrough'?'selected':''}>passthrough（透传客户端 system，被拦自动降级重试）</option><option value="custom" ${p.promptMode==='custom'?'selected':''}>custom（用下方自有提示词替换）</option><option value="append" ${p.promptMode==='append'?'selected':''}>append（保留客户端 system，另追加一条网关 system）</option></select></div><div class="fc mt-1 field-row" style="align-items:flex-start"><label style="width:110px;font-size:13px;padding-top:6px">自有提示词</label><textarea id="ptext-${escapePageHtml(p.id)}" rows="4" placeholder="custom/append 模式下注入的提示词" style="flex:1">${escapePageHtml(p.promptText||'')}</textarea></div><span class="form-helper">passthrough：透传客户端原始 system；遇内容拦截误报自动换中性提示词重试一次。custom：出站时用上方提示词整体替换 system/developer，从源头消除指纹误报。append：在开头连续 system/developer 块之后追加一条网关 system，客户端项目规范逐字保留、两者并用（降级重试时仍退化为整体替换）。</span></fieldset>
              ${p.id === 'cline' ? clineUpstreamSectionHtml(p) : ''}
              <div class="detail-actions"><div id="tr-${escapePageHtml(p.id)}" aria-live="polite"></div><div>${((p.id === 'cnb' || (p.baseUrl && p.baseUrl.indexOf('cnb.cool') !== -1)) || ((p.oauth && (p.oauth.flowType === 'm365-pkce' || p.oauth.flowType === 'm365-ropc')))) ? '<button class="btn btn-s" onclick="fetchOauthModels(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ((isSensenovaProviderUI(p) || p.apiType === 'openai' || p.id === 'cline' || p.id === 'opencode') && !isTraeProviderUI(p) && !(p.authType === 'oauth-device' && p.oauth)) ? '<button class="btn btn-s" onclick="fetchEditModels(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ''}${p.id === 'cline' ? '<button class="btn btn-s" onclick="clineOAuthConnect(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>一键授权获取 Token</button>' : ''}<button class="btn btn-d" onclick="del('${escapePageJsx(p.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button><button class="btn btn-p" onclick="save('${escapePageJsx(p.id)}')"><i class="fas fa-save" aria-hidden="true"></i>保存更改</button></div></div>
            </div>
          </article>`).join('') : `<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>`}
        </div>
      </section>

      <!-- P3：M365 账号池独立页已并入提供商详情（#m365-fs-<id>），此锚点仅为兼容旧链接保留重定向 -->
      <span id="m365-accounts" class="hd" aria-hidden="true"></span>

      <section id="proxy-keys" class="workspace-section" aria-labelledby="proxy-keys-title">
        <div class="section-heading section-heading--admin"><div><h2 id="proxy-keys-title">转发 Key</h2><p>客户端使用这些 Key 访问统一的 <code>/v1</code> 接口。</p></div><button class="btn btn-p" onclick="genKey()"><i class="fas fa-plus" aria-hidden="true"></i>生成转发 Key</button></div>
        <div class="key-list">
          ${proxyKeys.length===0?'<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>':''}
          ${proxyKeys.map(k=>`<article class="ki" data-id="${escapePageHtml(k.id)}"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div><div class="kv"><span id="kv-${escapePageHtml(k.id)}" data-full="${escapePageHtml(k.key)}">${escapePageHtml(k.key.length>12?k.key.substring(0,8)+'••••'+k.key.substring(k.key.length-4):k.key)}</span><button class="icon-btn" onclick="toggleKeyVis('${escapePageJsx(k.id)}')" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button><button class="icon-btn" onclick='copyText("${escapePageJsx(k.key)}",this)' title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div><h3>${escapePageHtml(k.name)}</h3><p>创建于 ${new Date(k.createdAt).toLocaleDateString()} · ${k.expiresAt?(new Date(k.expiresAt).getTime()>Date.now()?'有效至 '+new Date(k.expiresAt).toLocaleDateString():'<span class="c-d">已过期</span>'):'永久有效'} · <span class="bd ${k.allowedModels&&k.allowedModels.length>0?'bd-on':'bd-off'}">${k.allowedModels&&k.allowedModels.length>0?k.allowedModels.length+' 个模型':'全部模型'}</span></p></div></div><div class="key-actions"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} onchange="toggleProxyKey('${escapePageJsx(k.id)}',this.checked)" aria-label="启用 ${escapePageHtml(k.name)}"><span class="sl"></span></label><span class="bd ${k.enabled?'bd-on':'bd-off'}">${k.enabled?'已启用':'已禁用'}</span><button class="btn btn-gh btn-xs" onclick="editKeyExpiry('${escapePageJsx(k.id)}')" title="修改过期时间 / 续期"><i class="fas fa-clock" aria-hidden="true"></i>续期</button><button class="btn btn-gh btn-xs" onclick="editKeyModels('${escapePageJsx(k.id)}')" title="模型筛选"><i class="fas fa-filter" aria-hidden="true"></i>模型筛选</button><button class="btn btn-d btn-xs" onclick="rmKey('${escapePageJsx(k.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div></article>`).join('')}
        </div>
      </section>

      <!-- ===== Analytics Engine 使用统计 ===== -->
      <section id="analytics" class="workspace-section" aria-labelledby="analytics-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="analytics-title">使用统计</h2><p>Analytics Engine 数据采集，基于 Cloudflare Workers Analytics Engine。</p></div>
          <div class="admin-heading__actions">
            <button class="btn btn-gh btn-xs" onclick="loadAnalytics()" id="analytics-refresh"><i class="fas fa-sync-alt" aria-hidden="true"></i>刷新</button>
            <span class="range-group" id="analytics-range-group">
              <button class="btn btn-gh btn-xs is-active" data-analytics-range="24h" onclick="setAnalyticsRange('24h',this)">24 小时</button>
              <button class="btn btn-gh btn-xs" data-analytics-range="7d" onclick="setAnalyticsRange('7d',this)">7 天</button>
              <button class="btn btn-gh btn-xs" data-analytics-range="30d" onclick="setAnalyticsRange('30d',this)">30 天</button>
            </span>
          </div>
        </div>
        <div id="analytics-error" class="al al-e hd" role="alert" aria-live="assertive"></div>
        <div class="admin-metrics analytics-metrics" id="analytics-overview">
          <div><span class="analytics-value" id="metric-requests">—</span><p>总请求数</p><small></small></div>
          <div><span class="analytics-value" id="metric-success">—</span><p>成功率</p><small></small></div>
          <div><span class="analytics-value" id="metric-input">—</span><p>输入 Token</p><small></small></div>
          <div><span class="analytics-value" id="metric-output">—</span><p>输出 Token</p><small></small></div>
          <div><span class="analytics-value" id="metric-latency">—</span><p>平均延迟</p><small></small></div>
        </div>
        <div class="analytics-charts">
          <div class="analytics-chart-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-cube"></i></span><div><h3>模型调用排行</h3><p>按请求量 / Token 用量排序，点击切换</p></div></div></div>
            <div class="ranking-tabs" role="tablist">
              <button class="btn btn-gh btn-xs is-active" data-rank-tab="requests" onclick="switchModelRanking('requests',this)" role="tab" aria-selected="true">请求次数</button>
              <button class="btn btn-gh btn-xs" data-rank-tab="tokens" onclick="switchModelRanking('tokens',this)" role="tab" aria-selected="false">Token 用量</button>
            </div>
            <div id="model-ranking"><div class="analytics-empty"><p>暂无数据</p></div></div>
          </div>
        </div>
      </section>

      <!-- ===== Usage Logs 详细日志 ===== -->
      <section id="usage-logs" class="workspace-section" aria-labelledby="usage-logs-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="usage-logs-title">详细日志</h2><p>查询 Analytics Engine 事件明细，支持按时间/模型/渠道/结果筛选。</p></div>
          <div class="admin-heading__actions">
            <button class="btn btn-gh btn-xs" onclick="resetLogFilters()"><i class="fas fa-undo-alt" aria-hidden="true"></i>重置</button>
            <button class="btn btn-gh btn-xs" onclick="loadUsageLogs(true)"><i class="fas fa-search" aria-hidden="true"></i>查询</button>
          </div>
        </div>
        <div class="analytics-log-filters">
          <div class="fg log-time-range"><label>时间范围</label><div class="fc"><input type="datetime-local" id="log-start" aria-label="开始时间"><span style="margin:0 4px;color:var(--color-muted)">至</span><input type="datetime-local" id="log-end" aria-label="结束时间"></div></div>
          <div class="fg"><label>筛选维度</label><select id="log-dimension" class="select-sm"><option value="model">模型</option><option value="channel">渠道</option><option value="result">结果</option></select></div>
          <div class="fg"><label>关键词</label><input type="text" id="log-keyword" placeholder="模型 ID / 渠道名称"></div>
          <div class="fg"><label>结果</label><select id="log-result" class="select-sm"><option value="all">全部</option><option value="success">成功</option><option value="failure">失败</option></select></div>
        </div>
        <div id="usage-log-error" class="al al-e hd" role="alert" aria-live="assertive"></div>
        <div class="usage-log-table-wrap">
          <table class="usage-log-table" id="usage-log-table">
            <thead><tr><th>时间</th><th>结果</th><th>模型</th><th>渠道</th><th>Token (入/出)</th><th>延迟</th><th>状态码</th><th>操作</th></tr></thead>
            <tbody id="usage-log-body"></tbody>
          </table>
          <div class="usage-log-cards" id="usage-log-cards"></div>
          <div id="usage-log-empty" class="empty-state"><i class="fas fa-clipboard-list" aria-hidden="true"></i><h3>暂无日志数据</h3><p>配置 Analytics Engine 并发送请求后，数据将自动采集并显示于此。</p></div>
        </div>
        <div class="analytics-log-pagination">
          <button class="btn btn-gh btn-xs" id="log-prev" onclick="changeLogPage(-1)" disabled><i class="fas fa-chevron-left"></i>上一页</button>
          <span class="mu" id="log-page-label">第 1 页</span>
          <button class="btn btn-gh btn-xs" id="log-next" onclick="changeLogPage(1)">下一页<i class="fas fa-chevron-right"></i></button>
          <label class="mu" style="font-size:12px;display:inline-flex;align-items:center;gap:4px">每页
            <select id="log-page-size" class="select-sm" onchange="changeUsageLogPageSize(this.value)" aria-label="每页条数"><option value="5" selected>5</option><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option></select>
            条</label>
        </div>
      </section>
      <section id="logs" class="workspace-section" aria-labelledby="logs-title">
        <div class="section-heading section-heading--admin"><div><h2 id="logs-title">系统日志</h2><p>记录 API 请求、错误等关键信息。超过保留天数的日志会自动删除。</p></div><div><label class="tg"><input type="checkbox" id="log-switch" onchange="toggleLog(this.checked)"><span class="sl"></span></label><span id="log-status">已关闭</span><label class="tg" style="margin-left:12px" title="M365 SSE 调试日志：记录 ChatHub 原始 / OpenAI delta / 最终聚合三层，排查换行与格式来源"><input type="checkbox" id="m365-sse-switch" onchange="toggleM365Debug(this.checked)"><span class="sl"></span></label><span id="m365-sse-status" style="font-size:12px;margin-left:4px">M365调试</span><label class="tg" style="margin-left:8px" title="定时自动刷新日志，便于排查问题"><input type="checkbox" id="log-auto-on" onchange="logAutoToggle(this.checked)"><span class="sl"></span></label><input type="number" id="log-auto-sec" min="1" max="3600" value="5" style="width:58px;text-align:center;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit;margin-left:6px" onchange="logAutoSecChange()"><span class="mu" style="font-size:12px;margin-left:4px">秒自动刷新</span><label class="mu" style="font-size:12px;margin-left:10px" title="日志保留天数，超过后自动删除">保留</label><input type="number" id="log-retention" min="1" max="365" value="7" style="width:50px;text-align:center;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit;margin-left:4px" onchange="logRetentionChange(this.value)"><span class="mu" style="font-size:12px;margin-left:4px">天</span><button class="btn btn-gh btn-xs" onclick="logPageChange(1)" style="margin-left:10px" title="刷新（回到第一页）"><i class="fas fa-sync-alt"></i></button><button class="btn btn-d btn-xs" onclick="clearLogs()" style="margin-left:4px">清除</button></div></div>
        <div class="syslog-filters">
          <div class="fg log-time-range"><label>时间范围</label><div class="fc"><input type="datetime-local" id="syslog-start" aria-label="开始时间"><span style="margin:0 4px;color:var(--color-muted)">至</span><input type="datetime-local" id="syslog-end" aria-label="结束时间"></div></div>
          <div class="fg"><label>类型</label><select id="syslog-type" aria-label="日志类型"><option value="">全部</option><option value="error">error</option><option value="warn">warn</option><option value="info">info</option><option value="request">request</option><option value="response">response</option></select></div>
          <div class="fg"><label>关键词</label><input type="search" id="syslog-keyword" placeholder="日志关键字" onkeydown="if(event.key==='Enter'){syslogSearch()}"></div>
          <div class="log-actions"><button class="btn btn-gh btn-xs" onclick="syslogReset()"><i class="fas fa-undo-alt" aria-hidden="true"></i>重置</button><button class="btn btn-p btn-xs" onclick="syslogSearch()"><i class="fas fa-search" aria-hidden="true"></i>搜索</button><button class="btn btn-d btn-xs" onclick="deleteExpiredLogs()" title="删除超过保留天数的日志（按上方保留天数自动计算，无需选择时间范围）"><i class="fas fa-trash-alt" aria-hidden="true"></i>删除过期日志</button></div>
        </div>
        <div id="log-list" class="key-list">
          <div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>开启日志开关后，API 请求和错误会被记录。</p></div>
        </div>
      </section>

      <!-- ===== MCP 聚合网关 ===== -->
      <section id="mcps" class="workspace-section" aria-labelledby="mcps-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="mcps-title">MCP 网关</h2><p>聚合多个 MCP Server 的工具，统一暴露 JSON-RPC 端点 <code>/v1/mcp</code>（需转发 Key 认证）。工具名自动加前缀 <code>{MCP名称}-</code> 隔离命名空间。</p></div>
          <div class="fc">
            <button class="btn btn-gh" onclick="mcpHealth()" title="逐个探测各 MCP 的可达性与工具数"><i class="fas fa-heartbeat" aria-hidden="true"></i>健康检查</button>
            <button class="btn btn-gh" onclick="mcpBatchImport()"><i class="fas fa-file-import" aria-hidden="true"></i>批量导入</button>
            <button class="btn btn-p" onclick="mcpFormModal()"><i class="fas fa-plus" aria-hidden="true"></i>添加 MCP</button>
          </div>
        </div>
        <div class="key-list">
          ${mcps.length===0?'<div class="empty-state"><i class="fas fa-boxes" aria-hidden="true"></i><h3>还没有 MCP Server</h3><p>添加 MCP Server 后，其 tools/list 工具会聚合到 <code>/v1/mcp</code>，支持 tools/call 路由。</p><button class="btn btn-p" onclick="mcpFormModal()">添加 MCP</button></div>':''}
          ${mcps.map(m=>`<article class="ki" data-id="${escapePageHtml(m.id)}">
            <div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-boxes"></i></span>
              <div><h3>${escapePageHtml(m.name)} <span class="bd ${m.enabled?'bd-on':'bd-off'}">${m.enabled?'已启用':'已禁用'}</span></h3>
              <p><code>${escapePageHtml(m.url)}</code>${Object.keys(m.httpHeaders||{}).length>0?' · '+Object.keys(m.httpHeaders).length+' 个请求头':''}</p></div>
            </div>
            <div class="key-actions">
              <label class="tg"><input type="checkbox" ${m.enabled?'checked':''} onchange="mcpToggle('${escapePageJsx(m.id)}',this.checked)" aria-label="启用 ${escapePageHtml(m.name)}"><span class="sl"></span></label>
              <button class="btn btn-gh btn-xs" onclick="mcpEdit('${escapePageJsx(m.id)}')" title="编辑"><i class="fas fa-edit" aria-hidden="true"></i>编辑</button>
              <button class="btn btn-d btn-xs" onclick="mcpDel('${escapePageJsx(m.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button>
            </div>
          </article>`).join('')}
        </div>
      </section>

      <!-- ===== 联合模型（uni-model） ===== -->
      <section id="unimodels" class="workspace-section" aria-labelledby="unimodels-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="unimodels-title">联合模型</h2><p>一个逻辑模型名映射一组 <code>providerId/modelId</code> 候选，调用时按顺序 failover。调用模型 ID：<code>unimodel/名称</code>。</p></div>
          <button class="btn btn-p" onclick="unimodelFormModal()"><i class="fas fa-plus" aria-hidden="true"></i>添加联合模型</button>
        </div>
        <div class="key-list">
          ${unimodels.length===0?'<div class="empty-state"><i class="fas fa-layer-group" aria-hidden="true"></i><h3>还没有联合模型</h3><p>把多个提供商的等价模型聚成一个逻辑模型，如 <code>unimodel/free-flash</code>。</p><button class="btn btn-p" onclick="unimodelFormModal()">添加联合模型</button></div>':''}
          ${unimodels.map(u=>`<article class="ki" data-id="${escapePageHtml(u.id)}">
            <div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-layer-group"></i></span>
              <div><h3>unimodel/${escapePageHtml(u.name)} <span class="bd ${u.enabled?'bd-on':'bd-off'}">${u.enabled?'已启用':'已禁用'}</span></h3>
              <p>${(u.models||[]).map(ref=>`<code>${escapePageHtml(ref)}</code>`).join(' → ')}</p></div>
            </div>
            <div class="key-actions">
              <label class="tg"><input type="checkbox" ${u.enabled?'checked':''} onchange="unimodelToggle('${escapePageJsx(u.id)}',this.checked)" aria-label="启用 unimodel/${escapePageHtml(u.name)}"><span class="sl"></span></label>
              <button class="btn btn-gh btn-xs" onclick="unimodelEdit('${escapePageJsx(u.id)}')" title="编辑"><i class="fas fa-edit" aria-hidden="true"></i>编辑</button>
              <button class="btn btn-d btn-xs" onclick="unimodelDel('${escapePageJsx(u.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button>
            </div>
          </article>`).join('')}
        </div>
      </section>
      <!-- ===== 思维引导提示词设置 ===== -->
      <section id="thinking" class="workspace-section" aria-labelledby="thinking-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="thinking-title">思维引导提示词</h2><p>被勾选「思维引导注入」的模型，在转发前会在 messages 头部注入这段 system 提示词。存储于 KV，保存后最多 10s 生效。</p></div>
          <div><span class="mu" id="thinking-state" style="font-size:12px"></span></div>
        </div>
        <div class="form-group">
          <label class="fg">
            <span>提示词内容（留空 / 点「恢复默认」= 使用内置默认）</span>
            <textarea id="thinking-prompt" rows="12" class="fx1" style="white-space:pre-wrap;font-family:monospace;font-size:12px" placeholder="loading…"></textarea>
          </label>
        </div>
        <div class="fc mt-1 field-row">
          <button class="btn btn-p btn-xs" onclick="saveThinkingPrompt()"><i class="fas fa-save" aria-hidden="true"></i>保存</button>
          <button class="btn btn-gh btn-xs" onclick="resetThinkingPrompt()"><i class="fas fa-undo" aria-hidden="true"></i>恢复默认</button>
          <span class="form-helper">提示词首行会被加上网关注入标记以做幂等，请勿手动移除或复制该标记行。</span>
        </div>
        <div id="thinking-result" class="mt-1" aria-live="polite"></div>
      </section>

      <!-- ===== 内存缓存管理（P4） ===== -->
      <section id="cache" class="workspace-section" aria-labelledby="cache-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="cache-title">内存缓存</h2><p>热路径 KV 读的 10s 内存缓存（当前 isolate 实例）。外部直接改 KV 后，可在此手动清空让网关立即重读；也可点「清空全部」。</p></div>
          <div><button class="btn btn-gh btn-xs" onclick="loadCache()" style="margin-left:8px"><i class="fas fa-sync-alt"></i></button><button class="btn btn-d btn-xs" onclick="cacheClear()"><i class="fas fa-trash" aria-hidden="true"></i>清空全部</button></div>
        </div>
        <div id="cache-list" class="key-list">
          <div class="empty-state"><i class="fas fa-memory" aria-hidden="true"></i><h3>加载中…</h3></div>
        </div>
      </section>

      <section id="cache-prefix" class="workspace-section" aria-labelledby="cache-prefix-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="cache-prefix-title">缓存前缀</h2><p>被勾选「缓存前缀注入」的模型，在转发前会在 messages 头部注入这段固定 system 提示词。首行标记 + 固定内容让请求拥有稳定前缀，可提升上游前缀缓存命中率、降低 token 成本。存储于 KV，保存后最多 10s 生效。</p></div>
          <div><span class="mu" id="cache-prefix-state" style="font-size:12px"></span></div>
        </div>
        <div class="form-group">
          <label class="fg">
            <span>前缀内容（留空 / 点「恢复默认」= 使用内置默认）</span>
            <textarea id="cache-prefix-text" rows="10" class="fx1" style="white-space:pre-wrap;font-family:monospace;font-size:12px" placeholder="loading…"></textarea>
          </label>
        </div>
        <div class="fc mt-1 field-row">
          <button class="btn btn-p btn-xs" onclick="saveCachePrefix()"><i class="fas fa-save" aria-hidden="true"></i>保存</button>
          <button class="btn btn-gh btn-xs" onclick="resetCachePrefix()"><i class="fas fa-undo" aria-hidden="true"></i>恢复默认</button>
          <span class="form-helper">前缀首行会被加上网关注入标记以做幂等，请勿手动移除或复制该标记行。注意：前缀会注入到每次请求，编辑后所有上游缓存将失效重新建立。</span>
        </div>
        <div id="cache-prefix-result" class="mt-1" aria-live="polite"></div>
      </section>

      <section id="perf" class="workspace-section" aria-labelledby="perf-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="perf-title">性能设置</h2><p>通用转发（OpenAI / OAuth / Anthropic / Responses）的上游超时分级阈值。流式请求不再被整体超时掐断，改为「连接/首字节超时 + 无数据 idle 兜底 + 心跳」三级控制。保存后最多 10s 生效。</p></div>
          <div><span class="mu" id="perf-state" style="font-size:12px"></span></div>
        </div>
        <div class="form-grid">
          <label class="fg">
            <span>非流式整体超时（ms，默认 300000）</span>
            <input type="number" id="perf-total" min="5000" max="3600000" step="1000" class="fx1">
          </label>
          <label class="fg">
            <span>流式连接/首字节超时（ms，默认 90000）</span>
            <input type="number" id="perf-connect" min="1000" max="300000" step="1000" class="fx1">
          </label>
          <label class="fg">
            <span>流式无数据 idle 超时（ms，默认 240000）</span>
            <input type="number" id="perf-idle" min="1000" max="600000" step="1000" class="fx1">
          </label>
          <label class="fg">
            <span>SSE 心跳间隔（ms，默认 15000；0 = 不注入心跳）</span>
            <input type="number" id="perf-keepalive" min="0" max="120000" step="1000" class="fx1">
          </label>
        </div>
        <div class="fc mt-1 field-row">
          <button class="btn btn-p btn-xs" onclick="savePerfSettings()"><i class="fas fa-save" aria-hidden="true"></i>保存</button>
          <button class="btn btn-gh btn-xs" onclick="resetPerfSettings()"><i class="fas fa-undo" aria-hidden="true"></i>恢复默认</button>
          <span class="form-helper">调低连接超时可更快失败切换；长思考/agent 场景请保持 idle 超时较大；心跳 0 时不注入，避免干扰私有 SSE 解析器。</span>
        </div>
        <div id="perf-result" class="mt-1" aria-live="polite"></div>
      </section>
    </main>

    ${renderSiteFooter(SITE_CONFIG.title)}
  </div>
</div>

<div id="modal" class="modal-o hd" role="presentation" onclick="if(event.target===this)closeM()"><div class="modal" id="mc" role="dialog" aria-modal="true" aria-live="polite"></div></div>

<script>
// UX8：预设表单一数据源——注入文件顶部 PROVIDER_PRESETS / OAUTH_PRESETS，供 applyProviderPreset 等使用
const PROVIDER_PRESETS = ${serializeForScript(PROVIDER_PRESETS)};
const OAUTH_PRESETS = ${serializeForScript(OAUTH_PRESETS)};
${SHARED_JS}${ANALYTICS_JS}
// 全部已启用模型引用（providerId/modelId），供 Vision Bridge 识图模型勾选
const VB_MODELS = ${serializeForScript(allModelRefs)};
// 各提供商已保存的识图配置快照（懒渲染未展开时，保存表单可据此保留原配置）
const VB_ORIGINAL = ${serializeForScript(Object.fromEntries(providers.map(p => [p.id, { primary: (p.visionBridge&&p.visionBridge.primary)||'', vision: (p.visionBridge&&p.visionBridge.vision)||[], onVisionFailure: (p.visionBridge&&p.visionBridge.onVisionFailure)||'error' }])))};
// P6：识图模型引用列表懒渲染——展开「识图模型配置」时才从 VB_MODELS 生成控件，
// 避免 SSR 为每个提供商重放全库模型引用（O(N×M) 页面膨胀）。
function vbFill(container) {
  if (!container || container.getAttribute('data-vb-built')) return
  var isRadio = container.hasAttribute('data-vb-radio')
  var name = container.getAttribute('data-name') || ''
  var checkedVal = container.getAttribute('data-checked') || ''
  var checkedArr = []
  try { checkedArr = JSON.parse(checkedVal || '[]') } catch (e) { checkedArr = [] }
  var refs = VB_MODELS || []
  var h = ''
  if (isRadio) {
    h = '<label class="model-check"><input type="radio" name="' + escapeHtml(name) + '" value=""' + (!checkedVal ? ' checked' : '') + '><span>本提供商自身模型（共享识图，推荐）</span></label>'
    refs.forEach(function (r) {
      var s = escapeHtml(r)
      h += '<label class="model-check"><input type="radio" name="' + escapeHtml(name) + '" value="' + s + '"' + (checkedVal === r ? ' checked' : '') + '><span>' + s + '</span></label>'
    })
  } else if (refs.length === 0) {
    h = '<p class="form-helper">暂无已启用的模型，请先添加并启用模型。</p>'
  } else {
    h = '<div class="model-check-list">'
    refs.forEach(function (r) {
      var s = escapeHtml(r)
      h += '<label class="model-check vb-item"><span class="vb-order" title="识图链顺序">-</span><input type="checkbox" value="' + s + '"' + (checkedArr.indexOf(r) !== -1 ? ' checked' : '') + '><span>' + s + '</span></label>'
    })
    h += '</div><p class="form-helper">按勾选顺序转写（序号 1 优先），全部失败才尝试下一个。</p>'
  }
  container.innerHTML = h
  container.setAttribute('data-vb-built', '1')
}
function vbFillScope(root) {
  ;(root || document).querySelectorAll('[data-vb-radio],[data-vb-check]').forEach(function (c) { vbFill(c) })
  renumberVisionOrders()
}
// copy
function copyText(t, el) {
  const i = el.tagName === 'I' ? el : (el.querySelector('i') || el.parentElement?.querySelector('i'))
  if (!i) { navigator.clipboard.writeText(t).catch(() => {}); return }
  const oc = i.className
  navigator.clipboard.writeText(t).then(() => {
    i.className = 'fas fa-check'
    el.setAttribute('data-state', 'success')
    setTimeout(() => {
      i.className = oc
      el.removeAttribute('data-state')
    }, 1800)
  }).catch(() => {
    el.setAttribute('data-state', 'error')
  })
}

// modal
let modalLastFocus = null
function showM(h) {
  document.getElementById('mc').innerHTML = h
  const m = document.getElementById('modal')
  m.classList.remove('hd')
  // UX5：记录触发元素，关闭后归还焦点；打开时聚焦弹窗内首个可交互控件
  modalLastFocus = document.activeElement
  const f = m.querySelector('[autofocus], button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
  if (f) f.focus()
}
function closeM() {
  const m = document.getElementById('modal')
  if (m.classList.contains('hd')) return
  m.classList.add('hd')
  if (modalLastFocus && modalLastFocus.focus) { try { modalLastFocus.focus() } catch (e) { /* 忽略 */ } }
  modalLastFocus = null
}
// UX5：ESC 关闭 + Tab 焦点圈在弹窗内
document.addEventListener('keydown', function (e) {
  const m = document.getElementById('modal')
  if (!m || m.classList.contains('hd')) return
  if (e.key === 'Escape') {
    // 优先触发「取消」按钮，让确认/输入的 Promise 正常 resolve，避免 await 悬挂
    const cancel = m.querySelector('.btn-s, [data-cancel]')
    if (cancel) cancel.click()
    else closeM()
    return
  }
  if (e.key === 'Tab') {
    const focusables = Array.from(m.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
    if (focusables.length === 0) return
    const first = focusables[0], last = focusables[focusables.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === m)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
})
function cM(msg) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-question-circle c-p"></i> 确认</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-s" onclick="closeM();r(false)">取消</button><button class="btn btn-p" onclick="closeM();r(true)">确定</button></div>')
    window.r = r
  })
}
function pM(msg, def) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-pen c-p"></i> ' + msg + '</h3><div class="fg"><input type="text" id="pv" value="' + escapeHtml(def || '') + '" placeholder="请输入"></div><div class="fa"><button class="btn btn-s" id="pMc">取消</button><button class="btn btn-p" id="pMo">确定</button></div>')
    window.r = r
    const inp = document.getElementById('pv')
    if (inp) {
      inp.focus()
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { closeM(); r(inp.value.trim()) }
      })
    }
    document.getElementById('pMc').addEventListener('click', function() { closeM(); r(null) })
    document.getElementById('pMo').addEventListener('click', function() { closeM(); r(inp.value.trim()) })
  })
}
function aM(msg, t) {
  const i = t === 'success' ? 'fa-check-circle c-s' : 'fa-exclamation-circle c-d'
  showM('<h3><i class="fas ' + i + '"></i> ' + (t === 'success' ? '成功' : '提示') + '</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-p" onclick="closeM()">确定</button></div>')
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  const i = t === 'success' ? 'fa-check-circle' : 'fa-times-circle'
  const cls = t === 'success' ? 'al-s' : 'al-e'
  el.innerHTML = '<div class="al ' + cls + '"><i class="fas ' + i + '"></i> ' + escapeHtml(msg) + '</div>'
  el.classList.remove('hd')
  setTimeout(() => el.classList.add('hd'), 3000)
}

// providers
function tog(id) {
  const d = document.getElementById('dt-' + id), c = document.getElementById('ch-' + id)
  d.classList.toggle('open')
  c.style.transform = d.classList.contains('open') ? 'rotate(90deg)' : ''
  // TRAE SOLO：展开时自动刷新账号池状态
  if (d.classList.contains('open') && document.getElementById('trae-acc-' + id)) traeStatus(id)
  // P3：M365 提供商展开时自动加载账号池（账号池已内嵌提供商卡）
  if (d.classList.contains('open') && document.getElementById('m365-acc-' + id)) m365Render(id)
  // Qoder：展开时自动加载账号池状态
  if (d.classList.contains('open') && document.getElementById('qdp-acc-' + id)) qoderPoolStatus(id)
  // WorkBuddy：展开时自动加载账号池状态
  if (d.classList.contains('open') && document.getElementById('wbp-acc-' + id)) oauthPoolStatus(id)
  // DeepSeek App：展开时自动加载 token 池
  if (d.classList.contains('open') && document.getElementById('ds-list-' + id)) deepseekTokenList(id)
  // Cline：展开时**先读一次只读留档**（不打上游），让"额度耗尽被冷却"一眼可见；
  // 保存/一键授权后标记过「待检测」的账号再多跑一次真实检测（那时需要拿新 token 关联账号）。
  if (d.classList.contains('open')) clineOnCardOpen(id)
}

// P3：M365 账号池渲染 —— 独立页并入提供商详情后按 providerId 定位容器
function m365Esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function m365Render(providerId) {
  var root = document.getElementById('m365-acc-' + providerId)
  if (!root) return
  root.innerHTML = '<p class="mu">加载中…</p>'
  fetch('/admin/api/m365/accounts/' + encodeURIComponent(providerId))
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j.success) { root.innerHTML = '<p class="c-d">加载失败：' + m365Esc(((res.j && res.j.message) || (res.j && res.j.error) || '未知错误')) + '</p>'; return; }
      var accs = (res.j.data && res.j.data.accounts) || []
      var sum = (res.j.data && res.j.data.summary) || {}
      if (accs.length === 0) { root.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><h3>暂无账号</h3><p>点上方「连接新账号」，用授权码或账密登录，第一个账号即进入此池。</p></div>'; return; }
      // 顶部聚合状态条（对齐 M365-Gateway 账号池概览）
      var summaryHtml = '<div class="fc mb-2" style="flex-wrap:wrap;gap:8px;font-size:12px;justify-content:space-between;align-items:center">' +
        '<div class="fc" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<span class="mu">共 <b>' + (sum.total || accs.length) + '</b> 个</span>' +
        '<span class="bd bd-on">使用中 ' + (sum.inUse || 0) + '</span>' +
        '<span class="bd bd-off">空闲 ' + (sum.idle || 0) + '</span>' +
        '<span class="bd bd-off">休眠 ' + (sum.dormant || 0) + '</span>' +
        (sum.cooling ? '<span class="bd bd-warn">冷却 ' + sum.cooling + '</span>' : '') +
        (sum.authFailed ? '<span class="bd bd-danger">失效 ' + sum.authFailed + '</span>' : '') +
        (sum.unhealthy ? '<span class="bd bd-danger">异常 ' + sum.unhealthy + '</span>' : '') +
        '<span class="mu">每账号并发上限 ' + (sum.concurrencyLimit != null ? sum.concurrencyLimit : 1) + '</span>' +
        '</div>' +
        '<div><button class="btn btn-s btn-xs" onclick="m365RefreshAccounts(\\'' + m365Esc(providerId) + '\\',this)" title="向微软请求刷新全部账号令牌并探活"><i class="fas fa-sync-alt"></i>检测/刷新全部账号</button></div>' +
        '</div>'
      root.innerHTML = summaryHtml + '<table class="tbl"><thead><tr><th>账号</th><th>OID</th><th>状态</th><th>令牌有效期</th><th>最近使用</th><th>操作</th></tr></thead><tbody>' +
        accs.map(function (a) {
          // 状态徽章：使用中 > 未连接 > 授权失效 > 已隔离 > 冷却中 > 休眠 > 空闲
          var st = a.state || (a.healthy ? 'idle' : 'cooldown')
          var badge
          if (st === 'in_use') badge = '<span class="bd bd-on">使用中</span>'
          else if (st === 'idle') badge = '<span class="bd bd-on">空闲</span>'
          else if (st === 'dormant') badge = '<span class="bd bd-off">休眠待命</span>'
          else if (st === 'cooldown') badge = '<span class="bd bd-warn">冷却中</span>'
          else if (st === 'auth_failed') badge = '<span class="bd bd-danger">授权已失效</span>'
          else if (st === 'isolated') badge = '<span class="bd bd-danger">已隔离</span>'
          else if (st === 'disconnected') badge = '<span class="bd bd-off">未连接</span>'
          else badge = '<span class="bd bd-off">' + m365Esc(String(st)) + '</span>'
          // 冷却/隔离剩余时间提示
          var detail = ''
          if (a.cooldownUntil) detail = ' 冷却至 ' + new Date(a.cooldownUntil).toLocaleString()
          else if (a.trippedUntil) detail = ' 熔断至 ' + new Date(a.trippedUntil).toLocaleString()
          else if (a.imageLimitedUntil) detail = ' 图片额度恢复 ' + new Date(a.imageLimitedUntil).toLocaleString()
          var authErrDetail = (st === 'auth_failed' && a.authError) ? '<span class="c-d" style="display:block;font-size:11px;margin-top:2px;max-width:260px;word-break:break-all" title="' + m365Esc(a.authError) + '">' + m365Esc(a.authError.length > 60 ? a.authError.slice(0, 60) + '…' : a.authError) + '</span>' : ''
          var stCell = badge + (detail ? '<span class="mu">' + m365Esc(detail) + '</span>' : '') + authErrDetail
          // 令牌有效期 + 自动续期说明
          var exp = '—'
          if (a.tokenExpiresAt) {
            exp = new Date(a.tokenExpiresAt).toLocaleString()
            if (a.tokenExpiresAt <= Date.now()) {
              if (st === 'auth_failed') {
                exp += ' <span class="bd bd-danger">已失效·需重新授权</span>'
              } else if (a.hasRefreshToken) {
                exp += ' <span class="bd bd-warn">已过期·可自动续期</span>'
              } else {
                exp += ' <span class="bd bd-danger">已过期</span>'
              }
            }
            else exp += ' <span class="mu">· 自动续期</span>'
          }
          var last = a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : '<span class="mu">从未使用</span>'
          return '<tr><td>' + m365Esc(a.email || a.oid || '?') + '</td><td><code>' + m365Esc(a.oid || '') + '</code></td><td>' + stCell + '</td><td>' + exp + '</td><td>' + last + '</td>' +
            '<td>' +
            (a.state === 'cooldown' ? '<button class="btn btn-gh btn-xs" onclick="m365ClearCooldown(\\'' + m365Esc(providerId) + '\\',\\'' + m365Esc(a.oid || '') + '\\',this)" title="清除该账号冷却"><i class="fas fa-fire-extinguisher"></i>清除冷却</button> ' : '') +
            '<button class="btn btn-gh btn-xs" onclick="m365RefreshAccounts(\\'' + m365Esc(providerId) + '\\',this,\\'' + m365Esc(a.oid || '') + '\\')" title="向微软刷新此账号令牌"><i class="fas fa-sync-alt"></i>刷新</button> ' +
            '<button class="btn btn-d btn-xs" onclick="m365Remove(\\'' + m365Esc(providerId) + '\\',\\'' + m365Esc(a.oid || '') + '\\',this)"><i class="fas fa-trash"></i>移除</button></td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="mu" style="margin-top:8px">状态说明：使用中=当前有请求在途；空闲=健康可立即接单；休眠=超过 24h 未使用（唤醒时自动续期）；冷却=被上游限流/熔断，到期自动恢复；授权已失效=上游拒绝刷新凭据，需重新授权。令牌「已过期·可自动续期」表示仅 access_token 临期但 refresh_token 仍在，后台 Cron 会定期主动保活；若刷新失败则会标红提示「已失效·需重新授权」。</p>';
    })
    .catch(function (e) { root.innerHTML = '<p class="c-d">请求异常：' + m365Esc(String(e && e.message || e)) + '</p>'; });
}
function m365RefreshAccounts(providerId, btn, oid) {
  if (btn) btn.disabled = true;
  var origHtml = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>检测中…';
  var url = '/admin/api/m365/accounts/' + encodeURIComponent(providerId) + '/refresh' + (oid ? '?oid=' + encodeURIComponent(oid) : '');
  fetch(url, { method: 'POST' })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      if (res.ok && res.j && res.j.data) {
        var d = res.j.data;
        var msg = '检测/刷新完成：' + (d.refreshed || 0) + ' 个正常，' + (d.failed || 0) + ' 个失效';
        if (d.failed > 0 && d.results) {
          var failItems = d.results.filter(function (x) { return !x.success; });
          if (failItems.length > 0 && failItems[0].error) {
            msg += '\\n\\n失败原因示例：' + failItems[0].error;
          }
        }
        window.alert(msg);
        m365Render(providerId);
      } else {
        window.alert((res.j && res.j.error && res.j.error.message) || (res.j && res.j.message) || '刷新请求失败');
        m365Render(providerId);
      }
    })
    .catch(function (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      window.alert('请求异常: ' + String(e && e.message || e));
    });
}
function m365ClearCooldown(providerId, oid, btn) {
  if (btn) btn.disabled = true;
  fetch('/admin/api/m365/cooldown/' + encodeURIComponent(providerId) + (oid ? '?oid=' + encodeURIComponent(oid) : ''), { method: 'POST' })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { if (btn) btn.disabled = false; if (res.ok) m365Render(providerId); else window.alert((res.j && res.j.message) || '清除失败'); })
    .catch(function () { if (btn) btn.disabled = false; window.alert('请求异常'); });
}
function m365Remove(providerId, oid, btn) {
  if (!oid) return;
  if (!window.confirm('确认移除账号 ' + oid + '？')) return;
  if (btn) btn.disabled = true;
  fetch('/admin/api/m365/accounts/' + encodeURIComponent(providerId) + '?oid=' + encodeURIComponent(oid), { method: 'DELETE' })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { if (btn) btn.disabled = false; if (res.ok) m365Render(providerId); else window.alert((res.j && res.j.message) || '移除失败'); })
    .catch(function () { if (btn) btn.disabled = false; window.alert('请求异常'); });
}

function m365ConversationsModal(providerId) {
  showM('<h3><i class="fas fa-comments c-p"></i> M365 云端会话管理</h3>' +
    '<div id="m365-conv-body"><p class="mu">加载中…</p></div>' +
    '<div class="fa"><button class="btn btn-s" onclick="closeM()">关闭</button></div>');
  fetch('/admin/api/m365/conversations?provider_id=' + encodeURIComponent(providerId))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var body = document.getElementById('m365-conv-body');
      if (!body) return;
      if (!d.success) {
        body.innerHTML = '<p class="c-d">加载失败：' + m365Esc((d.error && d.error.message) || '未知错误') + '</p>';
        return;
      }
      var list = d.data || [];
      var cfg = d.config || {};
      var html = '<div class="fc mb-2 field-row" style="gap:8px;flex-wrap:wrap">' +
        '<span class="mu" style="font-size:13px">清理策略：</span>' +
        '<select id="m365-cl-mode" class="select-sm">' +
        '<option value="after_response"' + (cfg.mode === 'after_response' ? ' selected' : '') + '>每次响应后自动清理</option>' +
        '<option value="keep_n"' + (cfg.mode === 'keep_n' ? ' selected' : '') + '>保留最新 N 个</option>' +
        '<option value="max_age"' + (cfg.mode === 'max_age' ? ' selected' : '') + '>按最大存活时间</option>' +
        '<option value="on_exit"' + (cfg.mode === 'on_exit' ? ' selected' : '') + '>手动/退出清理</option>' +
        '</select>' +
        '<input type="number" id="m365-cl-keep" value="' + (cfg.keep_n || 5) + '" style="width:60px" placeholder="保留N个">' +
        '<input type="number" id="m365-cl-age" value="' + (cfg.max_age_hours || 24) + '" style="width:60px" placeholder="小时">' +
        '<button class="btn btn-s btn-xs" onclick="m365SaveCleanupConfig(\\'' + m365Esc(providerId) + '\\')">保存策略</button>' +
        '<button class="btn btn-d btn-xs" onclick="m365TriggerCleanup(\\'' + m365Esc(providerId) + '\\')"><i class="fas fa-broom"></i>立即清理</button>' +
        '</div>';
      if (list.length === 0) {
        html += '<p class="mu">当前无活跃云端会话记录。</p>';
      } else {
        html += '<table class="tbl" style="font-size:12px"><thead><tr><th>会话 ID</th><th>账号 OID</th><th>更新时间</th><th>操作</th></tr></thead><tbody>' +
          list.map(function (c) {
            var dateStr = c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '-';
            return '<tr><td><code>' + m365Esc(c.id) + '</code></td><td><code>' + m365Esc(c.account_id || '-') + '</code></td><td>' + dateStr + '</td>' +
              '<td><button class="btn btn-gh btn-xs" onclick="m365ToggleWhitelist(\\'' + m365Esc(providerId) + '\\',\\'' + m365Esc(c.id) + '\\',false)"><i class="fas fa-shield-alt"></i>白名单</button></td></tr>';
          }).join('') + '</tbody></table>';
      }
      body.innerHTML = html;
    })
    .catch(function (e) {
      var body = document.getElementById('m365-conv-body');
      if (body) body.innerHTML = '<p class="c-d">请求失败：' + m365Esc(e && e.message || String(e)) + '</p>';
    });
}
function m365SaveCleanupConfig(providerId) {
  var mode = (document.getElementById('m365-cl-mode') || {}).value;
  var keepN = parseInt((document.getElementById('m365-cl-keep') || {}).value, 10);
  var maxAge = parseInt((document.getElementById('m365-cl-age') || {}).value, 10);
  fetch('/admin/api/m365/conversations/config?provider_id=' + encodeURIComponent(providerId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: mode, keep_n: isNaN(keepN) ? 5 : keepN, max_age_hours: isNaN(maxAge) ? 24 : maxAge })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.success) toast('清理配置已更新', 'success');
    else toast((d.error && d.error.message) || '更新失败', 'error');
  }).catch(function () { toast('请求异常', 'error'); });
}
function m365TriggerCleanup(providerId) {
  if (!window.confirm('确认立即执行云端会话清理？')) return;
  fetch('/admin/api/m365/conversations/cleanup?provider_id=' + encodeURIComponent(providerId), {
    method: 'POST'
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.success) {
      toast('清理完成，共删除 ' + (d.deleted || 0) + ' 个会话', 'success');
      m365ConversationsModal(providerId);
    } else {
      toast((d.error && d.error.message) || '清理失败', 'error');
    }
  }).catch(function () { toast('请求异常', 'error'); });
}
function m365ToggleWhitelist(providerId, convId, remove) {
  fetch('/admin/api/m365/conversations/whitelist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_id: providerId, conversation_id: convId, action: remove ? 'remove' : 'add' })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.success) {
      toast(remove ? '已移出白名单' : '已加入白名单（受保护不被自动清理）', 'success');
    } else {
      toast((d.error && d.error.message) || '操作失败', 'error');
    }
  }).catch(function () { toast('请求异常', 'error'); });
}

// UX2：保存/删除等操作后 location.reload() 会把页面打回顶部、收起所有面板。
// reload 前捕获滚动位置与展开状态，刷新后恢复，避免「操作一次就找不到刚才的位置」。
function reloadAdmin() {
  markSaved()  // UX8：保存成功即将刷新，清除未保存标记
  try {
    // 关闭浏览器原生「按历史恢复滚动」，避免它和我们的恢复互相打架（尤其面板收起导致
    // 页面高度变化时，原生恢复会被 clamp 到错误位置，表现为「刷新后不在原位置」）。
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    const open = []
    document.querySelectorAll('.pd.open').forEach(function (d) { if (d.id) open.push(d.id) })
    const af = document.getElementById('af')
    // 额外记住当前展开/收起表单时的滚动基线，供下方恢复时判断页面是否已被外界改动
    uiScroll = window.scrollY
    localStorage.setItem('ui_state', JSON.stringify({ y: window.scrollY, open: open, add: !!(af && !af.classList.contains('hd')) }))
  } catch (e) { /* 忽略存储失败 */ }
  location.reload()
}
// 保存本次 reload 想要恢复到的那一版滚动位置（供 load 事件二次矫正用）
let uiScroll = 0
// 真正执行滚动复位（幂等，可多次调用）：只有文档高度足够时才生效，否则等下一次回调
function applyUiScroll() {
  try {
    const y = uiScroll || 0
    const max = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    if (y > 0 && y <= max) window.scrollTo(0, y)
  } catch (e) { /* 忽略 */ }
}
function restoreAdminState() {
  try {
    const s = JSON.parse(localStorage.getItem('ui_state') || 'null')
    if (s) {
      (s.open || []).forEach(function (panelId) {
        const d = document.getElementById(panelId)
        const c = document.getElementById('ch-' + String(panelId).replace(/^dt-/, ''))
        if (d && d.classList && !d.classList.contains('open')) { d.classList.add('open'); if (c) c.style.transform = 'rotate(90deg)' }
        // P3：恢复展开态时同步加载内嵌账号池（TRAE / M365 / Qoder / WorkBuddy），与手动 tog 行为一致
        const pid = String(panelId).replace(/^dt-/, '')
        if (document.getElementById('m365-acc-' + pid)) m365Render(pid)
        if (document.getElementById('trae-acc-' + pid)) traeStatus(pid)
        if (document.getElementById('qdp-acc-' + pid)) qoderPoolStatus(pid)
        if (document.getElementById('wbp-acc-' + pid)) oauthPoolStatus(pid)
        // Cline：恢复展开态同样要读冷却/额度留档——否则「刷新后面板本来就是开的」这条最常见路径
        // 什么都不加载，用户看不到任何状态（2026-10-02 实测报障）。与手动 tog 共用同一入口。
        clineOnCardOpen(pid)
      })
      if (s.add) { const af = document.getElementById('af'); if (af) af.classList.remove('hd') }
      if (typeof s.y === 'number') uiScroll = s.y
    }
  } catch (e) { /* 忽略损坏的状态 */ }
  // 首次：等一帧（重开面板后高度同步变化），load 事件时再矫正一次（图片/字体加载完）
  // 避免过早 scrollTo 被文档高度还没长全而 clamp 掉（这正是"刷新后不在原位置"的根因）。
  applyUiScroll()
  requestAnimationFrame(applyUiScroll)
  try { localStorage.removeItem('ui_state') } catch (e) { /* 忽略 */ }
}
// 图片/图标/懒加载内容落定后再矫正一次滚动，保证回到用户原来停的位置
window.addEventListener('load', function () { applyUiScroll() })

// UX3：表单提交中状态——防重复提交，按钮显示「处理中」
let adminSubmitting = false
function busyBtn(btn) {
  if (!btn || btn.disabled) return
  btn.disabled = true
  btn.dataset.prevHtml = btn.innerHTML
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中…'
}
function idleBtn(btn) {
  if (!btn) return
  if (btn.dataset.prevHtml !== undefined) { btn.innerHTML = btn.dataset.prevHtml; delete btn.dataset.prevHtml }
  btn.disabled = false
}

function showAdd() { document.getElementById('af').classList.remove('hd') }
function hideAdd() { document.getElementById('af').classList.add('hd'); document.getElementById('amc').classList.add('hd') }
function toggleVbCollapse(id, btn) {
  const fs = document.getElementById(id)
  if (!fs) return
  const isHidden = fs.classList.toggle('hd')
  btn.setAttribute('aria-expanded', !isHidden)
  const icon = btn.querySelector('.collapse-icon')
  if (icon) icon.style.transform = isHidden ? '' : 'rotate(90deg)'
  if (!isHidden) vbFillScope(fs)  // 展开时按需填充全库模型引用列表（P6）
}

// OAuth 高级配置折叠（与识图折叠同交互，但无 vbFillScope 副作用）
function toggleAdvOauth(id, btn) {
  const fs = document.getElementById(id)
  if (!fs) return
  const isHidden = fs.classList.toggle('hd')
  btn.setAttribute('aria-expanded', !isHidden)
  const icon = btn.querySelector('.collapse-icon')
  if (icon) icon.style.transform = isHidden ? '' : 'rotate(90deg)'
}

// 通用折叠/展开（权益包明细表格等纯展示区域，无懒渲染逻辑）
function toggleCollapse(id, btn) {
  const fs = document.getElementById(id)
  if (!fs) return
  const isHidden = fs.classList.toggle('hd')
  btn.setAttribute('aria-expanded', !isHidden)
  const icon = btn.querySelector('.collapse-icon')
  if (icon) icon.style.transform = isHidden ? '' : 'rotate(90deg)'
}

// aid 输入 opencode 时自动填充 API 地址
document.getElementById('aid').addEventListener('input', function() {
  if (this.value.trim() === 'opencode') {
    document.getElementById('aurl').value = '${OPENCODE_DEFAULT_URL}'
  }
  syncNewScopedFields()
})
// API 地址影响 CNB 判定（cnb.cool 域），变更后同步专属配置块显隐
document.getElementById('aurl').addEventListener('input', syncNewScopedFields)
// 新建表单首次渲染后按默认值同步一次（工具桥 / Gemini / Global 域默认隐藏）
syncNewScopedFields()

// provider api keys (add form)
function addAKeyRow() {
  const c = document.getElementById('akeys')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  // UX6：每行自带独立结果区（.trt），多 Key 并发测试互不覆盖
  d.innerHTML = '<input type="password" placeholder="sk-xxx" class="fx1 aki" aria-label="API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key" aria-label="显示或隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg"><input type="checkbox" checked class="ake" aria-label="启用该 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewAKey(this)" title="测试" aria-label="测试该 Key"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()" title="移除" aria-label="移除该 Key"><i class="fas fa-times c-l"></i></button><span class="trt" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
}

function renderModelGrid(models, editId, providerId) {
  if (providerId === 'opencode') {
    models = (models || []).filter(function(m) {
      return m && typeof m.id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(m.id) && (m.id === 'big-pickle' || m.id.endsWith('-free'))
    })
  }
  if (!models || models.length === 0) return '<span class="mu">未返回模型列表</span>'
  var h = models.map(function(m) {
    var modelId = String(m.id || '')
    var safeId = escapeHtml(modelId)
    var jsId = escapeJsAttr(modelId)
    var addFn = editId
      ? "addMdlToEdit('" + escapeJsAttr(editId) + "','" + jsId + "')"
      : "addMdlToForm('" + jsId + "')"
    return '<div class="mdl-item">' +
      '<i class="fas fa-cube"></i>' +
			'<span class="fx1 cp ov" onclick="copyText(\\'' + jsId + '\\',this)">' + safeId + '</span>' +
      '<button class="btn btn-gh btn-xs mdl-add-btn" onclick="' + addFn + '" title="添加到表单">+</button></div>'
  }).join('')
  return '<div class="grid-2-gap6">' + h + '</div>'
}

function testNewAKey(btn) {
  const inp = btn.parentElement.querySelector('.aki'), k = inp.value.trim()
  const providerId = document.getElementById('aid').value.trim()
  if (!k && providerId !== 'opencode') { toast('请输入 API Key', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
  if (!url) { toast('请先填写 API 地址', 'error'); return }
  const apiType = document.getElementById('afmt').value
  const tr = btn.parentElement.querySelector('.trt') || document.getElementById('atestR')
  showSpinner(tr)
  // 新建表单的测试按钮同样要模型列表来渲染模型网格
  testKeyConnection(url, apiType, k, providerId, 'fetchModels').then(function(result) {
    if (result.success) {
      document.getElementById('amcl').innerHTML = renderModelGrid(extractModels(result.data), null, providerId)
      document.getElementById('amc').classList.remove('hd')
    } else {
      document.getElementById('amc').classList.add('hd')
    }
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

let mdlCount = 1
function addMdlRow() {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用该模型"><span class="sl"></span></label><label class="tg" title="启用思维引导注入"><input type="checkbox" class="cti" aria-label="启用思维引导注入"><span class="sl"></span></label><label class="tg" title="启用缓存前缀注入"><input type="checkbox" class="ccp" aria-label="启用缓存前缀注入"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
  effDdEnsure(d)
}

function addMdlToForm(mid) {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用该模型"><span class="sl"></span></label><label class="tg" title="启用思维引导注入"><input type="checkbox" class="cti" aria-label="启用思维引导注入"><span class="sl"></span></label><label class="tg" title="启用缓存前缀注入"><input type="checkbox" class="ccp" aria-label="启用缓存前缀注入"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
  effDdEnsure(d)
}

function testNewMdl(btn) {
  const inp = btn.parentElement.querySelector('.ami'), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
    const akeys = document.querySelectorAll('#akeys .aki')
    const configuredKey = Array.from(akeys).map(function(inp) { return inp.value.trim() }).filter(Boolean)[0] || ''
    const apiType = document.getElementById('afmt').value
    const tr = btn.parentElement.querySelector('.trt') || document.getElementById('atestR')
    showSpinner(tr)
  const providerId = document.getElementById('aid').value.trim()
  const apiKey = configuredKey || (providerId === 'opencode' ? '' : 'dummy')
  testModelConnection(url, apiType, apiKey, mid, providerId).then(function(result) {
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

async function createProv(opts) {
  if (adminSubmitting) return
  const btns = Array.from(document.querySelectorAll('#af .btn-p'))
  const nm = document.getElementById('anm').value.trim(), id = document.getElementById('aid').value.trim()
  const url = document.getElementById('aurl').value.trim(), apiType = document.getElementById('afmt').value
  const authType = document.getElementById('aat').value
  const oauth = collectOauthNew()
  const aki = document.querySelectorAll('#akeys .aki')
  const keys = Array.from(aki).map((inp, i) => {
    const k = inp.value.trim()
    const en = inp.parentElement.querySelector('.ake')?.checked ?? true
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
  const ami = document.querySelectorAll('#amodels .ami')
  const models = Array.from(ami).map(inp => {
    const mid = inp.value.trim()
    const en = inp.parentElement.querySelector('.ame')?.checked ?? true
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
  // 思维引导注入：收集每个被勾选注入的模型 ID
  const thinkingInject = Array.from(ami).map(inp => {
    const mid = inp.value.trim()
    const inject = inp.parentElement.querySelector('.cti')?.checked === true
    return mid && inject ? mid : null
  }).filter(Boolean)
  // 缓存前缀注入：收集每个被勾选注入的模型 ID
  const cachePrefixInject = Array.from(ami).map(inp => {
    const mid = inp.value.trim()
    const inject = inp.parentElement.querySelector('.ccp')?.checked === true
    return mid && inject ? mid : null
  }).filter(Boolean)
  const enabled = document.getElementById('aen').checked
  const preset = PROVIDER_PRESETS[document.getElementById('apreset').value]
  const providerType = preset && preset.type
  const kukuThinkMode = providerType === 'kuku' ? numOrUndef((document.getElementById('akuku-think')||{}).value) : undefined
  if (!nm || !id || !url) { toast('请填写名称、ID 和 API 地址', 'error'); return }
  if (authType === 'oauth-device') {
    // 国际版必须带 Global 发起端点，否则保存后发起登录会静默走国内端点
    if (oauth.loginRealm === 'global' && !oauth.globalDeviceCodeUrl) {
      toast('登录域为国际版，请填写「Global 域发起端点」或点预置补全后再保存', 'error'); return
    }
    // gemini / m365（PKCE 授权码、ROPC 账密）由后端专用流程处理，端点与 Client ID 均有默认值，
    // 无需强制三端点；先保存，认证在「连接」里引导
    const specialFlow = oauth.flowType === 'gemini' || oauth.flowType === 'm365-pkce' || oauth.flowType === 'm365-ropc'
    if (!specialFlow) {
      const needsClientId = oauth.flowType !== 'browser'
      if (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl || (needsClientId && !oauth.clientId)) {
        toast('OAuth 模式下请填写完整的配置（三个端点' + (needsClientId ? ' + Client ID' : '') + '）', 'error'); return
      }
    }
  }
  // 识图模型：勾选了识图模型即保存配置；选了主文本模型才是独立桥（type=vision-bridge），
  // 仅勾识图模型（primary 留空）= 本提供商共享识图，保持普通提供商身份
  const vb = collectVisionBridgeNew()
  adminSubmitting = true
  btns.forEach(busyBtn)
  try {
    const r = await fetch('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, toolBridge: (document.getElementById('atb')||{}).checked === true, allowUnlistedModels: (document.getElementById('aum')||{}).checked === true, reasoningEffort: ((document.getElementById('re')||{}).value || undefined), thinkingInject, cachePrefixInject, type: providerType || (vb && vb.primary ? 'vision-bridge' : undefined), kukuThinkMode, visionBridge: vb, geminiBaseUrl: ((document.getElementById('agbu')||{}).value || '').trim() || undefined })
    })
    const d = await r.json()
    if (d.success) {
      if (opts && typeof opts.afterCreate === 'function') {
        markSaved()  // UX8：创建已保存，继续 OAuth 连接流程
        toast('已创建，继续下一步…', 'success')
        opts.afterCreate(id)
      } else {
        toast('已创建', 'success')
        hideAdd()  // 创建成功后收起添加表单，reloadAdmin 不再把 add:true 写进 ui_state，刷新后表单保持关闭
        reloadAdmin()
      }
    } else toast(d.message || '创建失败', 'error')
  } catch (e) { toast('创建失败', 'error') }
  finally {
    adminSubmitting = false
    btns.forEach(idleBtn)
  }
}

// 选「登录域=国际版」时，若 Global 三个端点为空则自动从 workbuddy 预置补全，
// 避免用户只看到国内「发起端点」没填 Global 端点，保存后静默回退国内地址。
function syncGlobalOauthNew() {
  const lr = document.getElementById('ao15')
  if (!lr || lr.value !== 'global') return
  const p = OAUTH_PRESETS['workbuddy']
  if (!p) return
  const f = function(id) { return document.getElementById(id) }
  const fill = function(id, val) { const el = f(id); if (el && !el.value) el.value = val || '' }
  fill('ao16', p._globalDeviceCodeUrl)
  fill('ao17', p._globalDeviceTokenUrl)
  fill('ao18', p._globalRefreshTokenUrl)
}
function syncGlobalOauthEdit(id) {
  const lr = document.getElementById('eao15-' + id)
  if (!lr || lr.value !== 'global') return
  const p = OAUTH_PRESETS['workbuddy']
  if (!p) return
  const fill = function(suffix, val) { const el = document.getElementById('eao' + suffix + '-' + id); if (el && !el.value) el.value = val || '' }
  fill('16', p._globalDeviceCodeUrl)
  fill('17', p._globalDeviceTokenUrl)
  fill('18', p._globalRefreshTokenUrl)
}

/**
 * 该模型行是否应显示「effort」下拉。
 * - 编辑表单（#ml-<id> 内）：由所在「模型」fieldset 的 data-effort 标记决定（仅 WorkBuddy/CodeBuddy）。
 * - 新建表单（#amodels 内）：按当前填写的提供商 ID / 登录流程动态判断（见 newFormUsesEffort）。
 */
function effortScopeEnabled(row) {
  if (!row) return false
  if (row.closest('#amodels')) return newFormUsesEffort()
  const fs = row.closest('[data-effort]')
  return !!(fs && fs.getAttribute('data-effort') === '1')
}

/** 新建表单当前是否属于会消费 effortPolicy 的 WorkBuddy/CodeBuddy 提供商 */
function newFormUsesEffort() {
  const aid = ((document.getElementById('aid') || {}).value || '').trim()
  if (aid.indexOf('workbuddy') === 0) return true
  const at = (document.getElementById('aat') || {}).value
  const flow = (document.getElementById('ao8') || {}).value
  return at === 'oauth-device' && flow === 'browser'
}

/** reasoning_effort 支持档位多选下拉：从 SSR 模板 #eff-dd-tpl 克隆进缺少下拉的模型行（新建/编辑共用） */
function effDdEnsure(row) {
  if (!row || row.querySelector('.eff-dd')) return
  if (!effortScopeEnabled(row)) return
  const tpl = document.getElementById('eff-dd-tpl')
  if (!tpl || !tpl.textContent) return
  const holder = document.createElement('div')
  holder.innerHTML = tpl.textContent
  const dd = holder.firstElementChild
  if (dd) row.insertBefore(dd, row.querySelector('button.btn-gh'))
}

/** 页面加载后给新建表单的首行（SSR 直出）注入 effort 下拉 */
function effDdInit() {
  Array.from(document.querySelectorAll('#amodels .field-row')).forEach(effDdEnsure)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', effDdInit)
else effDdInit()

/** 勾选变化后同步下拉摘要文本 */
function updateEffSummary(dd) {
  if (!dd) return
  const sel = Array.from(dd.querySelectorAll('.eff-cb:checked')).map(function (c) { return c.value })
  const sum = dd.querySelector('.eff-sum')
  if (sum) sum.textContent = sel.length ? sel.join(' + ') : 'effort 不启用'
}
document.addEventListener('change', function (e) {
  const t = e.target
  if (t && t.matches && t.matches('.eff-cb')) updateEffSummary(t.closest('.eff-dd'))
})
document.addEventListener('click', function (e) {
  // 点击下拉外部时收起已打开的 effort 下拉
  document.querySelectorAll('.eff-dd[open]').forEach(function (dd) {
    if (!dd.contains(e.target)) dd.removeAttribute('open')
  })
})

/** 从单条模型行收集已勾选档位；无勾选返回 null */
function collectEffPolicyFromRow(row, mid) {
  if (!mid) return null
  const dd = row.querySelector('.eff-dd')
  if (!dd) return null
  const sel = Array.from(dd.querySelectorAll('.eff-cb:checked')).map(function (c) { return c.value })
  return sel.length > 0 ? sel : null
}

/** 编辑表单：按模型行收集 oauth.effortPolicy（模型 ID 行内重命名会跟随新 ID） */
function collectEffortPolicyEdit(id) {
  const out = {}
  Array.from(document.querySelectorAll('#ml-' + id + ' [data-idx]')).forEach(function (item) {
    const idx = parseInt(item.dataset.idx)
    const mid = (document.getElementById('mid-' + id + '-' + idx) || {}).value?.trim() ?? ''
    const sel = collectEffPolicyFromRow(item, mid)
    if (sel) out[mid] = sel
  })
  return Object.keys(out).length > 0 ? out : undefined
}

/** 新建表单：按模型行收集 oauth.effortPolicy */
function collectEffortPolicyNew() {
  const out = {}
  Array.from(document.querySelectorAll('#amodels .ami')).forEach(function (inp) {
    const sel = collectEffPolicyFromRow(inp.parentElement, inp.value.trim())
    if (sel) out[inp.value.trim()] = sel
  })
  return Object.keys(out).length > 0 ? out : undefined
}

function collectOauthNew() {
  const g = function(id) { return (document.getElementById(id) || {}).value?.trim() ?? '' }
  let extraHeaders
  try { extraHeaders = g('ao7') ? JSON.parse(g('ao7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('ao8') || 'device',
    loginRealm: g('ao15') === 'global' ? 'global' : 'cn',
    deviceCodeUrl: g('ao1'),
    deviceTokenUrl: g('ao2'),
    refreshTokenUrl: g('ao3'),
    clientId: g('ao4'),
    clientSecret: g('ao14') || undefined,
    scope: g('ao5') || undefined,
    tokenHeader: g('ao6') || 'x-api-key',
    tokenHeaderPrefix: g('ao9') || undefined,
    extraHeaders,
    effortPolicy: collectEffortPolicyNew(),
    modelsUrl: g('ao10') || undefined,
    globalBaseUrl: g('ao11') || undefined,
    globalModelsUrl: g('ao12') || undefined,
    globalOrigin: g('ao13') || undefined,
    globalDeviceCodeUrl: g('ao16') || undefined,
    globalDeviceTokenUrl: g('ao17') || undefined,
    globalRefreshTokenUrl: g('ao18') || undefined,
  }
}

/** 收集「新建提供商」表单的 Vision Bridge 配置；未勾选识图模型时返回 undefined */
function collectVisionBridgeNew() {
  const vision = checkedValues('avb-vision')
  if (vision.length === 0) return undefined
  const primary = checkedRadioValue('avb-primary')
  return { primary: primary || undefined, vision, onVisionFailure: (document.getElementById('avb-fail') || {}).value || 'error' }
}

/** 收集「编辑提供商」表单的 Vision Bridge 配置；未勾选识图模型则清除配置 */
function collectVisionBridgeEdit(id) {
  // 懒渲染未展开时容器内无控件，直接读回 SSR 快照，避免保存时误清已保存的识图配置（P6）
  const root = document.getElementById('vb-vision-' + id)
  if (root && !root.getAttribute('data-vb-built')) {
    const orig = VB_ORIGINAL && VB_ORIGINAL[id]
    if (!orig || !orig.vision || orig.vision.length === 0) return undefined
    return { primary: orig.primary || undefined, vision: orig.vision, onVisionFailure: orig.onVisionFailure || 'error' }
  }
  const vision = checkedValues('vb-vision-' + id)
  if (vision.length === 0) return undefined
  const primary = checkedRadioValue('vb-primary-' + id)
  return { primary: primary || undefined, vision, onVisionFailure: (document.getElementById('vb-fail-' + id) || {}).value || 'error' }
}

/** 取容器内全部勾选的复选框 value（识图模型链，按 DOM 顺序 = 勾选顺序） */
function checkedValues(id) {
  const root = document.getElementById(id)
  const out = []
  if (root) root.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) { out.push(c.value) })
  return out
}

/** 为每个识图模型链容器重排顺序序号（勾选项显示 1/2/3…，未勾选显示 -） */
function renumberVisionOrders() {
  document.querySelectorAll('.model-check-list').forEach(function (list) {
    let n = 0
    list.querySelectorAll('.vb-item').forEach(function (item) {
      const badge = item.querySelector('.vb-order')
      if (!badge) return
      const cb = item.querySelector('input[type="checkbox"]')
      if (cb && cb.checked) {
        n += 1
        badge.textContent = n
        badge.classList.add('is-on')
      } else {
        badge.textContent = '-'
        badge.classList.remove('is-on')
      }
    })
  })
}
// 勾选识图模型时实时更新顺序序号（事件委托，覆盖新建/编辑表单）
document.addEventListener('change', function (e) {
  const t = e.target
  if (t && t.matches && t.matches('.model-check-list input[type="checkbox"]')) {
    renumberVisionOrders()
  }
})

/** 取容器内选中的单选框 value（主文本模型，空 = 本提供商自身模型） */
function checkedRadioValue(id) {
  const root = document.getElementById(id)
  if (!root) return ''
  const el = root.querySelector('input[type="radio"]:checked')
  return el ? el.value : ''
}

function collectOauthEdit(id) {
  const g = function(suffix) { return (document.getElementById('eao' + suffix + '-' + id) || {}).value?.trim() ?? '' }
  // 数字型 OAuth 字段（如并发上限）：留空/非法 → undefined（后端回默认），0 保留（表示不限）
  const numOauth = function(suffix) {
    const el = document.getElementById('eao' + suffix + '-' + id)
    const v = parseFloat((el || {}).value?.trim() ?? '')
    if (!Number.isFinite(v)) return undefined
    return v
  }
  let extraHeaders
  try { extraHeaders = g('7') ? JSON.parse(g('7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('8') || 'device',
    loginRealm: g('15') === 'global' ? 'global' : 'cn',
    deviceCodeUrl: g('1'),
    deviceTokenUrl: g('2'),
    refreshTokenUrl: g('3'),
    clientId: g('4'),
    clientSecret: g('14') || undefined,
    scope: g('5') || undefined,
    tokenHeader: g('6') || 'x-api-key',
    tokenHeaderPrefix: g('9') || undefined,
    extraHeaders,
    effortPolicy: collectEffortPolicyEdit(id),
    modelsUrl: g('10') || undefined,
    globalBaseUrl: g('11') || undefined,
    globalModelsUrl: g('12') || undefined,
    globalOrigin: g('13') || undefined,
    globalDeviceCodeUrl: g('16') || undefined,
    globalDeviceTokenUrl: g('17') || undefined,
    globalRefreshTokenUrl: g('18') || undefined,
    maxInFlight: numOauth('eao20'),
    maxInFlightGlobal: numOauth('eao21'),
  }
}

// ===== 厂商预设：单一数据源在文件顶部，页面 script 已注入 PROVIDER_PRESETS =====
function applyProviderPreset(name) {
  const p = PROVIDER_PRESETS[name]
  const keyInput = document.querySelector('#akeys .aki')
  if (keyInput) keyInput.placeholder = 'sk-...'
  applyClineKeyHint(false)
  const kukuRow = document.getElementById('akuku-row')
  if (kukuRow) kukuRow.classList.add('hd')
  const kukuQrRow = document.getElementById('akuku-qr')
  if (kukuQrRow) kukuQrRow.classList.add('hd')
  if (!p) return
  document.getElementById('anm').value = p.name
  document.getElementById('aid').value = p.id
  document.getElementById('aurl').value = p.baseUrl
  document.getElementById('afmt').value = p.apiType
  if (p.authType === 'oauth-device') {
    document.getElementById('aat').value = 'oauth-device'
    toggleAuthType()
    if (p.oauthPreset) applyOauthPreset(p.oauthPreset)
  } else {
    document.getElementById('aat').value = 'api-key'
    toggleAuthType()
  }
  // Cline：默认填上实测可用模型，并提示 Key 处填 refreshToken
  if (p.id === 'cline') {
    applyClineKeyHint(true)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else if (p.id === 'visionbridge') {
    applyVisionBridgePreset()
  } else if (p.id === 'gemini-api') {
    // 官方纯 API Key 直连（OpenAI 兼容端点），无需 OAuth，直接填好模型
    applyClineKeyHint(false)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else if (p.id === 'trae') {
    // TRAE SOLO：Key 区填登录凭证（登录后自动写入），预填实测模型
    applyTraeKeyHint(true)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else if (p.id === 'deepseek-app') {
    // token 注入型：创建时这里没有 Key 可填，凭据要创建后到详情页的面板里注入
    applyDeepseekKeyHint(true)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else {
    applyClineKeyHint(false)
  }
  if (kukuRow) kukuRow.classList.toggle('hd', p.type !== 'kuku')
  if (kukuQrRow) kukuQrRow.classList.toggle('hd', p.type !== 'kuku')
  const kukuThink = document.getElementById('akuku-think')
  if (kukuThink && p.type === 'kuku') kukuThink.value = String(p.kukuThinkMode ?? 3)
  if (p.type === 'kuku') {
    const legend = document.getElementById('akey-legend')
    const hint = document.getElementById('akey-hint')
    if (legend) legend.textContent = '百度账号 Cookie'
    if (hint) hint.textContent = '填写登录 kuku.baidu.com 后导出的完整 Cookie，或 kuku_cookies.json 内容。首阶段仅启用单账号文本对话。'
    if (keyInput) keyInput.placeholder = 'BDUSS=...; STOKEN=...'
    if (p.models && p.models.length) fillPresetModels(p.models)
  }
  const tb = document.getElementById('atb')
  if (tb) tb.checked = !!p.toolBridge
  // 预设切换后同步专属配置块显隐（工具桥 / Gemini 中转 / Client Secret / Global 域 / effort 下拉）
  syncNewScopedFields()
}
function applyVisionBridgePreset() {
  applyClineKeyHint(false)
  document.getElementById('avb-fail').value = 'error'
  const url = document.getElementById('aurl')
  if (url) url.value = 'https://example.com/v1'
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = '识图模型直接在下方勾选（可跨厂商，多选按顺序回退）。主文本模型留空时，本提供商下所有模型自动共享识图能力；本提供商 ID 下的模型 ID 为客户端选择时的名称。'
  // 自动展开识图配置
  const vbBtn = document.querySelector('.collapse-section > .collapse-btn')
  if (vbBtn) toggleVbCollapse('avb-fs', vbBtn)
  var refs = (typeof VB_MODELS !== 'undefined' && VB_MODELS) || []
  var want = ['qwen/qwen3-vl-flash', 'openai/gpt-4o-mini']
  var first = 'deepseek/deepseek-chat'
  if (refs.indexOf(first) === -1 && refs.length > 0) first = refs[0]
  var primaryBox = document.getElementById('avb-primary')
  var vision = document.getElementById('avb-vision')
  if (primaryBox) {
    primaryBox.querySelectorAll('input[type="radio"]').forEach(function (rb) { rb.checked = rb.value === first })
  }
  if (vision) {
    vision.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = want.indexOf(cb.value) !== -1 })
  }
}
function applyClineKeyHint(on) {
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = on ? 'Cline 使用 refreshToken（Cline 账号的长期钥匙）。每个 token 一行、一个账号；额度用完会自动切换，支持多账号。' : ''
  const legend = document.getElementById('akey-legend')
  if (legend) legend.textContent = on ? 'Cline RefreshTokens（每个账号一行）' : '上游 API Keys'
}
function applyTraeKeyHint(on) {
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = on ? 'TRAE SOLO 账号凭证为登录后自动写入的 JSON（也可粘贴 trae 登录脚本落盘的 trae-*.json 内容）。每个账号一行；创建后点「登录账号」可一键登录，额度用尽自动冷却轮换。' : ''
  const legend = document.getElementById('akey-legend')
  if (legend) legend.textContent = on ? 'TRAE 账号凭证（每个账号一行 JSON）' : '上游 API Keys'
}
/**
 * DeepSeek App：凭据不是 API Key 而是浏览器里取的 userToken。
 * 创建表单里没有注入入口（面板只在已存在的提供商详情页渲染），所以这里必须
 * 明确说「留空即可，创建后去详情页面板注入」，否则用户会以为漏填了 Key。
 */
function applyDeepseekKeyHint(on) {
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = on ? '这里留空——DeepSeek App 不用 API Key，凭据是浏览器里取的 userToken。点「创建提供商」后，展开该提供商，在「DeepSeek App token 池」面板里按四步指引注入并判活。' : ''
  const legend = document.getElementById('akey-legend')
  if (legend) legend.textContent = on ? '上游 API Keys（DeepSeek App 留空，创建后在详情页注入 token）' : '上游 API Keys'
}

/**
 * 新建表单：按当前填写的提供商 ID / 登录流程，显隐只对特定提供商生效的配置块。
 * 与编辑表单的 SSR 判定保持同一套规则（isCnbProviderUI / usesGlobalRealmUI / usesClientSecretUI / Gemini）。
 */
function syncNewScopedFields() {
  const aid = ((document.getElementById('aid') || {}).value || '').trim()
  const at = (document.getElementById('aat') || {}).value
  const flow = (document.getElementById('ao8') || {}).value
  const isOauth = at === 'oauth-device'
  const setHidden = function (id, hidden) {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('hd', !!hidden)
  }
  // 工具桥：仅 CNB（id 为 cnb 或用 cnb.cool 域）
  const url = ((document.getElementById('aurl') || {}).value || '')
  const isCnb = aid === 'cnb' || url.indexOf('cnb.cool') !== -1
  setHidden('atb-cs', !isCnb)
  // Gemini 推理中转地址：仅 Gemini 授权码流程
  setHidden('agbu-row', !(isOauth && flow === 'gemini'))
  // Client Secret：仅 Gemini OAuth 消费
  setHidden('ao14-row', !(isOauth && flow === 'gemini'))
  // 登录域 + Global 域端点：仅 browser / qoder 两条流程读取
  const usesRealm = isOauth && (flow === 'browser' || flow === 'qoder')
  setHidden('ao15-row', !usesRealm)
  setHidden('ao-global-rows', !usesRealm)
  // 模型行 effort 下拉：仅会消费 effortPolicy 的 WorkBuddy/CodeBuddy
  Array.from(document.querySelectorAll('#amodels .field-row')).forEach(function (row) {
    const has = !!row.querySelector('.eff-dd')
    const want = newFormUsesEffort()
    if (want && !has) effDdEnsure(row)
    else if (!want && has) { const dd = row.querySelector('.eff-dd'); if (dd) dd.remove() }
  })
}

/**
 * 编辑表单：登录流程类型变化后，重新显隐只对特定流程生效的配置块
 * （Client Secret / 登录域 / Global 域端点）。
 * 仅切换 CSS 显隐，不删除 DOM——隐藏的输入框仍会被 collectOauthEdit 读取，已存值不会丢失。
 */
function syncEditScopedFields(id) {
  const flow = ((document.getElementById('eao8-' + id) || {}).value) || 'device'
  const setHidden = function (elId, hidden) {
    const el = document.getElementById(elId)
    if (el) el.classList.toggle('hd', !!hidden)
  }
  setHidden('eao14-row-' + id, flow !== 'gemini')
  const usesRealm = flow === 'browser' || flow === 'qoder'
  setHidden('eao15-row-' + id, !usesRealm)
  setHidden('eao-global-rows-' + id, !usesRealm)
}

function toggleAuthType() {
  const v = document.getElementById('aat').value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-new').classList.toggle('hd', !isOauth)
  document.getElementById('akeys-fs').classList.toggle('hd', isOauth)
  document.getElementById('amodels-fs').classList.toggle('hd', isOauth)
  syncNewScopedFields()
}
function toggleAuthTypeEdit(id) {
  const v = document.getElementById('auth-' + id).value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-edit-' + id).classList.toggle('hd', !isOauth)
  const keysFs = document.getElementById('keys-fs-' + id)
  if (keysFs) keysFs.classList.toggle('hd', isOauth)
  const modelsFs = document.getElementById('models-fs-' + id)
  if (modelsFs) modelsFs.classList.toggle('hd', isOauth)
  if (isOauth) syncEditScopedFields(id)
}

// OAuth 预置模板：单一数据源在文件顶部，页面 script 已注入 OAUTH_PRESETS
function applyOauthPreset(name) {
  const p = OAUTH_PRESETS[name]
  if (!p) return
  document.getElementById('ao1').value = p.deviceCodeUrl
  document.getElementById('ao2').value = p.deviceTokenUrl
  document.getElementById('ao3').value = p.refreshTokenUrl
  document.getElementById('ao4').value = p.clientId
  const cs = document.getElementById('ao14'); if (cs) cs.value = p.clientSecret || ''
  document.getElementById('ao5').value = p.scope || ''
  document.getElementById('ao6').value = p.tokenHeader || 'x-api-key'
  document.getElementById('ao7').value = JSON.stringify(p.extraHeaders || {}, null, 2)
  const ft = document.getElementById('ao8'); if (ft) ft.value = p.flowType || 'device'
  const tp = document.getElementById('ao9'); if (tp) tp.value = p.tokenHeaderPrefix || ''
  const mu = document.getElementById('ao10'); if (mu) mu.value = p._modelsUrl || ''
  const gb = document.getElementById('ao11'); if (gb) gb.value = p._globalBaseUrl || ''
  const gm = document.getElementById('ao12'); if (gm) gm.value = p._globalModelsUrl || ''
  const go = document.getElementById('ao13'); if (go) go.value = p._globalOrigin || ''
  const gdc = document.getElementById('ao16'); if (gdc) gdc.value = p._globalDeviceCodeUrl || ''
  const gdt = document.getElementById('ao17'); if (gdt) gdt.value = p._globalDeviceTokenUrl || ''
  const grf = document.getElementById('ao18'); if (grf) grf.value = p._globalRefreshTokenUrl || ''
  const lr = document.getElementById('ao15'); if (lr) lr.value = 'cn'
  // 强制覆盖 baseUrl（不再仅在空时填）
  if (p._baseUrl) { const bu = document.getElementById('aurl'); if (bu) bu.value = p._baseUrl }
  document.getElementById('aat').value = 'oauth-device'
  toggleAuthType()
}
function applyOauthPresetEdit(id, name) {
  const p = OAUTH_PRESETS[name]
  if (!p) return
  document.getElementById('eao1-' + id).value = p.deviceCodeUrl
  document.getElementById('eao2-' + id).value = p.deviceTokenUrl
  document.getElementById('eao3-' + id).value = p.refreshTokenUrl
  document.getElementById('eao4-' + id).value = p.clientId
  const cs = document.getElementById('eao14-' + id); if (cs) cs.value = p.clientSecret || ''
  document.getElementById('eao5-' + id).value = p.scope || ''
  document.getElementById('eao6-' + id).value = p.tokenHeader || 'x-api-key'
  document.getElementById('eao7-' + id).value = JSON.stringify(p.extraHeaders || {}, null, 2)
  const ft = document.getElementById('eao8-' + id); if (ft) ft.value = p.flowType || 'device'
  const tp = document.getElementById('eao9-' + id); if (tp) tp.value = p.tokenHeaderPrefix || ''
  const mu = document.getElementById('eao10-' + id); if (mu) mu.value = p._modelsUrl || ''
  const gb = document.getElementById('eao11-' + id); if (gb) gb.value = p._globalBaseUrl || ''
  const gm = document.getElementById('eao12-' + id); if (gm) gm.value = p._globalModelsUrl || ''
  const go = document.getElementById('eao13-' + id); if (go) go.value = p._globalOrigin || ''
  const gdc = document.getElementById('eao16-' + id); if (gdc) gdc.value = p._globalDeviceCodeUrl || ''
  const gdt = document.getElementById('eao17-' + id); if (gdt) gdt.value = p._globalDeviceTokenUrl || ''
  const grf = document.getElementById('eao18-' + id); if (grf) grf.value = p._globalRefreshTokenUrl || ''
  const lr = document.getElementById('eao15-' + id); if (lr) lr.value = 'cn'
  // 强制覆盖 baseUrl
  if (p._baseUrl) { const bu = document.getElementById('url-' + id); if (bu) bu.value = p._baseUrl }
  document.getElementById('auth-' + id).value = 'oauth-device'
  toggleAuthTypeEdit(id)
}

// 预置模型填充 — 新建模式
function fillPresetModels(models) {
  const c = document.getElementById('amodels')
  if (!c) return
  c.innerHTML = ''
  models.forEach(function(mid) { addMdlToForm(mid) })
}
// 预置模型填充 — 编辑模式
function fillPresetModelsEdit(id, models) {
  const c = document.getElementById('ml-' + id)
  if (!c) return
  c.innerHTML = ''
  models.forEach(function(mid) {
    const d = document.createElement('div')
    d.className = 'fc mb-3 field-row'
    d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + escapeHtml(id) + '-' + Math.random().toString(36).substr(2,9) + '" placeholder="模型 ID"><label class="tg"><input type="checkbox" checked aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testMdl(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(mid) + '\\')"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()"><i class="fas fa-times c-l"></i></button>'
    c.appendChild(d)
  })
}

function oauthStatus(id) {
  const st = document.getElementById('oauth-st-' + id)
  st.textContent = '查询中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/status').then(r => r.json()).then(d => {
    if (!d.success) { st.textContent = d.message || '查询失败'; return }
    st.textContent = d.data.connected ? ('已连接，到期 ' + (d.data.expiresAt ? new Date(d.data.expiresAt).toLocaleString() : '未知')) : '未连接'
  }).catch(() => { st.textContent = '查询失败' })
}

// ===== WorkBuddy 多账号池：状态 / 移除 / 冷却参数 =====
function oauthPoolStatus(id) {
  const st = document.getElementById('wbp-st-' + id)
  if (st) st.innerHTML = '<span class="mu"><i class="fas fa-spinner fa-spin"></i> 加载账号池…</span>'
  // 并行拉取账号池 + 签到状态，按 uid 合并出签到/额度/权益包明细
  return Promise.all([
    fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/status').then(r => r.json()),
    fetch('/admin/api/checkin/status').then(r => r.json()).catch(() => null),
  ]).then(res => {
    const d = res[0], cd = res[1]
    if (!d.success) { if (st) showResult(st, false, d.message || '查询失败'); return }
    const pool = (d.data && d.data.pool) || []
    if (st) showResult(st, true, '共 ' + pool.length + ' 个账号')
    const preferUid = (d.data && d.data.preferUid) || ''
    // 从签到状态里找本提供商的逐账号明细（data.workbuddy[].providerId === id）
    let ciAccounts = []
    if (cd && cd.success && cd.data && Array.isArray(cd.data.workbuddy)) {
      const entry = cd.data.workbuddy.find(function (w) { return w && w.providerId === id })
      if (entry && Array.isArray(entry.accounts)) ciAccounts = entry.accounts
    }
    const ciByUid = {}
    const ciByNick = {}
    ciAccounts.forEach(function (a, ai) {
      if (!a) return
      if (a.uid) ciByUid[a.uid] = a
      // 旧数据无 uid：用 nickname 兜底匹配
      if (a.nickname) ciByNick[a.nickname] = a
      // 均缺失时挂到序号上（账号数一致时按池顺序对齐，最后兜底）
      a.__idx = ai
    })
    renderOauthPoolAccounts(id, pool, ciByUid, ciByNick, ciAccounts, preferUid)
    // 冷却到点自动重取一次：剩余时长来自服务端（remainingMs/remainingText），客户端只按它睡觉。
    // 为什么可以放心轮询：WorkBuddy 池的 /status 是**纯 KV 读**（不打上游）——只有 Qoder 的
    // 「刷新账号池」会顺带逐号探额度（?credits=1），那条路径绝不挂自动重取。
    var soonestWb = 0
    pool.forEach(function (a) {
      if (a && a.cooling && a.remainingMs > 0 && (soonestWb === 0 || a.remainingMs < soonestWb)) soonestWb = a.remainingMs
    })
    coolRefreshSchedule('wbpool:' + id, soonestWb, function () { oauthPoolStatus(id) })
  }).catch(() => { if (st) showResult(st, false, '查询失败') })
}
/* WB_EXPIRY_BEGIN */
// ===== 权益包「7 天内到期」判定与渲染（纯函数；单测按标记块抽取） =====
// WorkBuddy / TRAE / Qoder 三个池共用这一套（Qoder 的额度包由后端 buildQoderPacks 落成同一形态）。
// 口径必须与后端挑号一致（src/credit-expiry.ts + oauth-pool.soonestOauthExpiryAt / qoder/pool.soonestQoderExpiryAt）：
//   1) 上游 ExpiredTime 是 **CST 墙钟串**，浏览器本地时区可能是别的，必须显式按 +08:00 解释；
//   2) 只有「剩余 = 总额 - 已用 > 0」的包才算待救积分（已用尽的空包不参与优先）；
//   3) 窗口 7 天（含边界）；窗口内最早到期的账号在池内被优先挑中。
const WB_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** "YYYY-MM-DD HH:mm:ss"（CST）→ epoch ms；非法 → NaN。与后端 parseCstWallClock 同口径。 */
function wbParseCstWallClock(s) {
  if (typeof s !== 'string') return NaN;
  const t = s.trim();
  if (!t) return NaN;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*UTC\+8)?$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], m[6] ? +m[6] : 0);
  const p = Date.parse(t);
  return isNaN(p) ? NaN : p;
}
/** 包的剩余额度（口径同后端 packageExpiryEntry：max(0, size - used)）。 */
function wbPackRemain(p) {
  const size = p && typeof p.size === 'number' ? p.size : 0;
  const used = p && typeof p.used === 'number' ? p.used : 0;
  return size - used;
}
/** 7 天内到期且有剩余的包，按到期升序返回 [{name, ms, remain, days}]；无 → []。 */
function wbPackExpiring7d(packages, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!Array.isArray(packages)) return [];
  const out = [];
  for (const p of packages) {
    if (!p) continue;
    const remain = wbPackRemain(p);
    if (!(remain > 0)) continue;
    const ms = wbParseCstWallClock(p.expireAt);
    if (isNaN(ms) || ms <= now || ms - now > WB_EXPIRY_WINDOW_MS) continue;
    out.push({ name: p.name || '', ms: ms, remain: remain, days: Math.ceil((ms - now) / 86400000) });
  }
  out.sort(function (a, b) { return a.ms - b.ms; });
  return out;
}
/** 到期时间单元格：空 = 长期；非法 = 原样灰字；已过期 = 红；7 天内 = 琥珀 + 「剩 N 天」。 */
function wbPackExpireHtml(expireAt) {
  const raw = (typeof expireAt === 'string' && expireAt.trim()) ? expireAt.trim() : '';
  if (!raw) return '<span class="mu">长期</span>';
  const ms = wbParseCstWallClock(raw);
  if (isNaN(ms)) return '<span class="mu">' + escapeHtml(raw) + '</span>';
  const left = ms - Date.now();
  if (left <= 0) return '<span style="color:var(--color-danger,#ef4444)" title="' + escapeHtml(raw) + ' (CST)">已过期</span>';
  const days = Math.ceil(left / 86400000);
  const color = left <= 86400000 ? 'var(--color-danger,#ef4444)'
    : (left <= WB_EXPIRY_WINDOW_MS ? 'var(--color-warn,#d97706)' : 'inherit');
  const tail = left <= WB_EXPIRY_WINDOW_MS ? ' · 优先消耗' : '';
  return '<span style="color:' + color + '" title="' + escapeHtml(raw) + ' (CST)">' + escapeHtml(raw) + '</span><br><small class="mu">剩 ' + days + ' 天' + tail + '</small>';
}
/** 账号行徽章：「⏳ N 个包 7 天内到期」（无则空串，不刷存在感）。 */
function wbExpiringBadge(packages) {
  const soon = wbPackExpiring7d(packages);
  if (!soon.length) return '';
  const tip = soon.map(function (p) {
    return (p.name || '权益包') + ' 剩 ' + p.days + ' 天（余 ' + p.remain + '）';
  }).join('；');
  return ' <span class="bd bd-warn" title="' + escapeHtml('7 天内到期，池内优先消耗：' + tip) + '">⏳ ' + soon.length + ' 个包 7 天内到期</span>';
}
/** 展示排序键：到期越早越小；无到期时间（长期/未知）统一排最后。 */
function wbPackSortKey(ms) {
  return (typeof ms === 'number' && isFinite(ms) && ms > 0) ? ms : Number.MAX_SAFE_INTEGER;
}
/** 展示排序：到期升序 → 同名按名称稳定（避免两次刷新顺序抖动）。 */
function wbPackCmp(aMs, bMs, aName, bName) {
  const ka = wbPackSortKey(aMs), kb = wbPackSortKey(bMs);
  if (ka !== kb) return ka - kb;
  return String(aName || '').localeCompare(String(bName || ''));
}
/**
 * WorkBuddy 权益包展示列表：**隐藏已用完的包**（有正额度上限且无剩余），
 * 并按「到期越早越靠前、长期有效排最后」排序（快过期的显示在最上面）。
 *
 * 为什么不隐藏「容量未下发」（size <= 0）的包：无从判定它已用完，隐藏等于丢信息
 * （这类包面板原样显示「—」）。返回 {rows, hidden, total}，rows 为新数组（不改入参）。
 */
function wbPackageDisplayList(packages) {
  const all = Array.isArray(packages) ? packages.filter(function (p) { return !!p }) : [];
  const rows = [];
  let hidden = 0;
  for (const p of all) {
    const size = typeof p.size === 'number' ? p.size : 0;
    if (size > 0 && wbPackRemain(p) <= 0) { hidden++; continue; }
    rows.push(p);
  }
  rows.sort(function (a, b) {
    return wbPackCmp(wbParseCstWallClock(a.expireAt), wbParseCstWallClock(b.expireAt), a.name, b.name);
  });
  return { rows: rows, hidden: hidden, total: all.length };
}
/**
 * TRAE 权益包展示列表：**隐藏已用完的包**（limit > 0 且剩余 <= 0），
 * 并按「到期越早越靠前、长期（expireAt 0/缺省）排最后」排序。
 * limit 未下发（0）的包不隐藏（无从判定）。返回 {rows, hidden, total}。
 */
function traePackDisplayList(packs) {
  const all = Array.isArray(packs) ? packs.filter(function (p) { return !!p }) : [];
  const rows = [];
  let hidden = 0;
  for (const p of all) {
    const limit = Number(p.limit) || 0;
    const rem = Number(p.rem) || 0;
    if (limit > 0 && rem <= 0) { hidden++; continue; }
    rows.push(p);
  }
  rows.sort(function (a, b) {
    const ea = Number(a.expireAt) > 0 ? Number(a.expireAt) * 1000 : Number.MAX_SAFE_INTEGER;
    const eb = Number(b.expireAt) > 0 ? Number(b.expireAt) * 1000 : Number.MAX_SAFE_INTEGER;
    return wbPackCmp(ea, eb, a.name, b.name);
  });
  return { rows: rows, hidden: hidden, total: all.length };
}
/* WB_EXPIRY_END */
function renderOauthPoolAccounts(id, accs, ciByUid, ciByNick, ciAccounts, preferUid) {
  const box = document.getElementById('wbp-acc-' + id)
  if (!box) return
  if (!accs.length) { box.innerHTML = '<p class="mu">账号池为空：点「发起连接」每登录一个 WorkBuddy 账号即自动加入（可登录多个账号）。</p>'; return }
  preferUid = preferUid || ''
  ciByUid = ciByUid || {}
  ciByNick = ciByNick || {}
  ciAccounts = ciAccounts || []
  // 首选账号下拉（对齐 TRAE 面板的手工指定交互）：留空 = 按剩余积分自动挑选
  const opts = ['<option value="">自动挑选（即将到期优先）</option>'].concat(accs.map(function (a) {
    const sel = a.uid === preferUid ? ' selected' : ''
    return '<option value="' + escapeHtml(a.uid) + '"' + sel + '>' + escapeHtml((a.nickname || a.uid)) + '</option>'
  })).join('')
  const preferBar = '<div class="fc mt-1 field-row" style="align-items:center;gap:8px"><label style="margin:0;white-space:nowrap">首选账号：</label>' +
    '<select id="wbp-prefer-' + escapeHtml(id) + '" class="select-sm" style="max-width:280px">' + opts + '</select>' +
    '<button class="btn btn-s btn-xs" onclick="oauthPoolSetPrefer(\\'' + escapeJsAttr(id) + '\\')">指定</button>' +
    '<button class="btn btn-gh btn-xs" onclick="oauthPoolSetPrefer(\\'' + escapeJsAttr(id) + '\\',\\'\\')">恢复自动</button>' +
    '<span id="wbp-prefer-msg-' + escapeHtml(id) + '"></span></div>'
  // 旧 KV 签到数据无 uid 且昵称可能两侧均空：账号数一致时按池顺序对齐作最后兜底
  const idxFallback = ciAccounts.length === accs.length ? ciAccounts : null
  box.innerHTML = preferBar + accs.map(function(a, i) {
    const isOff = a.disabled || a.enabled === false
    // 签到结果匹配：uid → nickname → 顺序兜底（仅账号数一致时）
    const ci = ciByUid[a.uid] || (a.nickname && ciByNick[a.nickname]) || (idxFallback ? idxFallback[i] : null)
    // 签到状态徽章（今日已签 / 失败 / 未签）
    let ciBadge = ''
    if (ci) {
      if (ci.realm === 'global' || ci.reason === 'skipped_global') {
        // 国际版：无每日签到 / 猫猫旅行 / 开学季 / 夜猫任务，积分仅一次性 trial；
        // 活跃上报照常点亮连登（workbuddy.ai/v2/report 可用）。故不展示「签到成功」等 CN 专属标记。
        ciBadge = ' <span class="bd bd-info" title="国际版账号无每日签到/猫猫旅行/开学季/夜猫任务，积分仅一次性 trial。活跃上报照常点亮连登。">🌐 国际版</span>'
        if (ci.activityReport) {
          ciBadge += ' <span class="bd ' + (ci.activityReport.success ? 'bd-on' : 'bd-warn') + '" title="' + escapeHtml(ci.activityReport.message || '') + '">📡 活跃' + (ci.activityReport.success ? '已报' : '失败') + '</span>'
        }
        if (ci.trialClaim) {
          if (ci.trialClaim.already || ci.trialClaim.success) ciBadge += ' <span class="bd bd-on" title="国际版一次性 trial 加油包已领取">🎁 trial 已领</span>'
          else ciBadge += ' <span class="bd bd-warn" title="' + escapeHtml(ci.trialClaim.message || '') + '">🎁 trial 失败</span>'
        }
        if (ci.globalActivation && !ci.globalActivation.ok) {
          ciBadge += ' <span class="bd bd-danger" title="' + escapeHtml(ci.globalActivation.message || '') + '">⚠️ 激活失败</span>'
        }
      } else {
        ciBadge = ci.success ? ' <span class="bd bd-on">' + (ci.reason === 'already' ? '今日已签' : '签到成功') + '</span>'
          : ' <span class="bd bd-danger">签到失败</span>'
        // 成功时 message 是纯状态文案（如「签到成功」）会与徽章重复，仅失败时展示错误原因
        if (ci.message && !ci.success) ciBadge += ' <span style="color:var(--muted)">' + escapeHtml(ci.message) + '</span>'
      }
      // 连登徽章（CN 与 global 都有：活跃上报点亮连登）
      if (typeof ci.streakDays === 'number' && ci.streakDays > 0) {
        ciBadge += ' <span class="bd bd-on" title="连续签到/活跃天数">🔥 连登 ' + ci.streakDays + ' 天</span>'
      }
      // 猫猫旅行徽章（仅 CN：global 无此体系，natural 为空）
      if (!(ci.realm === 'global' || ci.reason === 'skipped_global') && ci.catTravel) {
        const ct = ci.catTravel
        let ctText = ''
        if (ct.state === 'traveling') ctText = '🐱 旅行中'
        else if (ct.state === 'claimed') ctText = '🐱 领奖+' + (ct.reward || '')
        else if (ct.state === 'departed') ctText = '🐱 已出发'
        else if (ct.state === 'adopted') ctText = '🐱 领养+300'
        else if (ct.state === 'idle' || ct.state === 'idle_limit') ctText = '🐱 休息中'
        else if (ct.state === 'error') ctText = '🐱 异常'
        else if (ct.state) ctText = '🐱 ' + ct.state
        if (ctText) {
          const ctTip = ct.message ? ' title="' + escapeHtml(ct.message) + '"' : ''
          ciBadge += ' <span class="bd bd-info"' + ctTip + '>' + escapeHtml(ctText) + '</span>'
        }
      }
      // 连登奖励/抽奖徽章（仅 CN：global 无该体系，见 runWorkbuddyGrowthRewards 门控）
      // acted=false 时不展示——「今日已领/未达标/无次数」属正常态，不该在面板上刷存在感。
      if (!(ci.realm === 'global' || ci.reason === 'skipped_global') && ci.growthReward && ci.growthReward.acted) {
        const gr = ci.growthReward
        let grText = '🎯 ' + (gr.tier || '奖励')
        if (gr.prize) grText += ' + 抽奖'
        const grTip = gr.message ? ' title="' + escapeHtml(gr.message) + '"' : ''
        ciBadge += ' <span class="bd bd-on"' + grTip + '>' + escapeHtml(grText) + '</span>'
      }
    } else {
      ciBadge = ' <span class="bd bd-off">未签</span>'
    }
    // 额度明细（可用/已用/额度池），与签到区口径一致
    let creditLine = ''
    if (ci && (ci.totalRemain !== undefined && ci.totalRemain !== null)) {
      const used = (ci.totalUsed !== undefined && ci.totalUsed !== null) ? ci.totalUsed : '—'
      const size = (ci.totalSize !== undefined && ci.totalSize !== null) ? ci.totalSize : '—'
      const packs = (ci.packCount !== undefined && ci.packCount !== null) ? ' · ' + ci.packCount + ' 个包' : ''
      const pct = (ci.totalSize > 0 && ci.totalUsed !== undefined && ci.totalUsed !== null) ? ' · ' + Math.round(ci.totalUsed / ci.totalSize * 100) + '%' : ''
      creditLine = '<div class="mu" style="margin-top:2px">可用 ' + ci.totalRemain + ' · 已用 ' + used + pct + ' · 额度池 ' + size + packs + '</div>'
    }
    // 权益包明细折叠表（与签到区相同的表格结构）。
    // 数据源优先用池状态里的 packages——它就是挑号用的那一份，且比签到结果（有 TTL）活得久；
    // 旧 KV 数据 / 尚未签到探测时回退签到结果里的同源快照。
    const pkgs = Array.isArray(a.packages) ? a.packages : (ci && Array.isArray(ci.packages) ? ci.packages : null)
    const expiring7d = wbPackExpiring7d(pkgs)
    // 展示列表：已用完的包隐藏；快过期的排最上面（长期有效排最后）
    const pkgDisp = wbPackageDisplayList(pkgs)
    const hiddenPkg = pkgDisp.hidden > 0 ? ' · <span class="mu">已用完 ' + pkgDisp.hidden + ' 个已隐藏</span>' : ''
    let pkgHtml = ''
    if (pkgDisp.rows.length > 0) {
      const aid = 'wbpkg-' + escapeHtml(id) + '-' + i
      const rows = pkgDisp.rows.map(function(p) {
        const cyc = (p.cycleEndTime && p.cycleEndTime.trim()) ? escapeHtml(p.cycleEndTime) : '—'
        let qty = '—'
        if (p.size !== undefined && p.size !== null && p.size > 0) {
          const used2 = (p.used !== undefined && p.used !== null) ? p.used : 0
          qty = used2 + ' / ' + p.size + (p.unit ? ' ' + p.unit : '')
        }
        return '<tr><td>' + escapeHtml(p.name) + '</td><td>' + wbPackExpireHtml(p.expireAt) + '</td><td>' + cyc + '</td><td class="numeric">' + qty + '</td></tr>'
      }).join('')
      const pkgHead = '权益包明细（' + pkgDisp.rows.length + '）' + (expiring7d.length > 0 ? ' · <span style="color:var(--color-warn,#d97706)">' + expiring7d.length + ' 个 7 天内到期</span>' : '') + hiddenPkg
      pkgHtml = '<div class="collapse-section" style="margin-top:4px"><button class="collapse-btn" data-pkg="' + aid + '" type="button" aria-expanded="false"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> ' + pkgHead + '</button><div id="' + aid + '" class="hd usage-log-table-wrap"><table class="usage-log-table"><thead><tr><th>名称</th><th>到期时间</th><th>周期结束</th><th>已用/总额度</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
    } else if (pkgDisp.total > 0) {
      pkgHtml = '<div class="mu" style="margin-top:2px">权益包明细：' + pkgDisp.total + ' 个包已全部用完</div>'
    }
    let line = 'uid=' + escapeHtml(a.uid) + (a.nickname ? '（' + escapeHtml(a.nickname) + '）' : '') + ' · 积分=' + (a.credits || 0) + wbExpiringBadge(pkgs)
    // 冷却状态徽章（常显，对齐 TRAE「冷却至」列）：禁用（红）> 冷却中（琥珀）> 无冷却（绿）；详情 muted 文字跟随
    const coolBadge = isOff ? '<span class="bd bd-danger">已禁用</span>'
      : (a.cooling ? '<span class="bd bd-warn">冷却中</span>' : '<span class="bd bd-on">无冷却</span>')
    let coolDetail = ''
    if (isOff) coolDetail = a.reason ? '（' + escapeHtml(a.reason) + '）' : ''
    else if (a.cooling && a.until) coolDetail = ' 冷却至 ' + new Date(a.until).toLocaleString() + (a.remainingText ? '（剩 ' + escapeHtml(a.remainingText) + '）' : '') + (a.reason ? '（' + escapeHtml(a.reason) + '）' : '')
    else if (a.reason) coolDetail = '（上次：' + escapeHtml(a.reason) + '）'
    let modelRateBadge = ''
    // 6004 模型级限流徽章（多模型表）：逐条展示仍在限额中的模型与恢复时刻
    const mcList = Array.isArray(a.modelCooldowns) ? a.modelCooldowns : []
    for (const mc of mcList) {
      if (!mc || !mc.model || !(mc.until > Date.now())) continue
      const resetTimeStr = new Date(mc.resetAt || mc.until).toLocaleTimeString()
      modelRateBadge += ' <span class="bd bd-warn" title="模型 ' + escapeHtml(mc.model) + ' 限流至 ' + resetTimeStr + '">模型限流(' + escapeHtml(mc.model) + ')</span>'
    }
    line += ' ' + coolBadge + modelRateBadge + '<span class="mu">' + coolDetail + '</span>'
    if (a.tokenMask) {
      line += ' · <code class="mu" style="font-size:11px" title="已存储于网关 KV">Token: ' + escapeHtml(a.tokenMask) + '</code>'
    }
    return '<div class="fc mb-2 field-row" style="align-items:flex-start"><div class="fx1" style="font-size:12px;min-width:0"><div>' + line + ' ' + ciBadge + '</div>' + creditLine + pkgHtml + '</div><div class="fc" style="gap:4px"><button class="btn btn-gh btn-xs" onclick="oauthPoolCopyToken(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')" title="复制 Access Token"><i class="fas fa-copy" aria-hidden="true"></i>复制Token</button><button class="btn btn-gh btn-xs" onclick="oauthPoolRemove(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')"><i class="fas fa-trash" aria-hidden="true"></i>移除</button></div></div>'
  }).join('')
  // 绑定权益包折叠按钮（与签到区相同的 toggleCollapse 交互）
  box.querySelectorAll('[data-pkg]').forEach(function(btn) {
    btn.addEventListener('click', function() { toggleCollapse(btn.getAttribute('data-pkg'), btn) })
  })
}
function oauthPoolRemove(id, uid) {
  cM('确定从账号池移除 ' + uid + ' 吗？该账号将不再被轮换使用。').then(function(ok) {
    if (!ok) return
    fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/pool/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid })
    }).then(r => r.json()).then(function(d) {
      toast(d.message || (d.success ? '已移除' : '移除失败'), d.success ? 'success' : 'error')
      if (d.success) {
        // Qoder 池与 WorkBuddy 池共用移除接口，按容器存在性刷新对应池
        if (document.getElementById('qdp-acc-' + id)) qoderPoolStatus(id)
        else oauthPoolStatus(id)
      }
    }).catch(function() { toast('移除失败', 'error') })
  })
}
// WorkBuddy 多账号池：设置首选账号（对齐 TRAE 面板交互；forcedUid 传入 '' 恢复自动挑选）
function oauthPoolSetPrefer(id, forcedUid) {
  const sel = document.getElementById('wbp-prefer-' + id)
  const msg = document.getElementById('wbp-prefer-msg-' + id)
  const uid = (forcedUid !== undefined ? forcedUid : ((sel || {}).value || '')).trim()
  if (msg) msg.textContent = ''
  fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/pool/prefer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: uid }),
  }).then(r => r.json()).then(function(d) {
    if (!d.success) { if (msg) { msg.textContent = (d.message || '设置失败'); msg.style.color = 'var(--color-danger,#ef4444)' } return }
    if (msg) { msg.textContent = (d.message || '已设置'); msg.style.color = 'var(--color-success,#16a34a)' }
    if (sel) sel.value = uid
    setTimeout(function () { oauthPoolStatus(id) }, 800)
  }).catch(function() { if (msg) { msg.textContent = '网络错误，请重试'; msg.style.color = 'var(--color-danger,#ef4444)' } })
}

// ===== 账号池 Token 复制与全量导出 =====
function oauthPoolCopyToken(id, uid) {
  fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/pool/export?uid=' + encodeURIComponent(uid))
    .then(r => r.json())
    .then(function(d) {
      if (!d.success || !Array.isArray(d.data) || !d.data[0] || !d.data[0].access_token) {
        toast('未找到该账号的 Access Token', 'error')
        return
      }
      const token = d.data[0].access_token
      navigator.clipboard.writeText(token).then(function() {
        toast('账号 ' + (d.data[0].nickname || uid) + ' 的 Token 已复制到剪贴板', 'success')
      }).catch(function() {
        toast('复制失败，请重试', 'error')
      })
    }).catch(function() { toast('网络错误，获取 Token 失败', 'error') })
}
function oauthPoolExportModal(id) {
  showM('<h3><i class="fas fa-spinner fa-spin c-p"></i> 加载凭证与 Token…</h3><p class="mu">正在从网关 KV 读取完整凭证…</p>')
  fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/pool/export')
    .then(r => r.json())
    .then(function(d) {
      if (!d.success || !Array.isArray(d.data) || d.data.length === 0) {
        showM('<h3><i class="fas fa-exclamation-triangle c-d"></i> 暂无可导出的账号</h3><p>账号池为空或未登录任何账号。</p><div class="fa"><button class="btn btn-p" onclick="closeM()">关闭</button></div>')
        return
      }
      const accs = d.data
      const jsonStr = JSON.stringify(accs, null, 2)
      let h = '<h3><i class="fas fa-file-export c-p"></i> 导出账号凭证与 Token</h3>'
      h += '<p class="mu" style="font-size:12px;margin-bottom:8px">共 ' + accs.length + ' 个账号凭证。格式已自动适配 <code>scripts/workbuddy/</code> 脚本库，可直接保存至 <code>auths/</code> 目录使用。</p>'
      h += '<div class="fc mb-2" style="gap:8px;flex-wrap:wrap">'
      h += '<button class="btn btn-p btn-xs" onclick="copyText(window.__lastExportJson, this)"><i class="fas fa-copy" aria-hidden="true"></i> 复制全部 JSON</button>'
      h += '<a class="btn btn-s btn-xs" href="/admin/api/oauth/' + encodeURIComponent(id) + '/pool/export?download=1" download><i class="fas fa-download" aria-hidden="true"></i> 下载完整 JSON 文件</a>'
      h += '</div>'

      h += '<div style="max-height:280px;overflow-y:auto;border:1px solid var(--color-rule);border-radius:6px;padding:8px;margin-bottom:10px;background:var(--color-paper-2)">'
      accs.forEach(function(a, idx) {
        const singleJson = JSON.stringify(a, null, 2)
        window['__exportJson_' + idx] = singleJson
        window['__exportTok_' + idx] = a.access_token || ''
        h += '<div style="padding:6px 0;' + (idx > 0 ? 'border-top:1px dashed var(--color-rule);' : '') + '">'
        h += '<div class="fc" style="justify-content:space-between;align-items:center;font-size:12px">'
        h += '<strong>' + escapeHtml(a.nickname || a.uid) + '</strong><span class="mu">UID: ' + escapeHtml(a.uid) + '</span>'
        h += '<div class="fc" style="gap:4px">'
        h += '<button class="btn btn-gh btn-xs" onclick="copyText(window.__exportTok_' + idx + ', this)" title="复制 Token"><i class="fas fa-key"></i> 复制Token</button>'
        h += '<a class="btn btn-gh btn-xs" href="/admin/api/oauth/' + encodeURIComponent(id) + '/pool/export?uid=' + encodeURIComponent(a.uid) + '&download=1" download title="下载此账号 JSON"><i class="fas fa-download"></i> 下载JSON</a>'
        h += '</div>'
        h += '</div>'
        h += '<div class="fc mt-1 field-row" style="align-items:center;gap:6px">'
        h += '<input type="password" id="exp-tok-' + idx + '" value="' + escapeHtml(a.access_token || '') + '" readonly style="font-size:11px;padding:2px 6px;flex:1;font-family:monospace">'
        h += '<button class="icon-btn" onclick="toggleKeyText(this)" title="查看/隐藏 Token"><i class="fas fa-eye"></i></button>'
        h += '</div>'
        h += '</div>'
      })
      h += '</div>'

      h += '<div class="fg" style="margin-bottom:8px"><label style="font-size:12px">全部账号 JSON 预览</label><textarea readonly rows="5" style="font-size:11px;font-family:monospace;width:100%">' + escapeHtml(jsonStr) + '</textarea></div>'
      h += '<div class="fa"><button class="btn btn-p" onclick="closeM()">关闭</button></div>'

      window.__lastExportJson = jsonStr
      showM(h)
    }).catch(function() {
      showM('<h3><i class="fas fa-exclamation-triangle c-d"></i> 导出失败</h3><p>网络或服务错误，无法读取账号凭证。</p><div class="fa"><button class="btn btn-p" onclick="closeM()">关闭</button></div>')
    })
}

// ===== Qoder 多账号池：状态 / 移除 =====
/**
 * 额度探测结果摘要。失败必须带出原因——只显示「已刷新」会让用户以为每个号都探到了，
 * 而实际上某个号的 token 已经不能用（那正是他点刷新想确认的事）。
 */
function qoderProbeSummary(count, probe) {
  var base = '共 ' + count + ' 个账号'
  if (!probe) return base
  if (probe.error) return base + ' · 额度探测失败：' + probe.error
  if (!probe.length) return base + ' · 额度探测：池内无账号'
  var ok = 0, fails = []
  probe.forEach(function (r) {
    if (r && r.ok) ok++
    else fails.push(((r && r.uid) ? String(r.uid).slice(0, 8) : '?') + '：' + ((r && r.error) || '未知错误'))
  })
  return base + ' · 额度已刷新 ' + ok + '/' + probe.length + (fails.length ? '，失败 ' + fails.join('；') : '')
}
function qoderPoolStatus(id) {
  const st = document.getElementById('qdp-st-' + id)
  if (st) st.innerHTML = '<span class="mu"><i class="fas fa-spinner fa-spin"></i> 刷新账号池并探测额度…</span>'
  return Promise.all([
    // credits=1：顺便让后端向每个账号探一次额度。Qoder 的额度只有签到会拉（cron 每天两次），
    // 不探的话「额度包明细 / 到期天数」会一直停在最近一次签到时的数据，「7 天内到期优先」
    // 的挑号依据也可能是昨天的。
    fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/status?credits=1').then(r => r.json()),
    fetch('/admin/api/checkin/status').then(r => r.json()).catch(() => null),
  ]).then(res => {
    const d = res[0], cd = res[1]
    if (!d.success) { if (st) showResult(st, false, d.message || '查询失败'); return }
    const pool = (d.data && d.data.pool) || []
    if (st) showResult(st, true, qoderProbeSummary(pool.length, d.data && d.data.quotaProbe))
    // 签到状态按 uid 匹配逐账号明细
    let ciAccounts = []
    if (cd && cd.success && cd.data && Array.isArray(cd.data.workbuddy)) {
      const entry = cd.data.workbuddy.find(function (w) { return w && w.providerId === id })
      if (entry && Array.isArray(entry.accounts)) ciAccounts = entry.accounts
    }
    const ciByUid = {}
    ciAccounts.forEach(function (a, ai) {
      if (!a) return
      if (a.uid) ciByUid[a.uid] = a
      a.__idx = ai
    })
    renderQoderPoolAccounts(id, pool, ciByUid, ciAccounts)
  }).catch(() => { if (st) showResult(st, false, '查询失败') })
}
function renderQoderPoolAccounts(id, accs, ciByUid, ciAccounts) {
  const box = document.getElementById('qdp-acc-' + id)
  if (!box) return
  if (!accs.length) { box.innerHTML = '<p class="mu">账号池为空：点「登录新账号」每授权一个 Qoder 账号即自动加入（可登录多个账号，老单账号会自动迁入）。</p>'; return }
  ciByUid = ciByUid || {}
  ciAccounts = ciAccounts || []
  const idxFallback = ciAccounts.length === accs.length ? ciAccounts : null
  box.innerHTML = accs.map(function(a, i) {
    const isOff = a.disabled || a.enabled === false
    const ci = ciByUid[a.uid] || (idxFallback ? idxFallback[i] : null)
    let ciBadge = ''
    if (ci) {
      ciBadge = ci.success ? ' <span class="bd bd-on">' + (ci.reason === 'already' ? '今日已签' : '签到成功') + '</span>'
        : ' <span class="bd bd-danger">签到失败</span>'
      // 成功时 message 是纯状态文案（如「签到成功」）会与徽章重复，仅失败时展示错误原因
      if (ci.message && !ci.success) ciBadge += ' <span style="color:var(--muted)">' + escapeHtml(ci.message) + '</span>'
    } else {
      ciBadge = ' <span class="bd bd-off">未签</span>'
    }
    let creditLine = ''
    if (ci && (ci.totalRemain !== undefined && ci.totalRemain !== null)) {
      const used = (ci.totalUsed !== undefined && ci.totalUsed !== null) ? ci.totalUsed : '—'
      creditLine = '<div class="mu" style="margin-top:2px">可用 ' + ci.totalRemain + ' · 已用 ' + used + '</div>'
    }
    let line = (a.nickname ? escapeHtml(a.nickname) : 'uid=' + escapeHtml(a.uid)) + ' · 积分=' + (a.credits || 0)
    // 额度包明细：数据源优先池状态（它就是挑号用的那一份，且比签到结果活得久）；
    // 旧 KV 数据 / 尚未签到探测时回退签到结果里的同源快照。
    const pkgs = Array.isArray(a.packages) ? a.packages : (ci && Array.isArray(ci.packages) ? ci.packages : null)
    const expiring7d = wbPackExpiring7d(pkgs)
    line += wbExpiringBadge(pkgs)
    // 冷却状态徽章（常显，与 WorkBuddy 池同款）：禁用（红）> 冷却中（琥珀）> 无冷却（绿）；详情 muted 文字跟随
    const coolBadge = isOff ? '<span class="bd bd-danger">已禁用</span>'
      : (a.cooling ? '<span class="bd bd-warn">冷却中</span>' : '<span class="bd bd-on">无冷却</span>')
    let coolDetail = ''
    if (isOff) coolDetail = a.reason ? '（' + escapeHtml(a.reason) + '）' : ''
    else if (a.cooling && a.until) coolDetail = ' 冷却至 ' + new Date(a.until).toLocaleString() + (a.reason ? '（' + escapeHtml(a.reason) + '）' : '')
    else if (a.reason) coolDetail = '（上次：' + escapeHtml(a.reason) + '）'
    line += ' ' + coolBadge + '<span class="mu">' + coolDetail + '</span>'
    if (a.tokenMask) {
      line += ' · <code class="mu" style="font-size:11px" title="已存储于网关 KV">Token: ' + escapeHtml(a.tokenMask) + '</code>'
    }
    // 额度包折叠表（与 WorkBuddy 池同款结构；Qoder 上游没有「周期结束」概念，故少一列）：
    // 隐藏已用完的包，其余按到期升序（快过期的在最上面），到期时间单元格带「剩 N 天」。
    const pkgDisp = wbPackageDisplayList(pkgs)
    const hiddenPkg = pkgDisp.hidden > 0 ? ' · <span class="mu">已用完 ' + pkgDisp.hidden + ' 个已隐藏</span>' : ''
    let pkgHtml = ''
    if (pkgDisp.rows.length > 0) {
      const aid = 'qdpkg-' + escapeHtml(id) + '-' + i
      const rows = pkgDisp.rows.map(function(p) {
        let qty = '—'
        if (p.size !== undefined && p.size !== null && p.size > 0) {
          const used2 = (p.used !== undefined && p.used !== null) ? p.used : 0
          qty = used2 + ' / ' + p.size + (p.unit ? ' ' + p.unit : '')
        }
        return '<tr><td>' + escapeHtml(p.name) + '</td><td>' + wbPackExpireHtml(p.expireAt) + '</td><td class="numeric">' + qty + '</td></tr>'
      }).join('')
      const pkgHead = '额度包明细（' + pkgDisp.rows.length + '）' + (expiring7d.length > 0 ? ' · <span style="color:var(--color-warn,#d97706)">' + expiring7d.length + ' 个 7 天内到期</span>' : '') + hiddenPkg
      pkgHtml = '<div class="collapse-section" style="margin-top:4px"><button class="collapse-btn" data-pkg="' + aid + '" type="button" aria-expanded="false"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> ' + pkgHead + '</button><div id="' + aid + '" class="hd usage-log-table-wrap"><table class="usage-log-table"><thead><tr><th>名称</th><th>到期时间</th><th>已用/总额度</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
    } else if (pkgDisp.total > 0) {
      pkgHtml = '<div class="mu" style="margin-top:2px">额度包明细：' + pkgDisp.total + ' 个包已全部用完</div>'
    }
    return '<div class="fc mb-2 field-row" style="align-items:flex-start"><div class="fx1" style="font-size:12px;min-width:0"><div>' + line + ' ' + ciBadge + '</div>' + creditLine + pkgHtml + '</div><div class="fc" style="gap:4px"><button class="btn btn-gh btn-xs" onclick="oauthPoolCopyToken(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')" title="复制 Access Token"><i class="fas fa-copy" aria-hidden="true"></i>复制Token</button><button class="btn btn-gh btn-xs" onclick="oauthPoolRemove(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')"><i class="fas fa-trash" aria-hidden="true"></i>移除</button></div></div>'
  }).join('')
  // 绑定额度包折叠按钮（与 WorkBuddy 池相同的 toggleCollapse 交互）
  box.querySelectorAll('[data-pkg]').forEach(function(btn) {
    btn.addEventListener('click', function() { toggleCollapse(btn.getAttribute('data-pkg'), btn) })
  })
}
/** 收集冷却参数（trae / workbuddy 池共用 cd-* 输入）；无输入框返回 undefined，全空返回 null（恢复默认）。 */
function numOrUndef(v) {
  const s = (v == null ? '' : String(v)).trim()
  if (s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function collectCooldown(id) {
  if (!document.getElementById('cd-plan-' + id)) return undefined
  const num = function(prefix, div) {
    const e = document.getElementById(prefix + '-' + id)
    const v = parseFloat((e && e.value || '').trim())
    if (!Number.isFinite(v) || v <= 0) return undefined
    return Math.round(v * div)
  }
  const planMs = num('cd-plan', 60000)
  const softMs = num('cd-soft', 1000)
  const errThreshold = num('cd-err', 1)
  const errMs = num('cd-errms', 60000)
  if (planMs === undefined && softMs === undefined && errThreshold === undefined && errMs === undefined) return null
  return { planMs: planMs, softMs: softMs, errThreshold: errThreshold, errMs: errMs }
}

function oauthConnect(id) {
  const st = document.getElementById('oauth-st-' + id)
  const oauth = collectOauthEdit(id)
  // browser（WorkBuddy）与 qoder（QoderWork 设备授权）都是"跳转登录页授权"的交互：
  // 直接打开登录链接，用户确认后由后台轮询 token，无需输入授权码
  const isBrowser = oauth.flowType === 'browser' || oauth.flowType === 'qoder'
  // gemini（Gemini CLI）/ m365-pkce 是"授权码"交互：后台生成授权链接，用户授权后把回调 URL 粘贴回来
  const isGemini = oauth.flowType === 'gemini'
  const isM365PKCE = oauth.flowType === 'm365-pkce'
  // m365-ropc 是"账号密码"交互：不需要授权链接，直接提交企业账号/密码换 token
  const isM365ROPC = oauth.flowType === 'm365-ropc'
  // gemini/m365 的端点可留空（后端走官方默认端点）
  if (!isGemini && !isM365PKCE && !isM365ROPC && (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl)) {
    st.textContent = '请先填写 OAuth 端点并保存'
    return
  }
  if (isGemini) {
    // 凭据可留空：后端按「表单 → 环境变量 → gemini-cli 公开凭据」顺序兜底，
    // 无需用户填写即可直接用谷歌账号登录（详见 src/oauth.ts geminiClientCreds）
  } else if (isM365ROPC) {
    // ROPC 无需发起授权，直接弹账号密码表单
    st.textContent = '请输入 M365 企业订阅账号与密码'
    showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> M365 账号密码登录（ROPC）</h3><p>请输入拥有 M365 Copilot 订阅的企业账号与密码（仅用于换取 OAuth token，不会存储密码）：</p><p><input type="text" id="m365-ropc-user" placeholder="user@example.com" style="width:100%;box-sizing:border-box"></p><p><input type="password" id="m365-ropc-pass" placeholder="密码" style="width:100%;box-sizing:border-box"></p><p class="oauth-status" id="m365-ropc-st"></p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthSubmitM365ROPC(\\'' + escapeJsAttr(id) + '\\')">登录</button></div>')
    return
  } else if (!isBrowser && !oauth.clientId) {
    st.textContent = '设备码模式需要 Client ID，请填写并保存'
    return
  }
  st.textContent = '发起中…'
  fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { st.textContent = d.message || '发起失败'; return }
    const dev = d.data
    const uri = (dev && dev.verification_uri) || ''
    if (isGemini || isM365PKCE) {
      // 授权码模式：打开授权链接，授权后把地址栏（含 ?code=...&state=...）粘贴回来
      const isM = isM365PKCE
      st.textContent = '请在浏览器中完成授权后粘贴回调 URL'
      showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> ' + (isM ? 'M365' : 'Gemini') + ' OAuth 授权</h3><p>1. 点击下方链接在浏览器中登录并授权（授权后页面会跳转，地址栏里含 <code>?code=...</code>&nbsp;<code>state=...</code>）：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.05em">' + escapeHtml(uri) + '</a></p><p>2. 复制浏览器地址栏的完整回调 URL，粘贴到下方后提交：</p><p><input type="text" id="' + (isM ? 'm365' : 'gemini') + '-cb-url" placeholder="' + (isM ? 'https://login.microsoftonline.com/common/oauth2/nativeclient?code=...&state=...' : 'http://127.0.0.1:8089/oauth2callback?code=...&state=...') + '" style="width:100%;box-sizing:border-box"></p><p class="oauth-status" id="' + (isM ? 'm365' : 'gemini') + '-cb-st"></p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthSubmit' + (isM ? 'M365' : 'Gemini') + '(\\'' + escapeJsAttr(id) + '\\')">提交授权</button></div>')
    } else if (isBrowser) {
      // 浏览器登录模式：显示登录链接，自动轮询
      st.textContent = '请在弹窗中打开登录链接完成授权'
      showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> OAuth 浏览器登录</h3><p>点击下方链接在浏览器中完成登录：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.1em">' + escapeHtml(uri) + '</a></p><p class="oauth-status" id="oauth-poll-st">等待登录完成…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthPoll(\\'' + escapeJsAttr(id) + '\\')">刷新状态</button></div>')
      // 自动轮询（每 3 秒）
      if (window._oauthPollTimer) clearInterval(window._oauthPollTimer)
      window._oauthPollTimer = setInterval(function() {
        const pollSt = document.getElementById('oauth-poll-st')
        if (!pollSt || pollSt.textContent.includes('成功')) { clearInterval(window._oauthPollTimer); return }
        oauthPoll(id)
      }, 3000)
    } else {
      // 设备码模式：显示授权码
      const code = (dev && dev.user_code) || ''
      st.textContent = '请在浏览器打开授权页面并输入授权码'
      showM('<h3><i class="fas fa-mobile-alt c-p" aria-hidden="true"></i> OAuth 授权</h3><p>打开以下链接并输入授权码：</p><p><code style="word-break:break-all">' + escapeHtml(uri) + '</code></p><p>授权码：<strong class="c-p" style="font-size:1.6em;letter-spacing:.2em">' + escapeHtml(code) + '</strong></p><p class="oauth-status" id="oauth-poll-st">等待授权…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthPoll(\\'' + escapeJsAttr(id) + '\\')">刷新状态</button></div>')
    }
  }).catch(() => { st.textContent = '发起失败' })
}

function oauthPoll(id) {
  const pollSt = document.getElementById('oauth-poll-st')
  const st = document.getElementById('oauth-st-' + id)
  if (pollSt) pollSt.textContent = '轮询中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/poll', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.success) {
      if (window._oauthPollTimer) { clearInterval(window._oauthPollTimer); window._oauthPollTimer = null }
      if (pollSt) { pollSt.textContent = '授权成功！正在拉取模型列表…'; setTimeout(closeM, 1200) }
      if (st) st.textContent = '已连接'
      // 登录成功后自动拉取上游真实模型列表（替代写死的预设模型）
      setTimeout(function() { fetchOauthModels(id) }, 1300)
      return true
    }
    if (pollSt) pollSt.textContent = d.message || '等待授权…'
    if (st) st.textContent = d.message || '等待授权…'
    return false
  }).catch(() => { if (pollSt) pollSt.textContent = '轮询失败，请重试' })
}

// ===== Kuku：百度扫码登录（自动抓 Cookie）=====
let _kukuQrTimer = null
function kukuQrLogin(id) {
  const providerId = (id != null && id !== '') ? id : ((document.getElementById('aid') || {}).value || '').trim() || 'kuku'
  if (!providerId) { toast('请先填写提供商 ID', 'error'); return }
  showM('<h3><i class="fas fa-qrcode c-p" aria-hidden="true"></i> Kuku 百度扫码登录</h3><p class="kuku-qr-status" id="kuku-qr-st">正在获取二维码…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button></div>')
  fetch('/admin/api/kuku/' + encodeURIComponent(providerId) + '/qr/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    const st = document.getElementById('kuku-qr-st')
    if (!d.success || !d.data) { if (st) st.textContent = (d.message) || '获取二维码失败'; return }
    if (st) st.innerHTML = '请用手机<strong>百度 App</strong>扫码（App 需已登录目标百度账号）：<br><img src="' + escapeHtml(d.data.imgUrl) + '" alt="登录二维码" style="width:220px;height:220px;border:1px solid #ddd;border-radius:8px"><br><span class="mu">等待扫码确认…</span>'
    if (_kukuQrTimer) clearInterval(_kukuQrTimer)
    _kukuQrTimer = setInterval(function() { kukuQrPoll(providerId) }, 3000)
  }).catch(() => { const st = document.getElementById('kuku-qr-st'); if (st) st.textContent = '获取二维码失败，请重试' })
}
function kukuQrPoll(providerId) {
  return fetch('/admin/api/kuku/' + encodeURIComponent(providerId) + '/qr/poll', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.success) {
      if (_kukuQrTimer) { clearInterval(_kukuQrTimer); _kukuQrTimer = null }
      const st = document.getElementById('kuku-qr-st')
      if (st) st.textContent = '扫码登录成功，Cookie 已写入！'
      if (d.data && d.data.cookie) injectKukuCookie(providerId, d.data.cookie)
      setTimeout(closeM, 1300)
      toast('已获取 Kuku Cookie，请保存', 'success')
      return true
    }
    const st = document.getElementById('kuku-qr-st')
    if (st) st.textContent = d.message || '等待扫码…'
    return false
  }).catch(() => { const st = document.getElementById('kuku-qr-st'); if (st) st.textContent = '轮询失败，请重试' })
}
function injectKukuCookie(providerId, cookie) {
  let inp = document.getElementById('k-' + providerId + '-0')   // 编辑表单已有 Key 行
  if (!inp) inp = document.getElementById('nk-' + providerId)   // 编辑表单新增 Key 输入框
  if (!inp) inp = document.querySelector('#akeys .aki')         // 新增表单
  if (inp) inp.value = cookie
}

// ===== TRAE SOLO 账号池：登录 / 签到 / 模型 / 状态 =====
function traeLogin(id) {
  if (adminSubmitting) return
  const st = document.getElementById('trae-st-' + id)
  if (st) st.textContent = '正在生成登录链接…'
  adminSubmitting = true
  return fetch('/admin/api/trae/' + encodeURIComponent(id) + '/login/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    adminSubmitting = false
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '发起失败'); return }
    const url = d.data.loginUrl
    window.open(url, '_blank')
    showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> TRAE 登录</h3>' +
      '<p>登录链接已在浏览器新标签页打开。若未自动打开，请手动访问：</p>' +
      '<p style="word-break:break-all"><a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(url) + '</a></p>' +
      '<p>完成登录后，<strong>复制浏览器地址栏跳转后的完整链接</strong>（形如 <code>http://127.0.0.1:18080/authorize?refreshToken=...</code>），粘贴到下方：</p>' +
      '<div class="fg"><input type="text" id="trae-cb" placeholder="http://127.0.0.1:18080/authorize?refreshToken=..." style="font-size:12px"></div>' +
      '<div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="traeLoginSubmit(\\'' + escapeJsAttr(id) + '\\')">完成登录</button></div>')
  }).catch(() => { adminSubmitting = false; if (st) showResult(st, false, '网络错误，请重试') })
}
function traeLoginSubmit(id) {
  const inp = document.getElementById('trae-cb')
  const url = (inp && inp.value || '').trim()
  if (!url) { toast('请粘贴回调链接', 'error'); return }
  const st = document.getElementById('trae-st-' + id)
  if (st) st.textContent = '正在换取 Token…'
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/login/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl: url }),
  }).then(r => r.json()).then(d => {
    if (!d.success) { toast(d.message || '登录失败', 'error'); if (st) showResult(st, false, d.message || '登录失败'); return }
    closeM()
    const dd = d.data || {}
    const credTxt = '通用=' + (dd.credits || 0) + ' Work=' + (dd.workCredits !== undefined ? dd.workCredits : 0)
    if (st) showResult(st, true, '登录成功 uid=' + (dd.uid || '') + ' ' + credTxt)
    traeStatus(id)
    setTimeout(function () { reloadAdmin() }, 1500)
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function traeCheckin(id) {
  const st = document.getElementById('trae-st-' + id)
  if (st) { st.textContent = '签到中…'; showSpinner(st) }
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/checkin', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { if (st) showResult(st, false, d.message || '签到失败'); return }
    const results = d.data || []
    if (st) showResult(st, true, '签到完成：' + results.length + ' 个账号')
    traeStatus(id)
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function traeRefreshCredits(id) {
  const st = document.getElementById('trae-st-' + id)
  if (st) { st.textContent = '正在探测通用与 Work 积分…'; showSpinner(st) }
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/credits/refresh', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { if (st) showResult(st, false, d.message || '刷新积分失败'); return }
    const results = d.data || []
    if (st) showResult(st, true, '积分刷新成功：共 ' + results.length + ' 个账号')
    traeStatus(id)
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function traeModels(id) {
  const st = document.getElementById('trae-st-' + id)
  if (st) { st.textContent = '拉取模型中…'; showSpinner(st) }
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/models', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { if (st) showResult(st, false, d.message || '拉取模型失败'); return }
    const entries = (d.data && d.data.data) || []
    showEditModelsList(id, entries)
    const from = (d.data && d.data.from) || 'static'
    if (st) showResult(st, true, '已拉取 ' + entries.length + ' 个模型（' + (from === 'dynamic' ? '动态' : '静态回退') + '），点击 + 添加或直接保存')
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function clineModels(id) {
  // 反馈写到按钮所在结果区（detail-actions 的 tr-<id>），不存在则用网格内的状态点
  const st = document.getElementById('tr-' + id) || document.getElementById('cline-st-' + id)
  if (st) { st.textContent = '同步中…'; showSpinner(st) }
  fetch('/admin/api/providers/' + encodeURIComponent(id) + '/cline-models/sync', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { if (st) showResult(st, false, d.message || '同步失败'); return }
    const entries = (d.data && d.data.data) || []
    showEditModelsList(id, entries)
    const sync = d.data && d.data.sync
    if (st) showResult(st, true, '已同步 ' + entries.length + ' 个模型' + (sync && sync.changed ? '，新增 ' + sync.added.length + ' 个' : '（无新增）'))
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function zcodeModels(id) {
  const st = document.getElementById('tr-' + id)
  if (st) { st.textContent = '拉取模型中…'; showSpinner(st) }
  fetch('/admin/api/providers/' + encodeURIComponent(id) + '/zcode-models/sync', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { if (st) showResult(st, false, d.message || '拉取模型失败'); return }
    const entries = (d.data && d.data.data) || []
    const from = (d.data && d.data.from) || 'dynamic'
    showEditModelsList(id, entries)
    if (st) showResult(st, true, '已拉取 ' + entries.length + ' 个模型（' + (from === 'dynamic' ? '上游动态' : from === 'cache' ? '缓存' : '静态兜底') + '），点击 + 添加或直接保存')
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
/**
 * TRAE 权益包到期时间渲染：
 *  - expireAt 为 0/缺省 → 「长期」（上游 end_time=0 表示不失效）
 *  - 已过期（< now）→ 红色「已过期」+ 原始时刻
 *  - 未过期 → CST 本地时间 + 剩余天数（<7 天标黄，与「7 天内到期优先消耗」的挑号窗口一致）
 * 时间戳口径为 Unix 秒（后端 normalizePackEpoch 已归一化毫秒变体）。
 */
function traePackExpireHtml(expireAt) {
  if (!expireAt || !(expireAt > 0)) return '<span class="mu">长期</span>'
  const d = new Date(expireAt * 1000)
  if (isNaN(d.getTime())) return '<span class="mu">—</span>'
  const txt = d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
  const days = Math.ceil((expireAt * 1000 - Date.now()) / 86400000)
  if (days <= 0) return '<span style="color:var(--color-danger,#ef4444)" title="' + escapeHtml(txt) + '">已过期</span>'
  const color = days <= 7 ? 'var(--color-warn,#d97706)' : 'inherit'
  return '<span style="color:' + color + '" title="' + escapeHtml(txt) + '">' + escapeHtml(txt) + '</span><br><small class="mu">剩 ' + days + ' 天</small>'
}
/**
 * TRAE 积分明细折叠表：逐包展示名称 / 到期时间 / 已用/总额 / 剩余。
 * 按「通用包在前、Work 包在后」分组，组内已由后端按到期时间升序排好。
 * packs 缺省（从未探测）与空数组（探测到 0 个包）语义不同，分别给不同提示。
 */
/**
 * TRAE 积分明细折叠表：逐包展示名称 / 到期时间 / 已用/总额 / 剩余。
 * 已用完的包（limit > 0 且剩余 <= 0）**隐藏不显示**；展示顺序为到期升序（长期有效排最后），
 * 即「快过期的在最上面」——与后端「7 天内到期优先消耗」的挑号顺序一致。
 * 可用/总额仍按**全部**包统计（隐藏不改变账号真实额度），另标注隐藏了几个。
 * packs 缺省（从未探测）与空数组（探测到 0 个包）语义不同，分别给不同提示。
 */
function traePackDetailHtml(uid, packs, packsAt, idx) {
  if (!Array.isArray(packs)) {
    return '<div class="mu" style="margin-top:2px">积分明细：未探测（点「刷新积分」或「全部签到」获取各包到期时间）</div>'
  }
  const totalRem = packs.reduce(function (s, p) { return s + (Number(p.rem) || 0) }, 0)
  const totalLimit = packs.reduce(function (s, p) { return s + (Number(p.limit) || 0) }, 0)
  const expiring = packs.filter(function (p) {
    if (Number(p.rem) <= 0) return false
    if (!p.expireAt || !(p.expireAt > 0)) return false
    const ms = p.expireAt * 1000 - Date.now()
    // 窗口与后端挑号一致（7 天）：徽章上的数字就是"这些包正在被优先消耗"
    return ms > 0 && ms <= 7 * 86400000
  }).length
  const when = packsAt ? new Date(packsAt).toLocaleString() : ''
  if (packs.length === 0) {
    return '<div class="mu" style="margin-top:2px">积分明细：上游未下发权益包' + (when ? '（探测于 ' + escapeHtml(when) + '）' : '') + '</div>'
  }
  const disp = traePackDisplayList(packs)
  if (disp.rows.length === 0) {
    return '<div class="mu" style="margin-top:2px">积分明细：' + disp.total + ' 个包已全部用完' + (when ? '（探测于 ' + escapeHtml(when) + '）' : '') + '</div>'
  }
  const aid = 'traepkg-' + escapeHtml(uid) + '-' + idx
  const rows = disp.rows.map(function (p) {
    const lim = Number(p.limit) || 0
    const used = Number(p.used) || 0
    const rem = Number(p.rem) || 0
    const pct = lim > 0 ? Math.round(used / lim * 100) : 0
    const kind = p.isWork ? '<span class="bd bd-info">Work</span>' : '<span class="bd bd-off">通用</span>'
    return '<tr><td>' + escapeHtml(p.name || '') + ' ' + kind + '</td>' +
      '<td>' + traePackExpireHtml(p.expireAt) + '</td>' +
      '<td class="numeric">' + used + ' / ' + lim + (lim > 0 ? '（' + pct + '%）' : '') + '</td>' +
      '<td class="numeric">' + rem + '</td></tr>'
  }).join('')
  const head = '积分明细（' + disp.rows.length + ' 个包 · 可用 ' + totalRem + ' / 总额 ' + totalLimit + '）' +
    (expiring > 0 ? ' · <span style="color:var(--color-warn,#d97706)">' + expiring + ' 个 7 天内到期</span>' : '') +
    (disp.hidden > 0 ? ' · <span class="mu">已用完 ' + disp.hidden + ' 个已隐藏</span>' : '')
  return '<div class="collapse-section" style="margin-top:4px"><button class="collapse-btn" data-traepkg="' + aid + '" type="button" aria-expanded="false">' +
    '<i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> ' + head + '</button>' +
    '<div id="' + aid + '" class="hd usage-log-table-wrap"><table class="usage-log-table">' +
    '<thead><tr><th>权益包</th><th>到期时间</th><th>已用/总额度</th><th>剩余</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    (when ? '<p class="form-helper">探测于 ' + escapeHtml(when) + '</p>' : '') + '</div></div>'
}
// ===== DeepSeek App token 池（浏览器注入）=====
function deepseekTokenList(id) {
  const st = document.getElementById('ds-st-' + id)
  const box = document.getElementById('ds-list-' + id)
  if (!box) return
  fetch('/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens', { method: 'GET' }).then(r => r.json()).then(d => {
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '状态获取失败'); return }
    if (st) st.textContent = ''
    const sum = d.data.summary || { total: 0, ready: 0, expired: 0, parked: 0 }
    const tokens = d.data.tokens || []
    if (tokens.length === 0) {
      box.innerHTML = '<p class="form-helper">池是空的。按上方步骤取一次 token 注入即可开始使用。</p>'
      return
    }
    const head = '共 ' + sum.total + ' 条：可用 ' + sum.ready + ' / 失效 ' + sum.expired +
      (sum.parked ? ' / <span style="color:var(--color-warn,#d97706)">已停用 ' + sum.parked + '</span>' : '') +
      (d.data.notice ? '　<b>' + escapeHtml(d.data.notice) + '</b>' : '')
    box.innerHTML = '<div class="form-helper">' + head + '</div>' +
      '<div style="max-height:240px;overflow:auto"><table class="usage-log-table" style="margin:0">' +
      '<thead><tr><th>备注</th><th>状态</th><th>尾号</th><th>注入时间</th><th>最近成功</th><th>最近错误</th><th>操作</th></tr></thead><tbody>' +
      tokens.map(function (t) {
        var stateTxt
        if (t.parked && t.park) {
          var kindTxt = { banned: '已封禁', muted: '已禁言', risk: '设备风险' }[t.park.kind] || '已停用'
          var untilTxt = t.park.kind === 'banned' ? '永久' : (t.park.until ? new Date(t.park.until).toLocaleString() + ' 解禁' : '待解禁')
          stateTxt = '<span style="color:var(--color-warn,#d97706)" title="' + escapeHtml(t.park.reason || '') + '">' + kindTxt + '（' + untilTxt + '）</span>'
        } else if (t.state === 'ready') {
          stateTxt = '<span style="color:var(--color-success,#16a34a)">可用</span>'
        } else {
          stateTxt = '<span style="color:var(--color-danger,#ef4444)">已失效</span>'
        }
        const when = function (ms) { return ms ? new Date(ms).toLocaleString() : '-' }
        return '<tr><td>' + escapeHtml(t.label || '-') + '</td><td>' + stateTxt + '</td><td>…' + escapeHtml(t.tokenTail || '') + '</td>' +
          '<td>' + when(t.addedAt) + '</td><td>' + when(t.lastOkAt) + '</td>' +
          '<td title="' + escapeHtml(t.lastError || '') + '">' + escapeHtml(String(t.lastError || '-').slice(0, 40)) + '</td>' +
          '<td><button class="btn btn-s btn-xs" onclick="deepseekTokenVerify(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(t.id) + '\\')">判活</button> ' +
          (t.parked ? '<button class="btn btn-gh btn-xs" onclick="deepseekTokenUnpark(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(t.id) + '\\')" title="清除上游处罚停用状态（封禁为永久停用，只能人工解除）">解除停用</button> ' : '') +
          '<button class="btn btn-gh btn-xs" onclick="deepseekTokenRemove(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(t.id) + '\\')">删除</button></td></tr>'
      }).join('') +
      '</tbody></table></div>'
  }).catch(function () { if (st) showResult(st, false, '请求失败') })
}
function deepseekTokenAdd(id) {
  const st = document.getElementById('ds-st-' + id)
  const tok = document.getElementById('ds-tok-' + id)
  const dev = document.getElementById('ds-dev-' + id)
  const lab = document.getElementById('ds-label-' + id)
  if (!tok || !tok.value.trim()) { if (st) showResult(st, false, '请先粘贴 userToken 的 value'); return }
  if (st) showResult(st, true, '注入并判活中…')
  fetch('/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok.value.trim(), headerDeviceId: dev ? dev.value.trim() : '', label: lab ? lab.value.trim() : '' })
  }).then(r => r.json()).then(d => {
    if (st) showResult(st, !!d.success, d.message || '')
    if (d.success && tok) tok.value = ''
    deepseekTokenList(id)
  }).catch(function () { if (st) showResult(st, false, '请求失败') })
}
function deepseekTokenVerify(id, tokenId) {
  const st = document.getElementById('ds-st-' + id)
  fetch('/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId: tokenId })
  }).then(r => r.json()).then(d => {
    if (st) showResult(st, !!d.success, d.message || '')
    deepseekTokenList(id)
  }).catch(function () { if (st) showResult(st, false, '请求失败') })
}
function deepseekTokenRemove(id, tokenId) {
  const st = document.getElementById('ds-st-' + id)
  fetch('/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId: tokenId })
  }).then(r => r.json()).then(d => {
    if (st) showResult(st, !!d.success, d.message || '')
    deepseekTokenList(id)
  }).catch(function () { if (st) showResult(st, false, '请求失败') })
}
function deepseekTokenUnpark(id, tokenId) {
  const st = document.getElementById('ds-st-' + id)
  fetch('/admin/api/deepseek/' + encodeURIComponent(id) + '/tokens/unpark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId: tokenId })
  }).then(r => r.json()).then(d => {
    if (st) showResult(st, !!d.success, d.message || '')
    deepseekTokenList(id)
  }).catch(function () { if (st) showResult(st, false, '请求失败') })
}
function traeStatus(id) {
  const st = document.getElementById('trae-st-' + id)
  const box = document.getElementById('trae-acc-' + id)
  if (!box) return
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/status', { method: 'GET' }).then(r => r.json()).then(d => {
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '状态获取失败'); return }
    const accs = d.data.accounts || []
    const checkin = d.data.checkin || []
    // 签到记录并入账号表：按 uid 匹配，表格直接显示「今日签到」列，不再单独渲染签到列表
    const ciByUid = {}
    checkin.forEach(function (r) { if (r && r.uid) ciByUid[r.uid] = r })
    if (st) st.textContent = ''
    if (accs.length === 0) {
      box.innerHTML = '<p class="form-helper">暂无账号。点击「登录账号」添加第一个 TRAE 账号。</p>'
    } else {
      const preferUid = d.data.preferTraeUid || ''
      const opts = ['<option value="">自动挑选（按可用积分）</option>'].concat(accs.map(function (a) {
        const sel = a.uid === preferUid ? ' selected' : ''
        return '<option value="' + escapeHtml(a.uid) + '"' + sel + '>' + escapeHtml((a.nickname || a.uid)) + '</option>'
      })).join('')
      const preferBar = '<div class="fc mt-1 field-row" style="align-items:center;gap:8px"><label style="margin:0;white-space:nowrap">首选账号：</label>' +
        '<select id="trae-prefer-' + escapeHtml(id) + '" class="select-sm" style="max-width:320px">' + opts + '</select>' +
        '<button class="btn btn-s btn-xs" onclick="traeSetPrefer(\\'' + escapeJsAttr(id) + '\\')">指定</button>' +
        '<button class="btn btn-gh btn-xs" onclick="traeSetPrefer(\\'' + escapeJsAttr(id) + '\\',\\'\\')">恢复自动</button>' +
        '<span id="trae-prefer-msg-' + escapeHtml(id) + '"></span></div>'
      const ciOk = accs.filter(function (a) { const r = ciByUid[a.uid]; return r && (r.success || r.checkedIn) }).length
      box.innerHTML = preferBar +
        '<div style="max-height:260px;overflow:auto"><table class="usage-log-table" style="margin:0">' +
        '<thead><tr><th>UID</th><th>昵称</th><th>通用积分 (SOLO)</th><th>Work 积分</th><th>今日签到</th><th>通道状态</th><th>冷却至</th><th>操作</th></tr></thead><tbody>' +
        accs.map(function (a, ai) {
          const isDis = a.disabled
          const soloCool = a.cooling
          const workCool = a.workCooling
          let stTxt = '<span style="color:var(--color-success,#16a34a)">正常</span>'
          if (isDis) {
            stTxt = '<span style="color:var(--color-danger,#ef4444)">已禁用</span>'
          } else if (soloCool && workCool) {
            stTxt = '<span style="color:var(--color-warn,#d97706)">双通道冷却</span>'
          } else if (soloCool) {
            stTxt = '<span style="color:var(--color-warn,#d97706)" title="SOLO 冷却，自动降级至 Work 通道">SOLO 冷却 (Work 可用)</span>'
          } else if (workCool) {
            stTxt = '<span style="color:var(--color-warn,#d97706)" title="Work 通道冷却">Work 冷却</span>'
          }

          const untilParts = []
          if (soloCool && a.until) untilParts.push('SOLO: ' + new Date(a.until).toLocaleTimeString())
          if (workCool && a.workUntil) untilParts.push('Work: ' + new Date(a.workUntil).toLocaleTimeString())
          const until = untilParts.join('<br>')

          const reasons = []
          if (a.reason) reasons.push('SOLO: ' + escapeHtml(a.reason))
          if (a.workReason) reasons.push('Work: ' + escapeHtml(a.workReason))
          const reasonHtml = reasons.length ? '<br><small>' + reasons.join('; ') + '</small>' : ''

          const ci = ciByUid[a.uid]
          const ciTxt = !ci ? '<span class="bd bd-off">未签</span>'
            : ci.success ? (ci.checkedIn ? '<span class="bd bd-on">已签到</span>' : '<span class="bd bd-on">成功</span>')
            : '<span class="bd bd-danger">失败</span>'
          const ciTip = ci && ci.message ? ' title="' + escapeHtml(ci.message) + '"' : ''

          const rawSolo = typeof a.credits === 'number' ? a.credits : 0
          const soloCredits = Math.round(rawSolo) === rawSolo ? rawSolo : Number(rawSolo.toFixed(2))
          const hasWork = typeof a.workCredits === 'number'
          const rawWork = hasWork ? a.workCredits : null
          const workVal = hasWork && rawWork !== null ? (Math.round(rawWork) === rawWork ? rawWork : Number(rawWork.toFixed(2))) : '未探测'
          const soloBadge = '<span class="bd ' + (rawSolo > 0 ? 'bd-on' : 'bd-off') + '" title="通用积分 (SOLO 通道): ' + rawSolo + '">' + soloCredits + '</span>'
          const workBadge = '<span class="bd ' + (hasWork && (rawWork || 0) > 0 ? 'bd-on' : 'bd-off') + '" title="' + (hasWork ? 'Work 专属通道可用额度: ' + rawWork : '点击「刷新积分」或「全部签到」探测') + '">' + workVal + '</span>'

          const packDetail = traePackDetailHtml(a.uid, a.packs, a.packsAt, ai)

          return '<tr><td><code>' + escapeHtml(a.uid) + '</code></td><td>' + escapeHtml(a.nickname || '-') + '</td>' +
            '<td>' + soloBadge + '</td><td>' + workBadge + '</td><td' + ciTip + '>' + ciTxt + '</td><td>' + stTxt + reasonHtml + '</td><td>' + until + '</td>' +
            '<td><button class="btn btn-d btn-xs" onclick="traeRemoveAccount(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')">删除</button></td></tr>' +
            '<tr><td colspan="8" style="border-top:none;padding-top:0">' + packDetail + '</td></tr>'
        }).join('') + '</tbody></table></div>' +
        '<p class="form-helper">共 ' + accs.length + ' 个账号；今日已签 ' + ciOk + ' / ' + accs.length + '。「积分明细」展开可见每个权益包的到期时间与用量（<b>已用完的包自动隐藏</b>，其余按到期升序，快过期的在最上面），点「刷新积分」更新。</p>'
    }
    // 绑定积分明细折叠按钮（与 WorkBuddy 池 / 签到区同一 toggleCollapse 交互）
    box.querySelectorAll('[data-traepkg]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleCollapse(btn.getAttribute('data-traepkg'), btn) })
    })
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
}
function traeSetPrefer(id, forcedUid) {
  const sel = document.getElementById('trae-prefer-' + id)
  const msg = document.getElementById('trae-prefer-msg-' + id)
  const uid = (forcedUid !== undefined ? forcedUid : ((sel || {}).value || '')).trim()
  if (msg) msg.textContent = ''
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/account/prefer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: uid }),
  }).then(r => r.json()).then(d => {
    if (!d.success) { if (msg) { msg.textContent = (d.message || '设置失败'); msg.style.color = 'var(--color-danger,#ef4444)' } return }
    if (msg) { msg.textContent = (d.message || '已设置'); msg.style.color = 'var(--color-success,#16a34a)' }
    if (sel) sel.value = uid
    setTimeout(function () { traeStatus(id) }, 800)
  }).catch(() => { if (msg) { msg.textContent = '网络错误，请重试'; msg.style.color = 'var(--color-danger,#ef4444)' } })
}
function traeRemoveAccount(id, uid) {
  cM('确定删除账号 ' + uid + ' 吗？该账号将退出账号池。').then(function (ok) {
    if (!ok) return
    const st = document.getElementById('trae-st-' + id)
    fetch('/admin/api/trae/' + encodeURIComponent(id) + '/account/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: uid }),
    }).then(r => r.json()).then(d => {
      if (!d.success) { if (st) showResult(st, false, d.message || '删除失败'); return }
      if (st) showResult(st, true, d.message || '已删除')
      traeStatus(id)
      setTimeout(function () { reloadAdmin() }, 1200)
    }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
  })
}
// Gemini 授权码模式：提交用户粘贴的回调 URL，后台换 token 并拉取模型
function oauthSubmitGemini(id) {
  const st = document.getElementById('gemini-cb-st')
  const mainSt = document.getElementById('oauth-st-' + id)
  const url = ((document.getElementById('gemini-cb-url') || {}).value || '').trim()
  if (!url) { if (st) st.textContent = '请先粘贴授权后的回调 URL'; return }
  if (st) st.textContent = '提交中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl: url }),
  }).then(r => r.json()).then(d => {
    if (d.success) {
      if (st) st.textContent = '授权成功！正在拉取模型列表…'
      if (mainSt) mainSt.textContent = '已连接'
      setTimeout(closeM, 1200)
      setTimeout(function() { fetchOauthModels(id) }, 1300)
    } else {
      if (st) st.textContent = d.message || '提交失败'
    }
  }).catch(() => { if (st) st.textContent = '提交失败，请重试' })
}

// M365 授权码模式：提交用户粘贴的回调 URL（换 token 逻辑同 gemini，走 /m365-callback）
function oauthSubmitM365(id) {
  const st = document.getElementById('m365-cb-st')
  const mainSt = document.getElementById('oauth-st-' + id)
  const url = ((document.getElementById('m365-cb-url') || {}).value || '').trim()
  if (!url) { if (st) st.textContent = '请先粘贴授权后的回调 URL'; return }
  if (st) st.textContent = '提交中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/m365-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl: url }),
  }).then(r => r.json()).then(d => {
    if (d.success) {
      if (st) st.textContent = '授权成功！正在拉取模型列表…'
      if (mainSt) mainSt.textContent = '已连接'
      setTimeout(closeM, 1200)
      setTimeout(function() { fetchOauthModels(id) }, 1300)
    } else {
      if (st) st.textContent = d.message || '提交失败'
    }
  }).catch(() => { if (st) st.textContent = '提交失败，请重试' })
}

// M365 ROPC 模式：提交账号密码直接登录换 token
function oauthSubmitM365ROPC(id) {
  const st = document.getElementById('m365-ropc-st')
  const mainSt = document.getElementById('oauth-st-' + id)
  const username = ((document.getElementById('m365-ropc-user') || {}).value || '').trim()
  const password = ((document.getElementById('m365-ropc-pass') || {}).value || '')
  if (!username || !password) { if (st) st.textContent = '请输入账号与密码'; return }
  if (st) st.textContent = '登录中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/m365-ropc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, password: password }),
  }).then(r => r.json()).then(d => {
    if (d.success) {
      if (st) st.textContent = '登录成功！正在拉取模型列表…'
      if (mainSt) mainSt.textContent = '已连接'
      setTimeout(closeM, 1200)
      setTimeout(function() { fetchOauthModels(id) }, 1300)
    } else {
      if (st) st.textContent = d.message || '登录失败'
    }
  }).catch(() => { if (st) st.textContent = '登录失败，请重试' })
}

function oauthDisconnect(id) {
  const st = document.getElementById('oauth-st-' + id)
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' }).then(r => r.json()).then(d => {
    st.textContent = d.success ? '已断开' : (d.message || '断开失败')
  }).catch(() => { st.textContent = '断开失败' })
}

// ===== Cline 一键授权（WorkOS 设备码流程，与原项目 cline_oauth.py 一致） =====
// 发起后弹出授权链接 + 设备码，浏览器登录授权后由后台轮询并自动把 refreshToken 存入账号池。
function clineOAuthConnect(id) {
  if (adminSubmitting) return  // 防重复发起（UX3）
  const st = document.getElementById('tr-' + id)
  if (st) st.textContent = '发起中…'
  adminSubmitting = true
  return fetch('/admin/api/cline/oauth/' + encodeURIComponent(id) + '/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '发起失败'); return }
    const dev = d.data
    const uri = dev.verification_uri || ''
    if (st) showResult(st, true, '请在弹窗中打开授权链接完成登录')
    showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> Cline 一键授权</h3><p>用注册 Cline 的账号（Google / GitHub / 邮箱）登录并授权，授权成功后 RefreshToken 会自动加入上方账号列表：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.05em">' + escapeHtml(uri) + '</a></p><p>设备码：<strong class="c-p" style="font-size:1.4em;letter-spacing:.15em">' + escapeHtml(dev.user_code || '') + '</strong></p><p class="oauth-status" id="cline-oauth-poll-st">等待授权…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="clineOAuthPoll(\\'' + escapeJsAttr(id) + '\\')">刷新状态</button></div>')
    // 自动轮询（每 5 秒，WorkOS interval 默认 5s）
    if (window._clineOAuthTimer) clearInterval(window._clineOAuthTimer)
    window._clineOAuthTimer = setInterval(function() {
      const pollSt = document.getElementById('cline-oauth-poll-st')
      if (!pollSt || pollSt.textContent.includes('成功')) { clearInterval(window._clineOAuthTimer); return }
      clineOAuthPoll(id)
    }, 5000)
  }).catch(() => { if (st) showResult(st, false, '发起失败') }).finally(function() { adminSubmitting = false })
}

function clineOAuthPoll(id) {
  const pollSt = document.getElementById('cline-oauth-poll-st')
  const st = document.getElementById('tr-' + id)
  if (pollSt) pollSt.textContent = '轮询中…'
  return fetch('/admin/api/cline/oauth/' + encodeURIComponent(id) + '/poll', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.success) {
      if (window._clineOAuthTimer) { clearInterval(window._clineOAuthTimer); window._clineOAuthTimer = null }
      if (pollSt) { pollSt.textContent = '授权成功！正在刷新账号列表…'; setTimeout(closeM, 1200) }
      if (st) showResult(st, true, '授权成功，RefreshToken 已加入账号池')
      clineMarkStale(id)
      setTimeout(function () { reloadAdmin() }, 1400)
      return true
    }
    if (pollSt) pollSt.textContent = d.message || '等待授权…'
    if (st) st.textContent = d.message || '等待授权…'
    return false
  }).catch(() => { if (pollSt) pollSt.textContent = '轮询失败，请重试' })
}

// ===== Cline 账号检测（refreshToken 有效性 + 关联账号） =====
// 每个 token 换一次 accessToken：徽章=是否仍可用，账号框=上游返回的邮箱（关联不到就手工填）。
// save() 成功与一键授权成功后会把提供商标记为「待检测」，下次展开自动跑一次，避免每次展开都打上游。
function clineMarkStale(id) { window._clineStale = window._clineStale || {}; window._clineStale[id] = true }

/* CLINE_UP_BEGIN */
// —— Cline 上游渠道与固定：纯映射与文案（pages-inline-script.test.ts 抽此块直接断言）——
function clineUpBadge(status) {
  var map = {
    ok: ['bd-on', '可用'],
    limited: ['bd-warn', '限流'],
    bad: ['bd-danger', '不可钉'],
    auth: ['bd-danger', '认证失败'],
    unknown: ['bd-off', '未知'],
  }
  return map[status] || map.unknown
}
function clineUpCostText(count, minGapMs) {
  if (!(count > 0)) return ''
  var sec = Math.round((count * (minGapMs || 800)) / 1000)
  return '将发起 ' + count + ' 次最小请求，约 ' + sec + ' 秒（期间其它 Cline 请求排队）'
}
/**
 * 固定摘要：勾选的渠道 + 模式 + 排序 + 排除数。
 * 排除项**必须**出现在摘要里：exclude 是换算成 only 白名单下发的独立否决清单，摘要是用户
 * 确认「到底存了什么」的唯一回显；漏掉它，用户改完排除会以为没保存上。
 * 与后端同口径：exclude 优先于 upstreams（同时出现以排除为准），所以这里也要先减掉。
 */
function clineUpPinSummary(pin) {
  if (!pin) return ''
  var exc = (pin.exclude || []).filter(Boolean)
  var ups = (pin.upstreams || []).filter(function (u) { return Boolean(u) && exc.indexOf(u) === -1 })
  if (!ups.length && !exc.length && !pin.sort) return ''
  var parts = []
  if (ups.length) {
    parts.push(ups.length === 1 ? ups[0] : (ups[0] + ' 等 ' + ups.length + ' 个'))
    parts.push(pin.pinMode === 'preferred' ? '优先' : '只用这几个')
  } else {
    parts.push('不指定渠道')
  }
  if (exc.length) parts.push('排除 ' + exc.length + ' 个')
  if (pin.sort) parts.push(pin.sort)
  return parts.join(' · ')
}
/**
 * 渠道三态：auto（未指定，网关自选）/ allow（勾选：只用它或优先它）/ deny（永不使用）。
 *
 * 为什么是三态循环而不是每个渠道两排按钮：一行一个模型、一行里十几个渠道，两排按钮会让行高翻倍。
 * 循环点击就地表达，且与源项目口径一致（upstreams 与 exclude 互斥，toggleUp 在两个列表间搬）。
 * 顺序固定 自动 → 勾选 → 排除 → 自动：第一下点出「勾选」是主要用法（挑几个用），
 * 想否决再多点一下即可，两种用法都只差一次点击。
 */
function clineUpState(pin, ch) {
  if (((pin && pin.exclude) || []).indexOf(ch) !== -1) return 'deny'
  if (((pin && pin.upstreams) || []).indexOf(ch) !== -1) return 'allow'
  return 'auto'
}
function clineUpNextState(state) {
  if (state === 'auto') return 'allow'
  if (state === 'allow') return 'deny'
  return 'auto'
}
/**
 * 把一次三态切换写回配置，返回新的 upstreams / exclude 两个数组（不改入参）。
 * 两个列表**互斥**：切换时先把该渠道从两个列表里都摘掉，再放进目标列表——这样
 * 「既勾选又排除」的矛盾配置在 UI 层就不可能产生（后端仍保留 exclude 优先的兜底裁决）。
 */
function clineUpApplyState(pin, ch, next) {
  var ups = ((pin && pin.upstreams) || []).filter(function (u) { return u !== ch })
  var exc = ((pin && pin.exclude) || []).filter(function (u) { return u !== ch })
  if (next === 'allow') ups.push(ch)
  else if (next === 'deny') exc.push(ch)
  return { upstreams: ups, exclude: exc }
}
/**
 * 渠道徽章的状态类与状态文案（面板与测试共读这一处）。
 * orderNo 是勾选序号（1 起）——多选时用户要能看出网关的优先顺序，否则「优先」等于没有顺序。
 */
function clineUpChannelBadge(status, state, orderNo) {
  var b = clineUpBadge(status)
  var cls = b[0] + (state === 'deny' ? ' is-excluded' : (state === 'allow' ? ' is-allowed' : ''))
  var prefix = state === 'deny' ? '✕ ' : (state === 'allow' && orderNo ? orderNo + ' ' : '')
  return [cls, prefix + b[1]]
}
/** 徽章的悬停说明：明确写出当前状态与「再点一下会变成什么」，否则三态循环只能靠试。 */
function clineUpChannelTitle(state, note) {
  var label = { auto: '自动（网关自选）', allow: '勾选（只用/优先）', deny: '永不使用' }
  var next = clineUpNextState(state)
  return '当前：' + label[state] + '。点击改为「' + label[next] + '」' + (note ? ' · ' + note : '')
}
/**
 * 「配了排除但没生效」判定：网关两侧都不认 exclude/ignore 字段（实测被静默忽略），排除只能
 * 结合渠道清单换算成 only 白名单——没有清单就换算不出来，后端会退回网关自动选。
 * 留档有 7 天有效期，过期后排除会悄悄失效，所以面板必须显式标出来，否则用户一直以为排除还在。
 */
function clineUpExcludeUnresolved(pin, probe) {
  var exc = (pin && pin.exclude) || []
  return exc.length > 0 && !((((probe || {}).upstreams) || []).length)
}
/**
 * 「钉住是否真的生效」的结论映射（口径与后端 judgeClinePinVerify 一致）。
 * 五种结论必须一眼可分，尤其是 unknown 与 ok 的区别——**读不到路由信息不等于生效**；
 * 把它显示成"成功"就是把"没验证"伪装成"已验证"，正是这套东西要消灭的东西。
 */
function clineUpVerdict(v) {
  var map = {
    ok: ['bd-on', '生效'],
    fallback: ['bd-warn', '走了兜底'],
    mismatch: ['bd-danger', '未生效'],
    unpinned: ['bd-off', '未配钉住'],
    unknown: ['bd-off', '读不到路由信息'],
  }
  return map[v] || map.unknown
}
/** 结论的说明文案（不含结论标签本身，标签由 clineUpVerdict 给）。 */
function clineUpVerifyText(res) {
  if (!res) return ''
  var when = res.verifiedAt ? new Date(res.verifiedAt).toLocaleTimeString() : ''
  return (res.note || '') + (when ? '（' + when + '）' : '')
}
/**
 * 把 {名字: 次数} 压成「alibaba×10 · baseten×2」，按次数降序，超出 cap 用「等 N 个」收尾。
 * 按次数降序而不是字典序：用户要一眼看出**主走哪个渠道**，字典序会把偶然走一次的排在最前。
 */
function clineUpCountText(counts, cap) {
  var keys = Object.keys(counts || {}).filter(function (k) { return counts[k] > 0 })
  if (!keys.length) return ''
  keys.sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1) })
  var head = keys.slice(0, cap).map(function (k) { return k + '×' + counts[k] })
  if (keys.length > cap) head.push('等 ' + keys.length + ' 个')
  return head.join(' · ')
}
/** 判定计数：标签复用 clineUpVerdict——同一个结论不能有两套叫法（手动验证与流量画像必须同词）。 */
function clineUpVerdictCounts(counts) {
  var order = ['ok', 'fallback', 'mismatch', 'unknown', 'unpinned']
  var out = []
  order.forEach(function (v) {
    var n = (counts || {})[v]
    if (n > 0) out.push(clineUpVerdict(v)[1] + '×' + n)
  })
  return out.join(' · ')
}
/**
 * 真实流量的路由画像（一行）。
 *
 * 读的是与手动「验证钉住」同一个字段（provider_metadata.gateway.routing.finalProvider），
 * 区别是这是**全量**的：手动验证抽样一次，这里每条真实请求都留档。三件事必须一眼可辨：
 *   1. 有没有读到路由信息——routed=0 时**绝不能说成生效**（读不到 = 无法判定）；
 *   2. 实际走了哪些渠道、各多少次（配置生效但该渠道本身挂了，会在这里露出兜底渠道）；
 *   3. 违反白名单的次数由 clineUpTrafficAnomalyText 另起一行标红，不混进这行统计。
 */
function clineUpTrafficText(rec) {
  if (!rec || !(rec.requests > 0)) return ''
  var parts = ['真实流量 ' + rec.requests + ' 次']
  parts.push(rec.routed ? ('读到路由 ' + rec.routed + ' 次') : '没读到路由信息（无法判定）')
  var provs = clineUpCountText(rec.providers, 3)
  if (provs) parts.push('实走 ' + provs)
  var vs = clineUpVerdictCounts(rec.verdicts)
  if (vs) parts.push('判定 ' + vs)
  if (rec.last) {
    parts.push('最近 ' + new Date(rec.last.at).toLocaleTimeString() +
      (rec.last.finalProvider ? ' → ' + rec.last.finalProvider : ''))
  }
  return parts.join(' ｜ ')
}
/**
 * 异常行（红）：实际渠道违反硬约束的次数 + 最近一条原文。
 * 为什么单独一行而不是并进统计：计数只说「未生效×2」，用户还需要**最近一次的具体证据**
 * （实际走了谁、不在哪个白名单里）才能判断是配置写错了还是上游不服从。
 */
function clineUpTrafficAnomalyText(rec) {
  var list = (rec && rec.anomalies) || []
  if (!list.length) return ''
  return '实测未生效 ' + list.length + ' 次，最近一次：' + (list[0].note || '')
}
/* CLINE_UP_END */

/* CLINE_UP_UI_BEGIN */
// —— Cline 上游渠道与固定：面板渲染与即时保存（pages-inline-script.test.ts 用 DOM 替身驱动这一段）——
var _clineUpData = {}
/** 保存中标记 / 保存期间又有改动：并发点击合并成一次「存完再存」，避免后写覆盖先写。 */
var _clineUpSaving = {}
var _clineUpDirty = {}
/** 最近一次保存的 promise：验证钉住前要等它落库（验证的语义是"验收存下来的配置"）。 */
var _clineUpInflight = {}

/**
 * 提供商配置的**全局写队列**（面板的即时保存与详情卡片的「保存更改」共用）。
 *
 * 为什么必须有（2026-10-06 用户报「改完模式再点下面的保存更改，这次改动就丢了」）：
 * /admin/api/providers/:id 的 PUT 在服务端是**整份 providers 数组的读-改-写**
 * （storage.ts updateProvider: getProvidersFresh → merge → setProviders）。同一页面里两次
 * 并发 PUT 会互相覆盖：后写的那次带着先读的旧快照，把对方刚改的字段整块抹掉——典型丢更新。
 * 面板的即时保存与卡片保存写的是同一条记录，所以**必须串行**。
 *
 * 队列按全局而不是按 id：KV 里所有提供商共用同一个 blob，跨提供商的并发 PUT 同样会互相覆盖。
 * 有意不做失败短路：前一次失败也要放行后一次（否则一次网络错误会卡死整条队列）。
 */
var _provWriteTail = Promise.resolve()
function queueProviderWrite(fn) {
  var next = _provWriteTail.then(fn, fn)
  _provWriteTail = next.then(function () {}, function () {})
  return next
}

function clineUpEl(id, name) { return document.getElementById('cu-' + name + '-' + id) }
function clineUpStatus(id, text) { var el = clineUpEl(id, 'st'); if (el) el.textContent = text || '' }
/** 该模型的本地固定配置（渲染与保存的唯一状态源；表格控件都写这里，重渲染不丢改动）。 */
function clineUpPin(id, model) {
  var d = _clineUpData[id]
  if (!d) { d = { models: [], pins: {}, probes: {}, checks: {} }; _clineUpData[id] = d }
  d.pins = d.pins || {}
  if (!d.pins[model]) d.pins[model] = {}
  return d.pins[model]
}
function clineUpPost(id, path, body) {
  return fetch('/admin/api/providers/' + encodeURIComponent(id) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) { return r.json() })
}

function clineUpstreamsLoad(id) {
  clineUpStatus(id, '读取留档中…')
  return fetch('/admin/api/providers/' + encodeURIComponent(id) + '/cline-upstreams')
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d.success) { clineUpStatus(id, '读取失败：' + ((d && d.message) || '未知错误')); return null }
      _clineUpData[id] = d.data
      clineUpstreamsRender(id)
      clineUpStatus(id, d.data.updatedAt ? ('留档时间 ' + new Date(d.data.updatedAt).toLocaleString()) : '还没有留档，点「探测全部渠道」开始')
      return d.data
    })
    .catch(function () { clineUpStatus(id, '网络错误，请重试'); return null })
}

function clineUpstreamsRender(id) {
  var box = clineUpEl(id, 'tb')
  var data = _clineUpData[id]
  if (!box || !data) return
  var models = data.models || []
  if (!models.length) {
    box.innerHTML = '<div class="mu" style="font-size:12px">该提供商还没有配置模型，先点上方「获取模型」并保存。</div>'
    return
  }
  var probes = data.probes || {}
  var checks = data.checks || {}
  var pins = data.pins || {}
  var verifies = data.verifies || {}
  var traffic = data.traffic || {}
  /** 每行的渠道顺序，供事件委托按 (行, 列) 反查渠道名——渠道名拼进选择器不安全。 */
  var badgeRows = []
  var body = models.map(function (m, i) {
    var probe = probes[m] || {}
    var channels = probe.upstreams || []
    var chk = checks[m] || {}
    var pin = pins[m] || {}
    var allowed = (pin.upstreams || []).filter(Boolean)
    var excluded = (pin.exclude || []).filter(Boolean)
    // 已勾选 / 已排除但已从清单消失的渠道也要排进来，否则用户看不见也改不掉它（下架 / 留档过期）
    var badgeList = channels.concat(allowed.concat(excluded).filter(function (c) { return channels.indexOf(c) === -1 }))
    badgeRows.push({ model: m, channels: badgeList })
    var badges = badgeList.length
      ? badgeList.map(function (c, j) {
          var st = clineUpState(pin, c)
          var b = clineUpChannelBadge((chk[c] || {}).status, st, allowed.indexOf(c) + 1)
          var title = clineUpChannelTitle(st, (chk[c] || {}).note || '尚未校验')
          return '<button type="button" class="bd ' + b[0] + '"' +
            ' data-cu-row="' + i + '" data-cu-ch="' + j + '" title="' + escapeHtml(title) + '"' +
            ' aria-pressed="' + (st === 'auto' ? 'false' : 'true') + '">' + escapeHtml(c) + ' · ' + b[1] + '</button>'
        }).join(' ')
      : '<span class="mu">未探测</span>'
    if (badgeList.length && clineUpExcludeUnresolved(pin, probe)) {
      badges += '<div class="mu" style="font-size:11px;color:var(--color-danger)">已配排除但渠道清单缺失 → <b>排除暂未生效</b>，请重新探测</div>'
    }
    // 上次「验证钉住」的结论：重载后仍在（后端落 KV），否则用户每次都要重新验证才看得到
    var vfy = verifies[m]
    if (vfy) {
      var vb = clineUpVerdict(vfy.verdict)
      badges += '<div style="font-size:11px;margin-top:4px"><span class="bd ' + vb[0] + '">' + escapeHtml(vb[1]) + '</span>' +
        ' <span class="mu">' + escapeHtml(clineUpVerifyText(vfy)) + '</span></div>'
    }
    // 真实流量的路由画像：**不需要点任何按钮**，每条真实请求都已留档（手动验证只是抽样一次）
    var tr = traffic[m]
    var trText = clineUpTrafficText(tr)
    if (trText) {
      badges += '<div class="mu" style="font-size:11px;margin-top:4px">' + escapeHtml(trText) + '</div>'
    }
    var trBad = clineUpTrafficAnomalyText(tr)
    if (trBad) {
      badges += '<div style="font-size:11px;margin-top:2px;color:var(--color-danger)">⚠ ' + escapeHtml(trBad) + '</div>'
    }
    var pipe = probe.pipeline && probe.pipeline !== 'unknown' ? probe.pipeline : '—'
    var modeSel = '<select id="cu-md-' + id + '-' + i + '" data-cu-row="' + i + '" aria-label="固定模式">' +
      '<option value="strict"' + ((pin.pinMode || 'strict') === 'strict' ? ' selected' : '') + '>只用勾选的</option>' +
      '<option value="preferred"' + (pin.pinMode === 'preferred' ? ' selected' : '') + '>优先勾选的</option></select>'
    var sortSel = '<select id="cu-so-' + id + '-' + i + '" data-cu-row="' + i + '" aria-label="渠道排序">' +
      '<option value=""' + (!pin.sort ? ' selected' : '') + '>默认</option>' +
      '<option value="cost"' + (pin.sort === 'cost' ? ' selected' : '') + '>成本</option>' +
      '<option value="ttft"' + (pin.sort === 'ttft' ? ' selected' : '') + '>首字</option>' +
      '<option value="tps"' + (pin.sort === 'tps' ? ' selected' : '') + '>吞吐</option></select>'
    return '<tr><td class="cell-fit">' + escapeHtml(m) + '<div class="mu" style="font-size:11px">管道 ' + escapeHtml(pipe) + '</div></td>' +
      '<td style="white-space:normal">' + badges + '</td>' +
      '<td class="cell-fit">' + modeSel + '</td>' +
      '<td class="cell-fit">' + sortSel + '</td>' +
      '<td class="cell-fit"><button class="btn btn-gh btn-xs" data-cu-probe="' + i + '" title="重新探测该模型的渠道清单"><i class="fas fa-satellite-dish"></i></button>' +
      '<button class="btn btn-gh btn-xs" data-cu-check="' + i + '" title="实测该模型全部渠道的可用性"><i class="fas fa-vial"></i></button>' +
      '<button class="btn btn-gh btn-xs" data-cu-verify="' + i + '" title="验证钉住是否真的生效：发 1 次最小真实请求，读回上游实际走的渠道"><i class="fas fa-shield-halved"></i></button></td></tr>'
  }).join('')
  box.innerHTML = '<div style="max-height:320px;overflow:auto"><table class="tbl"><thead><tr>' +
    '<th>模型</th><th>渠道（点徽章切换：勾选 → 排除 → 自动）</th><th>模式</th><th>排序</th><th>操作</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>'
  // 行内控件用事件委托：模型 ID 含 / 与 . 拼进 onclick 会破坏选择器
  Array.prototype.forEach.call(box.querySelectorAll('[data-cu-probe]'), function (btn) {
    btn.onclick = function () { clineUpstreamsProbeOne(id, models[Number(btn.getAttribute('data-cu-probe'))]) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-cu-check]'), function (btn) {
    btn.onclick = function () { clineUpstreamsValidateOne(id, models[Number(btn.getAttribute('data-cu-check'))]) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-cu-verify]'), function (btn) {
    btn.onclick = function () { clineUpstreamsVerifyOne(id, models[Number(btn.getAttribute('data-cu-verify'))]) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-cu-ch]'), function (btn) {
    btn.onclick = function () {
      var row = badgeRows[Number(btn.getAttribute('data-cu-row'))]
      if (!row) return
      var ch = row.channels[Number(btn.getAttribute('data-cu-ch'))]
      if (!ch) return
      var p = clineUpPin(id, row.model)
      var applied = clineUpApplyState(p, ch, clineUpNextState(clineUpState(p, ch)))
      p.upstreams = applied.upstreams
      p.exclude = applied.exclude
      clineUpstreamsRender(id)
      // 即时保存：面板不设「保存」这一步，就没有「改了没存上」这种状态可言
      clineUpstreamsSave(id)
    }
  })
  // 两个下拉同样即时保存。改完不重渲染，避免刚点开的下拉失去焦点。
  Array.prototype.forEach.call(box.querySelectorAll('select[id^="cu-md-"]'), function (sel) {
    sel.onchange = function () {
      var m = models[Number(sel.getAttribute('data-cu-row'))]
      if (!m) return
      clineUpPin(id, m).pinMode = sel.value
      clineUpstreamsSave(id)
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('select[id^="cu-so-"]'), function (sel) {
    sel.onchange = function () {
      var m = models[Number(sel.getAttribute('data-cu-row'))]
      if (!m) return
      var p = clineUpPin(id, m)
      if (sel.value) p.sort = sel.value
      else delete p.sort
      clineUpstreamsSave(id)
    }
  })
}

function clineUpstreamsProbeOne(id, model) {
  if (!model) return Promise.resolve()
  clineUpStatus(id, '探测中：' + model)
  return clineUpPost(id, '/cline-upstreams/probe', { model: model }).then(function (d) {
    if (!d.success) { clineUpStatus(id, '探测失败：' + ((d && d.message) || '未知错误')); return }
    var cur = _clineUpData[id] || { models: [], pins: {}, probes: {}, checks: {} }
    cur.probes = cur.probes || {}
    cur.probes[model] = d.data
    _clineUpData[id] = cur
    clineUpstreamsRender(id)
    var n = (d.data.upstreams || []).length
    clineUpStatus(id, model + '：' + n + ' 个渠道' + (d.data.ok ? '' : ('（' + (d.data.note || '未拿到清单') + '）')))
  }).catch(function () { clineUpStatus(id, '网络错误，请重试') })
}

function clineUpstreamsProbeAll(id) {
  function run() {
    var data = _clineUpData[id] || {}
    var models = data.models || []
    var i = 0
    function step() {
      if (i >= models.length) { clineUpStatus(id, '探测完成：' + models.length + ' 个模型'); return Promise.resolve() }
      var m = models[i]
      clineUpStatus(id, '探测中 ' + (i + 1) + '/' + models.length + '：' + m)
      return clineUpPost(id, '/cline-upstreams/probe', { model: m }).then(function (d) {
        if (d && d.success) {
          var cur = _clineUpData[id] || { models: [], pins: {}, probes: {}, checks: {} }
          cur.probes = cur.probes || {}
          cur.probes[m] = d.data
          _clineUpData[id] = cur
          clineUpstreamsRender(id)
        }
      }).catch(function () {}).then(function () { i++; return step() })
    }
    return step()
  }
  // 先确保拿到模型列表与固定设置（GET 不打上游）
  if (!_clineUpData[id]) return clineUpstreamsLoad(id).then(run)
  return run()
}

function _clineUpValidate(id, model, skipConfirm) {
  var data = _clineUpData[id] || {}
  var channels = ((data.probes || {})[model] || {}).upstreams || []
  if (!channels.length) { clineUpStatus(id, '请先探测渠道清单'); return Promise.resolve() }
  if (!skipConfirm && typeof confirm === 'function' && !confirm('校验 ' + model + '：' + clineUpCostText(channels.length, data.minGapMs) + '。继续？')) return Promise.resolve()
  clineUpStatus(id, '校验中：' + model + '（' + channels.length + ' 个渠道）')
  return clineUpPost(id, '/cline-upstreams/validate', { model: model }).then(function (d) {
    if (!d.success) { clineUpStatus(id, '校验失败：' + ((d && d.message) || '未知错误')); return }
    var cur = _clineUpData[id] || { models: [], pins: {}, probes: {}, checks: {} }
    cur.checks = cur.checks || {}
    var byCh = {}
    ;(d.data.checks || []).forEach(function (x) { byCh[x.upstream] = x })
    cur.checks[model] = byCh
    _clineUpData[id] = cur
    clineUpstreamsRender(id)
    clineUpStatus(id, model + '：' + (d.data.summary || ''))
  }).catch(function () { clineUpStatus(id, '网络错误，请重试') })
}

function clineUpstreamsValidateOne(id, model) { return _clineUpValidate(id, model, false) }

function clineUpstreamsValidateAll(id) {
  function run() {
    var data = _clineUpData[id] || {}
    var models = (data.models || []).filter(function (m) { return (((data.probes || {})[m] || {}).upstreams || []).length > 0 })
    if (!models.length) { clineUpStatus(id, '还没有渠道清单，请先点「探测全部渠道」'); return Promise.resolve() }
    var total = models.reduce(function (s, m) { return s + ((data.probes[m].upstreams || []).length) }, 0)
    if (typeof confirm === 'function' && !confirm('校验 ' + models.length + ' 个模型的全部渠道：' + clineUpCostText(total, data.minGapMs) + '。继续？')) return Promise.resolve()
    var i = 0
    function step() {
      if (i >= models.length) { clineUpStatus(id, '校验完成：' + models.length + ' 个模型'); return Promise.resolve() }
      return _clineUpValidate(id, models[i], true).then(function () { i++; return step() })
    }
    return step()
  }
  if (!_clineUpData[id]) return clineUpstreamsLoad(id).then(run)
  return run()
}

/**
 * 保存：把本地 pins 整表提交（clinePinByModel 是**整表替换**语义），成功后**用服务端返回的
 * 归一结果回渲染**。
 *
 * 为什么必须回渲染（2026-10-06 用户反馈「模式/排序/排除保存后不生效」）：原实现保存成功后只更新
 * 内存、不重渲染，于是「面板上看到的」与「服务端存下来的」可以不一致——用户以为自己存了，
 * 重进一看全变回去了。回渲染让面板立刻显示**真正存下来的东西**，归一化丢弃（或保留）什么一眼可见。
 *
 * 为什么改动即时保存、不设「保存」这一步：批式保存要求用户记得点，而任何一次漏点/请求被中断
 * 都表现为「保存不生效」，用户无从判断。即时保存把这一类状态整个消掉（源项目也是即时保存）。
 * 并发点击用 in-flight 标记合并：保存中再有改动只置脏位，完成后自动再存一次，不会互相覆盖。
 */
function clineUpstreamsSave(id) {
  if (_clineUpSaving[id]) { _clineUpDirty[id] = true; return Promise.resolve() }
  var data = _clineUpData[id] || {}
  var models = data.models || []
  var map = {}
  models.forEach(function (m) {
    var p = (data.pins || {})[m] || {}
    var ups = (p.upstreams || []).filter(Boolean)
    var exc = (p.exclude || []).filter(Boolean)
    var cfg = {}
    if (ups.length) {
      cfg.upstreams = ups
      cfg.pinMode = p.pinMode === 'preferred' ? 'preferred' : 'strict'
    }
    if (exc.length) cfg.exclude = exc
    if (p.sort) cfg.sort = p.sort
    if (ups.length || exc.length || cfg.sort) map[m] = cfg
  })
  _clineUpSaving[id] = true
  clineUpStatus(id, '保存中…')
  // 走全局写队列：详情卡片的「保存更改」写同一条记录，并发会让这次改动被旧快照抹掉
  var run = queueProviderWrite(function () {
    return fetch('/admin/api/providers/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clinePinByModel: map }),
    }).then(function (r) { return r.json() }).then(function (d) {
      if (!d || !d.success) {
        clineUpStatus(id, '保存失败：' + ((d && d.message) || '未知错误') + '（改动未存，请重试）')
        return false
      }
      var cur = _clineUpData[id] || data
      cur.pins = (d.data && d.data.clinePinByModel) || {}
      _clineUpData[id] = cur
      clineUpstreamsRender(id)
      var n = Object.keys(cur.pins).length
      clineUpStatus(id, n ? ('已保存 ' + n + ' 个模型的渠道设置') : '已保存：全部回到网关自动选')
      return true
    }).catch(function () {
      clineUpStatus(id, '网络错误，改动未存（请重试）')
      return false
    })
  }).then(function (ok) {
    _clineUpSaving[id] = false
    if (_clineUpDirty[id]) { _clineUpDirty[id] = false; return clineUpstreamsSave(id) }
    return ok
  })
  _clineUpInflight[id] = run
  return run
}

/**
 * 验证「已保存的钉住配置」是否真的生效：发 1 次最小真实请求，由后端读回上游实际渠道再判定。
 *
 * 为什么必须有这一步：出站偏好是网关自己拼的，[cline-pin] 日志只能证明**我们发出去了**；
 * 规划器管道会静默丢弃顶层 provider.only（照常 200 出流、不报错），所以"没报错"不是证据。
 * 唯一硬证据是响应里的路由元数据——面板上这一行就是把它变成可读的结论。
 */
function clineUpstreamsVerifyOne(id, model) {
  var data = _clineUpData[id] || {}
  var pin = (data.pins || {})[model]
  if (!pin || (!(pin.upstreams || []).length && !(pin.exclude || []).length && !pin.sort)) {
    clineUpStatus(id, '该模型还没配钉住：先在渠道徽章上勾选（或排除）再验证')
    return Promise.resolve()
  }
  function fire() {
    clineUpStatus(id, '验证中：' + model + '（发 1 次最小真实请求）')
    return clineUpPost(id, '/cline-upstreams/verify', { model: model }).then(function (d) {
      if (!d || !d.success) { clineUpStatus(id, '验证失败：' + ((d && d.message) || '未知错误')); return }
      var cur = _clineUpData[id] || { models: [], pins: {}, probes: {}, checks: {}, verifies: {} }
      cur.verifies = cur.verifies || {}
      cur.verifies[model] = d.data
      _clineUpData[id] = cur
      clineUpstreamsRender(id)
      clineUpStatus(id, model + '：' + clineUpVerdict(d.data.verdict)[1] + '——' + (d.data.note || ''))
    }).catch(function () { clineUpStatus(id, '网络错误，请重试') })
  }
  // 正在保存就先等它落库，否则验的是"上一次存下来的配置"，结论没有意义
  return Promise.resolve(_clineUpInflight[id]).then(fire)
}

/** 逐个验证**已配钉住**的模型（没配钉住的模型发了也是白花一次请求）。 */
function clineUpstreamsVerifyAll(id) {
  function run() {
    var data = _clineUpData[id] || {}
    var pins = data.pins || {}
    var targets = (data.models || []).filter(function (m) {
      var p = pins[m] || {}
      return (p.upstreams || []).length || (p.exclude || []).length || p.sort
    })
    if (!targets.length) {
      clineUpStatus(id, '还没有任何模型配了钉住/排除，先在渠道徽章上勾选')
      return Promise.resolve()
    }
    if (typeof confirm === 'function' &&
        !confirm('验证 ' + targets.length + ' 个已配钉住的模型：' + clineUpCostText(targets.length, data.minGapMs) +
                 '。每次会读回上游实际渠道，消耗少量 token。继续？')) return Promise.resolve()
    var i = 0
    var tally = {}
    function step() {
      if (i >= targets.length) {
        var parts = Object.keys(tally).map(function (k) { return clineUpVerdict(k)[1] + ' ' + tally[k] })
        clineUpStatus(id, '验证完成：' + (parts.length ? parts.join('，') : '无结果'))
        return Promise.resolve()
      }
      var m = targets[i]
      return clineUpstreamsVerifyOne(id, m).then(function () {
        var v = ((_clineUpData[id] || {}).verifies || {})[m]
        if (v) tally[v.verdict] = (tally[v.verdict] || 0) + 1
        i++
        return step()
      })
    }
    return step()
  }
  if (!_clineUpData[id]) return clineUpstreamsLoad(id).then(run)
  return run()
}

/**
 * 批量操作（源项目也有「全选优先 / 清空」）：十几个渠道逐个点太累。
 * 全选按**可用状态**排序（可用 → 限流 → 未知 → 不可用），这样顺序本身就是一份推荐优先级。
 */
function clineUpstreamsBulk(id, mode) {
  var data = _clineUpData[id] || {}
  var models = data.models || []
  var probes = data.probes || {}
  var checks = data.checks || {}
  var rank = { ok: 0, limited: 1, unknown: 2, bad: 3, auth: 4 }
  models.forEach(function (m) {
    var p = clineUpPin(id, m)
    if (mode === 'clear') { p.upstreams = []; p.exclude = []; return }
    var chk = checks[m] || {}
    var chs = ((probes[m] || {}).upstreams || []).slice()
    chs.sort(function (a, b) {
      var ra = rank[(chk[a] || {}).status]
      var rb = rank[(chk[b] || {}).status]
      return (ra === undefined ? 2 : ra) - (rb === undefined ? 2 : rb)
    })
    p.upstreams = chs
    p.exclude = []
  })
  clineUpstreamsRender(id)
  clineUpstreamsSave(id)
}
/**
 * 画一行账号的运行状态徽章。两个数据源共用（检测端点与只读留档端点），画法只有一处实现。
 *
 * 优先级：已禁用 > 冷却。禁用是页面上的本地事实，即使在冷却也先说禁用——那才是它不参与转发的原因。
 * 颜色：额度耗尽/余额不足/凭据失效 = 红（这个号现在真的不可用）；限流/推理空转 = 琥珀（多为短时）。
 */
function clinePaintRunBadge(id, a) {
  var rb = document.getElementById('krun-' + id + '-' + a.index)
  if (!rb) return
  var sl = a.stateLabel || ''
  if (!a.enabled) {
    rb.textContent = sl ? '已禁用 · ' + sl : '已禁用'
    rb.className = 'bd bd-off'
    rb.title = (sl ? (a.stateTitle || '') + ' ｜ ' : '') + '该密钥已禁用，不参与转发'
    rb.style.display = ''
  } else if (a.cooling && sl) {
    rb.textContent = sl
    var hard = a.stateKind === 'quota_empty' || a.stateKind === 'plan_exhausted' || a.stateKind === 'auth'
    rb.className = 'bd ' + (hard ? 'bd-danger' : 'bd-warn')
    rb.title = a.stateTitle || ''
    rb.style.display = ''
  } else {
    rb.textContent = ''
    rb.style.display = 'none'
  }
}

/**
 * 冷却「到点自动重取一次」的调度器（同一 key 只保留一个定时器）。
 *
 * 为什么需要：冷却剩余时长是**服务端在响应那一刻**算出来的（见 clineLoadStates /
 * oauthPoolStatus）。页面不重取，那个数就永远停在当时——用户会看到「冷却 52s」挂一小时
 * 一动不动，或冷却早已结束、面板还写着「冷却中」。
 *
 * 为什么不在客户端倒计时：剩余时长与文案的唯一真源在服务端。客户端一旦自己算，两端口径
 * 迟早分叉（这正是「面板谎报账号健康」的成因）。所以客户端只做一件事：按服务端给的
 * remainingMs **睡到点，再读一次**。
 *
 * 为什么 clamp 到 30 分钟一轮：402 的冷却可以长达 12h，睡 12h 的定时器没有意义（页面早就
 * 重载或关掉了）。醒来若仍在冷却，会再排一轮，效果等价、不留长命定时器。
 *
 * 同一 key 先清旧定时器：卡片反复展开/点刷新会重复调用，不清理就会堆积多个重取。
 */
function coolRefreshSchedule(key, ms, fn) {
  if (!(ms > 0) || typeof setTimeout !== 'function') return
  var timers = window._coolTimers || (window._coolTimers = {})
  if (timers[key] && typeof clearTimeout === 'function') clearTimeout(timers[key])
  timers[key] = setTimeout(function () {
    delete timers[key]
    fn()
  }, Math.min(ms, 30 * 60 * 1000) + 1000)
}

/**
 * 只读冷却/额度留档（不打上游）：展开 Cline 卡片时调用。
 *
 * 为什么不复用那个会逐个换 token 的按钮：它给每个 refreshToken 换一次 accessToken（有副作用的探测），
 * 而「看一眼这个号是不是额度耗尽被冷却了」不该付这个代价，也不该等用户先想到去点它。
 *
 * 读完后在按钮旁写一行结果（含时刻）。**这行不是装饰**：没有它时，「读取成功但没有冷却记录」与
 * 「压根没读取/读取失败」在界面上长得一模一样——2026-10-02 用户报「没看到徽章」时正是分不清这两者。
 */
function clineLoadStates(id) {
  return fetch('/admin/api/providers/' + encodeURIComponent(id) + '/cline-account-states')
    .then(function (r) { return r.json() })
    .then(function (d) {
      var st = document.getElementById('cline-chk-' + id)
      if (!d || !d.success) {
        if (st) st.textContent = '冷却留档读取失败：' + ((d && d.message) || '未知错误')
        return false
      }
      var accs = (d.data && d.data.accounts) || []
      accs.forEach(function (a) { clinePaintRunBadge(id, a) })
      var cooling = accs.filter(function (a) { return a.cooling }).length
      if (st) {
        st.textContent = '冷却留档已读取（' + new Date().toLocaleTimeString() + '）' +
          (cooling ? ' · 冷却中 ' + cooling : ' · 未记录到冷却')
      }
      // 冷却到点自动重取一次：剩余时长是服务端按响应时刻算的，不重取就会一直挂在界面上。
      // 取最早到期的那个（多个号冷却时，先醒来看第一个到期的）。
      var soonest = 0
      accs.forEach(function (a) {
        if (a.cooling && a.remainingMs > 0 && (soonest === 0 || a.remainingMs < soonest)) soonest = a.remainingMs
      })
      coolRefreshSchedule('cline:' + id, soonest, function () { clineLoadStates(id) })
      return true
    })
    .catch(function () {
      var st = document.getElementById('cline-chk-' + id)
      if (st) st.textContent = '冷却留档读取失败：网络错误'
      return false
    })
}

/**
 * 卡片展开（手动点击或刷新后恢复展开态）后该做的加载动作——**两条路径共用这一个入口**。
 *
 * 为什么必须共用：恢复展开态原本只加载 M365/TRAE/Qoder/WorkBuddy 的池子，Cline 不在其列，
 * 于是「刷新页面 → 卡片本来就是开的」这条最常见的路径下什么都没加载，用户看不到徽章
 * （2026-10-02 实测报障）。把决策收进一个函数，两条路径就不可能再各自漏掉一半。
 */
function clineOnCardOpen(id) {
  if (!document.getElementById('cline-chk-' + id)) return false
  if ((window._clineStale || {})[id]) { clineCheckAccounts(id, { silent: true }); return true }
  clineLoadStates(id)
  return true
}

function clineCheckAccounts(id, opts) {
  const silent = !!(opts && opts.silent)
  const st = document.getElementById('cline-chk-' + id)
  if (st) st.textContent = '检测中…'
  const rows = Array.prototype.slice.call(document.querySelectorAll('#keys-' + id + ' [data-kidx]'))
  rows.forEach(function (item) {
    const b = document.getElementById('kst-' + id + '-' + item.dataset.kidx)
    if (b && b.textContent !== '待保存') { b.textContent = '检测中…'; b.className = 'bd bd-info' }
  })
  return fetch('/admin/api/providers/' + encodeURIComponent(id) + '/cline-accounts/check', { method: 'POST' })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d.success) {
        if (st) st.textContent = '检测失败：' + ((d && d.message) || '未知错误')
        if (!silent) toast('检测失败：' + ((d && d.message) || '未知错误'), 'error')
        return false
      }
      const accs = (d.data && d.data.accounts) || []
      accs.forEach(function (a) {
        var b = document.getElementById('kst-' + id + '-' + a.index)
        if (b) {
          b.textContent = a.valid ? '有效' : '无效'
          b.className = 'bd ' + (a.valid ? 'bd-on' : 'bd-danger')
          b.title = (a.masked || '') + ' · ' + (a.message || '')
        }
        var m = document.getElementById('kmsg-' + id + '-' + a.index)
        if (m) {
          var src = a.labelSource === 'none' ? '未关联到账号，可手工填写账号名'
            : a.labelSource === 'auto' ? '已自动关联邮箱' : '手工填写的账号名'
          m.textContent = src
        }
        // 运行状态徽章：冷却（额度耗尽/限流/凭据失效）优先于"有效"——一个 token 有效但被冷却的
        // 账号同样不能转发，而 kst- 徽章只会显示"有效"，看不出这件事。
        clinePaintRunBadge(id, a)
        // 只在账号框为空时自动回填邮箱；用户手填的名字绝不被覆盖
        var lbl = document.getElementById('klbl-' + id + '-' + a.index)
        if (lbl && !lbl.value.trim() && a.label) lbl.value = a.label
      })
      if (st) st.textContent = ((d.data && d.data.summary) || '') + ' · ' + new Date().toLocaleTimeString()
      // 检测结果里若含冷却，同样排一次「到点重取」——否则点完检测看到的「冷却 52s」
      // 又会一直挂着不动（与展开卡片路径同一口径，只是数据来源换成了检测端点）。
      var soonestChk = 0
      accs.forEach(function (a) {
        if (a.cooling && a.remainingMs > 0 && (soonestChk === 0 || a.remainingMs < soonestChk)) soonestChk = a.remainingMs
      })
      coolRefreshSchedule('cline:' + id, soonestChk, function () { clineLoadStates(id) })
      window._clineStale = window._clineStale || {}
      window._clineStale[id] = false
      return true
    })
    .catch(function (e) {
      if (st) st.textContent = '检测失败：' + ((e && e.message) || '网络错误')
      if (!silent) toast('检测失败', 'error')
      return false
    })
}

// 账号名手工维护：失焦即存（空串=清除），避免用户为改名先点保存
function clineSaveLabel(id, idx) {
  var el = document.getElementById('klbl-' + id + '-' + idx)
  if (!el) return
  var m = document.getElementById('kmsg-' + id + '-' + idx)
  fetch('/admin/api/providers/' + encodeURIComponent(id) + '/cline-accounts/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: parseInt(idx, 10), label: el.value.trim() })
  }).then(function (r) { return r.json() })
    .then(function (d) {
      if (!d.success) { if (m) m.textContent = '账号名保存失败：' + (d.message || '未知错误'); return }
      if (m) m.textContent = el.value.trim() ? '手工填写的账号名（已保存）' : '未关联到账号，可手工填写账号名'
    })
    .catch(function () { if (m) m.textContent = '账号名保存失败：网络错误' })
}
/* CLINE_UP_UI_END */

// OAuth 提供商：用 KV 中的 token 拉取上游模型列表，动态填入编辑表单
async function fetchOauthModels(id) {
  const tr = document.getElementById('tr-' + id)
  if (tr) showSpinner(tr)
  const st = document.getElementById('oauth-st-' + id)
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/models', { method: 'POST' })
    const d = await r.json()
    if (d.success && d.data && d.data.data) {
      showEditModelsList(id, d.data.data || [])
      if (tr) showResult(tr, true, '已拉取 ' + (d.data.data.length || 0) + ' 个模型，点击 + 添加到下方')
      if (st) st.textContent = '已拉取 ' + (d.data.data.length || 0) + ' 个模型'
    } else {
      const msg = d.message || '拉取模型失败'
      // 拼接调试信息
      let debugInfo = ''
      if (d.data) {
        const dbg = d.data.debug || d.data
        const NL = String.fromCharCode(10)
        debugInfo = NL + NL + '--- 调试信息 ---' + NL
        if (dbg.realm) debugInfo += 'Token 域: ' + dbg.realm + NL
        if (dbg.tokenHeader) debugInfo += '认证头: ' + dbg.tokenHeader + (dbg.tokenHeaderPrefix && dbg.tokenHeaderPrefix !== '（前缀值不打印）' ? ' ' + dbg.tokenHeaderPrefix + '<token>' : ' <token>') + NL
        debugInfo += '有 Cookie: ' + (dbg.hasCookies ? '是' : '否') + NL
        if (dbg.modelsUrl) debugInfo += '模型 URL: ' + dbg.modelsUrl + NL
        if (dbg.requestUrl) debugInfo += '请求 URL: ' + dbg.requestUrl + NL
        if (dbg.requestHeaders) debugInfo += '请求头: ' + JSON.stringify(dbg.requestHeaders, null, 2) + NL
        if (dbg.tokenExpiresAt) debugInfo += 'Token 过期: ' + dbg.tokenExpiresAt + NL
        if (d.data.allErrors) debugInfo += '所有错误: ' + JSON.stringify(d.data.allErrors) + NL
      }
      // UX7：showResult 内部已 escapeHtml，这里不再预转义，避免双重转义显示 &amp;lt;
      if (tr) showResult(tr, false, msg + debugInfo)
      if (st) st.textContent = msg
    }
  } catch (e) {
    console.error('fetchOauthModels error:', e)
    if (tr) showResult(tr, false, '请求失败: ' + (e.message || '未知错误'))
    if (st) st.textContent = '拉取失败'
  }
}

// Gemini（Antigravity 链路）账号额度：订阅档位 + 5h/周窗口摘要 + 按模型剩余
async function geminiQuota(id, force) {
  const out = document.getElementById('gquota-out-' + id)
  const tier = document.getElementById('gquota-tier-' + id)
  if (!out) return
  out.textContent = '查询中…'
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/gemini-quota' + (force ? '?force=1' : ''))
    const d = await r.json()
    if (!d.success) {
      out.textContent = d.message || '查询失败'
      return
    }
    const q = d.data || {}
    if (tier) tier.textContent = q.subscriptionTier ? ('订阅档位: ' + q.subscriptionTier + (q.email ? ' · ' + q.email : '')) : ''
    const NL = String.fromCharCode(10)
    let html = ''
    const pct = v => (typeof v === 'number' ? Math.round(v) : 0)
    // 分组摘要：5h 窗口 + 周窗口（retrieveUserQuotaSummary）
    if (q.groups && q.groups.length > 0) {
      q.groups.forEach(function (g) {
        html += '<div style="margin:6px 0 2px;font-weight:600;">' + escapeHtml(g.displayName || '配额分组') + '</div>'
        ;(g.buckets || []).forEach(function (b) {
          const p = pct(b.remainingPercent)
          const label = (b.window === '5h' ? '5 小时窗口' : b.window === 'weekly' ? '周窗口' : (b.window || b.bucketId || '窗口'))
          const color = p >= 50 ? '#22c55e' : p >= 20 ? '#eab308' : '#ef4444'
          const reset = b.resetTime ? '（' + new Date(b.resetTime).toLocaleString() + ' 重置）' : ''
          html += '<div style="margin:2px 0;">' + label + '：<span style="font-weight:600;">' + p + '%</span> 剩余' + reset +
            '<div style="background:rgba(128,128,128,.2);border-radius:4px;height:6px;margin-top:2px;"><div style="width:' + p + '%;background:' + color + ';height:6px;border-radius:4px;"></div></div></div>'
        })
      })
    }
    // 按模型剩余（fetchAvailableModels）
    if (q.models && q.models.length > 0) {
      const hot = q.models.filter(function (m) { return m.name.indexOf('pro') !== -1 || m.name.indexOf('flash') !== -1 }).slice(0, 8)
      if (hot.length > 0) {
        html += '<div style="margin:6px 0 2px;font-weight:600;">按模型（5 小时窗口剩余）</div>'
        html += hot.map(function (m) {
          return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:1px 8px;border-radius:10px;background:rgba(128,128,128,.15);">' + escapeHtml(m.displayName || m.name) + ' ' + pct(m.percentage) + '%</span>'
        }).join('')
      }
    }
    if (q.warnings && q.warnings.length > 0) {
      html += NL + q.warnings.map(function (w) { return '⚠ ' + w }).join(NL)
    }
    out.innerHTML = html || '无额度数据'
  } catch (e) {
    out.textContent = '请求失败: ' + (e.message || '未知错误')
  }
}

// provider api keys (edit)
function getKeys(id) {
  const c = document.getElementById('keys-' + id)
  const items = c.querySelectorAll('[data-kidx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.kidx)
    const k = document.getElementById('k-' + id + '-' + idx).value.trim()
    const en = document.getElementById('ken-' + id + '-' + idx).checked
    if (!k) return null
    // Cline：账号名（自动关联或手工填），仅显示用，其余提供商没有这个输入框
    const lblEl = document.getElementById('klbl-' + id + '-' + idx)
    const lbl = lblEl ? lblEl.value.trim() : ''
    return lbl ? { key: k, enabled: en, label: lbl } : { key: k, enabled: en }
  }).filter(Boolean)
}

function addKeyRow(id) {
  const inp = document.getElementById('nk-' + id), k = inp.value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const c = document.getElementById('keys-' + id), cnt = c.querySelectorAll('[data-kidx]').length
  const isCline = id === 'cline'
  const d = document.createElement('div')
  // Cline：token 与账号信息同处一行（.cline-key-row 允许换行，窄窗口才折到第二行）
  d.className = isCline ? 'fc mb-3 field-row cline-key-row' : 'fc mb-3 field-row'
  d.dataset.kidx = cnt
  let html = '<input type="password" value="' + escapeHtml(k) + '" class="' + (isCline ? 'cline-tok' : 'fx1') + '" id="k-' + escapeHtml(id) + '-' + cnt + '" placeholder="API Key" aria-label="API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key" aria-label="显示或隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg"><input type="checkbox" checked id="ken-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用该 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testKeyRow(\\'' + escapeJsAttr(id) + '\\',' + cnt + ')" title="测试" aria-label="测试该 Key"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="rmKeyRow(\\'' + escapeJsAttr(id) + '\\',' + cnt + ')" title="移除" aria-label="移除该 Key"><i class="fas fa-times c-l"></i></button>'
  if (isCline) {
    html += '<span class="bd bd-info" id="kst-' + escapeHtml(id) + '-' + cnt + '">待保存</span>' +
      '<input type="text" class="cline-lbl" id="klbl-' + escapeHtml(id) + '-' + cnt + '" placeholder="账号（保存后自动关联邮箱）" aria-label="账号名（仅显示用）" onblur="clineSaveLabel(\\'' + escapeJsAttr(id) + '\\',' + cnt + ')">' +
      '<span class="mu" style="font-size:12px" id="kmsg-' + escapeHtml(id) + '-' + cnt + '"></span>'
  }
  html += '<span class="trt" id="ktr-' + escapeHtml(id) + '-' + cnt + '" aria-live="polite"></span>'
  d.innerHTML = html
  c.appendChild(d)
  inp.value = ''
  inp.focus()
}

function rmKeyRow(id, idx) {
  const c = document.getElementById('keys-' + id)
  c.querySelectorAll('[data-kidx]').forEach(item => {
    if (parseInt(item.dataset.kidx) === idx) item.remove()
  })
}

// 兼容不同 test-key / sync 端点的模型返回：可能是裸数组，也可能是 {data:[...]}（Cloudflare AI 等）
function extractModels(v) {
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.data)) return v.data
  return []
}

async function testKeyRow(id, idx) {
  const k = document.getElementById('k-' + id + '-' + idx).value.trim()
  const url = document.getElementById('url-' + id).value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const apiType = document.getElementById('at-' + id).value
  // UX6：结果写入该 Key 行自己的结果区，多个 Key 并发测试互不覆盖
  const tr = document.getElementById('ktr-' + id + '-' + idx) || document.getElementById('tr-' + id)
  showSpinner(tr)
  // 「测试密钥」按钮：opencode 走单 key 推理诊断（intent=diagnose），其余提供商忽略该参数
  const result = await testKeyConnection(url, apiType, k, id, 'diagnose')
  showResult(tr, result.success, result.success ? (result.email ? 'RefreshToken 有效（' + result.email + '）' : 'RefreshToken 有效') : (result.message && result.message.indexOf('HTTP') !== -1 ? result.message : 'HTTP ' + result.status + (result.message ? ': ' + result.message : '')))
  if (id === 'cline') {
    // Cline 这行测的是 refreshToken 是否有效 + 属于哪个账号，**不拉模型列表**
    // （拉模型是「获取模型」按钮的事，此前会顺手改写模型网格）。
    clineApplyProbe(id, idx, result)
    return
  }
  if (result.success) {
    showEditModelsList(id, extractModels(result.data))
  }
}

// 把单行探测结果写回该行的徽章与账号框（有效/无效 + 自动关联邮箱）
function clineApplyProbe(id, idx, result) {
  const b = document.getElementById('kst-' + id + '-' + idx)
  if (b) {
    b.textContent = result.success ? '有效' : '无效'
    b.className = 'bd ' + (result.success ? 'bd-on' : 'bd-danger')
    b.title = result.message || ''
  }
  const m = document.getElementById('kmsg-' + id + '-' + idx)
  const lbl = document.getElementById('klbl-' + id + '-' + idx)
  if (result.success && result.email && lbl && !lbl.value.trim()) lbl.value = result.email
  if (m) {
    if (!result.success) m.textContent = '该 RefreshToken 不可用（账号信息取自上游，失败时取不到）'
    else if (result.email) m.textContent = '已自动关联邮箱'
    else m.textContent = '上游未返回邮箱，可手工填写账号名'
  }
}

// opencode / 通用 编辑表单 — 获取模型（复用 testKeyConnection 逻辑）
async function fetchEditModels(id) {
  // Cline：仅保留一个「获取模型」按钮，改为动态拉官方 recommended-models（并入 provider.models）
  if (id === 'cline') { clineModels(id); return }
  // ZCode：走专属 sync 端点（带 ZCode 身份头 + KV 缓存 + 静态兜底）
  if (id === 'zcode') { zcodeModels(id); return }
  const url = document.getElementById('url-' + id).value.trim()
  const keys = getKeys(id)
  const apiKey = keys.length > 0 ? keys[0].key : ''
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  // 「获取模型」按钮：要的是模型列表（intent=fetchModels），与 key 可用性无关
  const result = await testKeyConnection(url, apiType, apiKey, id, 'fetchModels')
  // UX7：showResult 内部已转义，不再二次转义
  showResult(tr, result.success, result.success ? '' : (result.message || '获取模型失败'))
  if (result.success) {
    showEditModelsList(id, extractModels(result.data))
  }
}

function showEditModelsList(id, models) {
  const cid = 'mel-' + id
  let el = document.getElementById(cid)
  if (!el) {
    el = document.createElement('div')
    el.id = cid
    el.className = 'fg'
    const pd = document.getElementById('dt-' + id)
    if (!pd) { console.error('showEditModelsList: dt-' + id + ' not found'); return }
    // 找到模型 fieldset 并插入到它前面
    const sections = pd.querySelectorAll('fieldset.form-group')
    let target = null
    for (var i = 0; i < sections.length; i++) {
      var lbl = sections[i].querySelector('legend')
      if (lbl && (lbl.textContent.trim() === '模型' || lbl.textContent.includes('模型'))) {
        target = sections[i]
        break
      }
    }
    if (target && target.parentNode === pd) {
      pd.insertBefore(el, target)
    } else {
      pd.appendChild(el)
    }
  }
  el.innerHTML = '<label>可用模型 <span class="mu">（点击 + 添加单个，或 <a href="javascript:void(0)" onclick="addAllModels(\\'' + escapeJsAttr(id) + '\\')">一键全部添加</a>；Cline 点上方「获取模型」可动态拉官方 recommended-models）</span></label>' + renderModelGrid(models, id, id)
}

// 一键添加所有拉取的模型
function addAllModels(id) {
  const grid = document.getElementById('mel-' + id)
  if (!grid) return
  const btns = grid.querySelectorAll('[onclick^="addMdlToEdit"]')
  const ids = []
  btns.forEach(function(btn) {
    const onclick = btn.getAttribute('onclick') || ''
    const match = onclick.match(/addMdlToEdit\('([^']+)','([^']+)'\)/)
    if (match) ids.push(match[2])
  })
  if (ids.length === 0) { toast('没有可添加的模型', 'error'); return }
  // 清除现有模型列表
  const ml = document.getElementById('ml-' + id)
  if (ml) ml.innerHTML = ''
  ids.forEach(function(mid) { addMdlToEdit(id, mid) })
  toast('已添加 ' + ids.length + ' 个模型，请点击保存', 'success')
}

function addMdlToEdit(id, mid) {
  document.getElementById('nmid-' + id).value = mid
  addMdl(id)
}

function getMdl(id) {
  const c = document.getElementById('ml-' + id), items = c.querySelectorAll('[data-idx]')
  const list = Array.from(items).map(item => {
    const idx = parseInt(item.dataset.idx), mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const en = document.getElementById('men-' + id + '-' + idx).checked
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
  // 用户在"新的模型 ID"输入框里填了但没点"添加"就直接保存时，自动带上，避免模型丢失
  const np = document.getElementById('nmid-' + id)
  if (np && np.value.trim()) list.push({ id: np.value.trim(), enabled: true })
  return list
}

async function save(id) {
  if (adminSubmitting) return
  const nm = document.getElementById('nm-' + id).value.trim(), url = document.getElementById('url-' + id).value.trim()
  const apiType = document.getElementById('at-' + id).value
  const authType = document.getElementById('auth-' + id).value
  const oauth = collectOauthEdit(id)
  const keys = getKeys(id)
  const models = getMdl(id), enabled = document.getElementById('en-' + id).checked
  // 思维引导注入：收集每个勾选了注入的模型 ID
  const thinkingInject = Array.from(document.querySelectorAll('#ml-' + id + ' [data-idx]')).map(item => {
    const idx = parseInt(item.dataset.idx)
    const mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const inject = (document.getElementById('mit-' + id + '-' + idx)||{}).checked === true
    return mid && inject ? mid : null
  }).filter(Boolean)
  // 缓存前缀注入：收集每个勾选了注入的模型 ID
  const cachePrefixInject = Array.from(document.querySelectorAll('#ml-' + id + ' [data-idx]')).map(item => {
    const idx = parseInt(item.dataset.idx)
    const mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const inject = (document.getElementById('mcp-' + id + '-' + idx)||{}).checked === true
    return mid && inject ? mid : null
  }).filter(Boolean)
  // TRAE 省钱预算：收集开关 + 勾选命中的模型列表 + 3 个常量
  const traeBudgetEl = document.getElementById('trae-budget-' + id)
  const traeEnableRemoteBudget = traeBudgetEl ? traeBudgetEl.checked === true : undefined
  const traeRemoteOnlyModels = traeBudgetEl ? (Array.from(document.querySelectorAll('#ml-' + id + ' [data-idx]')).map(item => {
    const idx = parseInt(item.dataset.idx)
    const mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const budgetHit = (document.getElementById('mrb-' + id + '-' + idx)||{}).checked === true
    return mid && budgetHit ? mid : null
  }).filter(Boolean).join(',')) || undefined : undefined
  const traeMaxMessages = traeBudgetEl ? numOrUndef((document.getElementById('trae-mm-' + id)||{}).value) : undefined
  const traeMaxHistoryChars = traeBudgetEl ? numOrUndef((document.getElementById('trae-mhc-' + id)||{}).value) : undefined
  const traeMaxToolSchemaChars = traeBudgetEl ? numOrUndef((document.getElementById('trae-mtsc-' + id)||{}).value) : undefined
  // 系统提示词体系：模式 + 自有提示词（append 是合法取值，不能回落 passthrough）
  const pEl = document.getElementById('pmode-' + id)
  const promptMode = pEl ? (pEl.value === 'custom' ? 'custom' : pEl.value === 'append' ? 'append' : 'passthrough') : undefined
  const ptextEl = document.getElementById('ptext-' + id)
  const promptText = ptextEl ? (ptextEl.value.trim() || undefined) : undefined
  // DeepSeek App 深度思考开关：仅该提供商有此复选框，其余提供商读到 null → 不改动
  const dsThinkEl = document.getElementById('ds-thinkoff-' + id)
  const deepseekThinkingOff = dsThinkEl ? dsThinkEl.checked === true : undefined
  if (authType === 'oauth-device') {
    // 国际版必须带 Global 发起端点，否则发起登录会静默走国内端点
    if (oauth.loginRealm === 'global' && !oauth.globalDeviceCodeUrl) {
      toast('登录域为国际版，请填写「Global 域发起端点」或点预置补全后再保存', 'error'); return
    }
    // gemini / m365 同创建校验：后端专用流程无需三端点，允许先保存再连接认证
    const specialFlow = oauth.flowType === 'gemini' || oauth.flowType === 'm365-pkce' || oauth.flowType === 'm365-ropc'
    if (!specialFlow) {
      const needsClientId = oauth.flowType !== 'browser'
      if (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl || (needsClientId && !oauth.clientId)) {
        toast('OAuth 模式下请填写完整的配置（三个端点' + (needsClientId ? ' + Client ID' : '') + '）', 'error'); return
      }
    }
  }
  const vb = collectVisionBridgeEdit(id) || null
  const kukuThinkEl = document.getElementById('kuku-think-' + id)
  const providerType = kukuThinkEl ? 'kuku' : (vb && vb.primary ? 'vision-bridge' : null)
  const kukuThinkMode = kukuThinkEl ? numOrUndef(kukuThinkEl.value) : null
  const btn = document.querySelector('#dt-' + id + ' .detail-actions .btn-p')
  adminSubmitting = true
  busyBtn(btn)
  try {
    // 走全局写队列（见 queueProviderWrite）：服务端 PUT 是整份 providers 数组的读-改-写，
    // 与面板的即时保存并发会互相覆盖——用户实测「改完模式再点这里，这次改动就丢了」。
    const r = await queueProviderWrite(function () {
      return fetch('/admin/api/providers/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, toolBridge: (document.getElementById('atb-' + id)||{}).checked === true, allowUnlistedModels: (document.getElementById('aum-' + id)||{}).checked === true, reasoningEffort: ((document.getElementById('re-' + id)||{}).value || null), deepseekThinkingOff, thinkingInject, cachePrefixInject, cooldown: collectCooldown(id), type: providerType, kukuThinkMode, visionBridge: vb, geminiBaseUrl: ((document.getElementById('gbu-' + id)||{}).value || '').trim() || null, traeEnableRemoteBudget, traeRemoteOnlyModels, traeMaxMessages, traeMaxHistoryChars, traeMaxToolSchemaChars, accountSpread: (document.getElementById('m365-spread-' + id)||{}).checked === true, promptMode, promptText })
      })
    })
    const d = await r.json()
    if (d.success) {
      toast('已保存', 'success')
      // Cline：账号列表变了（新增/删除/轮换），下次展开自动重跑一次有效性检测
      if (id === 'cline') clineMarkStale(id)
      reloadAdmin()
    }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
  finally {
    adminSubmitting = false
    idleBtn(btn)
  }
}

async function del(id) {
  if (!(await cM('确定要删除此提供商？'))) return
  if (adminSubmitting) return
  const btn = document.querySelector('#dt-' + id + ' .detail-actions .btn-d')
  adminSubmitting = true
  busyBtn(btn)
  try {
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), { method: 'DELETE' })
    const d = await r.json()
    if (d.success) { toast('已删除', 'success'); reloadAdmin() }
    else toast(d.message || '删除失败', 'error')
  } catch (e) { toast('删除失败', 'error') }
  finally {
    adminSubmitting = false
    idleBtn(btn)
  }
}

// ===== 转发 Key 模型筛选 =====
async function editKeyModels(keyId) {
  // 获取所有提供商和模型
  const res = await fetch('/admin/api/providers')
  const d = await res.json()
  if (!d.success) { toast('获取模型列表失败', 'error'); return }
  const providers = d.data || []
  const allModels = []
  providers.forEach(function(p) {
    if (!p.enabled) return
    ;(p.models || []).forEach(function(m) {
      if (!m.enabled) return
      allModels.push({ id: p.id + '/' + m.id, label: p.name + ' / ' + m.id, group: p.name })
    })
  })
  // 联合模型（uni-model）也作为可筛选模型：调用 ID 形如 unimodel/名称
  ;(typeof UNIMODELS !== 'undefined' ? UNIMODELS : []).forEach(function(u) {
    allModels.push({ id: 'unimodel/' + u.name, label: 'unimodel/' + u.name, group: '联合模型' })
  })
  if (allModels.length === 0) { toast('暂无可用模型，请先添加提供商和模型', 'error'); return }
  // 获取当前 Key 的 allowedModels
  const keyRes = await fetch('/admin/api/proxy-keys')
  const kd = await keyRes.json()
  const key = (kd.data || []).find(function(k) { return k.id === keyId })
  const allowed = (key && key.allowedModels) || []
  const isAll = allowed.length === 0
  // 按提供商分组
  const groups = {}
  allModels.forEach(function(m) {
    if (!groups[m.group]) groups[m.group] = []
    groups[m.group].push(m)
  })
  let html = '<h3><i class="fas fa-filter c-p" aria-hidden="true"></i> 模型筛选</h3><p>不勾选的模型将无法通过此 Key 访问。全部勾选 = 允许全部。</p>'
  html += '<div style="margin-bottom:8px"><button class="btn btn-gh btn-xs" onclick="keyModelsToggle(true)">全选</button> <button class="btn btn-gh btn-xs" onclick="keyModelsToggle(false)">全不选</button></div>'
  html += '<div class="mdl-list" style="max-height:50vh;overflow-y:auto">'
  Object.keys(groups).forEach(function(g) {
    html += '<div><strong>' + escapeHtml(g) + '</strong></div>'
    groups[g].forEach(function(m) {
      const checked = isAll || allowed.indexOf(m.id) !== -1 ? ' checked' : ''
      html += '<label class="mdl-chk"><input type="checkbox" value="' + escapeHtml(m.id) + '"' + checked + '> ' + escapeHtml(m.id) + '</label>'
    })
  })
  html += '</div>'
  html += '<div class="fa" style="margin-top:12px"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="saveKeyModels(\\'' + escapeJsAttr(keyId) + '\\')">保存</button></div>'
  showM(html)
}
function keyModelsToggle(checked) {
  document.querySelectorAll('.mdl-chk input').forEach(function(el) { el.checked = checked })
}
async function saveKeyModels(keyId) {
  if (adminSubmitting) return  // 防重复提交（UX3）
  var checked = Array.from(document.querySelectorAll('.mdl-chk input:checked')).map(function(el) { return el.value })
  var all = Array.from(document.querySelectorAll('.mdl-chk input')).map(function(el) { return el.value })
  // 全部勾选 = 存空数组（= 全部允许）
  var allowedModels = checked.length === all.length ? [] : checked
  const btn = document.querySelector('#mc .btn-p')
  adminSubmitting = true
  busyBtn(btn)
  try {
    var res = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(keyId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedModels: allowedModels })
    })
    var d = await res.json()
    if (d.success) { toast('已保存', 'success'); markSaved(); closeM(); setTimeout(function() { reloadAdmin() }, 500) }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
  finally {
    adminSubmitting = false
    idleBtn(btn)
  }
}

function addMdl(id) {
  const inp = document.getElementById('nmid-' + id), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const c = document.getElementById('ml-' + id), cnt = c.querySelectorAll('[data-idx]').length
  // 省钱预算命中勾选：仅当该提供商存在「省钱预算」区（trae）才显示；并按已存命中列表回显
  const hasBudget = !!document.getElementById('trae-budget-' + id)
  const trm = document.getElementById('trae-trm-' + id)
  const savedList = hasBudget && trm ? (trm.getAttribute('data-rmodels') || '').split(',').map(function(s){ return s.trim().toLowerCase() }).filter(Boolean) : []
  const dbChecked = hasBudget && savedList.indexOf(String(mid).trim().toLowerCase()) !== -1
  const dbBox = hasBudget ? '<label class="tg" title="命中省钱预算（历史裁剪/工具压缩）"><input type="checkbox" id="mrb-' + escapeHtml(id) + '-' + cnt + '"' + (dbChecked ? ' checked' : '') + ' aria-label="命中省钱预算"><span class="sl"></span></label>' : ''
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.idx = cnt
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + escapeHtml(id) + '-' + cnt + '" placeholder="模型 ID" aria-label="模型 ID"><label class="tg" title="启用该模型"><input type="checkbox" checked id="men-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用该模型"><span class="sl"></span></label><label class="tg" title="启用思维引导注入"><input type="checkbox" id="mit-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用思维引导注入"><span class="sl"></span></label><label class="tg" title="启用缓存前缀注入"><input type="checkbox" id="mcp-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用缓存前缀注入"><span class="sl"></span></label>' + dbBox + '<button class="btn btn-gh btn-xs" id="tm-' + escapeHtml(id) + '-' + cnt + '" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" id="rm-' + escapeHtml(id) + '-' + cnt + '" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" id="mtr-' + escapeHtml(id) + '-' + cnt + '" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
  effDdEnsure(d)
  document.getElementById('tm-' + id + '-' + cnt).addEventListener('click', function() { testMdl(id, mid, cnt) })
  document.getElementById('rm-' + id + '-' + cnt).addEventListener('click', function() { rmMdl(id, cnt) })
  inp.value = ''
}

function rmMdl(id, idx) {
  const c = document.getElementById('ml-' + id)
  c.querySelectorAll('[data-idx]').forEach(item => {
    if (parseInt(item.dataset.idx) === idx) item.remove()
  })
}

async function testMdl(id, mid, idx) {
  // UX6：结果写入该模型行自己的结果区，多个模型并发测试互不覆盖
  const tr = document.getElementById('mtr-' + id + '-' + idx) || document.getElementById('tr-' + id)
  showSpinner(tr)
  try {
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id) + '/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: mid })
    })
    const d = await r.json()
    if (d.success && d.data) {
      showResult(tr, d.data.success, d.data.success ? '' : (d.data.message || '连接失败'))
    } else {
      showResult(tr, false, d.message || '测试失败')
    }
  } catch (e) { showResult(tr, false, '请求失败') }
}

// proxy keys
async function genKey() {
  const name = await pM('输入 Key 名称（可选）')
  if (name === null) return
  showM('<h3><i class="fas fa-key c-p"></i> 生成转发 Key</h3><div class="fg"><label>有效期类型</label><select id="expType" onchange="toggleKeyExpiry()"><option value="forever" selected>永久</option><option value="preset">预设</option><option value="custom">自定义</option></select></div><div id="expPreset" class="fg hd"><label>预设有效期</label><select id="exp"><option value="30d">30 天</option><option value="90d">90 天</option><option value="180d">180 天</option><option value="1y">1 年</option></select></div><div id="expCustom" class="fg hd"><label>自定义有效期</label><div class="fc"><input type="number" id="expVal" min="1" max="3650" placeholder="数值" style="width:100px"><select id="expUnit"><option value="d">天</option><option value="h">小时</option></select></div></div><div class="fa"><button class="btn btn-s" id="gKc">取消</button><button class="btn btn-p" id="gKo">生成</button></div>')
  document.getElementById('gKc').addEventListener('click', closeM)
  document.getElementById('gKo').addEventListener('click', function() { doGenKey(name) })
  window.toggleKeyExpiry = function() {
    const t = document.getElementById('expType').value
    document.getElementById('expPreset').classList.toggle('hd', t !== 'preset')
    document.getElementById('expCustom').classList.toggle('hd', t !== 'custom')
  }
}

async function doGenKey(name) {
  if (adminSubmitting) return  // 防重复提交（UX3）
  closeM()
  const nm = name || ''
  adminSubmitting = true
  try {
    const expType = document.getElementById('expType')?.value || 'forever'
    let body = { name: nm }
    if (expType === 'preset') {
      body.expiresIn = document.getElementById('exp')?.value || '30d'
    } else if (expType === 'custom') {
      const expVal = parseInt(document.getElementById('expVal')?.value || '0', 10)
      const expUnit = document.getElementById('expUnit')?.value || 'd'
      if (expVal > 0) {
        if (expUnit === 'h') body.expiresInHours = expVal
        else body.expiresInDays = expVal
      }
    }
    const r = await fetch('/admin/api/proxy-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.success && d.data) {
      markSaved()  // UX8：Key 已生成（modal 内无表单输入残留）
      showM('<h3><i class="fas fa-check-circle c-s"></i> 生成成功</h3><p>请妥善保存，切勿泄露：</p><div class="mk">' + d.data.key + '</div><div class="fa"><button class="btn btn-p" onclick="closeM();reloadAdmin()">关闭</button></div>')
    } else toast(d.message || '生成失败', 'error')
  } catch (e) { toast('生成失败', 'error') }
  finally { adminSubmitting = false }
}

// 修改过期时间 / 续期：已过期的 Key 也能直接续期恢复，无需删掉重加（Key 字符串不变）
async function editKeyExpiry(id) {
  const keyRes = await fetch('/admin/api/proxy-keys')
  const kd = await keyRes.json()
  const key = (kd.data || []).find(function(k) { return k.id === id })
  if (!key) { toast('Key 不存在', 'error'); return }
  const expired = !!(key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now())
  const curText = expired ? '已过期，续期后立即恢复可用' : (key.expiresAt ? '当前有效至 ' + new Date(key.expiresAt).toLocaleString() : '当前永久有效')
  showM('<h3><i class="fas fa-clock c-p"></i> 修改过期时间 / 续期</h3><p style="font-size:12px;color:var(--muted,#64748b)">' + escapeHtml(key.name) + (expired ? ' · <span class="c-d">已过期</span>' : '') + ' · ' + escapeHtml(curText) + '。新有效期从当前时间重新起算。</p><div class="fg"><label>有效期类型</label><select id="expType2" onchange="toggleKeyExpiry2()"><option value="preset" selected>预设</option><option value="custom">自定义</option><option value="forever">永久</option></select></div><div id="expPreset2" class="fg"><label>预设有效期</label><select id="exp2"><option value="30d">30 天</option><option value="90d">90 天</option><option value="180d">180 天</option><option value="1y">1 年</option></select></div><div id="expCustom2" class="fg hd"><label>自定义有效期</label><div class="fc"><input type="number" id="expVal2" min="1" max="3650" placeholder="数值" style="width:100px"><select id="expUnit2"><option value="d">天</option><option value="h">小时</option></select></div></div><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" id="eKo">保存</button></div>')
  window.toggleKeyExpiry2 = function() {
    const t = document.getElementById('expType2').value
    document.getElementById('expPreset2').classList.toggle('hd', t !== 'preset')
    document.getElementById('expCustom2').classList.toggle('hd', t !== 'custom')
  }
  document.getElementById('eKo').addEventListener('click', function() { doEditKeyExpiry(id) })
}

async function doEditKeyExpiry(id) {
  if (adminSubmitting) return  // 防重复提交（UX3）
  const expType = document.getElementById('expType2').value
  let body = {}
  if (expType === 'preset') {
    body.expiresIn = document.getElementById('exp2').value
  } else if (expType === 'custom') {
    const expVal = parseInt(document.getElementById('expVal2').value || '0', 10)
    const expUnit = document.getElementById('expUnit2').value || 'd'
    if (expVal <= 0) { toast('请输入有效的自定义有效期', 'error'); return }
    if (expUnit === 'h') body.expiresInHours = expVal
    else body.expiresInDays = expVal
  } else {
    body.expiresIn = 'forever'
  }
  const btn = document.getElementById('eKo')
  adminSubmitting = true
  busyBtn(btn)
  try {
    const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.success) { toast(expType === 'forever' ? '已改为永久有效' : '续期成功', 'success'); closeM(); setTimeout(function() { reloadAdmin() }, 500) }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
  finally {
    adminSubmitting = false
    idleBtn(btn)
  }
}

async function rmKey(id) {
  if (!(await cM('确定要删除此 Key？'))) return
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('已删除', 'success'); reloadAdmin() }
  else toast(d.message || '删除失败', 'error')
}

// proxy key list interactions
async function togglePb(id, checked) {
  const pi = document.querySelector('.pi[data-id="' + id + '"]')
  if (!pi) return
  const b = pi.querySelector('.ps .bd')
  if (b) { b.textContent = checked ? '已启用' : '未启用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
  // 同样走全局写队列：这也是 providers blob 的写者，与面板即时保存/卡片保存并发会互相覆盖
  const r = await queueProviderWrite(function () {
    return fetch('/admin/api/providers/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: checked })
    })
  })
  const d = await r.json()
  if (!d.success) toast(d.message || '操作失败', 'error')
  else markSaved()  // UX8：启用/禁用开关已即时保存
}

function toggleKeyVis(id) {
  const el = document.getElementById('kv-' + id)
  const full = el.dataset.full
  if (el.textContent.includes('****')) {
    el.textContent = full
  } else {
    el.textContent = full.length > 12
      ? full.substring(0, 8) + '****' + full.substring(full.length - 4)
      : full
  }
}

async function toggleProxyKey(id, checked) {
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (d.success) {
    const ki = document.querySelector('.ki[data-id="' + id + '"]')
    if (ki) {
      const b = ki.querySelector('.fc .bd')
      if (b) { b.textContent = checked ? '已启用' : '已禁用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
    }
  } else toast(d.message || '操作失败', 'error')
}

// 中文说明：根据点击和 URL 锚点同步侧栏选中态，避免导航始终停留在“概览”。
const adminNavLinks = Array.from(document.querySelectorAll('.admin-nav a[href^="#"]'))
function setActiveAdminNav(hash) {
  const targetHash = adminNavLinks.some(function (link) { return link.getAttribute('href') === hash }) ? hash : '#overview'
  adminNavLinks.forEach(function (link) {
    const active = link.getAttribute('href') === targetHash
    link.classList.toggle('is-active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
adminNavLinks.forEach(function (link) {
  link.addEventListener('click', function () { setActiveAdminNav(link.getAttribute('href') || '#overview') })
})
window.addEventListener('hashchange', function () { setActiveAdminNav(location.hash) })
setActiveAdminNav(location.hash)
// P3：M365 账号池独立页已并入提供商详情，旧锚点重定向到提供商区
if (location.hash === '#m365-accounts') location.replace('#providers')
window.addEventListener('hashchange', function () {
  if (location.hash === '#m365-accounts') location.replace('#providers')
})

// P2：概览驾驶舱聚合 KPI —— 拉取 /admin/api/overview 渲染各产品族额度 + 签到进度卡片
;(async function loadOverviewKpi() {
  var root = document.getElementById('overview-kpi')
  if (!root) return
  function kpiCard(value, label, sub, pct) {
    var bar = ''
    if (pct !== null && pct !== undefined) {
      var w = Math.max(0, Math.min(100, Math.round(pct)))
      bar = '<div class="kpi-bar" aria-hidden="true"><i style="width:' + w + '%"></i></div>'
    }
    return '<div class="kpi"><span>' + value + '</span><p>' + label + '</p><small>' + sub + '</small>' + bar + '</div>'
  }
  function kpiNum(v) {
    var n = typeof v === 'number' && isFinite(v) ? v : 0
    return String(Math.round(n) === n ? n : Number(n.toFixed(2)))
  }
  // 额度卡：remain/size 进度条；该产品族无账号时降级占位
  function quotaCard(q, label, emptyText) {
    var o = q || {}
    if (o.accounts > 0) {
      return kpiCard(kpiNum(o.remain), label, '额度池 ' + kpiNum(o.size), o.size > 0 ? o.remain / o.size * 100 : null)
    }
    return kpiCard('—', label, emptyText, null)
  }
  try {
    var r = await fetch('/admin/api/overview')
    var d = await r.json()
    if (!d.success || !d.data) return
    var ck = d.data.checkin || {}
    var ckTotal = ck.totalAccounts || 0
    var html = ''
    // 额度按产品族分开：合并成一个数会让 WorkBuddy 卡片把 QoderWork 的额度也算进去
    html += quotaCard(d.data.workbuddy, 'WorkBuddy 可用额度', '暂无 WorkBuddy 账号')
    html += quotaCard(d.data.qoder, 'QoderWork 可用额度', '暂无 QoderWork 账号')
    // TRAE 可用额度：SOLO(通用) + Work(专属) 双通道合计，副标题给出通道拆分便于定位
    var tr = d.data.trae || {}
    if (tr.accounts > 0) {
      html += kpiCard(kpiNum(tr.remain), 'TRAE 可用额度', 'SOLO ' + kpiNum(tr.soloRemain) + ' · Work ' + kpiNum(tr.workRemain), tr.size > 0 ? tr.remain / tr.size * 100 : null)
    } else {
      html += kpiCard('—', 'TRAE 可用额度', '暂无 TRAE 账号', null)
    }
    // 今日签到：跨产品族总口径
    if (ckTotal > 0) {
      html += kpiCard(ck.checkedIn + '/' + ckTotal, '今日签到', ck.checkedIn >= ckTotal ? '全部完成' : ((ckTotal - ck.checkedIn) + ' 个待签'), ckTotal ? ck.checkedIn / ckTotal * 100 : null)
    } else {
      html += kpiCard('—', '今日签到', '暂无签到数据', null)
    }
    root.innerHTML = html
  } catch (e) { /* 聚合接口失败保持空白，不打扰配置统计展示 */ }
})()

// 通过 ?connect=id 进入时自动发起 OAuth 登录（"创建并发起连接"按钮创建后跳转过来）
;(function () {
  var cid = new URLSearchParams(location.search).get('connect')
  if (cid) {
    history.replaceState(null, '', '/admin')  // 清掉参数，避免刷新重复触发
    setTimeout(function () { oauthConnect(cid) }, 300)
  }
})()

// ===== 日志系统 =====
var logAutoRefreshTimer = null
var logAutoRefreshSec = 5
var logRefreshing = false
var logPage = 1
var logPageSize = 5
function persistLogAuto() {
  try { localStorage.setItem('kv-log-auto', JSON.stringify({ on: document.getElementById('log-auto-on').checked, sec: Math.max(1, parseInt(document.getElementById('log-auto-sec').value) || 5) })) } catch (e) { /* 忽略 */ }
}
function startLogAutoRefresh() {
  stopLogAutoRefresh()
  logAutoRefreshSec = Math.max(1, parseInt(document.getElementById('log-auto-sec').value) || 5)
  logAutoRefreshTimer = setInterval(function () {
    if (document.getElementById('log-switch').checked) refreshLogs(true)  // P7：自动刷新静默模式
  }, logAutoRefreshSec * 1000)
}
function stopLogAutoRefresh() {
  if (logAutoRefreshTimer) { clearInterval(logAutoRefreshTimer); logAutoRefreshTimer = null }
}
function logAutoToggle(on) {
  if (on) startLogAutoRefresh(); else stopLogAutoRefresh()
  persistLogAuto()
}
function logAutoSecChange() {
  if (document.getElementById('log-auto-on').checked) startLogAutoRefresh()
  persistLogAuto()
}
;(function initLogs() {
  fetch('/admin/api/logs/config').then(r => r.json()).then(d => {
    if (d.success) {
      document.getElementById('log-switch').checked = d.data.enabled
      document.getElementById('log-status').textContent = d.data.enabled ? '已开启' : '已关闭'
      if (d.data.retentionDays) document.getElementById('log-retention').value = d.data.retentionDays
      if (d.data.enabled) refreshLogs()
    }
  })
  // M365 SSE 调试日志开关状态
  fetch('/admin/api/m365/debug-sse').then(r => r.json()).then(d => {
    if (d.success) {
      document.getElementById('m365-sse-switch').checked = d.data.enabled
      document.getElementById('m365-sse-status').textContent = d.data.enabled ? 'M365调试:开' : 'M365调试:关'
    }
  })
  // 恢复上次的自动刷新设置
  try {
    const cfg = JSON.parse(localStorage.getItem('kv-log-auto') || 'null')
    if (cfg) {
      document.getElementById('log-auto-sec').value = cfg.sec || 5
      if (cfg.on) { document.getElementById('log-auto-on').checked = true; startLogAutoRefresh() }
    }
  } catch (e) { /* 忽略 */ }
})()

async function toggleLog(on) {
  const r = await fetch('/admin/api/logs/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled:on}) })
  const d = await r.json()
  if (d.success) {
    document.getElementById('log-status').textContent = on ? '已开启' : '已关闭'
    if (on) { logPage = 1; refreshLogs() }
    else document.getElementById('log-list').innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>日志已关闭</h3><p>开启开关后开始记录。</p></div>'
  }
}

async function toggleM365Debug(on) {
  const r = await fetch('/admin/api/m365/debug-sse', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled:on}) })
  const d = await r.json()
  if (d.success) document.getElementById('m365-sse-status').textContent = on ? 'M365调试:开' : 'M365调试:关'
}

async function refreshLogs(isAuto) {
  if (logRefreshing) return
  logRefreshing = true
  const el = document.getElementById('log-list')
  // 日志记录开关关闭时：刷新也保持「日志已关闭」占位，不向后端拉取历史日志
  const sw = document.getElementById('log-switch')
  if (sw && !sw.checked) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>日志已关闭</h3><p>开启开关后开始记录。</p></div>'
    logRefreshing = false
    return
  }
  // P7：定时自动刷新走静默模式——不闪「加载中」，内容未变化时不重绘 DOM
  if (!isAuto) el.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i><h3>加载中…</h3></div>'
  try {
    try {
      // 拼接查询参数：分页 + 搜索条件（类型/日期范围/关键词）
      var qs = 'limit=' + logPageSize + '&offset=' + ((logPage - 1) * logPageSize)
      var syslogType = document.getElementById('syslog-type')
      var syslogStart = document.getElementById('syslog-start')
      var syslogEnd = document.getElementById('syslog-end')
      var syslogKeyword = document.getElementById('syslog-keyword')
      var fType = syslogType ? syslogType.value : ''
      var fStart = syslogStart ? syslogStart.value : ''
      var fEnd = syslogEnd ? syslogEnd.value : ''
      var fKw = syslogKeyword ? syslogKeyword.value.trim() : ''
      if (fType) qs += '&type=' + encodeURIComponent(fType)
      // 日期修复：datetime-local 值不含时区，Workers 运行时默认 UTC 会整体偏移 8 小时。
      // 在浏览器（用户本地时区）先转成 ISO 字符串再传，后端 new Date(iso) 即得正确 UTC 毫秒。
      if (fStart) {
        var ds = new Date(fStart)
        if (!isNaN(ds.getTime())) qs += '&start=' + encodeURIComponent(ds.toISOString())
      }
      if (fEnd) {
        var de = new Date(fEnd)
        if (!isNaN(de.getTime())) {
          // end 选 00:00:00 时补到 23:59:59.999——用户选同一天只想搜整天，避免漏掉当天后半段
          if (de.getHours() === 0 && de.getMinutes() === 0 && de.getSeconds() === 0) {
            de.setHours(23, 59, 59, 999)
          }
          qs += '&end=' + encodeURIComponent(de.toISOString())
        }
      }
      if (fKw) qs += '&keyword=' + encodeURIComponent(fKw)
      const r = await fetch('/admin/api/logs?' + qs)
      const d = await r.json()
      if (!d.success || !d.data.logs || d.data.logs.length === 0) {
        // 当前页无数据：若不在第一页则回退一页重新加载（如日志被清除）
        if (logPage > 1) { logPage--; logRefreshing = false; refreshLogs(isAuto); return }
        var hasCond = !!(fType || fStart || fEnd || fKw)
        var emptyTip = hasCond ? '没有匹配的日志，试试调整搜索条件。' : '开启开关后 API 请求会被记录。'
        // 搜索模式下显示扫描范围，便于诊断（scanned=实际扫描数 / kvTotal=日志总数）
        var scannedNote = ''
        if (hasCond && d.data) {
          scannedNote = '<p style="font-size:11px;color:var(--muted,#64748b)">已扫描 ' + (d.data.scanned || 0) + ' / ' + (d.data.kvTotal || 0) + ' 条日志'
          if (d.data.truncated) scannedNote += '（仅最近 ' + (d.data.scanned || 0) + ' 条，缩小日期范围可全量搜索）'
          scannedNote += '</p>'
        }
        el.innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>' + emptyTip + '</p>' + scannedNote + '</div>'
        return
      }
      var html = ''
      d.data.logs.forEach(function(log) {
        var icon = log.type === 'error' ? '<i class="fas fa-times-circle c-l"></i>'
          : log.type === 'warn' ? '<i class="fas fa-exclamation-triangle c-o"></i>'
          : log.type === 'request' ? '<i class="fas fa-check-circle c-g"></i>'
          : '<i class="fas fa-info-circle c-p"></i>'
        var time = new Date(log.time).toLocaleString()
        html += '<article class="ki" style="font-size:12px;padding:6px 10px"><div><span style="margin-right:8px">' + icon + '</span><span class="mu" style="margin-right:8px">' + escapeHtml(time) + '</span><span class="bd bd-' + (log.type==='error'?'danger':log.type==='warn'?'off':'on') + '">' + log.type + '</span></div><div style="margin-top:4px">' + escapeHtml(log.message) + '</div>' + (log.details ? '<details style="margin-top:4px"><summary>详情</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">' + escapeHtml(log.details) + '</pre></details>' : '') + '</article>'
      })
      // 分页条
      var totalPages = Math.max(1, Math.ceil(d.data.total / logPageSize))
      var sizeOpts = [5, 10, 15, 20, 50, 100]
      var sizeHtml = '<select onchange="logPageSizeChange(this.value)" style="font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit">'
      for (var s = 0; s < sizeOpts.length; s++) {
        sizeHtml += '<option value="' + sizeOpts[s] + '"' + (sizeOpts[s] === logPageSize ? ' selected' : '') + '>' + sizeOpts[s] + ' 条/页</option>'
      }
      sizeHtml += '</select>'
      html += '<div style="padding:10px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap">'
      html += '<button class="btn btn-gh btn-xs" onclick="logPageChange(' + (logPage - 1) + ')" ' + (logPage <= 1 ? 'disabled' : '') + '><i class="fas fa-chevron-left"></i>上一页</button>'
      html += '<span class="mu" style="font-size:12px">第 ' + logPage + ' / ' + totalPages + ' 页 · 共 ' + d.data.total + ' 条' + (d.data.scanned ? ' · 已扫描 ' + d.data.scanned + '/' + (d.data.kvTotal || d.data.scanned) + ' 条' : '') + '</span>'
      html += '<button class="btn btn-gh btn-xs" onclick="logPageChange(' + (logPage + 1) + ')" ' + (logPage >= totalPages ? 'disabled' : '') + '>下一页<i class="fas fa-chevron-right"></i></button>'
      html += '<span class="mu" style="font-size:12px">' + sizeHtml + '</span>'
      html += '</div>'
      // P7：内容未变化时跳过 DOM 重绘（自动刷新场景避免整页闪烁）
      if (!isAuto || el.innerHTML !== html) el.innerHTML = html
    } catch(e) {
      if (!isAuto) el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle c-l"></i><h3>加载失败</h3></div>'
    }
  } finally {
    logRefreshing = false
  }
}

// 系统日志搜索：读取筛选条件后回到第一页加载
function syslogSearch() {
  logPage = 1
  refreshLogs()
}
// 重置搜索条件
function syslogReset() {
  var t = document.getElementById('syslog-type')
  var s = document.getElementById('syslog-start')
  var e = document.getElementById('syslog-end')
  var k = document.getElementById('syslog-keyword')
  if (t) t.value = ''
  if (s) s.value = ''
  if (e) e.value = ''
  if (k) k.value = ''
  logPage = 1
  refreshLogs()
}

function logPageChange(p) {
  if (p < 1) return
  logPage = p
  refreshLogs()
}

function logPageSizeChange(v) {
  v = parseInt(v) || 50
  if (v === logPageSize) return
  logPageSize = v
  logPage = 1  // 切换每页条数后回到第一页
  refreshLogs()
}

async function clearLogs() {
  if (!await cM('确定要清除所有日志吗？此操作不可撤销。')) return
  await fetch('/admin/api/logs', { method: 'DELETE' })
  document.getElementById('log-list').innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>日志已清除。</p></div>'
  toast('日志已清除', 'success')
}

// 变更日志保留天数：超过该天数的日志由 KV 自动过期删除
async function logRetentionChange(v) {
  const n = Math.max(1, Math.min(365, parseInt(v) || 7))
  if (document.getElementById('log-retention').value != n) document.getElementById('log-retention').value = n
  const r = await fetch('/admin/api/logs/config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ retentionDays: n })
  })
  const d = await r.json()
  if (d.success) toast('日志保留 ' + n + ' 天，超期自动删除。', 'success')
  else toast(d.message || '保存失败', 'error')
}

// 删除超过保留天数的日志：以当前时间为起点往前推，后端按保留天数配置自动计算清理
async function deleteExpiredLogs() {
  const days = document.getElementById('log-retention').value || 7
  if (!(await cM('确定删除超过保留天数（' + days + ' 天）的日志吗？此操作不可撤销。'))) return
  const r = await fetch('/admin/api/logs?expired=1', { method: 'DELETE' })
  const d = await r.json()
  if (d.success) {
    toast(d.message || '已删除过期日志', 'success')
    logPage = 1
    refreshLogs()
  } else toast(d.message || '删除失败', 'error')
}

// ===== 签到（各池已迁移进 provider 卡，见 wbp-/qdp-/trae- 账号池的「立即签到」） =====
async function triggerCheckin(id) {
  toast('签到中…', 'info')
  try {
    const body = id ? JSON.stringify({ id: id }) : '{}'
    const r = await fetch('/admin/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    const d = await r.json()
    if (d.success) {
      var msg
      var results
      if (id) {
        msg = '签到完成'
        results = [d.data]
      } else {
        // 全量：d.data = { summary, trae }
        var s = (d.data && d.data.summary) || d.data || {}
        var t = (d.data && d.data.trae) ? d.data.trae : { ok: 0, already: 0, fail: 0 }
        msg = '签到完成：WorkBuddy 成功 ' + (s.success||0) + ' / 已签 ' + (s.already||0) + ' / 失败 ' + (s.fail||0) + ' / 跳过 ' + (s.skipped||0) +
          '；TRAE 成功 ' + (t.ok||0) + ' / 已签 ' + (t.already||0) + ' / 失败 ' + (t.fail||0)
        results = s.results || []
      }
      toast(msg, 'success')
      // 签到数据已更新：同步刷新各账号池（明细/徽章即时更新）
      // WorkBuddy 池
      document.querySelectorAll('.pd.open [id^="wbp-acc-"]').forEach(function (el) {
        var pid = String(el.id).replace(/^wbp-acc-/, '')
        if (document.getElementById('wbp-st-' + pid)) oauthPoolStatus(pid)
      })
      // Qoder 池
      document.querySelectorAll('.pd.open [id^="qdp-acc-"]').forEach(function (el) {
        var pid = String(el.id).replace(/^qdp-acc-/, '')
        if (document.getElementById('qdp-st-' + pid)) qoderPoolStatus(pid)
      })
      // TRAE SOLO 池（签到列更新）
      document.querySelectorAll('.pd.open [id^="trae-acc-"]').forEach(function (el) {
        traeStatus(String(el.id).replace(/^trae-acc-/, ''))
      })
    } else {
      toast(d.message || '签到失败', 'error')
    }
  } catch(e) {
    toast('签到请求失败', 'error')
  }
}

// ===== WorkBuddy 生态增值与日常任务客户端触发 =====
async function triggerDailyTasks(id) {
  toast('正在执行一键日常（签到+活跃+旅行）…', 'info')
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/daily', { method: 'POST' })
    const d = await r.json()
    if (d.success) {
      toast(d.message || '一键日常任务完成', 'success')
      if (document.getElementById('wbp-st-' + id)) oauthPoolStatus(id)
    } else {
      toast(d.message || '日常任务执行失败', 'error')
    }
  } catch (e) {
    toast('日常任务请求失败', 'error')
  }
}
async function triggerActivityReport(id) {
  toast('正在上报活跃度…', 'info')
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/activity', { method: 'POST' })
    const d = await r.json()
    if (d.success) {
      toast(d.message || '活跃度上报完成', 'success')
      if (document.getElementById('wbp-st-' + id)) oauthPoolStatus(id)
    } else {
      toast(d.message || '活跃度上报失败', 'error')
    }
  } catch (e) {
    toast('活跃度上报请求失败', 'error')
  }
}
async function triggerCatTravel(id) {
  toast('正在检查猫猫旅行…', 'info')
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/travel', { method: 'POST' })
    const d = await r.json()
    if (d.success) {
      var msg = d.message || '猫猫旅行巡检完成'
      if (Array.isArray(d.data) && d.data.length > 0) {
        var summary = d.data.map(function (item) {
          return (item.nickname || item.uid) + ': ' + (item.message || item.state)
        }).join('; ')
        msg += ' (' + summary + ')'
      }
      toast(msg, 'success')
      if (document.getElementById('wbp-st-' + id)) oauthPoolStatus(id)
    } else {
      toast(d.message || '猫猫旅行巡检失败', 'error')
    }
  } catch (e) {
    toast('猫猫旅行请求失败', 'error')
  }
}
// 页面加载后初始化识图模型顺序序号（处理编辑表单预勾选的模型）
renumberVisionOrders();
// UX2：上次 reload 前保存的滚动位置/展开面板在此恢复
restoreAdminState();

// ===== MCP 网关管理 =====
const MCPS = ${serializeForScript(mcps)};
const UNIMODELS = ${serializeForScript(unimodels)};
function mcpFind(id) {
  for (var i = 0; i < MCPS.length; i++) if (MCPS[i].id === id) return MCPS[i]
  return null
}
function mcpFormModal(m) {
  var h = '<h3><i class="fas fa-boxes c-p"></i> ' + (m ? '编辑 MCP Server' : '添加 MCP Server') + '</h3>'
  h += '<div class="fg"><label>名称</label><input type="text" id="mcp-name" value="' + (m ? escapeHtml(m.name) : '') + '" placeholder="如：网络搜索"></div>'
  h += '<div class="fg"><label>URL（MCP JSON-RPC 端点）</label><input type="url" id="mcp-url" value="' + (m ? escapeHtml(m.url) : '') + '" placeholder="https://example.com/mcp"></div>'
  h += '<div class="fg"><label>HTTP 头（JSON，可选）</label><textarea id="mcp-headers" rows="3" placeholder=\\'{"Authorization":"Bearer xxx"}\\'>' + (m ? escapeHtml(JSON.stringify(m.httpHeaders || {}, null, 2)) : '') + '</textarea><span class="form-helper">工具名自动加前缀「' + (m ? escapeHtml(m.name) : '名称') + '-」，名称中的空格变下划线。</span></div>'
  h += '<div class="panel-actions"><label class="switch-label"><span>启用</span><span class="tg"><input type="checkbox" id="mcp-enabled"' + (!m || m.enabled ? ' checked' : '') + '><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="mcpSave(\\'' + (m ? escapeJsAttr(m.id) : '') + '\\')">保存</button></div></div>'
  showM(h)
}
function mcpEdit(id) { mcpFormModal(mcpFind(id)) }
function mcpSave(id) {
  var name = document.getElementById('mcp-name').value.trim()
  var url = document.getElementById('mcp-url').value.trim()
  var headersRaw = document.getElementById('mcp-headers').value.trim()
  var enabled = document.getElementById('mcp-enabled').checked
  if (!name || !url) { toast('名称和 URL 为必填项', 'error'); return }
  var headers = {}
  if (headersRaw) {
    try { headers = JSON.parse(headersRaw) } catch (e) { toast('HTTP 头必须是合法 JSON', 'error'); return }
  }
  var payload = { name: name, url: url, httpHeaders: headers, enabled: enabled }
  fetch(id ? '/admin/api/mcps/' + encodeURIComponent(id) : '/admin/api/mcps', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json() }).then(function (d) {
    if (d.success) { closeM(); toast('保存成功', 'success'); setTimeout(function () { reloadAdmin() }, 300) }
    else { toast(d.message || '保存失败', 'error') }
  }).catch(function () { toast('网络错误', 'error') })
}
function mcpToggle(id, checked) {
  fetch('/admin/api/mcps/' + encodeURIComponent(id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  }).then(function (r) { return r.json() }).then(function (d) {
    if (d.success) toast(checked ? '已启用' : '已禁用', 'success')
    else toast(d.message || '操作失败', 'error')
  })
}
function mcpDel(id) {
  cM('确认删除该 MCP Server？').then(function (ok) {
    if (!ok) return
    fetch('/admin/api/mcps/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) { return r.json() })
      .then(function (d) { if (d.success) { toast('已删除', 'success'); setTimeout(function () { reloadAdmin() }, 300) } else toast(d.message || '删除失败', 'error') })
  })
}
// 健康检查：逐个探测各 MCP 的可达性与工具数
function mcpHealth() {
  toast('正在探测 MCP…', 'info')
  fetch('/admin/api/mcps/health').then(function (r) { return r.json() }).then(function (d) {
    if (!d.success) { toast(d.message || '探测失败', 'error'); return }
    var dt = d.data, servers = dt.servers || []
    var okN = 0
    var rows = servers.map(function (s) {
      if (s.status === 'ok') okN++
      var icon = s.status === 'ok' ? '<i class="fas fa-check-circle c-s"></i>' : (s.status === 'error' ? '<i class="fas fa-times-circle c-d"></i>' : '<i class="fas fa-pause-circle mu"></i>')
      var cls = s.status === 'ok' ? 'bd bd-on' : (s.status === 'error' ? 'bd bd-off' : 'mu')
      var label = s.status === 'ok' ? ('可达 · ' + s.tools + ' 个工具') : (s.status === 'error' ? ('异常 · ' + escapeHtml((s.error || '未知错误').slice(0, 80))) : '已禁用')
      return '<div class="mcph-row">' + icon + '<div class="fx1"><div><strong>' + escapeHtml(s.name) + '</strong> <span class="' + cls + '">' + label + '</span></div><div class="mu"><code>' + escapeHtml(s.url) + '</code></div></div></div>'
    }).join('')
    if (rows === '') rows = '<div class="empty-state"><i class="fas fa-boxes"></i><p>尚未配置 MCP Server。</p></div>'
    var summary = '<div style="padding:10px 2px 2px"><strong>健康检查</strong> ' + okN + '/' + (dt.enabled || dt.total || 0) + ' 在线，共 ' + (dt.total || 0) + ' 个</div>'
    var h = '<h3><i class="fas fa-heartbeat c-p"></i> MCP 健康检查</h3>' + summary + '<div class="mcph-list">' + rows + '</div><div class="panel-actions"><div><button class="btn btn-p" onclick="closeM()">关闭</button></div></div>'
    showM(h)
  }).catch(function () { toast('健康检查请求失败', 'error') })
}
// 批量导入：粘贴 JSON 数组（[{name,url,httpHeaders,enabled},...]）一次注册多个
function mcpBatchImport() {
  var sample = '[{"name":"github","url":"https://api.githubcopilot.com/mcp/","httpHeaders":{"Authorization":"Bearer TOKEN"},"enabled":true}]'
  var h = '<h3><i class="fas fa-file-import c-p"></i> 批量导入 MCP</h3>'
  h += '<div class="fg"><label>JSON 数组（每个元素含 name/url，可选 httpHeaders/enabled）</label><textarea id="mcp-batch-json" rows="10" placeholder="' + escapeHtml(sample) + '"></textarea><span class="form-helper">一条即一个 MCP Server；格式非法的条目会自动跳过并在结果中说明。单次最多 200 个。</span></div>'
  h += '<div class="panel-actions"><div><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="mcpBatchSubmit()"><i class="fas fa-file-import" aria-hidden="true"></i>导入</button></div></div>'
  showM(h)
}
function mcpBatchSubmit() {
  var raw = document.getElementById('mcp-batch-json').value.trim()
  var list
  try { list = JSON.parse(raw) } catch (e) { toast('JSON 解析失败：' + e.message, 'error'); return }
  if (!Array.isArray(list) || list.length === 0) { toast('请输入非空数组', 'error'); return }
  fetch('/admin/api/mcps/batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list)
  }).then(function (r) { return r.json() }).then(function (d) {
    if (!d.success) { toast(d.message || '导入失败', 'error'); return }
    var info = '成功导入 ' + d.data.created + ' 个'
    if ((d.data.failed || []).length) info += '，跳过 ' + d.data.failed.length + ' 个'
    closeM(); toast(info, 'success')
    if (d.data.created > 0) setTimeout(function () { reloadAdmin() }, 300)
  }).catch(function () { toast('网络错误', 'error') })
}

// ===== 联合模型（uni-model）管理 =====
function unimodelFind(id) {
  for (var i = 0; i < UNIMODELS.length; i++) if (UNIMODELS[i].id === id) return UNIMODELS[i]
  return null
}
function unimodelModelGrid(selected) {
  var sel = selected || []
  if (!VB_MODELS || VB_MODELS.length === 0) return '<span class="mu">暂无已启用模型，请先在「提供商」中配置并启用模型</span>'
  return VB_MODELS.map(function (ref) {
    var checked = sel.indexOf(ref) >= 0 ? ' checked' : ''
    return '<label class="mdl-item um-item" title="' + escapeHtml(ref) + '"><input type="checkbox" class="um-ref" value="' + escapeHtml(ref) + '"' + checked + '><span class="fx1">' + escapeHtml(ref) + '</span></label>'
  }).join('')
}
function unimodelFormModal(u) {
  var h = '<h3><i class="fas fa-layer-group c-p"></i> ' + (u ? '编辑联合模型' : '添加联合模型') + '</h3>'
  h += '<div class="fg"><label>名称</label><input type="text" id="um-name" value="' + (u ? escapeHtml(u.name) : '') + '" placeholder="如：free-flash"><span class="form-helper">调用模型 ID 为 unimodel/名称</span></div>'
  h += '<div class="fg"><label>候选模型（勾选顺序即 failover 尝试顺序，从上到下）</label><div id="um-models" class="grid-2-gap6">' + unimodelModelGrid(u ? (u.models || []) : []) + '</div><span class="form-helper">从已启用模型的列表中直接勾选，候选引用为 providerId/modelId；全部失败返回 unimodel_exhausted。</span></div>'
  h += '<div class="panel-actions"><label class="switch-label"><span>启用</span><span class="tg"><input type="checkbox" id="um-enabled"' + (!u || u.enabled ? ' checked' : '') + '><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="unimodelSave(\\'' + (u ? escapeJsAttr(u.id) : '') + '\\')">保存</button></div></div>'
  showM(h)
}
function unimodelEdit(id) { unimodelFormModal(unimodelFind(id)) }
function unimodelSave(id) {
  var name = document.getElementById('um-name').value.trim()
  var enabled = document.getElementById('um-enabled').checked
  var models = Array.prototype.map.call(document.querySelectorAll('#um-models input.um-ref:checked'), function (c) { return c.value })
  if (!name) { toast('名称为必填项', 'error'); return }
  if (models.length === 0) { toast('至少需要一个候选模型', 'error'); return }
  var payload = { name: name, models: models, enabled: enabled }
  fetch(id ? '/admin/api/unimodels/' + encodeURIComponent(id) : '/admin/api/unimodels', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json() }).then(function (d) {
    if (d.success) { closeM(); toast('保存成功', 'success'); setTimeout(function () { reloadAdmin() }, 300) }
    else { toast(d.message || '保存失败', 'error') }
  }).catch(function () { toast('网络错误', 'error') })
}
function unimodelToggle(id, checked) {
  fetch('/admin/api/unimodels/' + encodeURIComponent(id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  }).then(function (r) { return r.json() }).then(function (d) {
    if (d.success) toast(checked ? '已启用' : '已禁用', 'success')
    else toast(d.message || '操作失败', 'error')
  })
}
function unimodelDel(id) {
  cM('确认删除该联合模型？').then(function (ok) {
    if (!ok) return
    fetch('/admin/api/unimodels/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) { return r.json() })
      .then(function (d) { if (d.success) { toast('已删除', 'success'); setTimeout(function () { reloadAdmin() }, 300) } else toast(d.message || '删除失败', 'error') })
  })
}

// ===== 内存缓存管理（P4） =====
async function loadCache() {
  const el = document.getElementById('cache-list')
  if (!el) return
  const r = await fetch('/admin/api/cache')
  const d = await r.json()
  if (!d.success) { el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>加载失败</h3><p>' + escapeHtml(d.message || '') + '</p></div>'; return }
  const entries = d.data || []
  if (entries.length === 0) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-memory" aria-hidden="true"></i><h3>暂无缓存条目</h3><p>访问过 /v1 接口后，提供商配置与转发 Key 会进入 10s 内存缓存，届时可在此查看与管理。</p></div>'
    return
  }
  el.innerHTML = entries.map(function (e) {
    var age = Math.round(e.ageMs / 1000)
    var ttl = Math.round(e.ttlMs / 1000)
    return '<article class="ki" data-key="' + escapeHtml(e.key) + '"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-memory"></i></span><div><h3>' + escapeHtml(e.label) + '</h3><p>大小 ' + (e.size / 1024).toFixed(1) + ' KB · 已缓存 ' + age + 's / TTL ' + ttl + 's · KV key: <code>' + escapeHtml(e.key) + '</code></p></div></div><div class="key-actions"><button class="btn btn-d btn-xs" onclick="cacheDel(\\'' + escapeJsAttr(e.key) + '\\')"><i class="fas fa-trash" aria-hidden="true"></i>清除</button></div></article>'
  }).join('')
}
function cacheDel(key) {
  fetch('/admin/api/cache/' + encodeURIComponent(key), { method: 'DELETE' }).then(function (r) { return r.json() })
    .then(function (d) { if (d.success) { toast('已清除', 'success'); loadCache() } else toast(d.message || '清除失败', 'error') })
}
function cacheClear() {
  cM('确认清空全部内存缓存？下次请求将重新从 KV 读取。').then(function (ok) {
    if (!ok) return
    fetch('/admin/api/cache', { method: 'DELETE' }).then(function (r) { return r.json() })
      .then(function (d) { if (d.success) { toast(d.message || '已清空', 'success'); loadCache() } else toast(d.message || '清空失败', 'error') })
  })
}
// 与签到面板一致：页面加载时加载一次；进入 #cache 锚点时刷新
function maybeLoadCache(hash) { if (hash === '#cache') loadCache() }
window.addEventListener('hashchange', function () { maybeLoadCache(location.hash) })
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#cache') {
    link.addEventListener('click', function () { setTimeout(loadCache, 50) })
  }
})

// ===== 思维引导提示词设置 =====
async function loadThinkingPrompt() {
  const el = document.getElementById('thinking-prompt'), st = document.getElementById('thinking-state')
  if (!el) return
  try {
    const r = await fetch('/admin/api/thinking-prompt')
    const d = await r.json()
    if (!d.success) { el.value = ''; if (st) st.textContent = '加载失败'; return }
    el.value = d.data.prompt || ''
    if (st) st.textContent = d.data.isCustom ? '已自定义' : '使用内置默认'
  } catch (e) { el.value = ''; if (st) st.textContent = '加载失败' }
}
async function saveThinkingPrompt() {
  const el = document.getElementById('thinking-prompt'), out = document.getElementById('thinking-result')
  if (!el) return
  if (out) { out.textContent = ''; out.style.color = '' }
  try {
    const r = await fetch('/admin/api/thinking-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: el.value })
    })
    const d = await r.json()
    if (d.success) { toast('已保存（最多 10s 生效）', 'success'); loadThinkingPrompt() }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
}
function resetThinkingPrompt() {
  cM('恢复为内置默认提示词？当前自定义内容将被清空。').then(function (ok) {
    if (!ok) return
    const el = document.getElementById('thinking-prompt')
    if (el) el.value = ''
    saveThinkingPrompt()
  })
}
function maybeLoadThinking(hash) { if (hash === '#thinking') loadThinkingPrompt() }
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#thinking') {
    link.addEventListener('click', function () { setTimeout(loadThinkingPrompt, 50) })
  }
})
window.addEventListener('hashchange', function () { maybeLoadThinking(location.hash) })
setTimeout(loadThinkingPrompt, 100)
// ===== 缓存前缀设置 =====
async function loadCachePrefix() {
  const el = document.getElementById('cache-prefix-text'), st = document.getElementById('cache-prefix-state')
  if (!el) return
  try {
    const r = await fetch('/admin/api/cache-prefix')
    const d = await r.json()
    if (!d.success) { el.value = ''; if (st) st.textContent = '加载失败'; return }
    el.value = d.data.prefix || ''
    if (st) st.textContent = d.data.isCustom ? '已自定义' : '使用内置默认'
  } catch (e) { el.value = ''; if (st) st.textContent = '加载失败' }
}
async function saveCachePrefix() {
  const el = document.getElementById('cache-prefix-text'), out = document.getElementById('cache-prefix-result')
  if (!el) return
  if (out) { out.textContent = ''; out.style.color = '' }
  try {
    const r = await fetch('/admin/api/cache-prefix', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: el.value })
    })
    const d = await r.json()
    if (d.success) { toast('已保存（最多 10s 生效）', 'success'); loadCachePrefix() }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
}
function resetCachePrefix() {
  cM('恢复为内置默认缓存前缀？当前自定义内容将被清空。').then(function (ok) {
    if (!ok) return
    const el = document.getElementById('cache-prefix-text')
    if (el) el.value = ''
    saveCachePrefix()
  })
}
function maybeLoadCachePrefix(hash) { if (hash === '#cache-prefix') loadCachePrefix() }
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#cache-prefix') {
    link.addEventListener('click', function () { setTimeout(loadCachePrefix, 50) })
  }
})
window.addEventListener('hashchange', function () { maybeLoadCachePrefix(location.hash) })
setTimeout(loadCachePrefix, 100)
// ===== 性能设置 =====
let perfDefaults = {}
async function loadPerfSettings() {
  const els = ['perf-total', 'perf-connect', 'perf-idle', 'perf-keepalive'].map(id => document.getElementById(id))
  const st = document.getElementById('perf-state')
  if (els.some(e => !e)) return
  try {
    const r = await fetch('/admin/api/perf-settings')
    const d = await r.json()
    if (!d.success) { if (st) st.textContent = '加载失败'; return }
    const s = d.data.settings || {}
    perfDefaults = d.data.defaults || {}
    els[0].value = s.totalTimeoutMs; els[1].value = s.connectTimeoutMs
    els[2].value = s.idleTimeoutMs; els[3].value = s.keepAliveMs
    if (st) st.textContent = d.data.isCustom ? '已自定义' : '使用内置默认'
  } catch (e) { if (st) st.textContent = '加载失败' }
}
async function savePerfSettings() {
  const out = document.getElementById('perf-result')
  if (out) { out.textContent = ''; out.style.color = '' }
  const settings = {
    totalTimeoutMs: parseInt(document.getElementById('perf-total').value) || undefined,
    connectTimeoutMs: parseInt(document.getElementById('perf-connect').value) || undefined,
    idleTimeoutMs: parseInt(document.getElementById('perf-idle').value) || undefined,
    keepAliveMs: parseInt(document.getElementById('perf-keepalive').value) || 0,
  }
  try {
    const r = await fetch('/admin/api/perf-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    })
    const d = await r.json()
    if (d.success) { toast('已保存（最多 10s 生效）', 'success'); loadPerfSettings() }
    else toast(d.message || '保存失败', 'error')
  } catch (e) { toast('保存失败', 'error') }
}
function resetPerfSettings() {
  cM('恢复为内置默认性能设置？当前自定义值将被清空。').then(function (ok) {
    if (!ok) return
    document.getElementById('perf-total').value = perfDefaults.totalTimeoutMs
    document.getElementById('perf-connect').value = perfDefaults.connectTimeoutMs
    document.getElementById('perf-idle').value = perfDefaults.idleTimeoutMs
    document.getElementById('perf-keepalive').value = perfDefaults.keepAliveMs
    savePerfSettings()
  })
}
function maybeLoadPerf(hash) { if (hash === '#perf') loadPerfSettings() }
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#perf') {
    link.addEventListener('click', function () { setTimeout(loadPerfSettings, 50) })
  }
})
window.addEventListener('hashchange', function () { maybeLoadPerf(location.hash) })
setTimeout(loadPerfSettings, 100)
// ===== Qoder 真机设备身份（原 COSY_* Secret；配置块挂在 Qoder 提供商卡片里，无独立菜单） =====
/* QODER_DEV_BEGIN */
// 设备身份是**机器级全局配置**（KV qoder:device），不按提供商存值：一个 Qoder 卡片保存后，
// 另一张卡片重新加载看到的是同一份。作用域一律按容器（[data-qoder-device]）找，而不是固定 id——
// 旧实现用固定 id（qd- 前缀 + 字段名），页面上一旦出现第二个 Qoder 提供商就会撞 id（后者覆盖前者，
// 用户改的其实是同一份数据却看到两个不同的框）。
function qoderDeviceBlock(btn) {
  return (btn && btn.closest) ? btn.closest('[data-qoder-device]') : null
}
function qoderDeviceInputs(block) {
  if (!block) return []
  return Array.prototype.slice.call(block.querySelectorAll('.qoder-device-input'))
}
// 键名归一：去掉 cosy 前缀与非字母数字，于是 config.json 的 camelCase、
// COSY_MACHINE_TOKEN 这类环境变量写法、build-manifest.json 的 productVersion 都能对上。
// **只用于匹配「粘贴进来的 JSON」**，绝不能用在出站载荷上（见 qoderDevicePayload）。
function qoderDeviceKey(v) {
  var k = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (k.indexOf('cosy') === 0) k = k.slice(4)
  if (k === 'productversion' || k === 'clientversion' || k === 'appversion') k = 'version'
  return k
}
// 出站载荷：键名必须与后端 normalizeQoderDevice 的已知键**逐字相同**（camelCase），
// 所以这里直接用 data-key 原值，不归一。
// 踩过的坑（2026-10-02）：这里若写成 qoderDeviceKey(el.getAttribute('data-key'))，
// 键名会变成 'clienttype' 这类全小写 → 后端只认已知键、整包被丢弃 → 归一结果为空 →
// setQoderDevice 判定「用户清空了」而**删掉 KV**（连之前配好的真机身份一起清），
// 面板上只表现为「填好点保存，刷新后一片空白」，没有任何报错。后端现在也会 400 拦住它。
function qoderDevicePayload(block) {
  var device = {}
  qoderDeviceInputs(block).forEach(function (el) { device[el.getAttribute('data-key')] = el.value })
  return device
}
// 回填：同样按 data-key 原值取——用归一后的键名取不到（同一个坑的另一半，表现为保存成功也不回填）。
function qoderDeviceApply(block, dev) {
  var d = dev || {}
  qoderDeviceInputs(block).forEach(function (el) { el.value = d[el.getAttribute('data-key')] || '' })
}
function qoderDeviceFillFromJson(btn) {
  var block = qoderDeviceBlock(btn)
  if (!block) return
  var ta = block.querySelector('.qoder-device-json')
  var out = block.querySelector('.qoder-device-result')
  if (!ta) return
  var parsed
  try { parsed = JSON.parse(ta.value) } catch (e) { toast('JSON 解析失败：' + e.message, 'error'); return }
  var src = (parsed && parsed.device && typeof parsed.device === 'object') ? parsed.device : parsed
  if (!src || typeof src !== 'object') { toast('没找到 device 对象', 'error'); return }
  var map = {}
  Object.keys(src).forEach(function (k) { map[qoderDeviceKey(k)] = src[k] })
  var filled = 0
  qoderDeviceInputs(block).forEach(function (el) {
    var v = map[qoderDeviceKey(el.getAttribute('data-key'))]
    if (typeof v !== 'string' || !v.trim()) return
    el.value = v.trim()
    filled++
  })
  if (out) { out.style.color = ''; out.textContent = filled ? ('已填充 ' + filled + ' 个字段，核对后点「保存」') : '没识别到任何字段，请检查粘贴内容' }
  if (!filled) toast('没识别到任何字段', 'error')
}
/* QODER_DEV_END */
async function loadQoderDeviceBlock(block) {
  if (!block) return
  var st = block.querySelector('.qoder-device-state')
  try {
    var r = await fetch('/admin/api/qoder-device')
    var d = await r.json()
    if (!d.success) { if (st) st.textContent = '加载失败'; return }
    qoderDeviceApply(block, d.data && d.data.device)
    if (st) st.textContent = (d.data && d.data.isCustom) ? '已配置真机身份（签到日志 deviceIdentity=native）' : '未配置：正在用 uid 派生值，拿不到每日活动'
  } catch (e) { if (st) st.textContent = '加载失败' }
}
// 页面加载即拉取：配置块在提供商卡片里，卡片可能处于折叠状态——元素仍在 DOM 中，直接填即可。
function loadQoderDevices() {
  document.querySelectorAll('[data-qoder-device]').forEach(function (block) { loadQoderDeviceBlock(block) })
}
async function saveQoderDevice(btn) {
  var block = qoderDeviceBlock(btn)
  if (!block) return
  var out = block.querySelector('.qoder-device-result')
  if (out) { out.textContent = ''; out.style.color = '' }
  var device = qoderDevicePayload(block)
  try {
    var r = await fetch('/admin/api/qoder-device', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: device })
    })
    var d = await r.json()
    if (d.success) { toast('已保存（下次签到生效）', 'success'); loadQoderDeviceBlock(block) }
    else {
      // 400 = 键名不被识别（后端拒绝保存以免清空已配置的身份）：必须显示出来，
      // 否则用户看到的就是「点了保存、什么也没发生、刷新后还是空的」。
      if (out) { out.style.color = 'var(--color-danger,#ef4444)'; out.textContent = d.message || '保存失败' }
      toast(d.message || '保存失败', 'error')
    }
  } catch (e) { toast('保存失败', 'error') }
}
// 复制内置的提取脚本：内容来自卡片里的 <pre>（textContent 已还原 &amp; 实体，复制出来可直接运行）
function copyQoderExtractScript(btn) {
  var block = qoderDeviceBlock(btn)
  var pre = block ? block.querySelector('.qoder-extract-script') : null
  if (!pre) { toast('没找到脚本内容', 'error'); return }
  copyText(pre.textContent, btn)
}
function resetQoderDevice(btn) {
  var block = qoderDeviceBlock(btn)
  if (!block) return
  cM('清空 Qoder 设备身份？清空后回退 uid 派生值，拿不到「每日领取 100 Credits」。').then(function (ok) {
    if (!ok) return
    qoderDeviceInputs(block).forEach(function (el) { el.value = '' })
    var ta = block.querySelector('.qoder-device-json')
    if (ta) ta.value = ''
    saveQoderDevice(btn)
  })
}
setTimeout(loadQoderDevices, 100)
setTimeout(loadCache, 0)
</script>
</body></html>`)
}
