# AI Gateway

基于 Cloudflare Workers + Hono 的 AI 提供商 API 代理网关，统一 `/v1` 接口转发，支持多 Key 轮询、健康检查与自动故障转移。

> **二次开发说明**：本仓库基于 [yutian81/ai-gateway](https://github.com/yutian81/ai-gateway) 二次开发。在原有多 Key 轮询 / 健康检查 / OpenCode 故障转移的基础上，新增了 **WorkBuddy/CodeBuddy OAuth 接入**、**每日签到**、**对外管理 API**、**Anthropic/Responses 格式转换**、**Cline 白嫖模型反代（含一键授权）** 等能力，详见下方[「增量功能」](#增量功能基于源仓库的二次开发)。

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

### 7. QoderWork 接入（实验性，未验证通过）

移植自 `cpa-plugin/qoderwork`，作为内置特殊提供商 `qoder`，包含 COSY 签名、OAuth、请求体编码等完整实现（[src/qoder/](./src/qoder/)）。

> ⚠️ **当前状态：未验证通过。** COSY 签名 / 编码链路已移植，但因 QoderWork 上游协议变动或签名校验升级，**实测未能成功跑通**，仅供后续调试参考。如不需要可忽略，不影响其他提供商正常使用。

### 8. 管理后台体验优化

- **首页隐私保护**：首页不再展示模型目录、提供商统计数字；BASE_URL 与 curl 示例统一改用占位符 `https://自定义的域名/v1`，不泄露真实部署域名
- **新增模型免保存即可测试**：编辑已有提供商时，新加的模型行可直接点「测试」按钮验证连通性，无需先点保存（移除了 `/test-model` 端点对模型必须已入库的多余校验）

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
   - **Variables**：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`OPENCODE_MIRRORS_URL`（可选，追加额外镜像地址，每行一个，默认已包含上述三个镜像地址）

3. 在 GitHub 仓库 Actions 页面手动触发 **Deploy to Cloudflare Workers** 工作流

> 工作流会在 CI 中自动生成 `wrangler.toml`（含 KV 绑定和 ADMIN 凭据），无需手动配置 Dashboard。

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
│   ├── index.ts       # 入口，路由注册
│   ├── types.ts       # 类型定义
│   ├── config.ts      # 默认配置
│   ├── storage.ts     # KV 存储层
│   ├── auth.ts        # 认证系统
│   ├── proxy.ts       # API 转发核心（Key 轮询 + 健康检查 + 自动恢复）
│   ├── opencode.ts    # OpenCode 官方 API 与公共镜像故障转移
│   ├── admin.ts       # 管理 API（含服务端 Key/模型测试代理）
│   ├── pages.ts       # 前端页面模板
│   ├── pages.css.ts   # 样式
│   └── shared.js.ts   # 共享 JS 工具函数
├── wrangler.toml
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml
```

## License

Apache 2.0

## 星星走起

[![Star History Chart](https://api.star-history.com/chart?repos=yutian81/ai-gateway&type=date&legend=top-left&sealed_token=ss5l0FbgLFED_spRh5MGVvFPQXDCPXMWds6_dNkiuSrV1ESAvtN32rTu3h59YAu1cUWg2yKcFf1bZLX5Q4Cic1RgaLixtg_F81tOAvMEnoYRi4nE_plSMwSC-JC3lCGiTCwGBdd1yRwsXgV9owq1Jll7i2NnNKEx6b30mK7nspfrbAFBFYvCXLjR9P7W)](https://www.star-history.com/?repos=yutian81%2Fai-gateway&type=date&legend=top-left)
