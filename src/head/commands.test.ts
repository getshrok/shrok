import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { buildCommandRegistry } from './commands.js'
import type { SlashCommandContext } from './commands.js'
import type { Config } from '../config.js'
import type { AppStateStore } from '../db/app_state.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    dashboardPasswordHash: '$2b$10$placeholder',
    ...overrides,
  } as unknown as Config
}

function makeCtx(
  config: Config,
  revokeDashboardSessions?: () => void,
): SlashCommandContext {
  const base = {
    channel: 'test-channel',
    send: vi.fn().mockResolvedValue(undefined),
    appState: {} as AppStateStore,
    usageModes: new Map(),
    stop: vi.fn(),
    restart: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
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
    retractAllAgents: vi.fn().mockResolvedValue(0),
    clearQueue: vi.fn(),
    clearStewardRuns: vi.fn(),
    clearReminders: vi.fn(),
    config,
    getTopicCount: vi.fn().mockResolvedValue(0),
    getDbStats: vi.fn().mockReturnValue({ messages: 0, agents: 0, schedules: 0, reminders: 0 }),
    getHeadContextStats: vi.fn().mockReturnValue({ messageCount: 0, tokens: 0, oldestCreatedAt: null, historyBudget: 0, archivalThreshold: 0 }),
    getMcpCapabilities: vi.fn().mockReturnValue([]),
    getSpendSummary: vi.fn().mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0 }),
  }

  if (revokeDashboardSessions !== undefined) {
    return { ...base, revokeDashboardSessions }
  }
  return base
}

// ─── ~changedashboardpassword tests ──────────────────────────────────────────

describe('~changedashboardpassword', () => {
  const registry = buildCommandRegistry()
  const command = registry.get('changedashboardpassword')!

  let tmpDir: string
  let envFile: string
  const originalEnvFile = process.env['SHROK_ENV_FILE']

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-test-'))
    envFile = path.join(tmpDir, '.env')
    process.env['SHROK_ENV_FILE'] = envFile
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalEnvFile === undefined) {
      delete process.env['SHROK_ENV_FILE']
    } else {
      process.env['SHROK_ENV_FILE'] = originalEnvFile
    }
  })

  it('calls revokeDashboardSessions on successful password change', async () => {
    const revoke = vi.fn()
    const config = makeConfig()
    const ctx = makeCtx(config, revoke)

    await command.handler('newpassword1 newpassword1', ctx)

    expect(revoke).toHaveBeenCalledOnce()
  })

  it('does NOT call revokeDashboardSessions when passwords do not match', async () => {
    const revoke = vi.fn()
    const config = makeConfig()
    const ctx = makeCtx(config, revoke)

    await command.handler('password1 password2', ctx)

    const sendMock = ctx.send as ReturnType<typeof vi.fn>
    expect(revoke).not.toHaveBeenCalled()
    expect(sendMock.mock.calls[0]?.[0]).toMatch(/do not match/i)
  })

  it('does NOT call revokeDashboardSessions when password is too short', async () => {
    const revoke = vi.fn()
    const config = makeConfig()
    const ctx = makeCtx(config, revoke)

    await command.handler('short short', ctx)

    const sendMock = ctx.send as ReturnType<typeof vi.fn>
    expect(revoke).not.toHaveBeenCalled()
    expect(sendMock.mock.calls[0]?.[0]).toMatch(/at least 8 characters/i)
  })

  it('does NOT call revokeDashboardSessions when too few args are given', async () => {
    const revoke = vi.fn()
    const config = makeConfig()
    const ctx = makeCtx(config, revoke)

    await command.handler('onlyonearg', ctx)

    const sendMock = ctx.send as ReturnType<typeof vi.fn>
    expect(revoke).not.toHaveBeenCalled()
    expect(sendMock.mock.calls[0]?.[0]).toMatch(/usage/i)
  })

  it('works when revokeDashboardSessions is undefined (no crash)', async () => {
    const config = makeConfig()
    const ctx = makeCtx(config)  // no revokeDashboardSessions — omitted entirely

    await expect(command.handler('mypassword mypassword', ctx)).resolves.not.toThrow()
  })

  it('updates config.dashboardPasswordHash after successful password change', async () => {
    const revoke = vi.fn()
    const config = makeConfig({ dashboardPasswordHash: 'old-hash' })
    const ctx = makeCtx(config, revoke)

    await command.handler('newpassword1 newpassword1', ctx)

    expect((ctx.config as Record<string, unknown>)['dashboardPasswordHash']).not.toBe('old-hash')
    expect(typeof (ctx.config as Record<string, unknown>)['dashboardPasswordHash']).toBe('string')
  })

  it('sends confirmation message mentioning session revocation', async () => {
    const revoke = vi.fn()
    const config = makeConfig()
    const ctx = makeCtx(config, revoke)

    await command.handler('mypassword mypassword', ctx)

    const sendMock = ctx.send as ReturnType<typeof vi.fn>
    const sent = sendMock.mock.calls[0]?.[0] as string
    expect(sent.toLowerCase()).toContain('revoked')
    expect(sent).toContain('password updated')
  })
})
