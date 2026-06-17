import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import type { SensorRunner } from '../../sensors/runner.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

describe('createSensorsRouter', () => {
  // Import lazily to allow test to fail in RED phase with missing module
  let createSensorsRouter: (opts: { workspacePath: string; sensorRunner: SensorRunner }) => import('express').Router
  let tmpDir: string
  let server: Server | null = null
  let port = 0
  let runCalls: string[] = []

  const sensorRunner: SensorRunner = {
    run: async (slug: string): Promise<void> => {
      runCalls.push(slug)
    },
  }

  beforeEach(async () => {
    // Dynamic import so tests fail cleanly if module doesn't exist
    const mod = await import('./sensors.js')
    createSensorsRouter = mod.createSensorsRouter

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensors-route-test-'))
    runCalls = []

    const app = express()
    app.use(express.json())
    // Auth bypass: set res.locals.authenticated = true before the router
    app.use((_req, res, next) => {
      res.locals['authenticated'] = true
      next()
    })
    app.use('/api/sensors', createSensorsRouter({ workspacePath: tmpDir, sensorRunner }))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server!.once('error', reject)
    })
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>(r => server!.close(() => r()))
      server = null
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── GET / ────────────────────────────────────────────────────────────────

  it('SENSOR-LIST-01: fresh workspace (no sensors dir) → 200 + {sensors:[]}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors`)
    expect(res.status).toBe(200)
    const body = await res.json() as { sensors: unknown[] }
    expect(body.sensors).toEqual([])
  })

  it('SENSOR-LIST-02: lists slugs from filesystem after PUT', async () => {
    // Create via PUT first
    await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'process.stdout.write("hi")' }),
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors`)
    expect(res.status).toBe(200)
    const body = await res.json() as { sensors: Array<{ slug: string }> }
    expect(body.sensors.map(s => s.slug)).toContain('weather')
  })

  // ─── PUT /:slug ───────────────────────────────────────────────────────────

  it('SENSOR-PUT-01: writes sensor.mjs to disk and calls sensorRunner.run once', async () => {
    const content = 'process.stdout.write("weather data")'
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { slug: string }
    expect(body.slug).toBe('weather')

    // File must be written on disk
    const scriptPath = path.join(tmpDir, 'sensors', 'weather', 'sensor.mjs')
    expect(fs.existsSync(scriptPath)).toBe(true)
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(content)

    // Runner must have been called exactly once
    expect(runCalls).toEqual(['weather'])
  })

  it('SENSOR-PUT-02: PUT a second time overwrites the existing file', async () => {
    const first = 'process.stdout.write("v1")'
    const second = 'process.stdout.write("v2")'
    await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: first }),
    })
    await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: second }),
    })
    const scriptPath = path.join(tmpDir, 'sensors', 'weather', 'sensor.mjs')
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(second)
    // Runner called twice (once per PUT)
    expect(runCalls).toEqual(['weather', 'weather'])
  })

  it('SENSOR-PUT-03: missing content body → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 42 }), // not a string
    })
    expect(res.status).toBe(400)
  })

  // ─── GET /:slug ───────────────────────────────────────────────────────────

  it('SENSOR-GET-01: reads content from the live filesystem', async () => {
    // Write file DIRECTLY to disk (not via the API) — proves filesystem-as-truth
    const scriptDir = path.join(tmpDir, 'sensors', 'direct')
    fs.mkdirSync(scriptDir, { recursive: true })
    const directContent = 'process.stdout.write("direct")'
    fs.writeFileSync(path.join(scriptDir, 'sensor.mjs'), directContent, 'utf8')

    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/direct`)
    expect(res.status).toBe(200)
    const body = await res.json() as { slug: string; content: string }
    expect(body.slug).toBe('direct')
    expect(body.content).toBe(directContent)
  })

  it('SENSOR-GET-02: 404 when sensor does not exist', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/nonexistent`)
    expect(res.status).toBe(404)
  })

  // ─── DELETE /:slug ────────────────────────────────────────────────────────

  it('SENSOR-DELETE-01: removes script dir AND ambient md file', async () => {
    // Create sensor via PUT
    await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'process.stdout.write("hi")' }),
    })
    // Pre-create the ambient file (as the runner would after a real run)
    const ambientDir = path.join(tmpDir, 'ambient')
    fs.mkdirSync(ambientDir, { recursive: true })
    fs.writeFileSync(path.join(ambientDir, 'weather.md'), 'weather data', 'utf8')

    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    // Script dir must be gone
    const scriptDir = path.join(tmpDir, 'sensors', 'weather')
    expect(fs.existsSync(scriptDir)).toBe(false)

    // Ambient file must be gone
    expect(fs.existsSync(path.join(ambientDir, 'weather.md'))).toBe(false)
  })

  it('SENSOR-DELETE-02: DELETE when ambient file absent does NOT throw', async () => {
    // Create sensor via PUT (no ambient file exists yet)
    await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'process.stdout.write("hi")' }),
    })
    // Delete without pre-creating ambient file
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/weather`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  // ─── Slug guard ───────────────────────────────────────────────────────────

  it('SENSOR-SLUG-01: invalid slug (path traversal) → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/..%2Fetc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('SENSOR-SLUG-02: uppercase slug → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/Weather`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('SENSOR-SLUG-03: invalid slug on GET → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/..evil`)
    expect(res.status).toBe(400)
  })

  it('SENSOR-SLUG-04: invalid slug on DELETE → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sensors/..evil`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(400)
  })

  // ─── Auth guard ───────────────────────────────────────────────────────────

  it('SENSOR-AUTH-01: without auth middleware, GET / returns 401', async () => {
    // Start a separate app WITHOUT the auth bypass middleware
    const unauthApp = express()
    unauthApp.use(express.json())
    // No res.locals.authenticated = true middleware here
    unauthApp.use('/api/sensors', createSensorsRouter({ workspacePath: tmpDir, sensorRunner }))

    const unauthPort = await getFreePort()
    let unauthServer: Server | null = null
    await new Promise<void>((resolve, reject) => {
      unauthServer = unauthApp.listen(unauthPort, '127.0.0.1', () => resolve())
      unauthServer!.once('error', reject)
    })
    try {
      const res = await fetch(`http://127.0.0.1:${unauthPort}/api/sensors`)
      expect(res.status).toBe(401)
    } finally {
      await new Promise<void>(r => unauthServer!.close(() => r()))
    }
  })
})
