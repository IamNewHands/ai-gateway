import { describe, expect, it } from 'vitest'
import {
  filterSubagentTools,
  isFirstLevelSubagent,
  toolChoiceSelectsRemovedTool,
  validateM365ClientMetadata,
} from './responses-guardrails'

describe('M365 Responses client_metadata', () => {
  it('rejects non-object metadata', () => {
    expect(validateM365ClientMetadata([])).toMatchObject({ ok: false, code: 'invalid_client_metadata' })
    expect(validateM365ClientMetadata('x')).toMatchObject({ ok: false, code: 'invalid_client_metadata' })
  })

  it.each([-1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1])('rejects invalid agent_depth %s', (value) => {
    expect(validateM365ClientMetadata({ agent_depth: value })).toMatchObject({ ok: false, code: 'invalid_agent_depth' })
  })

  it('rejects blank and oversized task_id', () => {
    expect(validateM365ClientMetadata({ task_id: '   ' })).toMatchObject({ ok: false, code: 'invalid_task_id' })
    expect(validateM365ClientMetadata({ task_id: 'x'.repeat(1025) })).toMatchObject({ ok: false, code: 'invalid_task_id' })
  })

  it('normalizes valid metadata', () => {
    expect(validateM365ClientMetadata({ agent_depth: 1, task_id: ' task-1 ' })).toEqual({
      ok: true,
      metadata: { agent_depth: 1, task_id: 'task-1' },
    })
  })
})

describe('M365 first-level subagent tool isolation', () => {
  it('recognizes metadata or parent session header evidence', () => {
    expect(isFirstLevelSubagent({ agent_depth: 1 }, undefined)).toBe(true)
    expect(isFirstLevelSubagent({ agent_depth: 0 }, ' parent ')).toBe(true)
    expect(isFirstLevelSubagent({ agent_depth: 0 }, '   ')).toBe(false)
  })

  it('removes only agent creation tools and preserves local execution tools', () => {
    const result = filterSubagentTools([
      { type: 'function', name: 'task' },
      { type: 'function', name: 'collaboration.spawn_agent' },
      { type: 'function', name: 'exec' },
      { type: 'function', function: { name: 'exec_command' } },
      { type: 'function', function: { name: 'write_stdin' } },
      { type: 'function', function: { name: 'read_file' } },
    ])
    expect(result.tools.map((tool) => JSON.stringify(tool))).toEqual([
      JSON.stringify({ type: 'function', name: 'exec' }),
      JSON.stringify({ type: 'function', function: { name: 'exec_command' } }),
      JSON.stringify({ type: 'function', function: { name: 'write_stdin' } }),
      JSON.stringify({ type: 'function', function: { name: 'read_file' } }),
    ])
    expect(toolChoiceSelectsRemovedTool({ type: 'function', name: 'task' }, result.removedNames)).toBe(true)
    expect(toolChoiceSelectsRemovedTool({ type: 'function', function: { name: 'exec' } }, result.removedNames)).toBe(false)
  })
})
