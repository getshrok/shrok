import { createFileStore } from './file-store.js'

export interface Schedule {
  id: string
  taskName: string | null
  kind: 'task' | 'reminder'
  cron: string | null        // null for one-time
  runAt: string | null       // null for repeating
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  lastSkipped: string | null
  lastSkipReason: string | null
  conditions: string | null
  agentContext: string | null
  cronTimezone: string | null  // per-schedule timezone override; null = use workspace default
  createdAt: string
  updatedAt: string
}

export interface CreateScheduleOptions {
  id: string
  taskName?: string
  kind?: 'task' | 'reminder'
  cron?: string
  runAt?: string
  nextRun?: string
  conditions?: string
  agentContext?: string
  cronTimezone?: string
}

export type SchedulePatch = Partial<Pick<Schedule, 'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone'>>

export class ScheduleStore {
  private store: ReturnType<typeof createFileStore<Schedule>>

  constructor(private dir: string) {
    this.store = createFileStore<Schedule>(dir)
  }

  create(options: CreateScheduleOptions): Schedule {
    const now = new Date().toISOString()
    const schedule: Schedule = {
      id: options.id,
      taskName: options.taskName ?? null,
      kind: options.kind ?? 'task',
      cron: options.cron ?? null,
      runAt: options.runAt ?? null,
      enabled: true,
      lastRun: null,
      nextRun: options.nextRun ?? options.runAt ?? null,
      lastSkipped: null,
      lastSkipReason: null,
      conditions: options.conditions ?? null,
      agentContext: options.agentContext ?? null,
      cronTimezone: options.cronTimezone ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.store.save(schedule)
    return schedule
  }

  get(id: string): Schedule | null {
    return this.store.get(id)
  }

  list(): Schedule[] {
    return this.store.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  count(): number {
    return this.store.count()
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    const existing = this.store.get(id)
    if (!existing) return null

    if (patch.cron !== undefined) existing.cron = patch.cron
    if (patch.runAt !== undefined) existing.runAt = patch.runAt
    if (patch.enabled !== undefined) existing.enabled = patch.enabled
    if (patch.nextRun !== undefined) existing.nextRun = patch.nextRun
    if (patch.lastRun !== undefined) existing.lastRun = patch.lastRun
    if (patch.conditions !== undefined) existing.conditions = patch.conditions
    if (patch.agentContext !== undefined) existing.agentContext = patch.agentContext
    if (patch.cronTimezone !== undefined) existing.cronTimezone = patch.cronTimezone

    existing.updatedAt = new Date().toISOString()
    this.store.save(existing)
    return existing
  }

  delete(id: string): void {
    this.store.delete(id)
  }

  /** Returns schedules where next_run <= now and enabled. */
  getDue(now: string): Schedule[] {
    return this.store.list().filter(s => s.enabled && s.nextRun !== null && s.nextRun <= now)
  }

  /** Update last_run and next_run after firing a repeating schedule. */
  markFired(id: string, lastRun: string, nextRun: string): void {
    const s = this.store.get(id)
    if (!s) return
    s.lastRun = lastRun
    s.nextRun = nextRun
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }

  /** Advance next_run without updating last_run (prevents re-firing before proactive decision). */
  advanceNextRun(id: string, nextRun: string): void {
    const s = this.store.get(id)
    if (!s) return
    s.nextRun = nextRun
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }

  /** Record that a scheduled run was skipped by the proactive decision. */
  markSkipped(id: string, lastSkipped: string, reason: string): void {
    const s = this.store.get(id)
    if (!s) return
    s.lastSkipped = lastSkipped
    s.lastSkipReason = reason
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }
}
