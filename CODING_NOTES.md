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
- **transport 撞满 2 次即跳出**（`MAX_TRANSPORT_ATTEMPTS = 2`，2026-09-27 追加）：transport 与
  账号健康无关（`applyChatError` 对它刻意不罚号），**换号没有信息增益**——第 2 次撞的还是同一条
  「网关↔上游建连」。SOLO 主循环与 Work 循环（`executeWorkRequest`）各自计数、各自跳出；Work
  循环原先**没有** transport 分支，transport 会落到 `else` 走 `noteTraeWorkError` **罚号**（违反
  上面那条铁律），本轮一并修掉。保留 2 次而非 1 次：单次失败可能只是抖动，第 2 次仍失败才足以
  定性为「链路持续不可达」。**transport 路径的 Work 兜底每次请求只试一次**（`workFallbackTried`）：
  第 1 次 transport 时循环内已兜底，撞满跳出后函数末尾按该标记跳过，否则同一条链路会被撞两轮、
  503 前的总等待被放大成 2×（2×30s ×2）。
  **不要"顺手改回" MAX_ROTATE 的 3**：那 3 次是给**账号相关**故障（plan_limit/soft_rate/
  session_dead）用的，撞不同账号才有信息增益。
- **`doJson` / `doJsonText` 的连接层失败也打 `kind='transport'`**（2026-09-27 追加）：这两个
  短请求辅助（ExchangeToken / 模型 / 签到 / 积分）原先抛**裸** Error（无 `kind`），于是
  proxy 两处 refresh catch 的 `else` 分支把网络抖动当成账号故障冷却 10 分钟
  （`reason='refresh: ...'`）——正是上面那条铁律的反面。现在 fetch catch 打 transport 标记，
  两处 refresh catch 加 transport 分支：**不冷却、只计数、撞满 `MAX_TRANSPORT_ATTEMPTS` 即跳出**
  （与转发阶段同一纪律：换号没有信息增益）。区分保持不变：`session_dead`（401 家族）仍禁用账号，
  `refresh_failed: no token in response` 这类**凭证真失效**仍是账号问题，继续冷却。

**测试样本铁律**：构造「成功响应」样本时必须带自然收尾事件（SOLO `event: done`、Work
`event: done` 或 `[DONE]`）。修该缺陷时当场揪出 4 处既有样本缺收尾事件却断言 200/`stop`
——它们是被聚合层假 `stop` 掩盖的截断样本；给任何「兜底伪装」逻辑动刀前先修样本，
否则会把正确的回归误判成 bug。

### 第二类截断：上游发了 done、正文却停在半句（2026-09-27，`fd301f9` 之后仍复现）

`fd301f9` 的防线只在 `!sawDone` 时触发（`sse.ts` 收尾分支），线上却继续复现半句截断，
且**带着 `finish_reason=stop` 到达客户端**（DSH 会话 `session-39578d55` seq 1407，
2026-09-27 18:49:13，`finish=stop` + `turn/end=completed`）。部署已确认：`fd301f9` 新增的
503 文案（`trae/proxy.ts` 的「TRAE SOLO 上游连接超时/中断」）在真实会话里 14:02:19 就出现，
距提交 13:59:34 只隔 2 分 45 秒，即那批截断跑的都是新代码；235 个会话文件里防线帧
（`upstream_no_finish` / `upstream_interrupted` / 「未发送 done」）出现 0 次。故这类截断
**不是**「没发 done」，防线按设计抓不到——不是修复失效，是修的不是这一类。

剩下两种可能，靠收尾审计（`SoloDoneAudit` / `onAudit`，日志口径 `trae-stream end=done-audit`）
区分。**审计只记日志：不改任何下行帧、不罚号**（与 `end=runaway` 同纪律）：

- `dones=1` 且 `postDoneContent=0`：上游自己就产出了这么多（模型早停，或上游半路掐断却报
  stop）——协议上无从区分，只能在内容层做兜底
- `postDoneContent>0` 或 `dones>1`：上游在 `done` 之后仍在发正文，而网关照发、客户端见
  `[DONE]` 即丢弃后续帧（OpenAI 兼容客户端一律如此）→ 网关侧缺一个「done 之后停发」的刹车

配套两条排除法（复查同类问题前先做，免得又绕回账号池/定时器）：截断步耗时 p50 10.5s
（正常 9.3s，无 30/60/90s 聚集 → 不是超时定时器）；`outputTokens` p50 844（正常 902，
且 `finish kind` 里 `max-tokens` 是独立取值 → 不是 token 上限/退化熔断）。

**待查缺口**：`sse.ts` 的解析 switch 只读 `output` / `token_usage` / `done` / `error` 四种
事件的字段；`sse.ts` 头部事件序列里列出的 `extra_info`、以及 `metadata` / `timing_cost`
一个字段都没读——上游若把收尾原因（截断标记之类）放在 `extra_info`，现在是被静默丢掉的。

### Cline 建连超时定责（2026-09-27，改 cline 转发/超时前必读）

事故现象：用户报「重试延迟 543 毫秒」，失败原因是
`500: {"message":"The operation was aborted","type":"api_error"}`。**543ms 是正常退避，不是故障**：
DSH 的 retry policy 是 `initialDelayMs=500` + `jitterRatio=0.1`（`dsh-llm/lib/types/retry-policy.js:12-15`），
第 1 次重试天然落在 450–550ms。真正的病在**单次尝试要烧 90 秒**。

取证（DSH 会话记录 `session-f634b209`）：`step/start` → 91.0s → 183.5s → 292.0s → 385.1s，
每次恰好 +92s，与 `OPENCODE_CONNECT_TIMEOUT_MS = 90000` 吻合。全仓该错误体唯一生产者是
`cline/proxy.ts` 的 catch（AbortError 被原样包成 500）；DSH 把 "500" 归类 SERVER 并重试 5 次
（`dsh-llm-pi-ai/lib/index.js:1372`），而退避上限只有 8s → 5 次重试 ≈ 7.5 分钟全撞同一个卡死的上游。

修复（对齐 trae `fd301f9` 的定责口径）：

- `clineFetch` 给建连/首字节失败打 `kind='transport'`（`ClineTransportError`），**不罚号**
  （同 trae `applyChatError` 的 transport 分支纪律：一次网络抖动不该刷空账号池）
- `proxyClineChatRequest` 的 catch 分流：transport → **503 `upstream_unreachable`**，
  文案写明「账号未被惩罚，非账号池问题」；其余保持 500 `api_error`
- `CLINE_CHAT_CONNECT_TIMEOUT_MS = 30_000`，经 `streamFetchWithTimeout` 的
  `connectTimeoutMs` 显式传入（**不继承全局 90s**）。与 `TRAE_CHAT_CONNECT_TIMEOUT_MS` 一致，
  单次失败成本 91s → 31s

**有意的取舍（不要"顺手改回去"）**：

- 只给**建连阶段**打 transport 标记。账号池问题（`未配置 Cline RefreshToken`、全账号冷却、
  token 刷新失败）**不带标记**，出口不变 —— 把池问题伪装成网络故障是反向误导
- 全局 `OPENCODE_CONNECT_TIMEOUT_MS` 保持 90s 不动：其它 provider（含长思考）依赖它，
  cline 单独收紧，可回退面最小
- 30s 是**可调常量**：若线上出现「30s 内合法未出首字节」的误杀，只改这一个值

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

## CodeQL：`js/clear-text-logging` 在本仓是「命名启发式」误报（2026-09-27 定责）

- 该查询的 source 是**按名字猜**的（CodeQL `HeuristicNames`）：变量名/属性名命中 `apiKeys`、`oauth*`
  即当作敏感数据。本仓 Provider schema 恰好就叫 `provider.apiKeys` / `provider.oauth`，天然撞名。
- 实锤：`src/proxy.ts:930/932` 只打印两个普通 `string` 形参（`providerId`、`model`）也被判为泄露
  ——污点顺着 Provider 对象流动，**改日志字段/脱敏打印都消不掉这一族告警**（2026-09-16 已 dismiss 30 条同类）。
- 处理：**逐条 dismiss（reason = false positive）**。
- **不要再写 `// codeql-disable`**：CodeQL / GitHub code scanning **不支持**内联抑制注释，那是无效写法，
  只会让下一个人以为已经抑制了（7e7dc49 又加了 7 处）。
- 想一劳永逸只有两条路，都属人的决定、不默认做：advanced setup 的 `codeql-config.yml` 里
  `query-filters: - exclude: id: js/clear-text-logging`（等于整仓放弃该查询），或自维护一份改过 source 的查询副本。
- 真修的例子（本轮）：`src/pages-inline-script.test.ts` 内联脚本抽取正则改 `<\/script\s*\/?>`，
  修掉 `js/bad-tag-filter`（原来漏掉 `</script >` 这类结束标签 → 少校验一段客户端脚本）。

## 挑号规则：7 天内到期积分优先（2026-09-28）

积分带到期时间，原「积分高低」挑号会让低分号的整包额度直接过期作废。现两个池统一为两段式
（owner：`src/credit-expiry.ts`，纯函数、两个池各自供到期数据源）：

- **第 1 段**：候选里存在「窗口内（7 天，含边界）到期且仍有剩余」的积分包 → 只在其中挑，
  **到期最早者优先**（同到期再比积分/权重）。workbuddy 还会跳过实测**免费层**（`costTier===0`
  不消耗积分，钉住某个号没有收益）。
- **第 2 段**：窗口内没有待救积分 → 完全回落原规则（workbuddy 三因子加权随机 /
  trae 积分最高、Work 通道 workCredits 最高）。**未探测过 packs/packages 的账号天然走这一段**。
- trae 的 SOLO 与 Work 通道**各看自己那一类包**（`isWork`）：混用会把另一个通道的额度提前烧掉。
- workbuddy 到期数据落在池状态 `state.packages`（随手签到写路径落盘；`[]`＝探测成功但无包，
  会清旧明细）；trae 落在 `state.packs`。两者都**不在请求热路径写**，最多滞后到上一次探测
  （workbuddy cron `0 1,13 * * *` UTC 一天两次）。

**不要"顺手改回去"**：窗口 7 天（后端 `CREDIT_EXPIRY_WINDOW_MS` 与面板 `WB_EXPIRY_WINDOW_MS`
必须同值，面板 trae 侧也统一成 7 天——原先是 3 天，与挑号窗口不一致会误导）；上游 `ExpiredTime`
是 **CST 墙钟串**，浏览器/Workers 都不是 CST，前后端都必须显式按 `+08:00` 解释。

**客户端镜像逻辑要能被单测**：`pages.ts` 内的纯函数块用 `/* WB_EXPIRY_BEGIN */ … /* WB_EXPIRY_END */`
圈出，`pages-inline-script.test.ts` 按标记抽取后用 `new Function` 实例化并直接断言行为
（CST 解析 / 7 天边界 / 空包排除 / 徽章文案 / 到期单元格四态）。只做"存在性 + 语法"检查的话，
口径漂移（窗口写成 3 天、漏掉 remain 判定）在 UI 上看不出来，但徽章会误导使用者。
