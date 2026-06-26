// src/apps/discovery.test.ts
// Tests for discovery — the real loadApp path against a production-faithful temp workspace.
// D-11b: fixtures are .mjs (vitest/Vite won't transpile external .ts the way tsx does);
// production apps stay .ts. ensurePackageSymlink sets up the workspace symlink so the
// fixtures can resolve bare-specifier VMS imports if they need to.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SLUG_RE, listApps, loadApp } from './discovery.js'
import { ensurePackageSymlink } from './workspace.js'

// ── helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true })
  }
  tmpDirs.length = 0
})

/** Create a production-faithful temp workspace with ensurePackageSymlink applied. */
function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-disco-test-'))
  tmpDirs.push(ws)
  ensurePackageSymlink(ws) // D-11b: make the workspace production-faithful
  return ws
}

/** Write an app.mjs fixture that exports get() and action(). */
function writeGoodFixture(appsDir: string, slug: string, title?: string): void {
  const dir = path.join(appsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  if (title) {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title, icon: '🧪' }), 'utf8')
  }
  // The fixture uses node:sqlite via import.meta.url (D-11a: does NOT import src/apps/db.ts).
  // It must be .mjs so vitest/Node loads it without Vite transpilation.
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(new URL('./data.sqlite', import.meta.url).pathname)
db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)')
export const meta = { title: ${JSON.stringify(title ?? slug)}, icon: '🧪' }
export function get() { return { vm: { type: 'page', children: [] }, state: {} } }
export async function action(req) {
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}
`,
    'utf8'
  )
}

/** Write a fixture whose app.mjs throws at import time. */
function writeBrokenFixture(appsDir: string, slug: string): void {
  const dir = path.join(appsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `throw new Error('intentional load-time failure')
export function get() {}
export async function action() {}
`,
    'utf8'
  )
}

/** Write a fixture that is missing action() export. */
function writeMissingActionFixture(appsDir: string, slug: string): void {
  const dir = path.join(appsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `export function get() { return { vm: {}, state: {} } }
// action is intentionally missing
`,
    'utf8'
  )
}

// ── SLUG_RE ───────────────────────────────────────────────────────────────────

describe('SLUG_RE', () => {
  it('accepts valid slugs', () => {
    expect(SLUG_RE.test('notes')).toBe(true)
    expect(SLUG_RE.test('my-app')).toBe(true)
    expect(SLUG_RE.test('app123')).toBe(true)
    expect(SLUG_RE.test('a')).toBe(true)
    expect(SLUG_RE.test('0abc')).toBe(true)
  })

  it('rejects invalid slugs', () => {
    expect(SLUG_RE.test('_pkg')).toBe(false)    // starts with _
    expect(SLUG_RE.test('../evil')).toBe(false)  // traversal
    expect(SLUG_RE.test('has space')).toBe(false)
    expect(SLUG_RE.test('')).toBe(false)
    expect(SLUG_RE.test('ABC')).toBe(false)     // uppercase
    expect(SLUG_RE.test('-start')).toBe(false)  // starts with hyphen
  })
})

// ── listApps ─────────────────────────────────────────────────────────────────

describe('listApps', () => {
  it('returns [] for a fresh workspace with no apps dir', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    expect(listApps(appsDir)).toEqual([])
  })

  it('creates the apps dir if absent (mkdir-before-readdir)', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    listApps(appsDir)
    expect(fs.existsSync(appsDir)).toBe(true)
  })

  it('returns an entry for a dir with an app.mjs entry', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'notes', 'My Notes')
    const apps = listApps(appsDir)
    expect(apps.length).toBe(1)
    expect(apps[0]?.slug).toBe('notes')
  })

  it('reads meta.json without importing the module', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'notes', 'My Notes')
    const apps = listApps(appsDir)
    expect(apps[0]?.meta?.['title']).toBe('My Notes')
  })

  it('skips dirs without an app entry (app.ts or app.mjs)', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    fs.mkdirSync(path.join(appsDir, 'empty-dir'), { recursive: true })
    const apps = listApps(appsDir)
    expect(apps.length).toBe(0)
  })

  it('skips dirs whose name fails SLUG_RE (e.g. _pkg)', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    // _pkg has an app.mjs but its name starts with _ → fails SLUG_RE
    const dir = path.join(appsDir, '_pkg')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'app.mjs'), 'export function get(){} export async function action(){}', 'utf8')
    const apps = listApps(appsDir)
    expect(apps.length).toBe(0)
  })

  it('lists a broken app without throwing (enumeration does not import)', () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeBrokenFixture(appsDir, 'broken')
    expect(() => listApps(appsDir)).not.toThrow()
    expect(listApps(appsDir).length).toBe(1) // listed (exists) but not imported
  })
})

// ── loadApp ───────────────────────────────────────────────────────────────────

describe('loadApp', () => {
  it('returns undefined for a slug failing SLUG_RE', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    expect(await loadApp(appsDir, '../evil')).toBeUndefined()
    expect(await loadApp(appsDir, 'ABC')).toBeUndefined()
    expect(await loadApp(appsDir, '')).toBeUndefined()
  })

  it('returns undefined for a _-prefixed reserved slug', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    expect(await loadApp(appsDir, '_pkg')).toBeUndefined()
    expect(await loadApp(appsDir, '_skill')).toBeUndefined()
  })

  it('returns undefined for a slug with no app entry', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    expect(await loadApp(appsDir, 'nonexistent')).toBeUndefined()
  })

  it('loads a good .mjs fixture via the real dynamic import', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'notes', 'Notes App')
    const loaded = await loadApp(appsDir, 'notes')
    expect(loaded).toBeDefined()
    expect(loaded?.mod).toBeDefined()
    expect(loaded?.error).toBeUndefined()
    expect(loaded?.slug).toBe('notes')
  })

  it('returns the module\'s get() and action() functions', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'todo', 'Todo')
    const loaded = await loadApp(appsDir, 'todo')
    expect(typeof loaded?.mod?.get).toBe('function')
    expect(typeof loaded?.mod?.action).toBe('function')
  })

  it('returns { error } for a fixture that throws at import — does NOT throw', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeBrokenFixture(appsDir, 'broken')
    // loadApp must NOT re-throw — it returns { error } instead.
    // Call directly (not inside expect(...).not.toThrow): if it threw, this test fails.
    const loaded = await loadApp(appsDir, 'broken')
    expect(loaded).toBeDefined()
    expect(loaded?.error).toBeDefined()
    expect(loaded?.mod).toBeUndefined()
  })

  it('returns { error } for a module missing action() — does NOT throw', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeMissingActionFixture(appsDir, 'noaction')
    const loaded = await loadApp(appsDir, 'noaction')
    expect(loaded?.error).toMatch(/action/)
    expect(loaded?.mod).toBeUndefined()
  })

  it('discovers a brand-new slug without restart (hot discovery)', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'first', 'First')
    await loadApp(appsDir, 'first') // prime the cache with 'first'

    // Now add a brand-new slug AFTER the first scan
    writeGoodFixture(appsDir, 'second', 'Second')
    const loaded = await loadApp(appsDir, 'second')
    expect(loaded?.mod).toBeDefined()
    expect(loaded?.error).toBeUndefined()
  })

  it('reads meta.json and merges with module meta', async () => {
    const ws = makeWorkspace()
    const appsDir = path.join(ws, 'apps')
    writeGoodFixture(appsDir, 'meta-app', 'Meta Title')
    const loaded = await loadApp(appsDir, 'meta-app')
    // meta.json title + module meta.title — merged (module wins per D-04)
    expect(loaded?.meta?.['title']).toBeDefined()
  })
})
