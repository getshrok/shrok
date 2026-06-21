/**
 * Tests for HeadToolExecutor acknowledge_reminder dispatch case (Phase 38 Plan 04).
 *
 * Covers: ACK-04 (one-time delete), ACK-05 (recurring cron-resume), ACK-06 (nag cancelled),
 *         ACK-08 (hard error on ordinary reminder and task), D-09 (not-found + already-acked no-ops)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { HeadToolExecutor } from './index.js'
import { FileSystemIdentityLoader } from '../identity/loader.js'
import type { AgentRunner } from '../types/agent.js'
import type { Memory } from '../memory/index.js'
import type { SkillLoader } from '../types/skill.js'
import type { UsageStore } from '../db/usage.js'
import type { MessageStore } from '../db/messages.js'
import type { ScheduleStore, Schedule } from '../db/schedules.js'

// ─── Harness helpers (cloned from head.test.ts:192-221) ───────────────────────

function makeWorkerRunner(): AgentRunner {
  return {
    spawn: vi.fn().mockResolvedValue('tent_1'),
    update: vi.fn().mockResolvedValue(undefined),
    signal: vi.fn().mockResolvedValue(undefined),
    retract: vi.fn().mockResolvedValue(undefined),
    checkStatus: vi.fn().mockResolvedValue({ text: 'working on it', stale: false }),
    awaitAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRunner
}

function makeTopicMemory(): Memory {
  return {
    chunk: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
    getTopics: vi.fn().mockResolvedValue([]),
    deleteTopic: vi.fn().mockResolvedValue(undefined),
  } as unknown as Memory
}

function makeUsageStore(): UsageStore {
  return {
    summarize: vi.fn().mockReturnValue({ inputTokens: 100, outputTokens: 50 }),
    getBySourceType: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 }),
    getEstimatedCostToday: vi.fn().mockReturnValue(0),
    getCostSince: vi.fn().mockReturnValue(0),
    getSummary: vi.fn().mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0, byModel: {}, bySourceType: {}, bySource: {} }),
    record: vi.fn(),
  } as unknown as UsageStore
}

// ─── Schedule fixture helper ───────────────────────────────────────────────────

function makeReminder(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'rem-1',
    headId: 'default',
    taskName: null,
    kind: 'reminder',
    cron: null,
    runAt: null,
    enabled: true,
    lastRun: null,
    nextRun: new Date().toISOString(),
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: 'Take your meds',
    cronTimezone: null,
    requiresAck: true,
    nagIntervalMinutes: 60,
    ackPending: true,
    endDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ─── HeadToolExecutor acknowledge_reminder tests ──────────────────────────────

describe('HeadToolExecutor acknowledge_reminder', () => {
  let runner: AgentRunner
  let memory: Memory
  let skillLoader: SkillLoader
  let usageStore: UsageStore
  let executor: HeadToolExecutor
  let scheduleStore: ScheduleStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-tools-test-'))

    runner = makeWorkerRunner()
    memory = makeTopicMemory()
    usageStore = makeUsageStore()
    skillLoader = {
      load: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn(),
    } as unknown as SkillLoader

    scheduleStore = {
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ScheduleStore

    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)
    executor = new HeadToolExecutor({
      headId: 'default',
      agentRunner: runner,
      skillLoader,
      topicMemory: memory,
      usageStore,
      identityDir: tmpDir,
      identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
      scheduleStore,
      timezone: 'UTC',
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Test 1: ACK-04, ACK-06 — one-time ack reminder → delete row ─────────────

  it('one-time ack reminder: deletes row and returns { ok: true }', async () => {
    const reminder = makeReminder({ cron: null, ackPending: true })
    vi.mocked(scheduleStore.get).mockReturnValue(reminder)

    const result = await executor.execute({
      id: 'tc1',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-1' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed).toMatchObject({ ok: true })
    expect(scheduleStore.delete).toHaveBeenCalledWith('rem-1')
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })

  // ── Test 2: ACK-05, ACK-06 — recurring ack reminder → clear ackPending + cron resume ──

  it('recurring ack reminder: clears ackPending and resumes base cron cadence', async () => {
    // Monday at 09:00 UTC
    const reminder = makeReminder({ cron: '0 9 * * 1', ackPending: true })
    vi.mocked(scheduleStore.get).mockReturnValue(reminder)

    const before = Date.now()
    const result = await executor.execute({
      id: 'tc2',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-1' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed).toMatchObject({ ok: true })
    expect(scheduleStore.update).toHaveBeenCalledWith(
      'rem-1',
      expect.objectContaining({ ackPending: false })
    )
    // nextRun should be a valid ISO string in the future (the next Monday 09:00)
    const updateCall = vi.mocked(scheduleStore.update).mock.calls[0]!
    const patch = updateCall[1] as { ackPending: boolean; nextRun: string }
    expect(typeof patch.nextRun).toBe('string')
    const resumeMs = new Date(patch.nextRun).getTime()
    expect(resumeMs).toBeGreaterThan(before)
    // delete must NOT be called for recurring
    expect(scheduleStore.delete).not.toHaveBeenCalled()
  })

  // ── Test 3: ACK-08, D-08 — ordinary reminder (requiresAck:false) → hard error ──

  it('ordinary reminder (requiresAck: false): returns hard error, no mutation', async () => {
    const reminder = makeReminder({ requiresAck: false, ackPending: false })
    vi.mocked(scheduleStore.get).mockReturnValue(reminder)

    const result = await executor.execute({
      id: 'tc3',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-1' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed.error).toBe(true)
    expect(scheduleStore.delete).not.toHaveBeenCalled()
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })

  // ── Test 4: ACK-08, Pitfall 5 — task schedule → hard error ──────────────────

  it('task schedule (kind: task): returns hard error, no mutation', async () => {
    const taskSchedule = makeReminder({ kind: 'task', requiresAck: false, ackPending: false })
    vi.mocked(scheduleStore.get).mockReturnValue(taskSchedule)

    const result = await executor.execute({
      id: 'tc4',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-1' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed.error).toBe(true)
    expect(scheduleStore.delete).not.toHaveBeenCalled()
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })

  // ── Test 5: D-09 — row not found → benign no-op ──────────────────────────────

  it('row not found: returns ok no-op with note, no mutation', async () => {
    vi.mocked(scheduleStore.get).mockReturnValue(null)

    const result = await executor.execute({
      id: 'tc5',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-missing' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed.ok).toBe(true)
    expect(typeof parsed.note).toBe('string')
    expect(scheduleStore.delete).not.toHaveBeenCalled()
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })

  // ── Test 6: D-09 — ackPending: false (already acked) → benign no-op ─────────

  it('already acked (ackPending: false): returns ok no-op with note, no mutation', async () => {
    const reminder = makeReminder({ ackPending: false })
    vi.mocked(scheduleStore.get).mockReturnValue(reminder)

    const result = await executor.execute({
      id: 'tc6',
      name: 'acknowledge_reminder',
      input: { reminderId: 'rem-1' },
    })
    const parsed = JSON.parse(result.content as string)

    expect(parsed.ok).toBe(true)
    expect(typeof parsed.note).toBe('string')
    expect(scheduleStore.delete).not.toHaveBeenCalled()
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })
})
