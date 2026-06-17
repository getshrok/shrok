import { createFileStore } from './file-store.js'

export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder' | 'script'
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
  /** Whether this reminder requires explicit user acknowledgment before it stops nagging. */
  requiresAck: boolean
  /** Total nag cadence in minutes — the interval between repeated nag fires. Null/inert when requiresAck is false (D-07). */
  nagIntervalMinutes: number | null
  /** Whether an ack-required reminder currently has an outstanding (un-acknowledged) nag in flight. Inert (false) for non-ack reminders and tasks. Set true at activation delivery (D-05), cleared on ack (D-07). */
  ackPending: boolean
  /** Additional heads to deliver task completion to (Phase 44). Only meaningful for kind:'task'.
   *  Absent on reminders and legacy rows (absent = owner-only; do NOT migrate to []).
   *  Effective delivery set is dedupe([headId, ...deliverToHeadIds]). */
  deliverToHeadIds?: string[]
  /** Optional operator guidance for the relay steward, injected into its prompt to bias
   *  whether THIS scheduled task's output is surfaced (e.g. "always deliver" / "only ping
   *  on failure"). Only meaningful for kind:'task'. Absent = relay defaults apply. */
  relayGuidance?: string
  createdAt: string
  updatedAt: string
}

export interface CreateScheduleOptions {
  id: string
  headId: string
  taskName?: string
  kind?: 'task' | 'reminder' | 'script'
  cron?: string
  runAt?: string
  nextRun?: string
  conditions?: string
  agentContext?: string
  cronTimezone?: string
  requiresAck?: boolean
  nagIntervalMinutes?: number | null
  ackPending?: boolean
  deliverToHeadIds?: string[]
  relayGuidance?: string
}

export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' |
  'agentContext' | 'cronTimezone' | 'ackPending' | 'requiresAck' | 'nagIntervalMinutes' |
  'deliverToHeadIds' | 'relayGuidance'
>>

// ─── Lazy schedule migration (Phase 35 D-03, Phase 37 D-08) ──────────────────
//
// Legacy schedule JSON files (pre-Phase-35) have no `headId` field; pre-Phase-37
// files additionally lack `requiresAck` and `nagIntervalMinutes`. The first read
// stamps all missing fields with their defaults. The idempotent `'field' in obj`
// guard (NOT a `??` coalesce) makes repeated calls cheap and keeps the file's
// mtime stable on the second read — mirrors Phase 33 D-MIGRATION-IDEMPOTENT.
//
// Kept inline (rather than generalized into file-store.ts) per Plan 35-01
// Claude's Discretion item #2: Reminder has a different legacy shape and
// Phase 33's .env migration is unrelated, so generalization has no payoff.

function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
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
      requiresAck: options.requiresAck ?? false,
      nagIntervalMinutes: options.nagIntervalMinutes ?? null,
      ackPending: options.ackPending ?? false,
      ...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {}),
      ...(options.relayGuidance ? { relayGuidance: options.relayGuidance } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.store.save(schedule)
    return schedule
  }

  get(id: string): Schedule | null {
    const raw = this.store.get(id)
    if (raw === null) return null
    const { migrated, data } = migrateLegacySchedule(raw)
    if (migrated && data !== null) this.store.save(data)
    return data
  }

  list(filter?: { headId?: string }): Schedule[] {
    const raws = this.store.list()
    const out: Schedule[] = []
    for (const raw of raws) {
      const { migrated, data } = migrateLegacySchedule(raw)
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
    if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending
    if (patch.requiresAck !== undefined) existing.requiresAck = patch.requiresAck
    if (patch.nagIntervalMinutes !== undefined) existing.nagIntervalMinutes = patch.nagIntervalMinutes
    if (patch.deliverToHeadIds !== undefined) {
      if (patch.deliverToHeadIds.length > 0) {
        existing.deliverToHeadIds = patch.deliverToHeadIds
      } else {
        delete existing.deliverToHeadIds
      }
    }
    if (patch.relayGuidance !== undefined) {
      if (patch.relayGuidance) {
        existing.relayGuidance = patch.relayGuidance
      } else {
        delete existing.relayGuidance
      }
    }

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
      const { migrated, data } = migrateLegacySchedule(raw)
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

  /**
   * Plan 35-03 D-16 / D-17: cascade-delete all schedules and reminders owned
   * by a head. Returns split counts so the DELETE /api/heads/:id response can
   * surface them (D-17).
   *
   * Idempotent — non-existent headId returns { schedules: 0, reminders: 0 }
   * with no error. Reminders and schedules share the same JSON dir; the
   * `kind` field discriminates the count buckets.
   *
   * Uses this.list() so any unstamped legacy rows resolve to 'default' first
   * (lazy migration funnel per D-03), making the helper safe to call on a
   * directory that may contain pre-Phase-35 files.
   */
  /**
   * Rename all schedule rows whose taskName === oldName to newName.
   * Returns the count of updated rows.
   *
   * Note: only kind:'task' rows ever carry a non-null taskName;
   * reminder rows have taskName=null and are naturally skipped (null !== oldName).
   * Mutates rows directly like markFired/advanceNextRun — does NOT route through
   * update()/SchedulePatch because taskName is intentionally absent from the
   * SchedulePatch Pick<> per Phase 35 D-13.
   */
  renameTask(oldName: string, newName: string): number {
    let count = 0
    for (const s of this.list()) {
      if (s.taskName !== oldName) continue
      s.taskName = newName
      s.updatedAt = new Date().toISOString()
      this.store.save(s)
      count++
    }
    return count
  }

  deleteAllForHead(headId: string): { schedules: number; reminders: number } {
    const all = this.list()
    let schedules = 0
    let reminders = 0
    for (const s of all) {
      if (s.headId !== headId) continue
      this.store.delete(s.id)
      if (s.kind === 'reminder') reminders++
      else schedules++
    }
    return { schedules, reminders }
  }
}
