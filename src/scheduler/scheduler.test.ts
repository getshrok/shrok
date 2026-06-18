import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextRunAfter, describeCron } from './cron.js'
import { ScheduleEvaluatorImpl } from './index.js'
import type { QueueStore } from '../db/queue.js'
import type { ScheduleStore, Schedule } from '../db/schedules.js'
import { PRIORITY } from '../types/core.js'

// ─── nextRunAfter ─────────────────────────────────────────────────────────────

describe('nextRunAfter', () => {
  it('returns the next cron fire time after a given date', () => {
    // Every hour on the hour
    const after = new Date('2026-01-01T10:30:00Z')
    const next = nextRunAfter('0 * * * *', after, 'UTC')
    expect(next).toEqual(new Date('2026-01-01T11:00:00Z'))
  })

  it('handles every-3-minute cron', () => {
    const after = new Date('2026-01-01T10:01:00Z')
    const next = nextRunAfter('*/3 * * * *', after, 'UTC')
    expect(next).toEqual(new Date('2026-01-01T10:03:00Z'))
  })

  it('next run is always strictly after the given date', () => {
    const after = new Date()
    const next = nextRunAfter('*/5 * * * *', after, 'UTC')
    expect(next.getTime()).toBeGreaterThan(after.getTime())
  })

  it('throws on invalid cron expression', () => {
    expect(() => nextRunAfter('not a cron', new Date(), 'UTC')).toThrow()
  })
})

// ─── describeCron ────────────────────────────────────────────────────────────

describe('describeCron', () => {
  it('translates every N minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes')
    expect(describeCron('*/30 * * * *')).toBe('Every 30 minutes')
  })

  it('translates every N hours', () => {
    expect(describeCron('0 */2 * * *')).toContain('every 2 hours')
  })

  it('translates daily at specific time', () => {
    expect(describeCron('0 9 * * *')).toContain('09:00 AM')
    expect(describeCron('30 14 * * *')).toContain('02:30 PM')
  })

  it('translates weekdays', () => {
    expect(describeCron('0 10 * * 1-5')).toContain('Monday through Friday')
  })

  it('handles complex patterns', () => {
    expect(describeCron('0 9 1,15 * *')).toContain('day 1 and 15')
  })

  it('falls back gracefully on invalid expression', () => {
    expect(describeCron('not valid')).toBe('cron: not valid')
  })
})

// ─── ScheduleEvaluatorImpl ────────────────────────────────────────────────────

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched_1',
    headId: 'default',
    taskName: 'email',
    kind: 'task',
    cron: '*/3 * * * *',
    runAt: null,
    enabled: true,
    lastRun: null,
    nextRun: new Date().toISOString(),
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: null,
    cronTimezone: null,
    requiresAck: false,
    nagIntervalMinutes: null,
    ackPending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('ScheduleEvaluatorImpl', () => {
  let queueStore: QueueStore
  let scheduleStore: ScheduleStore
  let evaluator: ScheduleEvaluatorImpl

  beforeEach(() => {
    queueStore = {
      enqueue: vi.fn(),
      claimNext: vi.fn(),
      ack: vi.fn(),
      fail: vi.fn(),
      requeueStale: vi.fn(),
    } as unknown as QueueStore

    scheduleStore = {
      getDue: vi.fn().mockReturnValue([]),
      markFired: vi.fn(),
      advanceNextRun: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ScheduleStore

    // Use a large interval so the timer doesn't auto-fire during tests
    evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
  })

  it('enqueues a schedule_trigger for each due cron schedule', () => {
    const schedule = makeSchedule()
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluator.tick()

    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    const [event, priority, headId] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect(event.type).toBe('schedule_trigger')
    expect((event as { taskName: string }).taskName).toBe('email')
    expect(priority).toBe(PRIORITY.SCHEDULE_TRIGGER)
    expect(headId).toBe('default')
  })

  it("Test A (Plan 35-01 D-04): passes schedule.headId as 3rd arg to enqueue", () => {
    const schedule = makeSchedule({ id: 'sched_work', headId: 'work' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluator.tick()

    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    const [, , headId] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect(headId).toBe('work')
  })

  it("Test B (Plan 35-01 D-04): fan-out — two heads in one tick stamp distinct headIds", () => {
    const sDefault = makeSchedule({ id: 'a', headId: 'default', taskName: 'task-a' })
    const sWork = makeSchedule({ id: 'b', headId: 'work', taskName: 'task-b' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([sDefault, sWork])

    evaluator.tick()

    expect(queueStore.enqueue).toHaveBeenCalledTimes(2)
    const call0 = vi.mocked(queueStore.enqueue).mock.calls[0]!
    const call1 = vi.mocked(queueStore.enqueue).mock.calls[1]!

    // Match each call's 3rd arg to its scheduleId
    const event0 = call0[0] as { scheduleId: string }
    const event1 = call1[0] as { scheduleId: string }
    const expectedHeadFor = (sId: string) => (sId === 'a' ? 'default' : 'work')

    expect(call0[2]).toBe(expectedHeadFor(event0.scheduleId))
    expect(call1[2]).toBe(expectedHeadFor(event1.scheduleId))
    // And they must differ
    expect(call0[2]).not.toBe(call1[2])
  })

  it("forwards schedule.kind into the schedule_trigger QueueEvent (DISPATCH-03)", () => {
    const taskSchedule = makeSchedule({ id: 's_task', taskName: 'nightly-vacuum', kind: 'task' })
    const reminderSchedule = makeSchedule({ id: 's_reminder', taskName: null, kind: 'reminder' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([taskSchedule, reminderSchedule])

    evaluator.tick()

    expect(queueStore.enqueue).toHaveBeenCalledTimes(2)
    const ev1 = vi.mocked(queueStore.enqueue).mock.calls[0]![0] as { kind: string; taskName: string | null }
    const ev2 = vi.mocked(queueStore.enqueue).mock.calls[1]![0] as { kind: string; taskName: string | null }
    expect(ev1.kind).toBe('task')
    expect(ev1.taskName).toBe('nightly-vacuum')
    expect(ev2.kind).toBe('reminder')
    expect(ev2.taskName).toBeNull()
  })

  it('advances nextRun without setting lastRun for cron schedules', () => {
    const schedule = makeSchedule()
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluator.tick()

    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    expect(scheduleStore.markFired).not.toHaveBeenCalled()
    const [id, nextRun] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
    expect(id).toBe('sched_1')
    expect(new Date(nextRun).getTime()).toBeGreaterThan(Date.now())
  })

  it('does not update lastRun on tick — proactive steward sees the real previous lastRun', () => {
    const oldLastRun = '2026-01-01T06:00:00Z'
    const schedule = makeSchedule({ lastRun: oldLastRun })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluator.tick()

    // lastRun must not have been touched — markFired and update should not be called
    expect(scheduleStore.markFired).not.toHaveBeenCalled()
    expect(scheduleStore.update).not.toHaveBeenCalled()
    // advanceNextRun only updates next_run
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
  })

  it('second tick does not re-fire the same schedule (nextRun advanced past now)', () => {
    const schedule = makeSchedule()
    vi.mocked(scheduleStore.getDue).mockReturnValueOnce([schedule]).mockReturnValue([])

    evaluator.tick()
    evaluator.tick()

    // Only one enqueue — second tick found no due schedules
    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
  })

  it('disables one-time schedules in the tick (keeps row for activation to read before deleting)', () => {
    const oneTime = makeSchedule({ cron: null, runAt: '2026-01-01T10:00:00Z' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([oneTime])

    evaluator.tick()

    expect(scheduleStore.update).toHaveBeenCalledOnce()
    expect(scheduleStore.update).toHaveBeenCalledWith('sched_1', { enabled: false, nextRun: null })
    expect(scheduleStore.delete).not.toHaveBeenCalled()
    expect(scheduleStore.markFired).not.toHaveBeenCalled()
  })

  it('handles multiple due schedules in one tick', () => {
    const s1 = makeSchedule({ id: 'sched_1', taskName: 'email' })
    const s2 = makeSchedule({ id: 'sched_2', taskName: 'email-triage' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([s1, s2])

    evaluator.tick()

    expect(queueStore.enqueue).toHaveBeenCalledTimes(2)
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledTimes(2)
  })

  it('does not throw when getDue fails', () => {
    vi.mocked(scheduleStore.getDue).mockImplementation(() => { throw new Error('db down') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => evaluator.tick()).not.toThrow()
    spy.mockRestore()
  })

  it('does not throw when enqueue fails for one schedule', () => {
    const s1 = makeSchedule({ id: 'sched_1' })
    const s2 = makeSchedule({ id: 'sched_2' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([s1, s2])
    vi.mocked(queueStore.enqueue)
      .mockImplementationOnce(() => { throw new Error('queue full') })
      .mockImplementation(() => {})
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => evaluator.tick()).not.toThrow()
    // Both schedules advance — failing handler no longer blocks state advance
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('start/stop lifecycle does not throw', () => {
    evaluator.start()
    evaluator.stop()
    // Idempotent start
    evaluator.start()
    evaluator.start()
    evaluator.stop()
  })

  // ─── ACK-03 nag re-arm tests ──────────────────────────────────────────────

  it('(ACK-03) requiresAck one-time reminder: advanceNextRun to now+nagInterval, NOT update(enabled:false)', () => {
    const schedule = makeSchedule({
      id: 'rem_ack_1',
      kind: 'reminder',
      cron: null,
      runAt: '2026-01-01T10:00:00Z',
      requiresAck: true,
      nagIntervalMinutes: 60,
      ackPending: false,
    })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    const before = Date.now()
    evaluator.tick()

    // advanceNextRun must be called (not update with enabled:false)
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    const [id, nextRunIso] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
    expect(id).toBe('rem_ack_1')
    const nextRunMs = new Date(nextRunIso).getTime()
    // nextRun must be approximately now + 60 minutes (within 2s tolerance)
    expect(nextRunMs).toBeGreaterThanOrEqual(before + 60 * 60_000 - 2000)
    expect(nextRunMs).toBeLessThanOrEqual(before + 60 * 60_000 + 2000)
    // The one-time-disable path must NOT be taken
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })

  it('(ACK-06 setup) requiresAck recurring: re-arms to nag interval, NOT next cron occurrence', () => {
    // Weekly Monday cron — next occurrence is many hours away
    const schedule = makeSchedule({
      id: 'rem_ack_2',
      kind: 'reminder',
      cron: '0 9 * * 1',  // weekly, Monday at 09:00
      requiresAck: true,
      nagIntervalMinutes: 30,
      ackPending: true,
    })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    const before = Date.now()
    evaluator.tick()

    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    const [id, nextRunIso] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
    expect(id).toBe('rem_ack_2')
    const nextRunMs = new Date(nextRunIso).getTime()
    // Must re-arm to nag interval (~30 min from now), not the next Monday occurrence
    expect(nextRunMs).toBeGreaterThanOrEqual(before + 30 * 60_000 - 2000)
    expect(nextRunMs).toBeLessThanOrEqual(before + 30 * 60_000 + 2000)
    // The next Monday at 09:00 is at least 1 hour away — confirm we're NOT scheduling that far ahead
    expect(nextRunMs).toBeLessThan(before + 60 * 60_000)
  })

  it('(regression) ordinary cron reminder still advances via nextRunAfter/cron path', () => {
    const schedule = makeSchedule({
      id: 'sched_ordinary',
      kind: 'reminder',
      cron: '*/5 * * * *',
      requiresAck: false,
      nagIntervalMinutes: null,
      ackPending: false,
    })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluator.tick()

    // advanceNextRun called (cron path)
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    const [id, nextRunIso] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
    expect(id).toBe('sched_ordinary')
    // The cron path sets nextRun to the next cron occurrence (strictly after now)
    expect(new Date(nextRunIso).getTime()).toBeGreaterThan(Date.now())
    // Must NOT call update (no disable)
    expect(scheduleStore.update).not.toHaveBeenCalled()
  })
})

// ─── kind:'script' dispatch (Plan 48-02 Task 2) ──────────────────────────────

describe('ScheduleEvaluatorImpl — kind:script dispatch', () => {
  let queueStore: QueueStore
  let scheduleStore: ScheduleStore
  let sensorRunner: { run: ReturnType<typeof vi.fn> }
  let evaluatorWithRunner: ScheduleEvaluatorImpl
  let evaluatorNoRunner: ScheduleEvaluatorImpl

  beforeEach(() => {
    queueStore = {
      enqueue: vi.fn(),
      claimNext: vi.fn(),
      ack: vi.fn(),
      fail: vi.fn(),
      requeueStale: vi.fn(),
    } as unknown as QueueStore

    scheduleStore = {
      getDue: vi.fn().mockReturnValue([]),
      markFired: vi.fn(),
      advanceNextRun: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ScheduleStore

    sensorRunner = { run: vi.fn().mockResolvedValue(undefined) }

    // 5-arg construction (with runner)
    evaluatorWithRunner = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999, sensorRunner)
    // 4-arg construction (backward compat — existing tests must not break)
    evaluatorNoRunner = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
  })

  it('calls sensorRunner.run(slug, headId) and does NOT call queueStore.enqueue for kind:script (SENSOR-06)', async () => {
    const schedule = makeSchedule({ kind: 'script', taskName: 'weather', cron: '*/5 * * * *' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    // enqueue must not be called — script bypasses the activation loop
    expect(queueStore.enqueue).not.toHaveBeenCalled()
    // give the fire-and-forget promise a chance to run
    await new Promise(r => setTimeout(r, 10))
    expect(sensorRunner.run).toHaveBeenCalledOnce()
    // SENSOR-16: runner receives both slug AND headId
    expect(sensorRunner.run).toHaveBeenCalledWith('weather', 'default')
  })

  it('(SENSOR-16) passes schedule.headId to sensorRunner.run for kind:script', async () => {
    const schedule = makeSchedule({ kind: 'script', taskName: 'humidity', cron: '*/10 * * * *', headId: 'zoey' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    await new Promise(r => setTimeout(r, 10))
    expect(sensorRunner.run).toHaveBeenCalledOnce()
    expect(sensorRunner.run).toHaveBeenCalledWith('humidity', 'zoey')
  })

  it('advances nextRun for a cron kind:script schedule', () => {
    const schedule = makeSchedule({ kind: 'script', taskName: 'weather', cron: '*/5 * * * *' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    const [id, nextRunIso] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
    expect(id).toBe('sched_1')
    expect(new Date(nextRunIso).getTime()).toBeGreaterThan(Date.now())
  })

  it('disables one-time kind:script schedule after firing (proves enqueued=true set in script branch)', () => {
    const schedule = makeSchedule({ kind: 'script', taskName: 'weather', cron: null, runAt: '2026-01-01T10:00:00Z' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    expect(scheduleStore.update).toHaveBeenCalledOnce()
    expect(scheduleStore.update).toHaveBeenCalledWith('sched_1', { enabled: false, nextRun: null })
    // still must not enqueue
    expect(queueStore.enqueue).not.toHaveBeenCalled()
  })

  it('does not call runner and logs warn when kind:script schedule has no taskName/slug', async () => {
    const schedule = makeSchedule({ kind: 'script', taskName: null, cron: '*/5 * * * *' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => evaluatorWithRunner.tick()).not.toThrow()

    await new Promise(r => setTimeout(r, 10))
    expect(sensorRunner.run).not.toHaveBeenCalled()
    expect(queueStore.enqueue).not.toHaveBeenCalled()
    // advance still runs (enqueued=true set even when slug is missing)
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('regression: kind:task schedule still calls queueStore.enqueue', () => {
    const schedule = makeSchedule({ kind: 'task', taskName: 'nightly-vacuum', cron: '0 2 * * *' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    const [event] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect((event as { type: string }).type).toBe('schedule_trigger')
    expect(sensorRunner.run).not.toHaveBeenCalled()
  })

  it('regression: kind:reminder schedule still calls queueStore.enqueue', () => {
    const schedule = makeSchedule({ kind: 'reminder', taskName: null, cron: '0 9 * * 1' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    evaluatorWithRunner.tick()

    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    expect(sensorRunner.run).not.toHaveBeenCalled()
  })

  it('backward compat: 4-arg construction + kind:script schedule does not throw, still sets enqueued=true and advances', () => {
    const schedule = makeSchedule({ kind: 'script', taskName: 'weather', cron: '*/5 * * * *' })
    vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

    // No runner injected — should not throw; runner is just skipped
    expect(() => evaluatorNoRunner.tick()).not.toThrow()

    // Advance still runs (enqueued=true set in branch even without runner)
    expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
    // No enqueue
    expect(queueStore.enqueue).not.toHaveBeenCalled()
  })
})
