import { describe, expect, it } from 'vitest'
import { chatHubAllowedMessageTypes, chatPayload } from './chathub'

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
