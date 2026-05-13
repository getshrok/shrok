/**
 * Phase 33 Plan 01 — QueueStore.deleteAllForHead isolation tests.
 *
 * Mirrors the existing MessageStore.deleteAllForHead helper. Used later
 * by Plan 04's delete-head wipe transaction (D-07).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { QueueStore } from './queue.js'
import type { QueueEvent } from '../types/core.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function makeUserMessage(id: string, text = 'hi'): QueueEvent {
  return {
    type: 'user_message',
    id,
    text,
    channel: 'dashboard',
    createdAt: '2025-01-01T00:00:00Z',
  } as QueueEvent
}

describe('QueueStore.deleteAllForHead(headId)', () => {
  let db: DatabaseSync
  let queue: QueueStore

  beforeEach(() => {
    db = freshDb()
    queue = new QueueStore(db)
  })

  it("removes only the target head's queue_events; sibling heads' rows remain", () => {
    queue.enqueue(makeUserMessage('d1'), 100, 'default')
    queue.enqueue(makeUserMessage('w1'), 100, 'work')

    queue.deleteAllForHead('work')

    const defaultRows = db.prepare("SELECT id FROM queue_events WHERE head_id = 'default'").all() as { id: string }[]
    const workRows = db.prepare("SELECT id FROM queue_events WHERE head_id = 'work'").all() as { id: string }[]

    expect(defaultRows.map(r => r.id)).toEqual(['d1'])
    expect(workRows).toHaveLength(0)
  })

  it("claimNext('default') still returns the default-head pending event after deleteAllForHead('work')", () => {
    queue.enqueue(makeUserMessage('d1', 'still here'), 100, 'default')
    queue.enqueue(makeUserMessage('w1', 'gone'), 100, 'work')

    queue.deleteAllForHead('work')

    const defaultClaim = queue.claimNext('default')
    expect(defaultClaim?.event.id).toBe('d1')

    const workClaim = queue.claimNext('work')
    expect(workClaim).toBeNull()
  })
})
