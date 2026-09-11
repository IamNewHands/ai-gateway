import { describe, it, expect } from 'vitest'
import {
  isCallerLocalExecRefusal,
  shouldRecoverCallerLocalExecRefusal,
  shouldRecoverFableLocalExecRefusal,
  hasFreshCallerLocalContinuationEvidence,
  hasFreshCallerLocalFailureEvidence,
  callerLocalToolCandidates,
  normalizedToolIdentifier,
  preferredSecondAttemptLocalToolName,
  deterministicToolRouterRecovery,
  toolRequired,
  assistantReportsIncompleteOutcome,
  shouldAuditCallerLocalContinuation,
  shouldBufferToolStream,
  unresolvedAssistantCommitment,
} from './tools'
import type { AgentLedger, ToolDef } from './tools'
import type { TaskAnchor } from './task-anchors'

function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

const execTool = def('exec_command', 'Run a command in the caller local terminal shell', { cmd: { type: 'string' }, workdir: { type: 'string' } }, ['cmd'])
const readTool = def('read_file', 'Read a file from the local filesystem workspace', { path: { type: 'string' } }, ['path'])
const globTool = def('glob', 'Search files by pattern in the local workspace directory', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern'])
const hostedTool = def('code_interpreter', 'Run code in a hosted sandbox execution environment', { code: { type: 'string' } })

function emptyLedger(): AgentLedger {
  return { completed: [], pending: [], toolRounds: 0, repeatedCall: false, repeatedFailure: false }
}

describe('callerLocalToolCandidates：按能力分类调用方本地工具', () => {
  it('识别 exec/read/glob 的能力', () => {
    const c = callerLocalToolCandidates([execTool, readTool, globTool])
    const byName = Object.fromEntries(c.map((x) => [x.name, x.capabilities]))
    expect(byName['exec_command']).toContain('process_start')
    expect(byName['read_file']).toContain('filesystem_read')
    expect(byName['glob']).toContain('filesystem_search')
  })

  it('hosted/沙箱执行环境被显式排除', () => {
    expect(callerLocalToolCandidates([hostedTool])).toHaveLength(0)
  })

  it('normalizedToolIdentifier 归一 camelCase 与分隔符', () => {
    expect(normalizedToolIdentifier('ReadFile')).toBe('read_file')
    expect(normalizedToolIdentifier('read-file')).toBe('read_file')
    expect(normalizedToolIdentifier('__read file__')).toBe('read_file')
  })

  it('toolRequired 判定 required / 具名 / auto', () => {
    expect(toolRequired('required')).toBe(true)
    expect(toolRequired({ type: 'function', function: { name: 'x' } })).toBe(true)
    expect(toolRequired('auto')).toBe(false)
    expect(toolRequired(null)).toBe(false)
  })
})

describe('isCallerLocalExecRefusal：可用性矛盾检测（中/英/视觉）', () => {
  const base = { tone: 'Gpt_5_6_Chat', toolChoice: 'auto', tools: [execTool, readTool] as unknown[], prompt: '[USER]\n查看 D:\\repo\\package.json' }

  it('英文拒绝语义命中', () => {
    expect(isCallerLocalExecRefusal({ ...base, responseText: 'I cannot access the caller local filesystem tools in this session.' })).toBe(true)
  })

  it('中文拒绝语义命中', () => {
    expect(isCallerLocalExecRefusal({ ...base, responseText: '当前会话未暴露客户端本地执行工具，我无法读取文件系统。' })).toBe(true)
  })

  it('无本地工具时不判定', () => {
    expect(isCallerLocalExecRefusal({ ...base, tools: [hostedTool], responseText: 'I cannot access your local filesystem tools.' })).toBe(false)
  })

  it('toolChoice 非 auto 时不判定', () => {
    expect(isCallerLocalExecRefusal({ ...base, toolChoice: 'none', responseText: 'I cannot access the caller local filesystem tools.' })).toBe(false)
  })

  it('正常回答不误判', () => {
    expect(isCallerLocalExecRefusal({ ...base, responseText: 'Here is the content of package.json: { "name": "x" }' })).toBe(false)
  })

  it('视觉拒绝仅在声明 view_image 时命中', () => {
    const viewImage = def('view_image', 'View a local image file from the caller workspace', { path: { type: 'string' } })
    const input = { tone: 'Gpt_5_6_Chat', toolChoice: 'auto', tools: [viewImage] as unknown[], prompt: '[USER]\n看下这张图' }
    expect(isCallerLocalExecRefusal({ ...input, responseText: '我无法读取图片内容。' })).toBe(true)
    const noVisual = { ...input, tools: [execTool] as unknown[] }
    expect(isCallerLocalExecRefusal({ ...noVisual, responseText: '我无法读取图片内容。' })).toBe(false)
  })
})

describe('shouldRecoverCallerLocalExecRefusal：拒绝 + 用户因果意图门禁', () => {
  const input = (prompt: string, responseText: string) => ({ tone: 'Gpt_5_6_Chat', toolChoice: 'auto', tools: [execTool, readTool] as unknown[], prompt, responseText })

  it('拒绝 + 无关键词的具体用户命令 → 需恢复（因果意图以自然语言为准）', () => {
    expect(shouldRecoverCallerLocalExecRefusal(input('[USER]\n接上那台机器', '我无法读取或操作弹出的远程登录窗口，因此不能替你选择服务器。'))).toBe(true)
  })

  it('英文会话未暴露本地执行工具 + 具体命令 → 需恢复', () => {
    expect(shouldRecoverCallerLocalExecRefusal(input(
      '[USER]\nContinue the deployment.',
      'The current session does not expose the local Windows client execution tools, so I cannot continue.',
    ))).toBe(true)
  })

  it('拒绝 + 纯解释性问题 → 不恢复', () => {
    expect(shouldRecoverCallerLocalExecRefusal(input('[USER]\n请解释一下什么是本地文件系统', 'I cannot access the caller local filesystem tools.'))).toBe(false)
  })

  it('拒绝 + 明确"失败即停止" → 不恢复', () => {
    expect(shouldRecoverCallerLocalExecRefusal(input('[USER]\n如果出错就停止，不要再继续', 'I cannot access the caller local tools.'))).toBe(false)
  })

  it('仅有工具协议、无 USER 条目 → 不恢复', () => {
    expect(shouldRecoverCallerLocalExecRefusal(input('[TOOL RESULT]\nsome output', 'I cannot access the caller local filesystem tools.'))).toBe(false)
  })

  it('shouldRecoverFableLocalExecRefusal 仅对 Fable/Opus/Sonnet tone 生效', () => {
    const p = '[USER]\n查看 D:\\repo\\package.json'
    const r = 'I cannot access the caller local filesystem tools.'
    expect(shouldRecoverFableLocalExecRefusal({ tone: 'Claude_Fable_5', toolChoice: 'auto', tools: [readTool], prompt: p, responseText: r })).toBe(true)
    expect(shouldRecoverFableLocalExecRefusal({ tone: 'Gpt_5_6_Chat', toolChoice: 'auto', tools: [readTool], prompt: p, responseText: r })).toBe(false)
  })
})

describe('hasFresh*Evidence：基于结构化历史的证据判定', () => {
  const tools = [execTool, readTool] as unknown[]

  it('本地工具已完成结果 → continuation 证据成立', () => {
    const ledger = emptyLedger()
    ledger.completed.push({ id: 'c1', name: 'read_file', arguments: '{}', result: 'ok', failed: false })
    expect(hasFreshCallerLocalContinuationEvidence(tools, ledger)).toBe(true)
  })

  it('仅 pending（无结果）→ 证据不成立', () => {
    const ledger = emptyLedger()
    ledger.pending.push({ id: 'c1', name: 'read_file', arguments: '{}', result: '', failed: false })
    expect(hasFreshCallerLocalContinuationEvidence(tools, ledger)).toBe(false)
  })

  it('非本地工具完成 → 证据不成立', () => {
    const ledger = emptyLedger()
    ledger.completed.push({ id: 'c1', name: 'web_search', arguments: '{}', result: 'ok', failed: false })
    expect(hasFreshCallerLocalContinuationEvidence(tools, ledger)).toBe(false)
  })

  it('最新本地结果失败 → failure 证据成立', () => {
    const ledger = emptyLedger()
    ledger.completed.push({ id: 'c1', name: 'exec_command', arguments: '{}', result: 'error:boom', failed: true })
    expect(hasFreshCallerLocalFailureEvidence(tools, ledger)).toBe(true)
  })

  it('本地结果成功 → failure 证据不成立', () => {
    const ledger = emptyLedger()
    ledger.completed.push({ id: 'c1', name: 'exec_command', arguments: '{}', result: 'ok', failed: false })
    expect(hasFreshCallerLocalFailureEvidence(tools, ledger)).toBe(false)
  })
})

describe('preferredSecondAttemptLocalToolName：能力排序选工具', () => {
  it('单候选直接返回', () => {
    expect(preferredSecondAttemptLocalToolName([readTool], emptyLedger(), 'read it')).toBe('read_file')
  })

  it('进程动作意图优先选 exec', () => {
    const ledger = emptyLedger()
    expect(preferredSecondAttemptLocalToolName([execTool, readTool, globTool], ledger, 'run the build now')).toBe('exec_command')
  })

  it('搜索意图选 glob', () => {
    const ledger = emptyLedger()
    expect(preferredSecondAttemptLocalToolName([execTool, readTool, globTool], ledger, '请列出项目目录结构')).toBe('glob')
  })

  it('无本地工具返回 null', () => {
    expect(preferredSecondAttemptLocalToolName([hostedTool], emptyLedger(), 'run build')).toBeNull()
  })
})

describe('deterministicToolRouterRecovery：必需动作的确定性合成', () => {
  const anchors: TaskAnchor[] = [{ kind: 'windows_path', value: 'D:\\repo\\package.json' }]

  it('非 required 时不合成', async () => {
    expect(await deterministicToolRouterRecovery('read D:\\repo\\package.json', [readTool], 'auto', emptyLedger(), anchors)).toBeNull()
  })

  it('required + 唯一路径锚点 + 只读意图 → 合成 read 调用', async () => {
    const call = await deterministicToolRouterRecovery(
      'read D:\\repo\\package.json', [readTool], { type: 'function', function: { name: 'read_file' } }, emptyLedger(), anchors,
    )
    expect(call).not.toBeNull()
    expect(call!.name).toBe('read_file')
    expect(JSON.parse(call!.arguments)).toMatchObject({ path: 'D:\\repo\\package.json' })
  })

  it('写意图（unsafeIntent）绝不合成', async () => {
    const call = await deterministicToolRouterRecovery(
      'delete D:\\repo\\package.json', [readTool], { type: 'function', function: { name: 'read_file' } }, emptyLedger(), anchors,
    )
    expect(call).toBeNull()
  })

  it('多个路径锚点（无法确定唯一目标）不合成', async () => {
    const many: TaskAnchor[] = [
      { kind: 'windows_path', value: 'D:\\a\\x.json' },
      { kind: 'windows_path', value: 'D:\\b\\y.json' },
    ]
    expect(await deterministicToolRouterRecovery('read them', [readTool], { type: 'function', function: { name: 'read_file' } }, emptyLedger(), many)).toBeNull()
  })

  it('无路径锚点不合成', async () => {
    expect(await deterministicToolRouterRecovery('read it', [readTool], { type: 'function', function: { name: 'read_file' } }, emptyLedger(), [])).toBeNull()
  })

  it('已完成的相同调用不重复合成（去重护栏）', async () => {
    const ledger = emptyLedger()
    ledger.completed.push({ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'D:\\repo\\package.json' }), result: 'ok', failed: false })
    const call = await deterministicToolRouterRecovery(
      'read D:\\repo\\package.json', [readTool], { type: 'function', function: { name: 'read_file' } }, ledger, anchors,
    )
    expect(call).toBeNull()
  })
})

describe('assistantReportsIncompleteOutcome：诚实的未完成结局判定', () => {
  it('中文未完成状态命中', () => {
    expect(assistantReportsIncompleteOutcome('任务尚未完成，部署仍未执行。')).toBe(true)
  })

  it('英文未完成状态命中', () => {
    expect(assistantReportsIncompleteOutcome('The deployment is not yet complete.')).toBe(true)
  })

  it('已完成不命中', () => {
    expect(assistantReportsIncompleteOutcome('The deployment completed successfully.')).toBe(false)
  })

  it('引用块/代码块内的未完成表述被剥离后不误判', () => {
    expect(assistantReportsIncompleteOutcome('引用文档称：\n> not yet complete\n\n结论：一切正常。')).toBe(false)
    expect(assistantReportsIncompleteOutcome('示例输出：\n```\nnot yet complete\n```')).toBe(false)
  })
})

describe('shouldAuditCallerLocalContinuation：本地结果续接审计门禁', () => {
  const base = {
    tone: 'Gpt_5_6_Chat',
    toolChoice: 'auto',
    tools: [execTool, readTool] as unknown[],
    prompt: '[USER]\n按刚才的结果继续部署',
    responseText: '待评估',
  }

  it('fresh 本地结果 + 因果 USER 段 → 需审计', () => {
    expect(shouldAuditCallerLocalContinuation({ ...base, freshCallerLocalResult: true })).toBe(true)
  })

  it('无 fresh 本地结果 → 不审计', () => {
    expect(shouldAuditCallerLocalContinuation({ ...base, freshCallerLocalResult: false })).toBe(false)
  })

  it('无 USER 段（仅工具协议）→ 不审计', () => {
    expect(shouldAuditCallerLocalContinuation({ ...base, prompt: '[TOOL RESULT]\nok', freshCallerLocalResult: true })).toBe(false)
  })

  it('解释性提问 → 不审计', () => {
    expect(shouldAuditCallerLocalContinuation({ ...base, prompt: '[USER]\n请解释一下本地工具是怎么工作的', freshCallerLocalResult: true })).toBe(false)
  })

  it('显式失败即停止 → 不审计', () => {
    expect(shouldAuditCallerLocalContinuation({ ...base, prompt: '[USER]\n如果出错就停止', freshCallerLocalResult: true })).toBe(false)
  })
})

describe('shouldBufferToolStream：流缓冲判定', () => {
  it('有工具且 toolChoice 非 none → 缓冲', () => {
    expect(shouldBufferToolStream([execTool], 'auto')).toBe(true)
    expect(shouldBufferToolStream([execTool], { type: 'function', function: { name: 'exec_command' } })).toBe(true)
  })

  it('toolChoice none → 不缓冲（除非本地变更请求）', () => {
    expect(shouldBufferToolStream([execTool], 'none')).toBe(false)
  })

  it('无工具但要求写本地工作区文件 → 仍缓冲', () => {
    expect(shouldBufferToolStream([], 'auto', '[USER]\n把结果写入 D:\\repo\\out.txt')).toBe(true)
  })

  it('无工具、无本地变更意图 → 不缓冲', () => {
    expect(shouldBufferToolStream(undefined, 'auto', '[USER]\n你好')).toBe(false)
  })
})

describe('unresolvedAssistantCommitment：升级后的散文剥离', () => {
  it('真实承诺仍命中', () => {
    expect(unresolvedAssistantCommitment("I'll now run the build and fix errors.", false)).toBe(true)
    expect(unresolvedAssistantCommitment('接下来我会执行构建并修复所有错误。', false)).toBe(true)
  })

  it('引用块内的将来时被剥离后不误判', () => {
    expect(unresolvedAssistantCommitment('文档写道：\n> I will run the build later.\n\n以上是原文。', false)).toBe(false)
  })

  it('hasToolCalls 短路仍生效（契约兼容）', () => {
    expect(unresolvedAssistantCommitment("I'll now run the build.", true)).toBe(false)
  })
})
