import { createFileStore } from './file-store.js'

export interface Schedule {
  id: string
  headId: string
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
  headId: string
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

// ─── Lazy headId migration (Phase 35 D-03) ────────────────────────────────────
//
// Legacy schedule JSON files (pre-Phase-35) have no `headId` field. The first
// read stamps `headId='default'`. The idempotent guard (the `headId in raw`
// check) makes repeated calls cheap and keeps the file's mtime stable on the
// second read — mirrors Phase 33 D-MIGRATION-IDEMPOTENT.
//
// Kept inline (rather than generalized into file-store.ts) per Plan 35-01
// Claude's Discretion item #2: Reminder has a different legacy shape and
// Phase 33's .env migration is unrelated, so generalization has no payoff.

function migrateLegacyHeadId(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  if (!('headId' in obj)) {
    obj['headId'] = 'default'
    return { migrated: true, data: obj as unknown as Schedule }
  }
  return { migrated: false, data: obj as unknown as Schedule }
}

export class ScheduleStore {
  private store: ReturnType<typeof createFileStore<Schedule>>

  constructor(private dir: string) {
    this.store = createFileStore<Schedule>(dir)
  }

  create(options: CreateScheduleOptions): Schedule {
    const now = new Date().toISOString()
    const schedule: Schedule = {
      id: options.id,
      headId: options.headId,
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
    const raw = this.store.get(id)
    if (raw === null) return null
    const { migrated, data } = migrateLegacyHeadId(raw)
    if (migrated && data !== null) this.store.save(data)
    return data
  }

  list(filter?: { headId?: string }): Schedule[] {
    const raws = this.store.list()
    const out: Schedule[] = []
    for (const raw of raws) {
      const { migrated, data } = migrateLegacyHeadId(raw)
      if (data === null) continue
      if (migrated) this.store.save(data)
      out.push(data)
    }
    const filtered = filter?.headId !== undefined
      ? out.filter(s => s.headId === filter.headId)
      : out
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  count(): number {
    return this.store.count()
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    const existing = this.get(id)
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

  /** Returns schedules where next_run <= now and enabled (across all heads). */
  getDue(now: string): Schedule[] {
    const raws = this.store.list()
    const out: Schedule[] = []
    for (const raw of raws) {
      const { migrated, data } = migrateLegacyHeadId(raw)
      if (data === null) continue
      if (migrated) this.store.save(data)
      out.push(data)
    }
    return out.filter(s => s.enabled && s.nextRun !== null && s.nextRun <= now)
  }

  /** Update last_run and next_run after firing a repeating schedule. */
  markFired(id: string, lastRun: string, nextRun: string): void {
    const s = this.get(id)
    if (!s) return
    s.lastRun = lastRun
    s.nextRun = nextRun
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }

  /** Advance next_run without updating last_run (prevents re-firing before proactive decision). */
  advanceNextRun(id: string, nextRun: string): void {
    const s = this.get(id)
    if (!s) return
    s.nextRun = nextRun
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }

  /** Record that a scheduled run was skipped by the proactive decision. */
  markSkipped(id: string, lastSkipped: string, reason: string): void {
    const s = this.get(id)
    if (!s) return
    s.lastSkipped = lastSkipped
    s.lastSkipReason = reason
    s.updatedAt = new Date().toISOString()
    this.store.save(s)
  }
}
