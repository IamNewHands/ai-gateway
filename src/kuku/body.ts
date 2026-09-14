import { KUKU_APP_ID, KUKU_CHANNEL } from './constants'

export interface KukuSessionRef {
  sessionId: string
  replyId: string
  clientSessionId: string
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) throw new Error('Kuku only supports text message content')

  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new Error('Kuku only supports text message content')
    const item = part as Record<string, unknown>
    if (item.type !== 'text' || typeof item.text !== 'string') {
      throw new Error('Kuku does not support image, audio, file, or other multimodal content')
    }
    parts.push(item.text)
  }
  return parts.join('\n')
}

export function buildKukuPrompt(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Kuku requires at least one message')
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== 'object') throw new Error(`Invalid message at index ${index}`)
    const item = message as Record<string, unknown>
    const role = typeof item.role === 'string' ? item.role : 'user'
    return `[${role}]\n${textContent(item.content)}`
  }).join('\n\n')
}

function commonData(prompt: string, model: string, thinkMode: number) {
  const richInputContent = [{ type: 'text', text: prompt }]
  return {
    project_type: 1,
    text: prompt,
    rich_input_params: [{ id: 'textId', version: '1.0', type: 'text', text: prompt, data: { content: prompt } }],
    fsid: [],
    quotes: [],
    skills: [],
    experts: [],
    model_name: model,
    model_display_name: model,
    think_mode: thinkMode,
    show_text: JSON.stringify({
      skills: [], experts: [], model_name: model, model_display_name: model,
      think_mode: thinkMode, richInputContent, fileInfo: [],
    }),
    premake_data: {},
    custom_instructions: '',
    memory_sign: true,
    skill_dig_sign: true,
  }
}

export function buildKukuSendBody(
  prompt: string,
  model: string,
  thinkMode: number,
  clientSessionId: string,
  credentials: { bdstoken: string; uinfo: string; uk: number },
) {
  return {
    type: 'message',
    sub_type: 'chat_create',
    client_session_id: clientSessionId,
    session_id: '',
    uk: '',
    cid: 0,
    channel: KUKU_CHANNEL,
    device_type: 400,
    created_at: Date.now(),
    msg_type: 1,
    sync_type: 0,
    sync_id: '',
    v: crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    data: {
      ...commonData(prompt, model, thinkMode),
      client_added: JSON.stringify({
        client_session_id: clientSessionId,
        permission_type: 0,
        clienttype: 400,
        app_id: KUKU_APP_ID,
        web: 1,
        channel: 'chunlei',
        version: '1.4.4',
        ...credentials,
      }),
    },
  }
}

export function buildKukuStreamBody(
  prompt: string,
  model: string,
  thinkMode: number,
  session: KukuSessionRef,
) {
  return {
    ...commonData(prompt, model, thinkMode),
    session_id: session.sessionId,
    reply_id: session.replyId,
  }
}
