import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ScheduleStore, type Schedule } from './schedules.js'

// ─── ScheduleStore — headId field, filter API, lazy migration ─────────────────

describe('ScheduleStore — headId', () => {
  let tmpDir: string
  let store: ScheduleStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-sched-'))
    store = new ScheduleStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Test 1: create persists headId from options ───────────────────────────

  it("create({ headId: 'work' }) persists headId on disk", () => {
    const s = store.create({
      id: 's1',
      headId: 'work',
      kind: 'task',
      taskName: 'x',
      runAt: '2026-01-01T00:00:00Z',
      nextRun: '2026-01-01T00:00:00Z',
    })
    expect(s.headId).toBe('work')

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 's1.json'), 'utf8')) as Schedule
    expect(raw.headId).toBe('work')
  })

  it("create({ headId: 'default' }) round-trips through get()", () => {
    store.create({
      id: 's-default',
      headId: 'default',
      kind: 'task',
      taskName: 'x',
      runAt: '2026-01-01T00:00:00Z',
      nextRun: '2026-01-01T00:00:00Z',
    })
    const s = store.get('s-default')
    expect(s).not.toBeNull()
    expect(s!.headId).toBe('default')
  })

  // ── Test 3: filtered list ─────────────────────────────────────────────────

  it("list() returns schedules across all heads in createdAt order", () => {
    store.create({ id: 's-a', headId: 'default', taskName: 'a', nextRun: '2026-01-01T00:00:00Z' })
    store.create({ id: 's-b', headId: 'work', taskName: 'b', nextRun: '2026-01-01T00:00:00Z' })
    store.create({ id: 's-c', headId: 'default', taskName: 'c', nextRun: '2026-01-01T00:00:00Z' })
    const all = store.list()
    expect(all.map(s => s.id).sort()).toEqual(['s-a', 's-b', 's-c'])
  })

  it("list({ headId: 'work' }) returns only matching schedules", () => {
    store.create({ id: 's-a', headId: 'default', taskName: 'a', nextRun: '2026-01-01T00:00:00Z' })
    store.create({ id: 's-b', headId: 'work', taskName: 'b', nextRun: '2026-01-01T00:00:00Z' })
    store.create({ id: 's-c', headId: 'work', taskName: 'c', nextRun: '2026-01-01T00:00:00Z' })
    const work = store.list({ headId: 'work' })
    expect(work).toHaveLength(2)
    expect(work.map(s => s.id).sort()).toEqual(['s-b', 's-c'])
    for (const s of work) expect(s.headId).toBe('work')
  })

  it("list({ headId: 'nonexistent' }) returns empty array", () => {
    store.create({ id: 's-a', headId: 'default', taskName: 'a', nextRun: '2026-01-01T00:00:00Z' })
    const none = store.list({ headId: 'nonexistent' })
    expect(none).toEqual([])
  })

  // ── Test 4: getDue is cross-head (no headId filter) ──────────────────────

  it("getDue(now) returns due schedules across all heads", () => {
    store.create({ id: 's-a', headId: 'default', taskName: 'a', cron: '*/3 * * * *', nextRun: '2025-01-01T00:00:00Z' })
    store.create({ id: 's-b', headId: 'work', taskName: 'b', cron: '*/3 * * * *', nextRun: '2025-01-01T00:00:00Z' })
    store.create({ id: 's-c', headId: 'work', taskName: 'c', cron: '*/3 * * * *', nextRun: '2099-01-01T00:00:00Z' })
    const due = store.getDue('2026-06-01T00:00:00Z')
    const ids = due.map(s => s.id).sort()
    expect(ids).toEqual(['s-a', 's-b'])
  })

  // ── Test 5: lazy migration stamps headId='default' idempotently ──────────

  it("first read of legacy JSON (no headId) stamps headId='default' and writes back", () => {
    const id = 'legacy-1'
    const legacy = {
      id,
      taskName: 'old-task',
      kind: 'task',
      cron: '*/5 * * * *',
      runAt: null,
      enabled: true,
      lastRun: null,
      nextRun: '2025-01-01T00:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')
    // Sanity: legacy file has no headId field
    const beforeRaw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect('headId' in beforeRaw).toBe(false)

    // First read: triggers migration, returns headId='default'
    const s = store.get(id)
    expect(s).not.toBeNull()
    expect(s!.headId).toBe('default')

    // After migration: file on disk has headId='default'
    const afterRaw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Schedule
    expect(afterRaw.headId).toBe('default')
  })

  it("second read of an already-migrated file does NOT rewrite (mtime stable)", async () => {
    const id = 'legacy-idempotent'
    const legacy = {
      id,
      taskName: 'old-task',
      kind: 'task',
      cron: null,
      runAt: '2025-01-01T00:00:00Z',
      enabled: true,
      lastRun: null,
      nextRun: '2025-01-01T00:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')

    // First read triggers migration write
    store.get(id)
    const mtimeAfterFirst = fs.statSync(filePath).mtimeMs
    const bytesAfterFirst = fs.readFileSync(filePath)

    // Sleep so any subsequent write would change mtime on most filesystems
    await new Promise(r => setTimeout(r, 50))

    // Second read: must not rewrite
    store.get(id)
    const mtimeAfterSecond = fs.statSync(filePath).mtimeMs
    const bytesAfterSecond = fs.readFileSync(filePath)

    // Third read: still no rewrite
    store.get(id)
    const mtimeAfterThird = fs.statSync(filePath).mtimeMs
    const bytesAfterThird = fs.readFileSync(filePath)

    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
    expect(mtimeAfterThird).toBe(mtimeAfterFirst)
    expect(bytesAfterSecond.equals(bytesAfterFirst)).toBe(true)
    expect(bytesAfterThird.equals(bytesAfterFirst)).toBe(true)
  })

  // ── Test 6: list() migrates every legacy file in the directory ───────────

  it("list() lazy-migrates ALL legacy files in the directory", () => {
    const legacyBase = {
      taskName: 'old-task',
      kind: 'task' as const,
      cron: null,
      runAt: '2025-01-01T00:00:00Z',
      enabled: true,
      lastRun: null,
      nextRun: '2025-01-01T00:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      fs.writeFileSync(
        path.join(tmpDir, `${id}.json`),
        JSON.stringify({ id, ...legacyBase }, null, 2) + '\n',
        'utf8',
      )
    }

    const all = store.list()
    expect(all).toHaveLength(3)
    for (const s of all) expect(s.headId).toBe('default')

    // Every file on disk now has headId='default'
    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${id}.json`), 'utf8'))
      expect(raw.headId).toBe('default')
    }
  })

  it("getDue() lazy-migrates legacy due files before returning", () => {
    const id = 'legacy-due'
    const legacy = {
      id,
      taskName: 'old-task',
      kind: 'task',
      cron: '*/3 * * * *',
      runAt: null,
      enabled: true,
      lastRun: null,
      nextRun: '2025-01-01T00:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')

    const due = store.getDue('2026-06-01T00:00:00Z')
    expect(due).toHaveLength(1)
    expect(due[0]!.headId).toBe('default')

    // File on disk migrated
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(raw.headId).toBe('default')
  })

  it("markFired on a legacy schedule migrates it (read path is migrated)", () => {
    const id = 'legacy-marked'
    const legacy = {
      id,
      taskName: 'old-task',
      kind: 'task',
      cron: '0 * * * *',
      runAt: null,
      enabled: true,
      lastRun: null,
      nextRun: '2025-01-01T00:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: null,
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')

    store.markFired(id, '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Schedule
    expect(raw.headId).toBe('default')
    expect(raw.lastRun).toBe('2026-01-01T01:00:00Z')
    expect(raw.nextRun).toBe('2026-01-01T02:00:00Z')
  })

  // ─── Plan 35-03 D-16: deleteAllForHead cascade helper ─────────────────────

  // ── Task 2 (Phase 37-01): ack field round-trip, inert-for-tasks, legacy migration, mtime-stable ──

  it("create reminder with requiresAck + nagIntervalMinutes round-trips through get()", () => {
    store.create({
      id: 'rem-ack',
      headId: 'default',
      kind: 'reminder',
      agentContext: 'Take your meds',
      requiresAck: true,
      nagIntervalMinutes: 60,
      runAt: '2099-01-01T09:00:00Z',
      nextRun: '2099-01-01T09:00:00Z',
    })
    const s = store.get('rem-ack')
    expect(s).not.toBeNull()
    expect(s!.requiresAck).toBe(true)
    expect(s!.nagIntervalMinutes).toBe(60)
  })

  it("create task without ack fields defaults requiresAck:false and nagIntervalMinutes:null (D-07 inert-for-tasks)", () => {
    store.create({
      id: 'task-no-ack',
      headId: 'default',
      kind: 'task',
      taskName: 'nightly-vacuum',
      runAt: '2099-01-01T00:00:00Z',
      nextRun: '2099-01-01T00:00:00Z',
    })
    const s = store.get('task-no-ack')
    expect(s).not.toBeNull()
    expect(s!.requiresAck).toBe(false)
    expect(s!.nagIntervalMinutes).toBeNull()
  })

  it("first read of legacy reminder JSON (no ack fields) stamps defaults and reminder is still due (SC2 / ACK-09 legacy migration)", () => {
    const id = 'legacy-reminder-ack'
    const legacy = {
      id,
      headId: 'default',
      taskName: null,
      kind: 'reminder',
      cron: null,
      runAt: '2025-06-01T09:00:00Z',
      enabled: true,
      lastRun: null,
      nextRun: '2025-06-01T09:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: 'Doctor appointment',
      cronTimezone: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')

    // Sanity: legacy file has no ack fields
    const beforeRaw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect('requiresAck' in beforeRaw).toBe(false)
    expect('nagIntervalMinutes' in beforeRaw).toBe(false)

    // First read: triggers migration, returns stamped defaults
    const s = store.get(id)
    expect(s).not.toBeNull()
    expect(s!.requiresAck).toBe(false)
    expect(s!.nagIntervalMinutes).toBeNull()

    // After migration: file on disk has the new fields stamped
    const afterRaw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Schedule
    expect(afterRaw.requiresAck).toBe(false)
    expect(afterRaw.nagIntervalMinutes).toBeNull()

    // Still fires / still due (nextRun in past, enabled)
    const due = store.getDue('2026-06-01T00:00:00Z')
    const dueIds = due.map(s => s.id)
    expect(dueIds).toContain(id)
  })

  it("first read of a fully-populated row (all new fields present) does NOT rewrite (mtime stable — D-08 fully-populated no-rewrite)", async () => {
    const id = 'fully-populated'
    const full = {
      id,
      headId: 'default',
      taskName: null,
      kind: 'reminder',
      cron: null,
      runAt: '2099-01-01T09:00:00Z',
      enabled: true,
      lastRun: null,
      nextRun: '2099-01-01T09:00:00Z',
      lastSkipped: null,
      lastSkipReason: null,
      conditions: null,
      agentContext: 'Already migrated',
      cronTimezone: null,
      requiresAck: true,
      nagIntervalMinutes: 30,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2) + '\n', 'utf8')

    const mtimeBefore = fs.statSync(filePath).mtimeMs
    const bytesBefore = fs.readFileSync(filePath)

    // Sleep so any write would change mtime on most filesystems
    await new Promise(r => setTimeout(r, 50))

    // First read: must NOT rewrite (all fields present → migrated:false)
    store.get(id)
    const mtimeAfterFirst = fs.statSync(filePath).mtimeMs
    const bytesAfterFirst = fs.readFileSync(filePath)

    expect(mtimeAfterFirst).toBe(mtimeBefore)
    expect(bytesAfterFirst.equals(bytesBefore)).toBe(true)
  })

  // ─── Plan 35-03 D-16: deleteAllForHead cascade helper ─────────────────────

  it("deleteAllForHead removes only the target head's entries and returns split counts (schedules + reminders)", () => {
    // 'work' head: 2 task schedules + 1 reminder.
    store.create({ id: 'w-t1', headId: 'work', kind: 'task', taskName: 't1', runAt: '2026-01-01T00:00:00Z' })
    store.create({ id: 'w-t2', headId: 'work', kind: 'task', taskName: 't2', runAt: '2026-01-02T00:00:00Z' })
    store.create({ id: 'w-r1', headId: 'work', kind: 'reminder', agentContext: 'r1', runAt: '2026-01-03T00:00:00Z' })
    // 'default' head: 1 task + 1 reminder. Must stay intact.
    store.create({ id: 'd-t1', headId: 'default', kind: 'task', taskName: 't1', runAt: '2026-01-04T00:00:00Z' })
    store.create({ id: 'd-r1', headId: 'default', kind: 'reminder', agentContext: 'r1', runAt: '2026-01-05T00:00:00Z' })

    const result = store.deleteAllForHead('work')
    expect(result).toEqual({ schedules: 2, reminders: 1 })

    const remaining = store.list()
    expect(remaining.map(s => s.id).sort()).toEqual(['d-r1', 'd-t1'])
  })

  it("deleteAllForHead returns { schedules: 0, reminders: 0 } for an unknown headId", () => {
    store.create({ id: 'd-t1', headId: 'default', kind: 'task', taskName: 't1', runAt: '2026-01-01T00:00:00Z' })
    const result = store.deleteAllForHead('nonexistent-head')
    expect(result).toEqual({ schedules: 0, reminders: 0 })
    // Existing data untouched
    expect(store.list().map(s => s.id)).toEqual(['d-t1'])
  })

  it("deleteAllForHead is idempotent — second call returns zeros", () => {
    store.create({ id: 'w-t1', headId: 'work', kind: 'task', taskName: 't1', runAt: '2026-01-01T00:00:00Z' })
    store.create({ id: 'w-r1', headId: 'work', kind: 'reminder', agentContext: 'r1', runAt: '2026-01-02T00:00:00Z' })

    const first = store.deleteAllForHead('work')
    expect(first).toEqual({ schedules: 1, reminders: 1 })

    const second = store.deleteAllForHead('work')
    expect(second).toEqual({ schedules: 0, reminders: 0 })
  })
})
