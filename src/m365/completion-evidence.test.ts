import { describe, it, expect } from 'vitest'
import {
  classifyCompletionActions,
  completionClaims,
  evaluateCompletionEvidence,
  summarizeCompletionEvidence,
  completionEvidenceAllows,
} from './completion-evidence'
import type { AgentLedger, ToolEvidence } from './tools'

function toolEvidence(name: string, args: string, result: string, failed = false): ToolEvidence {
  return { id: `c_${Math.random()}`, name, arguments: args, result, failed }
}

function ledger(completed: ToolEvidence[], pending: ToolEvidence[] = []): AgentLedger {
  return {
    completed,
    pending,
    toolRounds: completed.length + pending.length,
    repeatedCall: false,
    repeatedFailure: false,
  }
}

describe('classifyCompletionActions', () => {
  it('按工具名分类 deploy', () => {
    const r = classifyCompletionActions({ name: 'deploy', arguments: '{}' })
    expect(r.actions).toContain('deploy')
  })

  it('按工具名分类 verify', () => {
    const r = classifyCompletionActions({ name: 'run_tests', arguments: '{}' })
    expect(r.actions).toContain('verify')
  })

  it('read/被动读取不分类为 verify（仅检查名称）', () => {
    const r = classifyCompletionActions({ name: 'read_file', arguments: '{"path":"/a"}' })
    expect(r.actions).not.toContain('verify')
  })

  it('shell 工具（sh/bash）中的 npm test 命令分类为 verify', () => {
    const r = classifyCompletionActions({ name: 'sh', arguments: '{"cmd":"npm test"}' })
    expect(r.actions).toContain('verify')
  })

  it('shell 工具中的 install 命令分类为 install', () => {
    const r = classifyCompletionActions({ name: 'exec_command', arguments: '{"cmd":"pip install foo"}' })
    expect(r.actions).toContain('install')
  })

  it('shell 工具的被动读取命令不产生动作', () => {
    const r = classifyCompletionActions({ name: 'bash', arguments: '{"cmd":"Get-Content style.css -Raw"}' })
    expect(r.actions).toEqual([])
  })

  it('Code Mode exec 从 input 中的静态 exec_command 提取命令', () => {
    const r = classifyCompletionActions({
      name: 'exec',
      arguments: JSON.stringify({ input: 'const r = await tools.exec_command({cmd: "npm test"});' }),
    })
    expect(r.actions).toContain('verify')
  })

  it('apply_patch 分类为 fix + patch 头动作', () => {
    const patch = `*** Begin Patch
*** Add File: index.html
+<h1>x</h1>
*** End Patch`
    const r = classifyCompletionActions({ name: 'apply_patch', arguments: JSON.stringify({ input: patch }) })
    expect(r.actions).toContain('fix')
    expect(r.actions).toContain('create')
  })
})

describe('completionClaims 声明检测', () => {
  it('检测已部署的英文声明', () => {
    const claims = completionClaims('The deployment completed successfully.')
    expect(claims).toContain('deploy')
  })

  it('检测中文部署完成声明', () => {
    const claims = completionClaims('部署已完成。')
    expect(claims).toContain('deploy')
  })

  it('不把否定句当作声明', () => {
    const claims = completionClaims('I have not deployed it yet.')
    expect(claims).not.toContain('deploy')
  })

  it('不把计划当作声明', () => {
    const claims = completionClaims('I will deploy it once you confirm.')
    expect(claims).not.toContain('deploy')
  })

  it('无完成措辞时不产生声明', () => {
    const claims = completionClaims('Here is some general information about the service.')
    expect(claims).toEqual([])
  })
})

describe('evaluateCompletionEvidence + completionEvidenceAllows', () => {
  it('无声明时允许', () => {
    const l = ledger([])
    expect(evaluateCompletionEvidence('这里是一些信息。', l).allowed).toBe(true)
    expect(completionEvidenceAllows('这里是一些信息。', l)).toBe(true)
  })

  it('有成功证据支持的声明允许', () => {
    const l = ledger([
      toolEvidence('run_tests', '{}', 'Tests passed', false),
    ])
    const result = evaluateCompletionEvidence('测试已通过。', l)
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('supported')
  })

  it('无证据的完成声明被阻止', () => {
    const l = ledger([])
    const result = evaluateCompletionEvidence('部署已完成。', l)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('missing_evidence')
    expect(completionEvidenceAllows('部署已完成。', l)).toBe(false)
  })

  it('有失败证据时阻止', () => {
    const l = ledger([
      toolEvidence('deploy', '{}', 'exit code: 1, error', true),
    ])
    const result = evaluateCompletionEvidence('部署已完成。', l)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('failed_evidence')
  })

  it('有未完成（pending）调用时阻止 strong claim', () => {
    const l = ledger([], [
      toolEvidence('deploy', '{}', '', false),
    ])
    const result = evaluateCompletionEvidence('部署已完成。', l)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('pending_evidence')
  })

  it('声明与工具证据不匹配时阻止（missing_evidence）', () => {
    // 只有 verify 证据，但声明是 deploy
    const l = ledger([
      toolEvidence('run_tests', '{}', 'Tests passed', false),
    ])
    const result = evaluateCompletionEvidence('部署已完成。', l)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('missing_evidence')
  })

  it('验证声明需要 verify 证据', () => {
    const l = ledger([
      toolEvidence('run_tests', '{}', 'Tests passed', false),
    ])
    const result = evaluateCompletionEvidence('验证已通过。', l)
    expect(result.allowed).toBe(true)
    expect(result.claimedActions).toContain('verify')
  })
})

describe('summarizeCompletionEvidence', () => {
  it('正确汇总成功/失败工具数量', () => {
    const l = ledger([
      toolEvidence('deploy', '{}', 'Deployed', false),
      toolEvidence('run_tests', '{}', 'Tests passed', false),
      toolEvidence('some_passive_tool', '{}', 'exit code: 1', true),
    ])
    const summary = summarizeCompletionEvidence(l)
    expect(summary.successfulTools).toBe(2)
    expect(summary.failedTools).toBe(1)
    expect(summary.actions.verify?.latest).toBe('success')
    expect(summary.actions.deploy?.latest).toBe('success')
  })

  it('mutation 之后的验证证据被失效（freshness）', () => {
    const l = ledger([
      toolEvidence('run_tests', '{}', 'Tests passed', false),
      toolEvidence('deploy', '{}', 'Deployed', false),
    ])
    const summary = summarizeCompletionEvidence(l)
    // deploy（mutation）在 run_tests（verify）之后 → verify 证据被失效
    expect(summary.actions.verify).toBeUndefined()
    expect(summary.actions.deploy?.latest).toBe('success')
  })
})