/**
 * Phase 35 architectural regression test: per-head scheduling.
 *
 * Pins four observable truths that close the cross-head schedule leak:
 *
 *   1. Schedule on head A produces a schedule_trigger queue_event with head_id='A'
 *   2. Schedule on head A produces ONE event (not one-per-head fan-out)
 *   3. claimNext('B') does NOT see head A's schedule_trigger event
 *   4. Two schedules across two heads each fire on their own head only (cross-head isolation)
 *
 * Plus a fifth test that pins Plan 35-01's lazy-migration contract end-to-end —
 * a legacy JSON file without a headId field is migrated to 'default' on read
 * and the resulting queue_event also carries head_id='default'.
 *
 * Self-contained — does NOT share fixtures with tests/integration/helpers.ts so a
 * misconfigured helper elsewhere cannot mask a regression here. Mirrors Phase 34
 * D-SELF-CONTAINED-REGRESSION-TEST.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { QueueStore } from '../../src/db/queue.js'
import { ScheduleStore } from '../../src/db/schedules.js'
import { ScheduleEvaluatorImpl } from '../../src/scheduler/index.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function freshScheduleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-sched-test-'))
}

function cleanup(db: DatabaseSync, dir: string): void {
  try { db.close() } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Multi-Head Scheduling (Phase 35 architectural regression)', () => {
  it("schedule on head 'work' produces a schedule_trigger queue_event with head_id='work'", () => {
    const db = freshDb()
    const dir = freshScheduleDir()
    const queueStore = new QueueStore(db)
    const scheduleStore = new ScheduleStore(dir)
    scheduleStore.create({
      id: 'sched_work_1',
      headId: 'work',
      kind: 'task',
      taskName: 'noop',
      runAt: new Date(Date.now() - 1000).toISOString(),
      nextRun: new Date(Date.now() - 1000).toISOString(),
    })
    const evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
    evaluator.tick()

    // Directly inspect queue_events to verify head_id stamping (no claimNext yet)
    const rows = db.prepare(
      "SELECT head_id, type FROM queue_events WHERE type = 'schedule_trigger'",
    ).all() as Array<{ head_id: string; type: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.head_id).toBe('work')

    cleanup(db, dir)
  })

  it('single tick produces exactly ONE event for one due schedule (guards against per-head fan-out)', () => {
    const db = freshDb()
    const dir = freshScheduleDir()
    const queueStore = new QueueStore(db)
    const scheduleStore = new ScheduleStore(dir)
    scheduleStore.create({
      id: 'sched_work_2',
      headId: 'work',
      kind: 'task',
      taskName: 'noop',
      runAt: new Date(Date.now() - 1000).toISOString(),
      nextRun: new Date(Date.now() - 1000).toISOString(),
    })
    const evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
    evaluator.tick()

    const countRow = db.prepare(
      "SELECT COUNT(*) as n FROM queue_events WHERE type = 'schedule_trigger'",
    ).get() as { n: number }
    expect(countRow.n).toBe(1)

    cleanup(db, dir)
  })

  it("claimNext('default') does NOT see head 'work's schedule_trigger event (cross-head isolation)", () => {
    const db = freshDb()
    const dir = freshScheduleDir()
    const queueStore = new QueueStore(db)
    const scheduleStore = new ScheduleStore(dir)
    scheduleStore.create({
      id: 'sched_work_3',
      headId: 'work',
      kind: 'task',
      taskName: 'noop',
      runAt: new Date(Date.now() - 1000).toISOString(),
      nextRun: new Date(Date.now() - 1000).toISOString(),
    })
    const evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
    evaluator.tick()

    // 'default' head's loop should see nothing
    const defaultClaim = queueStore.claimNext('default')
    expect(defaultClaim).toBeNull()

    // 'work' head's loop sees its own event
    const workClaim = queueStore.claimNext('work')
    expect(workClaim).not.toBeNull()
    expect(workClaim!.event.type).toBe('schedule_trigger')

    // No leftover after the work head claimed it
    expect(queueStore.claimNext('work')).toBeNull()
    expect(queueStore.claimNext('default')).toBeNull()

    cleanup(db, dir)
  })

  it('two schedules across two heads fire only on their own heads (two-head fan-out)', () => {
    const db = freshDb()
    const dir = freshScheduleDir()
    const queueStore = new QueueStore(db)
    const scheduleStore = new ScheduleStore(dir)
    scheduleStore.create({
      id: 'sched_default_1',
      headId: 'default',
      kind: 'task',
      taskName: 'noop',
      runAt: new Date(Date.now() - 2000).toISOString(),
      nextRun: new Date(Date.now() - 2000).toISOString(),
    })
    scheduleStore.create({
      id: 'sched_work_4',
      headId: 'work',
      kind: 'task',
      taskName: 'noop',
      runAt: new Date(Date.now() - 1000).toISOString(),
      nextRun: new Date(Date.now() - 1000).toISOString(),
    })
    const evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
    evaluator.tick()

    // Direct inspection — pin head_id stamping for both schedules
    const rows = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'schedule_trigger' ORDER BY head_id",
    ).all() as Array<{ head_id: string }>
    expect(rows.length).toBe(2)
    expect(rows.map(r => r.head_id).sort()).toEqual(['default', 'work'])

    // Each head sees exactly its own event
    const defaultClaim = queueStore.claimNext('default')
    expect(defaultClaim).not.toBeNull()
    expect(defaultClaim!.event.type).toBe('schedule_trigger')

    const workClaim = queueStore.claimNext('work')
    expect(workClaim).not.toBeNull()
    expect(workClaim!.event.type).toBe('schedule_trigger')

    // No cross-head leak after each head claimed its own
    expect(queueStore.claimNext('default')).toBeNull()
    expect(queueStore.claimNext('work')).toBeNull()

    cleanup(db, dir)
  })

  it("legacy JSON file without headId migrates to 'default' on read; evaluator stamps head_id='default'", () => {
    const db = freshDb()
    const dir = freshScheduleDir()
    const queueStore = new QueueStore(db)

    // Write a legacy JSON file directly with no headId field. This shape
    // mirrors a pre-Phase-35 schedule on disk.
    const legacyId = 'sched_legacy_1'
    const now = new Date().toISOString()
    const overdueIso = new Date(Date.now() - 1000).toISOString()
    const legacyRaw = {
      id: legacyId,
      taskName: 'noop',
      kind: 'task',
      cron: null,
      runAt: overdueIso,
      enabled: true,
      lastRun: null,
      nextRun: overdueIso,
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: now,
      updatedAt: now,
    }
    fs.writeFileSync(path.join(dir, `${legacyId}.json`), JSON.stringify(legacyRaw, null, 2))

    const scheduleStore = new ScheduleStore(dir)

    // First list() must surface the legacy row with headId='default'
    const listed = scheduleStore.list()
    expect(listed.length).toBe(1)
    expect(listed[0]!.headId).toBe('default')

    // Tick the evaluator — the resulting queue_event must carry head_id='default'
    const evaluator = new ScheduleEvaluatorImpl(queueStore, scheduleStore, 'UTC', 999_999)
    evaluator.tick()

    const rows = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'schedule_trigger'",
    ).all() as Array<{ head_id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.head_id).toBe('default')

    cleanup(db, dir)
  })
})
