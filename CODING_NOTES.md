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

## Qoder 签到：CST 10:00 轮次边界（2026-10-03 假签到事故）

**现象**：09:01 自动签到日志报 `already / 今日已领取`，但当日积分一整天不动（额度 395）；
10:23 手工再签一次才 +100 → 495。

**根因**：Qoder 的每日活动（`act-20260930-894`，key 里的日期是**活动起始日**、不是当天）
`claimStatus` 按轮次滚动，每轮要等 **CST 10:00** 才刷新放量
（hub `_diag_campaign.py:34-35`「每日 10:00（UTC+8）刷新，错过不补」）。
09:01 看到的 `CLAIMED` 是**上一轮**残留，旧实现据此短路成 `already`，
于是当天真实额度从未入账；10:23 能领到 +100 反向证明 09:01 那次没拿到当轮额度。

**修复（两处，缺一不可）**：

1. **代码**（`src/qoder/billing.ts`）：
   - 判定只认 Credits 奖励活动（对齐 hub `only_kinds=("", "CREDITS")`），
     兑换券类（`REDEMPTION_CODE`）已领不再被当成「今日积分已领」；
   - 新增 `qoderDailyRoundOpen(nowMs)`：CST 10:00 前，列表里的 `CLAIMED` **不算**
     「今日已领」，如实报「尚未刷新，请在 10:00 后重试」，**不再给假绿勾**。
2. **排程**（`wrangler.toml`）：签到 cron 由 `0 1,13 * * *`（09:00/21:00 CST）
   改为 `5 2,14 * * *`（10:05/22:05 CST），避开 10:00 刷新点。

**不要顺手改回去**：
- 不要恢复「列表有任意 CLAIMED 就报 already」——那正是本次事故的成因；
- `qoderDailyRoundOpen` 必须显式收 `nowMs`（纯函数），否则单测会随 CI 挂钟漂移；
- 相关用例（`src/qoder/port-20260923.test.ts`）用 `vi.setSystemTime` 固定到
  10:30 CST / 09:01 CST 两侧，改测试时不要去掉时间固定。

---

## 签到防御加固：TRAE 裸文本假绿消除与 WorkBuddy 记账对齐（2026-10-03）

1. **TRAE 签到假绿防御（`src/trae/upstream.ts` & `src/trae/admin.ts`）**：
   - 根因：原实现用 `low.includes('already') || msg.includes('已签') || msg.includes('今日')` 直接匹配裸错误文本，且 catch 分支不做后置 status 复核。若上游报 500（body 偶带 already）或网络层抛出 `address already in use`、或包含泛词「今日限流」，会直接误判为今日已签到给假绿勾。
   - 修复：
     - 新增 `isAlreadyTraeCheckin`：严格排除网络传输层错误（`kind === 'transport'`）与 HTTP 4xx/5xx 非 200 响应，排除英文短词 `already` 与泛词「今日」，仅认 9095 业务码与专属中文签到文案；
     - 软失败候选分支**必须调用 `fetchCheckinStatus` 进行二次状态复核**，只有后置确认为 `checked_in=true` 才认今日已签到，校验未通过一律如实报失败；
     - `performCheckinClaim` 遇到 9095 显式传出 `{ already: true }`，后置成功后标为「今日已签到」，不再混报「签到成功」。
2. **WorkBuddy / Qoder 池已签 reason 归类对齐（`src/checkin.ts`）**：
   - 根因：`performCheckin` 遇到幂等错误时返回 `{ success: true, message: '今日已签到' }` 但缺少 `already: true` 标记，导致池与单账号路径直接赋值 `base.reason = res.success ? 'ok' : 'fail'`，把已签到记成 `'ok'`（本次成功）。此外，池汇总在全已签时把 summary reason 算成 `'ok'`，导致全量签到摘要与面板徽章将已签到虚高计入「成功」。
   - 修复：
     - `performCheckin` 幂等分支补齐 `already: true`；
     - `checkinOauthPoolAccount` 与 `checkinOneAccount` 统一按 `res.success ? (res.already ? 'already' : 'ok') : 'fail'` 分流；
     - 池汇总 `base.reason` 修正为 `success > 0 ? 'ok' : (already > 0 ? 'already' : (fail > 0 ? 'fail' : 'skipped_no_token'))`，只有真正有新成功账号时才报 `'ok'`。

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

### 建连死线阶梯与 503 `upstream_unreachable`（2026-10-09 落地、2026-10-10 收紧，改超时前必读）

**症状**：DSH 报 `503 upstream_unreachable`，文案「TRAE SOLO 上游连接超时/中断（账号未被惩罚，非账号池问题）：
chat transport error: connect timeout <ms>」；客户端等待 20–45s 后自己 0.5s 重试即恢复（那 0.5s 是 DSH 本地
退避 `initialDelayMs=500 ± 10% jitter`，不是故障信号）。

**根因（已定责，勿再往账号池查）**：网关自己的建连死线掐断「建连 + 响应头」阶段。上游那条 TCP 是**死连接**
（对端接了不答），不是慢连接。证据链：
- 2026-10-08 单变量实验 30s→60s：给到 60s 照样不回（`connect=60000ms timeout=true elapsed=60675ms`），
  而 0.5s 后重开连接的请求几秒内完成 ⇒ 等更久无收益，唯一有信息量的动作是「换一条连接」。
- 2026-10-10 成功侧 `connect=` 分布 9 样本：全部 ≤ 9187ms（中位 2283ms），10–30s 区间零样本。
- 同窗口反证：21:25:06 两段皆死报 503，21:25:12 新连接 `connect=1820ms` 成功 ⇒ 活连接 ~2s 就回话。
- 死连接成因（CF 出站连接池半关连接 / 上游接了不答）在 Workers 里既观测不到也控制不了 ⇒ **网关侧无法根治**，
  能做的只有「早点换连接、少白等」。

**当前值**：`TRAE_CONNECT_DEADLINES_MS = [10_000, 10_000, 10_000]`；`TRAE_CHAT_CONNECT_TIMEOUT_MS` 恒等于最后一段
（单一 owner：未传死线的调用点，如后台「测试连接」，与主路径共用同一判据）。

**加段依据（2026-10-10 当晚由 2 段加到 3 段）**：坏窗口实测 q ≈ 0.5（session-070d26b6 在 22:02–22:25 约 25 个
请求里 12 次「第 1 段撞死」）。此时「多一段」优于「每段更长」——死连接放到 60s 也不回。关键性质：连接成功前
需要打开的连接数期望值恒为 1/q，**与段数无关** ⇒ 加段不增加上游负载，只是把一次客户端重试（0.5–10s 退避 +
一次 HTTP 往返）搬进网关，从而保护客户端那 5 次重试预算（预算耗尽才会让 turn 真正失败：session-3c542aab
turn4/step5 连续 5 次 503 后 `Connection error`）。代价只有最坏死等 21s → 32s（仍优于阶梯上线前的 42s）。

**被证伪的两个旧假设（不要再拿它们当依据）**：
1. 「存在 10–30s 才出响应头的合法慢请求，所以最后一段必须 ≥ 30s」——2026-10-10 分布证伪，该区间零样本。
2. 「两段皆死从未出现」——阶梯上线后 36/36 次 503 全是两段皆死；旧口径 `[10s, 30s]` 让每次失败死等 42s
   （10.5 + 31.7）却从未换来过一次成功。

**纪律**：只有网关自己的定时器掐断（`timing.connectTimeout === true`）才走阶梯重发；上游自己断的
（`timeout=false`）不重发。transport 不罚号（`applyChatError` 的 transport 分支刻意什么都不做）；
带 tools 时不走 Work 兜底，所以坏窗口里客户端看到的 503 由它自己重试兜底。

**不变量与验证**：每段必须 > 实测最慢活连接（现为 9187ms）；逐段不得收紧（`[i] >= [i-1]`）；
`src/trae/truncation.test.ts` 的阶梯组锁三件事——第 1 段撞满→同账号换连接成功、每段都撞满→503 + 逐段日志 +
`attempts=段数`、默认单段 = 最后一段。断言一律按 `TRAE_CONNECT_DEADLINES_MS` 取值，**不写死段数**。
验证命令：`npx tsc --noEmit` + `npx vitest run --pool=threads src/trae`。

**已知观测缺口（调参前先看这条）**：成功侧 `[trae-stream] ... connect=` 是 `writeLog(...).catch()` 的
fire-and-forget（`trae/proxy.ts` 的 onEnd 回调），isolate 收尾时可能丢；失败侧 `[trae-transport]` 是 `await`
落盘。⇒ **调死线最需要的那条数据恰好最不可靠**（2026-10-10 想核对旧口径第 2 段的 `connect=` 分布时，面板里
已经没有这块数据）。要数据驱动调参，得先把救援事件（第 1 段撞死后第 N 段成功）落一条 awaited 日志。

**未做（候选，未拍板）**：① 对冲重试——第 1 条发出后 ~3s 并行发第 2 条，谁先回响应头用谁：成功路径不再付
10s 死等、最坏仍 30s 且有 2 次机会；代价是坏窗口上游收到约 2× 请求，**是否重复计费未实测**。
② 查「约一半新连接是死的」这个 q 本身（上游静默限流 / CF 出站池半关连接），网关侧观测不到，需要外部手段。

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
- `CLINE_CHAT_CONNECT_TIMEOUT_MS = 60_000`（2026-10-01 从 30s 放宽）：长思考与排队场景下
  30s 首字节容易误杀合法请求，放宽到 60s 留出充足推理计算时间，同时比全局 90s 仍有 30s 保护
- `CLINE_MAX_TRANSPORT_ATTEMPTS = 2`：`clineFetchWithRetry` 内对 transport 异常捕获并进行 1 次
  内部退避重试（网络偶发抖动自愈）；撞满 2 次跳出当前模型，不罚号也不死循环
- **回退链遇 transport 故障放行**：`proxyClineChatRequest` 遇 transport 且存在后续候选模型时，
  `continue` 尝试下一个候选模型，真正发挥回退链容灾能力
- **入站 signal 穿透**：Anthropic / Responses 协议入口以闭包向 `proxyClineChatRequest` 注入入站请求 signal

**有意的取舍（不要"顺手改回去"）**：

- 只给**建连阶段**打 transport 标记。账号池问题（`未配置 Cline RefreshToken`、全账号冷却、
  token 刷新失败）**不带标记**，出口不变 —— 把池问题伪装成网络故障是反向误导
- 全局 `OPENCODE_CONNECT_TIMEOUT_MS` 保持 90s 不动：其它 provider（含长思考）依赖它，
  cline 单独收紧，可回退面最小
- 60s 是**可调常量**：若线上出现「60s 内合法未出首字节」的误杀，改这一个值

### Cline 流式三轮拦截的逐尝试归因日志（2026-10-02）

事故现象：用户报「重试延迟 1020 毫秒」+ `502 {"message":"Cline 推理退化/空响应/上游截断连续 3 次未产出可用流","type":"upstream_runaway"}`。

取证（本会话 DSH 会话记录 `session-1dd262ad`）：`turn2/step23` 与 `turn3/step3` 各两次 502，
`delayMs` = 471 / 1020（DSH `initialDelayMs=500` + `jitterRatio=0.1` 的正常区间，**不是故障信号**），
两次都在第 3 次重试成功。按周期耗时反推单次尝试仅 2–9 秒即结束 → 排除建连超时（那是 503
`upstream_unreachable`）、排除 402 额度（`upstream_plan_exhausted`）、排除传输故障（503），
剩「上游 200 之后几秒内空流 / 截断结束」。**与图片无关**：turn2 那次发生在发图之前。

缺口：`proxyStreamChat` 三轮拦截只有三合一聚合 502，**一行日志都不打**，线上无法分辨
退化 / 零帧空流 / 截断无 finish / 探测期读错误（与 cline2api issue #32 的「中间失败无日志」同类）。

修复：

- `pumpStreamAttempt` 新增拦截出口统一构造器 `failed(kind, detail)`，7 个拦截分支各自给出
  稳定 `detail` 值（`probe-timeout-ws-ratio` / `probe-ws-ratio` / `probe-finish-ws-ratio` /
  `probe-finish-length-no-content` / `probe-eof-ws-ratio` / `probe-eof-no-frames` /
  `probe-eof-no-finish`），并附带现场计数 `stats`（`frames` / `content` / `reasoning` /
  `buffered` / `sawFinish` / `probeReadError`）
- `proxyStreamChat` 每次拦截打一行日志（console + **KV 系统日志双出口**，与 `[cline-fallback]` /
  `[cline-max-tokens]` 同一口径）：`[cline-attempt] model=… attempt=n/3 kind=… detail=… frames=… content=… reasoning=… buffered=… sawFinish=… probeReadError=… cooldownReqMs=…`
- 三轮全失败时另补一行聚合结论：`[cline-attempt] model=… 三轮全拦截 → 502 upstream_runaway，明细=[kind:detail, …]`
  ——一条日志即可说清三轮分别空在哪一种

**为什么必须落 KV（2026-10-02 追加）**：`detail` 是唯一定性字段，但它原先只走 `console.log`，
只在 Cloudflare 仪表盘可见；管理面板「系统日志」查不到，用户自己发起一次请求也拿不到归因，
线上排查只能靠猜。落 KV 后：面板「系统日志」搜 `[cline-attempt]` 即可定性。
实现见 `logClineAttempt()`（`env.KV` 缺失时静默跳过，写日志失败不影响响应；有意 await 而非
fire-and-forget，换「响应返回时日志已落盘」的确定性）。

**有意的取舍**：`detail` 是唯一能定性的字段，**新增拦截分支必须给出新的 detail 值**，
否则又回到「只有三合一文案」的不可归因状态。对客户端响应体一个字没改（仍是原 502 文案），
避免客户端按 message 做匹配的逻辑被打破。

### Cline 空壳帧定性 + 「只服务点名模型」决定（2026-10-02）

面板 KV 日志实测定性（15:38）：`detail=probe-eof-no-finish frames=1 content=0 reasoning=0
buffered=2 sawFinish=false probeReadError=false`，**三轮完全一致**。含义：上游 200 → 只回
**1 个零正文帧** → 干净 EOF（无 finish_reason）。确定性复现 ⇒ 重试同一模型纯属白烧。

**用户决定（2026-10-02，明确要求）：网关不得做任何模型级自动替换。** 只服务点名的模型；
它产不出流就按既有语义试满 3 轮（含同模型换号），仍失败直接把错误交给客户端，由客户端
决定重试或自己换模型。

已退役（**不要再顺手加回来**）：

| 退役项 | 原语义 | 现在 |
|---|---|---|
| `clineModelFallbackChain` + `CLINE_FREE_LAST_RESORT` | 构建「点名模型 → 默认免费档 → 目录内全部免费模型 → 末位兜底」候选链（移植 `169fd9d`） | 函数已删；请求路径不再有候选链 |
| 402/429 沿链换模型 | 余额耗尽/限流时自动改走免费模型 | 402/429 原样透传（402 仍带 `upstream_plan_exhausted` 文案，点明该充值或自己换模型） |
| transport 故障换候选 | 建连失败时切下一个候选模型（`456d6ce`） | 撞满内部 transport 重试后直接 503 `upstream_unreachable` |
| `summarizeClineUpstreamError` | 「把上游错误体压成一行」——只为降级链日志服务 | 随链一起删除 |
| `upstream_runaway` 走链（`X-Cline-Runaway` 头） | 曾短暂实现，已撤回 | 只回 502，不换模型 |

新增的**唯一**模型级守卫（不是替换，是快速失败）：点名模型在当前账号池上全部冷却中时，
直接回 `502 upstream_unavailable` 并**不打上游**（此前会换下一个模型继续打）。

回归保护（任何自动换模型路径复活都会红）：

- `流式三轮全拦截 → 只报错，绝不把请求转给链上其它候选模型`（断言请求体只出现点名模型 3 次）
- `transport 故障撞满内部重试 → 503 upstream_unreachable，绝不换模型`
- `只服务点名模型：402/429/5xx/400 一律原样报错，不换模型`（整组）
- `点名模型在所有账号上冷却中 → 502 upstream_unavailable，且不再打上游`

保留的诊断：**`frameSkeleton` 形状摘录**（`describeFrameSkeleton`，进 `stats` 与日志
`firstFrame=`）：`frames=1 content=0` 只能说明「回了一帧空壳」，说不出是**错误帧**
（`{"error":…}`）、**role-only 帧**（模型拒答）还是 **usage-only 帧**（只结算），而三者
处置完全不同。摘录只取键名 / delta 键名 / finish_reason / error.message，不落正文，可安全进 KV。
它是本轮唯一还没收口的证据，拿到 `firstFrame=` 后即可决定是否保留（调试插桩拿到结论就该删）。

**注意**：`probe-eof-no-finish` 目前同时覆盖「真截断」与「上游主动收尾但零正文」——流式探测期
不认 `[DONE]` 为收尾标志（非流式聚合路径已有 `sawDone` 口径）。要分开二者需再加 `sawDone`
标志位；本次未做，因为两者处置相同（都是试满 3 轮后报错）。

### Cline 账号冷却/额度状态显示（2026-10-02，改面板账号行前必读）

**用户报的问题**：面板上看不出某个 Cline 账号已经「额度耗尽被冷却」——`kst-` 徽章只回答
「这条 refreshToken 能不能换 accessToken」，一个 token 有效但免费额度耗尽被冷却 12 小时的账号，
与健康账号长得一模一样。

**为什么必须落 KV（不能直接读内存池）**：冷却状态（`Account.cooldownUntil` / `modelCooldowns`）
原本只存在 **isolate 内存** 的 `pools` 对象里。面板请求与业务流量不保证同 isolate，重启/部署即清零
——直接读内存的后果是「账号正被冷却，面板显示一切正常」。所以冷却发生时就把事实写进
`cline:acctstate:<providerId>`（`src/cline/account-state.ts`），面板从 KV 读。

**设计要点**（每条都有用例钉住）：

| 要点 | 做法 | 理由 |
|---|---|---|
| 谁被冷却 | 留档带 `index` + `masked`（末 4 位）；读取时两者都要匹配 | 换过号的行不硬套别人的记录（面板不猜） |
| 过期判定 | 读时比较 `until`，不靠 KV TTL | TTL 只保证记录最终消失，保证不了「到期即显示正常」 |
| 写配额 | 同账号同原因 30 秒内只落一次盘（`CLINE_ACCOUNT_STATE_WRITE_GAP_MS`） | KV 写配额全功能共享；冷却中的号**每个请求**都会失败一次，逐次落盘会把配额写爆 |
| `until` 单调 | 同原因只许写长，旧写不许把冷却改短 | 并发/乱序下不许把「已冷却」写回「没冷却」 |
| 清档时机 | 只在**真的交付了健康结果**时清（流式 `pumpStreamAttempt` healthy / 非流式拿到 `agg.content`） | 上游额度耗尽的一种形态就是 **200 + 零帧流**；按 HTTP 200 清档会让刚判定的耗尽当场被抹掉 |
| 429 分类 | 文案命中 `daily free (model )?limit` 等 → `quota_empty`（额度耗尽），否则 `rate_limited` | 官方 429 文案是 `Daily free limit reached on model X. Try again in 23h 59m`，两者要分开显示；`until` 取上游给的倒计时（`cooldownFromResponse` 解析，6h 封顶） |

**口径提醒**：面板上的 `until` 是**网关的禁入窗口**，不是上游额度恢复时刻（tooltip 已写明）。
免费档每日额度的重置时间只有上游文案里的 `Try again in …` 一个来源，我们照抄并封顶 6h。

**上游事实（2026-10-02 源码取证）**：Cline **没有**「剩余免费额度」查询接口。可查的只有
`/api/v1/users/{uid}/balance`（微积分）、`/users/{uid}/usages`（逐笔，免费档 `creditsUsed=0`）、
`/users/me/plan/usage-limits`（**仅 ClinePass**，免费账号 404）。免费档每日限额只在被拒时以 429
文案暴露。参考实现 `bouderer/cline2api`（GitHub，**无 license，只能借鉴语义不能抄代码**）。

**端点与界面**：

- `GET /admin/api/providers/:id/cline-account-states`：只读 KV、**不打上游**（面板展开卡片即调用，
  让状态一眼可见，不必先点按钮）；`POST .../cline-accounts/check` 的每行也带同样的字段。
- 面板：账号行 `krun-<pid>-<idx>` 徽章。**已禁用**当场显示（本地事实，无需请求）；冷却状态来自留档。
  红 = 额度耗尽/余额不足/凭据失效（现在真的不可用），琥珀 = 限流/推理空转（多为短时）。
  画法只有一处（`clinePaintRunBadge`），两个数据源共用。
- 客户端脚本版本戳：`CLINE_UP_UI_VERSION = '2026-10-06-acct-state-2'`（改这块客户端行为必须 bump）。

**首版上线后用户报「部署了但看不到徽章」——两个根因（都在客户端接线，tsc 与语法检查全无感）**：

1. **刷新后卡片本来就是展开的**：`restoreAdminState()` 从 localStorage 恢复展开态时只重新加载
   M365/TRAE/Qoder/WorkBuddy 的池子，**Cline 不在其列**——于是「刷新页面」这条最常见的路径下
   什么都没读。修法：抽出 `clineOnCardOpen(id)`，手动 `tog` 与恢复展开态**共用同一个入口**
   （决策收在一处，两条路径不可能再各自漏一半）。
2. **下标坐标系错位**：账号池只装**启用**的账号（`poolFromProvider` 过滤 `enabled`），而面板按
   `provider.apiKeys` 下标对号。只要有一行被禁用，留档就整体错位——**会显示到别的账号那一行上**
   （比不显示更糟：用户去查一个无辜的号）。修法：`Pool.keyIndexes`（池下标 → apiKeys 下标，
   过滤判据必须与 `getPool` 逐字一致），留档与清除都换算后再落库。

**同时补的诊断**：只读读取完成后在按钮旁写一行结果（`冷却留档已读取（时刻）· 未记录到冷却` /
`冷却留档读取失败：…`）。没有这行时，「读取成功但没有冷却记录」与「压根没读取/读取失败」在界面上
一模一样——用户报「看不到徽章」时，正是这两种情况分不清。

### 已知缺口

- **上下文超限不是账号故障**（2026-10-01，`isTraeRequestSideError` 扩充）：上游把上下文超限
  报成 400/413（措辞 `context_length_exceeded` / `context_window_exceeded` /
  `model_context_window_exceeded` / `prompt_too_long` / `prompt is too long` /
  `maximum context length`）。此前这些落 `client` → `noteTraeError` 累计 3 次冷却账号
  10 分钟，把「该缩短请求」误报成「账号坏了」。现与 `4027 invalid_parameter` 同判为
  `client_params`：**4xx 终态原样回传、不罚号、不轮转**（同一 body 换任何账号必撞同一上限）。
  判据仍刻意收窄——无关 4xx 依旧是 `client`，见 `src/trae/request-side.test.ts`。
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

## CodeQL 2026-10-01 轮：URL 子串判定 / ReDoS / 栈信息外泄（真修，非 dismiss）

- **`js/incomplete-url-substring-sanitization`（#80 `src/deepseek/proxy.ts`、#81 `src/pages.ts`）**：
  `baseUrl.includes('chat.deepseek.com')` 会被 `https://chat.deepseek.com.evil.com` 与
  `https://evil.com/?u=chat.deepseek.com` 骗过（CWE-20）——前者会把**别人家的上游**路由进
  deepseek 模块并渲染成「自家上游」面板。
  处理：统一走 **`src/url-host.ts` 的 `baseUrlHostIs(baseUrl, host)`**（解析后 hostname 精确比对；
  空串/非字符串/不可解析一律 false，不猜）。`src/kuku/proxy.ts` 早先已按同一思路手写实现，新代码一律用这个 helper。
  **不要再写子串域名判定**；`pages.ts` 里 `includes('trae')` / `includes('cnb.cool')` 等同类写法尚未被报，
  但属同一族隐患（`includes('trae')` 连 `xtraefoo` 都算命中）。
- **`js/polynomial-redos`（#78 `src/deepseek/sessions.ts`）**：`parseDurationMs` 原用
  `/(-?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g` 逐段 exec，超长数字串 + 非法单位会按起始位置反复回溯。
  处理：改**手写线性扫描**，语义与旧正则逐字对齐（段间不许空隙、单位最长匹配优先 `ms` 先于 `m`/`s`、
  负号/小数点边界、纯数字走「秒」快路径）。回归用例含 5 万位数字串——改回正则形状会超时失败。
- **`js/stack-trace-exposure`（#79 `probe/worker.ts`）**：原把 `err.message` / `cause.message` 直接
  拼进 HTTP 响应体。处理：新增 `describeError()`，只回**结构化枚举字段**（BizError 的 `bizCode`/`code`/
  `httpStatus`、HttpStatusError 的 `status`、连接层 `cause.code`），完整 message 只写 `console.error`。
  ⚠️ **该查询的 source 是 catch 参数本身**（不是 `.stack`），barrier 是「读非 `stack` 属性」——
  所以「只取结构化字段」能真正消警，而「把 message 脱敏后再回」**不能**。
  探针的判定能力靠数字码（40003/风控 vs ENOTFOUND 连接层），不靠 message 文本，诊断力不损失。

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
  （workbuddy cron `5 2,14 * * *` UTC 一天两次）。

**不要"顺手改回去"**：窗口 7 天（后端 `CREDIT_EXPIRY_WINDOW_MS` 与面板 `WB_EXPIRY_WINDOW_MS`
必须同值，面板 trae 侧也统一成 7 天——原先是 3 天，与挑号窗口不一致会误导）；上游 `ExpiredTime`
是 **CST 墙钟串**，浏览器/Workers 都不是 CST，前后端都必须显式按 `+08:00` 解释。

**客户端镜像逻辑要能被单测**：`pages.ts` 内的纯函数块用 `/* WB_EXPIRY_BEGIN */ … /* WB_EXPIRY_END */`
圈出，`pages-inline-script.test.ts` 按标记抽取后用 `new Function` 实例化并直接断言行为
（CST 解析 / 7 天边界 / 空包排除 / 徽章文案 / 到期单元格四态 / 展示列表的隐藏与排序）。
只做"存在性 + 语法"检查的话，口径漂移（窗口写成 3 天、漏掉 remain 判定）在 UI 上看不出来，
但徽章会误导使用者。

**权益包明细的展示规则（两个面板同口径，2026-09-28 追加）**：已用完的包**隐藏不显示**
（workbuddy：`size > 0 && size - used <= 0`；trae：`limit > 0 && rem <= 0`），其余按
**到期升序**排列、长期有效（无到期时间）排最后 —— 快过期的永远在最上面。两个"不要顺手改回去"的点：

- **容量未下发的包不能隐藏**（workbuddy `size <= 0`、trae `limit <= 0`）：无从判定它已用完，
  原样显示「—」才是事实；隐藏等于丢信息。
- 折叠表标题的「可用 / 总额」按**全部**包统计（含被隐藏的已用完包），只是把隐藏数量标出来
  （「已用完 N 个已隐藏」）；若改成按展示行统计，账号真实额度会凭空变少。全部包都用完时
  显示「N 个包已全部用完」，不要渲染空表格（空 tbody 看起来像加载失败）。

## DeepSeek App 提供商（token 注入型，2026-09-30）

背景：`chat.deepseek.com` 安卓 App 私有协议（登录 / 会话 / PoW / SSE），移植自 Go 项目 simple-chat（MIT）。
完整计划、实测证据与任务清单一律以 `DEEPSEEK-APP-PORT.md` 为准，这里只记「不要顺手改回去」的约定。

### 关键决策：凭据是「浏览器注入的 token」，不是账号密码

- 实测：同一账号、同一台机器，用**真实 Chrome + 真实页面 JS + 真实 Shumei device_id** 走密码登录，
  上游照样返回 `biz_code 11 RISK_DEVICE_DETECTED`；参考实现 ds2api（utls 伪造 Safari TLS 指纹）逐字复刻同一组合也被同一码拒。
- 短信登录同样不可用：`create_sms_verification_code` 需要浏览器侧 Shumei `shumei_verification.rid`（无头进程造不出来）。
- 因此 `src/deepseek/client.ts` 的密码登录路径**保留但不接入 provider 流程**；凭据由面板/接口注入
  （`/admin/api/deepseek/:id/tokens`）。token 会过期：失效即标 `expired`、写下 KV、面板标红，并换下一条重试 —— **不静默降级**。
- 取 token 的正确姿势：浏览器登录 → DevTools → Application → Local Storage →
  `userToken` 取 **value 里那 64 字符**（LocalStorage 里是 `{"value":"…","__version":…}` 包装，整段直接用会拿到 `code 40003`）；
  `deepseek-device-id:chat` 取 UUID 作为 `headerDeviceId`。

### 两个新踩到的坑（代码里已注释钉住）

1. `ReadableStream` 的 `pull()` **必须**在返回前 `enqueue` 至少一块或 `close`。既不产出也不结束就返回，
   底层**不会**再次回调，客户端永久挂起（实测 9 个流测试 40s 全超时）。`src/deepseek/stream.ts` 用「pull 内循环」解决。
2. `arr?.[i++]`：`arr` 为 `undefined` 时可选链短路，**自增不执行**（测试里的假上游因此少算一轮）。

### 协议要点（改之前先看）

- 上游是 JSON-patch SSE：`data:` 行是 `{p,o,v}`，**省略 p/o 表示沿用上一次**；裸 `{"v":"字"}` 归到「上一次片段 type」
  （THINK/THINKING → `reasoning_content`，其余 → `content`）。
- 噪声路径必须丢：`quasi_status` / `fragments/-N/status` / `elapsed_secs` / `token_usage` /
  `pending_fragment` / `conversation_mode` / `response/search_status` —— 不丢会被当正文吐给客户端。
- 收尾诚实：只有 `event: close` / `"status":"FINISHED"` 才报 `finish_reason: "stop"`；断流报 `upstream_interrupted`，
  非流式标 `length`（沿用 trae 截断那一轮的定责口径）。
- PoW：HashV1 = SHA3-256 **跳过 Keccak-f 第 0 轮**，现成 SHA3 库都不可用，只能手写；JS 实现实测约 275k 次置换/秒
  （一次 144000 难度约 0.3-0.5s CPU）。
- 补全请求体字段序 = App 的 kotlinx descriptor 序，属于设备指纹的一部分，**不要改成 Map 或排序**。

### 已知缺口

- ~~特殊 provider 分支不走 `finalizeProxyResponse`，因此**不写 analytics usage**（trae 也一样）。~~
  **2026-10-01 实测纠正**：deepseek 分支**确实**走 `finalizeProxyResponse`（`handleProxy` 统一出口），
  用量正常落库。原判断是凭印象写的，已补 3 例回归测试钉住（`dispatch.test.ts` 的「analytics 用量落库」）。
  教训：缺口清单也要有断言兜着，否则会照着错误清单返工。
- 独立 `/v1/web_search` 端点未做（有意）：搜索 hits 已随 chat 响应的 `citations` 返回。

### 风控 park（2026-10-01 接线，**这是本 provider 最重要的安全阀**）

- **为什么必须有**：上游对禁言/封禁账号有「再次违规就加重」的行为。不 park 的话下一次请求会继续挑到
  同一账号，上游看到它又来了就**续期窗口甚至升级处罚**（simple-chat 注释里的实测：6h 禁言 → 3 天封禁）。
- 映射：biz **10** → `banned`（**永久**，只能人工解除）；biz **5** → `muted`（用上游 `mute_until`，
  缺失或已过期退化为 **6h** 兜底）；biz **11** → `risk`（固定 **10min** 冷却）。常量在 `pool.ts`。
- **处罚判定必须优先于鉴权判定**：biz 5/10/11 的信封常带「login」类文案，若先走 `isAuthFailure`
  就会把账号标 `expired` 而**不 park**，下一次请求又打上去，处罚形同虚设。`proxy.ts` 里每个 catch
  都先 `parkFromError(err)` 再判 `isAuthFailure`。
- park 的账号**零流量**，包括后台维护：`sessions.ts` 的 `readyTokens` 也过滤 park
  （对应 Go 的 `TestCleanupSkipsParkedAccounts`）。只要还有一条后台路径碰它，park 就等于没做。
- 自然解禁：`muted`/`risk` 到期自动回到轮转；`clearExpiredDeepseekParks` 会把过期 park 从 KV 清掉
  （**必须回写**，否则重启会把过期 park 重新装载）。`markDeepseekToken({ok:true})` 也清 park。
- 客户端错误形状（对齐 Go `writeUpstreamError`）：banned **502** `account_banned`；muted **429**
  `account_muted` + `Retry-After`（按真实 `mute_until` 算，兜底 60s、上限 24h）；risk **503**
  `upstream_unavailable`（账号在冷却但网关继续服务，客户端该重试而不是以为请求有问题）。
- 面板：池表格显示处罚状态与解禁时刻，「解除停用」按钮走 `POST /admin/api/deepseek/:id/tokens/unpark`。
  封禁是永久 park，**这个按钮是唯一出路**（否则只能删掉重新去浏览器取 token）。

### 图片理解（2026-10-01 接线）

- `src/deepseek/images.ts`：data URL 就地解码 / http(s) 服务端抓取（10MB 上限、30s 超时、MIME→后缀）。
  上传文件名**必须带受支持后缀**——上游按后缀判类型，不看 part 的 MIME。
- 图片在**取号之前**解析：抓外部图床的耗时不能占着池槽位。上传在 attempt 内做，file id 进 `ref_file_ids`。
- 失败语义：抓取失败 → 400 `image_fetch_failed`（且零出站）；上传失败 → 502 `upload_failed`，
  **不**标 token 失效（账号没问题，只是这张图没上去）。
- **与 Go 版的有意差异**：Go 的 `decodeDataURL` 对「不受支持 MIME / base64 损坏 / 超 10MB」静默跳过，
  这与它自己「绝不静默丢图」的契约矛盾（静默丢图会产出一个「客户端以为带了图」的回答）。本仓按契约报错。

### 其它两条本轮补上的护栏

- **超长 prompt**：`assertPromptLength`（上限 200 万字符）在**取号之前**校验，回 400
  `context_length_exceeded`。不校验的话客户端拿到的是归因错误的 502「上游出错」，而真因是请求太长。
  口径按 JS 字符串长度（UTF-16 code unit），与 Go 的字节数**不同**（中文 Go 会先触发）——这是有意的，别「修」。
- **SSE 心跳**：deepseek 流式响应已包 `withSSEKeepAlive`（8s 心跳 / 180s idle 兜底）。开着思考时
  首字节前静默可以很久，不包会被中间层或严格客户端判成断流。日志写在包裹**之前**。

### 分发点与后台维护（2026-09-30 补齐）

- 三个分发点全部接线：`/v1/chat/completions`（原样返回 OpenAI）、`/v1/messages`（转 Anthropic）、
  `/v1/responses`（`handleResponsesSpecial`，传薄包装）。
- **薄包装不是多余**：`handleResponsesSpecial` 内部 `sanitizeUpstreamBody` 会删掉 `thinking`，而 deepseek 只认
  thinking 开关 → 客户端用 `reasoning.effort="none"` 表达「不要思考」会被静默忽略。包装在 sanitize **之后**补回。
  判定统一走 `src/deepseek/request.ts` 的 `isDeepseekReasoningOff()`（`minimal` 也算「关」，因为上游没有中间档）。
- `/v1/chat/completions` + `apiType=anthropic` 这条入口**有意返回 501**：该组合在本仓真实存在
  （`proxy.ts` 里有专门处理它的 `proxyAnthropicNativeUpstream`），但 deepseek 这条入口的 OpenAI→Anthropic 转回还没写，
  明确报错优于悄悄回一个 OpenAI 体让客户端解析失败。
- 会话维护（`src/deepseek/sessions.ts`）接在 `index.ts` 的 `0 * * * *` cron 上：`runSessionCleanup(env)` +
  `runSessionPurge(env)`。**它每小时醒一次不代表每小时动手**——是否动手由模块内 KV 标记 + 抖动判定
  （base 1h ±50%、每次 0.5 概率），面板/日志里 `reason=not-due` 是正常状态，不要去「修」。


### 测试约定

本仓 vitest 在 DSH 沙箱内必须带 `--pool=threads`（默认 forks 池会 `spawn EPERM`）。
DeepSeek 的 SSE 测试吃的是**真实上游固件**（`src/deepseek/__fixtures__/completion-{plain,thinking,search}.sse.txt`），
上游改协议时用 `DS_LIVE_PROBE=1 DS_LIVE_CAPTURE=1 npx vitest run --pool=threads -t captures src/deepseek/live-capture.test.ts` 重抓。