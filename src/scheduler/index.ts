import type { QueueStore } from '../db/queue.js'
import { log } from '../logger.js'
import type { ScheduleStore } from '../db/schedules.js'
import { PRIORITY } from '../types/core.js'
import { nextRunAfter } from './cron.js'

export interface ScheduleEvaluator {
  start(): void
  stop(): void
  registerDirectHandler(skillName: string, handler: () => Promise<void>): void
}

export class ScheduleEvaluatorImpl implements ScheduleEvaluator {
  private queueStore: QueueStore
  private scheduleStore: ScheduleStore
  private timezone: string
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private directHandlers = new Map<string, () => Promise<void>>()

  constructor(queueStore: QueueStore, scheduleStore: ScheduleStore, timezone: string, intervalMs = 60_000) {
    this.queueStore = queueStore
    this.scheduleStore = scheduleStore
    this.timezone = timezone
    this.intervalMs = intervalMs
  }

  registerDirectHandler(skillName: string, handler: () => Promise<void>): void {
    this.directHandlers.set(skillName, handler)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    // Run immediately on start as well
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  tick(): void {
    const now = new Date()
    const nowIso = now.toISOString()

    let due: ReturnType<ScheduleStore['getDue']>
    try {
      due = this.scheduleStore.getDue(nowIso)
    } catch (err) {
      log.error('[scheduler] Failed to fetch due schedules:', (err as Error).message)
      return
    }

    for (const schedule of due) {
      let enqueued = false
      try {
        const directHandler = this.directHandlers.get(schedule.taskName ?? '')
        if (directHandler) {
          directHandler().catch(err =>
            log.error(`[scheduler] Direct handler for ${schedule.taskName ?? schedule.id} failed:`, (err as Error).message)
          )
          enqueued = true
        } else {
          const eventId = `qe_sched_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
          this.queueStore.enqueue(
            {
              type: 'schedule_trigger',
              id: eventId,
              scheduleId: schedule.id,
              taskName: schedule.taskName,
              kind: schedule.kind,
              createdAt: nowIso,
            },
            PRIORITY.SCHEDULE_TRIGGER,
          )
          enqueued = true
          log.info(`[scheduler] enqueued ${schedule.kind}:${schedule.taskName ?? schedule.id}`)
        }
      } catch (err) {
        log.error(`[scheduler] Failed to enqueue schedule ${schedule.id}:`, (err as Error).message)
      }
      try {
        if (schedule.cron) {
          const next = nextRunAfter(schedule.cron, now, this.timezone)
          this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())
        } else if (enqueued) {
          // Disable so the tick won't re-fire, but keep the row — activation
          // needs it to read agentContext and cron before deleting it after firing.
          this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
        }
      } catch (err) {
        log.error(`[scheduler] Failed to advance schedule ${schedule.id}:`, (err as Error).message)
      }
    }
  }
}
