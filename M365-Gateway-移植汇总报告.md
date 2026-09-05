# M365-Gateway 移植汇总报告（2026-09-05）

> 完成日期：2026-09-05
> 测试：288 tests passed（22 文件），无新增失败

## 四批总计

| 批次 | 计划 | 完成 | 跳过 | 主题 |
|------|------|------|------|------|
| Batch 1 | 6 | 5 | 1 | 小改修 bug |
| Batch 2 | 7 | 6 | 1 | 长任务地基 |
| Batch 3 | 4 | 1 | 3 | 循环升级 |
| 额外 | — | 2 | — | 隐私/体验 |
| **合计** | **17** | **14** | **5** | |

## 已移植项（14 项）

### Batch 1：小改修 bug
1. ✅ **resultFailed 结构化重写** — `tool-ledger.ts` — 修复 exit code 0 误判失败
2. ✅ **consumeResult 清理已完成提案** — `tool-ledger.ts` — 消除 409 死循环
3. ✅ **redactEvidence + compactMiddle + ledgerRouterContext 预算** — `tool-ledger.ts` — 凭据脱敏+8000字符预算
4. ✅ **firstPayloadLine 横幅剔除** — `tool-ledger.ts` — 剥除 Script completed/Output: 等横幅
5. ✅ **fetch 拨号错误脱敏** — `chathub.ts` — 防 access_token 泄漏
6. ⏭️ **injection 误报正则** — 跳过（深度耦合 B 的 CLE 修复流程）

### Batch 2：长任务地基
7. ✅ **SHA-256 指纹** — `tool-ledger.ts` — FNV→SHA-256 异步化
8. ⏭️ **快照持久化** — 跳过（A WebSocket 架构不需要）
9. ✅ **continuationOnly 选史** — `completion-evidence.ts`, `durable.ts` — 独立 evidenceLedger
10. ✅ **SignalR 握手解析** — `chathub.ts` — 严格验证 `{}` 返回，合并帧处理
11. ✅ **appendChatHubDelta 安全合并** — `chathub.ts` — 重复/累计帧安全合并
12. ✅ **主动 15s ping + type=7 + Disengaged** — `chathub.ts` — 防静默断连，干净关闭

### Batch 3：循环升级
13. ✅ **证据恢复循环** — `durable.ts` — evidence 不通过→恢复对话再继续

### 额外：隐私/体验
14. ✅ **upstreamErrorLabel 机器标签化** — `chathub.ts` — 防敏感数据泄漏到错误消息
15. ✅ **scrubNarration 剥旁白** — `chathub.ts`, `durable.ts` — 剥除"我将执行…"叙述

## 跳过项原因
- **快照持久化**：A 的 ChatHub WebSocket 有状态会话下不需要
- **修复循环体系**：深度耦合 B 的 checkpoint/DO/routerExchange 架构
- **deadline/心跳**：A 的 300s timeout + 90s progress idle 已足够
- **提案守卫**：A 的 validateDetectedToolCalls + filterCompletedCalls + canContinue 已等价覆盖
- **injection 误报正则**：深度耦合 B 的 CLE 修复流程
- **有界重连/有界SocketReader**：后续批次评估

## 变更文件清单
| 文件 | 改动 |
|------|------|
| `tool-ledger.ts` | SHA-256 指纹、resultFailed 重写、consumeResult 清理、redactEvidence/compactMiddle、firstPayloadLine |
| `tool-ledger.test.ts` | SHA-256 格式验证 |
| `completion-evidence.ts` | continuationOnly 选史函数 |
| `completion-evidence.test.ts` | 5 个新测试 |
| `durable.ts` | evidenceLedger、证据恢复循环、scrubNarration |
| `chathub.ts` | 握手解析、appendChatHubDelta、ping/type=7/Disengaged、upstreamErrorLabel、scrubNarration |
| `finalize.test.ts` | 7+4=11 个新测试 |

## 未移植项（按需评估）
| 项 | 优先级 | 评估条件 |
|----|--------|---------|
| 有界重连（B:2058-2117） | 低 | 需架构级改动 |
| 有界 SocketReader（B:1547-1643） | 低 | 内存优化，非正确性 |
| syntheticUpstreamFailureCode（B:853-861） | 低 | 独立优化 |
| 修复循环体系（B:4308/4400/4861） | 低 | 需 routerExchange 机制 |
| Responses API 续接（B:6691-6830） | 低 | 若 A 需 /v1/responses 端点 |
| 锚点伪影修复（B:task-anchors:216-307） | 中 | 中文路径长任务受影响 |