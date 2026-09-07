# AI Gateway

基于 Cloudflare Workers + Hono 的 AI API 代理网关，统一 `/v1` 接口转发，兼容 OpenAI / Anthropic 协议，支持多 Key 轮询、健康检查与自动故障转移。
<img width="3164" height="1657" alt="image" src="https://github.com/user-attachments/assets/8e88a23a-19c1-4ba7-a392-ccdb224ea069" />

## 功能特性

- **统一 API 接入** — 所有 AI 提供商通过 `https://你的域名/v1` 访问，兼容 OpenAI / Anthropic 协议
- **多 Key 轮询 + 健康检查** — 失败 Key 自动降权与冷却，冷却后自动恢复权重
- **多提供商支持** — 内置 OpenCode、WorkBuddy / CodeBuddy、M365 Copilot、Gemini CLI、CNB、Cline 等接入
- **协议格式转换** — Anthropic Messages / OpenAI Responses / Chat Completions 双向转换，含流式 SSE
- **使用统计看板** — 基于 Cloudflare Analytics Engine，无需额外数据库
- **管理后台** — 无需前端构建，卡片式 UI，移动端自适应
- **WebSocket 桥接** — 支持客户端自定义模型通过 WS 直连网关

## 新增功能（基于上游二次开发）

本仓库基于 [yutian81/ai-gateway](https://github.com/yutian81/ai-gateway) 二次开发，在原有的多 Key 轮询 / 健康检查 / OpenCode 故障转移基础上新增了以下能力：

- **WorkBuddy / CodeBuddy / TraeWork 接入** — OAuth 设备码登录、CN / Global 双域路由、Token 自动刷新、模型自动入库
- **WorkBuddy / TraeWork 每日签到** — Cron 定时自动签到，多账号支持，后台签到面板
- **对外管理 API** — Bearer Token 认证（`MANAGEMENT_TOKEN`），支持手机脚本远程管理提供商、触发签到
- **协议格式双向转换** — Anthropic Messages / OpenAI Responses / Chat Completions 双向转换，含流式 SSE 实时转换
- **Cline 接入** — 内置白嫖模型反代，多账号池轮询、一键授权获取 Token
- **使用统计看板** — 基于 Cloudflare Analytics Engine 的用量统计、请求趋势、模型 / 渠道排行
- **M365 Copilot 接入** — 走官方 ChatHub 协议，含会话管理、Agent 工具协议、图片生成、账户健康检测
- **CNB 接入** — cnb.cool 免登录免费模型，凭证池轮转，XYML 工具桥
- **Gemini CLI 接入** — 官方 OAuth 设备码授权，协议自转换
- **WebSocket 桥接** — 客户端自定义模型可通过 WS 直连网关
- **识图（Vision Bridge）** — 纯文本模型通过视觉模型链获得图片理解能力
- **MCP 聚合网关** — 多个 MCP Server 聚合成一个 OpenAI 兼容工具入口
- **uni-model 联合模型** — 一个逻辑模型名映射一组候选模型，自动故障转移
- **其他** — 请求头白名单透传、未配置模型透传开关、内存缓存后台管理、管理后台 UI 优化

> 其中 QoderWork 接入为实验性功能，尚未验证通过。

## 技术栈

- 运行时：Cloudflare Workers
- 框架：Hono v4
- 语言：TypeScript
- 存储：Cloudflare Workers KV / Durable Objects / Analytics Engine

## 本地开发

```bash
git clone https://github.com/IamNewHands/ai-gateway.git
cd ai-gateway
npm install

# 创建 .dev.vars
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD=your-password >> .dev.vars

npm run dev
```

## 部署

推荐使用 GitHub Actions 自动部署：

1. 推送代码到 GitHub 仓库
2. 在仓库 **Settings → Secrets and variables → Actions** 中配置：
   - **Secrets**：`CF_API_TOKEN`（需 Workers 编辑权限）
   - **Variables**：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`MANAGEMENT_TOKEN`
3. 在 Actions 页面手动触发 **Deploy to Cloudflare Workers** 工作流

> 部署完成后，进入 Worker 的 **Settings → Variables** 检查环境变量，并建议绑定自定义域名。

## 管理后台认证（Cloudflare Access，可选）

默认只靠 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录后台。为了更安全，可以用 **Cloudflare Access**（Zero Trust）给管理后台再加一道「邮箱验证码 / Google 登录」认证，并且**完全不影响客户端对接 `/v1` 使用模型**。

### 原理

三层鉴权本就互相独立，客户端 `/v1/*` 走转发 Key（`Bearer sk_cf_<KEY>`），永远不经过管理后台认证：

| 路径 | 鉴权 |
| --- | --- |
| `/v1/*`（客户端调模型） | 转发 Key（不受本方案影响） |
| `/admin/*`（管理后台） | Cloudflare Access JWT + 原有 Session |
| `/api/manage/*`（外部管理 API） | `MANAGEMENT_TOKEN` |

### 配置步骤

1. **Cloudflare 控制台 → Zero Trust → Access → Applications → Add application**，类型选 **Self-hosted**。
   - **Domain / Path**：填你的 Worker 域名，**Path 只覆盖 `/admin` 与 `/admin/*`** —— 这样只有管理后台被 Access 拦截，客户端 `/v1*` 无需登录。
   - **Policy**：身份验证选 **Email OTP（一次性邮箱验证码）** 或 Google / Microsoft OAuth，这就是你要的邮箱验证码登录，无需自己接发信服务。
   - 记下该应用的 **Audience / AUD** 标签。
   - **Policy 的 Session duration** 建议设成较长时间，避免频繁重新验证。
2. **Worker → Settings → Variables** 新增两个环境变量（`CF_ACCESS_AUD` 不配则本加固完全关闭，不影响任何路径）：
   ```toml
   CF_ACCESS_AUD = "<Access 应用的 AUD 标签>"
   CF_ACCESS_TEAM_DOMAIN = "<你的团队名>.cloudflareaccess.com"
   ```
   > `CF_ACCESS_TEAM_DOMAIN` 是你的 Zero Trust 团队域名（Dashboard → Zero Trust → Settings → Team domain），用于拉取 Access 验签公钥，**不是**你的 Worker 主域名。
3. 重新部署 Worker。

### 行为说明

- 访问 `/admin*`：先过 Access（输邮箱验证码）→ 通过后再进入原有用户名 / 密码登录。
- 客户端 `/v1*`：完全不变，只认 `Bearer sk_cf_<KEY>`，正常调用模型。
- 中间件在校验时**优先读 `Cf-Access-Jwt` 头，回退读 `CF_Authorization` Cookie**，两种通道都能正确识别已认证用户。
- `CF_ACCESS_AUD` 已配置但缺少 `CF_ACCESS_TEAM_DOMAIN` 时会返回 500 提示配置错误（防止静默放行）。

## MCP 聚合网关

把多个 MCP Server 聚合成**一个**入口，通过统一的 JSON-RPC 端点对外暴露。客户端只需配置一个地址，即可发现并调用所有已启用 MCP 的工具。

### 端点

| 端点 | 方法 | 认证 | 说明 |
| --- | --- | --- | --- |
| `/v1/mcp` | `POST` | 转发 Key（`Bearer sk_cf_<KEY>`） | MCP JSON-RPC 入口（initialize / tools/list / tools/call） |
| `/v1/mcp/health` | `GET` | 转发 Key | 健康排障：逐个探测各 MCP 的可达性与工具数 |
| `/admin/api/mcps` | `GET/POST` | 管理后台会话 | 查询 / 新增单个 MCP Server |
| `/admin/api/mcps/batch` | `POST` | 管理后台会话 | 批量导入（最多 200 个） |
| `/admin/api/mcps/:id` | `PUT/DELETE` | 管理后台会话 | 更新 / 删除单个 MCP Server |
| `/admin/api/mcps/health` | `GET` | 管理后台会话 | 与 `/v1/mcp/health` 同源，供后台面板调用 |

### 配置方式

1. **管理后台「MCP 网关」**：单个添加、批量导入 JSON 数组、或一键健康检查，均为可视化入口。
2. **单个新增 API**：

```bash
curl -X POST https://你的域名/admin/api/mcps \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "httpHeaders": { "Authorization": "Bearer <TOKEN>" },
    "enabled": true
  }'
```

3. **批量导入 API**（请求体为数组或 `{ "mcps": [...] }`）：

```bash
curl -X POST https://你的域名/admin/api/mcps/batch \
  -H 'Content-Type: application/json' \
  -d '[
    { "name": "github", "url": "https://api.githubcopilot.com/mcp/", "httpHeaders": { "Authorization": "Bearer <TOKEN>" } },
    { "name": "notion", "url": "https://mcp.notion.com/mcp" }
  ]'
```

### 客户端接入

在 Claude Desktop / Cline / Trae 等任意支持 MCP 的客户端中，把 Server 指向网关：

```
URL    : https://你的域名/v1/mcp
Header : Authorization: Bearer sk_cf_<KEY>
```

客户端通过标准的 `initialize` → `tools/list` 握手自动发现工具，无需预先登记。

### 调用约定

- `tools/list` 并发聚合所有已启用 MCP 的工具，工具名自动加 **`{MCP名称}-`** 前缀做命名空间隔离（MCP 名称中的空格会转成下划线）。
- `tools/call` 按前缀路由到目标 MCP，并还原原始工具名转发；上游响应统一归一化为 JSON。
- 单个 MCP 拉取失败会跳过（其余正常聚合），全部失败才返回错误。
- 上游仅支持 **streamable HTTP 单端点**（`POST` JSON-RPC）；老式 SSE 双端点与 stdio 暂不支持。

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台生成，格式为 `sk_cf_<KEY>`
- **模型 ID**：`提供商ID/模型ID`，例如 `opencode/deepseek-v4-flash-free`

## License

Apache 2.0
