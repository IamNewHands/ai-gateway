# M365-Gateway → ai-gateway 移植追踪

本文件追踪 `D:\GitHub_Clone\M365-Gateway`（基准源）到 ai-gateway `src/m365/`（目标）的移植完整度。

- **基准源性质**：Cloudflare Workers + Durable Object 的 M365 ChatHub 专用网关，是较晚、更严格的 CF 原生重构版。
- **目标性质**：ai-gateway 的 M365 提供商移植自 **Go 版 M365-2api**（见 `.review-orig/*.go`），与基准源存在架构级差异，因此**不是逐函数搬运**，而是"重构式移植"。

---

## 一、对比方法论（可复用）

### 1. 为什么用「符号级清单核对」

零散 grep 必然遗漏。正确做法是以基准源的**导出符号**为清单，逐一在目标中查证，得到可量化、不重不漏的矩阵。

### 2. 操作步骤

**Step 1 — 导出基准符号清单**（PowerShell，在基准源根目录执行）：

```powershell
# 抓取所有导出符号（函数/常量/类/接口）
Select-String -Path "D:\GitHub_Clone\M365-Gateway\src\*.ts" `
  -Pattern '^export (async )?function \w+|^export const \w+|^export class \w+|^export interface \w+' `
  | ForEach-Object { "{0}:{1}" -f ($_.Path -replace '.*\\',''), $_.Line.Trim() }
```

或直接用编辑器的 Grep 工具（正则同上，`output_mode: content`，`-n: true`）。

**Step 2 — 目标侧查证**（Grep 工具，`-n: true`）：

对每个符号在 `D:\GitHub_Clone\ai-gateway\src` 中搜索其**名字与语义等价物**。
注意目标可能改名/拆分/合并，需按**语义**而非仅名字判断。

**Step 3 — 状态归类**：

| 状态 | 判定标准 |
|---|---|
| ✅ 已移植 | 存在等价实现，逻辑一致或增强；有对应测试 |
| ⚠️ 部分移植 | 存在近似实现，但接口/严格性/边界/常量不同 |
| ❌ 未移植 | 无任何等价实现（含改名后仍找不到） |
| 🔍 待复核 | 疑似已实现，但可能因改名/bug/遗漏导致误判（**必须先复核**） |

**Step 4 — 按模块聚合完整度**，更新下方矩阵。

### 3. 复核前置原则（重要）

**移植前必须先做"批次零"复核**：某些"未移植"项可能其实已存在于目标，只是：
- 改了名字（如 `cleanupAccountCloudConversations` → `cleanupCloudConversations`）；
- 被内联（如 `parseSignalRHandshake` 内联进 `dialAndHandshake`）；
- 存在但**有 bug**（如 `chatHubAnswerMessageText` 语义反转）；
- 存在但**未导出/未接线**（如 `clientPlugins` 非 export）。

对 🔍 项，凡是"改名/内联/有bug/未接线"，一律**优先修复现有实现**，而非新增重复代码。

### 4. 移植后的验证清单（每项必做）

1. **适配性检查**：目标是否已有该能力？能否复用而非新增？
2. **契约兼容**：新字段/新行为对现有 provider 与客户端**向后兼容**（新字段可选）。
3. **单元测试**：为移植项新增针对性测试，覆盖正常/边界/错误路径。
4. **回归测试**：`npx tsc --noEmit` + `npx vitest run` 全量通过。
5. **行为对照**：以基准源的测试文件（如 `test/*.test.ts`）为参照，确认边界常量（字节上限、TTL、轮数）一致。

---

## 二、移植状态矩阵

> 图例：✅ 已移植 ｜ ⚠️ 部分移植 ｜ ❌ 未移植 ｜ 🔍 待复核

### 完整移植 ✅

| 模块/符号 | 证据 |
|---|---|
| `upstream-lifecycle.ts`（闸门/取消空闲超时） | `src/m365/upstream-lifecycle.ts`，逐行等价，有测试 |
| `models.ts`（modelTone / token 估算 / 能力表） | `src/m365/models.ts`，逐行等价 |
| `crypto.ts`（加解密） | `src/m365/crypto.ts`，等价 + `compaction capsule` 增强 |
| `completion-evidence.ts` | `src/m365/completion-evidence.ts` 主体完整 |
| `public-reasoning.ts` | `src/m365/public-reasoning.ts` 主体完整 |
| `task-anchors.ts` | `src/m365/task-anchors.ts` 主体完整 |
| `tool-ledger` / `account-routing` / `multimodal` | 核心逻辑对齐 |
| `decodeAZHEXArguments` | `tools.ts` 逐行一致 |
| `hasNativeFunctionCallEnvelope` | `tools.ts` 逐行等价 |
| `chatHubAllowedMessageTypes` | `chathub.ts` 逐项一致 |
| `appendChatHubDelta` | `chathub.ts` 逐行一致 |
| `normalizeClientArgumentKeys` | `tools.ts` 逐行等价 |
| `classifyAccountFailure` | `m365/account-routing.ts` |

### 部分移植 ⚠️

| 符号 | 目标现状 | 差异 |
|---|---|---|
| `clientPlugins` | `chathub.ts` 存在但非 export | 缺 `runtimeClientPlugins` 压缩分支、描述豁免 |
| `parseNativeFunctionCall` | `tools.ts` `nativeToolCalls` | 丢 `argumentEncoding:"legacy_azhex"` 标记 |
| `mayRetryUnseenChatHubFailure` | `isRetryableChatConnectError` | 缺 `responseStarted` 守卫 |
| `nextProgressBoundedChatHubFrame` | 内联等价 | 无同名函数 |
| `parseSignalRHandshake` | 内联进 `dialAndHandshake` | 无记录数上限 |
| `socketReader` | 已导出 | 接口不同（超时外置） |
| `validateToolArguments` | `validateDetectedToolCalls` 等组合 | 接口不同，覆盖更广 |
| `toolRouterPrompt` | `modelToolRouterPrompt` | 协议降级为自然语言 |
| `parseToolRouterDecision` | `parseModelToolDecision` | 更宽松 |
| `mayFailOverExchange` | `mayFailOverChatHubFailure` | 签名简化 |
| `publicCheckpointMetadata` | `buildJSON` 内联 | 无 `checkpoint_code` |
| `uploadConversationImages` | `uploadAttachments` | 选项内联、无脱敏诊断 |
| `cleanupAccountCloudConversations` | `cleanupCloudConversations` | 签名/轮次不同 |
| `RESPONSE_ALIAS_TTL_MS` 等别名常量 | `storage.ts` | 单位/语义不同 |
| `ChatCompactionCheckpoint` | `CompactionCheckpoint` | 字段不同 |

### 待复核 🔍（批次零处理）

| 项 | 疑点 |
|---|---|
| `chatHubAnswerMessageText` 语义 | 目标只接受 `messageType===''`，源接受 `undefined`/`"Chat"` —— **显式 `"Chat"` 可能被丢弃** |
| `quotaExhausted` | 目标有 `extractRemainingAllowance` 但未见 ≤0 判定，可能漏判 |
| `tryToolRouter` 确定性兜底 | 疑似只有软修复，需确认是否真的无合成调用 |
| `clientToolChoice` | 目标 `chatPayload` 不下发 toolChoice，需确认是否为有意 |

### 批次零复核结论（已完成）

| 项 | 复核结论 | 处置 |
|---|---|---|
| `quotaExhausted` | **假阴性**：判定已存在于 `account-health.ts:292-296`（`isSelectableAccount` 内 `values.every(v => v <= 0)`），只是名称不同 | 无需移植，文档改标 ✅ |
| `extractRemainingAllowance` | 已移植且**已接线**（`durable.ts:672/1006` → `recordAccountAllowance`） | ✅ |
| `tryToolRouter` 确定性兜底 | **真缺失**：`durable.ts:1225-1286` 仅"修复对话/重试对话"（软修复），无网关侧合成合法调用 | 批次一处理 |
| `chatHubAnswerMessageText` | **真 bug**：`chathub.ts:1223` 仅接受 `messageType===''`，但出站 payload（`:684`）下发 `'Chat'`；若上游回显 `'Chat'` 则正常答案被丢弃 | 批次零修复 |
| `clientToolChoice` | 目标 `chatPayload` 有意不下发 toolChoice（`:764` 注释），改由 router 决策 | 设计路线差异，暂不动 |


### 批次一复核与移植结论（已完成）

**已移植并接线**（目标 `src/m365/tools.ts` + `durable.ts`）：

| 符号 | 目标落地 | 验证 |
|---|---|---|
| `isCallerLocalExecRefusal` | `tools.ts` 逐行等价（中/英/视觉五族） | `caller-local-recovery.test.ts` 6 例 |
| `shouldRecoverCallerLocalExecRefusal` | `tools.ts` 因果 USER 意图门禁 | 6 例（含"接上那台机器"无关键词命令） |
| `shouldRecoverFableLocalExecRefusal` | `tools.ts` tone 门禁 | 2 例 |
| `hasFreshCallerLocalContinuationEvidence` | `tools.ts`，`consumedCallIds`→`completed.id` 语义等价 | 3 例 |
| `hasFreshCallerLocalFailureEvidence` | `tools.ts`，同上等价 | 2 例 |
| `callerLocalToolCandidates` / `normalizedToolIdentifier` / `toolRequired` | `tools.ts` | 4 例 |
| `preferredSecondAttemptLocalToolName` | `tools.ts` 能力排序 | 4 例 |
| `deterministicToolRouterRecovery` | `tools.ts`，接线进 `durable.ts tryToolRouter` 的 required 失败兜底 | 6 例 |
| `assistantReportsIncompleteOutcome` | `tools.ts`（含 `assistantProseWithoutQuotedData`），接线进 `durable.ts` 兜底 2.5 触发条件 | 4 例 |
| `shouldAuditCallerLocalContinuation` | `tools.ts`，接线进 `durable.ts` 主回答兜底 1（`refusalDetected`） | 5 例 |
| `shouldBufferToolStream` | `tools.ts`（导出+测试）；架构等价：ai-gateway 流式路径已在发出前缓冲抽取+校验工具调用（`durable.ts:991-993`），无需另设服务端缓冲开关 | 4 例 |
| `unresolvedAssistantCommitment` 内部升级 | `tools.ts`：接入 `assistantProseWithoutQuotedData`，保留 `hasToolCalls` 参数（契约兼容） | 3 例 |

**复核后判定为"源自身死代码/禁用"，明确不移植**：

| 符号 | 结论 |
|---|---|
| `shouldForceDirectNativeToolChoice` / `effectiveDirectToolChoice` | 源 `effectiveDirectToolChoice` 为**空实现**（`void env; void prompt; … return toolChoice`），注释明示 `DIRECT_NATIVE_TOOL_MODE never calls this keyword-based helper`。属源侧禁用路径，移植无意义 |
| `shouldAuditInitialCallerLocalDecision` | 源内部私有辅助，语义已由 `shouldAuditCallerLocalContinuation` + 初始路由覆盖 |
| `explicitClientActionRequest` | 源注释标注 `Legacy recovery gate retained only for non-production compatibility tests`，非生产路径 |

**仍属批次一范畴、需后续单列评估**（涉及流取消/公开推理投递，改动面较大，避免与批次三会话模型冲突）：

- `createStreamCancellation`、`adoptToolRouterResult` / `isolatedToolRouterCoordinates`、`chatDeliversPublicReasoning` / `chatReasoningContent` —— 这些与 Responses/推理投递路径耦合，归入批次三统一评估。

### 批次二复核与移植结论（已完成）

**已移植并接线**：

| 符号 | 目标落地 | 验证 |
|---|---|---|
| `RequestBodyError` / `readTextLimited` / `readJSONLimited` | 新建 `src/request-body.ts`，逐行等价 | `request-body.test.ts` 12 例 |
| `MAX_AI_REQUEST_BYTES`(8MiB) / `MAX_RESPONSES_REQUEST_BYTES` / `MAX_COMPACTION_REQUEST_BYTES`(16MiB) | 同上 | 同上 |
| 入站请求体上界接线 | `proxy.ts` 三个入口（`handleProxy`/`handleAnthropicMessages`/`handleResponses`）改用 `readBoundedJSON`（读流累计计数，超限即 cancel）；`index.ts` 全局 `onError` 映射 `RequestBodyError`→413/400 | 新增守卫逻辑 |
| `CHAT_HUB_PAYLOAD_LIMITS` / `BoundedPayloadSubtype` / `BoundedPayloadPhase` / `BoundedPayloadMetadata` / `BoundedPayloadError` / `assertBoundedPayload` | `src/m365/chathub.ts` | `payload-guardrails.test.ts` 19 例 |
| `boundedPayloadMetadata` / `BoundedPayloadDiagnostic` / `boundedPayloadDiagnostic`（+私有 `logBoundedPayloadFailure`） | `src/m365/chathub.ts`，隐私安全：仅数值+机器标签 | 同上 |
| `ChatHubAttemptError` 增 `terminalEmptyQuota` / `boundedPayload` 字段 | 构造签名向后兼容（string 或 unknown cause 均可） | 同上 |
| `mayReconnectChatHubFailure` | ✅ 已移植；**适配点**：源用固定传输码（`WS_DIAL_FAILED:5xx`），目标消息为 `ws dial failed: HTTP {status}`，故复用目标既有 `isRetryableChatConnectError` 白名单并补 `WS_ERROR_BEFORE_COMPLETION`/`WS_CLOSED_BEFORE_COMPLETION` | 同上 + 既有 `chat-reconnect.test.ts` |
| `preserveChatHubSubmissionHistory` / `chatHubInvocationWasSubmitted` / `isTerminalEmptyQuotaFailure` | `src/m365/chathub.ts` | `payload-guardrails.test.ts` |

**复核后判定为"目标已等价实现/不同架构模型"，不重复移植**：

| 符号 | 结论 |
|---|---|
| `quotaExhausted` | 已存在于 `account-health.ts`（`isSelectableAccount` 内 `values.every(v => v <= 0)`），批次零已确认 |
| `appendChatSnapshot` / `chooseChatHubText` | 目标以 `emitSnapshot`（`chathub.ts:1134`）内联实现"前缀命中才补发尾部 + 保留更长快照"，语义等价 |
| `appendUpstreamImageURLs` | 目标 `multimodal.ts extractUpstreamImageURLs` + `chathub.ts` 内联去重/上限（`imageLimitDetected`、`MAX_ATTACHMENTS`），语义等价但未单列导出函数 |
| `chatHubAttachments` | 目标用 `ChatHubAttachment` + `uploadAttachments`（含 image-only 计数上限 `MAX_ATTACHMENTS`），不同数据模型，功能覆盖 |
| `normalizeClientFunctionCall` | 目标 `normalizeClientArgumentKeys`（键归一）+ `validateDetectedToolCalls`（schema 校验），语义等价 |
| `parseToolDecisionAnswer` / `isOrdinaryToolDecisionAnswer` / `parseFunctionCall` | 属 AGT 决策协议/超大函数解析，目标走 `parseModelToolDecision`/`fencedToolCalls`/`nativeToolCalls` 路线，设计差异，不做 1:1 搬运 |

### 未移植 ❌（按批次）

#### 批次一：长任务稳定性（✅ 已完成，见上方"批次一复核与移植结论"）

| 符号 | 说明 |
|---|---|
| `shouldForceDirectNativeToolChoice` / `effectiveDirectToolChoice` | 复核结论：源侧禁用/空实现，**不移植** |
| `shouldAuditCallerLocalContinuation` | ✅ 已移植并接线 |
| `assistantReportsIncompleteOutcome` | ✅ 已移植并接线 |
| `shouldBufferToolStream` | ✅ 已移植（架构等价） |
| `createStreamCancellation` | 归入批次三评估 |
| `boundPublicExecFunctionCall` | ✅ 语义等价（`normalizeClientArgumentKeys` 归一 + `validateDetectedToolCalls` 校验） |
| `adoptToolRouterResult` / `isolatedToolRouterCoordinates` | 归入批次三评估 |
| `chatDeliversPublicReasoning` / `chatReasoningContent` | 归入批次三评估 |

#### 批次二：安全护栏（✅ 已完成，见上方"批次二复核与移植结论"）

> 本批次全部项已落地或复核为等价实现，无遗留。

#### 批次三：会话模型

| 符号 | 说明 |
|---|---|
| `PortableSessionState` / `boundPortableSessionState` | 可移植会话状态 + 字节预算 |
| `boundedUtf8Suffix` / `boundedPortableProtocolSuffix` / `portableSessionByteLength` | 后缀裁剪工具 |
| `ChatSession.startResponseBranch` / `discardResponseBranch` / `seed` | 别名分支隔离 |
| `ResponseAliasSnapshot` | 别名快照（含可移植协议状态） |
| `MAX_CHAT_SESSION_STATE_BYTES` / `MAX_PORTABLE_SESSION_BYTES` / `MAX_CALLER_TOOLS_SNAPSHOT_BYTES` | 容量上限 |
| `RESPONSE_ALIAS_REGISTRY_NAME` | 跨对象注册表 |
| `validateToolLedgerSnapshot` | 账本快照校验 |
| `ChatTurnCheckpoint` / `SupersededUpstreamRun` / `SupersededChatLease` | 检查点/被顶替运行 |
| `hydrateLeaseFromCompaction` | 从压缩胶囊恢复租约 |
| `shouldRestoreChatPortableCheckpoint` | 可移植检查点恢复 |
| `compactRetainedMessages` / `compactPortableTaskTail` | 压缩保留 |
| `shouldRestorePortableTaskFollowup` | 可移植任务续接 |

#### 批次四：运维/可观测

| 符号 | 说明 |
|---|---|
| `r2-archive.ts` 整模块 | R2 会话归档（outbox/重试/脱敏） |
| `RequestMetricTracker` / `trackStreamingResponse` / `trackBufferedResponse` | 请求指标追踪 |
| `SLOW_REQUEST_OBSERVATION_MS` / `shouldRetainRequestObservation` | 慢请求保留 |
| `verifyAccountMigration` / `MigrationRequestError` / `ACCOUNT_MIGRATION_PATH` | 账号迁移 API |
| `runCloudCleanup` / `CloudCleanupResult` | 云端清理编排 |
| `functionToolDefinition` | 工具定义归一（目标有等价物，低优先） |

---

## 三、执行批次与规划

| 批次 | 范围 | 优先级 | 状态 |
|---|---|---|---|
| 批次零 | 复核 🔍 项，修复现有实现（改名/内联/有bug/未接线） | 高 | ✅ 已完成 |
| 批次一 | 长任务稳定性：工具路由确定性恢复 + Fable 拒绝恢复 + 续接审计 + 未完成结局 | 高 | ✅ 已完成 |
| 批次二 | 安全护栏：请求体限制 + 有界负载 + 配额判定 + 重连护栏 | 高 | ✅ 已完成 |
| 批次三 | 会话模型：可移植状态 + 分支隔离 + 检查点 hydrate | 中 | 🔄 进行中 |
| 批次四 | 运维：请求指标追踪 + R2 归档 + 账号迁移 API | 中 | ⬜ 待开始 |

**每批次统一验收**：`npx tsc --noEmit` + `npx vitest run` 全量通过 + 新增针对性测试。

**进度快照**：批次零/一完成时全量回归 = 41 文件 / 559 测试全部通过，tsc 零错误。
批次二完成时全量回归 = 43 文件 / 590 测试全部通过，tsc 零错误（新增 `src/request-body.test.ts` 12 项、`src/m365/payload-guardrails.test.ts` 19 项）。
