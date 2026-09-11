import { describe, it, expect } from 'vitest'
import {
  CHAT_HUB_PAYLOAD_LIMITS,
  BoundedPayloadError,
  assertBoundedPayload,
  boundedPayloadMetadata,
  boundedPayloadDiagnostic,
  ChatHubAttemptError,
  mayReconnectChatHubFailure,
  preserveChatHubSubmissionHistory,
  chatHubInvocationWasSubmitted,
  isTerminalEmptyQuotaFailure,
} from './chathub'

describe('CHAT_HUB_PAYLOAD_LIMITS：五类负载上限', () => {
  it('五项常量与源一致', () => {
    expect(CHAT_HUB_PAYLOAD_LIMITS).toEqual({
      frameCharacters: 1_500_000,
      frameRecords: 16_384,
      outputCharacters: 2_000_000,
      queuedSocketCharacters: 2_000_000,
      upstreamImageURLCharacters: 6 * 1024 * 1024,
    })
  })

  it('冻结对象不可改写', () => {
    expect(Object.isFrozen(CHAT_HUB_PAYLOAD_LIMITS)).toBe(true)
  })
})

describe('assertBoundedPayload：有界负载断言', () => {
  it('未超限不抛错', () => {
    expect(() => assertBoundedPayload('CHAT_OUTPUT_TOO_LARGE', 100, 100, 'streamed_text')).not.toThrow()
  })

  it('超限抛出携带数值边界的 BoundedPayloadError', () => {
    try {
      assertBoundedPayload('WS_FRAME_TOO_LARGE', 2_000_000, 1_500_000, 'websocket_frame')
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(BoundedPayloadError)
      const err = e as BoundedPayloadError
      expect(err.subtype).toBe('WS_FRAME_TOO_LARGE')
      expect(err.observed).toBe(2_000_000)
      expect(err.limit).toBe(1_500_000)
      expect(err.phase).toBe('websocket_frame')
    }
  })
})

describe('boundedPayloadMetadata / boundedPayloadDiagnostic：隐私安全诊断', () => {
  it('从 BoundedPayloadError 提取数值边界', () => {
    const err = new BoundedPayloadError('CHAT_IMAGE_OUTPUT_TOO_LARGE', 7, 6, 'image_output')
    expect(boundedPayloadMetadata(err)).toEqual({ subtype: 'CHAT_IMAGE_OUTPUT_TOO_LARGE', observed: 7, limit: 6, phase: 'image_output' })
  })

  it('非体积错误返回 null', () => {
    expect(boundedPayloadMetadata(new Error('boom'))).toBeNull()
    expect(boundedPayloadDiagnostic({})).toBeNull()
  })

  it('诊断事件只含机器标签与数值，不含负载文本', () => {
    const err = new BoundedPayloadError('WS_BUFFER_TOO_LARGE', 10, 5, 'websocket_queue')
    const diag = boundedPayloadDiagnostic(err)
    expect(diag).toEqual({
      event: 'chathub_bounded_payload_rejected',
      subtype: 'WS_BUFFER_TOO_LARGE',
      phase: 'websocket_queue',
      observed_characters: 10,
      limit_characters: 5,
    })
  })

  it('跨 ChatHubAttemptError 包装保留体积元数据', () => {
    const inner = new BoundedPayloadError('CHAT_OUTPUT_TOO_LARGE', 3, 2, 'completion_message')
    const wrapped = new ChatHubAttemptError(inner, false)
    expect(boundedPayloadMetadata(wrapped)).toEqual({ subtype: 'CHAT_OUTPUT_TOO_LARGE', observed: 3, limit: 2, phase: 'completion_message' })
  })
})

describe('mayReconnectChatHubFailure：pre-submit 有界重连判定（适配目标消息词表）', () => {
  it('已提交 → 一律拒绝重连', () => {
    expect(mayReconnectChatHubFailure(new Error('ws dial failed: HTTP 502'), true)).toBe(false)
  })

  it('未提交的传输类故障 → 允许重连', () => {
    expect(mayReconnectChatHubFailure(new Error('ws dial failed: HTTP 502'), false)).toBe(true)
    expect(mayReconnectChatHubFailure(new Error('WS_DIAL_ERROR'), false)).toBe(true)
    expect(mayReconnectChatHubFailure(new Error('WS_HANDSHAKE_INVALID'), false)).toBe(true)
    expect(mayReconnectChatHubFailure(new Error('WS_HANDSHAKE_EMPTY'), false)).toBe(true)
    expect(mayReconnectChatHubFailure(new Error('timeout waiting handshake'), false)).toBe(true)
    expect(mayReconnectChatHubFailure(new Error('ws closed'), false)).toBe(true)
  })

  it('未提交的语义失败 → 拒绝重连', () => {
    expect(mayReconnectChatHubFailure(new Error('upstream rate-limit notice'), false)).toBe(false)
    expect(mayReconnectChatHubFailure(new Error('CHAT_PROGRESS_TIMEOUT'), false)).toBe(false)
  })

  it('string cause（构造兼容）也能正确分类', () => {
    expect(mayReconnectChatHubFailure('ws dial failed: HTTP 503', false)).toBe(true)
    expect(mayReconnectChatHubFailure('upstream rate-limit notice', false)).toBe(false)
  })
})

describe('ChatHubAttemptError：terminalEmptyQuota 与 reconnectSafe 语义', () => {
  it('默认非终态空配额', () => {
    const err = new ChatHubAttemptError('ws dial failed: HTTP 502', false)
    expect(err.terminalEmptyQuota).toBe(false)
    expect(err.invocationSubmitted).toBe(false)
    expect(err.reconnectSafe).toBe(true)
    expect(isTerminalEmptyQuotaFailure(err)).toBe(false)
  })

  it('显式终态空配额', () => {
    const err = new ChatHubAttemptError('CHAT_THROTTLED_QUOTA_EXHAUSTED', true, true)
    expect(err.terminalEmptyQuota).toBe(true)
    expect(isTerminalEmptyQuotaFailure(err)).toBe(true)
  })
})

describe('preserveChatHubSubmissionHistory：跨重试保留"已提交"事实', () => {
  it('首次未提交 → 原样返回', () => {
    const err = new Error('ws dial failed: HTTP 502')
    expect(preserveChatHubSubmissionHistory(err, false)).toBe(err)
  })

  it('首次已提交、二次失败 → 包成 invocationSubmitted=true（不可抹除）', () => {
    const second = new Error('ws dial failed: HTTP 502')
    const merged = preserveChatHubSubmissionHistory(second, true)
    expect(merged).toBeInstanceOf(ChatHubAttemptError)
    expect(chatHubInvocationWasSubmitted(merged)).toBe(true)
  })

  it('已是已提交的 ChatHubAttemptError → 保持不变', () => {
    const first = new ChatHubAttemptError('ws closed', true)
    expect(preserveChatHubSubmissionHistory(first, true)).toBe(first)
  })

  it('保留终态空配额标记', () => {
    const first = new ChatHubAttemptError('CHAT_THROTTLED_QUOTA_EXHAUSTED', true, true)
    const merged = preserveChatHubSubmissionHistory(new Error('x'), true) as ChatHubAttemptError
    expect(isTerminalEmptyQuotaFailure(first)).toBe(true)
    // 二次失败本身没有终态标记时，不臆造（与源语义一致：仅保留既有事实）
    expect(merged.terminalEmptyQuota).toBe(false)
  })
})

describe('chatHubInvocationWasSubmitted', () => {
  it('仅对已提交的 ChatHubAttemptError 为真', () => {
    expect(chatHubInvocationWasSubmitted(new ChatHubAttemptError('x', true))).toBe(true)
    expect(chatHubInvocationWasSubmitted(new ChatHubAttemptError('x', false))).toBe(false)
    expect(chatHubInvocationWasSubmitted(new Error('x'))).toBe(false)
    expect(chatHubInvocationWasSubmitted(undefined)).toBe(false)
  })
})
