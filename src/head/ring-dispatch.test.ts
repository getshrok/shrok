// src/head/ring-dispatch.test.ts
//
// Phase 45 gap-fix regression test (caught by 45-VERIFICATION goal-backward audit).
//
// Asserts that HeadToolExecutor.dispatch('ring_device') actually reaches the
// RingRunner when a resolver is initialized — previously the head dispatch called
// runner.dispatchForHead WITHOUT the resolver, returning silent no-op for every
// alarm start and every voice dismiss. Both load-bearing paths were broken.
//
// The fix routes both head and sub-agent surfaces through the same module-singleton
// executeRingDevice (set by initRingTool at startup). This test exercises the head
// path end-to-end with a real (mocked) resolver returning an adapter.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HeadToolExecutor } from './index.js'
import { initRingTool } from '../ring/tool.js'
import type { RingRunner, RingAdapterLike } from '../ring/runner.js'

function makeRunner(): RingRunner {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    dispatchForHead: vi.fn(),
  } as unknown as RingRunner
}

function makeExecutor(): HeadToolExecutor {
  // Only the head opts that the ring_device dispatch case actually reads matter
  // here (headId). Other store options are cast through `unknown` for the rest of
  // the constructor surface; this test never invokes other dispatch cases.
  return new HeadToolExecutor({
    headId: 'voice-head',
  } as unknown as ConstructorParameters<typeof HeadToolExecutor>[0])
}

describe('Phase 45 gap-fix — HeadToolExecutor.ring_device reaches the runner', () => {
  beforeEach(() => {
    // Reset module singletons by re-initializing with fresh mocks each test.
    // initRingTool is idempotent and overwrites the prior runner/resolver.
  })

  it('start: head dispatch resolves the adapter and starts the runner (was silent no-op pre-fix)', async () => {
    const runner = makeRunner()
    const mockAdapter: RingAdapterLike = {
      headId: 'voice-head',
      id: 'home-assistant',
    } as unknown as RingAdapterLike
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    initRingTool(runner, getHaAdapter)

    const executor = makeExecutor()
    const result = await executor.execute({
      id: 't1',
      name: 'ring_device',
      input: { action: 'start', source: 'alarm' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed).toEqual({ ok: true })
    expect(getHaAdapter).toHaveBeenCalledWith('voice-head')
    expect(runner.start).toHaveBeenCalledWith(mockAdapter, 'alarm')
    expect(runner.stop).not.toHaveBeenCalled()
  })

  it('stop: head dispatch resolves the adapter and stops the runner (was silent no-op pre-fix)', async () => {
    const runner = makeRunner()
    const mockAdapter: RingAdapterLike = {
      headId: 'voice-head',
      id: 'home-assistant',
    } as unknown as RingAdapterLike
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    initRingTool(runner, getHaAdapter)

    const executor = makeExecutor()
    const result = await executor.execute({
      id: 't2',
      name: 'ring_device',
      input: { action: 'stop' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed).toEqual({ ok: true })
    expect(getHaAdapter).toHaveBeenCalledWith('voice-head')
    expect(runner.stop).toHaveBeenCalledWith(mockAdapter)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('non-HA head: returns ok no-op without touching the runner (RING-04)', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(null)
    initRingTool(runner, getHaAdapter)

    const executor = makeExecutor()
    const result = await executor.execute({
      id: 't3',
      name: 'ring_device',
      input: { action: 'start' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed.ok).toBe(true)
    expect(parsed.note).toContain('no HA channel')
    expect(getHaAdapter).toHaveBeenCalledWith('voice-head')
    expect(runner.start).not.toHaveBeenCalled()
    expect(runner.stop).not.toHaveBeenCalled()
  })
})
