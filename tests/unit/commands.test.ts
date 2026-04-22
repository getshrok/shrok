import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildCommandRegistry, type SlashCommandContext, type UsageMode } from '../../src/head/commands.js'
import type { AppStateStore } from '../../src/db/app_state.js'
import type { Config } from '../../src/config.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    workspacePath: '/tmp/nowhere',
    visAgentWork: false,
    visHeadTools: false,
    visSystemEvents: false,
    visStewardRuns: false,
    visAgentPills: false,
    visMemoryRetrievals: false,
    usageFootersEnabled: false,
    // Minimal other fields used by commands handlers
    dbPath: '/tmp/nowhere.db',
    llmProvider: 'anthropic',
    contextWindowTokens: 100_000,
    memoryBudgetPercent: 45,
    ...overrides,
  } as Config
}

function makeCtx(overrides?: Partial<SlashCommandContext>): SlashCommandContext & { sent: string[] } {
  const sent: string[] = []
  // Minimal AppStateStore mock — only methods still used by SlashCommandContext paths
  const appState = {
    getLastActiveChannel: () => '',
    setLastActiveChannel: vi.fn(),
    tryAcquireArchivalLock: vi.fn().mockReturnValue(true),
    releaseArchivalLock: vi.fn(),
    getThresholds: vi.fn().mockReturnValue([]),
    getAllThresholdFiredAt: vi.fn().mockReturnValue({}),
  } as unknown as AppStateStore

  return {
    channel: 'test-channel',
    send: async (msg: string) => { sent.push(msg) },
    appState,
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
    config: makeFakeConfig(),
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
  let workspace: string

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-xray-'))
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function readCfg(): Record<string, unknown> {
    const p = path.join(workspace, 'config.json')
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  }

  it('toggles visAgentWork on when currently off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace }) })
    await registry.get('xray')!.handler('', ctx)
    expect(readCfg()['visAgentWork']).toBe(true)
    expect(ctx.sent[0]).toContain('on')
  })

  it('toggles visAgentWork off when currently on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace, visAgentWork: true }) })
    await registry.get('xray')!.handler('', ctx)
    expect(readCfg()['visAgentWork']).toBe(false)
    expect(ctx.sent[0]).toContain('off')
  })

  it('forces on with explicit "on" arg', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace }) })
    await registry.get('xray')!.handler('on', ctx)
    expect(readCfg()['visAgentWork']).toBe(true)
  })

  it('does not touch other visibility categories', async () => {
    const registry = buildCommandRegistry()
    // visHeadTools is only in ctx.config, not in the disk config.json
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace, visAgentWork: false }) })
    await registry.get('xray')!.handler('on', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentWork']).toBe(true)
    // Other keys were not written by xray
    expect(cfg['visHeadTools']).toBeUndefined()
    expect(cfg['visStewardRuns']).toBeUndefined()
  })
})

describe('~debug', () => {
  let workspace: string

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-debug-'))
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function readCfg(): Record<string, unknown> {
    const p = path.join(workspace, 'config.json')
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  }

  it('turns all 4 debug-relevant categories on when all are off', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace }) })
    await registry.get('debug')!.handler('', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentWork']).toBe(true)
    expect(cfg['visHeadTools']).toBe(true)
    expect(cfg['visSystemEvents']).toBe(true)
    expect(cfg['visStewardRuns']).toBe(true)
    expect(ctx.sent[0]).toContain('on')
  })

  it('does NOT touch visAgentPills', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace }) })
    await registry.get('debug')!.handler('on', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentPills']).toBeUndefined()
  })

  it('also preserves visAgentPills when turning off', async () => {
    const registry = buildCommandRegistry()
    // Pre-seed config.json with visAgentPills: true to simulate it being set separately
    fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ visAgentPills: true }), 'utf8')
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace, visAgentWork: true, visHeadTools: true, visAgentPills: true }) })
    await registry.get('debug')!.handler('off', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentWork']).toBe(false)
    expect(cfg['visHeadTools']).toBe(false)
    expect(cfg['visAgentPills']).toBe(true)  // untouched
  })

  it('toggles off when any debug-relevant category was on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace, visAgentWork: true }) })
    await registry.get('debug')!.handler('', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentWork']).toBe(false)
    expect(ctx.sent[0]).toContain('off')
  })

  it('forces on with explicit "on" arg', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace }) })
    await registry.get('debug')!.handler('on', ctx)
    expect(readCfg()['visAgentWork']).toBe(true)
  })

  it('forces off with explicit "off" arg even when already on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ workspacePath: workspace, visAgentWork: true, visHeadTools: true, visSystemEvents: true, visStewardRuns: true }) })
    await registry.get('debug')!.handler('off', ctx)
    const cfg = readCfg()
    expect(cfg['visAgentWork']).toBe(false)
    expect(cfg['visHeadTools']).toBe(false)
    expect(cfg['visSystemEvents']).toBe(false)
    expect(cfg['visStewardRuns']).toBe(false)
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
    const ctx = makeCtx({ config: makeFakeConfig({ visAgentWork: true, visHeadTools: true, visSystemEvents: true, visStewardRuns: true }) })
    await registry.get('status')!.handler('', ctx)
    expect(ctx.sent[0]).toContain('Debug mode:         on')
  })

  it('shows debug mode "partial" when only some debug-relevant categories are on', async () => {
    const registry = buildCommandRegistry()
    const ctx = makeCtx({ config: makeFakeConfig({ visAgentWork: true }) })
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
