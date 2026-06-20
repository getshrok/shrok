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
    runSensorDispatchDecision: vi.fn(),
  }
})

// Phase 48 SENSOR-11 — hoisted mock for scanAmbient sentinel test
import * as scanModule from '../sensors/scan.js'
vi.mock('../sensors/scan.js', () => ({
  scanAmbient: vi.fn(() => '## SENTINEL-AMBIENT\nsentinel-body'),
}))

interface Fixture {
  loop: ActivationLoop
  agentRunner: AgentRunner
  injector: Injector
  scheduleStore: ScheduleStore
  tmpDir: string
  queueStore: QueueStore
  appState: AppStateStore
  resolveCurrentHeads: ReturnType<typeof vi.fn>
}

function makeFixture(opts: {
  proactiveEnabled?: boolean
  decision?: { action: 'fire' | 'skip'; reason: string; context?: string }
  conditions?: string | null
  kind?: 'task' | 'reminder'
  agentContext?: string
  /** Phase 35: override the appState.getLastActiveChannel return value. Default 'discord'. Pass null to exercise the D-07 fallback path. */
  lastActiveChannel?: string | null
  /** Phase 35 D-08: override the resolveCurrentHeads callback. Default returns []. */
  resolveCurrentHeads?: () => Array<{ id: string; channels: Array<{ id: string }> }>
  /** Phase 38: ack-required reminder fields */
  requiresAck?: boolean
  nagIntervalMinutes?: number | null
  ackPending?: boolean
} = {}): Fixture {
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

  const scheduleKind = opts.kind ?? 'task'
  const scheduleRow = scheduleKind === 'reminder'
    ? {
        id: 's1',
        headId: 'default',
        cron: null,
        runAt: '2099-01-01T00:00:00Z',
        lastRun: null,
        lastSkipped: null,
        lastSkipReason: null,
        conditions: opts.conditions ?? null,
        agentContext: opts.agentContext ?? '',
        taskName: null,
        kind: 'reminder' as const,
        enabled: true,
        cronTimezone: null,
        requiresAck: opts.requiresAck ?? false,
        nagIntervalMinutes: opts.nagIntervalMinutes ?? null,
        ackPending: opts.ackPending ?? false,
      }
    : {
        id: 's1',
        cron: '*/5 * * * *',
        lastRun: null,
        lastSkipped: null,
        lastSkipReason: null,
        conditions: opts.conditions ?? null,
        agentContext: null,
        taskName: 'bar',
        kind: 'task' as const,
        enabled: true,
      }

  const scheduleStore = {
    get: vi.fn().mockReturnValue(scheduleRow),
    update: vi.fn(),
    markSkipped: vi.fn(),
    delete: vi.fn(),
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
    getRecentTextByTokens: vi.fn().mockReturnValue([]),
  } as unknown as MessageStore

  const config = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.8,
    timezone: 'UTC',
    proactiveEnabled: opts.proactiveEnabled ?? false,
    proactiveShadow: false,
    stewardModel: 'claude-haiku-4-5',
    workspacePath: tmpDir,  // Phase 48: needed so scanAmbient call site is reached
  } as unknown as Config

  // Default proactive decision: fire (no skip).
  const decision = opts.decision ?? { action: 'fire' as const, reason: 'ok' }
  vi.mocked(proactive.runProactiveDecision).mockResolvedValue(decision as any)
  vi.mocked(proactive.runSensorDispatchDecision).mockResolvedValue({ action: 'run', reason: 'ok' } as any)

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
  const lastActive = opts.lastActiveChannel === undefined ? 'discord' : opts.lastActiveChannel
  const appState = {
    getThresholds: vi.fn().mockReturnValue([]),
    getLastActiveChannel: vi.fn().mockReturnValue(lastActive),
    setLastActiveChannel: vi.fn(),
    tryAcquireArchivalLock: vi.fn().mockReturnValue(false),
    releaseArchivalLock: vi.fn(),
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

  const resolveCurrentHeads = vi.fn(opts.resolveCurrentHeads ?? (() => []))

  const loop = new ActivationLoop({
    headId: 'default',
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
      headId: 'default',                                // Phase 34: test fixture single-head
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
    resolveCurrentHeads,
  })

  return { loop, agentRunner, injector, scheduleStore, tmpDir, queueStore, appState, resolveCurrentHeads }
}

function jobEvent(taskName: string | null, kind: 'task' | 'reminder' = 'task'): QueueEvent & { type: 'schedule_trigger' } {
  return { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName, kind, createdAt: new Date().toISOString() }
}

function reminderEvent(): QueueEvent & { type: 'schedule_trigger' } {
  return { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName: null, kind: 'reminder', createdAt: new Date().toISOString() }
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
    expect(args.task).toBe('Vacuum the database now.')
    expect(args.skillName).toBe('bar')
    expect(args.trigger).toBe('scheduled')
    expect(args.model).toBe('claude-opus-4-6')
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

  it('task: threads schedule.conditions into ProactiveContext (C-02, D-04)', async () => {
    fix = makeFixture({ proactiveEnabled: true, conditions: 'Weekdays only' })
    await fire(fix.loop, jobEvent('bar', 'task'))
    const ctx = vi.mocked(proactive.runProactiveDecision).mock.calls[0]![0]
    expect(ctx.conditions).toBe('Weekdays only')
  })

  it('task: null conditions resolves to undefined in ProactiveContext', async () => {
    fix = makeFixture({ proactiveEnabled: true, conditions: null })
    await fire(fix.loop, jobEvent('bar', 'task'))
    const ctx = vi.mocked(proactive.runProactiveDecision).mock.calls[0]![0]
    expect(ctx.conditions).toBeUndefined()
  })

  it('reminder: threads schedule.conditions into ReminderDecisionContext (C-03, D-06)', async () => {
    fix = makeFixture({
      proactiveEnabled: true,
      kind: 'reminder',
      agentContext: 'Check the build',
      conditions: "Only while I'm home",
    })
    vi.mocked(proactive.runReminderDecision).mockResolvedValue({ action: 'inject', reason: 'ok' } as any)
    await fire(fix.loop, jobEvent(null, 'reminder'))
    const ctx = vi.mocked(proactive.runReminderDecision).mock.calls[0]![0]
    expect(ctx.conditions).toBe("Only while I'm home")
  })

  it('reminder: null conditions resolves to undefined in ReminderDecisionContext', async () => {
    fix = makeFixture({
      proactiveEnabled: true,
      kind: 'reminder',
      agentContext: 'Check the build',
      conditions: null,
    })
    vi.mocked(proactive.runReminderDecision).mockResolvedValue({ action: 'inject', reason: 'ok' } as any)
    await fire(fix.loop, jobEvent(null, 'reminder'))
    const ctx = vi.mocked(proactive.runReminderDecision).mock.calls[0]![0]
    expect(ctx.conditions).toBeUndefined()
  })

  // Phase 38 — ack-required reminder semantics (ACK-07, ACK-08, D-05, D-10, D-12)

  it('requiresAck reminder: steward NOT called even when proactiveEnabled=true (D-10 / Test A)', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Take meds',
      proactiveEnabled: true,
      requiresAck: true,
      nagIntervalMinutes: 60,
      ackPending: false,
    })
    await fire(fix.loop, reminderEvent())

    // D-10: steward must not be called — every ack-required fire always delivers
    expect(proactive.runReminderDecision).not.toHaveBeenCalled()
  })

  it('requiresAck reminder: scheduleStore.update called with ackPending:true; delete NOT called (D-05 / Test B)', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Take meds',
      requiresAck: true,
      nagIntervalMinutes: 60,
      ackPending: false,
    })
    await fire(fix.loop, reminderEvent())

    // D-05: ackPending set before enqueue
    expect(fix.scheduleStore.update).toHaveBeenCalledWith('s1', expect.objectContaining({ ackPending: true }))
    // One-time row must NOT be deleted — must survive to keep nagging
    expect(fix.scheduleStore.delete).not.toHaveBeenCalled()
  })

  it('requiresAck reminder: enqueued text contains requires-ack="true" and reminderId="s1" (ACK-07 / D-12 / Test C)', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Take meds',
      requiresAck: true,
      nagIntervalMinutes: 60,
      ackPending: false,
    })
    await fire(fix.loop, reminderEvent())

    const enqueueArgs = vi.mocked(fix.queueStore.enqueue).mock.calls[0]?.[0] as any
    expect(enqueueArgs).toBeDefined()
    expect(enqueueArgs.text).toContain('requires-ack="true"')
    expect(enqueueArgs.text).toContain('reminderId="s1"')
    expect(enqueueArgs.text).toContain('acknowledge_reminder')
  })

  it('ordinary reminder (requiresAck=false): enqueued text does NOT contain requires-ack= attr (regression / Test D)', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'normal reminder',
      requiresAck: false,
    })
    await fire(fix.loop, reminderEvent())

    const enqueueArgs = vi.mocked(fix.queueStore.enqueue).mock.calls[0]?.[0] as any
    expect(enqueueArgs).toBeDefined()
    expect(enqueueArgs.text).not.toContain('requires-ack=')
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

// ─── Phase 35 D-07: reminder fire first-channel fallback ─────────────────────

describe('handleScheduleTrigger reminder branch — D-07 fallback', () => {
  let fix: Fixture

  afterEach(() => {
    if (fix?.tmpDir) fs.rmSync(fix.tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function reminderEvent(): QueueEvent & { type: 'schedule_trigger' } {
    return { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName: null, kind: 'reminder', createdAt: new Date().toISOString() }
  }

  it('Test A — happy path (D-06 unchanged): last_active_channel returns a channel, enqueue uses it, resolveCurrentHeads NOT called', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Check the build',
      lastActiveChannel: 'tg_a',
      resolveCurrentHeads: () => [{ id: 'default', channels: [{ id: 'should_not_be_used' }] }],
    })
    await fire(fix.loop, reminderEvent())
    expect(fix.queueStore.enqueue).toHaveBeenCalledOnce()
    const enqueueArgs = vi.mocked(fix.queueStore.enqueue).mock.calls[0]!
    const enqueuedEvent = enqueueArgs[0] as { type: string; channel?: string }
    expect(enqueuedEvent.type).toBe('user_message')
    expect(enqueuedEvent.channel).toBe('tg_a')
    expect(fix.resolveCurrentHeads).not.toHaveBeenCalled()
  })

  it('Test B — fallback fires (D-07 new): last_active is null, falls back to head.channels[0].id', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Check the build',
      lastActiveChannel: null,
      resolveCurrentHeads: () => [{ id: 'default', channels: [{ id: 'tg_b' }, { id: 'tg_c' }] }],
    })
    await fire(fix.loop, reminderEvent())
    expect(fix.queueStore.enqueue).toHaveBeenCalledOnce()
    const enqueueArgs = vi.mocked(fix.queueStore.enqueue).mock.calls[0]!
    const enqueuedEvent = enqueueArgs[0] as { type: string; channel?: string }
    expect(enqueuedEvent.type).toBe('user_message')
    expect(enqueuedEvent.channel).toBe('tg_b')
    expect(fix.resolveCurrentHeads).toHaveBeenCalled()
  })

  it('Test C — skip+log (D-07 edge): last_active null AND head has zero channels, no enqueue, one-time reminder deleted', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Check the build',
      lastActiveChannel: null,
      resolveCurrentHeads: () => [{ id: 'default', channels: [] }],
    })
    await fire(fix.loop, reminderEvent())
    expect(fix.queueStore.enqueue).not.toHaveBeenCalled()
    expect(fix.scheduleStore.delete).toHaveBeenCalledWith('s1')
  })

  it('Test D — head not found (defensive): last_active null AND resolveCurrentHeads returns no matching head, same skip+log behavior', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Check the build',
      lastActiveChannel: null,
      resolveCurrentHeads: () => [],
    })
    await fire(fix.loop, reminderEvent())
    expect(fix.queueStore.enqueue).not.toHaveBeenCalled()
    expect(fix.scheduleStore.delete).toHaveBeenCalledWith('s1')
  })

  it('Test E — WR-01: one-time requiresAck reminder is NOT deleted on channel outage (must survive to keep nagging)', async () => {
    fix = makeFixture({
      kind: 'reminder',
      agentContext: 'Take your medication',
      requiresAck: true,
      lastActiveChannel: null,
      resolveCurrentHeads: () => [{ id: 'default', channels: [] }],
    })
    await fire(fix.loop, reminderEvent())
    // No channel → cannot deliver this tick, but an ack-required reminder must NOT be
    // discarded; the scheduler already re-armed nextRun and it re-nags next tick.
    expect(fix.queueStore.enqueue).not.toHaveBeenCalled()
    expect(fix.scheduleStore.delete).not.toHaveBeenCalled()
  })
})

// ─── Phase 48 SENSOR-11: scanAmbient sentinel reaches ambientContext at both proactive call sites ──

describe('handleScheduleTrigger — scanAmbient sentinel reaches ambientContext (SENSOR-11 / D-12)', () => {
  let fix: Fixture

  afterEach(() => {
    if (fix?.tmpDir) fs.rmSync(fix.tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('REMINDER branch: mocked scanAmbient sentinel reaches ambientContext field of ReminderDecisionContext', async () => {
    vi.mocked(scanModule.scanAmbient).mockReturnValue('## SENTINEL-AMBIENT\nsentinel-body')
    vi.mocked(proactive.runReminderDecision).mockResolvedValue({ action: 'inject', reason: 'ok' } as any)

    fix = makeFixture({
      proactiveEnabled: true,
      kind: 'reminder',
      agentContext: 'test reminder',
    })
    await fire(fix.loop, { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName: null, kind: 'reminder', createdAt: new Date().toISOString() })

    expect(proactive.runReminderDecision).toHaveBeenCalledOnce()
    const ctx = vi.mocked(proactive.runReminderDecision).mock.calls[0]![0]
    expect(ctx.ambientContext).toBe('## SENTINEL-AMBIENT\nsentinel-body')
  })

  it('TASK branch: mocked scanAmbient sentinel reaches ambientContext field of ProactiveContext', async () => {
    vi.mocked(scanModule.scanAmbient).mockReturnValue('## SENTINEL-AMBIENT\nsentinel-body')
    vi.mocked(proactive.runProactiveDecision).mockResolvedValue({ action: 'run', reason: 'ok' } as any)

    fix = makeFixture({
      proactiveEnabled: true,
      kind: 'task',
    })
    await fire(fix.loop, { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName: 'bar', kind: 'task', createdAt: new Date().toISOString() })

    expect(proactive.runProactiveDecision).toHaveBeenCalledOnce()
    const ctx = vi.mocked(proactive.runProactiveDecision).mock.calls[0]![0]
    expect(ctx.ambientContext).toBe('## SENTINEL-AMBIENT\nsentinel-body')
  })
})

// ─── Phase 52 SENSOR-19: handleSensorSubAgentTrigger ─────────────────────────

function sensorEvent(slug: string, prompt: string, relayGuidance?: string): QueueEvent & { type: 'sensor_sub_agent_trigger' } {
  return { type: 'sensor_sub_agent_trigger', id: 'qe_s1', slug, prompt, ...(relayGuidance ? { relayGuidance } : {}), createdAt: new Date().toISOString() }
}

async function fireSensor(loop: ActivationLoop, event: QueueEvent & { type: 'sensor_sub_agent_trigger' }): Promise<void> {
  await (loop as unknown as { handleSensorSubAgentTrigger: (e: typeof event) => Promise<void> })
    .handleSensorSubAgentTrigger(event)
}

describe('handleSensorSubAgentTrigger — sensor sub-agent dispatch (SENSOR-19)', () => {
  let fix: Fixture

  afterEach(() => {
    if (fix?.tmpDir) fs.rmSync(fix.tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('spawns with trigger:sensor, NO skillName, slug carried in agentId, task=event.prompt', async () => {
    fix = makeFixture()
    await fireSensor(fix.loop, sensorEvent('calendar', 'Create a reminder for 2pm meeting.'))

    expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
    const args = vi.mocked(fix.agentRunner.spawn).mock.calls[0]![0] as any
    expect(args.trigger).toBe('sensor')
    // skillName must NOT be passed: 'sensor:<slug>' is not a real skill, and spawn() does
    // resolve-or-throw on skillName — passing it aborted the spawn so no sub-agent ran.
    // The "which sensor" label is carried by agentId instead.
    expect(args.skillName).toBeUndefined()
    expect(args.agentId).toContain('sensor')
    expect(args.agentId).toContain('calendar')
    expect(args.task).toContain('Create a reminder for 2pm meeting.')
    // No relayGuidance on the event → spawn arg is undefined (default relay rules).
    expect(args.relayGuidance).toBeUndefined()
  })

  it('passes event.relayGuidance through to spawn when present', async () => {
    fix = makeFixture()
    await fireSensor(fix.loop, sensorEvent('meeting-nag', 'Create reminders.', 'only relay on failure'))

    expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
    const args = vi.mocked(fix.agentRunner.spawn).mock.calls[0]![0] as any
    expect(args.relayGuidance).toBe('only relay on failure')
  })

  it('with proactiveEnabled:true and skip decision: agentRunner.spawn is NOT called', async () => {
    fix = makeFixture({ proactiveEnabled: true, decision: { action: 'skip', reason: 'user busy' } })
    vi.mocked(proactive.runSensorDispatchDecision).mockResolvedValue({ action: 'skip', reason: 'user busy' } as any)
    await fireSensor(fix.loop, sensorEvent('calendar', 'Create a reminder.'))

    expect(fix.agentRunner.spawn).not.toHaveBeenCalled()
    // Also: no schedule-store mutation (no markSkipped)
    expect(fix.scheduleStore.markSkipped).not.toHaveBeenCalled()
  })

  it('with proactiveEnabled:false, spawns directly without calling runSensorDispatchDecision', async () => {
    fix = makeFixture({ proactiveEnabled: false })
    await fireSensor(fix.loop, sensorEvent('weather', 'Log current weather conditions.'))

    expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
    expect(proactive.runSensorDispatchDecision).not.toHaveBeenCalled()
  })

  it('early-returns without reaching head activation path (assembler.assemble never called)', async () => {
    fix = makeFixture()
    await fireSensor(fix.loop, sensorEvent('disk-space', 'Check disk usage and alert if over 90%.'))

    // The handler must return before head activation — assembler must not be called
    const assembler = (fix.loop as unknown as { opts: { assembler: ContextAssembler } }).opts.assembler
    expect(assembler.assemble).not.toHaveBeenCalled()
    // And spawn was called (handler ran to completion)
    expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
  })
})
