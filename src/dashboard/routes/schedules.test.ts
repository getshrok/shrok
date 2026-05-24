import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { ScheduleStore } from '../../db/schedules.js'
import { FileSystemKindLoader } from '../../skills/loader.js'
import { UnifiedLoader } from '../../skills/unified.js'
import { createSchedulesRouter } from './schedules.js'
import { CADENCE_ERROR_MESSAGE } from '../../scheduler/cadence.js'


async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

function seedEntry(root: string, name: string, marker: 'SKILL.md' | 'TASK.md') {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, marker),
    `---\nname: ${name}\ndescription: test ${name}\n---\nbody`,
    'utf8',
  )
}

describe('POST /api/schedules kind validation', () => {
  let skillsRoot: string
  let tasksRoot: string
  let storeDir: string
  let store: ScheduleStore
  let unified: UnifiedLoader
  let server: Server
  let port: number

  beforeEach(async () => {
    skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-skills-'))
    tasksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-tasks-'))
    seedEntry(skillsRoot, 'existing-skill', 'SKILL.md')
    seedEntry(tasksRoot, 'existing-task', 'TASK.md')

    const skillLoader = new FileSystemKindLoader({ root: skillsRoot, kind: 'skill', filename: 'SKILL.md' })
    const taskLoader = new FileSystemKindLoader({ root: tasksRoot, kind: 'task', filename: 'TASK.md' })
    unified = new UnifiedLoader(skillLoader, taskLoader)

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'))
    store = new ScheduleStore(storeDir)

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => {
      res.locals['authenticated'] = true
      next()
    })
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', () => [{ id: 'default' }], unified))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(tasksRoot, { recursive: true, force: true })
    fs.rmSync(storeDir, { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  it("Test A: kind='skill' → 400 mentioning kind; no row inserted", async () => {
    const before = store.list().length
    const r = await post({ taskName: 'existing-task', kind: 'skill', cron: '* * * * *', headId: 'default' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('kind')
    expect(store.list().length).toBe(before)
  })

  it("Test A2: kind='reminder' → 200, persists kind='reminder' with agentContext", async () => {
    const r = await post({ kind: 'reminder', agentContext: 'Remember to review goals', cron: '0 9 * * *', headId: 'default' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string; taskName: string | null; agentContext: string } }).schedule
    expect(schedule.kind).toBe('reminder')
    expect(schedule.taskName).toBeNull()
    expect(schedule.agentContext).toBe('Remember to review goals')
  })

  it("Test B: kind omitted + valid task target → 200, persists kind='task'", async () => {
    const r = await post({ taskName: 'existing-task', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string } }).schedule
    expect(schedule.kind).toBe('task')
  })

  it('Test C: kind omitted + unknown target → 400 (tasks-only validates when kind absent)', async () => {
    const r = await post({ taskName: 'does-not-exist', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error
    expect(err.toLowerCase()).toMatch(/unknown|not found/)
  })

  it("Test D: kind='task' with valid task target → 200, kind='task'", async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string } }).schedule
    expect(schedule.kind).toBe('task')
  })

  it("Test E: kind='bogus' → 400 mentioning kind", async () => {
    const r = await post({ kind: 'bogus', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error
    expect(err.toLowerCase()).toContain('kind')
  })

  it("Test F: kind='task' + unknown task name → 400", async () => {
    const r = await post({ taskName: 'nope', kind: 'task', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error
    expect(err.toLowerCase()).toMatch(/unknown|not found/)
  })
})

describe('cadence validation (POST + PATCH /api/schedules)', () => {
  let skillsRoot: string
  let tasksRoot: string
  let storeDir: string
  let store: ScheduleStore
  let unified: UnifiedLoader
  let server: Server
  let port: number

  beforeEach(async () => {
    skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-skills-'))
    tasksRoot  = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-tasks-'))
    seedEntry(skillsRoot, 'existing-skill', 'SKILL.md')
    seedEntry(tasksRoot, 'existing-task', 'TASK.md')

    const skillLoader = new FileSystemKindLoader({ root: skillsRoot, kind: 'skill', filename: 'SKILL.md' })
    const taskLoader  = new FileSystemKindLoader({ root: tasksRoot,  kind: 'task',  filename: 'TASK.md' })
    unified = new UnifiedLoader(skillLoader, taskLoader)

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-store-'))
    store = new ScheduleStore(storeDir)

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', () => [{ id: 'default' }], unified))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(tasksRoot,  { recursive: true, force: true })
    fs.rmSync(storeDir,   { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  // ─── POST (create) ─────────────────────────────────────────────────

  it('POST rejects */7 * * * * with 400 and the locked CADENCE_ERROR_MESSAGE', async () => {
    const before = store.list().length
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/7 * * * *', headId: 'default' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)
    expect((r.data as { error: string }).error).toContain('conditions')
    expect(store.list().length).toBe(before)
  })

  it('POST accepts 0 9 * * 1-5 (weekdays Mon–Fri, phase 23 expansion) with 200', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 * * 1-5', headId: 'default' })
    expect(r.status).toBe(200)
  })

  it('POST rejects 0 9 29 * * (day-of-month > 28) with 400', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 29 * *', headId: 'default' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)
  })

  it('POST accepts */30 * * * * (supported cadence) with 200', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *', headId: 'default' })
    expect(r.status).toBe(200)
    const s = (r.data as { schedule: { cron: string } }).schedule
    expect(s.cron).toBe('*/30 * * * *')
  })

  it('POST accepts 0 9 * * 1 (weekly Monday 09:00) with 200', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 * * 1', headId: 'default' })
    expect(r.status).toBe(200)
  })

  // ─── PATCH (update) ────────────────────────────────────────────────

  it('PATCH rejects non-cadence cron with 400 and leaves the row unchanged', async () => {
    const created = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *', headId: 'default' })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { cron: '*/7 * * * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)

    // Confirm the original cron was NOT overwritten
    const still = store.list().find(s => s.id === id)
    expect(still?.cron).toBe('*/30 * * * *')
  })

  it('PATCH accepts a supported cadence update with 200', async () => {
    const created = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *', headId: 'default' })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { cron: '0 9 * * 1' })
    expect(r.status).toBe(200)
    const s = (r.data as { schedule: { cron: string } }).schedule
    expect(s.cron).toBe('0 9 * * 1')
  })
})

// ─── Plan 35-03 Task 1: headId required on POST, cross-head GET, headId rejected on PATCH ─

describe('headId routing (Plan 35-03 D-11/D-12/D-13)', () => {
  let skillsRoot: string
  let tasksRoot: string
  let storeDir: string
  let store: ScheduleStore
  let unified: UnifiedLoader
  let server: Server
  let port: number

  beforeEach(async () => {
    skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched35-skills-'))
    tasksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched35-tasks-'))
    seedEntry(skillsRoot, 'existing-skill', 'SKILL.md')
    seedEntry(tasksRoot, 'existing-task', 'TASK.md')

    const skillLoader = new FileSystemKindLoader({ root: skillsRoot, kind: 'skill', filename: 'SKILL.md' })
    const taskLoader = new FileSystemKindLoader({ root: tasksRoot, kind: 'task', filename: 'TASK.md' })
    unified = new UnifiedLoader(skillLoader, taskLoader)

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched35-store-'))
    store = new ScheduleStore(storeDir)

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    // Two known heads — 'default' and 'work'.
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', () => [{ id: 'default' }, { id: 'work' }], unified))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(tasksRoot, { recursive: true, force: true })
    fs.rmSync(storeDir, { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  async function getAll() {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules`)
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  it('Test 1 (D-11 happy): POST with valid headId returns 200 + persists headId', async () => {
    const r = await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *', headId: 'work' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { id: string; headId: string } }).schedule
    expect(schedule.headId).toBe('work')
    // Persisted state on disk
    const persisted = store.get(schedule.id)
    expect(persisted).not.toBeNull()
    expect(persisted!.headId).toBe('work')
  })

  it('Test 2 (D-11 missing): POST without headId returns 400 mentioning "headId is required"', async () => {
    const r = await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toContain('headId is required')
  })

  it('Test 3 (D-11 unknown): POST with unknown headId returns 404 mentioning "head"', async () => {
    const r = await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *', headId: 'nonexistent' })
    expect(r.status).toBe(404)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('head')
  })

  it('Test 4 (D-12 cross-head GET): GET returns schedules across all heads, each tagged with headId', async () => {
    await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *', headId: 'default' })
    await post({ kind: 'task', taskName: 'existing-task', cron: '*/10 * * * *', headId: 'work' })
    const r = await getAll()
    expect(r.status).toBe(200)
    const schedules = (r.data as { schedules: Array<{ headId: string }> }).schedules
    expect(schedules.length).toBe(2)
    const headIds = schedules.map(s => s.headId).sort()
    expect(headIds).toEqual(['default', 'work'])
    // Each entry carries headId field
    for (const s of schedules) {
      expect(typeof s.headId).toBe('string')
    }
  })

  it('Test 5 (D-13 PATCH reject): PATCH with headId returns 400 and does NOT touch the row', async () => {
    const created = await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *', headId: 'default' })
    const id = (created.data as { schedule: { id: string } }).schedule.id
    const before = store.get(id)
    expect(before).not.toBeNull()
    const beforeUpdatedAt = before!.updatedAt

    const r = await patch(id, { headId: 'work' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toContain('headId cannot be reassigned')

    // Row on disk unchanged
    const after = store.get(id)
    expect(after!.headId).toBe('default')
    expect(after!.updatedAt).toBe(beforeUpdatedAt)
  })

  it('Test 6 (D-13 PATCH happy): PATCH without headId still works (enabled toggle)', async () => {
    const created = await post({ kind: 'task', taskName: 'existing-task', cron: '*/5 * * * *', headId: 'default' })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { enabled: false })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { enabled: boolean; headId: string } }).schedule
    expect(schedule.enabled).toBe(false)
    expect(schedule.headId).toBe('default')
  })
})

// ─── Plan 39-01: ack/nag coupling, startAt->nextRun, D-12, D-04 standalone-nag ─

describe('ack/nag validation, startAt, and D-12 (Plan 39-01)', () => {
  let skillsRoot: string
  let tasksRoot: string
  let storeDir: string
  let store: ScheduleStore
  let unified: UnifiedLoader
  let server: Server
  let port: number

  beforeEach(async () => {
    skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched39-skills-'))
    tasksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched39-tasks-'))
    seedEntry(skillsRoot, 'existing-skill', 'SKILL.md')
    seedEntry(tasksRoot, 'existing-task', 'TASK.md')

    const skillLoader = new FileSystemKindLoader({ root: skillsRoot, kind: 'skill', filename: 'SKILL.md' })
    const taskLoader = new FileSystemKindLoader({ root: tasksRoot, kind: 'task', filename: 'TASK.md' })
    unified = new UnifiedLoader(skillLoader, taskLoader)

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched39-store-'))
    store = new ScheduleStore(storeDir)

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', () => [{ id: 'default' }], unified))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(tasksRoot, { recursive: true, force: true })
    fs.rmSync(storeDir, { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`http://127.0.0.1:${port}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  // ── POST: ack+nag happy path ─────────────────────────────────────────────────

  it('POST reminder with requiresAck:true + nagIntervalMinutes:60 → 200, fields persisted', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Take meds', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 60,
    })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { requiresAck: boolean; nagIntervalMinutes: number } }).schedule
    expect(schedule.requiresAck).toBe(true)
    expect(schedule.nagIntervalMinutes).toBe(60)
  })

  // ── POST: coupling errors ────────────────────────────────────────────────────

  it('POST reminder with requiresAck:true and no nagIntervalMinutes → 400 mentions "nag"', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true,
    })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('nag')
  })

  it('POST reminder with requiresAck:true and nagIntervalMinutes:0 → 400 mentions "nag"', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 0,
    })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('nag')
  })

  it('POST reminder with nagIntervalMinutes > 0 and requiresAck:false → 400 mentions ack/coupling', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: false, nagIntervalMinutes: 30,
    })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error.toLowerCase()
    expect(err.match(/ack|coupling|only applies/)).toBeTruthy()
  })

  it('POST reminder with nagIntervalMinutes > 0 and requiresAck omitted → 400 mentions ack/coupling', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', nagIntervalMinutes: 30,
    })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error.toLowerCase()
    expect(err.match(/ack|coupling|only applies/)).toBeTruthy()
  })

  it('POST reminder with requiresAck:true and nagIntervalMinutes:1 → 200 (floor boundary)', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 1,
    })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { requiresAck: boolean; nagIntervalMinutes: number } }).schedule
    expect(schedule.requiresAck).toBe(true)
    expect(schedule.nagIntervalMinutes).toBe(1)
  })

  // ── POST: ceiling error ──────────────────────────────────────────────────────

  it('POST reminder with nagIntervalMinutes:43201 → 400 mentions "30 days" or "43200"', async () => {
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 43201,
    })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error.toLowerCase()
    expect(err.match(/30 days|43200/)).toBeTruthy()
  })

  // ── POST: startAt -> nextRun mapping (D-10) ──────────────────────────────────

  it('POST reminder with cron + future startAt → 200; nextRun===startAt, cron retained', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString()
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', startAt: futureDate,
    })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { nextRun: string; cron: string } }).schedule
    expect(schedule.nextRun).toBe(futureDate)
    expect(schedule.cron).toBe('0 9 * * *')
  })

  it('POST reminder with cron + past startAt → 400 mentions future/startAt', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString()
    const r = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', startAt: pastDate,
    })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error.toLowerCase()
    expect(err.match(/future|startat/)).toBeTruthy()
  })

  // ── PATCH: requiresAck/nagIntervalMinutes round-trip (D-11) ─────────────────

  it('PATCH reminder updates requiresAck:true + nagIntervalMinutes:120 → 200', async () => {
    const created = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default',
    })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { requiresAck: true, nagIntervalMinutes: 120 })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { requiresAck: boolean; nagIntervalMinutes: number } }).schedule
    expect(schedule.requiresAck).toBe(true)
    expect(schedule.nagIntervalMinutes).toBe(120)
  })

  it('PATCH reminder requiresAck:false → 200; nagIntervalMinutes becomes null', async () => {
    const created = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 60,
    })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { requiresAck: false })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { requiresAck: boolean; nagIntervalMinutes: number | null } }).schedule
    expect(schedule.requiresAck).toBe(false)
    expect(schedule.nagIntervalMinutes).toBeNull()
  })

  // ── PATCH: standalone-nag coupling guard (D-04) ──────────────────────────────

  it('PATCH standalone { nagIntervalMinutes: 0 } on ack-required reminder → 400 mentions "nag"', async () => {
    // Create an ack-required reminder
    const created = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 60,
    })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    // PATCH with only nagIntervalMinutes=0 (requiresAck ABSENT from body)
    const r = await patch(id, { nagIntervalMinutes: 0 })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('nag')
  })

  it('PATCH standalone { nagIntervalMinutes: 120 } on ack-required reminder → 200', async () => {
    const created = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default', requiresAck: true, nagIntervalMinutes: 60,
    })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { nagIntervalMinutes: 120 })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { nagIntervalMinutes: number } }).schedule
    expect(schedule.nagIntervalMinutes).toBe(120)
  })

  it('PATCH standalone { nagIntervalMinutes: 0 } on NON-ack reminder → 200 (no coupling to violate)', async () => {
    const created = await post({
      kind: 'reminder', agentContext: 'Test', cron: '0 9 * * *',
      headId: 'default',
    })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    // Non-ack reminder with nag=0 bare patch → should succeed (no coupling violated)
    // Note: nagIntervalMinutes: 0 on a non-ack reminder — the coupling check only fires
    // if the stored row has requiresAck===true
    const r = await patch(id, { nagIntervalMinutes: 0 })
    expect(r.status).toBe(200)
  })
})
