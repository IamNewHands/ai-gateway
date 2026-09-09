export type AccountFailureKind = 'rate_limit' | 'auth' | 'transient' | 'permanent'

export interface AccountFailureDisposition {
  kind: AccountFailureKind
  mayFailOverBeforeVisibleOutput: boolean
}

/**
 * Classify only failures with a reliable account-level meaning.
 *
 * Unknown application, protocol, validation, and tool errors deliberately
 * return null: rotating on every exception would hide real bugs and expose
 * multiple healthy accounts to the same malformed request.
 */
export function classifyAccountFailure(cause: unknown): AccountFailureDisposition | null {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '')
  const upper = raw.toUpperCase()
  if (!upper || upper === 'REQUEST_ABORTED' || upper === 'ACCOUNT_QUEUE_TIMEOUT') return null

  if (
    /(?:^|[^0-9])429(?:[^0-9]|$)/u.test(upper)
    || upper.includes('TOO_MANY_REQUESTS')
    || upper.includes('TOOMANYREQUESTS')
    || upper === 'MICROSOFT_TOKEN_RATE_LIMITED'
    || upper === 'OFFICIAL_UPSTREAM_RATE_LIMITED'
    || upper.includes('RATE_LIMIT')
    || upper.includes('RATELIMIT')
    || upper.includes('THROTTL')
  ) {
    return { kind: 'rate_limit', mayFailOverBeforeVisibleOutput: true }
  }

  if (
    upper.startsWith('WS_DIAL_FAILED:401')
    || upper.startsWith('WS_DIAL_FAILED:403')
    || upper.includes('INVALID_GRANT')
    || upper.includes('UNAUTHORIZED')
    || upper.includes('FORBIDDEN')
    || upper === 'MICROSOFT_REFRESH_TOKEN_MISSING'
    || upper === 'MICROSOFT_REFRESH_TOKEN_REJECTED'
    || upper === 'MICROSOFT_TOKEN_EXCHANGE_FAILED'
    || upper === 'OFFICIAL_UPSTREAM_AUTH_ERROR'
  ) {
    return { kind: 'auth', mayFailOverBeforeVisibleOutput: true }
  }

  if (
    upper === 'RELAY_DIAL_ERROR'
    || upper.startsWith('RELAY_DIAL_FAILED:')
    || upper === 'ACCOUNT_RELAY_EGRESS_UNAVAILABLE'
    || upper === 'MICROSOFT_TOKEN_SERVICE_UNAVAILABLE'
    || upper === 'OFFICIAL_UPSTREAM_UNAVAILABLE'
    || upper === 'OFFICIAL_UPSTREAM_TIMEOUT'
    || upper === 'OFFICIAL_UPSTREAM_CONFLICT'
  ) {
    return { kind: 'transient', mayFailOverBeforeVisibleOutput: true }
  }

  if (
    upper === 'ACCOUNT_CREDENTIAL_MISSING'
    || upper === 'ACCOUNT_CREDENTIAL_CORRUPT'
    || upper === 'MICROSOFT_TOKEN_IDENTITY_MISSING'
  ) {
    return { kind: 'permanent', mayFailOverBeforeVisibleOutput: true }
  }

  if (
    upper === 'ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE'
    || upper === 'WS_DIAL_ERROR'
    || upper.startsWith('WS_DIAL_FAILED:408')
    || upper.startsWith('WS_DIAL_FAILED:425')
    || /^WS_DIAL_FAILED:5\d\d(?:\D|$)/u.test(upper)
    || upper.startsWith('WS_CLOSED_BEFORE_COMPLETION')
    || upper === 'WS_ERROR_BEFORE_COMPLETION'
    || upper === 'WS_READ_TIMEOUT'
    || upper.startsWith('CHAT_CLOSED_BEFORE_COMPLETION')
    || upper === 'CHAT_DEADLINE_EXCEEDED'
    || upper === 'CHAT_PROGRESS_TIMEOUT'
    || upper === 'CHAT_RETURNED_NO_CONTENT'
  ) {
    return { kind: 'transient', mayFailOverBeforeVisibleOutput: true }
  }

  if (
    (upper.startsWith('CHAT_COMPLETION_ERROR:') || upper.startsWith('CHAT_UPSTREAM_ERROR:'))
    && /(?:TEMPORAR|UNAVAILABLE|TIMEOUT|TIMED OUT|CONNECTION|RESET|TRY AGAIN|\b5\d\d\b)/u.test(upper)
  ) {
    return { kind: 'transient', mayFailOverBeforeVisibleOutput: true }
  }

  return null
}
