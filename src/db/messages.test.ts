/**
 * Phase 33 Plan 01 — MessageStore head_id write isolation tests.
 *
 * These tests exercise the new append(msg, headId) signature and
 * verify that head_id is stamped on the row at write time (DATA-02
 * write-side counterpart to db.test.ts read-side isolation tests).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { MessageStore } from './messages.js'
import type { TextMessage } from '../types/core.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function makeText(id: string, content: string, createdAt = '2025-01-01T00:00:00Z'): TextMessage {
  return { kind: 'text', id, role: 'user', content, createdAt }
}

describe('MessageStore.append(msg, headId)', () => {
  let db: DatabaseSync
  let store: MessageStore

  beforeEach(() => {
    db = freshDb()
    store = new MessageStore(db)
  })

  it('writes head_id into the row when explicitly provided', () => {
    store.append(makeText('w1', 'work-msg'), 'work')
    const row = db.prepare("SELECT head_id FROM messages WHERE id = 'w1'").get() as { head_id: string } | undefined
    expect(row?.head_id).toBe('work')
    expect(store.countForHead('work')).toBe(1)
    expect(store.countForHead('default')).toBe(0)
  })

  it('isolates getRecent across heads after append(msg, headId)', () => {
    store.append(makeText('d1', 'default-msg', '2025-01-01T00:00:00Z'), 'default')
    store.append(makeText('w1', 'work-msg', '2025-01-01T00:00:01Z'), 'work')

    const defaultMsgs = store.getRecent('default', 1_000_000)
    expect(defaultMsgs.map(m => m.id)).toEqual(['d1'])

    const workMsgs = store.getRecent('work', 1_000_000)
    expect(workMsgs.map(m => m.id)).toEqual(['w1'])
  })

  it("deleteAllForHead removes only the target head's rows", () => {
    store.append(makeText('d1', 'd', '2025-01-01T00:00:00Z'), 'default')
    store.append(makeText('w1', 'w', '2025-01-01T00:00:01Z'), 'work')
    expect(store.countForHead('default')).toBe(1)
    expect(store.countForHead('work')).toBe(1)

    store.deleteAllForHead('work')

    expect(store.countForHead('default')).toBe(1)
    expect(store.countForHead('work')).toBe(0)
    const remaining = store.getRecent('default', 1_000_000)
    expect(remaining.map(m => m.id)).toEqual(['d1'])
  })
})
