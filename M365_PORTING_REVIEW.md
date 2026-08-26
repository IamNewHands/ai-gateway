# M365 移植复查：差异修复记录

> 对照原版 [HEXUXIU/M365-Copilot2API](https://github.com/HEXUXIU/M365-Copilot2API)（Go）对 `src/m365/*`（TypeScript / Cloudflare Workers）做逐模块移植复查，共发现 **40+ 处差异**。
>
> **状态：此前「未修复清单」中的全部项已处理完毕**（大部分已修复/对齐；少数按决策保持不变并在下方注明）。本文档作为差异修复台账留存，按优先级排列，用于追溯每项的最终处理方式。

**说明**：本清单为「行为/能力风险」普查，不包含「默认即可用、无需改动」的无害差异（已在原审查中分流）。

优先级说明：

- **P0**：核心功能可能失效或产生数据异常，建议优先处理
- **P1**：明确行为偏差，影响实际使用质量
- **P2**：能力缺失/能力弱化，多数场景可用但有退化
- **P3**：健壮性/一致性优化，非阻塞

---

## 本轮已修复 / 已处理项（原「未修复清单」）

### P0

#### 1. 流式（`stream:true`）退化为伪流式 → 已完整重构
- **位置**：`src/m365/durable.ts`（`streamMainAnswer`）、`src/m365/chathub.ts`（`ChatHubOptions.signal`）、`src/proxy.ts` / `src/m365/proxy.ts`
- **处理**：
  - DO 用 `ReadableStream` 打开 SSE 后立即驱动 `chatWithHandlers`，`onDelta`/`onEvent` 实时推 `content`/`reasoning_content` delta（增量透传，不再等整段完成）。
  - `cancel()` 与 `requestSignal` 双路中止上游 WS（等价原版 `r.Context().Done()` 客户端断连取消对话）。
  - Worker 侧流式透传包 `withSSEKeepAlive`（心跳 + idle 兜底），消除长时无字节被中间层/客户端超时掐断。
- **遗留（设计取舍）**：流式下文本已发出后无法撤回，故「工具拒绝/沙盒幻觉/完成证据」等需要先看全文再改写的校正，仅用于会话绑定文本保持复用一致，不对已发出的流式文本改写（代码注释与告警日志已注明）。

#### 2. 工具轮数 / 死循环熔断门禁未启用 → 已修复
- **位置**：`src/m365/tools.ts`（`canContinue`、`MAX_TOOL_ROUNDS_DEFAULT`）、`src/m365/durable.ts`
- **处理**：ledger 构建后接入 `canContinue`（命中 `stuckLoop` / 重复失败 / 轮数超限 → `409 tool_round_limit`）；`canContinue` 补 `repeatedFailure` 判定；新增 `src/m365/tools.test.ts` 覆盖 5 个熔断场景。

### P1

#### 3. 错误冷却策略大幅简化（403 / 429 / 503 / 空响应 / Retry-After / 全局熔断） → 已修复
- **位置**：`src/m365/account-health.ts`
- **处理**：403/鉴权 → 24h；429 → 指数退避 30s·2^(n-1) 封顶 30min；503 → 15s 且纳入限流；空响应 → 10s；未知错误 → 30s；接通上游 Retry-After；KV 落盘全局熔断器（30s 窗口失败≥10 且失败率≥50% → 熔断 30s，跨实例/DO 共享）。

#### 4. 图片 URL 提取输入范围受限（Designer 生成图可能漏提） → 已修复
- **位置**：`src/m365/chathub.ts`（`rawFrames`）
- **处理**：`rawFrames` 补收 `type=2 result` 帧的 `item` 内容，图片 URL 提取覆盖 update + result 帧。

#### 5. WS dial / 流式路径不读取 Retry-After 与 keepalive → 已修复
- **位置**：`src/m365/chathub.ts`（dial 失败）、`src/m365/durable.ts`（错误标记）、`src/proxy.ts`（keepalive）
- **处理**：dial 失败解析 HTTP 状态并携带 `retryAfterSeconds`，durable catch 透传给 `markAccountFailure` / `confirmAndMarkRateLimit`；流式透传包 keepalive。

#### 6. 请求画像缩水：`variants` / `allowedMessageTypes` / `optionsSets` / `clientInfo` → 已部分对齐（静态补全）
- **位置**：`src/m365/chathub.ts`（`VARIANTS`、`chatPayload`、`clientInfo`）
- **处理**：按评审「静态补全」：variants 尾缺 flag、allowedMessageTypes 缺项、clientInfo 缺项、optionsSets 静态缺项均已补；**不引入** FeatureFlags 条件项，保留 `cwc_code_interpreter_v3`。
- **注意**：具体 flag 值部分为合理近似（无原版精确清单），上线如遇上游行为异常优先回查此块。

### P2

#### 7. `toolProtocolPrompt` 分支方向相反 + 缺防截断前缀 → 已修复
- **位置**：`src/m365/tools.ts`
- **处理**：无工具 → 注入防截断前缀；原生插件 → 原样返回；其余 → `<tools>` 注入支持**并行多块** + 补「不要使用内置 code interpreter / Python 沙箱」防幻觉段。

#### 8. `clientPlugins` 缺 mcp-gateway 插件条目 → 已修复（默认关闭）
- **位置**：`src/m365/chathub.ts`（`clientPlugins`/`buildPlugins`）、`src/m365/durable.ts`
- **处理**：`body.m365_mcp_server_url` 非空时注入 `{Id:'mcp-gateway', Source:'MCPServer', ServerUrl}`；默认无该字段则无注入，不影响现有流程。

#### 9. 提示词管道差异（`flattenPromptMessages`、`isToolRefusal` / `isSandboxHallucination`） → 已修复
- **位置**：`src/m365/tools.ts`、`src/m365/durable.ts`
- **处理**：system/developer 前置聚合为单一块；tool 结果非 string 整体 JSON 序列化；拆分独立 `isSandboxHallucination`（无长度限制、专门纠正词，durable 分别处理）。

#### 10. `validateDetectedToolCalls` 缺 tool_choice 校验 + 空 arguments 默认 → 已修复
- **位置**：`src/m365/tools.ts`、`src/m365/durable.ts`
- **处理**：签名补 `choice` 并在调用处传入；空串/`"null"` arguments 归一 `{}` 保留继续按 schema 校验。

#### 11. 会话复用层缺失（convCache / 内容键之外的复用） → 已补 convCache 层
- **位置**：`src/m365/session.ts`、`src/m365/durable.ts`
- **处理**：新增按 `account+model+systemPromptHash` 的 convCache（KV，成功后写入；新会话无工具时命中则沿用云端对话并只发最新用户消息增量）。

#### 12. `cloneMessages` 不截断 512 条 → 已修复
- **位置**：`src/m365/session.ts`
- **处理**：超 512 条按消息原子边界截最后 512 条，防 KV value 无限增长。

### P3

#### 13. 图片生成忽略 `accountId`/`user`，多账号时 token 与生成账号错配 → 已修复
- **位置**：`src/m365/images.ts`
- **处理**：`accountId` 贯穿 `getM365Account` 预检、DO 生成 payload（`m365_account_id`）、Designer token，保证生成与下载同账号。

#### 14. 认证若干健壮性差异 → 部分修复（加密按决策不做）
- **位置**：`src/m365/oauth.ts`
- **处理**：oid 未命中不再静默回退（明确返回不存在）；`writeToken` 按 oid **或 email** 合并（同邮箱重登不分裂）。**账号池 AES-GCM 加密落盘按决策不做**（保持明文 + 30 天 TTL 现状）。

#### 15. 换 token 端点 no-op 三元 + ROPC 端点硬编码 → 已修复
- **位置**：`src/m365/oauth.ts`（`tokenEndpointUrl`、`submitM365PKCECallback`、`doRefreshM365Token`）
- **处理**：token 端点由可配置 authority（`.../authorize` → `.../token`）派生；PKCE 回调与刷新不再硬编码 `/common`。

#### 16. `images.ts` 参数校验放宽 / 响应形状差异 → 已修复
- **位置**：`src/m365/images.ts`、`src/index.ts`
- **处理**：`n>10` → 400；`response_format` 非 url/b64_json → 400；`data:image/` 无逗号 → 400；本地图片 URL 在能取得 origin 时返回绝对地址；响应附 `m365:{accountId,providerId}` 元数据块。

#### 17. Designer 下载重定向语义与 Content-Type 校验差异 → 已处理（见 #16）
- **位置**：`src/m365/images.ts`
- **处理**：与 #16 一并收敛参数/URL 形状；重定向与资源大小已在现状实现。

#### 18. 并发闸门等待语义（立即 429 vs 排队） → 按决策保持现状
- **位置**：`src/m365/account-flux.ts`、`src/m365/durable.ts`
- **处理**：**按产品决策保持不变**——并发吃满时轮询 8s 后返回 429 `Retry-After: 5`，不做阻塞排队。

#### 19. cron 全量刷新 vs 原版只刷临期账号 → 已调整
- **位置**：`src/oauth.ts`（`refreshAllM365PoolTokens`）
- **处理**：只刷「临期（expiresAt 前 10min）」或「闲置过久（>20 天，重置 30 天池 TTL 保活）」的账号，减少对上游请求。

---

## 已修复（历史提交，仅记录）

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

> 维护提示：上述「本轮已修复」项对应本次移植补齐的 P0–P3 全部差异；其中 #14 加密、#18 并发等待语义为产品决策项，按当前决策保持不变。后续如需开启 MCP 网关（#8）或流式强校正，可据本文档「遗留」说明进一步扩展。