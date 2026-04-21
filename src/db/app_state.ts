import { type DatabaseSync, type StatementSync } from './index.js'
import type { UsageThreshold, ThresholdAction } from '../usage-threshold.js'
import type { Period } from '../period.js'
import { log } from '../logger.js'

export interface ConversationVisibility {
  agentWork: boolean
  headTools: boolean
  systemEvents: boolean
  stewardRuns: boolean
  agentPills: boolean
  memoryRetrievals: boolean
}

export class AppStateStore {
  private stmtGet: StatementSync
  private stmtSet: StatementSync
  private stmtDelete: StatementSync

  constructor(private db: DatabaseSync) {
    this.stmtGet = db.prepare('SELECT value FROM app_state WHERE key = ?')
    this.stmtSet = db.prepare(
      'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    this.stmtDelete = db.prepare('DELETE FROM app_state WHERE key = ?')
  }

  private get(key: string): string | null {
    const row = this.stmtGet.get(key) as unknown as { value: string } | undefined
    return row?.value ?? null
  }

  private set(key: string, value: string): void {
    this.stmtSet.run(key, value)
  }

  private delete(key: string): void {
    this.stmtDelete.run(key)
  }

  getLastActiveChannel(): string {
    return this.get('last_active_channel') ?? ''
  }

  setLastActiveChannel(id: string): void {
    this.set('last_active_channel', id)
  }

  /** Atomic test-and-set: acquire archival lock only if not already held.
   *  Returns true if the lock was acquired, false if already running. */
  tryAcquireArchivalLock(): boolean {
    // INSERT OR IGNORE seeds the row with value='false' if it doesn't exist.
    this.db.prepare(
      "INSERT OR IGNORE INTO app_state (key, value) VALUES ('archival_lock', 'false')"
    ).run()

    const result = this.db.prepare(
      "UPDATE app_state SET value = 'true' WHERE key = 'archival_lock' AND value = 'false'"
    ).run()

    return result.changes === 1
  }

  releaseArchivalLock(): void {
    this.set('archival_lock', 'false')
  }

  /**
   * Categorized dashboard visibility controls. Replaces the old boolean `xray_enabled`.
   * Each category controls a cohesive group of related message types in the conversation view.
   */
  getConversationVisibility(): ConversationVisibility {
    // One-time migration: if legacy 'xray_enabled' exists, seed agentWork from it and delete.
    // get() returns string | null, so check for !== null.
    const legacy = this.get('xray_enabled')
    if (legacy !== null) {
      const seeded: ConversationVisibility = {
        agentWork: legacy === 'true',
        headTools: false,
        systemEvents: false,
        stewardRuns: false,
        agentPills: false,
        memoryRetrievals: false,
      }
      this.setConversationVisibility(seeded)
      this.delete('xray_enabled')
      return seeded
    }
    return {
      agentWork: this.get('vis_agent_work') !== 'false',  // default true for new installs
      headTools: this.get('vis_head_tools') === 'true',
      systemEvents: this.get('vis_system_events') === 'true',
      stewardRuns: this.get('vis_steward_runs') === 'true',
      agentPills: this.get('vis_agent_pills') === 'true',
      memoryRetrievals: this.get('vis_memory_retrievals') === 'true',
    }
  }

  setConversationVisibility(v: ConversationVisibility): void {
    this.set('vis_agent_work', v.agentWork ? 'true' : 'false')
    this.set('vis_head_tools', v.headTools ? 'true' : 'false')
    this.set('vis_system_events', v.systemEvents ? 'true' : 'false')
    this.set('vis_steward_runs', v.stewardRuns ? 'true' : 'false')
    this.set('vis_agent_pills', v.agentPills ? 'true' : 'false')
    this.set('vis_memory_retrievals', v.memoryRetrievals ? 'true' : 'false')
  }

  getUsageFootersEnabled(): boolean {
    return this.get('usage_footers_enabled') === 'true'
  }

  setUsageFootersEnabled(enabled: boolean): void {
    this.set('usage_footers_enabled', enabled ? 'true' : 'false')
  }

  // ─── Usage thresholds ────────────────────────────────────────────────────
  // The user's configured spend caps. Stored as a JSON-encoded array under
  // a single key. The threshold checker (task 6) reads via getThresholds();
  // the dashboard / settings API mutates via add/update/delete.

  private static readonly THRESHOLDS_KEY = 'usage_thresholds'

  getThresholds(): UsageThreshold[] {
    const raw = this.get(AppStateStore.THRESHOLDS_KEY)
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // Corrupted JSON shouldn't brick the settings UI — return empty and let
      // the user re-add. Log a WARN so there's a breadcrumb to debug from.
      log.warn('[app_state] usage_thresholds row was malformed JSON, returning empty list:', (err as Error).message)
      return []
    }
    if (!Array.isArray(parsed)) {
      log.warn('[app_state] usage_thresholds row was not an array, returning empty list')
      return []
    }

    const out: UsageThreshold[] = []
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') {
        log.warn('[app_state] usage_thresholds entry is not an object, skipping')
        continue
      }
      const t = raw as Record<string, unknown>
      if (typeof t['id'] !== 'string' || !t['id']) {
        log.warn('[app_state] usage_thresholds entry missing id, skipping')
        continue
      }
      if (typeof t['period'] !== 'string' || !['day', 'week', 'month'].includes(t['period'])) {
        log.warn(`[app_state] usage_thresholds entry ${t['id']} has invalid period, skipping`)
        continue
      }
      if (typeof t['amountUsd'] !== 'number' || !Number.isFinite(t['amountUsd']) || t['amountUsd'] <= 0) {
        log.warn(`[app_state] usage_thresholds entry ${t['id']} has invalid amountUsd, skipping`)
        continue
      }
      // action is the only legitimately new field — default to 'alert' if missing
      // (legacy data from task 4 had no action field). Validate the type if present.
      let action: ThresholdAction = 'alert'
      if ('action' in t) {
        if (t['action'] !== 'alert' && t['action'] !== 'block') {
          log.warn(`[app_state] usage_thresholds entry ${t['id']} has invalid action "${String(t['action'])}", defaulting to 'alert'`)
        } else {
          action = t['action']
        }
      }
      out.push({
        id: t['id'],
        period: t['period'] as Period,
        amountUsd: t['amountUsd'],
        action,
      })
    }
    return out
  }

  // Wholesale replacement is an internal escape hatch only. External callers
  // (settings API, dashboard) must go through addThreshold / updateThreshold /
  // deleteThreshold so validation and ID generation stay in one place.
  private setThresholds(thresholds: UsageThreshold[]): void {
    this.set(AppStateStore.THRESHOLDS_KEY, JSON.stringify(thresholds))
  }

  addThreshold(input: Omit<UsageThreshold, 'id'>): UsageThreshold {
    const threshold: UsageThreshold = {
      id: `threshold_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      period: input.period,
      amountUsd: input.amountUsd,
      action: input.action,
    }
    this.setThresholds([...this.getThresholds(), threshold])
    return threshold
  }

  updateThreshold(id: string, patch: Partial<Omit<UsageThreshold, 'id'>>): UsageThreshold | null {
    const current = this.getThresholds()
    const idx = current.findIndex(t => t.id === id)
    if (idx === -1) return null
    const before = current[idx]!
    const updated: UsageThreshold = { ...before, ...patch }
    const next = [...current]
    next[idx] = updated
    this.setThresholds(next)
    // Period change resets fired state — a new period is semantically a new
    // threshold for eligibility purposes. Avoids stale stamps silencing the
    // new period (e.g. day→month would silence for up to ~30 days).
    if (patch.period !== undefined && patch.period !== before.period) {
      this.clearThresholdFiredAt(id)
    }
    return updated
  }

  deleteThreshold(id: string): boolean {
    const current = this.getThresholds()
    const next = current.filter(t => t.id !== id)
    if (next.length === current.length) return false
    this.setThresholds(next)
    this.clearThresholdFiredAt(id)   // housekeeping: drop orphan fired-state
    return true
  }

  // ─── Threshold fired-state ───────────────────────────────────────────────
  // Tracks when each threshold last fired. Stored as a separate JSON-encoded
  // map ({ thresholdId: isoTimestamp }) under usage_thresholds_fired so user
  // config and runtime state stay decoupled. The threshold checker (task 6)
  // uses these to enforce "fire once per period" semantics.

  private static readonly THRESHOLDS_FIRED_KEY = 'usage_thresholds_fired'

  // Read AND sanitize the map. Skips per-entry corruption (non-string values,
  // unparseable date strings) with a WARN. Both readers below get clean data.
  private getFiredMap(): Record<string, string> {
    const raw = this.get(AppStateStore.THRESHOLDS_FIRED_KEY)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn('[app_state] usage_thresholds_fired row was malformed JSON, returning empty map:', (err as Error).message)
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('[app_state] usage_thresholds_fired row was not an object, returning empty map')
      return {}
    }
    const out: Record<string, string> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        log.warn(`[app_state] usage_thresholds_fired entry ${id} has non-string value (${typeof value}), skipping`)
        continue
      }
      if (!Number.isFinite(new Date(value).getTime())) {
        log.warn(`[app_state] usage_thresholds_fired entry ${id} has unparseable timestamp "${value}", skipping`)
        continue
      }
      out[id] = value
    }
    return out
  }

  private setFiredMap(map: Record<string, string>): void {
    this.set(AppStateStore.THRESHOLDS_FIRED_KEY, JSON.stringify(map))
  }

  /** Returns the timestamp this threshold last fired at, or null if never. */
  getThresholdFiredAt(thresholdId: string): Date | null {
    const iso = this.getFiredMap()[thresholdId]
    return iso ? new Date(iso) : null
  }

  /** Bulk read for the checker — one DB hit per check loop instead of N. */
  getAllThresholdFiredAt(): Record<string, Date> {
    const map = this.getFiredMap()
    const out: Record<string, Date> = {}
    for (const [id, iso] of Object.entries(map)) {
      out[id] = new Date(iso)
    }
    return out
  }

  /** Stamp a fire. The `when` default is for production convenience only;
   *  tests and the threshold checker (task 6) should always pass an
   *  explicit `now` plumbed from their caller for testability. */
  setThresholdFiredAt(thresholdId: string, when: Date = new Date()): void {
    const map = this.getFiredMap()
    map[thresholdId] = when.toISOString()
    this.setFiredMap(map)
  }

  /** Drop a single entry. Used by deleteThreshold for housekeeping; no-op for unknown ids. */
  clearThresholdFiredAt(thresholdId: string): void {
    const map = this.getFiredMap()
    if (!(thresholdId in map)) return
    delete map[thresholdId]
    this.setFiredMap(map)
  }

  /** One-time seed of the default $50/day block threshold on fresh installs.
   *  Idempotent via the `usage_threshold_migrated_v1` flag — subsequent calls
   *  are no-ops and never re-seed nor modify an existing threshold.
   *  Returns true if the seed ran this call, false if already done. */
  seedDefaultThreshold(): boolean {
    const FLAG_KEY = 'usage_threshold_migrated_v1'
    if (this.get(FLAG_KEY) === 'true') return false
    this.addThreshold({
      period: 'day',
      amountUsd: 50,
      action: 'block',
    })
    this.set(FLAG_KEY, 'true')
    return true
  }
}
