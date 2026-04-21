import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ActivationLoop } from './activation.js'
import { FileSystemKindLoader } from '../skills/loader.js'
import { UnifiedLoader } from '../skills/unified.js'
import type { QueueEvent } from '../types/core.js'
import type { Injector } from './injector.js'
import type { ContextAssembler } from './assembler.js'
import type { AgentRunner } from '../types/agent.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { QueueStore } from '../db/queue.js'
import type { AppStateStore } from '../db/app_state.js'
import type { UsageStore } from '../db/usage.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { ChannelRouter } from '../types/channel.js'
import type { LLMRouter } from '../types/llm.js'
import type { Memory } from '../memory/index.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { Config } from '../config.js'
import type { SkillLoader } from '../types/skill.js'

// Mock the proactive steward — we want deterministic decisions in dispatch tests.
import * as proactive from '../scheduler/proactive.js'
vi.mock('../scheduler/proactive.js', async () => {
  const actual = await vi.importActual<typeof import('../scheduler/proactive.js')>('../scheduler/proactive.js')
  return {
    ...actual,
    runProactiveDecision: vi.fn(),
    runReminderDecision: vi.fn(),
  }
})

interface Fixture {
  loop: ActivationLoop
  agentRunner: AgentRunner
  injector: Injector
  scheduleStore: ScheduleStore
  tmpDir: string
}

function makeFixture(opts: { proactiveEnabled?: boolean; decision?: { action: 'fire' | 'skip'; reason: string; context?: string } } = {}): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-test-'))
  const skillsDir = path.join(tmpDir, 'skills')
  const tasksDir = path.join(tmpDir, 'tasks')
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.mkdirSync(tasksDir, { recursive: true })

  // foo skill
  const fooDir = path.join(skillsDir, 'foo')
  fs.mkdirSync(fooDir)
  fs.writeFileSync(
    path.join(fooDir, 'SKILL.md'),
    '---\nname: foo\ndescription: Foo skill\nmodel: claude-haiku-4-5\n---\nDo foo things.',
  )

  // bar task
  const barDir = path.join(tasksDir, 'bar')
  fs.mkdirSync(barDir)
  fs.writeFileSync(
    path.join(barDir, 'TASK.md'),
    '---\nname: bar\ndescription: Bar task\nmodel: claude-opus-4-6\n---\nVacuum the database now.',
  )

  const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
  const tasksLoader = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
  const unifiedLoader = new UnifiedLoader(skillsLoader, tasksLoader)

  const agentRunner = {
    spawn: vi.fn().mockResolvedValue('agent_1'),
    update: vi.fn().mockResolvedValue(undefined),
    signal: vi.fn().mockResolvedValue(undefined),
    retract: vi.fn().mockResolvedValue(undefined),
    checkStatus: vi.fn().mockResolvedValue({ text: '', stale: false }),
    awaitAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRunner

  const injector = {
    injectAgentEvent: vi.fn(),
    injectWebhookEvent: vi.fn(),
  } as unknown as Injector

  const scheduleStore = {
    get: vi.fn().mockReturnValue({ id: 's1', cron: '*/5 * * * *', lastRun: null, lastSkipped: null, lastSkipReason: null }),
    update: vi.fn(),
    markSkipped: vi.fn(),
    count: vi.fn().mockReturnValue(0),
  } as unknown as ScheduleStore

  const messages = {
    getRecent: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    append: vi.fn(),
    findTextByAgentId: vi.fn().mockReturnValue(null),
    updateTextContent: vi.fn(),
    getSince: vi.fn().mockReturnValue([]),
    getRecentBefore: vi.fn().mockReturnValue([]),
    replaceWithSummary: vi.fn(),
  } as unknown as MessageStore

  const config = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.8,
    timezone: 'UTC',
    proactiveEnabled: opts.proactiveEnabled ?? false,
    proactiveShadow: false,
    stewardModel: 'claude-haiku-4-5',
  } as unknown as Config

  // Default proactive decision: fire (no skip).
  const decision = opts.decision ?? { action: 'fire' as const, reason: 'ok' }
  vi.mocked(proactive.runProactiveDecision).mockResolvedValue(decision as any)

  const llmRouter = { complete: vi.fn() } as unknown as LLMRouter
  const channelRouter = { send: vi.fn(), sendTyping: vi.fn(), getFirstChannel: vi.fn().mockReturnValue('discord') } as unknown as ChannelRouter
  const assembler = { assemble: vi.fn() } as unknown as ContextAssembler
  const queueStore = {
    claimNext: vi.fn().mockReturnValue(null),
    enqueue: vi.fn(),
    ack: vi.fn(), fail: vi.fn(), release: vi.fn(),
    claimAllPendingBackground: vi.fn().mockReturnValue([]),
    claimAllPendingUserMessages: vi.fn().mockReturnValue([]),
  } as unknown as QueueStore
  const appState = {
    getThresholds: vi.fn().mockReturnValue([]),
    getLastActiveChannel: vi.fn().mockReturnValue('discord'),
    setLastActiveChannel: vi.fn(),
    tryAcquireArchivalLock: vi.fn().mockReturnValue(false),
    releaseArchivalLock: vi.fn(),
    getConversationVisibility: vi.fn().mockReturnValue({}),
    getAllThresholdFiredAt: vi.fn().mockReturnValue({}),
  } as unknown as AppStateStore
  const usageStore = { record: vi.fn(), getCostSince: vi.fn().mockReturnValue(0), getBySource: vi.fn().mockReturnValue([]), summarize: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 }) } as unknown as UsageStore
  const topicMemory = { chunk: vi.fn(), retrieve: vi.fn().mockResolvedValue([]) } as unknown as Memory
  const agentStore = { get: vi.fn(), getActive: vi.fn().mockReturnValue([]) } as unknown as AgentStore
  const mcpRegistry = { listCapabilities: vi.fn().mockReturnValue([]), loadTools: vi.fn().mockResolvedValue([]) } as unknown as McpRegistry
  const identityLoader = {
    loadSystemPrompt: vi.fn().mockReturnValue(''),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
  }

  const skillLoaderForTools = {
    load: (name: string) => skillsLoader.load(name),
    listAll: () => skillsLoader.listAll(),
    write: vi.fn(),
    delete: vi.fn(),
    watch: vi.fn(),
  } as unknown as SkillLoader

  const loop = new ActivationLoop({
    queueStore,
    messages,
    appState,
    usageStore,
    topicMemory,
    agentStore,
    llmRouter,
    channelRouter,
    assembler,
    injector,
    scheduleStore,
    mcpRegistry,
    toolExecutorOpts: {
      agentRunner,
      skillLoader: skillLoaderForTools,
      unifiedLoader,
      topicMemory,
      usageStore,
      identityDir: tmpDir,
      identityLoader: identityLoader as any,
      messages,
    },
    config,
    transaction: (fn) => fn(),
    pollIntervalMs: 0,
  })

  return { loop, agentRunner, injector, scheduleStore, tmpDir }
}

function jobEvent(skillName: string, kind: 'skill' | 'task' | 'reminder' = 'task'): QueueEvent & { type: 'schedule_trigger' } {
  return { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', skillName, kind, createdAt: new Date().toISOString() }
}

// We invoke handleScheduleTrigger via the private member; the loop machinery
// (claimNext / handleEvent / drain) is exercised by head.test.ts already.
async function fire(loop: ActivationLoop, event: QueueEvent & { type: 'schedule_trigger' }): Promise<void> {
  await (loop as unknown as { handleScheduleTrigger: (e: typeof event) => Promise<void> })
    .handleScheduleTrigger(event)
}

describe('handleScheduleTrigger — kind-aware dispatch', () => {
  let fix: Fixture

  afterEach(() => {
    if (fix?.tmpDir) fs.rmSync(fix.tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('task: spawns with body-as-prompt and skillName=<task name> (D-15, DISPATCH-02, ATTR-01)', async () => {
    // tasks carry skillName so downstream attribution works — the agents.skill_name
    // row persists the task name so by-source usage aggregation can bucket
    // scheduled task spend under its own name instead of folding into manual_agents.
    fix = makeFixture()
    await fire(fix.loop, jobEvent('bar', 'task'))

    expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
    const args = vi.mocked(fix.agentRunner.spawn).mock.calls[0]![0] as any
    expect(args.prompt).toBe('Vacuum the database now.')
    expect(args.skillName).toBe('bar')
    expect(args.trigger).toBe('scheduled')
    expect(args.model).toBe('claude-opus-4-6')
  })

  it("legacy kind='skill' trigger: dropped with warn, no spawn, no injector (tasks-only, 260414-112)", async () => {
    fix = makeFixture()
    await fire(fix.loop, jobEvent('foo', 'skill'))
    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
  })

  it("legacy kind='skill' trigger for a name that is actually a task: still dropped", async () => {
    fix = makeFixture()
    await fire(fix.loop, jobEvent('bar', 'skill'))
    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
  })

  it("kind='task' for a name that only exists as a skill: logs and skips spawn", async () => {
    fix = makeFixture()
    await fire(fix.loop, jobEvent('foo', 'task'))
    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
  })

  it('unknown target: logs and skips spawn', async () => {
    fix = makeFixture()
    await fire(fix.loop, jobEvent('does-not-exist', 'task'))
    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
  })

  it('proactive steward runs for tasks too (D-13 uniform treatment) — skip path fires markSkipped', async () => {
    fix = makeFixture({ proactiveEnabled: true, decision: { action: 'skip', reason: 'too soon' } })
    await fire(fix.loop, jobEvent('bar', 'task'))

    expect(fix.scheduleStore.markSkipped).toHaveBeenCalledOnce()
    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
  })

})

// Direct tests for injectEvent — the private dispatcher that threads the
// work-summary override from handleEvent into injector.injectAgentEvent.
// We exercise it via `loop as any` like `handleScheduleTrigger` is above.
describe('injectEvent — append-only override threading', () => {
  let fix: Fixture

  afterEach(() => {
    if (fix?.tmpDir) fs.rmSync(fix.tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('agent_completed: forwards workSummaryOverride to injector.injectAgentEvent', () => {
    fix = makeFixture()
    const event: QueueEvent = {
      type: 'agent_completed', id: 'e1', agentId: 'ag_1', output: 'done',
      createdAt: new Date().toISOString(),
    }
    ;(fix.loop as unknown as { injectEvent: (e: QueueEvent, o?: string) => void })
      .injectEvent(event, 'SUMMARY_TEXT')
    expect(fix.injector.injectAgentEvent).toHaveBeenCalledOnce()
    const call = vi.mocked(fix.injector.injectAgentEvent).mock.calls[0]!
    expect(call[0]).toBe(event)
    expect(call[1]).toBe('SUMMARY_TEXT')
  })

  it('agent_question: ignores override (only agent_completed forwards it)', () => {
    fix = makeFixture()
    const event: QueueEvent = {
      type: 'agent_question', id: 'e1', agentId: 'ag_1', question: 'help?',
      createdAt: new Date().toISOString(),
    }
    ;(fix.loop as unknown as { injectEvent: (e: QueueEvent, o?: string) => void })
      .injectEvent(event, 'IGNORED')
    expect(fix.injector.injectAgentEvent).toHaveBeenCalledOnce()
    const call = vi.mocked(fix.injector.injectAgentEvent).mock.calls[0]!
    expect(call[0]).toBe(event)
    // 2nd arg is intentionally omitted for non-completed events.
    expect(call[1]).toBeUndefined()
  })
})

