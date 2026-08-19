# AI Gateway

基于 Cloudflare Workers + Hono 的 AI 提供商 API 代理网关，统一 `/v1` 接口转发，支持多 Key 轮询、健康检查与自动故障转移。

> **二次开发说明**：本仓库基于 [yutian81/ai-gateway](https://github.com/yutian81/ai-gateway) 二次开发。在原有多 Key 轮询 / 健康检查 / OpenCode 故障转移的基础上，新增了 **WorkBuddy/CodeBuddy OAuth 接入**、**每日签到**、**使用统计看板**、**对外管理 API**、**Anthropic/Responses 格式转换**、**Cline 白嫖模型反代（含一键授权）**、**M365 Copilot 接入（含 Agent 工具协议）**、**CNB 免登录免费模型** 等能力，详见下方[「增量功能」](#增量功能基于源仓库的二次开发)。

## 增量功能（基于源仓库的二次开发）

### 1. WorkBuddy / CodeBuddy OAuth 接入

- **设备码登录流程**：OAuth Device Code 登录，登录后自动拉取可用模型
- **CN / Global 双域路由**：解码 JWT `iss` 自动判断账号域，CN 走 `copilot.tencent.com`，Global 走 `www.workbuddy.ai`；APISIX 401 时自动切换备用域
- **access_token 自动刷新**：Cron 每 2 小时定时刷新 + 请求前惰性刷新（提前 60 秒），401/403 时刷新 token 重试
- **模型发现端点可配置**：`oauth.modelsUrl` 支持 WorkBuddy 非标准端点 `/console/enterprises/personal/models`，留空回退 `${baseUrl}/models`
- **预置模板**：CodeBuddy / WorkBuddy 一键填充 baseUrl/apiType/oauth 配置，编辑时自动回显已选模板
- **创建并发起连接**：新建 OAuth 提供商时无需先保存即可发起登录（`?connect={id}` 自动触发）
- **表单智能隐藏**：选择 OAuth 认证类型时自动隐藏"上游 API Keys"和"模型 ID"区块

### 2. WorkBuddy 每日签到

- **Cloudflare Cron 定时执行**：每天 09:00 / 21:00（北京时间）自动签到
- **签到状态查询 + 执行**：仅 CN 账号可签到，国际版自动跳过；今日已签则跳过执行
- **额度信息拉取**：`get-user-resource` 聚合所有资源包，显示 可用 / 已用 / 百分比 / 额度池 / 包数（移植自 CPA 的 `packageRemainUsed` 聚合逻辑）
- **套餐类型识别**：`get-payment-type`（free / paid）
- **JWT 身份解析**：从 access_token 解出 uid / enterpriseId / nickname，补全 billing 接口所需 `X-User-Id` / `X-Enterprise-Id` / `X-Tenant-Id` 请求头
- **多账号支持**：维护多个 WorkBuddy 账号（多 provider），各自独立签到
- **管理后台签到面板**：连续签到天数 / 总积分 / 额度 / 套餐 / 上次签到时间
- **进入面板自动展示最新状态**：先读 KV 缓存快速渲染，再后台静默刷新（`silent` 模式不写日志，避免噪音）
- **手动触发**：全部签到 / 单个签到；支持对外管理 API 远程触发

### 3. 对外管理 API（`/api/manage/*`）

独立于浏览器 Session 的 Bearer Token 认证（`MANAGEMENT_TOKEN` 环境变量，SHA-256 哈希比对），供手机脚本等外部调用，无需登录管理后台。

- `POST /api/manage/providers/upsert` — 创建或合并提供商（apiKeys / models 按 id 去重追加，不覆盖已有 enabled 状态）
- `GET /api/manage/providers` — 查询所有提供商
- `DELETE /api/manage/providers/:id` — 删除提供商
- `POST /api/manage/checkin` / `POST /api/manage/checkin/:id` — 远程触发签到

> 三套凭证职责分离：`MANAGEMENT_TOKEN`（提供商管理）/ `sk_cf_*`（模型调用）/ admin 账号（UI 登录）。详细对接文档见 [MANAGE_API.md](./MANAGE_API.md)。

### 4. API 格式双向转换

- **Anthropic Messages**（`/v1/messages`）↔ OpenAI Chat Completions 双向转换
- **OpenAI Responses**（`/v1/responses`）↔ OpenAI Chat Completions 双向转换
- **流式 SSE 实时转换**：OpenAI SSE → Anthropic named-event SSE / Responses SSE
- **修复 SSE 多事件格式**：单 chunk 触发多个事件时正确用空行（`\n\n`）分隔，避免 `message_stop` 被客户端吞掉（`truncated: stream ended`，file tool 调用必现）
- **流结束兜底**：上游缺失 `finish_reason` 或 `tool_use` 块未关闭时，强制补发 `content_block_stop` + `message_delta` + `message_stop`，并通过 `messageStopSent` / `currentBlockClosed` 标志保证幂等；触发兜底时记录 `warn` 诊断日志（含 providerId / model / tool_use 名称与 id），便于定位偶发的 `truncated: stream ended` 问题
- **上游请求体清洗**：去除 WorkBuddy 不支持字段（`reasoning_effort`、`developer` 角色转 `system`、空 `content` 数组处理）

### 5. 其他改进

- **OAuth 获取模型自动入库**：拉取模型列表后自动合并到 `provider.models`（按 id 去重追加），免手动保存即可测试
- **日志改进**：请求体摘要（避免长消息内容截断）、writeLog 异常保护、错误日志含请求详情与 URL
- **管理后台 UI 视觉重构**：卡片式布局、签到面板、移动端自适应导航
- **GitHub Actions 部署**：workflow 仅允许手动触发（`workflow_dispatch`），禁止 push 事件自动触发

### 6. Cline 接入（移植自 [cline2api-workers](https://github.com/pingmike2/cline2api-workers)）

将 Cline 白嫖模型反代能力集成进网关，作为内置特殊提供商 `cline`，无需独立部署 worker。

- **RefreshToken 多账号池**：每行一个 refreshToken，轮询使用；额度用尽 / 刷新失败 / 401 自动冷却切号
- **Token 缓存与惰性刷新**：refreshToken → accessToken 缓存（提前 60s 刷新），失败自动重试
- **SSE 透传**：转发 `api.cline.bot/api/v1/chat/completions`，剥离 Cline `{data:{...}}` 包装后透传标准 OpenAI SSE
- **串行限流**：免费通道并发 `>1` 会空响应，内部串行队列避免触发限流
- **一键授权（与原项目 `cline_oauth.py` 一致）**：管理后台编辑 Cline 提供商 → 点「一键授权获取 Token」→ 弹出 WorkOS 设备码授权链接 → 浏览器登录 Cline 账号（Google / GitHub / 邮箱）→ 后台轮询并自动把 refreshToken 写入账号池，无需手动跑 Python 脚本
- **同时支持 OpenAI 与 Anthropic 协议**：`/v1/chat/completions` 与 `/v1/messages` 均可调用
- **可用模型**（2026-08 实测）：`poolside/laguna-s-2.1:free` 当前唯一稳定免费可用；`deepseek/deepseek-v4-flash`、`cline-free/glm-5.2` 被 Cline 官方锁定为「仅产品界面可用」（第三方 API 返回 403，原项目同样受限）；`cline-pass/*` 需付费订阅

> 客户端调用：`POST /v1/chat/completions`，`model: cline/poolside/laguna-s-2.1:free`

### 7. 使用统计看板（Analytics Engine）

集成 Cloudflare Analytics Engine，对每次代理请求自动采集用量数据，提供管理后台可视化看板，无需额外存储或数据库。

#### 功能

- **概览卡片**：请求总量、成功率、输入/输出 Token、平均延迟
- **请求趋势图**：基于 SVG 的折线图，支持 24h / 7d / 30d / 90d 切换
- **模型调用排行**：按 model 聚合请求量 + 成功率
- **渠道调用排行**：按 Provider 实例聚合
- **详细日志**：支持时间范围、模型/渠道/结果维度筛选、关键词搜索、分页查看每请求观测字段（模型、Token、延迟、状态码、IP、User-Agent、Colo 等）

#### 配置步骤

1. **创建 Analytics Engine 数据集**

   在 Cloudflare Dashboard → **Analytics & Logs** → **Analytics Engine** → 点击 **Create Dataset**，输入名称 `ai_gateway_usage`，点击创建。

2. **设置查询凭据**

   在 Worker 的 **Settings** → **Variables** 中添加以下两个 **Secrets**（加密变量）：

   | 变量名 | 值 | 说明 |
   |--------|-----|------|
   | `CF_ACCOUNT_ID` | 你的 Cloudflare Account ID | 可在 Dashboard 右侧找到 |
   | `CF_API_TOKEN` | 拥有 `Analytics Engine:Read` 权限的 API Token | 在 API Tokens 页面创建 |

3. **部署验证**

   部署完成后，进入管理后台，左侧导航会看到 **统计** 和 **详细日志** 两个入口。首次使用数据为空是正常的，开始转发请求后自动采集。

> 数据采集是自动的，每次通过网关的代理请求都会记录用量到 `ai_gateway_usage` 数据集。查询凭据仅在面板读取时使用，不影响代理性能。

### 8. M365 Copilot 接入

将 Microsoft 365 Copilot 订阅账号接入网关（移植自 [M365-Copilot2API](https://github.com/IamNewHands/M365-Copilot2API)），走官方 ChatHub 协议，支持 OpenAI / Anthropic / Responses 三种协议调用，含工具调用与图片生成。

#### 8.1 授权方式

- **PKCE 授权码（m365-pkce）**：浏览器完成授权后，把回调 URL 粘贴回后台换 token（推荐，`flowType=m365-pkce`）
- **ROPC 账号密码（m365-ropc）**：企业订阅账号直接用账号密码换 token（`flowType=m365-ropc`）
- **Token 自动刷新**：Cron 每 2 小时刷新 + 请求前惰性刷新（提前 60 秒），401 时按需重试

#### 8.2 会话与对话管理

- **Durable Object 会话**：`M365_SESSION` DO 承载 ChatHub WS 对话，同会话并发串行化，突破 Worker 墙钟限制
- **会话绑定**：客户端可在请求体带 `m365_session_id`，或按末尾消息内容指纹自动分片；绑定信息持久化 KV，支持查询/解除（`GET/DELETE /v1/sessions`）
- **云端对话管理**：查询对话列表、白名单保护、清理配置（keep_n / max_age / after_response / on_exit）、手动清理
- **自动清理**：Cron 每小时自动清理过期云端对话

#### 8.3 Agent 工具协议

ChatHub 上游不支持标准 OpenAI function calling，采用「提示词注入 + fenced block」约定（移植自 `toolloop.go` / `tool_planning.go` / `agent_ledger.go` / `protocol_compat.go`）：

- **Tool Router**：带 tools 时先发起一次独立路由对话，模型显式决策 `CALL_TOOL` / `NO_TOOL_NEEDED`；`tool_choice=required` 时强制重试
- **多种工具调用提取**：`<m365-tool-call>` fenced block、`` ```name\n{json}\n``` `` 约定、原生工具事件树三种解析
- **Agent Ledger（证据台账）**：从多轮消息历史构建已完成/待处理工具证据，去重过滤重复调用（同名称同参数不再触发）
- **Completion Guard**：存在工具证据但回答声称「已完成」且无匹配结果时，替换为未确认措辞，防止模型虚构执行结果
- **Sandbox Hallucination 防护**：检测模型声称在 Linux 沙箱/代码解释器中执行、拒绝 Windows 执行通道等幻觉表述，触发纠正重试
- **JSON Schema 校验**：工具参数严格校验（enum / required / additionalProperties），未声明的工具调用直接拒绝

#### 8.4 图片生成

- **DALL-E 兼容**：`POST /v1/images/generations` / `/v1/images/edits`，走 M365 官方 GPT Image / Designer 生成
- 返回 `b64_json` 或 `url`，支持多图、尺寸、编辑（multipart 或 JSON body）

#### 8.5 账户健康与运维

- **账户健康检测**：限流/鉴权失败自动冷却（默认 3 分钟，`Retry-After` 优先）；限流前先发一条最小消息做二次确认探测，避免误冷却
- **Token 健康查询**：`GET /admin/api/m365/token-health/:id` — 查看连接状态、过期时间、可用性与冷却剩余秒数
- **手动清除冷却**：`DELETE /admin/api/m365/cooldown/:id` — 误冷却后一键恢复

> 调用示例：`POST /v1/chat/completions`，`model: <提供商ID>/gpt-5`；可用模型清单见 [src/m365/proxy.ts](./src/m365/proxy.ts)。

### 9. CNB (cnb.cool) 接入

内置 cnb.cool 免费模型提供商（移植自 [cnb2api](https://github.com/lwjlwjlwjlwj/cnb2api)，MIT）：

- **免登录**：自动抓取首页 CSRF 凭证（csrfkey + window.csrftoken 配对）；**凭证池**（默认 2~8 个独立会话 round-robin 轮转，TTL 30 分钟，可用 `provider.cnbPool` 覆盖 min/max/ttlMinutes），过期/连续失败自动淘汰并补证，401/403 自动换证重试；凭证内存 + KV 双缓存（冷启动复用）
- **内置模型**：`deepseek-v4-flash`、`deepseek-v4-pro`
- **XYML 工具桥**：上游禁原生 tools（403 Agent calls not allowed），`provider.toolBridge` 开启后把客户端 tools 转成 XYML 提示词注入，流式解析回标准 `tool_calls` 返回客户端（[src/cnb/](./src/cnb/)）

### 10. Gemini CLI 接入

内置 Gemini CLI 提供商（移植自 [cpa-plugin-gemini-cli](https://github.com/router-for-me/cpa-plugin-gemini-cli)），使用 Gemini CLI 官方 OAuth 凭据：

- **OAuth 设备码授权**：管理后台一键授权（`GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` 环境变量或表单粘贴，与 cpa-plugin 官方凭据一致）
- **协议自转换**：OpenAI chat.completions → Gemini `generateContent`（messages→contents、tools→function_declarations、system→systemInstruction），响应/流式反向转回 OpenAI SSE
- **内置模型**：`gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-3-pro-preview` 等（清单见 [src/gemini/proxy.ts](./src/gemini/proxy.ts)）

### 11. WebSocket 桥接

支持 Trae 等客户端自定义模型直连网关时走 WS 传输（`GET /v1/*` 带 `Upgrade: websocket` 即进入该通道）：

- 接受 WS 握手后读取首条文本消息（兼容直接 body 或 `{method,path,headers,body}` 信封两种格式），复用 HTTP 转发核心，将上游 SSE/JSON 分块以 WS 帧回推
- 日志仅记录结构信息（model / 消息数量 / 长度），不落盘 prompt 与工具定义全文

### 12. 识图（Vision Bridge 图片转写桥）

让不支持图片输入的纯文本模型具备图片理解能力：请求含图时，网关先调用「视觉模型链」把图片转写为文本，再用转写文本替换图片块转发给主模型。

#### 原理

```
客户端(含图请求) → 检测到图片
  ├─ 无图 ─────────→ 直接转发给主文本模型（零改动）
  └─ 有图 ─────────→ 视觉模型链按顺序依次尝试，把图片转写为文本
                    → 用转写文本替换图片块（标注"网关生成，不可信"）
                    → 连同原文本转发给主文本模型
```

#### 配置步骤

1. **进入提供商编辑**：管理后台 → 提供商 → 新建或编辑一个提供商 → 展开「识图模型配置（可选）」（默认收起，点击展开）

2. **勾选识图模型（视觉模型链）**：从全局已启用模型中勾选用于识图的模型（可跨厂商多选）。**勾选顺序 = 转写优先级**，序号 1 最优先，失败才依次尝试下一个。建议把额度较稳的模型排在前面。

   > 模型引用格式为 `提供商ID/模型ID`（与调用网关时使用的模型 ID 一致）。

3. **选择主文本模型（可选）**：
   - **留空（推荐）**：本提供商自身模型自动共享识图能力，其下所有模型都能识图
   - **填写引用**：本提供商作为「图片转写桥」，所有请求转发到该主文本模型

4. **失败策略**：全部识图模型都失败时，可配置为「报错」或「丢弃图片仅转发文本」（`text_only`）

#### 注意事项

- **识图模型需为 OpenAI 兼容**且支持图片输入；OAuth 提供商（如 WorkBuddy）的识图请求自动复用其认证与 CN/Global 域路由
- **WorkBuddy 上游只支持流式请求**：转写时自动发流式请求并解析 SSE 聚合文本
- **日志定位**：识图成功会在「详细日志」记录 `[VisionBridge] 识图成功`（含实际使用的识图模型与图片组数），便于调整视觉链顺序
- **视觉转写属于不可信上下文**：仅作为普通用户文本注入，不放入 system 提示，避免被诱导执行越权指令


### 13. QoderWork 接入（实验性，未验证通过）

移植自 `cpa-plugin/qoderwork`，作为内置特殊提供商 `qoder`，包含 COSY 签名、OAuth、请求体编码等完整实现（[src/qoder/](./src/qoder/)）。

> ⚠️ **当前状态：未验证通过。** COSY 签名 / 编码链路已移植，但因 QoderWork 上游协议变动或签名校验升级，**实测未能成功跑通**，仅供后续调试参考。如不需要可忽略，不影响其他提供商正常使用。

### 14. 管理后台体验优化

- **首页隐私保护**：首页不再展示模型目录、提供商统计数字；BASE_URL 与 curl 示例统一改用占位符 `https://自定义的域名/v1`，不泄露真实部署域名
- **新增模型免保存即可测试**：编辑已有提供商时，新加的模型行可直接点「测试」按钮验证连通性，无需先点保存（移除了 `/test-model` 端点对模型必须已入库的多余校验）

### 15. 从 aihub 移植的高级能力

一系列面向 API 网关的高级能力，移植自 [yutian81/aihub](https://github.com/yutian81/aihub)，覆盖 MCP 工具聚合、多模型联合调度、缓存运维与转发增强。

#### 15.1 MCP 聚合网关（`/v1/mcp`）

把多个 MCP Server 聚合成一个 OpenAI 兼容的工具调用入口，客户端仅需对接网关一个端点即可使用所有 MCP 工具。

- **管理 API**：`GET/POST /admin/api/mcps`、`PUT/DELETE /admin/api/mcps/:id`，支持配置上游 URL 与鉴权头（`httpHeaders`）
- **JSON-RPC 端点**：`POST /v1/mcp`（需转发 Key），支持 `initialize` / `notifications/initialized` / `tools/list` / `tools/call`
- **工具名前缀**：`工具名.前缀`（`<MCP名>-<工具名>`）避免多 Server 工具名冲突，`tools/call` 按前缀路由回对应 MCP Server
- **并发与重试**：`tools/list` 拉取全部 Server 时并发限制 6，失败自动重试（5 次，间隔 1 秒）
- **SSRF 防护**：MCP URL 复用网关注入的 `isSafeHttpUrl` 校验，禁止内网/私有地址

调用示例：把 `https://你的域名/v1/mcp` 配置为 LLM 客户端的 MCP Server，工具即来自所有已启用的 MCP Server。

#### 15.2 uni-model 联合模型（Unified Model Failover）

一个逻辑模型名映射一组候选模型，按顺序自动故障转移，任一候选成功即返回，无需客户端自行重试。

- **管理 API**：`GET/POST /admin/api/unimodels`、`PUT/DELETE /admin/api/unimodels/:id`
- **用法**：调用 `model: unimodel/联合模型名`，网关按候选顺序依次转发，全部失败返回 `unimodel_exhausted`（附带最后一次错误状态码）
- **自动注入模型列表**：启用且存在候选的联合模型会自动出现在 `/v1/models` 中，provider_name 显示「联合模型」——客户端无需额外配置即可发现
- **兼容权限体系**：联合模型整体仍受转发 Key 的 `allowedModels` 白名单约束；候选模型格式为 `提供商ID/模型ID`

#### 15.3 内存缓存可视化后台管理

- **管理 API**：`GET /admin/api/cache`（列表）、`DELETE /admin/api/cache`（清空全部）、`DELETE /admin/api/cache/:key`（单项清除）
- **管理后台面板**：侧栏「内存缓存」入口，展示每个缓存项的类型、大小、年龄与剩余 TTL，支持单项清除与一键清空
- 适用于 KV 数据更新后不重启 Worker 的即时生效场景

#### 15.4 未配置模型透传（提供商级后台开关）

- **provider.allowUnlistedModels 开关**（管理后台「模型策略」）：关闭（默认）时保持「模型必须预配置」原校验；开启后，请求该提供商的**任意 modelId 都直接转发**，模型是否有效交由上游判断
- 适合模型频繁上架、不想每次后台手动加模型的提供商（如 OpenRouter）
- 已禁用的模型不受开关影响，仍返回 403

#### 15.5 请求头白名单透传

- 默认网关转发上游时只带 `Content-Type` 与 `Authorization`；现在客户端发来的 `x-` / `anthropic-` / `user-` / `referer` 前缀头会**原样透传**给上游
- 场景举例：OpenRouter 的 `X-Title` / `HTTP-Referer`（后台显示调用来源应用名）、仅认 `x-api-key` 的上游供应商、Anthropic 的 `anthropic-version` / `anthropic-beta`、企业网关的 `user-` 身份头
- 注：opencode 等专用通道暂未透传（内部固定使用自有头）；`referer` 系浏览器保护字段，部分 HTTP 客户端（如 undici）会自动吞掉，需要透传时请改用非受限客户端

## 功能与特性（源仓库）

- **统一 API 接口** — 所有 AI 提供商通过 `https://你的域名/v1` 访问，兼容 OpenAI / Anthropic 协议
- **多 Key 轮询 + 健康检查** — 每个提供商可配置多个 API Key，请求随机打乱；失败 Key 自动降权，连续失败 5 次后进入冷却
- **Key 自动恢复** — 降权 Key 冷却 5 分钟后自动获得一次试用机会，成功则恢复权重，失败则重新冷却
- **OpenCode 默认接入** — 默认启用 4 个免费模型，无需配置上游 API Key
- **OpenCode 自动故障转移** — 配置 Key 时优先官方 API，失败后使用公共镜像；无 Key 时直接使用公共镜像
- **多提供商管理** — 默认仅创建 OpenCode，支持自定义添加其他 OpenAI / Anthropic 兼容提供商
- **OpenCode 创建智能填充** — 创建提供商时 ID 输入 `opencode` 自动填充官方 API 地址，API Key 可留空，空 Key 测试时自动走镜像获取可用模型（仅显示 `-free` 和 `big-pickle` 模型）
- **OpenCode 编辑获取模型** — 编辑页可直接从镜像/官方获取模型列表，一键添加到表单
- **两级启用控制** — 提供商级别 + 模型级别的启用/禁用
- **转发 Key 认证** — 生成 `sk_cf_*` 格式的 API Key，支持有效期管理
- **模型连接测试** — 管理后台手动测试模型是否可连接（通过服务端代理，无跨域限制）
- **管理后台** — 卡片式 UI，移动端自适应，无需前端构建

## 技术栈

- **运行时**：Cloudflare Workers
- **框架**：[Hono](https://hono.dev/) v4
- **存储**：Cloudflare Workers KV
- **语言**：TypeScript

## 本地开发

```bash
# 克隆项目
git clone <你的仓库地址>
cd ai-gateway
npm install

# 创建 .dev.vars（已 .gitignore）
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD=your-password >> .dev.vars
echo OPENCODE_MIRRORS_URL=https://opencode.ai.cmliussss.net/zen/v1 >> .dev.vars

# 启动本地开发服务器
npm run dev
```

## 部署

### 方式一：手动部署

1. 在 Cloudflare Dashboard → **Workers & Pages** → 点击 **创建** → **Workers** → **连接到 Git**
2. 选择你的 GitHub 仓库，在构建设置中使用默认选项，点击**保存并部署**
3. Cloudflare Pages 会自动构建并部署 Worker，同时自动创建 `KV` 命名空间并绑定
4. 部署完成后，进入 Worker 页面 → **Settings** → **Variables**，添加：
  - `ADMIN_USERNAME` — 管理后台登录用户名
  - `ADMIN_PASSWORD` — 管理后台登录密码
  - `MANAGEMENT_TOKEN` — 对外管理 API（`/api/manage/*`）Bearer Token，不配置则返回 503
  - `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` — Gemini CLI 一键授权凭据（可选，也可在管理后台表单粘贴）
  - `OPENCODE_MIRRORS_URL` — OpenCode 镜像地址列表，每行一个 URL或用 `,` 分隔。填写以下三个地址：
  
  ```
  https://opencode.ai.cmliussss.net/zen/v1
  https://opencode.fastly.cmliussss.net/zen/v1
  https://opencode.gcore.cmliussss.net/zen/v1
  ```

  > 以上镜像地址来源于CM大佬，在此表示感谢！

- 建议：绑定一个自定义域名

### 方式二：GitHub Actions 自动部署

1. Fork 或推送代码到你的 GitHub 仓库

2. 在 GitHub 仓库 Settings → **Secrets and variables** → **Actions** 中配置：
   - **Secrets**：`CF_API_TOKEN`（Cloudflare API Token，权限需包含 Workers 编辑）
   - **Variables**：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`MANAGEMENT_TOKEN`、`GEMINI_OAUTH_CLIENT_ID`、`GEMINI_OAUTH_CLIENT_SECRET`、`OPENCODE_MIRRORS_URL`（可选，追加额外镜像地址，每行一个，默认已包含上述三个镜像地址）

3. 在 GitHub 仓库 Actions 页面手动触发 **Deploy to Cloudflare Workers** 工作流

> 工作流会在 CI 中自动生成 `wrangler.toml`（含 KV 绑定和 ADMIN 凭据），无需手动配置 Dashboard。

### 部署须知（新增绑定）

- **KV 命名空间**：`wrangler.toml` 中 `[[kv_namespaces]]` 使用 `binding = "KV"`，需在 Dashboard 创建同名 KV 并绑定
- **M365 Session Durable Object**：若使用 M365 Copilot 接入，需创建 `M365_SESSION` DO（SQLite 存储），`wrangler.toml` 已声明 `[durable_objects]` 与 `[exports.M365Session]`，首次部署会自动创建
- **Analytics Engine**：使用统计看板需创建 `ai_gateway_usage` 数据集并配置 `CF_ACCOUNT_ID` / `CF_API_TOKEN`（见上文「使用统计看板」章节）

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台手动生成，格式为：`sk_cf_<KEY>`
- **模型ID**：`提供商ID/模型ID`，默认 OpenCode 模型包括：
  - `opencode/deepseek-v4-flash-free`
  - `opencode/mimo-v2.5-free`
  - `opencode/nemotron-3-ultra-free`
  - `opencode/hy3-free`

OpenCode 默认不需要上游 Key。若在管理后台为 OpenCode 添加 Key，请求会先访问后台配置的官方 API 地址；未成功时再从随机起点依次尝试镜像地址，并使用内置的 `Bearer public`。镜像地址列表通过环境变量 `OPENCODE_MIRRORS_URL` 配置（多行，每行一个 URL），部署脚本默认写入三个公共镜像。用户可在 GitHub Actions Variables 中设置同名变量追加额外地址（全局去重）。已有 KV 数据不会被删除，升级时仅在缺少 OpenCode 的情况下补充该默认提供商。

## 项目结构

```
ai-gateway/
├── src/
│   ├── index.ts                 # 入口，路由注册 + Cron 定时任务
│   ├── types.ts                 # 类型定义
│   ├── config.ts                # 默认配置 / 常量
│   ├── storage.ts               # KV 存储层（提供商 / Key / MCP / 联合模型）
│   ├── auth.ts                  # 认证系统（登录 Session / 转发 Key / 管理 Token）
│   ├── proxy.ts                 # API 转发核心（Key 轮询 + 健康检查 + 自动恢复）
│   ├── opencode.ts              # OpenCode 官方 API 与公共镜像故障转移
│   ├── admin.ts                 # 管理 API（含服务端 Key/模型测试代理、M365 运维接口）
│   ├── pages.ts / pages.css.ts / shared.js.ts   # 管理后台前端模板
│   ├── oauth.ts                 # OAuth 设备码流程 + Token 自动刷新
│   ├── checkin.ts               # WorkBuddy 每日签到
│   ├── ws.ts                    # WebSocket 桥接
│   ├── formats.ts               # 格式转换工具
│   ├── mcp-gateway.ts           # MCP 聚合网关（JSON-RPC：initialize / tools/list / tools/call）
│   ├── analytics/
│   │   ├── types.ts             # Analytics Engine 类型定义
│   │   ├── usage-logger.ts      # 用量数据采集
│   │   ├── query.ts             # 分析引擎 SQL 查询
│   │   └── admin-api.ts         # 分析 API 路由处理器
│   ├── analytics-ui.js.ts       # 前端看板 JS
│   ├── vision/                  # 识图转写桥接
│   │   └── bridge.ts
│   ├── cline/                   # Cline 白嫖模型反代（多账号池 + 一键授权）
│   │   └── proxy.ts
│   ├── gemini/                  # Gemini CLI 接入
│   │   └── proxy.ts
│   ├── cnb/                     # CNB (cnb.cool) 免登录免费模型
│   │   ├── proxy.ts             # CSRF 凭证抓取与请求转发
│   │   └── xyml.ts              # XYML 工具桥（提示词注入 + ToolSieve 流式解析）
│   ├── m365/                    # M365 Copilot 接入
│   │   ├── proxy.ts             # 协议适配（OpenAI/Anthropic/Responses → M365）
│   │   ├── oauth.ts             # PKCE / ROPC 授权 + token 刷新
│   │   ├── chathub.ts           # ChatHub SignalR WebSocket 客户端
│   │   ├── durable.ts           # M365 Session Durable Object（会话串行化）
│   │   ├── session.ts           # 会话绑定（KV 持久化）
│   │   ├── conversation-manager.ts # 云端对话管理 + 清理策略
│   │   ├── auto-cleanup.ts      # Cron 自动清理
│   │   ├── account-health.ts    # 账户健康 / 冷却 / 限流确认探测
│   │   ├── tools.ts             # Agent 工具协议（Tool Router / Ledger / Completion Guard）
│   │   ├── events.ts            # 事件流解析
│   │   ├── cloud-api.ts         # m365.cloud.microsoft 管理面 API
│   │   └── images.ts            # DALL-E 图片生成
│   └── qoder/                   # QoderWork 接入（实验性，未验证通过）
│       ├── proxy.ts / body.ts / cosy.ts / md5.ts / billing.ts / baseprompt.json
├── wrangler.toml                # KV / Durable Object / Analytics Engine / Cron 声明
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml
```

## License

Apache 2.0
