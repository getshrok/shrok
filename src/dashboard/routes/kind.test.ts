import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { FileSystemKindLoader } from '../../skills/loader.js'
import { createKindRouter } from './kind.js'

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

function startApp(mount: (app: express.Express) => void): Promise<{ port: number; server: Server }> {
  const app = express()
  app.use(express.json())
  // Simulate authenticated session for unit tests
  app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
  mount(app)
  return getFreePort().then(port =>
    new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => resolve({ port, server }))
      server.once('error', reject)
    })
  )
}

function seedEntry(root: string, name: string, marker: 'SKILL.md' | 'TASK.md', body = '') {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, marker),
    `---\nname: ${name}\ndescription: test ${name}\n---\n${body}`,
    'utf8',
  )
}

describe('createKindRouter', () => {
  let skillsRoot: string
  let jobsRoot: string
  let skillLoader: FileSystemKindLoader
  let jobLoader: FileSystemKindLoader
  let skillsServer: Server
  let jobsServer: Server
  let skillsPort: number
  let jobsPort: number

  beforeEach(async () => {
    skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-skills-'))
    jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-tasks-'))
    seedEntry(skillsRoot, 'foo', 'SKILL.md', 'skill-foo body')
    seedEntry(jobsRoot, 'bar', 'TASK.md', 'task-bar body')

    skillLoader = new FileSystemKindLoader({ root: skillsRoot, kind: 'skill', filename: 'SKILL.md' })
    jobLoader = new FileSystemKindLoader({ root: jobsRoot, kind: 'task', filename: 'TASK.md' })

    const s1 = await startApp(app => {
      app.use('/api/skills', createKindRouter(skillLoader, { kind: 'skill', notFoundLabel: 'Skill' }))
    })
    skillsPort = s1.port
    skillsServer = s1.server

    const s2 = await startApp(app => {
      app.use('/api/tasks', createKindRouter(jobLoader, { kind: 'task', notFoundLabel: 'Task' }))
    })
    jobsPort = s2.port
    jobsServer = s2.server
  })

  afterEach(async () => {
    await new Promise<void>(r => skillsServer.close(() => r()))
    await new Promise<void>(r => jobsServer.close(() => r()))
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(jobsRoot, { recursive: true, force: true })
  })

  it('Test 1: GET / returns { skills: [...] } for kind=skill', async () => {
    const r = await fetch(`http://127.0.0.1:${skillsPort}/api/skills`)
    const body = await r.json() as { skills: Array<{ name: string }> }
    expect(r.status).toBe(200)
    expect(Array.isArray(body.skills)).toBe(true)
    expect(body.skills.map(s => s.name)).toContain('foo')
  })

  it('Test 2: GET / returns { tasks: [...] } for kind=task', async () => {
    const r = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks`)
    const body = await r.json() as { tasks: Array<{ name: string }> }
    expect(r.status).toBe(200)
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(body.tasks.map(s => s.name)).toContain('bar')
  })

  it('Test 3: GET /:missing returns 404 with "Task not found" when kind=task', async () => {
    const r = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/missing-name`)
    expect(r.status).toBe(404)
    const body = await r.json() as { error: string }
    expect(body.error).toBe('Task not found')
  })

  it('Test 4: GET /:missing/files returns 404 with "Task not found" when kind=task', async () => {
    const r = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/missing-name/files`)
    expect(r.status).toBe(404)
    const body = await r.json() as { error: string }
    expect(body.error).toBe('Task not found')
  })

  it('Test 5: PUT /:name round-trips a write, GET returns updated content', async () => {
    const newContent = '---\nname: bar\ndescription: updated\n---\nnew body'
    const put = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/bar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    })
    expect(put.status).toBe(200)

    const get = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/bar`)
    expect(get.status).toBe(200)
    const body = await get.json() as { rawContent: string }
    expect(body.rawContent).toContain('new body')
  })

  it('Test 6: DELETE /:name removes the entry; subsequent GET returns 404', async () => {
    const del = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/bar`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const get = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/bar`)
    expect(get.status).toBe(404)
  })

  it('Test 7: invalid name (path traversal) returns 400 Invalid task name', async () => {
    const r = await fetch(`http://127.0.0.1:${jobsPort}/api/tasks/${encodeURIComponent('../etc')}`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toBe('Invalid task name')
  })
})
