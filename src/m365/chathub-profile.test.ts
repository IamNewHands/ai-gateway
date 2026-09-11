import { describe, expect, it } from 'vitest'
import { chatHubAllowedMessageTypes, chatHubAnswerMessageText, chatPayload } from './chathub'

const ANSWER_ONLY_TYPES = [
  'Chat',
  'Suggestion',
  'InternalSearchQuery',
  'Disengaged',
  'InternalLoaderMessage',
  'Progress',
  'RenderCardRequest',
  'SemanticSerp',
  'GenerateContentQuery',
  'SearchQuery',
  'ConfirmationCard',
  'DeveloperLogs',
  'EndOfRequest',
  'ReferencesListComplete',
  'GeneratedCode',
]

const COMPACT_TYPES = [
  'Chat',
  'Disengaged',
  'Progress',
  'ConfirmationCard',
  'EndOfRequest',
  'ReferencesListComplete',
]

describe('ChatHub message profiles', () => {
  it('uses the complete message set for answer turns', () => {
    expect(chatHubAllowedMessageTypes({ messageProfile: 'answer' })).toEqual(ANSWER_ONLY_TYPES)
  })

  it('uses the compact message set for caller-tool and router turns', () => {
    expect(chatHubAllowedMessageTypes({ messageProfile: 'caller_tool' })).toEqual(COMPACT_TYPES)
    expect(chatHubAllowedMessageTypes({ messageProfile: 'router' })).toEqual(COMPACT_TYPES)
  })

  it('retains compatibility inference when no explicit profile is supplied', () => {
    expect(chatHubAllowedMessageTypes({ tools: [{ type: 'function', function: { name: 'read' } }] })).toEqual(COMPACT_TYPES)
    expect(chatHubAllowedMessageTypes({ toolChoice: 'none' })).toEqual(COMPACT_TYPES)
    expect(chatHubAllowedMessageTypes({})).toEqual(ANSWER_ONLY_TYPES)
  })

  it('serializes the selected profile message types into the ChatHub invocation', () => {
    const wire = chatPayload({
      text: 'hello',
      tone: 'Gpt_5_6_Chat',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      messageProfile: 'router',
    }, 'request-1')
    const invocation = JSON.parse(wire.split('\u001e')[0])

    expect(invocation.arguments[0].tone).toBe('Gpt_5_6_Chat')
    expect(invocation.arguments[0].allowedMessageTypes).toEqual(COMPACT_TYPES)
  })
})

describe('chatHubAnswerMessageText（对齐 M365-Gateway，防静默丢弃真实回答）', () => {
  it('接受显式 messageType="Chat" 的正常答案（历史 bug 会丢弃）', () => {
    expect(chatHubAnswerMessageText({ author: 'bot', messageType: 'Chat', text: 'real answer' })).toBe('real answer')
  })

  it('接受 messageType 为 undefined 的答案', () => {
    expect(chatHubAnswerMessageText({ author: 'bot', text: 'answer' })).toBe('answer')
  })

  it('拒绝控制类 messageType（如 Progress/SearchQuery）', () => {
    expect(chatHubAnswerMessageText({ author: 'bot', messageType: 'Progress', text: 'x' })).toBe('')
    expect(chatHubAnswerMessageText({ author: 'bot', messageType: 'SearchQuery', text: 'x' })).toBe('')
  })

  it('拒绝非 bot 作者与空文本', () => {
    expect(chatHubAnswerMessageText({ author: 'user', messageType: 'Chat', text: 'x' })).toBe('')
    expect(chatHubAnswerMessageText({ author: 'bot', messageType: 'Chat', text: '' })).toBe('')
    expect(chatHubAnswerMessageText({ author: 'bot', messageType: 'Chat', text: 123 })).toBe('')
  })
})
