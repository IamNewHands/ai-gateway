import { Context } from 'hono'
import { getProviders, getProxyKeys, getMcps, getUnimodels } from './storage'
import { SITE_CONFIG, OPENCODE_DEFAULT_URL } from './config'
import type { AppEnv, OAuthDeviceConfig } from './types'
import { CSS_CONTENT } from './pages.css'
import { SHARED_JS, renderSiteFooter } from './shared.js'
import { ANALYTICS_JS } from './analytics-ui.js'

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

// UX8：厂商预设与 OAuth 预置模板——单一数据源。
// SSR 下拉 option 与客户端 applyProviderPreset / applyOauthPreset* 共用，
// 注入为页面 script 常量，消除服务端/客户端两套重复预设表。
const PROVIDER_PRESETS: Record<string, { name: string; id: string; baseUrl: string; apiType: string; authType?: string; oauthPreset?: string; models?: string[]; toolBridge?: boolean }> = {
  deepseek:     { name: 'DeepSeek',           id: 'deepseek',     baseUrl: 'https://api.deepseek.com',                          apiType: 'openai' },
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
  openrouter:   { name: 'OpenRouter',         id: 'openrouter',   baseUrl: 'https://openrouter.ai/api/v1',                      apiType: 'openai' },
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
    models: ['poolside/laguna-s-2.1:free', 'deepseek/deepseek-v4-flash', 'cline-free/glm-5.2', 'cline-pass/glm-5.2', 'cline-pass/deepseek-v4-flash', 'cline-pass/qwen3.7-max'],
  },
  cnb:          { name: 'CNB (免费 deepseek-v4)', id: 'cnb',       baseUrl: 'https://cnb.cool',                                   apiType: 'openai', toolBridge: true,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  visionbridge: { name: 'Vision Bridge (图片转写桥)', id: 'visionbridge', baseUrl: 'https://example.com/v1', apiType: 'openai' },
  m365:         { name: 'M365 Copilot (OAuth)',   id: 'm365',         baseUrl: 'https://substrate.office.com',                     apiType: 'openai', authType: 'oauth-device', oauthPreset: 'm365' },
  trae:         { name: 'TRAE SOLO (多账号反代)', id: 'trae',         baseUrl: 'https://trae-api-cn.mchost.guru',                  apiType: 'openai',
    models: ['glm-5.2', 'glm-5-turbo', 'glm-5', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Flash-Official', 'DeepSeek-V4', 'kimi-k3', 'kimi-k2.7-code', 'qwen-3.7-plus', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.0-Code', 'minimax-m3'],
  },
}

const OAUTH_PRESETS: Record<string, { label: string; flowType: string; deviceCodeUrl: string; deviceTokenUrl: string; refreshTokenUrl: string; clientId: string; clientSecret?: string; scope?: string; tokenHeader: string; tokenHeaderPrefix: string; extraHeaders: Record<string, string>; _baseUrl?: string; _modelsUrl?: string; _globalBaseUrl?: string; _globalModelsUrl?: string; _globalOrigin?: string; _redirectUri?: string }> = {
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
  },
  gemini: {
    label: 'Gemini（官方 OAuth）',
    flowType: 'gemini',
    deviceCodeUrl: '',
    deviceTokenUrl: '',
    refreshTokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
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

// ===== 首页 =====

export async function renderHomePage(c: Context<AppEnv>, isLoggedIn: boolean) {
  // 首页仅展示占位示例，不暴露真实部署域名，避免泄露隐私链接
  const apiBase = 'https://自定义的域名/v1'

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('首页')}
<body class="site-page home-page">
<header class="topbar">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">API CONTROL PLANE</span>
    </a>
    <nav class="topbar__actions" aria-label="主导航">
      ${isLoggedIn
        ? `<a href="/admin" class="btn btn-p"><i class="fas fa-sliders-h" aria-hidden="true"></i>管理控制台</a><a href="javascript:void(0)" onclick="doLogout()" class="btn btn-gh"><i class="fas fa-sign-out-alt" aria-hidden="true"></i>退出</a>`
        : `<a href="/admin/login" class="btn btn-p"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>管理员登录</a>`
      }
    </nav>
  </div>
</header>

<main>
  <section class="shell home-hero" aria-labelledby="home-title">
    <div class="home-hero__copy">
      <p class="eyebrow"><span aria-hidden="true"></span>UNIFIED AI GATEWAY</p>
      <h1 id="home-title">一个 API，调用已配置的所有模型。</h1>
      <p class="home-hero__lede">统一的 OpenAI / Anthropic 兼容入口。模型按提供商归档，转发 Key、启用状态和故障转移集中管理。</p>
      <div class="endpoint-box" aria-label="API 接入地址">
        <span class="endpoint-box__label">BASE URL</span>
        <code>${escapePageHtml(apiBase)}</code>
        <button class="icon-btn copy-control" type="button" data-copy="${escapePageHtml(apiBase)}" aria-label="复制 API 地址">
          <i class="far fa-copy" aria-hidden="true"></i><span>复制</span>
        </button>
      </div>
      <p id="copy-status" class="sr-status" aria-live="polite"></p>
    </div>

    <figure class="request-panel" aria-labelledby="request-caption">
      <figcaption id="request-caption">
        <span>POST /chat/completions</span>
        <span class="protocol-state"><i aria-hidden="true"></i>OPENAI COMPATIBLE</span>
      </figcaption>
      <pre><code><span class="syntax-command">curl</span> ${escapePageHtml(apiBase)}/chat/completions \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Authorization: Bearer sk_cf_••••"</span> \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Content-Type: application/json"</span> \\
  <span class="syntax-key">-d</span> <span class="syntax-string">'{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'</span></code></pre>
      <div class="request-panel__foot">
        <span>模型格式</span>
        <code>provider/model</code>
      </div>
    </figure>
  </section>
</main>

<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© ${new Date().getFullYear()} ${SITE_CONFIG.title}</span>
    <span>Cloudflare Workers · Hono · KV</span>
  </div>
</footer>

<script>
(function () {
  var status = document.getElementById('copy-status')
  document.querySelectorAll('.copy-control').forEach(function (button) {
    button.addEventListener('click', async function () {
      var text = button.getAttribute('data-copy') || ''
      var icon = button.querySelector('i')
      var label = button.querySelector('span')
      try {
        await navigator.clipboard.writeText(text)
        button.setAttribute('data-state', 'success')
        if (icon) icon.className = 'fas fa-check'
        if (label) label.textContent = '已复制'
        if (status) status.textContent = '已复制 ' + text
        window.setTimeout(function () {
          button.removeAttribute('data-state')
          if (icon) icon.className = 'far fa-copy'
          if (label) label.textContent = '复制'
        }, 1800)
      } catch (error) {
        button.setAttribute('data-state', 'error')
        if (status) status.textContent = '复制失败，请手动选择文本。'
      }
    })
  })
})()
// S5：logout 已改 POST-only（GET 易被链接型 CSRF 触发），退出统一走这里
function doLogout() {
  fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' })
    .catch(function () { /* 忽略网络错误 */ })
    .then(function () { location.href = '/admin/login' })
}
</script>
</body></html>`)
}

// ===== 登录页 =====

export async function renderLoginPage(c: Context<AppEnv>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('登录')}
<body class="site-page auth-page">
<header class="topbar topbar--auth">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
    </a>
    <a href="/" class="btn btn-gh"><i class="fas fa-arrow-left" aria-hidden="true"></i>返回首页</a>
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
      <a class="admin-nav__link" href="#providers"><i class="fas fa-server" aria-hidden="true"></i><span>提供商</span><b>${providers.length}</b></a>
      <a class="admin-nav__link" href="#proxy-keys"><i class="fas fa-key" aria-hidden="true"></i><span>转发 Key</span><b>${proxyKeys.length}</b></a>
      <a class="admin-nav__link" href="#analytics"><i class="fas fa-chart-bar" aria-hidden="true"></i><span>使用统计</span></a>
      <a class="admin-nav__link" href="#usage-logs"><i class="fas fa-clipboard-list" aria-hidden="true"></i><span>详细日志</span></a>
      <a class="admin-nav__link" href="#logs"><i class="fas fa-list-alt" aria-hidden="true"></i><span>系统日志</span></a>
<a class="admin-nav__link" href="#checkin"><i class="fas fa-calendar-check" aria-hidden="true"></i><span>签到</span><b>${providers.filter((p:any)=>p.authType==='oauth-device'&&p.oauth&&p.oauth.flowType!=='m365-pkce'&&p.oauth.flowType!=='m365-ropc').length}</b></a>
      <a class="admin-nav__link" href="#mcps"><i class="fas fa-boxes" aria-hidden="true"></i><span>MCP 网关</span><b>${mcps.length}</b></a>
      <a class="admin-nav__link" href="#unimodels"><i class="fas fa-layer-group" aria-hidden="true"></i><span>联合模型</span><b>${unimodels.length}</b></a>
      <a class="admin-nav__link" href="#cache"><i class="fas fa-memory" aria-hidden="true"></i><span>内存缓存</span></a>
    </nav>
    <div class="admin-rail__foot">
      <a href="/" class="admin-nav__link"><i class="fas fa-arrow-left" aria-hidden="true"></i><span>返回首页</span></a>
      <a href="javascript:void(0)" onclick="doLogout()" class="admin-nav__link"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>

  <div class="admin-main">
    <header class="admin-topbar">
      <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span><span class="brand__name">${SITE_CONFIG.title}</span></a>
      <nav aria-label="移动端控制台导航"><a href="#overview">概览</a><a href="#providers">提供商</a><a href="#proxy-keys">Key</a><a href="#analytics">统计</a><a href="#usage-logs">日志</a><a href="#checkin">签到</a><a href="#mcps">MCP</a><a href="#unimodels">联合</a><a href="#cache">缓存</a><a href="#logs">系统日志</a></nav>
      <a class="icon-btn" href="javascript:void(0)" onclick="doLogout()" aria-label="退出登录"><i class="fas fa-sign-out-alt" aria-hidden="true"></i></a>
    </header>

    <main class="admin-content">
      <div id="toast" class="hd toast" role="status" aria-live="polite"></div>

      <section id="overview" class="admin-overview" aria-labelledby="admin-title">
        <div class="admin-heading">
          <div><p class="eyebrow"><span aria-hidden="true"></span>GATEWAY STATUS</p><h1 id="admin-title">管理控制台</h1><p>配置提供商、模型与客户端访问凭据。变更将写入 Cloudflare KV。</p></div>
          <div class="admin-heading__actions"><a href="/" class="btn btn-s"><i class="fas fa-external-link-alt" aria-hidden="true"></i>查看模型目录</a><button class="btn btn-p" onclick="showAdd();location.hash='providers'"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button></div>
        </div>
        <div class="admin-metrics" aria-label="配置统计">
          <div><span>${providers.length}</span><p>提供商</p><small>${enabledProvidersCount} 个已启用</small></div>
          <div><span>${modelsCount}</span><p>模型</p><small>${enabledModelsCount} 个可用</small></div>
          <div><span>${proxyKeys.length}</span><p>转发 Key</p><small>${enabledProxyKeysCount} 个可用</small></div>
          <div><span class="status-dot status-dot--online"><i aria-hidden="true"></i>已配置</span><p>存储</p><small>Cloudflare KV</small></div>
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
                <div class="fg"><label>登录流程类型</label><select id="ao8" class="select-sm"><option value="device">设备码（RFC 8628）</option><option value="browser">浏览器登录（WorkBuddy）</option><option value="qoder">Qoder 设备授权（QoderWork）</option><option value="gemini">Gemini 授权码（Gemini CLI）</option><option value="m365-pkce">M365 授权码（PKCE）</option><option value="m365-ropc">M365 账号密码（ROPC）</option></select></div>
                <div class="fg"><label>发起端点 (deviceCodeUrl)</label><input type="url" id="ao1" placeholder="https://.../auth/device/code"></div>
                <div class="fg"><label>轮询端点 (deviceTokenUrl)</label><input type="url" id="ao2" placeholder="https://.../auth/device/token"></div>
                <div class="fg"><label>Token 刷新端点 (refreshTokenUrl)</label><input type="url" id="ao3" placeholder="https://.../auth/oauth_token/refresh"></div>
                <div class="fg"><label>Client ID</label><input type="text" id="ao4" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                <div class="fg"><label>Client Secret（可选）</label><input type="text" id="ao14" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"></div>
                <div class="fg"><label>Scope（可选）</label><input type="text" id="ao5" placeholder="如 user"></div>
                <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="ao6" placeholder="x-api-key"></div>
                <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="ao9" placeholder="如 Bearer （含尾空格）"></div>
                <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="ao7" rows="3" placeholder='{"x-app-name":"my-app","x-app-version":"1.0.0"}'></textarea></div>
                <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="ao10" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"><span class="form-helper">登录后从此地址动态拉取可用模型；WorkBuddy 等自定义 API 需填写。</span></div>
                <div class="fg"><label>Global 域配置（海外账户，可选）</label><span class="form-helper">Token 为 workbuddy.ai 域时使用以下端点，留空则不区分域。WorkBuddy 预设会自动填充。</span></div>
                <div class="fg"><label>Global 域 baseUrl</label><input type="url" id="ao11" placeholder="https://www.workbuddy.ai/v2"></div>
                <div class="fg"><label>Global 域模型 URL</label><input type="url" id="ao12" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                <div class="fg"><label>Global 域 Origin</label><input type="url" id="ao13" placeholder="https://www.workbuddy.ai"></div>
                <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPreset(this.value)"><option value="">— 选择 —</option>${Object.entries(OAUTH_PRESETS).map(([k, pre]) => `<option value="${k}">${escapePageHtml(pre.label)}</option>`).join('')}</select></div>
                <div class="fc mt-1 field-row"><button class="btn btn-p" onclick="createProv({afterCreate:function(id){location.href='/admin?connect='+encodeURIComponent(id)}})"><i class="fas fa-plug" aria-hidden="true"></i>创建并发起连接</button><span class="form-helper">先创建提供商，保存后自动弹出 OAuth 登录链接；登录成功会自动拉取模型。</span></div>
              </fieldset>
            </div>
            <fieldset class="form-group" id="akeys-fs"><legend id="akey-legend">上游 API Keys</legend><div id="akeys"><div class="fc mb-4 field-row"><input type="password" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewAKey(this)" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addAKeyRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加 Key</button><span id="akey-hint" class="form-helper"></span></fieldset>
            <fieldset class="form-group" id="amodels-fs"><legend>模型 ID</legend><div id="amodels"><div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addMdlRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加模型</button></fieldset>
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
            <fieldset class="form-group" id="atb-fs"><legend>工具桥</legend><label class="switch-label"><span>启用工具桥（XYML 提示词注入 + 流式解析回 tool_calls，仅 CNB 需要）</span><span class="tg"><input type="checkbox" id="atb"><span class="sl"></span></span></label></fieldset>
            <fieldset class="form-group" id="aum-fs"><legend>模型策略</legend><label class="switch-label"><span>允许未配置模型透传——开启后请求该提供商的任意 modelId 都直接转发（跳过「未配置」校验），适合模型频繁上架、不想每次手动加模型的提供商（如 OpenRouter）。</span><span class="tg"><input type="checkbox" id="aum"><span class="sl"></span></span></label></fieldset>
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
              <div class="fg"><label>API 格式</label><select id="at-${escapePageHtml(p.id)}" class="select-sm"><option value="openai" ${(p.apiType||'openai')==='openai'?'selected':''}>OpenAI 兼容</option><option value="anthropic" ${p.apiType==='anthropic'?'selected':''}>Anthropic 兼容</option></select></div>
              <div class="fg"><label>认证方式</label><select id="auth-${escapePageHtml(p.id)}" class="select-sm" onchange="toggleAuthTypeEdit('${escapePageJsx(p.id)}')"><option value="api-key" ${(p.authType||'api-key')==='api-key'?'selected':''}>API Key</option><option value="oauth-device" ${p.authType==='oauth-device'?'selected':''}>OAuth 设备码登录</option></select></div>
              <div id="oauth-edit-${escapePageHtml(p.id)}" class="${p.authType==='oauth-device'?'form-group':'hd form-group'}">
                <fieldset class="form-group"><legend>OAuth 配置</legend>
                  <div class="fg"><label>登录流程类型</label><select id="eao8-${escapePageHtml(p.id)}" class="select-sm"><option value="device" ${((p.oauth&&p.oauth.flowType)||'device')==='device'?'selected':''}>设备码（RFC 8628）</option><option value="browser" ${(p.oauth&&p.oauth.flowType)==='browser'?'selected':''}>浏览器登录（WorkBuddy）</option><option value="qoder" ${(p.oauth&&p.oauth.flowType)==='qoder'?'selected':''}>Qoder 设备授权（QoderWork）</option><option value="gemini" ${(p.oauth&&p.oauth.flowType)==='gemini'?'selected':''}>Gemini 授权码（Gemini CLI）</option><option value="m365-pkce" ${(p.oauth&&p.oauth.flowType)==='m365-pkce'?'selected':''}>M365 授权码（PKCE）</option><option value="m365-ropc" ${(p.oauth&&p.oauth.flowType)==='m365-ropc'?'selected':''}>M365 账号密码（ROPC）</option></select></div>
                  <div class="fg"><label>发起端点</label><input type="url" id="eao1-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceCodeUrl)||'')}" placeholder="https://.../auth/device/code"></div>
                  <div class="fg"><label>轮询端点</label><input type="url" id="eao2-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceTokenUrl)||'')}" placeholder="https://.../auth/device/token"></div>
                  <div class="fg"><label>Token 刷新端点</label><input type="url" id="eao3-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.refreshTokenUrl)||'')}" placeholder="https://.../auth/oauth_token/refresh"></div>
                  <div class="fg"><label>Client ID</label><input type="text" id="eao4-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientId)||'')}" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                  <div class="fg"><label>Client Secret（可选）</label><input type="text" id="eao14-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientSecret)||'')}" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"></div>
                  <div class="fg"><label>Scope（可选）</label><input type="text" id="eao5-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.scope)||'')}" placeholder="如 user"></div>
                  <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="eao6-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeader)||'x-api-key')}" placeholder="x-api-key"></div>
                  <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="eao9-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeaderPrefix)||'')}" placeholder="如 Bearer （含尾空格）"></div>
                  <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="eao7-${escapePageHtml(p.id)}" rows="3" placeholder='{"x-app-name":"my-app"}'>${escapePageHtml((p.oauth&&JSON.stringify(p.oauth.extraHeaders||{}))||'')}</textarea></div>
                  <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="eao10-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.modelsUrl)||'')}" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"></div>
                  <div class="fg"><label>Global 域 baseUrl（海外账户，可选）</label><input type="url" id="eao11-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalBaseUrl)||'')}" placeholder="https://www.workbuddy.ai/v2"></div>
                  <div class="fg"><label>Global 域模型 URL（可选）</label><input type="url" id="eao12-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalModelsUrl)||'')}" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                  <div class="fg"><label>Global 域 Origin（可选）</label><input type="url" id="eao13-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalOrigin)||'')}" placeholder="https://www.workbuddy.ai"></div>
                  <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPresetEdit('${escapePageJsx(p.id)}',this.value)"><option value="" ${detectOauthPreset(p.oauth)===''?'selected':''}>— 选择 —</option>${Object.entries(OAUTH_PRESETS).map(([k, pre]) => `<option value="${k}" ${detectOauthPreset(p.oauth)===k?'selected':''}>${escapePageHtml(pre.label)}</option>`).join('')}</select></div>
                  <div class="fc mt-1 field-row"><button class="btn btn-s" onclick="oauthConnect('${escapePageJsx(p.id)}')"><i class="fas fa-plug" aria-hidden="true"></i>发起连接</button><button class="btn btn-gh" onclick="fetchOauthModels('${escapePageJsx(p.id)}')"><i class="fas fa-cloud-download-alt" aria-hidden="true"></i>获取模型</button><button class="btn btn-gh" onclick="oauthStatus('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>状态</button><button class="btn btn-gh" onclick="oauthDisconnect('${escapePageJsx(p.id)}')"><i class="fas fa-unlink" aria-hidden="true"></i>断开</button><span id="oauth-st-${escapePageHtml(p.id)}" class="oauth-status"></span></div>
                </fieldset>
              </div>
              <fieldset class="form-group ${p.authType==='oauth-device'?'hd':''}" id="keys-fs-${escapePageHtml(p.id)}"><legend id="key-legend-${escapePageHtml(p.id)}">${isTraeProviderUI(p)?'TRAE 账号凭证（每个账号一行 JSON）':(p.id==='cline'?'Cline RefreshTokens（每个账号一行）':'上游 API Keys')}</legend><div id="keys-${escapePageHtml(p.id)}">${p.apiKeys.map((k, ki)=>`<div class="fc mb-3 field-row" data-kidx="${ki}"><input type="password" value="${escapePageHtml(k.key)}" class="fx1" id="k-${escapePageHtml(p.id)}-${ki}" placeholder="API Key" aria-label="API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} id="ken-${escapePageHtml(p.id)}-${ki}" aria-label="启用 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testKeyRow('${escapePageJsx(p.id)}',${ki})" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="rmKeyRow('${escapePageJsx(p.id)}',${ki})" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="password" id="nk-${escapePageHtml(p.id)}" placeholder="${isTraeProviderUI(p)?'新的 TRAE 凭证 JSON（或点「登录账号」自动写入）':(p.id==='cline'?'新的 RefreshToken（一个账号一行）':'新的 API Key')}" class="fx1"><button class="btn btn-s btn-xs" onclick="addKeyRow('${escapePageJsx(p.id)}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div><span id="key-hint-${escapePageHtml(p.id)}" class="form-helper">${isTraeProviderUI(p)?'TRAE SOLO 账号凭证为登录后自动写入的 JSON（也可粘贴 trae 登录脚本落盘的 trae-*.json 内容）。每行一个账号、按剩余积分自动挑选，额度用尽自动冷却轮换；禁用该 Key 即停用账号。':(p.id==='cline'?'Cline 使用 Cline 账号的 refreshToken（长期钥匙）。每个账号一行，额度用完自动切换；留空禁用某个账号。':' ')}</span></fieldset>
              <fieldset class="form-group" id="models-fs-${escapePageHtml(p.id)}"><legend>模型</legend><div id="ml-${escapePageHtml(p.id)}">${p.models.map((m,mi)=>`<div class="fc mb-3 field-row" data-idx="${mi}"><input type="text" value="${escapePageHtml(m.id)}" class="fx1" id="mid-${escapePageHtml(p.id)}-${mi}" placeholder="模型 ID"><label class="tg"><input type="checkbox" ${m.enabled?'checked':''} id="men-${escapePageHtml(p.id)}-${mi}" aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testMdl('${escapePageJsx(p.id)}','${escapePageJsx(m.id)}',${mi})" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="rmMdl('${escapePageJsx(p.id)}',${mi})" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nmid-${escapePageHtml(p.id)}" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s btn-xs" onclick="addMdl('${escapePageJsx(p.id)}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>
              ${isTraeProviderUI(p)?`
              <fieldset class="form-group" id="trae-fs-${escapePageHtml(p.id)}"><legend>TRAE SOLO 账号池</legend><span class="form-helper">免费积分多账号反代：登录成功后凭证自动写入上方账号列表；转发时按剩余积分自动挑选账号，额度用尽自动冷却轮换（1005/429/401 各按策略冷却/禁用），每日 01:00/13:00 自动签到补积分并解冻。</span>
                <div class="fc mt-1 field-row">
                  <button class="btn btn-s" onclick="traeLogin('${escapePageJsx(p.id)}')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录账号</button>
                  <button class="btn btn-s" onclick="traeCheckin('${escapePageJsx(p.id)}')"><i class="fas fa-calendar-check" aria-hidden="true"></i>全部签到</button>
                  <button class="btn btn-s" onclick="traeModels('${escapePageJsx(p.id)}')"><i class="fas fa-cloud-download-alt" aria-hidden="true"></i>拉取模型</button>
                  <button class="btn btn-gh" onclick="traeStatus('${escapePageJsx(p.id)}')"><i class="fas fa-sync" aria-hidden="true"></i>刷新状态</button>
                </div>
                <div id="trae-st-${escapePageHtml(p.id)}" class="oauth-status" aria-live="polite"></div>
                <div id="trae-acc-${escapePageHtml(p.id)}" class="mt-1"></div>
                <div id="trae-checkin-${escapePageHtml(p.id)}" class="mt-1"></div>
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
              <fieldset class="form-group" id="atb-fs-${escapePageHtml(p.id)}"><legend>工具桥</legend><label class="switch-label"><span>启用工具桥（XYML 提示词注入 + 流式解析回 tool_calls，仅 CNB 需要）</span><span class="tg"><input type="checkbox" id="atb-${escapePageHtml(p.id)}" ${p.toolBridge?'checked':''}><span class="sl"></span></span></label></fieldset>
              <fieldset class="form-group" id="aum-fs-${escapePageHtml(p.id)}"><legend>模型策略</legend><label class="switch-label"><span>允许未配置模型透传——开启后请求该提供商的任意 modelId 都直接转发（跳过「未配置」校验），适合模型频繁上架、不想每次手动加模型的提供商（如 OpenRouter）。</span><span class="tg"><input type="checkbox" id="aum-${escapePageHtml(p.id)}" ${p.allowUnlistedModels?'checked':''}><span class="sl"></span></span></label></fieldset>
              <div class="detail-actions"><div id="tr-${escapePageHtml(p.id)}" aria-live="polite"></div><div>${((p.id === 'cnb' || (p.baseUrl && p.baseUrl.indexOf('cnb.cool') !== -1)) || ((p.oauth && (p.oauth.flowType === 'm365-pkce' || p.oauth.flowType === 'm365-ropc')))) ? '<button class="btn btn-s" onclick="fetchOauthModels(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ((p.apiType === 'openai' || p.id === 'cline' || p.id === 'opencode') && !isTraeProviderUI(p)) ? '<button class="btn btn-s" onclick="fetchEditModels(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ''}${p.id === 'cline' ? '<button class="btn btn-s" onclick="clineOAuthConnect(\'' + escapePageJsx(p.id) + '\')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>一键授权获取 Token</button>' : ''}<button class="btn btn-d" onclick="del('${escapePageJsx(p.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button><button class="btn btn-p" onclick="save('${escapePageJsx(p.id)}')"><i class="fas fa-save" aria-hidden="true"></i>保存更改</button></div></div>
            </div>
          </article>`).join('') : `<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>`}
        </div>
      </section>

      <section id="proxy-keys" class="workspace-section" aria-labelledby="proxy-keys-title">
        <div class="section-heading section-heading--admin"><div><h2 id="proxy-keys-title">转发 Key</h2><p>客户端使用这些 Key 访问统一的 <code>/v1</code> 接口。</p></div><button class="btn btn-p" onclick="genKey()"><i class="fas fa-plus" aria-hidden="true"></i>生成转发 Key</button></div>
        <div class="key-list">
          ${proxyKeys.length===0?'<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>':''}
          ${proxyKeys.map(k=>`<article class="ki" data-id="${escapePageHtml(k.id)}"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div><div class="kv"><span id="kv-${escapePageHtml(k.id)}" data-full="${escapePageHtml(k.key)}">${escapePageHtml(k.key.length>12?k.key.substring(0,8)+'••••'+k.key.substring(k.key.length-4):k.key)}</span><button class="icon-btn" onclick="toggleKeyVis('${escapePageJsx(k.id)}')" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button><button class="icon-btn" onclick='copyText("${escapePageJsx(k.key)}",this)' title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div><h3>${escapePageHtml(k.name)}</h3><p>创建于 ${new Date(k.createdAt).toLocaleDateString()} · ${k.expiresAt?'有效至 '+new Date(k.expiresAt).toLocaleDateString():'永久有效'} · <span class="bd ${k.allowedModels&&k.allowedModels.length>0?'bd-on':'bd-off'}">${k.allowedModels&&k.allowedModels.length>0?k.allowedModels.length+' 个模型':'全部模型'}</span></p></div></div><div class="key-actions"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} onchange="toggleProxyKey('${escapePageJsx(k.id)}',this.checked)" aria-label="启用 ${escapePageHtml(k.name)}"><span class="sl"></span></label><span class="bd ${k.enabled?'bd-on':'bd-off'}">${k.enabled?'已启用':'已禁用'}</span><button class="btn btn-gh btn-xs" onclick="editKeyModels('${escapePageJsx(k.id)}')" title="模型筛选"><i class="fas fa-filter" aria-hidden="true"></i>模型筛选</button><button class="btn btn-d btn-xs" onclick="rmKey('${escapePageJsx(k.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div></article>`).join('')}
        </div>
      </section>
      <section id="logs" class="workspace-section" aria-labelledby="logs-title">
        <div class="section-heading section-heading--admin"><div><h2 id="logs-title">系统日志</h2><p>记录 API 请求、错误等关键信息。超过保留天数的日志会自动删除。</p></div><div><label class="tg"><input type="checkbox" id="log-switch" onchange="toggleLog(this.checked)"><span class="sl"></span></label><span id="log-status">已关闭</span><label class="tg" style="margin-left:8px" title="定时自动刷新日志，便于排查问题"><input type="checkbox" id="log-auto-on" onchange="logAutoToggle(this.checked)"><span class="sl"></span></label><input type="number" id="log-auto-sec" min="1" max="3600" value="5" style="width:58px;text-align:center;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit;margin-left:6px" onchange="logAutoSecChange()"><span class="mu" style="font-size:12px;margin-left:4px">秒自动刷新</span><label class="mu" style="font-size:12px;margin-left:10px" title="日志保留天数，超过后自动删除">保留</label><input type="number" id="log-retention" min="1" max="365" value="7" style="width:50px;text-align:center;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit;margin-left:4px" onchange="logRetentionChange(this.value)"><span class="mu" style="font-size:12px;margin-left:4px">天</span><button class="btn btn-gh btn-xs" onclick="logPageChange(1)" style="margin-left:10px" title="刷新（回到第一页）"><i class="fas fa-sync-alt"></i></button><button class="btn btn-d btn-xs" onclick="clearLogs()" style="margin-left:4px">清除</button></div></div>
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
      <section id="checkin" class="workspace-section" aria-labelledby="checkin-title">
        <div class="section-heading section-heading--admin"><div><h2 id="checkin-title">签到状态</h2><p>WorkBuddy / QoderWork / TRAE SOLO 每日签到领取免费积分，一个面板统一管理。仅 CN 账号可签到（国际版自动跳过）。定时任务每天 09:00/21:00 自动执行。</p></div><div><button class="btn btn-gh btn-xs" onclick="loadCheckin()" style="margin-left:8px"><i class="fas fa-sync-alt"></i></button><button class="btn btn-p btn-xs" onclick="triggerCheckin()"><i class="fas fa-calendar-check" aria-hidden="true"></i>全部签到</button></div></div>
        <div id="checkin-list" class="key-list">
          <div class="empty-state"><i class="fas fa-calendar-check" aria-hidden="true"></i><h3>暂无签到数据</h3><p>配置 WorkBuddy / QoderWork / TRAE SOLO 账号后，登录并点击「全部签到」。</p></div>
        </div>
        <div id="trae-checkin-list" class="mt-1"></div>
      </section>

      <!-- ===== MCP 聚合网关 ===== -->
      <section id="mcps" class="workspace-section" aria-labelledby="mcps-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="mcps-title">MCP 网关</h2><p>聚合多个 MCP Server 的工具，统一暴露 JSON-RPC 端点 <code>/v1/mcp</code>（需转发 Key 认证）。工具名自动加前缀 <code>{MCP名称}-</code> 隔离命名空间。</p></div>
          <button class="btn btn-p" onclick="mcpFormModal()"><i class="fas fa-plus" aria-hidden="true"></i>添加 MCP</button>
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
}

// UX2：保存/删除等操作后 location.reload() 会把页面打回顶部、收起所有面板。
// reload 前捕获滚动位置与展开状态，刷新后恢复，避免「操作一次就找不到刚才的位置」。
function reloadAdmin() {
  markSaved()  // UX8：保存成功即将刷新，清除未保存标记
  try {
    const open = []
    document.querySelectorAll('.pd.open').forEach(function (d) { if (d.id) open.push(d.id) })
    const af = document.getElementById('af')
    localStorage.setItem('ui_state', JSON.stringify({ y: window.scrollY, open: open, add: !!(af && !af.classList.contains('hd')) }))
  } catch (e) { /* 忽略存储失败 */ }
  location.reload()
}
function restoreAdminState() {
  try {
    const s = JSON.parse(localStorage.getItem('ui_state') || 'null')
    if (!s) { return }
    (s.open || []).forEach(function (panelId) {
      const d = document.getElementById(panelId)
      const c = document.getElementById('ch-' + String(panelId).replace(/^dt-/, ''))
      if (d && d.classList && !d.classList.contains('open')) { d.classList.add('open'); if (c) c.style.transform = 'rotate(90deg)' }
    })
    if (s.add) { const af = document.getElementById('af'); if (af) af.classList.remove('hd') }
    if (s.y) window.scrollTo(0, s.y)
  } catch (e) { /* 忽略损坏的状态 */ }
  try { localStorage.removeItem('ui_state') } catch (e) { /* 忽略 */ }
}

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
})

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
  testKeyConnection(url, apiType, k, providerId).then(function(result) {
    if (result.success && result.data) {
      document.getElementById('amcl').innerHTML = renderModelGrid(result.data.data || [], null, providerId)
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
  d.innerHTML = '<input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用该模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
}

function addMdlToForm(mid) {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用该模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
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
  const enabled = document.getElementById('aen').checked
  if (!nm || !id || !url) { toast('请填写名称、ID 和 API 地址', 'error'); return }
  if (authType === 'oauth-device') {
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
      body: JSON.stringify({ id, name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, toolBridge: (document.getElementById('atb')||{}).checked === true, allowUnlistedModels: (document.getElementById('aum')||{}).checked === true, type: vb && vb.primary ? 'vision-bridge' : undefined, visionBridge: vb })
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

function collectOauthNew() {
  const g = function(id) { return (document.getElementById(id) || {}).value?.trim() ?? '' }
  let extraHeaders
  try { extraHeaders = g('ao7') ? JSON.parse(g('ao7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('ao8') || 'device',
    deviceCodeUrl: g('ao1'),
    deviceTokenUrl: g('ao2'),
    refreshTokenUrl: g('ao3'),
    clientId: g('ao4'),
    clientSecret: g('ao14') || undefined,
    scope: g('ao5') || undefined,
    tokenHeader: g('ao6') || 'x-api-key',
    tokenHeaderPrefix: g('ao9') || undefined,
    extraHeaders,
    modelsUrl: g('ao10') || undefined,
    globalBaseUrl: g('ao11') || undefined,
    globalModelsUrl: g('ao12') || undefined,
    globalOrigin: g('ao13') || undefined,
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
  let extraHeaders
  try { extraHeaders = g('7') ? JSON.parse(g('7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('8') || 'device',
    deviceCodeUrl: g('1'),
    deviceTokenUrl: g('2'),
    refreshTokenUrl: g('3'),
    clientId: g('4'),
    clientSecret: g('14') || undefined,
    scope: g('5') || undefined,
    tokenHeader: g('6') || 'x-api-key',
    tokenHeaderPrefix: g('9') || undefined,
    extraHeaders,
    modelsUrl: g('10') || undefined,
    globalBaseUrl: g('11') || undefined,
    globalModelsUrl: g('12') || undefined,
    globalOrigin: g('13') || undefined,
  }
}

// ===== 厂商预设：单一数据源在文件顶部，页面 script 已注入 PROVIDER_PRESETS =====
function applyProviderPreset(name) {
  const p = PROVIDER_PRESETS[name]
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
  } else {
    applyClineKeyHint(false)
  }
  const tb = document.getElementById('atb')
  if (tb) tb.checked = !!p.toolBridge
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

function toggleAuthType() {
  const v = document.getElementById('aat').value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-new').classList.toggle('hd', !isOauth)
  document.getElementById('akeys-fs').classList.toggle('hd', isOauth)
  document.getElementById('amodels-fs').classList.toggle('hd', isOauth)
}
function toggleAuthTypeEdit(id) {
  const v = document.getElementById('auth-' + id).value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-edit-' + id).classList.toggle('hd', !isOauth)
  const keysFs = document.getElementById('keys-fs-' + id)
  if (keysFs) keysFs.classList.toggle('hd', isOauth)
  const modelsFs = document.getElementById('models-fs-' + id)
  if (modelsFs) modelsFs.classList.toggle('hd', isOauth)
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
    // 凭据可从环境变量读取（GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET），
    // 表单留空时后端回退环境变量，故这里不强制
    if (!oauth.clientId && !oauth.clientSecret) {
      st.textContent = '请填写 Gemini Client ID / Client Secret，或配置环境变量 GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET'
      return
    }
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
    if (st) showResult(st, true, '登录成功 uid=' + (dd.uid || '') + ' 积分=' + (dd.credits || 0))
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
    renderTraeCheckin(id, results)
    if (st) showResult(st, true, '签到完成：' + results.length + ' 个账号')
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
function traeStatus(id) {
  const st = document.getElementById('trae-st-' + id)
  const box = document.getElementById('trae-acc-' + id)
  if (!box) return
  fetch('/admin/api/trae/' + encodeURIComponent(id) + '/status', { method: 'GET' }).then(r => r.json()).then(d => {
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '状态获取失败'); return }
    const accs = d.data.accounts || []
    const checkin = d.data.checkin || []
    if (st) st.textContent = ''
    if (accs.length === 0) {
      box.innerHTML = '<p class="form-helper">暂无账号。点击「登录账号」添加第一个 TRAE 账号。</p>'
    } else {
      box.innerHTML = '<div style="max-height:260px;overflow:auto"><table class="usage-log-table" style="margin:0">' +
        '<thead><tr><th>UID</th><th>昵称</th><th>积分</th><th>状态</th><th>冷却至</th><th>操作</th></tr></thead><tbody>' +
        accs.map(function (a) {
          const stTxt = a.disabled ? '<span style="color:var(--color-danger,#ef4444)">已禁用</span>' : a.cooling ? '<span style="color:var(--color-warn,#d97706)">冷却中</span>' : '<span style="color:var(--color-success,#16a34a)">正常</span>'
          const until = a.cooling && a.until ? new Date(a.until).toLocaleString() : ''
          const reason = a.reason ? '<small>' + escapeHtml(a.reason) + '</small>' : ''
          return '<tr><td><code>' + escapeHtml(a.uid) + '</code></td><td>' + escapeHtml(a.nickname || '-') + '</td>' +
            '<td>' + (a.credits || 0) + '</td><td>' + stTxt + (reason ? '<br>' + reason : '') + '</td><td>' + escapeHtml(until) + '</td>' +
            '<td><button class="btn btn-d btn-xs" onclick="traeRemoveAccount(\\'' + escapeJsAttr(id) + '\\',\\'' + escapeJsAttr(a.uid) + '\\')">删除</button></td></tr>'
        }).join('') + '</tbody></table></div>' +
        '<p class="form-helper">共 ' + accs.length + ' 个账号' + (checkin.length ? '；最近签到 ' + checkin.length + ' 条记录（见下）' : '') + '</p>'
    }
    renderTraeCheckin(id, checkin)
  }).catch(() => { if (st) showResult(st, false, '网络错误，请重试') })
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
function renderTraeCheckin(id, results) {
  const box = document.getElementById('trae-checkin-' + id)
  if (!box) return
  if (!results || results.length === 0) { box.innerHTML = ''; return }
  box.innerHTML = '<div class="checkin-grid">' + results.map(function (r) {
    const ok = r.success ? '<span class="bd bd-on">成功</span>' : '<span class="bd bd-off">失败</span>'
    return '<div class="ki" style="margin-bottom:6px"><div class="key-main"><span class="key-icon"><i class="fas fa-calendar-check"></i></span>' +
      '<div><h3>' + escapeHtml(r.nickname || r.uid) + ' ' + ok + (r.checkedIn ? ' <span class="bd bd-on">已签到</span>' : '') + '</h3>' +
      '<p>' + escapeHtml(r.message || '') + (r.credits !== undefined && r.credits !== null ? ' · 剩余积分 ' + r.credits : '') + '</p></div></div></div>'
  }).join('') + '</div>'
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
      setTimeout(function () { reloadAdmin() }, 1400)
      return true
    }
    if (pollSt) pollSt.textContent = d.message || '等待授权…'
    if (st) st.textContent = d.message || '等待授权…'
    return false
  }).catch(() => { if (pollSt) pollSt.textContent = '轮询失败，请重试' })
}

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

// provider api keys (edit)
function getKeys(id) {
  const c = document.getElementById('keys-' + id)
  const items = c.querySelectorAll('[data-kidx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.kidx)
    const k = document.getElementById('k-' + id + '-' + idx).value.trim()
    const en = document.getElementById('ken-' + id + '-' + idx).checked
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
}

function addKeyRow(id) {
  const inp = document.getElementById('nk-' + id), k = inp.value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const c = document.getElementById('keys-' + id), cnt = c.querySelectorAll('[data-kidx]').length
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.kidx = cnt
  d.innerHTML = '<input type="password" value="' + escapeHtml(k) + '" class="fx1" id="k-' + escapeHtml(id) + '-' + cnt + '" placeholder="API Key" aria-label="API Key"><button class="icon-btn" onclick="toggleKeyText(this)" title="显示/隐藏 Key" aria-label="显示或隐藏 Key"><i class="fas fa-eye" aria-hidden="true"></i></button><label class="tg"><input type="checkbox" checked id="ken-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用该 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testKeyRow(\\'' + escapeJsAttr(id) + '\\',' + cnt + ')" title="测试" aria-label="测试该 Key"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="rmKeyRow(\\'' + escapeJsAttr(id) + '\\',' + cnt + ')" title="移除" aria-label="移除该 Key"><i class="fas fa-times c-l"></i></button><span class="trt" id="ktr-' + escapeHtml(id) + '-' + cnt + '" style="flex-basis:100%" aria-live="polite"></span>'
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

async function testKeyRow(id, idx) {
  const k = document.getElementById('k-' + id + '-' + idx).value.trim()
  const url = document.getElementById('url-' + id).value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const apiType = document.getElementById('at-' + id).value
  // UX6：结果写入该 Key 行自己的结果区，多个 Key 并发测试互不覆盖
  const tr = document.getElementById('ktr-' + id + '-' + idx) || document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, k, id)
  showResult(tr, result.success, result.success ? '' : (result.message && result.message.indexOf('HTTP') !== -1 ? result.message : 'HTTP ' + result.status + (result.message ? ': ' + result.message : '')))
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
  }
}

// opencode 编辑表单 — 获取模型（复用 testKeyConnection 逻辑）
async function fetchEditModels(id) {
  const url = document.getElementById('url-' + id).value.trim()
  const keys = getKeys(id)
  const apiKey = keys.length > 0 ? keys[0].key : ''
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, apiKey, id)
  // UX7：showResult 内部已转义，不再二次转义
  showResult(tr, result.success, result.success ? '' : (result.message || '获取模型失败'))
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
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
  el.innerHTML = '<label>可用模型 <span class="mu">（点击 + 添加单个，或 <a href="javascript:void(0)" onclick="addAllModels(\\'' + escapeJsAttr(id) + '\\')">一键全部添加</a>）</span></label>' + renderModelGrid(models, id, id)
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
  if (authType === 'oauth-device') {
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
  const btn = document.querySelector('#dt-' + id + ' .detail-actions .btn-p')
  adminSubmitting = true
  busyBtn(btn)
  try {
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, toolBridge: (document.getElementById('atb-' + id)||{}).checked === true, allowUnlistedModels: (document.getElementById('aum-' + id)||{}).checked === true, type: vb && vb.primary ? 'vision-bridge' : null, visionBridge: vb })
    })
    const d = await r.json()
    if (d.success) { toast('已保存', 'success'); reloadAdmin() }
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
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.idx = cnt
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + escapeHtml(id) + '-' + cnt + '" placeholder="模型 ID" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked id="men-' + escapeHtml(id) + '-' + cnt + '" aria-label="启用该模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" id="tm-' + escapeHtml(id) + '-' + cnt + '" aria-label="测试该模型"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" id="rm-' + escapeHtml(id) + '-' + cnt + '" aria-label="移除该模型"><i class="fas fa-times c-l"></i></button><span class="trt" id="mtr-' + escapeHtml(id) + '-' + cnt + '" style="flex-basis:100%" aria-live="polite"></span>'
  c.appendChild(d)
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
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
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

// 签到状态：页面加载后总是加载一次（区块同屏展示，避免签到区默认停在静态占位）；进入 #checkin 时再刷新
// 注意：仅读取状态，不触发签到（签到只能通过手动点击按钮或 cron 定时触发）
function maybeLoadCheckin(hash) { if (hash === '#checkin') loadCheckin() }
window.addEventListener('hashchange', function () { maybeLoadCheckin(location.hash) })
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#checkin') {
    link.addEventListener('click', function () { setTimeout(loadCheckin, 50) })
  }
})
setTimeout(loadCheckin, 0)

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
        html += '<article class="ki" style="font-size:12px;padding:6px 10px"><div><span style="margin-right:8px">' + icon + '</span><span class="mu" style="margin-right:8px">' + escapeHtml(time) + '</span><span class="bd bd-' + (log.type==='error'?'off':'on') + '">' + log.type + '</span></div><div style="margin-top:4px">' + escapeHtml(log.message) + '</div>' + (log.details ? '<details style="margin-top:4px"><summary>详情</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">' + escapeHtml(log.details) + '</pre></details>' : '') + '</article>'
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

// ===== WorkBuddy 签到 =====
async function loadCheckin() {
  const el = document.getElementById('checkin-list')
  if (!el) return
  el.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i><h3>加载中…</h3></div>'
  try {
    const r = await fetch('/admin/api/checkin/status')
    const d = await r.json()
    renderCheckinList(d)
  } catch(e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle c-l"></i><h3>加载失败</h3></div>'
    return
  }
}

function renderCheckinList(d) {
  const el = document.getElementById('checkin-list')
  if (!el) return
  // 兼容旧结构（data 为数组）/ 新结构（data = {workbuddy, trae}）
  var dataArr = Array.isArray(d && d.data) ? d.data
    : (d && d.data && Array.isArray(d.data.workbuddy) ? d.data.workbuddy : [])
  if (!d || !d.success || dataArr.length === 0) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-check" aria-hidden="true"></i><h3>暂无 WorkBuddy 签到数据</h3><p>配置 WorkBuddy / QoderWork OAuth 提供商后，点击「全部签到」。</p></div>'
  } else {
    const html = renderWorkbuddyCards(dataArr)
    el.innerHTML = html
    el.querySelectorAll('[data-cid]').forEach(function(btn) {
      btn.addEventListener('click', function() { triggerCheckin(btn.getAttribute('data-cid')) })
    })
    el.querySelectorAll('[data-pkg]').forEach(function(btn) {
      btn.addEventListener('click', function() { toggleCollapse(btn.getAttribute('data-pkg'), btn) })
    })
  }
  // 渲染 TRAE 认可账号级结果（新结构时）
  if (d && d.data && !Array.isArray(d.data) && d.data.trae) {
    renderTraeCheckinList(d.data.trae)
  } else if (d && d.data && Array.isArray(d.data)) {
    renderTraeCheckinList([])
  }
}

/** 生成 WorkBuddy/QoderWork 的卡片 HTML（原 renderCheckinList 内联逻辑）。 */
function renderWorkbuddyCards(list) {
  var html = ''
  list.forEach(function(c, idx) {
    var reason = c.reason || 'fail'
    var badge = reason === 'ok' ? '<span class="bd bd-on">签到成功</span>'
      : reason === 'already' ? '<span class="bd bd-on">今日已签</span>'
      : reason === 'skipped_global' ? '<span class="bd bd-off">国际版跳过</span>'
      : reason === 'skipped_no_token' ? '<span class="bd bd-off">未签到</span>'
      : '<span class="bd bd-off">失败</span>'
    var lastTime = c.lastCheckinAt ? new Date(c.lastCheckinAt).toLocaleString() : '—'
    var streak = (c.streakDays !== undefined && c.streakDays !== null) ? c.streakDays + ' 天' : '—'
    var credits = (c.totalCredits !== undefined && c.totalCredits !== null) ? c.totalCredits : '—'
    var realmBadge = c.realm === 'cn' ? '<span class="bd bd-on">CN</span>' : c.realm === 'global' ? '<span class="bd bd-off">Global</span>' : '<span class="bd bd-off">未知</span>'
    var payBadge = c.paymentType ? '<span class="bd bd-on">' + escapeHtml(c.paymentType) + '</span>' : ''
    var title = c.nickname ? escapeHtml(c.nickname) + ' <small style="color:var(--muted)">' + escapeHtml(c.name) + '</small>' : escapeHtml(c.name)
    var remain = (c.totalRemain !== undefined && c.totalRemain !== null) ? c.totalRemain : '—'
    var used = (c.totalUsed !== undefined && c.totalUsed !== null) ? c.totalUsed : '—'
    var size = (c.totalSize !== undefined && c.totalSize !== null) ? c.totalSize : '—'
    var packs = (c.packCount !== undefined && c.packCount !== null) ? c.packCount + ' 个包' : '—'
    var pct = (c.totalSize > 0 && c.totalUsed !== undefined && c.totalUsed !== null) ? Math.round(c.totalUsed / c.totalSize * 100) + '%' : ''
    var creditLine = '可用 ' + remain + ' · 已用 ' + used + (pct ? ' · ' + pct : '') + ' · 额度池 ' + size + ' · ' + packs
    var checkinCredit = (c.checkinCredit !== undefined && c.checkinCredit !== null) ? '+' + c.checkinCredit : ''
    var checkinLine = '连续签到：' + streak + (checkinCredit ? ' · 本次签到 ' + checkinCredit + ' 积分' : '') + ' · 总积分：' + credits + ' · 上次签到：' + escapeHtml(lastTime)
    var packLine = ''
    if (c.packages && c.packages.length > 0) {
      var pkgId = 'pkg-' + idx
      var rows = c.packages.map(function(p) {
        var exp = (p.expireAt && p.expireAt.trim()) ? escapeHtml(p.expireAt) : '长期'
        var cyc = (p.cycleEndTime && p.cycleEndTime.trim()) ? escapeHtml(p.cycleEndTime) : '—'
        var qty = ''
        if (p.size !== undefined && p.size !== null && p.size > 0) {
          var used2 = (p.used !== undefined && p.used !== null) ? p.used : 0
          qty = '<td class="numeric">' + used2 + ' / ' + p.size + (p.unit ? ' ' + escapeHtml(p.unit) : '') + '</td>'
        } else {
          qty = '<td>—</td>'
        }
        return '<tr><td>' + escapeHtml(p.name) + '</td><td>' + exp + '</td><td>' + cyc + '</td>' + qty + '</tr>'
      }).join('')
      packLine = '<div class="collapse-section" style="margin-top:6px"><button class="collapse-btn" data-pkg="' + pkgId + '" type="button" aria-expanded="false"><i class="fas fa-chevron-right collapse-icon" aria-hidden="true"></i> 权益包明细（' + c.packages.length + '）</button><div id="' + pkgId + '" class="hd usage-log-table-wrap"><table class="usage-log-table"><thead><tr><th>名称</th><th>到期时间</th><th>周期结束</th><th>已用/总额度</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
    }
    html += '<article class="ki"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-calendar-check"></i></span><div><div class="kv"><h3>' + title + '</h3>' + realmBadge + payBadge + badge + '</div><p>' + creditLine + '</p><p style="margin-top:2px">' + checkinLine + '</p>' + packLine + (c.message ? '<p class="mu" style="margin-top:2px">' + escapeHtml(c.message) + '</p>' : '') + '</div></div><div class="key-actions"><button class="btn btn-gh btn-xs" data-cid="' + escapeHtml(c.providerId) + '"><i class="fas fa-calendar-check" aria-hidden="true"></i>签到</button></div></article>'
  })
  return html
}

/** 渲染 TRAE SOLO 账号级签到结果（新结构 data.trae）。 */
function renderTraeCheckinList(traeList) {
  const el = document.getElementById('trae-checkin-list')
  if (!el) return
  const list = traeList || []
  if (list.length === 0) { el.innerHTML = ''; return }
  var html = '<div class="section-heading section-heading--admin" style="margin-top:16px"><div><h2>TRAE SOLO 签到</h2><p>按账号展示最近一次签到与剩余积分。</p></div></div>'
  list.forEach(function(t) {
    html += '<div class="ki" style="margin-bottom:6px"><div class="key-main"><span class="key-icon"><i class="fas fa-calendar-check"></i></span><div><h3>' + escapeHtml(t.name) + '</h3>'
    if (!t.results || t.results.length === 0) {
      html += '<p class="mu">尚未签到</p>'
    } else {
      html += t.results.map(function(r) {
        const ok = r.success ? (r.checkedIn ? '<span class="bd bd-on">已签到</span>' : '<span class="bd bd-on">成功</span>') : '<span class="bd bd-off">失败</span>'
        return '<div style="margin-top:4px"><span class="bd bd-on">' + escapeHtml(r.nickname || r.uid) + '</span> ' + ok +
          ' <span style="color:var(--muted)">' + escapeHtml(r.message || '') + '</span>' +
          ((r.credits !== undefined && r.credits !== null) ? ' · 剩余积分 ' + r.credits : '') + '</div>'
      }).join('')
    }
    html += '</div></div><div class="key-actions"><button class="btn btn-gh btn-xs" data-trae-checkin="' + escapeHtml(t.providerId) + '"><i class="fas fa-calendar-check" aria-hidden="true"></i>签到</button></div></div>'
  })
  el.innerHTML = html
  el.querySelectorAll('[data-trae-checkin]').forEach(function(btn) {
    btn.addEventListener('click', function() { traeCheckin(btn.getAttribute('data-trae-checkin')) })
  })
}

async function refreshCheckinInBackground() {
  try {
    const r = await fetch('/admin/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ silent: true }) })
    const d = await r.json()
    if (d.success) loadCheckin()
  } catch(e) { /* 静默刷新失败不提示 */ }
}

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
      renderCheckinList({ success: true, data: results })
      if (!id) loadCheckin()
    } else {
      toast(d.message || '签到失败', 'error')
    }
  } catch(e) {
    toast('签到请求失败', 'error')
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
setTimeout(loadCache, 0)
</script>
</body></html>`)
}