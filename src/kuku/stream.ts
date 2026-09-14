export interface KukuStreamEvent {
  type: 'delta' | 'done' | 'error'
  text?: string
  error?: string
}

export class KukuSSEParser {
  private buffer = ''
  private finished = false

  push(chunk: string, flush = false): KukuStreamEvent[] {
    if (this.finished) return []
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const blocks = this.buffer.split('\n\n')
    this.buffer = flush ? '' : (blocks.pop() || '')
    const complete = flush ? blocks.concat(this.buffer ? [this.buffer] : []) : blocks
    const events: KukuStreamEvent[] = []

    for (const block of complete) {
      const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue

      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(data) as Record<string, unknown> } catch { continue }
      const type = parsed.type
      if (type === 'TEXT_BLOCK_DELTA') {
        const payload = parsed.data as Record<string, unknown> | undefined
        if (typeof payload?.delta === 'string' && payload.delta) {
          events.push({ type: 'delta', text: payload.delta })
        }
      } else if (type === 'ERROR') {
        this.finished = true
        events.push({ type: 'error', error: data })
      } else if (type === 'REPLY_END' || type === 'DIALOGUE_END') {
        this.finished = true
        events.push({ type: 'done' })
      }
    }
    return events
  }
}

export function openAIChunk(id: string, model: string, delta: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: finishReason }],
  })}\n\n`
}

export function openAICompletion(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}
