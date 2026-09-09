import { describe, expect, it, vi } from 'vitest'
import { createUpstreamGateLifecycle } from './upstream-lifecycle'
import type { UpstreamGateReleaser, UpstreamGate } from './upstream-lifecycle'

describe('M365 upstream gate lifecycle', () => {
  it('acquires, attaches and releases upstream gates cleanly', async () => {
    const releaser: UpstreamGateReleaser = {
      releaseUpstream: vi.fn().mockResolvedValue(undefined),
    }
    const lifecycle = createUpstreamGateLifecycle(releaser)

    expect(lifecycle.begin()).toBe(true)
    const gate: UpstreamGate = { accountId: 'acc-1', leaseId: 'lease-1' }
    expect(lifecycle.attach(gate)).toBe(true)

    await lifecycle.release(gate)
    expect(releaser.releaseUpstream).toHaveBeenCalledWith('acc-1', 'lease-1')

    lifecycle.end()
  })

  it('handles cancellation and auto-releases active gate after unwinding', async () => {
    const releaser: UpstreamGateReleaser = {
      releaseUpstream: vi.fn().mockResolvedValue(undefined),
    }
    const lifecycle = createUpstreamGateLifecycle(releaser)

    expect(lifecycle.begin()).toBe(true)
    const gate: UpstreamGate = { accountId: 'acc-2', leaseId: 'lease-2' }
    expect(lifecycle.attach(gate)).toBe(true)

    // Trigger cancellation while operation is in progress
    const cancelPromise = lifecycle.cancel()

    // Unwind operation
    lifecycle.end()

    await cancelPromise
    expect(releaser.releaseUpstream).toHaveBeenCalledWith('acc-2', 'lease-2')

    // Subsequent begin calls should return false
    expect(lifecycle.begin()).toBe(false)
  })

  it('rejects gate attachment when cancelled prior to DO response', async () => {
    const releaser: UpstreamGateReleaser = {
      releaseUpstream: vi.fn().mockResolvedValue(undefined),
    }
    const lifecycle = createUpstreamGateLifecycle(releaser)

    expect(lifecycle.begin()).toBe(true)
    lifecycle.end()

    await lifecycle.cancel()

    const gate: UpstreamGate = { accountId: 'acc-3', leaseId: 'lease-3' }
    // Attach after cancel returns false and immediately triggers cleanup release
    expect(lifecycle.attach(gate)).toBe(false)
    expect(releaser.releaseUpstream).toHaveBeenCalledWith('acc-3', 'lease-3')
  })
})
