import { describe, it, expect } from 'vitest'
import { isRetryableChatConnectError } from './chathub'

describe('isRetryableChatConnectError（pre-submit 有界重连的分类器，同 B mayRetryUnseenChatHubFailure）', () => {
  it('瞬时传输故障 → 可重连', () => {
    expect(isRetryableChatConnectError(new Error('WS_DIAL_ERROR'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('ws dial failed: HTTP 502 bad gateway'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('WS_HANDSHAKE_INVALID'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('WS_HANDSHAKE_EMPTY'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('WS_HANDSHAKE_UNEXPECTED_FRAME'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('timeout waiting handshake (15000ms)'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('ws closed: code=1006 reason='))).toBe(true)
    expect(isRetryableChatConnectError(new Error('ws error'))).toBe(true)
    expect(isRetryableChatConnectError(new Error('ws already closed'))).toBe(true)
  })

  it('语义失败（鉴权/限流/内容策略/超时类）→ 不重连', () => {
    expect(isRetryableChatConnectError(new Error('upstream rate-limit notice'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('chathub completion error: code="ErrorUserThrottled"'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('WS_HANDSHAKE_FAILED'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('request aborted by client'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('upstream content policy flagged as offensive'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('chathub response deadline exceeded before completion'))).toBe(false)
    expect(isRetryableChatConnectError(new Error('CHAT_PROGRESS_TIMEOUT'))).toBe(false)
  })

  it('非 Error 与空消息不误判', () => {
    expect(isRetryableChatConnectError(undefined)).toBe(false)
    expect(isRetryableChatConnectError(null)).toBe(false)
    expect(isRetryableChatConnectError('WS_DIAL_ERROR')).toBe(false)
    expect(isRetryableChatConnectError(new Error(''))).toBe(false)
  })
})
