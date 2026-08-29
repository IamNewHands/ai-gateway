# Gemini 通用推理中转 Worker

解决部分地区直连 Google Gemini 推理端点时返回
`HTTP 400 User location is not supported` 的问题。

部署在 Cloudflare（海外数据中心，出口为美国），把网关发来的推理请求原样转发给 Google，
并如实透传 SSE/JSON 响应。一条中转同时支持两条链路，按路径自动分流：

| 路径前缀 | 目标端点 | 对应网关提供商 |
|---|---|---|
| `/v1internal/*` | `cloudcode-pa.googleapis.com` | Gemini 授权码（OAuth CLI）→ 填「Gemini 推理中转地址」 |
| `/v1beta/openai/*`、`/v1beta/*` | `generativelanguage.googleapis.com` | Gemini 官方 API Key → 填 baseUrl |

**认证请求（OAuth 登录）仍由网关直连 Google，只有推理请求走中转。**

## 为什么是 Worker 而不是填 Clash

AI Gateway 跑在 Cloudflare Workers（云端）上，Cloudflare 服务器**无法直连你本机的
Clash**。Clash 是本地 SOCKS 代理，不是公网 HTTP 端点。所以需要部署一个公网可访问的
HTTP 反代 —— 本 Worker 就是这个反向代理。它本身在 Cloudflare 美国数据中心，出口 IP
就是美国，天然规避地区限制。

## 部署

```bash
cd relays/gemini
npm install
npm run deploy      # 登录 CF 后部署，输出 https://gemini-relay.你的用户名.workers.dev
```

## 在网关里配置（两种方式都填同一个部署地址）

**方式 A — Gemini 官方 API Key 提供商：**

1. 管理面板 → 编辑你的 `gemini-api` 提供商
2. 把 **baseUrl** 改成部署地址：

   ```
   https://gemini-relay.你的用户名.workers.dev
   ```

   网关会在该地址后自动拼 `/chat/completions`，请求变为
   `https://gemini-relay.xxx.workers.dev/chat/completions`，本 Worker 会自动改写映射到
   官方 OpenAI 兼容端点并转发到 Google。（直接填根地址即可，无需手动带 `/v1beta/openai` 后缀。）

**方式 B — Gemini 授权码（OAuth）提供商：**

1. 管理面板 → 编辑你的 Gemini 授权码提供商
2. 在「**Gemini 推理中转地址（可选）**」填入同一个部署地址。
   网关会拼 `/v1internal:*` 请求，本 Worker 原样透传到 Google。

## 工作原理

```
客户端 ──► AI Gateway ──► 本 Worker ──► Google（按路径分流）
```

## 验证实际出口地区

部署后访问诊断端点，确认回源出口 IP 和地区：

```bash
curl https://gemini-relay.你的用户名.workers.dev/__relay_info
```

返回示例：

```json
{
  "ip": "104.XX.XX.XX",
  "loc": "US",
  "colo": "LAX",
  "warp": "off"
}
```

- `loc` = 出口国家码（`US`=美国，`JP`=日本，`SG`=新加坡…）。**日/新/美都是 Google 支持地区**，
  都能规避 `User location is not supported`，不强制要求是美国。
- `ip` = Worker 回源出口 IP，Google 正是按这个 IP 的地区判定请求。
- 只要 `loc` 属于 Google 支持地区（美/日/新等），即说明中转已生效。