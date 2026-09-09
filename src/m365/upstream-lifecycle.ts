export interface UpstreamGate {
  accountId: string
  leaseId: string
}

export interface UpstreamGateReleaser {
  releaseUpstream(accountId: string, leaseId: string): Promise<void>
}

export interface UpstreamGateLifecycle {
  /** Register one exchange before it starts waiting for the account gate. */
  begin(): boolean
  /** Attach the gate returned by the Durable Object. False means cancellation won the race. */
  attach(gate: UpstreamGate): boolean
  /** Idempotently release a particular gate. */
  release(gate: UpstreamGate): Promise<void>
  /** Mark the registered exchange as fully unwound. */
  end(): void
  /** Abort future exchanges, release an active gate, and wait for in-flight acquisition to unwind. */
  cancel(): Promise<void>
}

/**
 * A cancelled request must not wait indefinitely for a broken upstream RPC.
 * This is only a cancellation fence: normal operations still wait for idle
 * before releasing, so a healthy runner cannot overlap a replacement turn.
 */
export const UPSTREAM_CANCEL_IDLE_TIMEOUT_MS = 5_000

function sameGate(left: UpstreamGate | undefined, right: UpstreamGate): boolean {
  return left?.accountId === right.accountId && left.leaseId === right.leaseId
}

/**
 * Owns the account-level gate for one downstream stream.
 *
 * Cancellation can race the Durable Object RPC that acquires a gate. Merely
 * releasing the gate that is visible at cancellation time is insufficient: the
 * RPC may return a lease one microtask later and leave it held for the full
 * stale-lease period. The begin/end fence makes cancel() wait until that race is
 * settled, while attach() tells the exchange to stop if cancellation won.
 */
export function createUpstreamGateLifecycle(state: UpstreamGateReleaser): UpstreamGateLifecycle {
  let active: UpstreamGate | undefined
  let cancelled = false
  let operations = 0
  let cancelPromise: Promise<void> | undefined
  const releases = new Map<string, Promise<void>>()
  const idleWaiters = new Set<() => void>()

  const keyFor = (gate: UpstreamGate): string => `${gate.accountId}\x00${gate.leaseId}`
  const idleWithDeadline = (): Promise<void> => {
    if (operations === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, UPSTREAM_CANCEL_IDLE_TIMEOUT_MS)
      idleWaiters.add(finish)
    })
  }

  const release = (gate: UpstreamGate): Promise<void> => {
    if (sameGate(active, gate)) active = undefined
    const key = keyFor(gate)
    const existing = releases.get(key)
    if (existing) return existing
    const pending = state.releaseUpstream(gate.accountId, gate.leaseId)
    releases.set(key, pending)
    return pending
  }

  return {
    begin(): boolean {
      if (cancelled) return false
      operations += 1
      return true
    },
    attach(gate: UpstreamGate): boolean {
      active = gate
      if (!cancelled) return true
      // Cancellation may win immediately before the acquire RPC resolves.
      // Release this exact lease even though the caller will not use it.
      void release(gate).catch(() => {
        console.error(JSON.stringify({ event: 'cancelled_upstream_gate_release_failed' }))
      })
      return false
    },
    release,
    end(): void {
      if (operations <= 0) return
      operations -= 1
      if (operations === 0) {
        for (const resolve of idleWaiters) resolve()
        idleWaiters.clear()
      }
    },
    cancel(): Promise<void> {
      if (cancelPromise) return cancelPromise
      cancelled = true
      cancelPromise = (async () => {
        // Do not make the account available while the aborted WebSocket/fetch
        // is still unwinding. Releasing first creates a window where a new
        // request can overlap the old upstream invocation on the same account.
        await idleWithDeadline()
        if (active) await release(active)
      })()
      return cancelPromise
    },
  }
}
