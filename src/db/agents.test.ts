/**
 * AgentStore.getRecent head-scoping tests (closes #10).
 *
 * Verifies that getRecent(limit, headId) returns only agents for the
 * given head, and that getRecent(limit) (no headId) returns agents
 * across all heads (backward-compatible).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { AgentStore } from './agents.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

describe('AgentStore.getRecent(limit, headId?)', () => {
  let db: DatabaseSync
  let store: AgentStore

  beforeEach(() => {
    db = freshDb()
    store = new AgentStore(db)
  })

  it('returns only agents belonging to the specified head when headId is provided', () => {
    store.create('agent-a1', { prompt: 'task A1', trigger: 'manual', headId: 'A' })
    store.create('agent-a2', { prompt: 'task A2', trigger: 'manual', headId: 'A' })
    store.create('agent-b1', { prompt: 'task B1', trigger: 'manual', headId: 'B' })

    const result = store.getRecent(10, 'A')
    const ids = result.map(a => a.id)
    expect(ids).toContain('agent-a1')
    expect(ids).toContain('agent-a2')
    expect(ids).not.toContain('agent-b1')
    expect(result).toHaveLength(2)
  })

  it('returns agents from all heads when headId is omitted', () => {
    store.create('agent-a1', { prompt: 'task A1', trigger: 'manual', headId: 'A' })
    store.create('agent-a2', { prompt: 'task A2', trigger: 'manual', headId: 'A' })
    store.create('agent-b1', { prompt: 'task B1', trigger: 'manual', headId: 'B' })

    const result = store.getRecent(10)
    const ids = result.map(a => a.id)
    expect(ids).toContain('agent-a1')
    expect(ids).toContain('agent-a2')
    expect(ids).toContain('agent-b1')
    expect(result).toHaveLength(3)
  })

  it('returns empty array when the specified head has no agents', () => {
    store.create('agent-a1', { prompt: 'task A1', trigger: 'manual', headId: 'A' })

    const result = store.getRecent(10, 'nonexistent')
    expect(result).toHaveLength(0)
  })
})
