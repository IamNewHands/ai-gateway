import { describe, expect, it } from 'vitest'
import { classifyAccountFailure } from './account-routing'

describe('M365 account failure classification', () => {
  it('classifies rate limit errors with failover eligibility', () => {
    expect(classifyAccountFailure('429 Too Many Requests')).toEqual({
      kind: 'rate_limit',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure(new Error('MICROSOFT_TOKEN_RATE_LIMITED'))).toEqual({
      kind: 'rate_limit',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('Upstream throttled by server')).toEqual({
      kind: 'rate_limit',
      mayFailOverBeforeVisibleOutput: true,
    })
  })

  it('classifies authentication errors correctly', () => {
    expect(classifyAccountFailure('WS_DIAL_FAILED:401 Unauthorized')).toEqual({
      kind: 'auth',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('invalid_grant: Refresh token expired')).toEqual({
      kind: 'auth',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('MICROSOFT_REFRESH_TOKEN_REJECTED')).toEqual({
      kind: 'auth',
      mayFailOverBeforeVisibleOutput: true,
    })
  })

  it('classifies transient network and service errors', () => {
    expect(classifyAccountFailure('WS_DIAL_FAILED:503 Service Unavailable')).toEqual({
      kind: 'transient',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('WS_READ_TIMEOUT')).toEqual({
      kind: 'transient',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('CHAT_DEADLINE_EXCEEDED')).toEqual({
      kind: 'transient',
      mayFailOverBeforeVisibleOutput: true,
    })
  })

  it('classifies permanent credential errors', () => {
    expect(classifyAccountFailure('ACCOUNT_CREDENTIAL_MISSING')).toEqual({
      kind: 'permanent',
      mayFailOverBeforeVisibleOutput: true,
    })
    expect(classifyAccountFailure('MICROSOFT_TOKEN_IDENTITY_MISSING')).toEqual({
      kind: 'permanent',
      mayFailOverBeforeVisibleOutput: true,
    })
  })

  it('returns null for generic / non-account errors to avoid rotating healthy accounts', () => {
    expect(classifyAccountFailure('REQUEST_ABORTED')).toBeNull()
    expect(classifyAccountFailure('ACCOUNT_QUEUE_TIMEOUT')).toBeNull()
    expect(classifyAccountFailure('invalid json schema in tool')).toBeNull()
    expect(classifyAccountFailure(null)).toBeNull()
    expect(classifyAccountFailure(undefined)).toBeNull()
  })
})
