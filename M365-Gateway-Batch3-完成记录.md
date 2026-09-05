# M365-Gateway Batch 3 移植完成记录（循环升级）

> 完成日期：2026-09-05
> A = `ai-gateway/src/m365/`（多提供商 Workers）
> B = `M365-Gateway/src/`（原项目，2026.09.04）
> 测试：284 tests passed（22 文件），无新增失败

## 计划项 vs 实际

| 计划 | 状态 | 说明 |
|------|------|------|
| 1. 证据恢复循环 | ✅ 完成 | completion evidence 不通过→恢复对话而非直接终止 |
| 2. 修复循环体系 | ⏭️ 跳过 | 深度耦合 B 的 checkpoint/DO/routerExchange 架构 |
| 3. deadline/心跳 | ⏭️ 跳过 | A 的 timeout 模型已足够（300s per request） |
| 4. 提案守卫 | ⏭️ 跳过 | A 已有等价覆盖（validateDetectedToolCalls/filterCompletedCalls/canContinue） |

## 完成项详情

### 1. 证据恢复循环
- **文件**：`durable.ts`
- **改动**：`handleChat` 方法中的"兜底 3"完成证据评估，从硬替换→先尝试恢复循环
- **流程**：
  1. `evaluateCompletionEvidence` 不通过且理由是 `failed_evidence`/`missing_evidence`/`unknown_evidence` 时
  2. 构建恢复 prompt（含 failureContext + unsupportedActions + 禁止重复完成声明）
  3. 独立对话（`chatWithHandlers`，`started: true`，不写历史）
  4. 从恢复对话提取工具调用（fenced + native 双通道）
  5. 校验通过→用恢复产生的工具调用替代原始 finalText
  6. 恢复失败或 `pending_evidence` 类型→降级到硬替换（同原版不变）
- **B 参考**：B:5247-5272（`resolveFunctionCall` 逻辑）
- **关键设计**：恢复对话不写历史（同原版 `routerExchange`），避免后续轮次继承修复对话的格式化文本

## 跳过项原因

### 2. 修复循环体系（B:4308 `repairCallerLocalCheckpoint`、B:4400 `repairToolResultAnswer`、B:4861 malformed transport）
- **深度耦合 B 架构**：B 的修复循环依赖 `routerExchange`（独立路由对话交易所）、`FunctionCallResolution` 状态机、`checkpointOnly` 机制
- **A 已有等价替代**：`tryToolRouter` 的 1-shot JSON repair（line 860-875）和 `required` 重试（line 879-889）覆盖了主要的畸形响应修复场景
- **移植成本**：需要引入 A 没有的 `routerExchange` 机制和 checkpoint 模式，架构改动过大

### 3. deadline/心跳（B:57 `logicalRequestDeadlineAt`、B:5533 5s 流心跳、B:56 背压超时）
- **A 已有等价覆盖**：`timeoutMs: 300_000`（5min 请求级超时）、`readTimeoutMs: 90_000`、`progressIdleMs: 90_000`（无语义进展超时）
- **架构差异**：B 的全局 10min `logicalRequestDeadlineAt` 是为无状态 HTTP API 设计的（每个请求可能是一轮工具循环），A 的 WebSocket 会话模型下 300s 超时更合理
- **流心跳**：A 已有 `type=6` 被动 ping 响应 + 主动 15s ping（Batch 2 移植），SSE 流式通过注释行保活（等价于 B 的空 chunk 心跳）

### 4. 提案守卫（B:899 `guardProposedToolCalls`）
- **A 已有等价覆盖**：`validateDetectedToolCalls`（schema 校验 + tool_choice 约束）、`filterCompletedCalls`（指纹去重）、`canContinue`（逐指纹熔断 + 轮数上限）
- B 的并行提案去重、预算预检、逐指纹熔断在 A 中通过 `canContinue` 的 `consecutiveFingerprint` 和 `filterCompletedCalls` 覆盖

## 变更文件
- `durable.ts` — 证据恢复循环（兜底 3 扩展）

## 总计
| 批次 | 完成 | 跳过 | 项目 |
|------|------|------|------|
| Batch 1 | 5 | 1 | 小改修 bug |
| Batch 2 | 6 | 1 | 长任务地基 |
| Batch 3 | 1 | 3 | 循环升级 |
| **合计** | **12** | **5** | |