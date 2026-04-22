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
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', unified))

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
    const r = await post({ taskName: 'existing-task', kind: 'skill', cron: '* * * * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error.toLowerCase()).toContain('kind')
    expect(store.list().length).toBe(before)
  })

  it("Test A2: kind='reminder' → 200, persists kind='reminder' with agentContext", async () => {
    const r = await post({ kind: 'reminder', agentContext: 'Remember to review goals', cron: '0 9 * * *' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string; taskName: string | null; agentContext: string } }).schedule
    expect(schedule.kind).toBe('reminder')
    expect(schedule.taskName).toBeNull()
    expect(schedule.agentContext).toBe('Remember to review goals')
  })

  it("Test B: kind omitted + valid task target → 200, persists kind='task'", async () => {
    const r = await post({ taskName: 'existing-task', cron: '*/30 * * * *' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string } }).schedule
    expect(schedule.kind).toBe('task')
  })

  it('Test C: kind omitted + unknown target → 400 (tasks-only validates when kind absent)', async () => {
    const r = await post({ taskName: 'does-not-exist', cron: '*/30 * * * *' })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error
    expect(err.toLowerCase()).toMatch(/unknown|not found/)
  })

  it("Test D: kind='task' with valid task target → 200, kind='task'", async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *' })
    expect(r.status).toBe(200)
    const schedule = (r.data as { schedule: { kind: string } }).schedule
    expect(schedule.kind).toBe('task')
  })

  it("Test E: kind='bogus' → 400 mentioning kind", async () => {
    const r = await post({ kind: 'bogus', cron: '*/30 * * * *' })
    expect(r.status).toBe(400)
    const err = (r.data as { error: string }).error
    expect(err.toLowerCase()).toContain('kind')
  })

  it("Test F: kind='task' + unknown task name → 400", async () => {
    const r = await post({ taskName: 'nope', kind: 'task', cron: '*/30 * * * *' })
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
    app.use('/api/schedules', createSchedulesRouter(store, 'UTC', unified))

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
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/7 * * * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)
    expect((r.data as { error: string }).error).toContain('conditions')
    expect(store.list().length).toBe(before)
  })

  it('POST rejects 0 9 * * 1-5 (weekday range) with 400', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 * * 1-5' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)
  })

  it('POST rejects 0 9 29 * * (day-of-month > 28) with 400', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 29 * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)
  })

  it('POST accepts */30 * * * * (supported cadence) with 200', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *' })
    expect(r.status).toBe(200)
    const s = (r.data as { schedule: { cron: string } }).schedule
    expect(s.cron).toBe('*/30 * * * *')
  })

  it('POST accepts 0 9 * * 1 (weekly Monday 09:00) with 200', async () => {
    const r = await post({ taskName: 'existing-task', kind: 'task', cron: '0 9 * * 1' })
    expect(r.status).toBe(200)
  })

  // ─── PATCH (update) ────────────────────────────────────────────────

  it('PATCH rejects non-cadence cron with 400 and leaves the row unchanged', async () => {
    const created = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *' })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { cron: '*/7 * * * *' })
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toBe(CADENCE_ERROR_MESSAGE)

    // Confirm the original cron was NOT overwritten
    const still = store.list().find(s => s.id === id)
    expect(still?.cron).toBe('*/30 * * * *')
  })

  it('PATCH accepts a supported cadence update with 200', async () => {
    const created = await post({ taskName: 'existing-task', kind: 'task', cron: '*/30 * * * *' })
    const id = (created.data as { schedule: { id: string } }).schedule.id

    const r = await patch(id, { cron: '0 9 * * 1' })
    expect(r.status).toBe(200)
    const s = (r.data as { schedule: { cron: string } }).schedule
    expect(s.cron).toBe('0 9 * * 1')
  })
})
