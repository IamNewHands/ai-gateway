import { normalizedToolIdentifier } from './tools'

export interface M365ClientMetadata {
  agent_depth?: 0 | 1
  task_id?: string
}

export type ClientMetadataValidation =
  | { ok: true; metadata: M365ClientMetadata | undefined }
  | { ok: false; code: 'invalid_client_metadata' | 'invalid_agent_depth' | 'invalid_task_id'; message: string }

const AGENT_CREATION_TOOLS = new Set([
  'task',
  'spawn_agent',
  'delegate_task',
  'create_agent',
  'collaboration_spawn_agent',
])

export function validateM365ClientMetadata(value: unknown): ClientMetadataValidation {
  if (value === undefined) return { ok: true, metadata: undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_client_metadata', message: 'client_metadata must be an object' }
  }

  const raw = value as Record<string, unknown>
  const metadata: M365ClientMetadata = {}

  if (raw['agent_depth'] !== undefined) {
    const depth = raw['agent_depth']
    if (!Number.isSafeInteger(depth) || (depth !== 0 && depth !== 1)) {
      return { ok: false, code: 'invalid_agent_depth', message: 'client_metadata.agent_depth must be 0 or 1' }
    }
    metadata.agent_depth = depth as 0 | 1
  }

  if (raw['task_id'] !== undefined) {
    if (typeof raw['task_id'] !== 'string') {
      return { ok: false, code: 'invalid_task_id', message: 'client_metadata.task_id must be a string' }
    }
    const taskId = raw['task_id'].trim()
    if (!taskId || taskId.length > 1024) {
      return { ok: false, code: 'invalid_task_id', message: 'client_metadata.task_id must contain 1 to 1024 characters' }
    }
    metadata.task_id = taskId
  }

  return { ok: true, metadata }
}

export function isFirstLevelSubagent(metadata: M365ClientMetadata | undefined, parentSessionId: unknown): boolean {
  return metadata?.agent_depth === 1
    || (typeof parentSessionId === 'string' && parentSessionId.trim().length > 0)
}

export function responseToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  const record = tool as Record<string, unknown>
  const fn = record['function']
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>)['name']
    return typeof name === 'string' ? name.trim() : ''
  }
  return typeof record['name'] === 'string' ? record['name'].trim() : ''
}

export function isAgentCreationToolName(name: string): boolean {
  return AGENT_CREATION_TOOLS.has(normalizedToolIdentifier(name))
}

export function filterSubagentTools(tools: unknown): { tools: unknown[]; removedNames: Set<string> } {
  if (!Array.isArray(tools)) return { tools: [], removedNames: new Set() }
  const removedNames = new Set<string>()
  const filtered = tools.filter((tool) => {
    const name = responseToolName(tool)
    if (!name || !isAgentCreationToolName(name)) return true
    removedNames.add(normalizedToolIdentifier(name))
    return false
  })
  return { tools: filtered, removedNames }
}

export function namedToolChoiceName(choice: unknown): string {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return ''
  const record = choice as Record<string, unknown>
  if (record['type'] !== 'function' && record['type'] !== 'tool') return ''
  const fn = record['function']
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>)['name']
    if (typeof name === 'string') return name.trim()
  }
  return typeof record['name'] === 'string' ? record['name'].trim() : ''
}

export function toolChoiceSelectsRemovedTool(choice: unknown, removedNames: ReadonlySet<string>): boolean {
  const name = namedToolChoiceName(choice)
  return Boolean(name) && removedNames.has(normalizedToolIdentifier(name))
}
