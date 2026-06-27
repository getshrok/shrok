// src/apps/build-app-example.test.ts
//
// Vitest CI guard: the shipped golden example loads through the production
// loadApp path, drives its actions, and is DELETE-consistent (D-11).
//
// This test copies the REPO'S skills/build-app/example/ into a temp workspace
// so a future edit to the example that breaks compilation or contract will fail
// here in CI before it can ship to agents.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadApp, type AppMod } from './discovery.js'
import { ensurePackageSymlink } from './workspace.js'

// ── Repo anchors ──────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXAMPLE_SRC = path.join(repoRoot, 'skills', 'build-app', 'example')
// Slug must satisfy SLUG_RE: /^[a-z0-9][a-z0-9-]*$/
const SLUG = 'example-app'

// ── In-process dispatch helper ────────────────────────────────────────────────
//
// Mirrors the POST shape the router adapter builds at /apps/<slug>/api/action
// (src/apps/router.ts → action(toWebRequest(...))).

type ActionResult = { ok?: boolean; vm?: unknown; state?: unknown }

async function dispatch(mod: AppMod, name: string, state: unknown): Promise<ActionResult> {
  const res = await mod.action(
    new Request('http://localhost/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }),
  )
  return res.json() as Promise<ActionResult>
}

// ── Walker: find the first "del-<id>" action name in a vm tree ───────────────

function findDelAction(node: unknown): string | undefined {
  if (node == null || typeof node !== 'object') return undefined
  const n = node as Record<string, unknown>
  if (n['type'] === 'button') {
    const act = n['action'] as { name: string } | undefined
    if (act?.name?.startsWith('del-')) return act.name
  }
  for (const key of ['children', 'footer']) {
    const arr = n[key]
    if (Array.isArray(arr)) {
      for (const child of arr) {
        const found = findDelAction(child)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('build-app golden example CI guard', () => {
  let tmpDir = ''
  let appsDir = ''
  let appDbPath = ''

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appex-'))
    appsDir = path.join(tmpDir, 'apps')
    const appDir = path.join(appsDir, SLUG)

    // Copy the REPO's example source into the temp workspace (proves repo files work)
    fs.mkdirSync(appDir, { recursive: true })
    fs.copyFileSync(path.join(EXAMPLE_SRC, 'app.ts'), path.join(appDir, 'app.ts'))
    fs.copyFileSync(path.join(EXAMPLE_SRC, 'meta.json'), path.join(appDir, 'meta.json'))

    // Ensure the workspace VMS package symlink so @ashley-shrok/viewmodel-shell
    // resolves when loadApp dynamically imports the copied app.ts (D-11 / workspace.ts:37)
    ensurePackageSymlink(tmpDir)

    // Set APP_DB_PATH BEFORE loadApp so the module-level DatabaseSync init hits
    // the temp path, not the source tree (D-05).
    appDbPath = path.join(appDir, 'data.sqlite')
    process.env.APP_DB_PATH = appDbPath
  })

  afterEach(() => {
    delete process.env.APP_DB_PATH
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── (a) GOLDEN-LOADS ───────────────────────────────────────────────────────

  it('loadApp returns {mod} (not {error}) for the shipped example', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    expect(loaded).toBeDefined()
    // SUCCESS branch: mod is present and error is absent
    expect(loaded!.error).toBeUndefined()
    expect(loaded!.mod).toBeDefined()
    expect(typeof loaded!.mod!.get).toBe('function')
    expect(typeof loaded!.mod!.action).toBe('function')
  })

  it('get() returns {vm, state} matching the GET /apps/<slug>/api wire response', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    expect(loaded!.mod).toBeDefined()
    const result = loaded!.mod!.get()
    // These are the exact two keys the GET handler wraps in {ok:true, vm, state}
    expect(result.vm).toBeTruthy()
    expect(result.state).toBeTruthy()
    // vm must be a page node at root
    const vm = result.vm as { type: string }
    expect(vm.type).toBe('page')
  })

  // ── (b) ACTIONS ────────────────────────────────────────────────────────────

  it('open-add sets adding:true; close resets it to false', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    const mod = loaded!.mod!
    const init = mod.get()

    const opened = await dispatch(mod, 'open-add', init.state)
    expect(opened.ok).not.toBe(false)
    const openedState = opened.state as { adding: boolean }
    expect(openedState.adding).toBe(true)

    const closed = await dispatch(mod, 'close', openedState)
    expect(closed.ok).not.toBe(false)
    const closedState = closed.state as { adding: boolean }
    expect(closedState.adding).toBe(false)
  })

  it('add inserts a note; del-<id> removes it', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    const mod = loaded!.mod!
    const init = mod.get()
    // Provide form fields: title + body (mirrors the FieldNode binds in app.ts)
    const stateForAdd = {
      ...(init.state as object),
      adding: true,
      fields: { title: 'CI Test Note', body: 'Hello CI' },
    }

    const added = await dispatch(mod, 'add', stateForAdd)
    expect(added.ok).not.toBe(false)
    const addedState = added.state as { adding: boolean; error: string | null }
    expect(addedState.adding).toBe(false)
    expect(addedState.error).toBeNull()

    // The returned vm must now contain a del-<id> button for the newly added note
    const delName = findDelAction(added.vm)
    expect(typeof delName).toBe('string')

    const deleted = await dispatch(mod, delName!, init.state)
    expect(deleted.ok).not.toBe(false)
  })

  it('validation error (empty title) surfaces as state.error, not ok:false', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    const mod = loaded!.mod!
    const init = mod.get()
    const stateForAdd = {
      ...(init.state as object),
      adding: true,
      fields: { title: '   ', body: '' },
    }

    const result = await dispatch(mod, 'add', stateForAdd)
    // The action catches the Error and stores it as state.error (not a 422)
    expect(result.ok).not.toBe(false)
    const rs = result.state as { error: string | null }
    expect(typeof rs.error).toBe('string')
    expect((rs.error as string).length).toBeGreaterThan(0)
  })

  it('unknown action name returns ok:false (UnknownActionError path)', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    const mod = loaded!.mod!
    const init = mod.get()

    const result = await dispatch(mod, 'no-such-action', init.state)
    expect(result.ok).toBe(false)
  })

  // ── (c) DELETE CONSISTENCY (D-11) ──────────────────────────────────────────

  it('D-11: write via add is visible in a second DatabaseSync on the same path; no -wal sidecar', async () => {
    const loaded = await loadApp(appsDir, SLUG)
    const mod = loaded!.mod!
    const init = mod.get()
    const stateForAdd = {
      ...(init.state as object),
      adding: true,
      fields: { title: 'DeleteCheck', body: '' },
    }

    // Write a row through the app action
    const added = await dispatch(mod, 'add', stateForAdd)
    expect(added.ok).not.toBe(false)

    // Open a SECOND independent DatabaseSync on the SAME appDbPath.
    // Under journal_mode=DELETE the write is already flushed to the main file,
    // so a fresh connection can see it immediately — no -wal sidecar required.
    const db2 = new DatabaseSync(appDbPath)
    const rows = db2.prepare("SELECT title FROM notes WHERE title = 'DeleteCheck'").all() as { title: string }[]
    db2.close()

    expect(rows.length).toBe(1)
    expect(rows[0]?.title).toBe('DeleteCheck')

    // Assert no WAL sidecar file was created (proves journal_mode=DELETE is in effect)
    expect(fs.existsSync(appDbPath + '-wal')).toBe(false)
    expect(fs.existsSync(appDbPath + '-shm')).toBe(false)
  })
})
