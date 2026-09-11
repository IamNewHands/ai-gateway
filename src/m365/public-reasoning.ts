/**
 * Responses compatibility for Microsoft-authored, publicly displayed summaries.
 * Never manufacture a summary from assistant text, tool progress or code.
 */
export interface PublicReasoningItem {
  id: string
  type: 'reasoning'
  status: 'completed'
  summary: Array<{ type: 'summary_text'; text: string }>
}

export function requestsPublicReasoning(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const options = value as Record<string, unknown>
  const mode = options['summary'] === undefined ? options['generate_summary'] : options['summary']
  return mode === 'auto' || mode === 'concise' || mode === 'detailed'
}

/**
 * 判断一次 Chat Completions 请求是否应投递公开推理（移植自 M365-Gateway
 * openai.ts chatDeliversPublicReasoning）。缺省为投递；仅当 summary 显式
 * 为 "none" 时关闭。与 requestsPublicReasoning 方向相反：后者问"客户端是否
 * 请求"，本函数问"是否应投递"。
 */
export function chatDeliversPublicReasoning(reasoning: unknown): boolean {
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return true
  const options = reasoning as Record<string, unknown>
  const mode = options['summary'] === undefined ? options['generate_summary'] : options['summary']
  return mode !== 'none'
}

/**
 * 把上游公开推理摘要渲染为 Chat Completions 的 reasoning_content
 * （移植自 M365-Gateway openai.ts chatReasoningContent）：去重、按 16384
 * 字符总预算截断、以空行连接。
 */
export function chatReasoningContent(summaries: readonly string[] | undefined): string | undefined {
  if (!summaries?.length) return undefined
  const seen = new Set<string>()
  const parts: string[] = []
  let remaining = 16_384
  for (const text of summaries) {
    if (typeof text !== 'string' || !text.trim() || seen.has(text) || text.length > remaining) continue
    seen.add(text)
    parts.push(text)
    remaining -= text.length
  }
  return parts.length ? parts.join('\n\n') : undefined
}

export function appendPublicReasoning(
  output: unknown[],
  summaries: readonly string[] | undefined,
  requested: boolean,
): unknown[] {
  if (!requested || !summaries?.length) return output
  let remaining = 16_384
  const seen = new Set<string>()
  const summary: PublicReasoningItem['summary'] = []
  for (const text of summaries) {
    if (summary.length >= 64) break
    if (typeof text !== 'string' || !text.trim() || seen.has(text) || text.length > remaining) continue
    seen.add(text)
    remaining -= text.length
    summary.push({ type: 'summary_text', text })
  }
  if (!summary.length) return output
  // Keep the business item at index 0: existing continuation aliases and tool
  // event indices must not shift when optional public metadata is present.
  return [...output, {
    id: `rs_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'reasoning', status: 'completed', summary,
  } satisfies PublicReasoningItem]
}

export function publicReasoningEvents(output: unknown[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  output.forEach((raw, outputIndex) => {
    if (!raw || typeof raw !== 'object' || (raw as { type?: string }).type !== 'reasoning') return
    const item = raw as PublicReasoningItem
    events.push({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', summary: [] } })
    item.summary.forEach((part, summaryIndex) => {
      const indices = { item_id: item.id, output_index: outputIndex, summary_index: summaryIndex }
      events.push({ type: 'response.reasoning_summary_part.added', ...indices, part: { type: 'summary_text', text: '' } })
      events.push({ type: 'response.reasoning_summary_text.delta', ...indices, delta: part.text })
      events.push({ type: 'response.reasoning_summary_text.done', ...indices, text: part.text })
      events.push({ type: 'response.reasoning_summary_part.done', ...indices, part })
    })
    events.push({ type: 'response.output_item.done', output_index: outputIndex, item })
  })
  return events
}

/**
 * Extract public reasoning summary strings from ChatHub events
 */
export function extractPublicReasoningSummaries(events: unknown[]): string[] {
  const summariesMap = new Map<string, string>()
  const orderedIds: string[] = []

  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const m = item as Record<string, unknown>
    const author = String(m['author'] || '').toLowerCase()
    const messageType = String(m['messageType'] || '')
    const contentOrigin = String(m['contentOrigin'] || '')
    const text = typeof m['text'] === 'string' ? m['text'] : ''

    if (author === 'bot' && messageType === 'Progress' && contentOrigin === 'ChainOfThoughtSummary' && text.trim() !== '') {
      const id = typeof m['messageId'] === 'string' && m['messageId'] ? m['messageId'] : `msg_${orderedIds.length}`
      if (!summariesMap.has(id)) {
        orderedIds.push(id)
      }
      summariesMap.set(id, text)
    }

    if (Array.isArray(m['messages'])) {
      for (const nested of m['messages']) visit(nested)
    }
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const record = ev as Record<string, unknown>
    if (Array.isArray(record['arguments'])) {
      for (const arg of record['arguments']) visit(arg)
    }
    if (record['item'] && typeof record['item'] === 'object') {
      visit(record['item'])
    }
  }

  return orderedIds.map((id) => summariesMap.get(id)!).filter(Boolean)
}
