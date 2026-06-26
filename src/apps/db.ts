// src/apps/db.ts
// HOST/test-facing per-app node:sqlite helper (D-03, D-11a).
//
// ⚠️ This module is for the HOST and TESTS ONLY — agent-authored apps do NOT import it.
// An app opens its own co-located sqlite directly via the node:sqlite builtin:
//   const db = new DatabaseSync(new URL('./data.sqlite', import.meta.url).pathname)
// This keeps apps independent of the repo's internal helpers and their DB files
// co-located with their code (deleting apps/<slug>/ removes code + data together — D-03).
//
// appDb(appDir, name) is for the host + tests to open an app's DB by path, e.g. to
// assert that a POST persisted a row.
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Per-path cache: key = "<appDir>:<name>" → open DatabaseSync handle.
// Calling appDb twice with the same arguments returns the same instance (no re-open).
const cache = new Map<string, DatabaseSync>()

/**
 * Open (and cache) the app's co-located sqlite file at `<appDir>/<name>.sqlite`.
 *
 * - `name` must match /^[a-z0-9_-]+$/i — throws "Invalid app name: <name>" otherwise
 *   (guards against path traversal: `/`, `.`, spaces, etc.).
 * - Opens with PRAGMA journal_mode=WAL and PRAGMA foreign_keys=ON (mirrors initDb in
 *   src/db/index.ts — the canonical shrok sqlite init body).
 * - The parent directory is created recursively before opening.
 */
export function appDb(appDir: string, name: string): DatabaseSync {
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Invalid app name: ${name}`)
  }

  const cacheKey = `${appDir}:${name}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const dbPath = path.join(appDir, `${name}.sqlite`)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  cache.set(cacheKey, db)
  return db
}
