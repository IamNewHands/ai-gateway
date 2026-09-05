# M365-Gateway Batch 2 移植完成记录（长任务地基）

> 完成日期：2026-09-05
> A = `ai-gateway/src/m365/`（多提供商 Workers）
> B = `M365-Gateway/src/`（原项目，2026.09.04）
> 测试：284 tests passed（22 文件），无新增失败

## 计划项 vs 实际

| 计划 | 状态 | 说明 |
|------|------|------|
| 1. SHA-256 指纹 | ✅ 完成 | toolCallFingerprint FNV→SHA-256 |
| 2. 快照持久化 | ⏭️ 跳过 | A 架构不需要（WebSocket 有状态会话） |
| 3. continuationOnly 选史 | ✅ 完成 | selectCompletionEvidenceMessages |
| 4a. SignalR 握手解析 | ✅ 完成 | 严格验证 `{}` 响应，合并帧处理 |
| 4b. appendChatHubDelta | ✅ 完成 | 安全合并 writeAtCursor 增量 |
| 4c. ping/type=7/Disengaged | ✅ 完成 | 15s ping、干净关闭、Disengaged 检测 |

## 完成项详情

### 1. SHA-256 指纹
- `toolCallFingerprint` 异步化，`sha256:` 前缀
- `resultFingerprint` 也用 `sha256:${await sha256(normalizedResult)}`
- 文件：`tool-ledger.ts`、`tool-ledger.test.ts`

### 3. continuationOnly 选史
- `completion-evidence.ts`：`continuationOnly` 正则、`selectCompletionEvidenceMessages()`
- `durable.ts`：独立 `evidenceLedger`，completion evidence 校验使用 wider window
- 5 个新测试

### 4a. SignalR 握手解析
- 验证 `{}` 空对象返回、`error` 字段、意外字段
- 合并帧（coalesced）剩余部分重新入队
- 错误消息：`WS_HANDSHAKE_EMPTY`、`WS_HANDSHAKE_INVALID`、`WS_HANDSHAKE_FAILED`、`WS_HANDSHAKE_UNEXPECTED_FRAME`

### 4b. appendChatHubDelta
- 纯函数，处理 4 种场景：空 chunk、chunk===current/current.endsWith(chunk)、chunk.startsWith(current)、无关累加
- 7 个新测试

### 4c. ping/type=7/Disengaged
- 握手后 15s `setInterval` 主动 ping，finally 清理
- `update` 帧检测 `messageType === 'Disengaged'`
- `type=7` 分支：有最终答案时正常返回，否则抛 `chathub closed before completion: clean without final`

## 变更文件
- `tool-ledger.ts` — SHA-256 指纹
- `tool-ledger.test.ts` — SHA-256 格式验证
- `completion-evidence.ts` — continuationOnly 选史
- `completion-evidence.test.ts` — 5 个新测试
- `durable.ts` — evidenceLedger
- `chathub.ts` — 握手解析、appendChatHubDelta、ping/type=7/Disengaged
- `finalize.test.ts` — 7 个 appendChatHubDelta 测试

## 跳过项原因
- **快照持久化**：A 的 ChatHub WebSocket 有状态会话下客户端发完整消息 transcript，不需要 DO 快照填补历史缺口
- **有界重连**：涉及架构级改动，保留到后续批次评估
- **有界 SocketReader**：内存优化，非功能正确性
- **syntheticUpstreamFailureCode**：独立优化，非必须