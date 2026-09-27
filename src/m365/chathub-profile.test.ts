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

// ===== optionsSets 对齐真实浏览器流量（§4.2 拼写漂移修复）=====

/** HAR har1#364 SEND 真实 flight 串（docs/har-mining/02-hidden-endpoints.md:100-106，33 项） */
const HAR_OPTION_SETS = [
  'cwc_flux_image',
  'cwc_code_interpreter',
  'cwcfluxgptv',
  'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch',
  'gptvnorm2048',
  'cwc_fileupload_odb',
  'update_memory_plugin',
  'add_custom_instructions',
  'cwc_flux_v3',
  'flux_v3_progress_messages',
  'enable_batch_token_processing',
  'enable_gg_gpt',
  'flux_v3_references',
  'flux_v3_references_entities',
  'flux_v3_references_ci',
  'add_filestore_filetype',
  'flux_v3_image_gen_enable_dimensions',
  'flux_v3_image_gen_enable_non_watermarked_storage',
  'flux_v3_image_gen_enable_icon_dimensions',
  'flux_v3_image_gen_enable_system_text_with_params',
  'flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts',
  'flux_v3_image_gen_enable_story',
  'code_interpreter_interactive_charts',
  'rich_responses',
]

function optionsSetsOf(profile?: 'answer' | 'router'): string[] {
  const wire = chatPayload({ text: 'hi', sessionId: 's1', conversationId: 'c1', messageProfile: profile }, 'req-1')
  const invocation = JSON.parse(wire.split('\u001e')[0])
  return invocation.arguments[0].optionsSets as string[]
}

describe('optionsSets 对齐 HAR 真实流量', () => {
  it('包含 HAR 真实串的每一项（拼写漂移修复：不再是自造的 image-gen-dimensions-*）', () => {
    const actual = optionsSetsOf('answer')
    for (const flag of HAR_OPTION_SETS) {
      expect(actual, `missing ${flag}`).toContain(flag)
    }
  })

  it('图片尺寸 flight 用真实拼写 flux_v3_image_gen_enable_dimensions', () => {
    const actual = optionsSetsOf('answer')
    expect(actual).toContain('flux_v3_image_gen_enable_dimensions')
    expect(actual).toContain('flux_v3_image_gen_enable_non_watermarked_storage')
    expect(actual).toContain('flux_v3_image_gen_enable_icon_dimensions')
  })

  it('代码解释器系列按真实拼写齐备', () => {
    const actual = optionsSetsOf('answer')
    for (const flag of [
      'cwc_code_interpreter',
      'cwc_code_interpreter_amsfix',
      'cwc_code_interpreter_citation_fix',
      'cwc_code_interpreter_citation_sourceannotations',
      'code_interpreter_interactive_charts',
      'cwc_code_interpreter_interactive_charts_inline_image',
      'code_interpreter_matplotlib_patching',
      'cdxcwc_code_interpreter_hallucinated_url_filter',
    ]) {
      expect(actual, `missing ${flag}`).toContain(flag)
    }
  })

  it('update_memory_plugin / add_custom_instructions 紧跟 cwc_fileupload_odb（§6.3 顺序要求）', () => {
    const actual = optionsSetsOf('answer')
    const uploadIdx = actual.indexOf('cwc_fileupload_odb')
    expect(actual[uploadIdx + 1]).toBe('update_memory_plugin')
    expect(actual[uploadIdx + 2]).toBe('add_custom_instructions')
    expect(actual.indexOf('cwc_flux_v3')).toBeGreaterThan(uploadIdx)
  })

  it('真实串项排在自造项之前（自造项保留但不干扰指纹顺序）', () => {
    const actual = optionsSetsOf('answer')
    const lastReal = Math.max(...HAR_OPTION_SETS.map((f) => actual.indexOf(f)))
    const firstExtra = Math.min(...['image-gen-dimensions-1024x1024', 'cwc_code_interpreter_v3', 'code-interpreter']
      .map((f) => actual.indexOf(f)).filter((i) => i >= 0))
    expect(firstExtra).toBeGreaterThan(lastReal)
  })

  it('router/compact profile 同样携带完整 optionsSets（不因 profile 丢 flight）', () => {
    expect(optionsSetsOf('router')).toEqual(optionsSetsOf('answer'))
  })
})
