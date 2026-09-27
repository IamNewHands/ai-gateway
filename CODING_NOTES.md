# 开发备忘（CODING_NOTES）

本项目迭代中反复踩坑的约定。改代码前先看这里，尤其是涉及管理后台页面模板时。

## ⚠️ SSR 内联 JS 转义铁律（最高优先级）

`src/pages.ts` 是用 **TypeScript 模板字符串（反引号）整体渲染成 `<script>` 内联脚本** 的 SSR 页面。
任何转义失误都会导致 **整块脚本语法错误 → 后台所有按钮/函数失效**，且错误只在浏览器控制台报
`xxx is not defined`，极难排查。已多次踩坑，铁律如下：

1. **单反斜杠陷阱**：想要渲染后 JS 里出现 `\'`（JS 字符串内的转义单引号），**源文件必须写 `\\'`（两个反斜杠）**。
   写单反斜杠 `\'` 会在模板字符串里被解释成裸单引号 `'`，使渲染出的 JS 单引号字符串提前闭合 → SyntaxError。
   ```ts
   // ✅ 正确（渲染后为 onclick="mcpSave('...')"）
   onclick="mcpSave(\\'' + id + '\\')"
   // ❌ 错误（渲染后单引号字符串提前闭合，必炸）
   onclick="mcpSave(\'' + id + '\')"
   ```

2. **JSON 注入一律用 `serializeForScript()`**，禁止裸 `JSON.stringify` 拼进模板：
   - 不转义 `<` 时，数据里的 `</script>` 会直接截断 HTML script 块；`<!--` 会开启 HTML 注释吞掉后续脚本。
   - 数据里的 U+2028 / U+2029（JS 行/段分隔符）会令字符串字面量非法（ES2019 前）。
   ```ts
   const X = ${serializeForScript(data)};   // ✅
   const X = ${JSON.stringify(data)};       // ❌
   ```
   该方法在 `renderAdminPage` 内定义，转义 `<` → `\u003c`、U+2028 → `\u2028`、U+2029 → `\u2029`。

3. **禁止裸反引号与裸 `${`**：页面 JS 内容里出现 `` ` `` 会结束 TS 模板字符串，出现 `${` 会被当作插值。

4. **转义函数选型（不要混用）**：
   - 字符串值进 HTML → `escapePageHtml()`
   - 字符串值进内联 JS 属性（onclick / onchange 等）→ `escapePageJs()` / `escapePageJsx()`

5. **改完必须验证**：重新渲染管理页，把生成的 `<script>` 内容存文件后 `node --check` 校验；
   或至少核对所有新写的 `\'` 都是 `\\'`。
   （诊断脚本示例：登录拿 cookie → fetch `/admin` → 正则抽取 script → `node --check`）

以上同样适用于经 `${SHARED_JS}` / `${ANALYTICS_JS}` 注入的 `shared.js.ts` / `analytics-ui.js.ts`。

## 其他约定

- **git 提交约定**：改完代码后**自动提交并推送**到仓库（用户约定，无需再询问）。提交前先 `git pull --rebase` 避免远程有更新。
- **git 推送目标（用户手记）**：**没有特殊说明时，改动一律直接推送到 `main` 分支，不要新建分支 / 不要开 PR**（fast-forward 推进；推 main 前先 `git fetch` 确认线性、不覆盖远程独占提交）。
- **避免新增 npm 依赖**：本仓库仅依赖 hono。需要并发限制等小工具时自实现（如 `mcp-gateway.ts` 的 `mapWithLimit`）。
- **类型检查**：`npx tsc --noEmit`（`npm run build` 的 wrangler dry-run 在部分环境会因日志写入权限退出非零，不代表构建失败）。
- **存储键隔离**：新增 KV 键在 `config.ts` 的 `KV_KEYS` 注册；新功能数据与现有 providers / proxyKeys 键隔离。
- **SSRF 防护**：新增外部 URL 配置统一过 `isSafeHttpUrl` 校验。
- **不破坏现有 API 契约**：路由、KV 结构、响应字段对客户端保持向后兼容；新字段一律可选。

---

## TRAE（SOLO 协议）适配指南

TRAE 上游（`trae-api-cn.mchost.guru`）**不是 OpenAI 兼容端点**，是 SOLO 私有 SSE 协议
（`/llm_utils/chat`，需账号池登录态 + sign 签名）。网关在 `src/trae/` 内部完成
「客户端 OpenAI/Anthropic ↔ SOLO 协议」的转换。**对接新接口（如 Responses API）或排查
TRAE 相关问题前先读本节。**

### 数据流总览

```
客户端(OpenAI chat/completions)
  → src/proxy.ts forwardProxy ──isTraeProvider──▶ src/trae/proxy.ts proxyTraeChatRequest
      ├─ 非流式: upstream.chatStream → sse.aggregateSoloSse → OpenAI JSON
      └─ 流式:   upstream.chatStream → sse.soloStreamToOpenAIStream → OpenAI SSE
客户端(Anthropic /v1/messages) → proxy.ts handleAnthropicMessages ──isTraeProvider──▶ 同上，
      再经 formats.ts 把 OpenAI SSE ↔ Anthropic SSE
管理后台测试连接 → admin.ts handleTestModel ──isTraeProvider──▶ trae/proxy.ts testTraeModel（SOLO 账号池真实测试）
```

### src/trae/ 文件职责（改前必读）

| 文件 | 职责 | 对接新接口时看 |
|---|---|---|
| `constants.ts` | `TRAE_STATIC_MODEL_IDS`（预置模型表）、账号池 KV 键等 | 加新模型 |
| `types.ts` | `TraeAccount`、模型 plan 类型 | — |
| `payload.ts` | `prepareBody`：OpenAI 请求体 → SOLO 请求体（工具→function_call、图片→多模态、`tool_choice` 归一） | 请求体改造 |
| `upstream.ts` | SOLO HTTP 调用：`chatStream`（流式）、`doJson`/`doJsonText`、`parseAuth`/`serializeAccount`、`sign` 签名 | 上游协议变化 |
| `pool.ts` | 账号池：`getTraeAccounts`/`pickTraeAccount`（积分高者优先）/`saveTraeAccount`、1005/429/401 冷却与禁用、签到解冻 | 账号流转逻辑 |
| `sse.ts` | SOLO/Work SSE ↔ OpenAI SSE：`soloStreamToOpenAIStream`、`workStreamToOpenAIStream`、`aggregateSoloSse`/`aggregateWorkSse`（含 `truncated` 收尾判定）、`normalizeStreamToolCalls`、`mergeToolCallJSON`/`mergeToolCallDelta` | **流式/非流式转换，坑最多**；改收尾逻辑前读「收尾定责与兜底决策」 |
| `admin.ts` | 管理后台：`handleTraeModels`（拉取模型）、`handleTraeStatus`、`handleTraeCheckin` | 后台功能 |
| `proxy.ts` | 主入口 `proxyTraeChatRequest`、新增的 `testTraeModel` | 入口分流 |

### 对接新接口（如 /v1/responses 的 TRAE 支持）需要动的位置

1. **`src/proxy.ts` 新增 `handleResponsesTrae`**（参照现有 `handleResponses` 的 OAuth 分支骨架）：
   - `getProvider` → 校验模型 → `responsesToOpenAI` 转 OpenAI 格式 → `{...body, stream: true}`（TRAE 只支持流式，非流式由本层聚合）
   - 调 `proxyTraeChatRequest(c.env, provider, upstreamBody)` 拿 OpenAI SSE
   - 流式：`formats.ts` 的 `openAIChunkToResponsesSSE` 实时转 Responses SSE，结尾兜底 `response.completed`
   - 非流式：聚合后 `aggregateOpenAIToResponses`
2. **`src/proxy.ts` `handleResponses` 内、vision-bridge/gemini/cnb/m365 分支后**加 `if (isTraeProvider(provider)) return handleResponsesTrae(...)`（TRAE 在 `provider.apiKeys` 存的是账号 JSON，绝不能掉进"非 OAuth 通用转发"路径——那里会把账号 JSON 当 Bearer key 发到 `baseUrl/chat/completions`，端点也不存在，必然失败）。
3. `src/index.ts` 若新增路由需先于 `/v1/*` 通用中间件注册。

### 已踩的坑（务必遵守）

1. **body 只能读一次**（Workers 硬限制）：`response.json()` 失败后 catch 里再 `response.text()` 必抛
   `Body has already been used. Use tee() first`。正确姿势：**先 `text()` 一次，再 `JSON.parse`**
   （参考 `testModelConnection` / 通用转发错误路径）。全仓禁止 `json().catch(() => text())` 模式。
2. **流式 SSE 必须完整收尾，且「收尾完整」不等于「回答完整」**（否则客户端（AI SDK / iOS 严格解析器）报 `truncated: stream ended`）：
   - 有 tool_calls 时强制最后一个 chunk `finish_reason: 'tool_calls'`
   - 上游提前断流时兜底补「收尾 chunk + `[DONE]`」
   - 首个非空 delta 注入 `role: 'assistant'`
   - **上游没发 `done` 就结束时，收尾前先注入一帧具名 error**（`upstream_no_finish` /
     `upstream_interrupted`），并回调 `onTruncated({kind, contentChars, …})` 落
     `[trae-stream] end=truncated` 日志。只补收尾会让半句话看起来像正常完成：严格客户端
     见到 `data.error` 才抛错重试（`openai` SDK `core/streaming.js` 遇 `data.error` 即抛）
3. **流式 tool_call 增量清洗**（`normalizeStreamToolCalls`）：
   - 空 `tool_calls` 数组整体丢弃；缺 `index` 按数组位补齐
   - **空字符串 `id` / `function.name` 必须删掉**：SOLO 后续增量会发空串，严格客户端对增量是「覆盖」而非「补缺」，空值会冲掉首块已落定的 id/函数名 → 工具解析失败
4. **非流式聚合必须区分「收到 done」与「没收到 done」**（`aggregateSoloSse` / `aggregateWorkSse`）：
   - tool_calls 时 `finish_reason='tool_calls'`、清理残留 `index`、补 `type: 'function'`、
     `mergeToolCallJSON` 只合并非空 id/name
   - 返回值第三字段 `truncated`（复用 `SoloStreamEndInfo`，`kind=read_error|no_done`）非空即
     「上游半路断」：**调用方不得把 `resp` 当成功返回**；`err` 优先（err 非空时 `truncated` 为 null），
     避免两套失败语义打架
   - 无 done 时 `finish_reason` **不得谎报 `stop`**（无工具调用降级 `length`，有工具调用保留
     `tool_calls`）——它是客户端侧最后一道可见信号
   - Work 侧自然收尾有两个信号（`event: done` 与 SSE 层 `[DONE]`），与
     `workStreamToOpenAIStream` 的 `sawDone` 保持一致
5. **测试连接走 SOLO 账号池**（`testTraeModel`）：TRAE 的凭证在 `provider.apiKeys`（每行一个账号 JSON），上游无 `/chat/completions` 端点——通用 `testModelConnection` 对它必然失败，必须在 `handleTestModel` 加 `isTraeProvider` 分支。
6. **流式响应头**：`Content-Type: text/event-stream`、`Cache-Control: no-store`、`X-Accel-Buffering: no`（防中间层缓冲）。
7. **Anthropic 路径对 TRAE 强制 `stream: true`**：TRAE 上游只支持流式，非流式由本层聚合后再转 Anthropic JSON。

### 收尾定责与兜底决策（2026-09-27 静默截断事故，改 TRAE 收尾逻辑前必读）

事故：客户端回答停在半句，而会话记录里 `finish=stop`、`turn/end=completed`（2026-09-27，
`trae/deepseek-v4.1-flash`，DSH 会话 `session-e83b2ca2`）。取证结论：DSH 侧无错，是网关把
「上游没发 `done` 就断」兜底成了正常收尾。修复：`fd301f9`（流式）、`e27009b`（非流式聚合）。

**定性铁律：连接层/收尾层失败不是账号故障，禁止罚号。** `sse.ts` 的收尾异常与 `upstream.ts`
的 `kind='transport'`（建连超时/被掐断）都不得进入 `noteTraeError` / `noteTraeWorkError`
（`trae/proxy.ts` 的 `applyChatError` 对 `transport` 刻意什么都不做）。

反例代价：一次网络抖动累计 `errCount` → 触发冷却 → 外层报 `503 no_healthy_account`
「all accounts unavailable (cooling/disabled)」。实测那次连撞两个账号共 62s ≈
2×`TRAE_CHAT_CONNECT_TIMEOUT_MS`，520ms 后重试即成功（池子是健康的），而错误文案把排查
方向引向了账号池。

**为什么截断不复用 `err` 通道**：`err` 会走 `applyStreamError` →（非请求侧错误）`noteTraeError`，
即上面那条铁律的反面；若用哨兵 code 复用，还要在 SOLO 错误码空间里长期维护一个臆造值，
未来上游真发出同码即误判。因此非流式聚合新增独立 `truncated` 字段，`err` 语义不变。

**有意的取舍（不要"顺手改回去"）**：

- 截断的终态仍是 **HTTP 503**（客户端按可重试 5xx 处理，语义不变），只把 `code` 改为
  `upstream_unreachable`、文案写明「账号未被惩罚，非账号池问题」
- 拒绝「200 + `finish_reason=length` + 半句正文」作为终态：客户端不会重试，用户只拿到半句；
  `length` 只作为聚合层最后一道可见信号保留（上游 `done.finish_reason='length'` 属真实上限截断，
  原值照传，不得改写或误报）
- 流式：error 帧**先于**合成收尾发出 —— 严格客户端（`openai` SDK）见到即抛错重试，
  宽松客户端仍能靠 `stop` + `[DONE]` 正常收尾
- `kind='transport'` 纳入 Work 通道兜底（仅 `!hasTools` 时）：Work 走另一条 host/协议
  （`create_agent_task`），是同因不同路的真兜底，比继续轮流撞同一个建连超时（30s×N）划算

**测试样本铁律**：构造「成功响应」样本时必须带自然收尾事件（SOLO `event: done`、Work
`event: done` 或 `[DONE]`）。修该缺陷时当场揪出 4 处既有样本缺收尾事件却断言 200/`stop`
——它们是被聚合层假 `stop` 掩盖的截断样本；给任何「兜底伪装」逻辑动刀前先修样本，
否则会把正确的回归误判成 bug。

### 已知缺口

- ~~`/v1/responses`（Responses API）无 TRAE 分支~~ **已支持**：`handleResponses` 内加
  `isTraeProvider` / `isClineProvider` 分支，复用 `handleResponsesSpecial`（OpenAI 请求体 →
  专门转发函数拿 OpenAI SSE → `openAIChunkToResponsesSSE` 转 Responses SSE / `aggregateOpenAIToResponses` 聚合）。
- `/v1/responses` 的 Gemini 分支尚未包 SSE 心跳（若 Gemini 思考模型静默期截断，参照 `handleResponsesSpecial` 的 `withSSEKeepAlive` 补上）。

### 流式心跳配置（防模型静默期被客户端判为断流）

TRAE 思考模型在推理阶段可能 15~20s 不发数据，客户端（AI SDK / iOS 严格解析器）通常有
~15s 空闲超时，无数据即判定流结束 → 回答被截断。所有**发往客户端的 SSE 流**都应按需包
`withSSEKeepAlive(stream, keepAliveMs, idleTimeoutMs)`（src/opencode.ts）：
- 心跳：距上次输出超过 keepAliveMs 注入 `: keep-alive\n\n` 注释行（SSE 标准注释，客户端忽略但重置 idle 计时器）
- idle 兜底：上游超过 idleTimeoutMs 完全无数据则主动结束流（防挂起）
- TRAE 直出流（`trae/proxy.ts`）：`TRAE_KEEPALIVE_MS = 8000`、`TRAE_STREAM_IDLE_TIMEOUT_MS = 180000`
- 转换后流（proxy.ts 的 Anthropic / Responses 转换）：`SSE_KEEPALIVE_MS = 8000`、`SSE_IDLE_TIMEOUT_MS = 180000`
- 心跳注释行仅对**严格 SSE**（text/event-stream）安全；Anthropic / Responses 转换循环都以 `data:` 前缀过滤行，注释行会被自然跳过，不会污染解析
