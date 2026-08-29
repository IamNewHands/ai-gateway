# Gemini 推理中转 Worker

解决部分地区直连 Google Gemini 推理端点 `cloudcode-pa.googleapis.com` 时返回
`HTTP 400 User location is not supported` 的问题。

部署在 Cloudflare（海外数据中心），把网关发来的 `/v1internal/*` 推理请求
（`generateContent` / `streamGenerateContent` / `countTokens`）原样转发给 Google，
并如实流式回传响应。**认证（OAuth）仍由网关直连 Google，只有推理请求走中转。**

## 为什么是 Worker 而不是填 Clash

AI Gateway 跑在 Cloudflare Workers（云端）上，Cloudflare 服务器**无法直连你本机的
Clash**。Clash 是本地 SOCKS 代理，不是公网 HTTP 端点。所以需要部署一个公网可访问的
HTTP 反代 —— 本 Worker 就是这个反向代理。它本身在 Cloudflare 美国数据中心，出口 IP
就是美国，天然规避地区限制。

## 部署

```bash
cd relays/gemini
npm install          # 安装 wrangler
npm run deploy       # 登录 CF 后部署，会输出 https://gemini-relay.xxxx.workers.dev
```

部署后得到一个 `https://gemini-relay.你的用户名.workers.dev` 地址（不带末尾斜杠）。

## 在网关里配置

1. AI Gateway 管理面板 → 打开你的 Gemini 提供商（编辑卡片）
2. 在「**Gemini 推理中转地址（可选）**」输入框填入上面部署得到的地址：

   ```
   https://gemini-relay.你的用户名.workers.dev
   ```

3. 点击「保存更改」

之后该提供商的所有 `generateContent` / `countTokens` 推理请求都会先到该 Worker，
再由它转发给 Google。**OAuth 登录认证不受影响（仍直连 Google 官方端点）。**

> 想用自定义域名就绑定域名后把地址换成 `<你的域名>`，网关拼 `/v1internal/…` 后缀请求。

## 工作原理

```
客户端 ──► AI Gateway ──(geminiBaseUrl)──► 本 Worker ──► cloudcode-pa.googleapis.com
                                            /v1internal/*   （美国出口）
```

- 只放行 `/v1internal/` 前缀路径（避免被当作任意 URL 跳转/SSRF）
- 透传 `Authorization` / `x-goog-api-key` 等认证头
- 流式 SSE（`streamGenerateContent?alt=sse`）与非流式 JSON 都如实透传