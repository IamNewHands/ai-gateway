# AI Gateway 代码审查报告与修复进度

> 生成日期：2026-08-09
> 审查范围：全项目约 1.4 万行 TypeScript（proxy / admin / pages / oauth / checkin / gemini / cline / opencode / ws / analytics 等全部模块）
> 审查维度：安全 / 性能 / 使用体验 / 健壮性
>
> **用法**：每完成一项修复，将对应 `- [ ]` 改为 `- [x]`，并在「修复记录」中追加条目。

---

## 一、安全

### 🔴 高危

- [x] **S1. 日志明文泄漏敏感数据（多处）**
  - [oauth.ts:296](src/oauth.ts#L296) 上游 `Set-Cookie` 原文打 console（L296、L353-355）——账号会话凭证直接打印到 Workers 日志
  - [ws.ts:82-87](src/ws.ts#L82-L87) 客户端首帧全文（含 system prompt/工具定义）写入 KV 日志 + console
  - [proxy.ts:1067-1088](src/proxy.ts#L1067-L1088) 上游响应体前 1500 字节写入日志；[proxy.ts:867](src/proxy.ts#L867) 成功日志记录上游 apiKey 前 8 位
  - analytics 侧有脱敏（usage-logger.ts L55-58），但 `writeLog` 路径**零脱敏**
  - ✅ 已修复：`admin.ts` 新增 `sanitizeLogText` 并接入 `writeLog`（Bearer/sk_/x-api-key/authorization/cookie 统一脱敏）；`ws.ts` 首帧改为 `summarizeWsFrame`（只记录 model/messages/tools 数量）；`qoder/cosy.ts`、`qoder/proxy.ts` 去掉 identityJSON/cosyKey/tempKey 原文；`proxy.ts` 成功日志去掉 apiKey 前缀

- [x] **S2. 管理面 SSRF：baseUrl / 测试 URL 无校验**
  - [admin.ts:350-401](src/admin.ts#L350-L401) `handleTestKeyNew`、`handleTestModelNew` 直接把管理员提交的任意 `url` 交给服务端 `fetch`，且携带 `Authorization: Bearer <apiKey>` 头
  - `baseUrl` 仅去除尾部斜杠，无 scheme 白名单、无内网 IP 拦截
  - 放大因素：登录无速率限制（auth.ts L73-110）、Session 7 天有效期
  - ✅ 已修复：新增 `isSafeHttpUrl`（仅 http/https、拒绝带凭据 URL、拒绝本机/内网/保留 IP 段、拒绝 localhost 等本机域名）并应用到 baseUrl（创建/更新/upsert）、OAuth 被 fetch 的端点（deviceCodeUrl/deviceTokenUrl/refreshTokenUrl/modelsUrl/globalBaseUrl/globalModelsUrl）及测试 URL（handleTestKeyNew / handleTestModelNew）

- [x] **S3. 前端 XSS：内联事件属性裸拼接**
  - [pages.ts:626-635](src/pages.ts#L626-L635) `renderModelGrid` 把远程模型 ID 原样拼进 `onclick`
  - L452-494 大量 `onclick="tog('${p.id}')"` 服务端模板单引号字符串裸插值；[pages.ts:1274](src/pages.ts#L1274) `addKeyRow` 把 Key 明文拼进 `value` 属性
  - 根因：现有 `escapeHtml` 只转 HTML 实体，JS 字符串上下文（onclick 属性内）**无效**
  - ✅ 已修复：新增 JS 字符串转义并全区替换为「JS 字符串 + HTML 属性」双转义（服务端 `escapePageJsx`、客户端 `escapeJsAttr`）；`addKeyRow` Key 值先 `escapeHtml` 再入 `value`；`renderModelGrid`/`fillPresetModelsEdit`/OAuth 弹窗 `onclick` 参数全部转义；`pM` 默认值入属性转义

### 🟠 中危

- [ ] **S4. OAuth token 明文存 KV**
  - [oauth.ts:19-23](src/oauth.ts#L19-L23) `access_token` / `refresh_token` / 会话 Cookie 以纯 JSON 明文写 KV，无应用层加密
- [x] **S5. 管理 API 无 CSRF 防护**
  - 写操作依赖 `SameSite=Lax` 单层防线；带副作用的 GET（`handleOAuthModels`、`/admin/logout`）可被链接型 CSRF 触发
  - ✅ 已修复：`index.ts` 在 `/admin/*` 认证后新增跨域中间件——非 GET/HEAD/OPTIONS 请求校验 `Origin` 与 `Host` 同源，跨站返回 403；`/admin/logout` 与 `/admin/api/oauth/:id/models` 改为 POST-only；前端 logout 链接改走 `doLogout()`（POST 后跳登录），`fetchOauthModels` 改 POST
- [ ] **S6. Gemini 图片抓取 SSRF + 无界内存**
  - [gemini/proxy.ts:141-165](src/gemini/proxy.ts#L141-L165) 直接 `fetch` 用户可控 `image_url`，无协议白名单、无大小限制
- [ ] **S7. Gemini 回调 state 校验可跳过**
  - [oauth.ts:667](src/oauth.ts#L667) state 缺失时直接放行，存在账号劫持风险

### 🟡 低危

- [ ] **S8. 其它低危项**
  - `/api/manage/providers` 明文返回全部 apiKeys；Token 比较非恒定时间
  - 上游错误体原样回显给客户端
  - Qoder PKCE verifier 进 URL 查询串；JWT 不验签仅用于域路由（可接受但需知悉）

---

## 二、性能

### 🔴 高

- [x] **P1. KV 零缓存 + 每请求多次读写**
  - [storage.ts:6-9](src/storage.ts#L6-L9) 每次全量读 `providers` 并 JSON.parse（含明文密钥）
  - 每请求 ≥2 次同步 KV 读 + 1-2 次 KV 写日志；Anthropic/OAuth 路径峰值约 7 次 KV 操作
  - ✅ 已修复：`storage.ts` 新增内存缓存（10s TTL）应用于 providers/proxyKeys 读写；读路径优先走缓存，写路径同步刷新，多 isolate 最多滞后一个 TTL
- [x] **P2. `AbortSignal.timeout(300000)` 掐断超过 5 分钟的流**
  - [proxy.ts:856](src/proxy.ts#L856) 通用/OAuth 路径 abort 对流式读取持续生效，长思考/agent 会话中途被截断
  - opencode 路径已正确规避（连接超时后改 idle 超时 + keep-alive），其余路径未对齐
  - ✅ 已修复：`opencode.ts` 通用化 `streamFetchWithTimeout`（连接/首字节超时 90s → 拿到响应后解除整体超时 → `withSSEKeepAlive` idle 兜底 240s + 心跳）；心跳只对严格 `text/event-stream` 注入（NDJSON 等逐行格式注入注释行会破坏解析）；proxy 通用/OAuth/Anthropic/Responses/qoder/cline/gemini 全部路径统一接入 `fetchUpstream`/`streamFetchWithTimeout`

### 🟠 中

- [x] **P3. 响应体多次缓冲放大内存 2-3 倍**
  - [proxy.ts:471](src/proxy.ts#L471) 对响应 `tee()`，观察分支逐行 JSON.parse 整个 SSE 流
  - ✅ 已修复：非流式不再 `tee()`（整体读一次解析 usage 后直接构造响应，单份缓冲）；`observeStreamUsage` 单行缓冲设 64KB 上限，异常超长行只保留尾段
- [x] **P4. 日志 KV 写放大**
  - 每请求 1 次 KV.put（日志）+ 1 次 Analytics 数据点
  - ✅ 已修复：`log_enabled` 开关 5s 内存 TTL 缓存（`isLogEnabled`），消除每请求 1 次 KV.get；开关切换时同步刷新缓存
- [x] **P5. handleLogs 全量 KV 枚举**
  - [admin.ts:984-989](src/admin.ts#L984-L989) 先全量 KV.list 再逐批读取，日志量大时逼近 subrequest 上限
  - ✅ 已修复：KV.list 只拉 key 名（上限 5000 条截断 total），仅对 offset..offset+limit 窗口内的 key 发起 KV.get，subrequest 数从「全量」降到「页数 + limit」量级
- [x] **P6. 管理页 SSR 体量 O(N×M)**
  - [pages.ts:269-276](src/pages.ts#L269-L276) 每提供商完整重放全库模型引用列表
  - ✅ 已修复：识图模型引用列表改懒渲染——SSR 只输出空容器 + `VB_MODELS`/`VB_ORIGINAL` 快照各一份（O(N)），展开「识图模型配置」时才客户端生成控件；未展开时保存表单按快照保留原配置，避免误清

### 🟡 低

- [x] **P7. 其他**
  - 前端日志 5s 自动刷新全量重绘；opencode 429 重试同步 sleep；usage-logs 前导通配符 ILIKE 全表扫描
  - ✅ 已修复：① 日志自动刷新改静默模式（不闪「加载中」，内容未变化时不重绘 DOM）；② opencode 429 重试已是异步「sleep + 退避重试」（commit 720f565 引入 `await sleep`，非同步阻塞，审查点复核无改动）；③ usage-logs 关键词去掉前导通配符，改前缀匹配（`ILIKE 'kw%'`）并转义用户输入的 `%`/`_`/`\`

---

## 三、使用体验

### 🔴 高

- [x] **UX1. 折叠面板内嵌可交互控件（键盘误触）**
  - [pages.ts:452-455](src/pages.ts#L452-L455) `.ps` 整块 role="button"，内部又放 checkbox/按钮，按 Enter 同时触发展开收起和状态切换
- [x] **UX2. 保存/删除后整页 `location.reload()`**
  - 多处 reload 导致页面回顶、面板折叠、输入丢失
  - ✅ 已修复：`reloadAdmin()` 在 reload 前记录滚动位置 + 展开的提供商面板 + 添加表单状态，刷新后 `restoreAdminState()` 恢复；全部 reload 调用点已替换
- [x] **UX3. 表单无提交中状态，可重复提交**
  - 双击「创建提供商」可 POST 两次
  - ✅ 已修复：全局 `adminSubmitting` 防重入 + `busyBtn`/`idleBtn` 按钮提交中状态（「处理中…」+ 禁用），覆盖创建/保存/删除/Key 模型筛选/生成 Key/删除 Key/Cline 一键授权

### 🟠 中

- [x] **UX4. flowType 回显 Bug（功能缺陷）**
  - [pages.ts:464](src/pages.ts#L464) `(p.oauth&&p.oauth.flowType)||'device'==='device'` 运算优先级错误恒为 true，browser/qoder/gemini 流程编辑时总是选中「设备码」
- [x] **UX5. 模态框无障碍缺失**
  - 无 ESC 关闭、无焦点管理、无键盘陷阱；动态添加行无 aria-label
  - ✅ 已修复：`showM`/`closeM` 记录并归还触发焦点、打开时聚焦首控件；ESC 关闭（优先触发「取消」让 Promise 正常 resolve）、Tab 焦点圈在弹窗内；Key/模型动态行按钮补 aria-label
- [x] **UX6. 多 Key 并发测试结果互相覆盖**
  - ✅ 已修复：Key/模型测试结果写入各自行内的 `.trt` 结果区（`ktr-<id>-<idx>`/`mtr-<id>-<idx>`），并发测试互不覆盖
- [x] **UX7. 双重转义**
  - `escapeHtml(msg)` 后再经 `showResult` 二次转义，错误信息显示字面 `&amp;lt;` 实体
  - ✅ 已修复：移除 `fetchOauthModels`/`fetchEditModels` 调用处的预转义，`showResult` 内部统一转义

### 🟡 低

- [x] **UX8. 其他**
  - ✅ 已修复（未保存离开提醒）：`shared.js` 全局监听 Provider 表单（`#af`/`#dt-*`）、Key 模型筛选（`.mdl-list`）、日志筛选（`.analytics-log-filters`）的 input/change 置脏，`beforeunload` 拦截未保存离开；保存成功路径（`reloadAdmin`/`createProv`/`saveKeyModels`/`doGenKey`/`togglePb`/日志查询）统一 `markSaved()` 复位
  - 未做（低优先级）：成功 toast 与 modal 双路径风格统一；服务端+客户端两套重复预设表去重

---

## 四、健壮性

### 🔴 高

- [x] **R1. 并发 KV 读-改-写竞争**
  - 键健康计数 readHealth → failures++ → writeHealth 无原子性，并发计数丢失；成功删除失败记录可能清掉并发失败记录
  - OAuth token 刷新多并发 401 同时 refresh，上游 rotate refresh_token 时互相覆盖
  - ✅ 已修复：health 读写走 10s 内存缓存（写路径同步刷新），isolate 内并发共享同一 map 消除覆盖写；OAuth `refreshInflight` 按 provider 合并并发刷新 Promise，同一 provider 只打一次上游
- [x] **R2. 客户端断开后上游流仍被持续消费**
  - [proxy.ts:471](src/proxy.ts#L471) tee 后观察分支继续读完整条上游 body，浪费 Worker 时长与上游配额
  - ✅ 已修复：`usage-logger` 新增 `createStreamUsageProbe`（TransformStream），usage 解析内联进透传管道；`finalizeProxyResponse` 由「tee + waitUntil 观察」改为 `pipeThrough` 单一消费链——客户端 Cancel 沿管道传播到上游立即停止拉取，usage 在正常流结束（flush）时一次性写 analytics，中途断开不再后台空读

### 🟠 中

- [ ] **R3. Anthropic/Responses 非 OAuth 路径只用第 1 个 key，无 failover**
  - [proxy.ts:1476-1486](src/proxy.ts#L1476-L1489)、[proxy.ts:2440-2450](src/proxy.ts#L2440-L2450) 单 key 故障即整条格式路径不可用
- [x] **R4. OAuth token KV TTL 绑定 access_token 寿命**
  - [oauth.ts:21-22](src/oauth.ts#L21-L22) 过期即删，refresh_token 一并丢失，之后无法离线续期
  - ✅ 已修复：`writeOauthToken` 有 `refresh_token` 时 TTL 放宽到 30 天（不再随 access 2h 过期删除）；仅无 refresh_token 的一次性 token 才按 access 剩余寿命设置 TTL（60s 下限 / 30 天上限）
- [x] **R5. browser 模式刷新后丢失 Cookie jar**
  - [oauth.ts:978-1009](src/oauth.ts#L978-L1009) 刷新路径未写 `cookies` 字段，后续请求 401
  - ✅ 已修复：`refreshOauthTokenBrowser` 写回 `cookies: Set-Cookie || state.cookies`，刷新不丢 cookie 会话
- [x] **R6. 管理 handler 的 `c.req.json()` 无 try/catch**
  - admin.ts 全文件无保护，畸形 JSON 返回 500 而非 400
  - ✅ 已修复：`index.ts` `app.onError` 识别 JSON 解析失败（SyntaxError "Unexpected end of JSON input"/"Unexpected token"）返回 400，覆盖 admin/auth 全部 `c.req.json()` 路径
- [x] **R7. storage.ts `JSON.parse` 无 try/catch 兜底**
  - KV 数据损坏时所有管理接口与代理鉴权连锁 500
  - ✅ 已修复：`storage.ts` 新增 `safeParseArray` 回退空数组；`getSession` try/catch + `expiresAt` 类型校验

### 🟡 低

- [x] **R8. handleLogs 的 `parseInt('abc')` 产生 NaN 静默返回空列表；handleLogsClear 只删 1000 条**
  - ✅ 已修复：`handleLogs` 新增 `toInt` 安全解析（Number + isFinite 兜底），limit/offset 不再被 NaN 污染；`handleLogsClear` 按 cursor 循环删除直至全部删完，单次上限 20000 条并分批（50/批）避免 subrequest 超限
- [x] **R9. 其他**
  - ✅ 已修复：usage-logs 查询前导通配符（`escapeLike` 前缀化）；observeStreamUsage 超长单行 buffer 64KB 截断；checkin 结果 `JSON.parse` try/catch 兜底；passthrough 3xx 透传 Location 头

---

## 五、修复记录

| 日期 | 修复项 | 改动文件 | 说明 |
|------|--------|----------|------|
| 2026-08-09 | 创建本报告 / 备份分支 | CODE_REVIEW.md | 分析落地为可勾选文档 |
| 2026-08-09 | S1 日志脱敏 | admin.ts, ws.ts, qoder/cosy.ts, qoder/proxy.ts, proxy.ts | `sanitizeLogText` 统一接入 `writeLog`；首帧改摘要；去掉各密钥原文 |
| 2026-08-09 | S2 SSRF 防护 | admin.ts | 新增 `isSafeHttpUrl`（协议白名单 + 拒绝带凭据/本机/内网/保留 IP）应用于 baseUrl、OAuth 被 fetch 的 6 个端点、测试 URL |
| 2026-08-09 | S3 前端 XSS | pages.ts, shared.js.ts | `escapePageJsx`/`escapeJsAttr` 双转义；addKeyRow/Key 值转义；全部内联事件参数转义 |
| 2026-08-09 | UX1 折叠面板键盘误触 | pages.ts | onkeydown 加 `event.target===this` 判断，内部控件不再连锁触发 |
| 2026-08-09 | UX4 flowType 回显 | pages.ts | 修正 `(p.oauth&&p.oauth.flowType)||'device'==='device'` 优先级 Bug |
| 2026-08-09 | UX2 reload 状态丢失 | pages.ts | `reloadAdmin()` 捕获滚动/展开面板/添加表单状态，`restoreAdminState()` 刷新后恢复 |
| 2026-08-09 | UX3 重复提交 | pages.ts | `adminSubmitting` 防重入 + `busyBtn`/`idleBtn` 提交中状态，覆盖创建/保存/删除/Key 筛选/生成/删除/Cline 授权 |
| 2026-08-09 | UX5 模态框无障碍 | pages.ts | 焦点记录/归还/首控件聚焦、ESC 关闭（触发取消按钮防 Promise 悬挂）、Tab 焦点圈、动态行 aria-label |
| 2026-08-09 | UX6 测试结果互相覆盖 | pages.ts | Key/模型测试写入各自行 `.trt` 结果区（`ktr-<id>-<idx>`/`mtr-<id>-<idx>`） |
| 2026-08-09 | UX7 双重转义 | pages.ts | 移除 `fetchOauthModels`/`fetchEditModels` 预转义，`showResult` 统一转义 |
| 2026-08-09 | 详细日志每页条数 | pages.ts, analytics-ui.js.ts, analytics/query.ts, analytics/admin-api.ts | 每页 5/10/20/50/100 可选，默认 5，localStorage 记忆；后端 `pageSize` 参数 clamp 1-200 |
| 2026-08-09 | P1 KV 缓存 | storage.ts | providers/proxyKeys 10s 内存 TTL 缓存，写路径同步刷新 |
| 2026-08-09 | R6 畸形 JSON 400 化 | index.ts | `onError` 识别 SyntaxError 返回 400，覆盖 admin/auth `c.req.json()` |
| 2026-08-09 | R7 JSON.parse 保护 | storage.ts | `safeParseArray` 回退空数组；`getSession` try/catch + 类型校验 |
| 2026-08-09 | R1 并发 KV 竞争 | proxy.ts, oauth.ts | health 读写加 10s 内存缓存（写路径同步刷新），消除「读→改→覆盖写」并发计数丢失；OAuth token 刷新 `refreshInflight` 按 provider 合并并发刷新 Promise，只打一次上游 |
| 2026-08-09 | P2 流式超时 | opencode.ts, proxy.ts, qoder/proxy.ts, cline/proxy.ts, gemini/proxy.ts | `streamFetchWithTimeout` 连接/首字节 90s + idle 240s 兜底 + 心跳；心跳仅对严格 text/event-stream 注入；全部上游路径统一接入 |
| 2026-08-09 | P3 内存放大 | proxy.ts, analytics/usage-logger.ts | 非流式不再 tee（单份缓冲）；`observeStreamUsage` 单行缓冲 64KB 上限 |
| 2026-08-09 | P4 日志 KV 写放大 | admin.ts | `log_enabled` 5s 内存缓存消除每请求 KV.get |
| 2026-08-09 | P5 全量 KV 枚举 | admin.ts | handleLogs 只 KV.list 拉 key 名（5000 截断），仅对 offset..limit 窗口 KV.get |
| 2026-08-09 | P6 SSR 体量 | pages.ts | 识图模型列表懒渲染：SSR 输出空容器 + `VB_MODELS`/`VB_ORIGINAL` 快照，展开时客户端生成，未展开保存读快照防误清 |
| 2026-08-09 | P7 其他 | pages.ts, analytics/query.ts | 日志自动刷新静默模式（内容不变不重绘）；usage-logs 前缀匹配 + 通配符转义；opencode 429 已为异步退避（复核无改动） |
| 2026-08-09 | S5 CSRF 防护 | index.ts, pages.ts, shared.js.ts | `/admin/*` 写操作 Origin/Host 同源校验（跨站 403）；logout 与 oauth/models 改 POST-only；前端 logout 走 `doLogout()` POST |
| 2026-08-09 | R2 客户端断开停流 | proxy.ts, analytics/usage-logger.ts | usage 探针 `createStreamUsageProbe` 内联进 `pipeThrough` 透传链，客户端 Cancel 沿管道传播到上游，flush 时一次写 analytics |
| 2026-08-09 | R4/R5 OAuth token | oauth.ts | 有 refresh_token 时 TTL 放宽 30 天不随 access 过期；browser 刷新写回 `cookies: Set-Cookie || state.cookies` |
| 2026-08-09 | R8 日志分页/清空 | admin.ts | `toInt` 兜底 NaN；`handleLogsClear` cursor 循环删除全部（上限 20000，50/批） |
| 2026-08-09 | R9 健壮性 | checkin.ts, proxy.ts | checkin 结果 JSON.parse try/catch；passthrough 3xx 透传 Location |
| 2026-08-09 | UX8 未保存离开提醒 | shared.js, pages.ts, analytics-ui.js.ts | Provider/Key 筛选/日志筛选输入置脏，beforeunload 拦截；保存成功路径 markSaved 复位 |
