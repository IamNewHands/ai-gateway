/**
 * M365 Completion Evidence —— 移植自 M365-Gateway-CF2 completion-evidence.ts。
 *
 * 核心功能：
 * 1. 行动分类（classifyCompletionActions）—— 将工具名称和参数分类为操作动作
 * 2. 声明检测（completionClaims）—— 检测助手回答中的操作完成声明
 * 3. 非断言上下文（isNonAssertiveContext）—— 排除否定、计划、假设等非断言措辞
 * 4. 证据汇总（summarizeCompletionEvidence）—— 安全的非敏感证据摘要
 * 5. 证据评估（evaluateCompletionEvidence）—— 完整的证据评估，替换 completionEvidenceAllows
 */
import type { AgentLedger, ToolEvidence } from './tools'

// ==================== 类型定义 ====================

export type CompletionAction =
  | 'deploy' | 'fix' | 'install' | 'verify' | 'upload'
  | 'delete' | 'create' | 'configure' | 'start' | 'complete'

export type CompletionEvidenceStatus = 'success' | 'failure' | 'unknown' | 'pending'
export type OperationalAction = Exclude<CompletionAction, 'complete'>

export interface CompletionActionEvidence {
  latest: CompletionEvidenceStatus
  successes: number
  failures: number
  unknown: number
  pending: number
}

/** 安全的非敏感证据摘要（不含工具名、参数、输出、callId、错误文本、路径、token、URL） */
export interface CompletionEvidenceSummary {
  actions: Partial<Record<OperationalAction, CompletionActionEvidence>>
  successfulTools: number
  failedTools: number
  unknownTools: number
  pendingTools: number
  classifiedSuccessfulTools: number
  classifiedFailedTools: number
  unclassifiedFailedTools: number
  unclassifiedUnknownTools: number
}

export interface ClassifiedEvidenceActions {
  actions: OperationalAction[]
  orderedVerificationAfterMutation: boolean
}

export type CompletionEvidenceReason =
  | 'no_completion_claim'
  | 'supported'
  | 'pending_evidence'
  | 'failed_evidence'
  | 'unknown_evidence'
  | 'missing_evidence'

export interface CompletionEvidenceDecision {
  allowed: boolean
  disposition: 'allow' | 'downgrade' | 'terminate'
  reason: CompletionEvidenceReason
  claimedActions: CompletionAction[]
  unsupportedActions: CompletionAction[]
  replacementText?: string
}

// ==================== 常量 ====================

const operationalActions: readonly OperationalAction[] = [
  'deploy', 'fix', 'install', 'verify', 'upload',
  'delete', 'create', 'configure', 'start',
]

const failureSignal = /(?:exit\s*(?:code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|timeout|permission denied|not found|refused|cancel(?:led|ed)|operation was canceled)/iu

/** 工具名称模式（仅匹配工具名，不搜索参数中的用户数据） */
const toolNamePatterns: Readonly<Record<OperationalAction, readonly RegExp[]>> = {
  deploy: [/(?:^|[_-])(?:deploy|deployment|release)(?:$|[_-])/iu],
  fix: [/(?:^|[_-])(?:fix|repair|patch)(?:$|[_-])/iu],
  install: [/(?:^|[_-])(?:install|installer|setup)(?:$|[_-])/iu],
  verify: [/(?:^|[_-])(?:verify|validate|validation|tests?|checks?|healthcheck|doctor|audit|inspect)(?:$|[_-])/iu],
  upload: [/(?:^|[_-])(?:upload|publish|push|sync)(?:$|[_-])/iu],
  delete: [/(?:^|[_-])(?:delete|remove|cleanup|clean|purge)(?:$|[_-])/iu],
  create: [/(?:^|[_-])(?:create|provision|scaffold|mkdir)(?:$|[_-])/iu],
  configure: [
    /(?:^|[_-])(?:configure|config|edit|update|modify|save)(?:$|[_-])/iu,
    /(?:^|[_-])write(?:$|[_-](?:file|content|config|settings))/iu,
  ],
  start: [/(?:^|[_-])(?:start|restart|launch|run_service)(?:$|[_-])/iu],
}

/** 命令模式（匹配命令字符串中的操作动词） */
const commandPatterns: Readonly<Record<OperationalAction, readonly RegExp[]>> = {
  deploy: [
    /\bwrangler\s+deploy\b/iu,
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/iu,
    /\bkubectl\s+(?:apply|rollout)\b/iu,
    /\bdocker(?:\s+compose|\s+stack)?\s+(?:up|deploy)\b/iu,
  ],
  fix: [/\bapply[_-]?patch\b/iu],
  install: [/\b(?:apt(?:-get)?|dnf|yum|pip\d*|npm|pnpm|yarn|winget|choco)\s+install\b/iu],
  verify: [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:s)?\b/iu,
    /\b(?:go|cargo|dotnet|deno)\s+test\b/iu,
    /\b(?:pytest|vitest|jest|mocha|ava|ctest)\b/iu,
    /\b(?:mvn|gradle|gradlew)\b[^\r\n;&|]{0,100}\btest\b/iu,
    /\btsc\b[^\r\n;&|]{0,160}\b--noEmit\b/iu,
    /\bnode\b[^\r\n;&|]{0,160}\b--check\b/iu,
    /\b(?:eslint|stylelint|html-validate)\b/iu,
  ],
  upload: [
    /\bgit\s+push\b/iu,
    /\b(?:scp|rsync|rclone)\b/iu,
    /\baws\s+s3\s+(?:cp|sync)\b/iu,
  ],
  delete: [/(?:^|[;&|\s])rm\s+(?:-[^\s]+\s+)*(?:--\s+)?[^\s]/iu, /\bRemove-Item\b/iu],
  create: [/(?:^|[;&|\s])mkdir(?:\s|$)/iu, /\bNew-Item\b/iu],
  configure: [/\b(?:Set-Content|Add-Content)\b/iu],
  start: [/\bsystemctl\s+(?:start|restart|reload)\b/iu, /\bStart-(?:Service|Process)\b/iu],
}

/** 声明模式（匹配回答中的完成声明措辞，支持中英文） */
const claimPatterns: Readonly<Record<CompletionAction, readonly RegExp[]>> = {
  deploy: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5b8c\u6210)?\s*(?:\u90e8\u7f72|\u4e0a\u7ebf)/giu,
    /(?:\u90e8\u7f72|\u4e0a\u7ebf)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?deployed\b/giu,
    /\bdeployment\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
    /\b(?:is|went)\s+live\b/giu,
  ],
  fix: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5f7b\u5e95)?\s*(?:\u4fee\u590d|\u89e3\u51b3)/giu,
    /(?:\u4fee\u590d|\u6574\u6539)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:fixed|repaired|resolved)\b/giu,
    /\b(?:fix|repair|remediation)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  install: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*\u5b89\u88c5/giu,
    /\u5b89\u88c5(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?installed\b/giu,
    /\binstallation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  verify: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)/giu,
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u901a\u8fc7|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?verified\b/giu,
    /\b(?:verification|validation|tests?|checks?)\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:complete|completed|successful|passed)\b/giu,
  ],
  upload: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)/giu,
    /(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:uploaded|published|pushed|synced)\b/giu,
    /\b(?:upload|publication|push|sync)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  delete: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)/giu,
    /(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:deleted|removed|cleaned|purged)\b/giu,
    /\b(?:deletion|removal|cleanup)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  create: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u521b\u5efa|\u65b0\u5efa)/giu,
    /(?:\u521b\u5efa|\u65b0\u5efa)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?created\b/giu,
    /\bcreation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  configure: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)/giu,
    /(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:configured|updated|modified|written|saved)\b/giu,
    /\b(?:configuration|update|modification)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  start: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)/giu,
    /(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:started|restarted|launched|reloaded)\b/giu,
    /\b(?:startup|restart|launch|reload)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  complete: [
    /(?:\u5168\u90e8|\u6240\u6709|\u6574\u4e2a|\u672c\u6b21)?\s*(?:\u4efb\u52a1|\u5de5\u4f5c|\u5904\u7406|\u64cd\u4f5c|\u6267\u884c|\u6574\u6539)\s*(?:\u5747|\u90fd)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5168\u90e8)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /(?:\u5168\u90e8|\u6240\u6709)\s*(?:\u90fd|\u5df2)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /\b(?:all\s+done|everything\s+(?:is\s+)?(?:done|complete)|task\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|work\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|completed\s+successfully)\b/giu,
  ],
}

// ==================== 辅助函数 ====================

function normalizedOperationName(name: string): string {
  const value = name.trim().toLowerCase()
  return value.split(/[.:/\\]/u).at(-1) ?? value
}

function parsedOperationArguments(record: { arguments: string; name: string }): unknown {
  const value = record.arguments?.trim()
  if (!value) return {}
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value) as unknown } catch { /* 非 JSON 参数 */ }
  }
  return value
}

function operationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function patchInput(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, 256_000)
  const record = operationRecord(args)
  const value = record?.input ?? record?.patch
  return typeof value === 'string' ? value.slice(0, 256_000) : ''
}

function classifyPatchHeaders(input: string, actions: Set<OperationalAction>): void {
  for (const match of input.matchAll(/^\*\*\*\s+(Add File|Delete File|Update File|Move to):/gimu)) {
    const kind = match[1].toLowerCase()
    if (kind === 'add file') actions.add('create')
    else if (kind === 'delete file') actions.add('delete')
    else actions.add('configure')
  }
}

function decodeStaticStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try { return typeof JSON.parse(literal) === 'string' ? JSON.parse(literal) as string : '' } catch { return '' }
  }
  if (!literal.startsWith("'") || !literal.endsWith("'")) return ''
  const escapes: Record<string, string> = { "'": "'", '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
  return literal.slice(1, -1).replace(/\\(['"\\bfnrtv])/gu, (_whole, escaped: string) => escapes[escaped] ?? escaped)
}

function codeModeExecCommands(input: string): string[] {
  const commands: string[] = []
  const call = /\btools\.exec_command\s*\(\s*\{\s*(?:["']cmd["']|cmd)\s*:\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gimu
  for (const match of input.slice(0, 256_000).matchAll(call)) {
    const decoded = decodeStaticStringLiteral(match[1])
    if (decoded) commands.push(decoded)
  }
  return commands
}

function commandTextWithoutOpaqueOperands(command: string): string {
  return command
    .replace(/@(["'])\r?\n[\s\S]*?\r?\n\1@/gu, ' ')
    .replace(/'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/gu, ' ')
    .slice(0, 16_384)
}

function trustedCommandTexts(name: string, args: unknown): string[] {
  const record = operationRecord(args)
  if (name === 'exec') {
    const input = typeof record?.input === 'string' ? record.input : typeof args === 'string' ? args : ''
    return codeModeExecCommands(input)
  }
  // 识别执行命令类工具：既匹配 CF2 的 exec/shell/bash/powershell/terminal，
  // 也兼容常见短别名（sh/cmd/pwsh）
  if (!/(?:^|[_-])(?:exec|exec_command|command|shell|bash|powershell|terminal|pwsh|cmd|sh)(?:$|[_-])/iu.test(name)) return []
  if (record) {
    return [record.cmd, record.command].filter((value): value is string => typeof value === 'string' && value.length > 0)
  }
  return typeof args === 'string' ? [args] : []
}

function trustedSelectorTexts(args: unknown): string[] {
  const record = operationRecord(args)
  if (!record) return []
  return [record.action, record.operation, record.mode, record.method]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.slice(0, 128))
}

function commandMatchesAction(command: string, action: OperationalAction): boolean {
  return commandPatterns[action].some((pattern) => pattern.test(command))
}

function isExplicitReadbackCommand(command: string): boolean {
  return /(?:^|[;&|\s])(?:Get-Content|Get-Item|Test-Path|Select-String|Compare-Object|type|cat)(?:\s|$)/iu.test(command)
    || /\b(?:git\s+diff\s+--check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:s)?|(?:pytest|vitest|jest|mocha|ava)\b)/iu.test(command)
}

function isStaticFileCreationCommand(command: string): boolean {
  return /\bSet-Content\b[^\r\n;&|]{0,240}\s-(?:LiteralPath|Path)\b/iu.test(command)
}

// ==================== 行动分类 ====================

/** 分类工具调用表示的操作动作 */
export function classifyCompletionActions(record: { name: string; arguments: string }): ClassifiedEvidenceActions {
  const actions = new Set<OperationalAction>()
  const name = normalizedOperationName(record.name)
  const args = parsedOperationArguments(record)
  const selectors = trustedSelectorTexts(args)

  for (const action of operationalActions) {
    if (toolNamePatterns[action].some((pattern) => pattern.test(name))) actions.add(action)
    if (selectors.some((selector) => toolNamePatterns[action].some((pattern) => pattern.test(selector)))) actions.add(action)
  }

  if (name === 'apply_patch' || name === 'applypatch') {
    actions.add('fix')
    classifyPatchHeaders(patchInput(args), actions)
  }

  for (const command of trustedCommandTexts(name, args)) {
    const controlText = commandTextWithoutOpaqueOperands(command)
    for (const action of operationalActions) {
      if (commandPatterns[action].some((pattern) => pattern.test(controlText))) actions.add(action)
    }
  }

  // Code Mode 的额外检测
  if (name === 'exec') {
    const commands = trustedCommandTexts(name, args).map(commandTextWithoutOpaqueOperands)
    let mutationSeen = false
    let orderedVerificationAfterMutation = false
    for (const command of commands) {
      const commandActions = operationalActions.filter((action) => commandMatchesAction(command, action))
      if (commandActions.some((action) => action !== 'verify')) mutationSeen = true
      if (isStaticFileCreationCommand(command)) actions.add('create')
      if (mutationSeen && isExplicitReadbackCommand(command)) {
        orderedVerificationAfterMutation = true
        actions.add('verify')
      }
    }
    return { actions: [...actions], orderedVerificationAfterMutation }
  }

  return { actions: [...actions], orderedVerificationAfterMutation: false }
}

// ==================== 证据状态检测 ====================

function compactResultText(result: string): string {
  return result.slice(0, 4_096)
}

function evidenceStatus(record: ToolEvidence): Exclude<CompletionEvidenceStatus, 'pending'> {
  if (record.failed === true) return 'failure'
  if (record.failed === false) return 'success'
  const result = compactResultText(record.result)
  if (!result.trim()) return 'unknown'
  return failureSignal.test(result) ? 'failure' : 'success'
}

function emptyActionEvidence(status: CompletionEvidenceStatus): CompletionActionEvidence {
  return { latest: status, successes: 0, failures: 0, unknown: 0, pending: 0 }
}

function updateActionEvidence(
  actions: Partial<Record<OperationalAction, CompletionActionEvidence>>,
  action: OperationalAction,
  status: CompletionEvidenceStatus,
): void {
  const evidence = actions[action] ?? emptyActionEvidence(status)
  evidence.latest = status
  if (status === 'success') evidence.successes += 1
  else if (status === 'failure') evidence.failures += 1
  else if (status === 'unknown') evidence.unknown += 1
  else evidence.pending += 1
  actions[action] = evidence
}

function invalidatesPriorVerification(actions: readonly OperationalAction[]): boolean {
  return actions.some((action) => action !== 'verify')
}

function updateOrderedActionEvidence(
  summary: CompletionEvidenceSummary,
  actions: readonly OperationalAction[],
  status: CompletionEvidenceStatus,
  orderedVerificationAfterMutation = false,
): void {
  const invalidatesVerification = invalidatesPriorVerification(actions)
  if (invalidatesVerification) delete summary.actions.verify
  for (const action of actions) {
    if (action === 'verify' && invalidatesVerification && !orderedVerificationAfterMutation) continue
    updateActionEvidence(summary.actions, action, status)
  }
}

// ==================== 证据汇总 ====================

/** 将 AgentLedger 安全汇总为非敏感 action/status 计数器 */
export function summarizeCompletionEvidence(ledger: AgentLedger): CompletionEvidenceSummary {
  const summary: CompletionEvidenceSummary = {
    actions: {},
    successfulTools: 0,
    failedTools: 0,
    unknownTools: 0,
    pendingTools: ledger.pending.length,
    classifiedSuccessfulTools: 0,
    classifiedFailedTools: 0,
    unclassifiedFailedTools: 0,
    unclassifiedUnknownTools: 0,
  }

  for (const record of ledger.completed) {
    const status = evidenceStatus(record)
    if (status === 'success') summary.successfulTools += 1
    else if (status === 'failure') summary.failedTools += 1
    else summary.unknownTools += 1

    const classified = classifyCompletionActions(record)
    const actions = classified.actions
    if (status === 'success' && actions.length > 0) summary.classifiedSuccessfulTools += 1
    if (status === 'failure' && actions.length > 0) summary.classifiedFailedTools += 1
    if (status === 'failure' && actions.length === 0) summary.unclassifiedFailedTools += 1
    if (status === 'unknown' && actions.length === 0) summary.unclassifiedUnknownTools += 1
    updateOrderedActionEvidence(summary, actions, status, classified.orderedVerificationAfterMutation)
  }

  for (const record of ledger.pending) {
    const classified = classifyCompletionActions(record)
    updateOrderedActionEvidence(summary, classified.actions, 'pending', classified.orderedVerificationAfterMutation)
  }

  return summary
}

// ==================== 非断言上下文检测 ====================

function clauseBefore(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 80), index)
  const boundary = Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf(','), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'))
  return prefix.slice(boundary + 1)
}

function isNonAssertiveContext(text: string, start: number, end: number): boolean {
  const before = clauseBefore(text, start)
  const after = text.slice(end, Math.min(text.length, end + 18))

  // 否定词（中英文）
  if (/(?:\u5c1a\u672a|\u8fd8\u672a|\u5e76\u672a|\u6ca1\u6709|\u6ca1\u80fd|\u672a\u80fd|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u66fe|\u5e76\u975e|\u4e0d\u53ef|\u4e0d\u786e\u5b9a|\u4e0d\u80fd\u786e\u8ba4)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,14}$/iu.test(before)) return true
  if (/\b(?:not|never|cannot|can't|unable\s+to|failed\s+to|didn't|hasn't|haven't|wasn't|isn't|cannot\s+confirm|can't\s+confirm)\b[^,.!?;]{0,20}$/iu.test(before)) return true

  // 计划、假设、前提条件
  if (/(?:\u5982\u679c|\u82e5|\u5047\u5982|\u4e00\u65e6|\u53ea\u6709|\u9664\u975e|\u5f85|\u7b49\u5230|\u5c06|\u4f1a|\u51c6\u5907|\u8ba1\u5212|\u6253\u7b97|\u9700\u8981|\u5fc5\u987b|\u53ef\u4ee5|\u5e94\u5f53)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,30}$/u.test(before)) return true
  if (/\b(?:if|when|once|unless|provided|assuming|will|would|could|should|can|may|might|plan(?:s|ned)?\s+to|intend(?:s|ed)?\s+to|need(?:s|ed)?\s+to|going\s+to|must)\b[^,.!?;]{0,35}$/iu.test(before)) return true
  if (/^\s*(?:\u540e|\u4e4b\u540e|\u65f6|\u4ee5\u540e|\u518d|\u624d|after\b|before\b|once\b|if\b|when\b)/iu.test(after)) return true

  // 引用的事件/字段名描述
  if (/(?:\u540d\u4e3a|\u53eb\u4f5c|\u5b57\u6bb5|\u4e8b\u4ef6|\u5b57\u7b26\u4e32|\u672f\u8bed|\u8bf4\u660e|\u63cf\u8ff0|\u89e3\u91ca)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,16}[\u201c\u2018"']?$/u.test(before) && /^[\u201d\u2019"']?(?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49|\u5982\u4f55|\u65f6)/u.test(after)) return true
  if (/[\u201c\u2018"']\s*$/u.test(before) && /^[\u201d\u2019"'](?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49)/u.test(after)) return true
  if (/\b(?:called|named|phrase|term|event|field|message|explains?\s+how|describes?\s+how)\b[^,.!?;]{0,24}[\u201c\u2018"']?$/iu.test(before) && /^[\u201d\u2019"']?\s*(?:event|status|field|message|flow|means|works?)\b/iu.test(after)) return true

  return false
}

// ==================== 声明检测 ====================

/** 检测助手回答中的操作完成声明，排除否定和计划 */
export function completionClaims(answer: string): CompletionAction[] {
  const claims = new Set<CompletionAction>()
  for (const action of [...operationalActions, 'complete' as const]) {
    for (const pattern of claimPatterns[action]) {
      pattern.lastIndex = 0
      for (const match of answer.matchAll(pattern)) {
        const start = match.index ?? 0
        if (!isNonAssertiveContext(answer, start, start + match[0].length)) claims.add(action)
      }
    }
  }
  // "completed successfully" 经常与特定操作重叠（如 "deployment completed successfully"），
  // 此时 complete 不增加独立的全任务断言
  if (claims.size > 1) claims.delete('complete')
  return [...claims]
}

// ==================== 替换文本 ====================

function replacementText(reason: CompletionEvidenceReason): string {
  if (reason === 'pending_evidence') {
    return '当前仍有工具调用未返回，无法确认相关操作已完成。请先等待或检查最后一次工具结果。'
  }
  if (reason === 'failed_evidence') {
    return '现有工具证据显示相关操作失败或未成功完成，因此不能声明已经完成。请检查最后一次失败结果后再决定下一步。'
  }
  if (reason === 'unknown_evidence') {
    return '工具结果的状态无法核验，因此不能确认相关操作已经完成。'
  }
  return '没有与该完成声明对应的成功工具证据，因此暂时无法确认相关操作已经完成。'
}

// ==================== 通用 Complete 支持检测 ====================

function genericCompletionSupported(summary: CompletionEvidenceSummary): CompletionEvidenceReason {
  if (summary.pendingTools > 0) return 'pending_evidence'
  if (summary.unclassifiedFailedTools > 0) return 'failed_evidence'
  if (summary.unclassifiedUnknownTools > 0) return 'unknown_evidence'
  if (summary.classifiedSuccessfulTools === 0) {
    if (summary.failedTools > 0) return 'failed_evidence'
    if (summary.unknownTools > 0 || summary.successfulTools > 0) return 'unknown_evidence'
    return 'missing_evidence'
  }
  const successfulNonVerificationAction = Object.entries(summary.actions).some(
    ([action, state]) => action !== 'verify' && state?.latest === 'success',
  )
  if (!successfulNonVerificationAction) return 'unknown_evidence'
  for (const state of Object.values(summary.actions)) {
    if (state?.latest === 'failure') return 'failed_evidence'
    if (state?.latest === 'unknown') return 'unknown_evidence'
    if (state?.latest === 'pending') return 'pending_evidence'
  }
  return 'supported'
}

// ==================== 证据评估 ====================

/**
 * 评估助手回答中的完成声明是否被工具证据支持。
 * 每个断言的独立操作都必须有匹配的成功证据。
 * 一个成功的工具不能授权无关的声明，后续成功只修复同一分类操作的失败。
 */
export function evaluateCompletionEvidence(
  answer: string,
  ledger: AgentLedger,
): CompletionEvidenceDecision {
  const claims = completionClaims(answer)
  if (claims.length === 0) {
    return {
      allowed: true,
      disposition: 'allow',
      reason: 'no_completion_claim',
      claimedActions: [],
      unsupportedActions: [],
    }
  }

  const summary = summarizeCompletionEvidence(ledger)
  const reasons = new Map<CompletionAction, CompletionEvidenceReason>()

  for (const claim of claims) {
    if (claim === 'complete') {
      reasons.set(claim, genericCompletionSupported(summary))
      continue
    }
    if (summary.pendingTools > 0) {
      reasons.set(claim, 'pending_evidence')
      continue
    }
    const state = summary.actions[claim]
    if (!state) reasons.set(claim, 'missing_evidence')
    else if (state.latest === 'success') reasons.set(claim, 'supported')
    else if (state.latest === 'failure') reasons.set(claim, 'failed_evidence')
    else if (state.latest === 'unknown') reasons.set(claim, 'unknown_evidence')
    else reasons.set(claim, 'pending_evidence')
  }

  const unsupportedActions = claims.filter((claim) => reasons.get(claim) !== 'supported')
  if (unsupportedActions.length === 0) {
    return {
      allowed: true,
      disposition: 'allow',
      reason: 'supported',
      claimedActions: claims,
      unsupportedActions: [],
    }
  }

  const unsupportedReasons = unsupportedActions.map((claim) => reasons.get(claim))
  const reason: CompletionEvidenceReason = unsupportedReasons.includes('pending_evidence')
    ? 'pending_evidence'
    : unsupportedReasons.includes('failed_evidence')
      ? 'failed_evidence'
      : unsupportedReasons.includes('unknown_evidence')
        ? 'unknown_evidence'
        : 'missing_evidence'

  return {
    allowed: false,
    disposition: reason === 'pending_evidence' || reason === 'failed_evidence' ? 'terminate' : 'downgrade',
    reason,
    claimedActions: claims,
    unsupportedActions,
    replacementText: replacementText(reason),
  }
}

/**
 * 向后兼容包装：将新 evaluateCompletionEvidence 转为旧 completionEvidenceAllows 的 boolean 返回值。
 * 用于逐步替换 durable.ts 中的现有调用点。
 */
export function completionEvidenceAllows(answer: string, ledger: AgentLedger): boolean {
  return evaluateCompletionEvidence(answer, ledger).allowed
}