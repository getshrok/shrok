import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import { createAppsRouter } from './router.js'

// ── Auth bypass ─────────────────────────────────────────────────────────────────────
// Sets res.locals.authenticated so requireAuth passes without a real dashboard session.
const authBypass: express.RequestHandler = (_req, res, next) => {
  res.locals['authenticated'] = true
  next()
}

// ── Fixture writers ─────────────────────────────────────────────────────────────────

/**
 * Write a working counter app as .mjs (D-11b: Node loads it natively, no tsx needed).
 *   - D-11a: opens its own co-located data.sqlite, NOT importing src/apps/db.ts.
 *   - Imports createAction from the REAL @ashley-shrok/viewmodel-shell package, which
 *     Node resolves via the workspace symlink that createAppsRouter ensures at construction.
 */
function writeCounterApp(workspacePath: string): void {
  const dir = join(workspacePath, 'apps', 'counter')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ title: 'Counter App', desc: 'An integer counter' })
  )
  writeFileSync(
    join(dir, 'app.mjs'),
    `import { createAction } from '@ashley-shrok/viewmodel-shell/server'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(new URL('./data.sqlite', import.meta.url).pathname)
db.exec('PRAGMA journal_mode=WAL')
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)')
db.exec("INSERT OR IGNORE INTO kv (k,v) VALUES ('count',0)")

function snapshot() {
  const row = db.prepare("SELECT v FROM kv WHERE k='count'").get()
  const count = row.v
  return {
    vm: { type: 'page', title: 'Counter App', children: [] },
    state: { count }
  }
}

export function get() { return snapshot() }

export const action = createAction(async (payload) => {
  if (payload.name === 'increment') {
    db.prepare("UPDATE kv SET v=v+1 WHERE k='count'").run()
  }
  return snapshot()
})
`
  )
}

/** Write a broken app that throws at import time (tests the D-09 error boundary). */
function writeBrokenApp(workspacePath: string): void {
  const dir = join(workspacePath, 'apps', 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ title: 'Broken' }))
  writeFileSync(join(dir, 'app.mjs'), `throw new Error('intentional load failure')`)
}

// ── Tests ───────────────────────────────────────────────────────────────────────────

describe('createAppsRouter', () => {
  let workspacePath: string
  let server: Server
  let base: string

  beforeAll(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'appsrouter-'))
    writeCounterApp(workspacePath)
    writeBrokenApp(workspacePath)

    const app = express()
    app.use(express.json())
    app.use(authBypass)
    // Mount under /apps — ensurePackageSymlink runs at factory construction (D-11).
    app.use('/apps', createAppsRouter({ workspacePath }))

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}/apps`
  })

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
    if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
  })

  // ── Enumeration ────────────────────────────────────────────────────────────────
  it('GET / lists discovered apps', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    const data = await res.json() as { slug: string }[]
    const slugs = data.map((a) => a.slug)
    expect(slugs).toContain('counter')
  })

  // ── HTML shell ─────────────────────────────────────────────────────────────────
  it('GET /:slug/ returns HTML with slug and title substituted', async () => {
    const res = await fetch(`${base}/counter/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
    const html = await res.text()
    expect(html).toContain('/apps/counter/api')
    expect(html).not.toContain('__SLUG__')
    expect(html).not.toContain('__TITLE__')
    expect(html).toContain('Counter App')
  })

  it('GET /:slug/ for unknown slug returns 404', async () => {
    const res = await fetch(`${base}/nonexistent/`)
    expect(res.status).toBe(404)
  })

  // ── Security regression: CR-01 (reflected XSS in 404 response) ───────────────
  it('CR-01: 404 for XSS-shaped slug returns text/plain, not text/html', async () => {
    // URL-encode a slug that would execute script if interpreted as HTML.
    // The slug fails SLUG_RE so loadApp returns undefined → 404 path.
    const res = await fetch(`${base}/%3Cscript%3Ealert(1)%3C%2Fscript%3E/`)
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    // Must NOT be text/html — response must not be browser-interpreted as HTML.
    expect(ct).not.toMatch(/text\/html/)
    expect(ct).toMatch(/text\/plain/)
  })

  // ── Security regression: CR-02 (stored XSS in 500 response) ─────────────────
  it('CR-02: 500 for broken app returns text/plain, not text/html', async () => {
    // The 'broken' app fixture throws at import time → loadApp returns { error }.
    // The /:slug/ handler must send 500 as text/plain, not text/html.
    const res = await fetch(`${base}/broken/`)
    expect(res.status).toBe(500)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).not.toMatch(/text\/html/)
    expect(ct).toMatch(/text\/plain/)
    const body = await res.text()
    // Body must contain the error indication (plain text, not HTML markup).
    expect(body).toContain('broken')
  })

  // ── VMS GET wire ───────────────────────────────────────────────────────────────
  it('GET /:slug/api returns { ok:true, vm, state }', async () => {
    const res = await fetch(`${base}/counter/api`)
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; vm: unknown; state: { count: number } }
    expect(data.ok).toBe(true)
    expect(data.vm).toBeDefined()
    expect(typeof data.state.count).toBe('number')
  })

  it('GET /:slug/api for unknown slug returns 404 JSON envelope', async () => {
    const res = await fetch(`${base}/nonexistent/api`)
    expect(res.status).toBe(404)
    const data = await res.json() as { ok: boolean; errors: { message: string }[] }
    expect(data.ok).toBe(false)
    expect(data.errors[0]?.message).toContain('nonexistent')
  })

  // ── VMS POST wire + DB persistence ─────────────────────────────────────────────
  it('POST /:slug/api/action mutates state and persists to sqlite', async () => {
    // Read initial count (may be non-zero from prior test runs in the same process)
    const getRes = await fetch(`${base}/counter/api`)
    const initial = await getRes.json() as { ok: boolean; state: { count: number } }
    const before = initial.state.count

    // Send increment action
    const actionRes = await fetch(`${base}/counter/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'increment', state: initial.state }),
    })
    expect(actionRes.status).toBe(200)
    const updated = await actionRes.json() as { ok: boolean; state: { count: number } }
    expect(updated.state.count).toBe(before + 1)

    // GET again to confirm DB write persisted
    const getRes2 = await fetch(`${base}/counter/api`)
    const persisted = await getRes2.json() as { state: { count: number } }
    expect(persisted.state.count).toBe(before + 1)
  })

  // ── Real VMS wire: multipart/form-data action (regression for the 400 bug) ──────
  // The VMS BrowserAdapter POSTs actions as multipart/form-data (FormData with _action/_state),
  // NOT application/json. The JSON test above fabricates a wire the browser never uses; this one
  // replicates the real dispatch. Node's fetch sets the multipart content-type + boundary itself.
  it('POST /:slug/api/action accepts a real multipart/form-data FormData body', async () => {
    const getRes = await fetch(`${base}/counter/api`)
    const initial = await getRes.json() as { ok: boolean; state: { count: number } }
    const before = initial.state.count

    const form = new FormData()
    form.append('_action', JSON.stringify({ name: 'increment' }))
    form.append('_state', JSON.stringify(initial.state))

    const actionRes = await fetch(`${base}/counter/api/action`, { method: 'POST', body: form })
    expect(actionRes.status).toBe(200)
    const updated = await actionRes.json() as { ok: boolean; state: { count: number } }
    expect(updated.ok).toBe(true)
    expect(updated.state.count).toBe(before + 1)

    // Confirm the multipart-driven write persisted.
    const getRes2 = await fetch(`${base}/counter/api`)
    const persisted = await getRes2.json() as { state: { count: number } }
    expect(persisted.state.count).toBe(before + 1)
  })

  // ── Per-app error boundary (D-09) ──────────────────────────────────────────────
  it('broken app GET /:slug/api returns 500 with code:uncaught_exception', async () => {
    const res = await fetch(`${base}/broken/api`)
    expect(res.status).toBe(500)
    const data = await res.json() as { ok: boolean; errors: { code?: string; message: string }[] }
    expect(data.ok).toBe(false)
    expect(data.errors[0]?.code).toBe('uncaught_exception')
  })

  it('broken app error does not affect the counter app (D-09 isolation)', async () => {
    await fetch(`${base}/broken/api`)
    const res = await fetch(`${base}/counter/api`)
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean }
    expect(data.ok).toBe(true)
  })

  // ── Package assets ─────────────────────────────────────────────────────────────
  it('GET /_pkg/index.js returns application/javascript', async () => {
    const res = await fetch(`${base}/_pkg/index.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
  })

  it('GET /_pkg/browser.js returns application/javascript', async () => {
    const res = await fetch(`${base}/_pkg/browser.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
  })

  it('GET /_pkg/styles.css returns text/css', async () => {
    const res = await fetch(`${base}/_pkg/styles.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/css/)
  })

  it('GET /_pkg/theme.css returns text/css', async () => {
    const res = await fetch(`${base}/_pkg/theme.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/css/)
  })

  // ── DELETE /:slug — remove an app (code + co-located data) ──────────────────────
  it('DELETE /:slug removes the app dir, de-lists it, and subsequent GET 404s', async () => {
    // Dedicated throwaway fixture so the shared `counter`/`broken` apps are untouched.
    const dir = join(workspacePath, 'apps', 'deleteme')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ title: 'Delete Me' }))
    writeFileSync(
      join(dir, 'app.mjs'),
      `export function get() { return { vm: { type: 'page', title: 'Delete Me', children: [] }, state: {} } }
export async function action() { return new Response('{}', { headers: { 'content-type': 'application/json' } }) }
`
    )

    // It's discoverable before deletion.
    const listBefore = await (await fetch(`${base}/`)).json() as { slug: string }[]
    expect(listBefore.map((a) => a.slug)).toContain('deleteme')

    // Delete it.
    const del = await fetch(`${base}/deleteme`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })

    // Folder is gone on disk.
    expect(existsSync(dir)).toBe(false)

    // No longer listed, and the API route 404s (cache evicted).
    const listAfter = await (await fetch(`${base}/`)).json() as { slug: string }[]
    expect(listAfter.map((a) => a.slug)).not.toContain('deleteme')
    const apiRes = await fetch(`${base}/deleteme/api`)
    expect(apiRes.status).toBe(404)
  })

  it('DELETE /:slug for a missing app returns 404 JSON envelope', async () => {
    const res = await fetch(`${base}/nonexistent`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    const data = await res.json() as { ok: boolean; errors: { message: string }[] }
    expect(data.ok).toBe(false)
    expect(data.errors[0]?.message).toContain('nonexistent')
  })

  it('DELETE /:slug for a reserved/invalid slug returns 404 and never touches disk', async () => {
    // A '_'-prefixed slug fails SLUG_RE → rejected before any fs access.
    const res = await fetch(`${base}/_pkg`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    // The real counter app is still present and serving.
    const counter = await fetch(`${base}/counter/api`)
    expect(counter.status).toBe(200)
  })

  // ── Agent skill ─────────────────────────────────────────────────────────────────
  it('GET /_skill.md returns text/markdown content', async () => {
    const res = await fetch(`${base}/_skill.md`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/markdown/)
    const text = await res.text()
    expect(text.length).toBeGreaterThan(50)
  })
})
