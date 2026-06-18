/**
 * StewardRunStore.getRecent head-scoping tests (Phase 50).
 *
 * Verifies that getRecent(limit, headId) returns only runs for the
 * given head, and that getRecent(limit) (no headId) returns runs
 * across all heads (backward-compatible).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { StewardRunStore } from './steward_runs.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

describe('StewardRunStore.getRecent(limit, headId?)', () => {
  let db: DatabaseSync
  let store: StewardRunStore

  beforeEach(() => {
    db = freshDb()
    store = new StewardRunStore(db)
  })

  it('returns only runs belonging to the specified head when headId is provided', () => {
    store.append({ id: 'run-a1', stewards: [{ name: 'steward1', ran: true, fired: false }], createdAt: '2026-06-18T10:00:00Z', headId: 'A' })
    store.append({ id: 'run-a2', stewards: [{ name: 'steward2', ran: true, fired: true }], createdAt: '2026-06-18T10:01:00Z', headId: 'A' })
    store.append({ id: 'run-b1', stewards: [{ name: 'steward3', ran: false, fired: false }], createdAt: '2026-06-18T10:02:00Z', headId: 'B' })

    const result = store.getRecent(10, 'A')
    const ids = result.map(r => r.id)
    expect(ids).toContain('run-a1')
    expect(ids).toContain('run-a2')
    expect(ids).not.toContain('run-b1')
    expect(result).toHaveLength(2)
    result.forEach(r => expect(r.headId).toBe('A'))
  })

  it('returns runs from all heads when headId is omitted', () => {
    store.append({ id: 'run-a1', stewards: [{ name: 'steward1', ran: true, fired: false }], createdAt: '2026-06-18T10:00:00Z', headId: 'A' })
    store.append({ id: 'run-a2', stewards: [{ name: 'steward2', ran: true, fired: true }], createdAt: '2026-06-18T10:01:00Z', headId: 'A' })
    store.append({ id: 'run-b1', stewards: [{ name: 'steward3', ran: false, fired: false }], createdAt: '2026-06-18T10:02:00Z', headId: 'B' })

    const result = store.getRecent(10)
    const ids = result.map(r => r.id)
    expect(ids).toContain('run-a1')
    expect(ids).toContain('run-a2')
    expect(ids).toContain('run-b1')
    expect(result).toHaveLength(3)
  })

  it('returns empty array when the specified head has no runs', () => {
    store.append({ id: 'run-a1', stewards: [{ name: 'steward1', ran: true, fired: false }], createdAt: '2026-06-18T10:00:00Z', headId: 'A' })

    const result = store.getRecent(10, 'nonexistent')
    expect(result).toHaveLength(0)
  })
})
