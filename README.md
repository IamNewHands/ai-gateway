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

- **WorkBuddy / CodeBuddy 接入** — OAuth 设备码登录、CN / Global 双域路由、Token 自动刷新、模型自动入库
- **WorkBuddy 每日签到** — Cron 定时自动签到，多账号支持，后台签到面板
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

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台生成，格式为 `sk_cf_<KEY>`
- **模型 ID**：`提供商ID/模型ID`，例如 `opencode/deepseek-v4-flash-free`

## License

Apache 2.0
