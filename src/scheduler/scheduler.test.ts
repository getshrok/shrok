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
    const [event, priority] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect(event.type).toBe('schedule_trigger')
    expect((event as { taskName: string }).taskName).toBe('email')
    expect(priority).toBe(PRIORITY.SCHEDULE_TRIGGER)
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
})
