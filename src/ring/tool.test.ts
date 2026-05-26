// src/ring/tool.test.ts
// Tests for ring_device tool definition, agent factory, and module singletons.
// Also asserts HEAD_TOOLS + OPTIONAL_TOOLS membership (RING-03 dual-surface contract).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  RING_DEVICE_DEF,
  buildRingDeviceTool,
  initRingTool,
  executeRingDevice,
} from './tool.js'
import { HEAD_TOOLS } from '../head/index.js'
import { OPTIONAL_TOOL_NAMES } from '../sub-agents/registry.js'
import type { RingRunner } from './runner.js'
import type { AgentContext } from '../types/agent.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(headId = 'test-head'): AgentContext {
  return {
    agentId: 'agent-1',
    headId,
    suspend: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  }
}

function makeRunner() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    dispatchForHead: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as RingRunner
}

// ─── (a) Schema tests ─────────────────────────────────────────────────────────

describe('RING_DEVICE_DEF schema', () => {
  it('has name ring_device', () => {
    expect(RING_DEVICE_DEF.name).toBe('ring_device')
  })

  it('action enum is exactly ["start", "stop"]', () => {
    const props = RING_DEVICE_DEF.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(props['action']?.enum).toEqual(['start', 'stop'])
  })

  it('action is in required array', () => {
    expect(RING_DEVICE_DEF.inputSchema.required).toContain('action')
  })

  it('source is defined and optional (not in required)', () => {
    const props = RING_DEVICE_DEF.inputSchema.properties as Record<string, unknown>
    expect(props['source']).toBeDefined()
    expect(RING_DEVICE_DEF.inputSchema.required).not.toContain('source')
  })
})

// ─── (b) buildRingDeviceTool — no HA adapter ────────────────────────────────

describe('buildRingDeviceTool — no HA adapter', () => {
  it('returns ok+note and does NOT call runner.start/stop when adapter is null', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(null)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    const result = await entry.execute({ action: 'start' }, makeCtx('head-no-ha'))
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(parsed.note).toContain('no HA channel')
    expect(runner.start).not.toHaveBeenCalled()
    expect(runner.stop).not.toHaveBeenCalled()
  })

  it('passes ctx.headId to getHaAdapter', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(null)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    await entry.execute({ action: 'start' }, makeCtx('specific-head'))

    expect(getHaAdapter).toHaveBeenCalledWith('specific-head')
  })
})

// ─── (c) buildRingDeviceTool — with HA adapter ───────────────────────────────

describe('buildRingDeviceTool — with HA adapter', () => {
  const mockAdapter = { headId: 'ha-head', id: 'home-assistant' }

  it('calls runner.start with source "alarm" when source is "alarm"', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    const result = await entry.execute({ action: 'start', source: 'alarm' }, makeCtx('ha-head'))
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(parsed.note).toBeUndefined()
    expect(runner.start).toHaveBeenCalledWith(mockAdapter, 'alarm')
    expect(runner.stop).not.toHaveBeenCalled()
  })

  it('calls runner.start with source "timer" when source is "timer"', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    await entry.execute({ action: 'start', source: 'timer' }, makeCtx('ha-head'))

    expect(runner.start).toHaveBeenCalledWith(mockAdapter, 'timer')
  })

  it('calls runner.start with source "timer" as default when source is absent', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    await entry.execute({ action: 'start' }, makeCtx('ha-head'))

    expect(runner.start).toHaveBeenCalledWith(mockAdapter, 'timer')
  })

  it('calls runner.stop and NOT runner.start when action is "stop"', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    const entry = buildRingDeviceTool(runner, getHaAdapter)

    const result = await entry.execute({ action: 'stop' }, makeCtx('ha-head'))
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(runner.stop).toHaveBeenCalledWith(mockAdapter)
    expect(runner.start).not.toHaveBeenCalled()
  })
})

// ─── (d) executeRingDevice module-singleton ───────────────────────────────────
//
// Note: Vitest runs tests in order within a file. The pre-init test must run
// BEFORE initRingTool is called in subsequent tests. We use a fresh import
// path to ensure isolation — module-level state is shared within this file
// because Vitest uses one module instance per file by default.

describe('executeRingDevice — pre-init (before initRingTool)', () => {
  it('returns ring-not-configured no-op without throwing', async () => {
    // Module-level singletons are null at import time.
    // This test suite runs BEFORE initRingTool is called in the next suite.
    const result = await executeRingDevice({ action: 'start' }, makeCtx().headId)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(parsed.note).toBe('ring not configured')
  })
})

// ─── RING-03: dual-surface membership ────────────────────────────────────────

describe('RING-03: ring_device on both tool surfaces', () => {
  it('HEAD_TOOLS includes a tool named ring_device', () => {
    expect(HEAD_TOOLS.some(t => t.name === 'ring_device')).toBe(true)
  })

  it('OPTIONAL_TOOL_NAMES includes ring_device', () => {
    expect(OPTIONAL_TOOL_NAMES).toContain('ring_device')
  })
})

describe('executeRingDevice — after initRingTool', () => {
  const mockAdapter = { headId: 'init-head', id: 'home-assistant' }

  it('routes through singletons on no-HA path (getHaAdapter returns null)', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(null)
    initRingTool(runner, getHaAdapter)

    const result = await executeRingDevice({ action: 'start' }, makeCtx('init-test-head').headId)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(parsed.note).toContain('no HA channel')
    expect(getHaAdapter).toHaveBeenCalledWith('init-test-head')
  })

  it('dispatches start via runner when adapter is present', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    initRingTool(runner, getHaAdapter)

    const result = await executeRingDevice({ action: 'start', source: 'alarm' }, makeCtx('init-head').headId)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(runner.start).toHaveBeenCalledWith(mockAdapter, 'alarm')
  })

  it('dispatches stop via runner when adapter is present', async () => {
    const runner = makeRunner()
    const getHaAdapter = vi.fn().mockReturnValue(mockAdapter)
    initRingTool(runner, getHaAdapter)

    const result = await executeRingDevice({ action: 'stop' }, makeCtx('init-head').headId)
    const parsed = JSON.parse(result as string)

    expect(parsed.ok).toBe(true)
    expect(runner.stop).toHaveBeenCalledWith(mockAdapter)
  })
})
