// src/apps/integration.test.ts
//
// End-to-end integration test for the app-serving subsystem (Phase 55, Plan 04).
//
// Replicates the full dashboard middleware stack (express.json + auth bypass +
// CSRF middleware with /apps/ carve-out) and drives a real Express server on a
// free port to verify all five Phase-55 success criteria:
//
//   APPSRV-01  page HTML: shell rendered with slug/title; __SLUG__ tokens removed
//   APPSRV-02  GET/POST wire: {ok:true, vm, state}; POST action round-trips
//   APPSRV-04  error boundary: broken app → 500, counter unaffected, process alive
//   APPSRV-05  sqlite persistence + per-app isolation: direct DatabaseSync read
//   APPSRV-06  hot discovery: app created after listen is found with no restart
//
// Also covers:
//   D-08       CSRF carve-out: POST with sec-fetch-site:cross-site reaches /apps/*
//   TRAVERSAL  SLUG_RE / reserved-prefix guards return 404
//   ENUM       listApps covers all pre-written fixtures

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import type { Server } from 'node:http'
import { createAppsRouter } from './router.js'
import { requireSameOrigin } from '../dashboard/auth.js'

// ── Free-port helper ─────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close((err) => (err ? reject(err) : resolve(addr.port)))
    })
    srv.once('error', reject)
  })
}

// ── Fixture writers ──────────────────────────────────────────────────────────
//
// All fixtures are .mjs so Node loads them natively without tsx transpilation
// (D-11b). They import the REAL @ashley-shrok/viewmodel-shell/server via the
// workspace symlink that createAppsRouter ensures at construction (D-11).

/**
 * Integer counter — exercises GET wire, POST wire, and sqlite persistence (D-11a).
 * The database file is co-located at apps/counter/data.sqlite.
 */
function writeCounterApp(workspacePath: string): void {
  const dir = path.join(workspacePath, 'apps', 'counter')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Counter App', desc: 'An integer counter' }))
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `import { createAction } from '@ashley-shrok/viewmodel-shell/server'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(new URL('./data.sqlite', import.meta.url).pathname)
db.exec('PRAGMA journal_mode=WAL')
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)')
db.exec("INSERT OR IGNORE INTO kv (k,v) VALUES ('count',0)")

function snapshot() {
  const row = db.prepare("SELECT v FROM kv WHERE k='count'").get()
  return { vm: { type: 'page', title: 'Counter App', children: [] }, state: { count: row.v } }
}

export function get() { return snapshot() }

export const action = createAction(async (payload) => {
  if (payload.name === 'increment') db.prepare("UPDATE kv SET v=v+1 WHERE k='count'").run()
  return snapshot()
})
`
  )
}

/**
 * Notes app — uses a separate sqlite (notes table, NOT kv) to prove per-app
 * database isolation (APPSRV-05b).
 */
function writeNotes2App(workspacePath: string): void {
  const dir = path.join(workspacePath, 'apps', 'notes2')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Notes 2' }))
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `import { createAction } from '@ashley-shrok/viewmodel-shell/server'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(new URL('./data.sqlite', import.meta.url).pathname)
db.exec('PRAGMA journal_mode=WAL')
db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)')

function snapshot() {
  const rows = db.prepare("SELECT id, text FROM notes ORDER BY id").all()
  return { vm: { type: 'page', title: 'Notes 2', children: [] }, state: { notes: rows } }
}

export function get() { return snapshot() }

export const action = createAction(async (payload) => {
  if (payload.name === 'add-note') {
    const text = payload.state && typeof payload.state === 'object' && 'text' in payload.state
      ? String(payload.state.text)
      : ''
    db.prepare("INSERT INTO notes (text) VALUES (?)").run(text)
  }
  return snapshot()
})
`
  )
}

/** Throws at import time — exercises the D-09 error boundary (APPSRV-04). */
function writeBrokenApp(workspacePath: string): void {
  const dir = path.join(workspacePath, 'apps', 'broken')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Broken' }))
  fs.writeFileSync(path.join(dir, 'app.mjs'), `throw new Error('intentional load failure')`)
}

/**
 * A stateless app written AFTER the server starts.
 * Confirms hot discovery (APPSRV-06): new slugs have no cache entry so they
 * are loaded on the next request with no server restart.
 */
function writeLateApp(workspacePath: string): void {
  const dir = path.join(workspacePath, 'apps', 'late')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Late App' }))
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `import { createAction } from '@ashley-shrok/viewmodel-shell/server'
export function get() {
  return { vm: { type: 'page', title: 'Late App', children: [] }, state: { hello: 'world' } }
}
export const action = createAction(async () => {
  return { vm: { type: 'page', title: 'Late App', children: [] }, state: { hello: 'world' } }
})
`
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Apps subsystem — end-to-end integration (Plan 04)', () => {
  let tmpDir: string
  let server: Server | null = null
  let port = 0

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsint-'))
    writeCounterApp(tmpDir)
    writeNotes2App(tmpDir)
    writeBrokenApp(tmpDir)
    // writeLateApp is NOT called here; it is written mid-test in APPSRV-06.

    const app = express()
    app.use(express.json())

    // Auth bypass: sets res.locals.authenticated so requireAuth passes without
    // a real session cookie or token store (matches the sensor test pattern).
    app.use((_req, res, next) => {
      res.locals['authenticated'] = true
      next()
    })

    // ── CSRF middleware — mirrors server.ts:175-179 exactly, including D-08 ──
    // The /apps/ carve-out is under test here: POST with sec-fetch-site:cross-site
    // must succeed for /apps/* and be blocked for other routes.
    app.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
      if (req.path.startsWith('/v1/')) return next()
      if (req.path.startsWith('/apps/')) return next() // D-08: VMS adapter w/o CSRF token
      requireSameOrigin(req, res, next)
    })

    // Sentinel non-apps POST: used in the D-08 negative test to show CSRF blocks
    // routes outside /apps/ when sec-fetch-site:cross-site is present.
    app.post('/sentinel', (_req, res) => { res.json({ ok: true }) })

    app.use('/apps', createAppsRouter({ workspacePath: tmpDir }))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server!.once('error', reject)
    })
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => { server!.close(() => r()) })
      server = null
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── APPSRV-01: page HTML ───────────────────────────────────────────────────

  it('APPSRV-01: GET /apps/counter/ returns 200 HTML with shell markers and slug substituted', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/counter/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
    const html = await res.text()
    // Shell must embed the slug in the api endpoint path and title.
    expect(html).toContain('counter')
    expect(html).toContain('name="viewmodel-shell"')
    expect(html).toContain('/apps/counter/api')
    // Template placeholders must be fully substituted.
    expect(html).not.toContain('__SLUG__')
    expect(html).not.toContain('__TITLE__')
    expect(html).toContain('Counter App')
  })

  // ── APPSRV-02: GET/POST VMS wire ──────────────────────────────────────────

  it('APPSRV-02: GET /apps/counter/api returns {ok:true, vm, state.count}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/counter/api`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; vm: unknown; state: { count: number } }
    expect(body.ok).toBe(true)
    expect(body.vm).toBeDefined()
    expect(typeof body.state.count).toBe('number')
  })

  it('APPSRV-02: POST /apps/counter/api/action increments count and returns updated state', async () => {
    const getRes = await fetch(`http://127.0.0.1:${port}/apps/counter/api`)
    const initial = await getRes.json() as { ok: boolean; state: { count: number } }
    const before = initial.state.count

    const res = await fetch(`http://127.0.0.1:${port}/apps/counter/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'increment', state: initial.state }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok?: boolean; state: { count: number } }
    expect(body.state.count).toBe(before + 1)
  })

  // ── D-08: CSRF carve-out ──────────────────────────────────────────────────

  it('D-08 (positive): POST with sec-fetch-site:cross-site to /apps/* returns 200 (carve-out)', async () => {
    const getRes = await fetch(`http://127.0.0.1:${port}/apps/counter/api`)
    const initial = await getRes.json() as { ok: boolean; state: { count: number } }

    // sec-fetch-site:cross-site simulates a cross-origin browser POST.
    // requireSameOrigin blocks this when site='cross-site', but the /apps/ carve-out
    // calls next() before requireSameOrigin is reached — so the action succeeds.
    const res = await fetch(`http://127.0.0.1:${port}/apps/counter/api/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ name: 'increment', state: initial.state }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { state: { count: number } }
    expect(body.state.count).toBe(initial.state.count + 1)
  })

  it('D-08 (negative): POST with sec-fetch-site:cross-site to non-/apps/ route returns 403', async () => {
    // Without the /apps/ carve-out, all non-GET/HEAD/OPTIONS non-/v1/ routes
    // reach requireSameOrigin, which returns 403 for site:cross-site.
    // This confirms the carve-out is specific to /apps/ and not a global bypass.
    const res = await fetch(`http://127.0.0.1:${port}/sentinel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  // ── APPSRV-05: sqlite persistence + per-app isolation ─────────────────────

  it('APPSRV-05a: POST increment persists to counter data.sqlite (direct DatabaseSync read)', async () => {
    const getRes = await fetch(`http://127.0.0.1:${port}/apps/counter/api`)
    const initial = await getRes.json() as { ok: boolean; state: { count: number } }
    const before = initial.state.count

    const actionRes = await fetch(`http://127.0.0.1:${port}/apps/counter/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'increment', state: initial.state }),
    })
    expect(actionRes.status).toBe(200)

    // Direct DatabaseSync read bypasses the app's in-process cache and confirms
    // the write actually landed in the co-located sqlite file (D-11a).
    const db = new DatabaseSync(path.join(tmpDir, 'apps', 'counter', 'data.sqlite'))
    const row = db.prepare("SELECT v FROM kv WHERE k='count'").get() as { v: number }
    db.close()
    expect(row.v).toBe(before + 1)
  })

  it('APPSRV-05b: notes2 has its own sqlite with notes table (no kv — per-app isolation)', async () => {
    // Trigger notes2 so its sqlite is initialised by the app module.
    const initRes = await fetch(`http://127.0.0.1:${port}/apps/notes2/api`)
    expect(initRes.status).toBe(200)

    // Direct read: notes2 DB has 'notes' table but NOT 'kv' (which belongs to counter).
    // This proves each app writes to its own isolated database (D-11a).
    const db = new DatabaseSync(path.join(tmpDir, 'apps', 'notes2', 'data.sqlite'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    db.close()
    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('notes')
    expect(tableNames).not.toContain('kv')
  })

  // ── APPSRV-04: error boundary ─────────────────────────────────────────────

  it('APPSRV-04: broken app returns 500 with uncaught_exception; counter still 200; host alive', async () => {
    const brokenRes = await fetch(`http://127.0.0.1:${port}/apps/broken/api`)
    expect(brokenRes.status).toBe(500)
    const brokenBody = await brokenRes.json() as { ok: boolean; errors: { code?: string; message: string }[] }
    expect(brokenBody.ok).toBe(false)
    expect(brokenBody.errors[0]?.code).toBe('uncaught_exception')

    // Error is scoped to the broken app — host process + other apps unaffected (D-09).
    const counterRes = await fetch(`http://127.0.0.1:${port}/apps/counter/api`)
    expect(counterRes.status).toBe(200)
    const counterBody = await counterRes.json() as { ok: boolean }
    expect(counterBody.ok).toBe(true)

    // Server is still listening (process did not crash).
    expect(server).not.toBeNull()
  })

  // ── APPSRV-06: hot discovery ──────────────────────────────────────────────

  it('APPSRV-06: app folder written after listen is discovered per-request (no restart)', async () => {
    // Confirm 'late' does not exist yet — loadApp returns undefined → 404.
    const before = await fetch(`http://127.0.0.1:${port}/apps/late/api`)
    expect(before.status).toBe(404)

    // Write the app after the server is already listening.
    writeLateApp(tmpDir)

    // New slug has no cache entry in discovery.ts, so loadApp tries resolveEntry
    // fresh and finds the newly created app.mjs → 200 with no server restart.
    const after = await fetch(`http://127.0.0.1:${port}/apps/late/api`)
    expect(after.status).toBe(200)
    const body = await after.json() as { ok: boolean; state: { hello: string } }
    expect(body.ok).toBe(true)
    expect(body.state.hello).toBe('world')
  })

  // ── Traversal / slug guard ────────────────────────────────────────────────

  it('TRAVERSAL: slug with dots/non-alphanum chars returns 404 (SLUG_RE guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/..evil/api`)
    expect(res.status).toBe(404)
  })

  it('RESERVED: underscore-prefix slug returns 404 (reserved-prefix guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/_reserved/api`)
    expect(res.status).toBe(404)
  })

  // ── Package assets not shadowed ───────────────────────────────────────────

  it('_pkg: GET /apps/_pkg/index.js serves VMS package JS (not a user app slug)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/_pkg/index.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
  })

  // ── Enumeration ───────────────────────────────────────────────────────────

  it('ENUM: GET /apps/ includes all pre-written fixtures (counter, notes2, broken)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/apps/`)
    expect(res.status).toBe(200)
    const list = await res.json() as { slug: string }[]
    const slugs = list.map((a) => a.slug)
    expect(slugs).toContain('counter')
    expect(slugs).toContain('notes2')
    expect(slugs).toContain('broken')
  })
})
