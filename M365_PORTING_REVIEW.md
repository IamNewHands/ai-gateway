# M365 移植复查：剩余未修复问题清单

> 对照原版 [HEXUXIU/M365-Copilot2API](https://github.com/HEXUXIU/M365-Copilot2API)（Go）对 `src/m365/*`（TypeScript / Cloudflare Workers）做逐模块移植复查，共发现 **40+ 处差异**。本文档记录**剩余未修复**项，按优先级排列。已修复项见文末「已修复」小节。

**说明**：本清单为「行为/能力风险」普查，不包含「默认即可用、无需改动」的无害差异（已在原审查中分流）。每项给出：位置（文件/函数）· 现状 · 原版行为 · 影响 · 建议修复方向。优先级按「是否会直接导致功能失效 / 数据异常」划分。

优先级说明：

- **P0**：核心功能可能失效或产生数据异常，建议优先处理
- **P1**：明确行为偏差，影响实际使用质量
- **P2**：能力缺失/能力弱化，多数场景可用但有退化
- **P3**：健壮性/一致性优化，非阻塞

---

## 未修复清单

### P0

#### 1. 流式（`stream:true`）退化为伪流式
- **位置**：`src/m365/durable.ts`（DO 主流程、`buildSSE`/`buildJSON`）
- **现状**：DO 等整个 `chatWithHandlers` 完成后，才用完整 outcome 一次性构建全部 SSE chunk；`onDelta` 只做字符串累积，**无增量透出**。
- **原版**：SSE 通道上随收到事件增量透出 delta，每 15s 发一次 keepalive；客户端断连会通过 `r.Context().Done()` 中止上游对话。
- **影响**：客户端长时间收不到任何字节（易被中间层/客户端超时掐断）、无 keepalive、客户端断连无法取消上游对话（浪费账号额度）。
- **建议**：DO 侧建立可中断的 WS→Worker 流式桥接，将 `onDelta` 实时推给 Worker；Worker 侧透传 SSE 并支持断开时中止 DO fetch。

#### 2. 工具轮数 / 死循环熔断门禁未启用
- **位置**：`src/m365/tools.ts` 的 `canContinue`、`buildAgentLedger`；`src/m365/durable.ts`（工具循环）
- **现状**：`buildAgentLedger` 已接入（durable.ts 用它做多轮工具证据注入、去重），但 **`canContinue` 熔断门禁无调用方**——轮数超限 / StuckLoop（同一失败调用 ≥3 次）/ RepeatedFailure / pending 未回复均不会触发 409 熔断，`MAX_TOOL_ROUNDS_DEFAULT` 恢复 512 但未被使用。
- **原版**：`server.go` 每请求用 `buildAgentLedger` + `CanContinue(maxToolRounds())` 门禁，轮数超限/StuckLoop/RepeatedFailure/pending 未回复 → 409 `tool_round_limit`；`maxToolRounds` 默认 512。
- **影响**：模型进入工具死循环/反复失败时网关侧无熔断，可能无限消耗账号轮次直至超时。
- **建议**：在 durable 工具循环入口接入 `canContinue` 门禁，命中即返回 409 `tool_round_limit`。

---

### P1

#### 3. 错误冷却策略大幅简化（403 / 429 / 503 / 空响应 / Retry-After / 全局熔断）
- **位置**：`src/m365/account-health.ts`（`markAccountFailure`、`isRateLimited`、`accountCooldownSeconds`）
- **现状**：
  - 403 归入 `isAuthFailure` → 冷却 **2 分钟**（原版 24h）
  - 429 固定 60s，**无指数退避**（原版 30s·2^(n-1) 封顶 30min）
  - 503 不冷却、不视为限流（原版 15s 冷却，`IsRateLimited` 含 503）
  - 空响应 / 未知错误不冷却（原版 10–30s）
  - `retryAfterSeconds` 参数**无调用方传入**，Retry-After 恒被忽略
  - 全局熔断器（30s 窗口 ≥10 次且失败率 ≥50% 则熔断 30s）完全缺失
- **影响**：被封禁账号每 2 分钟被重试；过载时不退避，账号被打爆。
- **建议**：引入指数退避与分类冷却时长，503 纳入限流类，接通 Retry-After，补全局熔断器（单实例语义在 DO/KV 场景需适配为分布式方案）。

#### 4. 图片 URL 提取输入范围受限（Designer 生成图可能漏提）
- **位置**：`src/m365/chathub.ts`（`rawFrames` 收集）、`src/m365/events.ts`
- **现状**：`rawFrames` 只收集 **type=1 update 帧**的 `arguments`；图片 URL 只从这里提取。
- **原版**：`events` 收集**所有** SignalR 帧（含 type=2 result 帧），`images = imageURLs(events)`。
- **影响**：只出现在 result 帧（如 `result.value`/item 元数据）里的生成图 URL 会被漏掉，`/v1/images` 可能返回「no image resource」误报，或图片生成链路丢图。
- **建议**：把 `rawFrames` 扩展为收集 update + result 帧的 arguments/result 内容。

#### 5. WS dial / 流式路径不读取 Retry-After 与 keepalive
- **位置**：`src/m365/chathub.ts`（WS dial 分支、事件循环）
- **现状**：WS dial 失败不读 `Retry-After` 头；405 / 3xx 等 dial 错误未被分类进冷却（调研报告里 DialError{Status,RetryAfter,Kind} 未移植）。
- **原版**：dial 失败解析 HTTP 状态与 Retry-After，路由到正确冷却类别。
- **影响**：401 / 429 类 dial 失败无针对性退避。
- **建议**：dial 失败解析状态码与 Retry-After，接入 account-health 冷却。

#### 6. 请求画像缩水：`variants` / `allowedMessageTypes` / `optionsSets` / `clientInfo`
- **位置**：`src/m365/chathub.ts`（`buildWSURL` 的 variants、payload 构造）
- **现状**：
  - variants 尾部缺 10 个 flag（`EnableMergingPureDeltas`、`EnableRemoveStreamingMode`、`EnableConversationShareApis*`、`feature.*ImageGen*Throttled` 等）
  - allowedMessageTypes 缺约 18 种（`GenerateGraphicArt`、`GenerateContentQuery`、`RenderCardRequest` 等）
  - optionsSets 缺 code-interpreter / flux_v3_references / image-gen-dimensions 系列，多了一个原版没有的 `cwc_code_interpreter_v3`，且 7 个 FeatureFlags 开关整体未移植
  - clientInfo 缺 `clientEntrypoint`、`clientSessionId`、`ProductCategory` 等 7 字段
- **原版**：`client.go` / `server.go` 完整携带并按 FeatureFlags 条件附加。
- **影响**：画图、引用输出、代码解释器等能力可能因上游按列表过滤消息而失效；`cwc_code_interpreter_v3` 是原版没有的 flag，可能引入未知行为。
- **建议**：谨慎对齐（优先补 variants 与 allowedMessageTypes 的静态缺项；optionSets 依赖 FeatureFlags 的部分需评估后实施）。

---

### P2

#### 7. `toolProtocolPrompt` 分支方向相反 + 缺防截断前缀
- **位置**：`src/m365/tools.ts`（`toolProtocolPrompt`）、`src/m365/chathub.ts`（`hasPlugins`）
- **现状**：有插件时注入一段原版没有的 `[system] The caller is a client application...` 前缀；无插件时原样返回（缺失原版对每个无工具请求注入的「请完整回答、勿截断」前缀）；完整 `<tools>` 注入文本缺失「不要使用内置 code interpreter / Python 沙箱」防幻觉段，且把「one or more fenced blocks（支持并行多调用）」写成了「**ONLY one** fenced block」。
- **原版**：有工具 → 原样返回不注入提示词；无工具 → 注入防截断前缀；tools 注入支持并行多块。
- **影响**：无工具请求长回答有截断风险；并行工具调用指令被反转成单块限制。
- **建议**：修正分支方向与多块语义，补齐防截断前缀与防沙箱幻觉段。

#### 8. `clientPlugins` 缺 mcp-gateway 插件条目
- **位置**：`src/m365/chathub.ts`（`clientPlugins`）
- **现状**：只生成 `{Id, Source:'API', ...}`；`src/mcp-gateway.ts` 的 MCP 聚合未接入 M365 流程。
- **原版**：在 mcpServerURL 非空时恒注入 `{Id:'mcp-gateway', Source:'MCPServer', ...}`。
- **影响**：M365 原生工具经 MCP 回调网关的执行链路缺失。
- **建议**：若 M365 需走 MCP 工具，接入 mcp-gateway 条目。

#### 9. 提示词管道差异（`flattenPromptMessages`、`isToolRefusal` / `isSandboxHallucination`）
- **位置**：`src/m365/tools.ts`
- **现状**：`flattenPromptMessages` 不聚合 system/developer（原版前置聚合为单一 system 块），工具消息 content 非 string 时只提 text/output（数组型 tool_result 丢失）；`isToolRefusal` 吞并 `isSandboxHallucination` 且带 200 长度限制（沙箱幻觉 ≥200 字符不触发纠正、<200 用较弱纠正词）。
- **原版**：system/developer 前置聚合；tool content 整体 JSON 序列化；两个检测独立，后者无长度限制且用专门纠正词。
- **影响**：系统指令可能落在消息序列中间；Anthropic 风格数组 tool_result 内容丢失；沙箱幻觉纠正弱化。
- **建议**：对齐聚合与序列化；拆分独立沙箱幻觉检测。

#### 10. `validateDetectedToolCalls` 缺 tool_choice 校验 + 空 arguments 默认
- **位置**：`src/m365/tools.ts`（`validateDetectedToolCalls`、`extractToolCalls`）
- **现状**：函数签名无 `choice` 参数（`tool_choice` 约束对原生事件路径完全失效）；arguments 为空串/`"null"` 时 `JSON.parse` 抛异常/得 null → 一律丢弃。
- **原版**：`tooldecision.go` 先 `toolChoiceAllows(choice, call.Name)`；空/`"null"` arguments 默认 `{}` 并保留继续校验。
- **影响**：原生工具事件不受 tool_choice 约束；空 arguments 调用被误丢。
- **建议**：补 `choice` 参数并在调用处传入；空/`"null"` arguments 归一为 `{}`。

#### 11. 会话复用层缺失（convCache / 内容键之外的复用）
- **位置**：`src/m365/durable.ts`（会话解析）、`src/m365/session.ts`
- **现状**：只实现内容键 resolver；`user` 字段存进绑定但不参与匹配；`account+model+systemPromptHash` 的 convCache 完全缺失。
- **原版**：另有 `body.SessionKey` 会话存储、`body.User` 用户会话、convCache 三层复用。
- **影响**：复用命中率与延后退化。
- **建议**：视需要补 convCache 层。

#### 12. `cloneMessages` 不截断 512 条
- **位置**：`src/m365/session.ts`（`cloneMessages`）
- **现状**：全量保留。
- **原版**：按原子边界截最后 512 条。
- **影响**：超长对话 KV value 持续增长（KV 25MB 上限风险）。
- **建议**：按原子边界截断。

---

### P3

#### 13. 图片生成忽略 `accountId`/`user`，多账号时 token 与生成账号错配
- **位置**：`src/m365/images.ts`、`src/m365/oauth.ts`（`getM365Account`）
- **现状**：忽略 `user/accountId`；Designer token 取池内第一个账号，而实际生成由 DO 内健康选号。
- **原版**：同一账号贯穿生成与下载。
- **影响**：Client 手动指定 `accountId`/`user` 时不生效；token 与图片归属可能不同账号 → 下载失败。
- **建议**：要求指定账号时，生成与下载使用同一账号。

#### 14. 认证若干健壮性差异
- **位置**：`src/m365/oauth.ts`
- **现状**：
  - 惰性刷新传空配置 `{} as OAuthDeviceConfig`，自定义 `clientId/scope` 的 provider 刷新退回默认 client_id
  - `getM365Account` oid 未命中时**静默回退池内第一个账号**（原版明确返回不存在）
  - `upsertHistory` 只按 `oid` 匹配（原版按 ID **或 email** 合并，同邮箱重登会分裂成两条池记录）
  - 账号池 KV 明文 + 30 天 TTL（原版 AES-GCM 加密落盘、无 TTL）
- **影响**：自定义 client 配置失效；oid 失效后用错账号 token；同邮箱重登分裂；凭据明文落盘 & 闲置 30 天整池过期。
- **建议**：按需对齐（加密、email 合并、oid 未命中时明确报错）。

#### 15. 换 token 端点 no-op 三元 + ROPC 端点硬编码
- **位置**：`src/m365/oauth.ts`（`refreshM365Token`、`m365ROPC`）
- **现状**：`conf.authority ? M365_OAUTH.tokenUrl : M365_OAUTH.tokenUrl` 两分支相同（no-op 三元）；`doRefreshM365Token` 同样硬编码 `/common`；ROPC 硬编码 `/organizations/`。
- **影响**：配置了自定义授权端点时换 token 仍打 `/common`，流程断裂（当前默认无影响）。
- **建议**：让换 token 端点由可配置 authority 派生。

#### 16. `images.ts` 参数校验放宽 / 响应形状差异
- **位置**：`src/m365/images.ts`、`src/m365/index.ts`
- **现状**：`n>10` 静默截断（原版 400）；`response_format` 不校验（原版 400）；`data:image/` 无逗号不报错；生成图片返回相对 URL `/v1/images/files/${id}`（原版绝对 URL）；响应缺 `m365:{...}` 元数据块。
- **影响**：非标准请求被放行；OpenAI 客户端对相对 URL 处理不一定兼容。
- **建议**：按需对齐校验与 URL 形状。

#### 17. Designer 下载重定向语义与 Content-Type 校验差异
- **位置**：`src/m365/images.ts`（`downloadDesignerImage`）
- **现状**：重定向到非 designer 域时匿名跟随并成功返回（原版直接判失败，2 跳上限 vs 这里 3 跳）；Content-Type 缺失默认 `image/png`、不校验 `image/` 前缀（原版缺失时嗅探、非图片报错）。
- **影响**：可能把 HTML 错误页当图片存储。
- **建议**：按需收紧重定向与 Content-Type 校验。

#### 18. 并发闸门等待语义（立即 429 vs 排队）
- **位置**：`src/m365/account-flux.ts`（`acquireSlot`）+ `src/m365/durable.ts`
- **现状**：最多轮询 8s 后放弃 → 429 `Retry-After: 5`。
- **原版**：`Acquire` 阻塞直到有空位或请求 ctx 结束。
- **影响**：高并发下客户端立即收到 429，而非排队。
- **建议**：确认产品预期后按需对齐。

#### 19. cron 全量刷新 vs 原版只刷临期账号
- **位置**：`src/oauth.ts`（`refreshAllM365PoolTokens`）
- **现状**：遍历池内每个账号无条件刷新（我方上一轮修复引入的保活策略）。
- **原版**：只刷 `now > ExpiresAt-30s` 的临期账号。
- **影响**：刷新更频繁、对上游请求更多（换取账号不被闲置失效/池 TTL 重置）；需权衡保活收益与上游请求量。
- **建议**：保留保活但可考虑仅在「临期 或 超过闲置阈值」时才刷新。

---

## 已修复（历史提交 + 本次新增，仅记录）

以下 32 项差异已在 `904a79f`、`b1433cb`、`6f43ac7`（历次修复）中解决或主动调整：

- **账号池续期**：cron 只读单 token key 不刷账号池 → 已改为遍历池逐个刷新；状态按钮只显示最闲置账号 → 已改为逐账号健康；30 天池 TTL 保活。
- **云端清理**：cloud API token audience 混用（401）→ 已换专用 scope token；createTimeUtc 缺失误删 → 已回退为跳过；recordConversation 重置 createdAt → 已保留原创建时间。
- **工具路由**：`schemaValid` 条件方向写反 → 已修复（合法调用放行、非法调用拒绝）。
- **图片链路**：Designer token 用错 client_id → 已改 `M365_OAUTH.clientId`；轮换 refresh_token 未持久化 → 已回写账号池；提取回退 `||` 死代码 → 已改两级回退；URL 判定丢 query / value-data 键 / url 数组键漏提取 → 已对齐启发式；`/v1/images/edits` btoa 展开溢出 → 已改分块。
- **账号健康**：24h 图片封禁 TTL 错配（只活 1h）→ 已覆盖最长到期；markAccountSuccess 误清图片封禁 → 已保留至到期。
- **ChatHub 协议**：首轮 payload 缺 sessionId/conversationId → 已回填进 req；图片额度/内容策略检测缺失 → 已补齐三处检测 + 词表对齐；WS close 错误入队顺序 → 已修复；会话绑定把 reasoning 拼进 content → 已分离。

以下 **6 项**在复查后的新一轮修复中解决（`8b36159`、`a2acfb5` 等提交）：

- **会话前缀匹配缺原子边界检查**：`contextPrefixLen` 已增加原子边界校验（`atomicBoundaryOk`），历史不结束在消息原子边界时返回 0，避免增量从 tool 往返中途开始。
- **图片附件下载失败被静默跳过**：download / upload 失败、超限、非 2xx 一律 `throw`，整请求失败（同原版），不再 `continue` 静默跳过。
- **WS URL 缺 query 参数**：`buildWSURL` 已补齐 `XRoutingParameterSessionKey=requestID` 与 `isEdu=false`（对齐 `client.go` 的 `BuildWSURLWithOptions`）。
- **`mapChatError` 泄漏原始上游错误**：兜底改为 502 泛化消息，剥离原始上游原文；content_policy 语义按原版对齐。
- **热账号全冷却错误码**：全部账号冷却从 401 `auth_error` 改为 429 `rate_limit_error` + `Retry-After: 60`（对齐原版语义）。
- **工具结果截断算法**：`compactToolResult` 已按原版 head=`limit/3`、tail=`limit-head-80`、先 TrimSpace 重写，上下文保留量对齐原版。

---

> 维护提示：错误分类（P1 第 3 项）与流式（P0 第 1 项）是影响面最大的两块，建议优先规划；其余多为行为微调，可按上线后的实际反馈分批处理。