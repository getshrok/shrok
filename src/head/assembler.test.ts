import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ContextAssemblerImpl } from './assembler.js'
import {
  setMemoryPromptsWorkspaceDir,
  __resetMemoryPromptsWorkspaceDirForTests,
  MEMORY_PROMPTS_DIR,
} from '../memory/prompts.js'
import type { Memory, RetrieveResult } from '../memory/index.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { Config } from '../config.js'
import type { QueueEvent } from '../types/core.js'
import type { Schedule, ScheduleStore } from '../db/schedules.js'

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

function makeMinimalConfig(): Config {
  return {
    llmProvider: 'anthropic',
    llmProviderPriority: ['anthropic'],
    anthropicApiKey: '',
    anthropicModelSmart: 'claude-sonnet-4-6',
    anthropicModelFast: 'claude-haiku-3-5',
    geminiApiKey: '',
    geminiModelSmart: 'gemini-3-flash-preview',
    geminiModelFast: 'gemini-3-flash-preview',
    openaiApiKey: '',
    openaiModelSmart: 'gpt-5.4',
    openaiModelFast: 'gpt-5.4',
    contextWindowTokens: 100_000,
    llmMaxTokens: 4096,
    memoryBudgetPercent: 40,
    memoryQueryContextTokens: 0,
    memoryRetrievalModel: 'dumb',
    workspacePath: os.tmpdir(),
    timezone: 'UTC',
    maxConcurrentAgents: 4,
    agentTimeoutMs: 60_000,
    enableVoice: false,
    voiceProvider: 'elevenlabs',
    elevenLabsApiKey: '',
    elevenLabsVoiceId: '',
    openaiTtsVoice: 'alloy',
    openaiTtsModel: 'tts-1',
    deepgramApiKey: '',
    sttProvider: 'deepgram',
    discord: false,
    discordToken: '',
    discordChannelId: '',
    telegram: false,
    telegramBotToken: '',
    slack: false,
    slackBotToken: '',
    slackAppToken: '',
    whatsapp: false,
    whatsappPhoneId: '',
    whatsappToken: '',
    zohoCliq: false,
    zohoCliqToken: '',
    zohoCliqBotName: '',
    port: 3000,
    logLevel: 'info',
    stewardModel: 'dumb',
    proactiveWorkspaceDir: '',
    stewardsWorkspaceDir: '',
    memoryPromptsWorkspaceDir: '',
    enableMemory: true,
    memoryPath: '',
    archivalFraction: 0.3,
    archivalWindowTokens: 50_000,
    agentHistoryEnabled: false,
    agentHistoryTokenBudget: 0,
  } as unknown as Config
}

function makeIdentityLoader(): IdentityLoader {
  return {
    loadSystemPrompt: () => 'System prompt',
  } as unknown as IdentityLoader
}

function makeMessageStore(): MessageStore {
  return {
    getRecent: () => [],
    getRecentTextByTokens: () => [],
    append: () => {},
    deleteByIds: () => {},
  } as unknown as MessageStore
}

function makeAgentStore(): AgentStore {
  return {
    get: () => null,
  } as unknown as AgentStore
}

function makeSkillLoader(): SkillLoader {
  return {
    load: () => null,
    listAll: () => [],
  } as unknown as SkillLoader
}

function makeMcpRegistry(): McpRegistry {
  return {
    listCapabilities: () => [],
    loadTools: async () => [],
  } as unknown as McpRegistry
}

function makeScheduleTrigger(): QueueEvent {
  return {
    id: 'evt-1',
    type: 'schedule_trigger',
    taskName: 'test-task',
    createdAt: new Date().toISOString(),
    priority: 10,
  } as unknown as QueueEvent
}

function makeMockMemory(retrieveSpy: (args: unknown[]) => void): Memory {
  return {
    chunk: async () => {},
    getTopics: async () => [],
    retrieve: async (...args: unknown[]) => {
      retrieveSpy(args)
      return [] as RetrieveResult[]
    },
    retrieveByEntity: async () => [],
    retrieveByIds: async () => [],
    compact: async () => {},
    deleteTopic: async () => {},
  } as unknown as Memory
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssemblerImpl + loadMemoryPromptOverrides wiring', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-test-'))
    setMemoryPromptsWorkspaceDir(tmpDir)
  })

  afterEach(() => {
    __resetMemoryPromptsWorkspaceDirForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retrieve receives prompts from loadMemoryPromptOverrides when workspace router file exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ROUTER.md'), 'WS-ROUTER')

    let capturedArgs: unknown[] = []
    const topicMemory = makeMockMemory(args => { capturedArgs = args })

    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      () => new Date('2026-01-01T00:00:00Z'),
      topicMemory,
      // no router — schedule_trigger bypasses rewriteQueryForRetrieval
    )

    await assembler.assemble(makeScheduleTrigger())

    // retrieve should have been called
    expect(capturedArgs.length).toBe(3)
    const promptsArg = capturedArgs[2] as { router?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(promptsArg?.router).toBe('WS-ROUTER')
  })

  it('retrieve receives loaded defaults when no workspace overrides exist', async () => {
    // No workspace MEMORY-*.md files — loader reads shipped defaults
    const shippedRouter = fs.readFileSync(
      path.join(MEMORY_PROMPTS_DIR, 'MEMORY-ROUTER.md'),
      'utf8',
    ).trim()

    let capturedArgs: unknown[] = []
    const topicMemory = makeMockMemory(args => { capturedArgs = args })

    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      () => new Date('2026-01-01T00:00:00Z'),
      topicMemory,
    )

    await assembler.assemble(makeScheduleTrigger())

    expect(capturedArgs.length).toBe(3)
    const promptsArg = capturedArgs[2] as { router?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(promptsArg?.router).toBe(shippedRouter)
  })
})

// ─── Issue #12: per-head customPrompt + head-aware history ───────────────────

describe('ContextAssemblerImpl — customPrompt + headId (issue #12)', () => {
  // (a) customPrompt 'Be terse.' → systemPrompt contains header AND text, and
  //     the header index < 'Current time:' index (inside cached prefix).
  it('(a) injects Head-Specific Instructions header before Current time when customPrompt is set', async () => {
    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      undefined, // getNow
      undefined, // topicMemory
      undefined, // router
      'default', // headId
      'Be terse.', // customPrompt
    )

    const { systemPrompt } = await assembler.assemble(makeScheduleTrigger())

    expect(systemPrompt).toContain('## Head-Specific Instructions')
    expect(systemPrompt).toContain('Be terse.')

    const headerIdx = systemPrompt.indexOf('## Head-Specific Instructions')
    const currentTimeIdx = systemPrompt.indexOf('Current time:')
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(currentTimeIdx).toBeGreaterThanOrEqual(0)
    expect(headerIdx).toBeLessThan(currentTimeIdx)
  })

  // (b) no customPrompt → no header injected; whitespace-only → still no header.
  it('(b) does NOT inject header when customPrompt is undefined', async () => {
    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
    )

    const { systemPrompt } = await assembler.assemble(makeScheduleTrigger())
    expect(systemPrompt).not.toContain('## Head-Specific Instructions')
  })

  it('(b) does NOT inject header when customPrompt is whitespace-only', async () => {
    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      undefined, // getNow
      undefined, // topicMemory
      undefined, // router
      'default', // headId
      '   ',     // whitespace-only customPrompt
    )

    const { systemPrompt } = await assembler.assemble(makeScheduleTrigger())
    expect(systemPrompt).not.toContain('## Head-Specific Instructions')
  })

  // (c) headId 'work' → getRecent/getRecentTextByTokens both receive 'work', not 'default'.
  it('(c) uses this.headId (not hardcoded "default") for getRecent', async () => {
    const recentCalls: string[] = []
    const messageStore: MessageStore = {
      getRecent: (headId: string) => { recentCalls.push(headId); return [] },
      getRecentTextByTokens: () => [],
      append: () => {},
      deleteByIds: () => {},
    } as unknown as MessageStore

    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      messageStore,
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      undefined, // getNow
      undefined, // topicMemory
      undefined, // router
      'work',    // headId — the bug fix
    )

    await assembler.assemble(makeScheduleTrigger())

    expect(recentCalls.length).toBeGreaterThan(0)
    expect(recentCalls.every(id => id === 'work')).toBe(true)
  })
})

// ─── Scheduled reminders & tasks awareness block ──────────────────────────────

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  const now = new Date('2026-06-17T12:00:00Z').toISOString()
  return {
    id: 'sched_1',
    headId: 'default',
    taskName: 'email',
    kind: 'task',
    cron: null,
    runAt: null,
    enabled: true,
    lastRun: null,
    nextRun: null,
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: null,
    cronTimezone: null,
    requiresAck: false,
    nagIntervalMinutes: null,
    ackPending: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeScheduleStore(items: Schedule[]): ScheduleStore {
  return {
    list: (filter?: { headId?: string }) =>
      filter?.headId !== undefined ? items.filter(s => s.headId === filter.headId) : items,
  } as unknown as ScheduleStore
}

function makeAssemblerWithSchedules(items: Schedule[], headId = 'default'): ContextAssemblerImpl {
  return new ContextAssemblerImpl(
    makeIdentityLoader(),
    makeMessageStore(),
    makeAgentStore(),
    makeSkillLoader(),
    makeMinimalConfig(),
    makeMcpRegistry(),
    () => new Date('2026-06-17T12:00:00Z'), // getNow
    undefined, // topicMemory
    undefined, // router
    headId,
    undefined, // customPrompt
    makeScheduleStore(items),
  )
}

describe('ContextAssemblerImpl — scheduled reminders & tasks awareness block', () => {
  it('renders the block AFTER "Current time:" (dynamic region) with one line per item', async () => {
    const items = [
      makeSchedule({ id: 'a', kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: 'call the bank' }),
      makeSchedule({ id: 'b', kind: 'task', taskName: 'backup-photos', cron: '0 2 * * *', nextRun: '2026-06-18T02:00:00Z' }),
    ]
    const { systemPrompt } = await makeAssemblerWithSchedules(items).assemble(makeScheduleTrigger())

    expect(systemPrompt).toContain('## Scheduled reminders & tasks (this head)')
    expect(systemPrompt).toContain('- Reminder · today 17:30 — call the bank')
    expect(systemPrompt).toContain('- Task · daily 02:00, next tomorrow — backup-photos')

    const blockIdx = systemPrompt.indexOf('## Scheduled reminders & tasks')
    const currentTimeIdx = systemPrompt.indexOf('Current time:')
    expect(currentTimeIdx).toBeGreaterThanOrEqual(0)
    expect(blockIdx).toBeGreaterThan(currentTimeIdx)
  })

  it('sorts by next fire (soonest first)', async () => {
    const items = [
      makeSchedule({ id: 'late', kind: 'task', taskName: 'late', cron: '0 2 * * *', nextRun: '2026-06-20T02:00:00Z' }),
      makeSchedule({ id: 'soon', kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: 'soon' }),
    ]
    const { systemPrompt } = await makeAssemblerWithSchedules(items).assemble(makeScheduleTrigger())
    expect(systemPrompt.indexOf('— soon')).toBeLessThan(systemPrompt.indexOf('— late'))
  })

  it('excludes disabled schedules and those without a nextRun', async () => {
    const items = [
      makeSchedule({ id: 'off', kind: 'reminder', enabled: false, nextRun: '2026-06-18T09:00:00Z', agentContext: 'disabled one' }),
      makeSchedule({ id: 'nonext', kind: 'reminder', enabled: true, nextRun: null, agentContext: 'no next run' }),
      makeSchedule({ id: 'live', kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: 'live one' }),
    ]
    const { systemPrompt } = await makeAssemblerWithSchedules(items).assemble(makeScheduleTrigger())
    expect(systemPrompt).toContain('live one')
    expect(systemPrompt).not.toContain('disabled one')
    expect(systemPrompt).not.toContain('no next run')
  })

  it('only lists schedules owned by this head', async () => {
    const items = [
      makeSchedule({ id: 'mine', headId: 'work', kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: 'mine' }),
      makeSchedule({ id: 'theirs', headId: 'default', kind: 'reminder', runAt: '2026-06-17T18:00:00Z', nextRun: '2026-06-17T18:00:00Z', agentContext: 'theirs' }),
    ]
    const { systemPrompt } = await makeAssemblerWithSchedules(items, 'work').assemble(makeScheduleTrigger())
    expect(systemPrompt).toContain('mine')
    expect(systemPrompt).not.toContain('theirs')
  })

  it('omits the block entirely when there are no eligible items', async () => {
    const { systemPrompt } = await makeAssemblerWithSchedules([]).assemble(makeScheduleTrigger())
    expect(systemPrompt).not.toContain('## Scheduled reminders & tasks')
  })

  it('omits the block when no schedule store is wired (back-compat)', async () => {
    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
    )
    const { systemPrompt } = await assembler.assemble(makeScheduleTrigger())
    expect(systemPrompt).not.toContain('## Scheduled reminders & tasks')
  })
})
