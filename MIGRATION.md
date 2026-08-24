# M365 移植对比清单 / 处理记录

> 目标仓库：`https://github.com/HEXUXIU/M365-Copilot2API`（Go 版，自托管）
> 本地移植：`src/m365/*`（TypeScript，Cloudflare Worker / Durable Object）
> 结论日期：2026-08-24
> 状态说明：`✅ 已处理` / `⚠️ 适配可接受（勿改）` / `🚧 架构依赖（需专项）` / `⏳ 未处理`

> 环境差异提示：原版依赖进程内内存（sync.Map、内存图库、连接池）与子进程（MCP stdio）、出站代理节点。迁移到 Worker/DO 时需改为 KV / DO 内存，子进程类能力不可用。已移植代码中"KV 存健康状态、FNV 指纹"属于刻意适配，非 Bug。

---

## 一、新功能可移植清单

### 高优先级（收益最大）

| 功能 | 本地缺失处 | 原仓文件 | 状态 |
|---|---|---|---|
| 多账号池 + round-robin/lastHealthy 故障转移 | `durable.ts` / `cloud-api.ts` 只有单 `getM365Account` | `auth/cache.go`、`server.go resolveAccount/nextHealthyAccount` | ✅(账号池存取·轮询·新会话 failover·按账号健康·管理端)/🚧(每账号并发闸门·显式账号参数透传) |
| 账号级冷却 + 并发闸门（每账号并发上限，区别于会话串行队列） | `account-health.ts` 无 `imageLimited`；`durable.ts` `queue` 为会话级 | `account_concurrency.go`、`account_health.go` | ✅(账号级冷却/图片额度 24h)/🚧(每账号并发闸门) |
| 模型→ChatHub tone 映射 + 动态模型目录 | `proxy.ts` 静态 `M365_MODELS`，无 tone 映射 | `codex_catalog.go`、`server.go modelTone` | ⏳(需上游 tone 实测，避免臆造) |
| 完整 Result 元数据（throttling/suggestedResponses/rawResult/references/citations/metering） | `ChatHubResult` 字段过少 | `client.go` Result | ✅(部分：throttling/rawResult/images 透传入 `m365` 块) |
| 图片额度/内容策略/空返回硬错误（ErrImageLimit/ErrOffensiveContent/ErrEmptyCompletion + 多语 IsContentPolicyBlock） | `chathub.ts rateLimited` 单判别 | `client.go`、`toolloop.go` | ✅ |

### 中优先级

| 功能 | 本地缺失处 | 原仓文件 | 状态 |
|---|---|---|---|
| 工具规划模式(native vs router) + tool_progress 进度事件 + validateDetectedToolCalls 信任边界 + writeToolResponse 分块 | `durable.ts` 硬编码 router | `tool_planning/tool_progress/tooldecision/tool_response.go` | ✅(buildSSE 分块)/⏳(规划·进度·信任边界) |
| ledger StuckLoop / CanContinue / maxToolRounds | `tools.ts AgentLedger` 无此层级 | `agent_ledger.go` | ⏳ |
| 限流二次确认探测接线（原版 30s 新会话 `Reply with exactly: OK`） | `account-health.ts` 有函数但 `durable.ts` 未调用、探针缺失 | `server.go confirmRateLimitNotice` | 🚧 |
| 会话解析多索引 + 清理级联解绑 UnbindByConversation + TTL 可配 | `session.ts` 单列表、无级联解绑、TTL 硬编码 | `session_resolver.go` | ✅(UnbindByConversation)/⏳(多索引·TTL) |
| MCP 工具经 ChatHub 原生插件注入（Source:MCPServer）打通 `mcp-gateway` | `clientPlugins` 只有 API 类 | `chathub/tools.go` | 🚧 |
| ChatHub 连接池复用/预热/GC | 每次新建 WS | `connpool.go` | 🚧 |
| optionsSets / allowedMessageTypes / buildWSURL（XRoutingParameterSessionKey、可配 licenseType/scenario）刷新 | `chathub.ts` 集合过旧/过少 | `client.go` | ✅(optionsSets·allowedMessageTypes)/⏳(buildWSURL) |

### 低/按需

| 功能 | 状态 |
|---|---|
| MCP stdio 子进程客户端、outbound SOCKS 代理池、账号级代理绑定、`plugins.go` EventListener、`codex previous_response_id`、`deployments`/`usage.jsonl`、API Key 二次管理 | ⚠️ 本地已有等价物或 Worker 架构不支持 |

---

## 二、已移植代码需修复的问题

### P0 硬伤 Bug

| # | 问题 | 位置 | 状态 |
|---|---|---|---|
| 1 | 图片恒为空：type=3 硬编码 `imageURLs([])` | `chathub.ts:587` | ✅ |
| 2 | 大数组 `btoa(String.fromCharCode(...imgData))` 20MB spread 崩溃 | `images.ts:274,279` | ✅ |
| 3 | CALL_TOOL 分支跳过 schema 校验 | `tools.ts:268-276` | ✅ |
| 4 | `<m365-tool-call>` 只取首块，多工具截断 | `tools.ts:193-219` | ✅ |
| 5 | `completionEvidenceAllows` 空分支未抑制 `unsupportedSuccess` | `tools.ts:579` | ✅ |
| 6 | `isToolRefusal` 缺 `len>=200` 保护 | `tools.ts:607` | ✅ |
| 7 | Designer 下载重定向透传 Bearer + 任意 Location（SSRF/token 泄露） | `images.ts:82-89` | ✅ |
| 8 | 图片 serve 恒 `image/png`、无 Content-Type/LRU 上限 | `images.ts:309` | ✅ |

### P1 行为偏差

| # | 问题 | 位置 | 状态 |
|---|---|---|---|
| 9 | `emitSnapshot` 重写策略扩过了（indexOf/endsWith/全量重发） | `chathub.ts:480-498` | ✅ |
| 10 | attachments 序列化把 `docId/fileType` 带进 wire | `chathub.ts:216` | ✅ |
| 11 | `isAuthFailure` 匹配普通 `auth` 子串，误判 | `account-health.ts:62-74` | ✅ |
| 12 | 限流冷却 3min 与原生 ~30-60s 偏差 | `account-health.ts:18` | ✅ |
| 13 | JWT 只解 access_token，漏 email | `oauth.ts:70-84` | ✅ |
| 14 | ROPC 走 `/common` 非 `/organizations` | `oauth.ts:289` | ✅ |
| 15 | `compactToolResult` 仅死截断，未保头保尾 | `tools.ts:426` | ✅ |
| 16 | 会话清理不级联解绑（死绑定串号风险） | `session.ts` | ✅ |
| 17 | SSE 工具 arguments 不分块 | `durable.ts:398-403` | ✅ |

### 适配可接受（勿改）
健康状态/会话用 KV、FNV 指纹、手动清理恒带活跃保护、`M365_MODELS` 静态清单。

---

## 三、处理记录（按优先级执行）

### P0 硬伤
- `images` 恒空：将 type=3 收集到的事件传入 `imageURLs`，并用更完整的 URL 提取（键 `url/imageurl/thumbnailurl/downloadurl/src/value/data` + `data:image`）。
- `btoa` spread：改用分块 base64（复用 `chathub.bytesToBase64` 思路），消除 20MB 调用栈溢出。
- 工具解析：CALL_TOOL 要求 schema 通过、`<m365-tool-call>` 循环取全部块、`completionEvidenceAllows` 空分支抑制虚构、`isToolRefusal` 加长度保护。
- Designer 下载：重定向仅允许 `designerapp` 主机、最多 3 跳、仅目标主机带鉴权。
- 图片本地服务：KV 记录实际 Content-Type，serve 用记录值。

### P1 行为
- `emitSnapshot` 对齐原生"仅前缀命中补尾，否则跳过"。
- attachments 序列化剥离 `docId/fileType`（上游 wire 形状对齐）。
- `isAuthFailure` 收紧为明确鉴权信号；限流冷却对齐 ~60s。
- oauth 补充 `id_token` email、ROPC 改 `/organizations`。
- `compactToolResult` 保头保尾。
- `session.ts` 增加 `UnbindByConversation` 并在云端清理时级联调用（防串号）。
- `buildSSE` 工具 arguments 按 512 字符 UTF-16 安全分块。

### P2 功能
- 错误语义：图片额度/内容策略/空返回检测并入 `chathub.ts`，`durable.ts` 映射为 429/502；图片额度触发账号级 24h 封禁（`markAccountImageLimited`）。
- Result 元数据：`throttling/rawResult/images` 透传，非流式响应附带 `m365` 元数据块。
- `optionsSets`/`allowedMessageTypes` 刷新（含 `cwc_code_interpreter_v3`、`rich_responses` 等）。
- 未做（避免臆造上游协议/重架构）：模型→tone 映射、`buildWSURL` XRouting、账号池/并发闸门、MCP 插件注入、连接池、tool_progress/信任边界、限流探针接线，均标注为 ⏳/🚧。

---

## 四、本次变更文件

| 文件 | 变更概要 |
|---|---|
| `src/m365/chathub.ts` | 修 images 恒空（收集 update 帧 → `imageURLs`）；修 `emitSnapshot` 对齐原生；attachments 剥离 `docId/fileType`；补 `classifyChatHubNotice`/内容策略/空返回检测；补 `rawResult/throttling` 返回字段；补 `optionsSets`/`allowedMessageTypes` |
| `src/m365/events.ts` | `imageURLs` 增强为原版启发式（url/imageurl/…/value/data + data:image） |
| `src/m365/images.ts` | 修 btoa spread 崩溃（分块 base64）；修 Designer 下载 SSRF/token 泄露（主机白名单 + 跳数限制）；图库 KV 存 Content-Type 并 serve |
| `src/m365/tools.ts` | 补 CALL_TOOL schema 校验；`<m365-tool-call>` 多块循环；`completionEvidenceAllows` 空分支抑制虚构；`isToolRefusal` 长度保护；`compactToolResult` 保头保尾 |
| `src/m365/account-health.ts` | 收紧 `isAuthFailure`；冷却对齐 60s；新增图片额度 24h 封禁字段与 `markAccountImageLimited` |
| `src/m365/oauth.ts` | token 解析补 `id_token`；ROPC 改 `/organizations` 端点 |
| `src/m365/session.ts` | 新增 `unbindByConversation` 级联解绑 |
| `src/m365/cloud-api.ts` | 云端删除后级联清理本地会话绑定 |
| `src/m365/durable.ts` | 错误语义映射（429/502/图片额度封禁）；`buildSSE` 工具参数分块；非流式响应附带 `m365` 元数据块 |

### 二轮：多账号池

| 文件 | 变更概要 |
|---|---|
| `src/m365/oauth.ts` | 单账号存储 → 账号池 KV(`…:pool`)；`readAccounts/persistAccounts`；旧单账号自动迁移；`writeToken` 按 oid upsert；`getM365Account` 支持 oid；`listM365Accounts/getM365AccountInfos/removeM365Account`；刷新按账号粒度 in-flight |
| `src/m365/durable.ts` | `selectAccounts`（账号池选择：已绑定会话钉账号、新会话健康轮询）+ 主回答账号级 failover（限流/鉴权失败、新会话才切号）+ `mapChatError`；绑定/健康/对话记录改用实际账号 oid；`accountId` 语义改为账号 oid |
| `src/m365/cloud-api.ts` | `doCloudAPI/listConversations/deleteConversation/cleanupCloudConversations` 支持按 oid 指向账号 |
| `src/m365/auto-cleanup.ts` | 清理遍历账号池中每个账号的云端对话 |
| `src/admin.ts` | `handleM365TokenHealth` 返回账号池数组；`handleM365ClearCooldown` 支持 ?oid= 或清全部；新增 `handleM365Accounts`（GET 列表 / DELETE ?oid= 移除，联动清健康） |
| `src/index.ts` | 注册 `/admin/api/m365/accounts/:id` |

> 校验：`cd /workspace && npx tsc --noEmit` 通过（exit 0）。
> 新增管理接口：
> - `GET    /admin/api/m365/accounts/:id`  列出账号池
> - `DELETE /admin/api/m365/accounts/:id?oid=<oid>`  移除账号
> - `GET    /admin/api/m365/token-health/:id`  返回 `accounts[]`（含逐账号可用性/冷却）
> - `DELETE /admin/api/m365/cooldown/:id?oid=<oid>`  清除单账号或全部账号冷却