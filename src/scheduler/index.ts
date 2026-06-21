import type { QueueStore } from '../db/queue.js'
import { log } from '../logger.js'
import type { ScheduleStore } from '../db/schedules.js'
import { PRIORITY } from '../types/core.js'
import { nextRunAfter } from './cron.js'
import type { SensorRunner } from '../sensors/runner.js'

export type { SensorRunner }

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
  private sensorRunner: SensorRunner | undefined

  constructor(queueStore: QueueStore, scheduleStore: ScheduleStore, timezone: string, intervalMs = 60_000, sensorRunner?: SensorRunner) {
    this.queueStore = queueStore
    this.scheduleStore = scheduleStore
    this.timezone = timezone
    this.intervalMs = intervalMs
    this.sensorRunner = sensorRunner
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
        if (schedule.kind === 'script') {
          // SENSOR-06: bypass the activation loop entirely — run the sensor inline.
          // Fire-and-forget the runner (mirrors directHandler pattern); errors are caught
          // and logged so a failing sensor never disrupts other due schedules.
          const slug = schedule.taskName
          if (!slug) {
            log.warn(`[scheduler] script schedule ${schedule.id} has no taskName/slug — skipping`)
          } else if (this.sensorRunner) {
            this.sensorRunner.run(slug, schedule.headId).catch(err =>
              log.error(`[scheduler] sensor:${slug} runner error:`, (err as Error).message)
            )
          }
          // CRITICAL (Pitfall 1): set enqueued=true even though no queue event is produced.
          // Without this, one-time kind:'script' schedules re-fire every tick because the
          // advance block below only disables a row when enqueued===true.
          enqueued = true
        } else {
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
              schedule.headId,
            )
            enqueued = true
            log.info(`[scheduler] enqueued ${schedule.kind}:${schedule.taskName ?? schedule.id}`)
          }
        }
      } catch (err) {
        log.error(`[scheduler] Failed to enqueue schedule ${schedule.id}:`, (err as Error).message)
      }
      try {
        if (schedule.requiresAck && schedule.nagIntervalMinutes !== null) {
          // ACK-03 nag re-arm: keep enabled=true, point nextRun to now+nagInterval.
          // Uses advanceNextRun (nextRun-only) so enabled stays true throughout the
          // nag loop — never falls into the one-time-disable path (Pitfall 2 in RESEARCH).
          // This branch must be FIRST so a requiresAck one-time reminder (cron===null)
          // never reaches the `else if (enqueued)` disable path.
          const nagNext = new Date(now.getTime() + schedule.nagIntervalMinutes * 60_000)
          this.scheduleStore.advanceNextRun(schedule.id, nagNext.toISOString())
        } else if (schedule.cron) {
          const tz = schedule.cronTimezone ?? this.timezone
          const next = nextRunAfter(schedule.cron, now, tz)
          const nextIso = next.toISOString()
          // WL2-ENDDATE: if the next computed fire is on/after endDate, auto-disable
          // instead of advancing. A recurring schedule whose endDate already passed
          // disables on its first post-fire advance. One-time (runAt) schedules already
          // disable after firing via the `else if (enqueued)` branch below, so no
          // getDue() endDate guard is needed.
          if (schedule.endDate && nextIso >= schedule.endDate) {
            this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
          } else {
            this.scheduleStore.advanceNextRun(schedule.id, nextIso)
          }
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
