import { describe, it, expect, vi } from 'vitest'
import { buildCommandRegistry, type SlashCommandContext, type UsageMode } from '../../src/head/commands.js'
import type { AppStateStore, ConversationVisibility } from '../../src/db/app_state.js'

// ─── Context factory ──────────────────────────────────────────────────────────

function makeAppState(initial?: Partial<ConversationVisibility>): AppStateStore {
  let vis: ConversationVisibility = {
    agentWork: false,
    headTools: false,
    systemEvents: false,
    stewardRuns: false,
    agentPills: false,
    memoryRetrievals: false,
    ...initial,
  }
  return {
    getConversationVisibility: () => vis,
    setConversationVisibility: (v: ConversationVisibility) => { vis = v },
    // Unused in these tests, but present on the real store
    getLastActiveChannel: () => '',
    setLastActiveChannel: vi.fn(),
    tryAcquireArchivalLock: vi.fn().mockReturnValue(true),
    releaseArchivalLock: vi.fn(),
    getUsageFootersEnabled: () => false,
    setUsageFootersEnabled: vi.fn(),
  } as unknown as AppStateStore
}

function makeCtx(overrides?: Partial<SlashCommandContext>): SlashCommandContext & { sent: string[] } {
  const sent: string[] = []
  return {
    channel: 'test-channel',
    send: async (msg: string) => { sent.push(msg) },
    appState: makeAppState(),
    usageModes: new Map(),
    stop: vi.fn(),
    restart: vi.fn(),
    getStatus: () => ({
      uptimeSeconds: 0,
      estimatedSpendToday: 0,
      blockingThresholds: 0,
      activeAgents: 0,
      runningAgents: 0,
      suspendedAgents: 0,
    }),
    forceArchive: vi.fn().mockResolvedValue(0),
    clearHistory: vi.fn(),
    clearAgents: vi.fn(),
    clearQueue: vi.fn(),
    clearStewardRuns: vi.fn(),
    clearReminders: vi.fn(),
    config: {} as SlashCommandContext['config'],
    getTopicCount: vi.fn().mockResolvedValue(0),
    getDbStats: vi.fn().mockReturnValue({ messages: 0, agents: 0, schedules: 0, reminders: 0 }),
    getMcpCapabilities: vi.fn().mockReturnValue([]),
    getSpendSummary: vi.fn().mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0 }),
    ...overrides,
    get sent() { return sent },
  } as SlashCommandContext & { sent: string[] }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildCommandRegistry', () => {
  it('returns a Map containing all expected command names', () => {
    const registry = buildCommandRegistry()
    expect(registry.has('help')).toBe(true)
    expect(registry.has('status')).toBe(true)
    expect(registry.has('debug')).toBe(true)
    expect(registry.has('xray')).toBe(true)
    expect(registry.has('usage')).toBe(true)
    expect(registry.has('stop')).toBe(true)
    expect(registry.has('restart')).toBe(true)
    expect(registry.has('resetthedatabaseimsupersureandnotmakingamistake')).toBe(true)
  })
})

describe('~help', () => {
  it('sends a message listing all command names', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('help')!.handler('', ctx)
    expect(ctx.sent.length).toBe(1)
    expect(ctx.sent[0]).toContain('~debug')
    expect(ctx.sent[0]).toContain('~status')
    expect(ctx.sent[0]).toContain('~usage')
    expect(ctx.sent[0]).toContain('~stop')
  })
})

describe('~xray', () => {
  it('toggles agentWork on when off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('xray')!.handler('', ctx)
    expect(ctx.appState.getConversationVisibility().agentWork).toBe(true)
    expect(ctx.sent[0]).toContain('on')
  })

  it('toggles agentWork off when on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true }) })
    await registry.get('xray')!.handler('', ctx)
    expect(ctx.appState.getConversationVisibility().agentWork).toBe(false)
    expect(ctx.sent[0]).toContain('off')
  })

  it('forces on with explicit "on" arg', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('xray')!.handler('on', ctx)
    expect(ctx.appState.getConversationVisibility().agentWork).toBe(true)
  })

  it('does not touch other visibility categories', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ headTools: true, stewardRuns: true }) })
    await registry.get('xray')!.handler('on', ctx)
    const v = ctx.appState.getConversationVisibility()
    expect(v.agentWork).toBe(true)
    expect(v.headTools).toBe(true)
    expect(v.stewardRuns).toBe(true)
  })
})

describe('~debug', () => {
  it('turns all 4 debug-relevant categories on when all are off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('debug')!.handler('', ctx)
    const v = ctx.appState.getConversationVisibility()
    expect(v.agentWork).toBe(true)
    expect(v.headTools).toBe(true)
    expect(v.systemEvents).toBe(true)
    expect(v.stewardRuns).toBe(true)
    expect(ctx.sent[0]).toContain('on')
  })

  it('does NOT touch agentPills', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('debug')!.handler('on', ctx)
    expect(ctx.appState.getConversationVisibility().agentPills).toBe(false)
  })

  it('also preserves agentPills when turning off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true, headTools: true, agentPills: true }) })
    await registry.get('debug')!.handler('off', ctx)
    const v = ctx.appState.getConversationVisibility()
    expect(v.agentWork).toBe(false)
    expect(v.headTools).toBe(false)
    expect(v.agentPills).toBe(true)  // untouched
  })

  it('toggles off when any debug-relevant category was on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true }) })
    await registry.get('debug')!.handler('', ctx)
    const v = ctx.appState.getConversationVisibility()
    expect(v.agentWork).toBe(false)
    expect(ctx.sent[0]).toContain('off')
  })

  it('forces on with explicit "on" arg', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('debug')!.handler('on', ctx)
    expect(ctx.appState.getConversationVisibility().agentWork).toBe(true)
  })

  it('forces off with explicit "off" arg even when already on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true, headTools: true, systemEvents: true, stewardRuns: true }) })
    await registry.get('debug')!.handler('off', ctx)
    const v = ctx.appState.getConversationVisibility()
    expect(v.agentWork).toBe(false)
    expect(v.headTools).toBe(false)
    expect(v.systemEvents).toBe(false)
    expect(v.stewardRuns).toBe(false)
  })
})

describe('~usage', () => {
  it('sets usage mode to tokens', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('usage')!.handler('tokens', ctx)
    expect(ctx.usageModes.get('test-channel')).toBe('tokens')
    expect(ctx.sent[0]).toContain('tokens')
  })

  it('sets usage mode to cost', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('usage')!.handler('cost', ctx)
    expect(ctx.usageModes.get('test-channel')).toBe('cost')
  })

  it('sets usage mode to full', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('usage')!.handler('full', ctx)
    expect(ctx.usageModes.get('test-channel')).toBe('full')
  })

  it('deletes usage mode when set to off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    ctx.usageModes.set('test-channel', 'full')
    await registry.get('usage')!.handler('off', ctx)
    expect(ctx.usageModes.has('test-channel')).toBe(false)
  })

  it('reports current mode when called with no args', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    ctx.usageModes.set('test-channel', 'cost' as UsageMode)
    await registry.get('usage')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('cost')
  })

  it('sends error message for invalid mode', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('usage')!.handler('invalid', ctx)
    expect(ctx.sent[0]).toContain('Unknown mode')
    expect(ctx.usageModes.has('test-channel')).toBe(false)
  })
})

describe('~status', () => {
  it('formats uptime in hours and minutes when >= 1 hour', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({
      getStatus: () => ({
        uptimeSeconds: 7262, // 2h 1m 2s
        estimatedSpendToday: 1.23,
        blockingThresholds: 0,
        activeAgents: 3,
        runningAgents: 0,
        suspendedAgents: 0,
      }),
    })
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('2h 1m')
    expect(ctx.sent[0]).toContain('$1.23')
    expect(ctx.sent[0]).toContain('3')
  })

  it('formats uptime in minutes only when < 1 hour', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({
      getStatus: () => ({
        uptimeSeconds: 542, // 9 minutes
        estimatedSpendToday: 0,
        blockingThresholds: 0,
        activeAgents: 0,
        runningAgents: 0,
        suspendedAgents: 0,
      }),
    })
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('9m')
    expect(ctx.sent[0]).not.toMatch(/\dh/)
  })

  it('shows debug mode "on" when all 4 debug-relevant categories are on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true, headTools: true, systemEvents: true, stewardRuns: true }) })
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('Debug mode:         on')
  })

  it('shows debug mode "partial" when only some debug-relevant categories are on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ appState: makeAppState({ agentWork: true }) })
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('Debug mode:         partial')
  })

  it('shows debug mode "off" when all debug-relevant categories are off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('Debug mode:         off')
  })
})

describe('~stop', () => {
  it('calls ctx.stop()', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('stop')!.handler('', ctx)
    expect(ctx.stop).toHaveBeenCalledOnce()
    expect(ctx.sent[0]).toContain('Shutting down')
  })
})

describe('~restart', () => {
  it('calls ctx.restart()', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('restart')!.handler('', ctx)
    expect(ctx.restart).toHaveBeenCalledOnce()
  })
})

describe('~resetthedatabaseimsupersureandnotmakingamistake', () => {
  it('calls clearHistory and confirms', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx()
    await registry.get('resetthedatabaseimsupersureandnotmakingamistake')!.handler('', ctx)
    expect(ctx.clearHistory).toHaveBeenCalledOnce()
    expect(ctx.sent[0]).toContain('cleared')
  })
})
