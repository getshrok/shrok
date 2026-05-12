import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb } from './index.js'
import { runMigrations } from './migrate.js'
import { MessageStore } from './messages.js'
import { AgentStore } from './agents.js'
import { AgentInboxStore } from './agent_inbox.js'
import { ScheduleStore } from './schedules.js'
import { QueueStore } from './queue.js'
import { UsageStore } from './usage.js'
import { AppStateStore } from './app_state.js'
import { estimateTokens } from './token.js'
import { findBlockingThresholds, formatThresholdBlock } from '../usage-threshold.js'
import type { TextMessage, ToolCallMessage, ToolResultMessage, SummaryMessage, QueueEvent } from '../types/core.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns a positive count for non-empty messages', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'user', content: 'hello world', createdAt: '2025-01-01' }
    expect(estimateTokens([msg])).toBeGreaterThan(0)
  })

  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0)
  })
})

// ─── initDb + runMigrations ───────────────────────────────────────────────────

describe('initDb + runMigrations', () => {
  it('creates all tables', () => {
    const db = freshDb()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(r => r.name)

    expect(tables).toContain('messages')
    expect(tables).toContain('agents')
    expect(tables).toContain('queue_events')
    expect(tables).toContain('app_state')
    expect(tables).toContain('memories')
    expect(tables).toContain('agent_inbox')
    expect(tables).toContain('usage')
    expect(tables).toContain('_migrations')
    // schedules and reminders are now flat JSON files, not DB tables
    expect(tables).not.toContain('schedules')
    expect(tables).not.toContain('reminders')
  })

  it('agents table has color_slot column (Phase 18)', () => {
    const db = freshDb()
    const cols = (db.prepare("PRAGMA table_info('agents')").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[])
    const slot = cols.find(c => c.name === 'color_slot')
    expect(slot).toBeDefined()
    expect(slot!.type).toBe('INTEGER')
    expect(slot!.notnull).toBe(0)          // nullable
    expect(slot!.dflt_value).toBeNull()    // no default → existing rows are NULL
  })

  it('queue_events table has head_id column with NOT NULL DEFAULT \'default\' (Phase 29 DATA-01)', () => {
    const db = freshDb()
    const cols = db.prepare("PRAGMA table_info('queue_events')").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[]
    const head = cols.find(c => c.name === 'head_id')
    expect(head).toBeDefined()
    expect(head!.type).toBe('TEXT')
    expect(head!.notnull).toBe(1)
    expect(String(head!.dflt_value)).toBe("'default'")
  })

  it('messages table has head_id column with NOT NULL DEFAULT \'default\' (Phase 29 DATA-02)', () => {
    const db = freshDb()
    const cols = db.prepare("PRAGMA table_info('messages')").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[]
    const head = cols.find(c => c.name === 'head_id')
    expect(head).toBeDefined()
    expect(head!.type).toBe('TEXT')
    expect(head!.notnull).toBe(1)
    expect(String(head!.dflt_value)).toBe("'default'")
  })

  it('idx_queue_status_priority replaced by idx_queue_head_status_priority (D-08)', () => {
    const db = freshDb()
    const oldIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_queue_status_priority'").get()
    expect(oldIdx).toBeUndefined()
    const newIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_queue_head_status_priority'").get()
    expect(newIdx).toBeDefined()
  })

  it('idx_messages_head_created exists (D-09)', () => {
    const db = freshDb()
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_head_created'").get()
    expect(idx).toBeDefined()
  })

  it('idx_messages_created_at retained (D-10)', () => {
    const db = freshDb()
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_created_at'").get()
    expect(idx).toBeDefined()
  })

  it('is idempotent — running twice does not fail', () => {
    const db = initDb(':memory:')
    expect(() => {
      runMigrations(db, MIGRATIONS_DIR)
      runMigrations(db, MIGRATIONS_DIR)
    }).not.toThrow()
  })

  it('enables foreign keys', () => {
    const db = freshDb()
    // WAL mode is not applicable to :memory: databases (SQLite returns 'memory');
    // only verify foreign keys are enabled.
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
  })
})

// ─── MessageStore ─────────────────────────────────────────────────────────────

describe('MessageStore', () => {
  let store: MessageStore

  beforeEach(() => {
    store = new MessageStore(freshDb())
  })

  const textMsg: TextMessage = {
    kind: 'text', id: 'msg-1', role: 'user', content: 'hello',
    createdAt: '2025-01-01T00:00:00Z', channel: 'discord',
  }

  it('appends and retrieves text messages', () => {
    store.append(textMsg)
    const msgs = store.getRecent('default', 10_000)
    expect(msgs).toHaveLength(1)
    const m = msgs[0] as TextMessage
    expect(m.kind).toBe('text')
    expect(m.content).toBe('hello')
    expect(m.channel).toBe('discord')
  })

  it("append without explicit head_id stamps row with head_id='default' (DATA-02)", () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    const msg: TextMessage = {
      kind: 'text', id: 'msg-default', role: 'user', content: 'hi',
      createdAt: '2025-01-01T00:00:00Z',
    }
    localStore.append(msg)
    const row = db.prepare("SELECT head_id FROM messages WHERE id = ?").get('msg-default') as { head_id: string } | undefined
    expect(row?.head_id).toBe('default')
  })

  it('appends tool_call messages', () => {
    const msg: ToolCallMessage = {
      kind: 'tool_call', id: 'msg-2', content: '',
      toolCalls: [{ id: 'tc1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: '2025-01-01T00:00:01Z',
    }
    store.append(msg)
    const msgs = store.getRecent('default', 10_000)
    expect(msgs[0]?.kind).toBe('tool_call')
  })

  it('appends tool_result messages', () => {
    const msg: ToolResultMessage = {
      kind: 'tool_result', id: 'msg-3',
      toolResults: [{ toolCallId: 'tc1', name: 'bash', content: 'file.ts' }],
      createdAt: '2025-01-01T00:00:02Z',
    }
    store.append(msg)
    const msgs = store.getRecent('default', 10_000)
    expect(msgs[0]?.kind).toBe('tool_result')
  })

  it('respects token budget in getRecent', () => {
    const content = '12345678901234567890'
    const sampleMsg: TextMessage = { kind: 'text', id: 'sample', role: 'user', content, createdAt: '2025-01-01T00:00:00Z' }
    const costPerMsg = estimateTokens([sampleMsg])
    for (let i = 0; i < 10; i++) {
      store.append({
        kind: 'text', id: `msg-${i}`, role: 'user', content,
        createdAt: `2025-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      })
    }
    // Budget fits at most 3 messages
    const msgs = store.getRecent('default', costPerMsg * 3)
    expect(msgs.length).toBeLessThanOrEqual(3)
  })

  it('getSince returns only messages at or after the datetime', () => {
    store.append({ kind: 'text', id: 'early', role: 'user', content: 'early', createdAt: '2025-01-01T00:00:00Z' })
    store.append({ kind: 'text', id: 'late', role: 'user', content: 'late', createdAt: '2025-01-02T00:00:00Z' })
    const msgs = store.getSince('default', '2025-01-02T00:00:00Z')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.id).toBe('late')
  })

  it('getRecentBefore returns messages before datetime', () => {
    store.append({ kind: 'text', id: 'a', role: 'user', content: 'a', createdAt: '2025-01-01T00:00:00Z' })
    store.append({ kind: 'text', id: 'b', role: 'user', content: 'b', createdAt: '2025-01-02T00:00:00Z' })
    const msgs = store.getRecentBefore('default', '2025-01-02T00:00:00Z', 10_000)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.id).toBe('a')
  })

  it('attachment array survives round-trip serialization', () => {
    const msg: TextMessage = {
      kind: 'text', id: 'msg-att', role: 'user', content: 'look at this',
      createdAt: '2025-01-01T00:00:10Z',
      attachments: [
        { type: 'image', mediaType: 'image/jpeg', filename: 'photo.jpg', size: 12345 },
        { type: 'audio', mediaType: 'audio/ogg', filename: 'voice.ogg', durationSeconds: 8.5 },
      ],
    }
    store.append(msg)
    const msgs = store.getRecent('default', 100_000)
    const m = msgs[0] as TextMessage
    expect(m.attachments).toHaveLength(2)
    expect(m.attachments![0]!.type).toBe('image')
    expect(m.attachments![0]!.filename).toBe('photo.jpg')
    expect(m.attachments![0]!.size).toBe(12345)
    expect(m.attachments![1]!.durationSeconds).toBe(8.5)
  })

  it('message without attachments has no attachments key', () => {
    store.append({ kind: 'text', id: 'msg-noatt', role: 'user', content: 'plain', createdAt: '2025-01-01T00:00:10Z' })
    const msgs = store.getRecent('default', 100_000)
    const m = msgs[0] as TextMessage
    expect(m.attachments).toBeUndefined()
  })

  it('replaceWithSummary removes old messages and inserts summary', () => {
    store.append({ kind: 'text', id: 'msg-x', role: 'user', content: 'old', createdAt: '2025-01-01T00:00:00Z' })
    const summary: SummaryMessage = {
      kind: 'summary', id: 'sum-1', content: 'A summary',
      summarySpan: ['2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'],
      createdAt: '2025-01-01T00:01:00Z',
    }
    store.replaceWithSummary(['msg-x'], summary)
    const msgs = store.getRecent('default', 10_000)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.kind).toBe('summary')
  })

  // ─── Phase 29: head_id isolation (DATA-04) ──────────────────────────────────

  function insertWithHead(db: ReturnType<typeof freshDb>, id: string, head: string, content: string, createdAt: string): void {
    db.prepare(
      "INSERT INTO messages (id, kind, role, content, injected, head_id, created_at) VALUES (?, 'text', 'user', ?, 0, ?, ?)"
    ).run(id, content, head, createdAt)
  }

  it('getRecent(headId) returns only messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p1', 'personal', 'p-one', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'p2', 'personal', 'p-two', '2025-01-01T00:00:01Z')
    insertWithHead(db, 'w1', 'work',     'w-one', '2025-01-01T00:00:02Z')

    const personal = localStore.getRecent('personal', 1_000_000)
    expect(personal.map(m => m.id).sort()).toEqual(['p1', 'p2'])
    const work = localStore.getRecent('work', 1_000_000)
    expect(work.map(m => m.id)).toEqual(['w1'])
  })

  it('getAll(headId) returns only messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p1', 'personal', 'p', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'w1', 'work', 'w', '2025-01-01T00:00:01Z')
    expect(localStore.getAll('personal').map(m => m.id)).toEqual(['p1'])
    expect(localStore.getAll('work').map(m => m.id)).toEqual(['w1'])
  })

  it('getSince(headId, datetime) returns only messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p-early', 'personal', 'early', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'p-late', 'personal', 'late', '2025-01-02T00:00:00Z')
    insertWithHead(db, 'w-late', 'work', 'wlate', '2025-01-02T00:00:00Z')
    const msgs = localStore.getSince('personal', '2025-01-02T00:00:00Z')
    expect(msgs.map(m => m.id)).toEqual(['p-late'])
  })

  it('getRecentBefore(headId, before, budget) returns only messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p-a', 'personal', 'a', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'p-b', 'personal', 'b', '2025-01-02T00:00:00Z')
    insertWithHead(db, 'w-a', 'work', 'wa', '2025-01-01T00:00:00Z')
    const msgs = localStore.getRecentBefore('personal', '2025-01-02T00:00:00Z', 1_000_000)
    expect(msgs.map(m => m.id)).toEqual(['p-a'])
  })

  it('getRecentText(headId, limit) returns only text messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p1', 'personal', 'p-one', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'w1', 'work', 'w-one', '2025-01-01T00:00:01Z')
    const msgs = localStore.getRecentText('personal', 10)
    expect(msgs.map(m => m.id)).toEqual(['p1'])
  })

  it('getRecentTextByTokens(headId, budget, fn) returns only text messages for that head (DATA-04)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p1', 'personal', 'p-one', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'w1', 'work', 'w-one', '2025-01-01T00:00:01Z')
    const msgs = localStore.getRecentTextByTokens('personal', 10_000, estimateTokens)
    expect(msgs.map(m => m.id)).toEqual(['p1'])
  })

  it('sanitizeOrphans() remains global — sees orphans across heads (D-06)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    // Insert an orphan tool_call under head 'work' (no following tool_result).
    db.prepare(
      "INSERT INTO messages (id, kind, content, tool_calls, injected, head_id, created_at) VALUES ('orphan-tc', 'tool_call', '', ?, 0, 'work', '2025-01-01T00:00:00Z')"
    ).run(JSON.stringify([{ id: 'tc1', name: 'bash', input: { cmd: 'ls' } }]))
    // Insert a benign text message under 'personal' so the store is not empty.
    insertWithHead(db, 'p1', 'personal', 'hi', '2025-01-01T00:00:01Z')
    const removed = localStore.sanitizeOrphans()
    expect(removed).toBe(1)
    // Verify orphan is gone, personal text remains.
    const remaining = db.prepare('SELECT id FROM messages').all() as { id: string }[]
    expect(remaining.map(r => r.id)).toEqual(['p1'])
  })

  it('count() remains global across heads (D-06)', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    insertWithHead(db, 'p1', 'personal', 'p', '2025-01-01T00:00:00Z')
    insertWithHead(db, 'w1', 'work', 'w', '2025-01-01T00:00:01Z')
    expect(localStore.count()).toBe(2)
  })

  it('getRecent(headId, budget) still respects token budget within head scope', () => {
    const db = freshDb()
    const localStore = new MessageStore(db)
    const sample: TextMessage = { kind: 'text', id: 'sample', role: 'user', content: '12345678901234567890', createdAt: '2025-01-01T00:00:00Z' }
    const costPerMsg = estimateTokens([sample])
    for (let i = 0; i < 5; i++) {
      insertWithHead(db, `p-${i}`, 'personal', '12345678901234567890', `2025-01-01T00:00:0${i}Z`)
    }
    insertWithHead(db, 'w-x', 'work', '12345678901234567890', '2025-01-01T00:00:09Z')
    const msgs = localStore.getRecent('personal', costPerMsg * 2)
    expect(msgs.length).toBeLessThanOrEqual(2)
    expect(msgs.every(m => m.id.startsWith('p-'))).toBe(true)
  })
})

// ─── AgentStore ────────────────────────────────────────────────────────────

describe('AgentStore', () => {
  let store: AgentStore

  beforeEach(() => {
    store = new AgentStore(freshDb())
  })

  const baseOptions = {
    prompt: 'do something',
    model: 'capable',
    trigger: 'manual' as const,
  }

  it('creates and retrieves an agent', () => {
    const t = store.create('t-1', baseOptions)
    expect(t.id).toBe('t-1')
    expect(t.status).toBe('running')
    expect(t.task).toBe('do something')
    expect(t.model).toBe('capable')

    const fetched = store.get('t-1')
    expect(fetched?.id).toBe('t-1')
  })

  it('get returns null for unknown id', () => {
    expect(store.get('nope')).toBeNull()
  })

  it('suspends and resumes', () => {
    store.create('t-2', baseOptions)
    const msg: TextMessage = { kind: 'text', id: 'm1', role: 'user', content: 'hi', createdAt: '2025-01-01' }
    store.appendMessages('t-2', [msg])
    store.suspend('t-2', 'should I continue?')
    const suspended = store.get('t-2')
    expect(suspended?.status).toBe('suspended')
    expect(suspended?.pendingQuestion).toBe('should I continue?')
    expect(suspended?.history).toHaveLength(1)

    store.resume('t-2')
    const resumed = store.get('t-2')
    expect(resumed?.status).toBe('running')
    expect(resumed?.pendingQuestion).toBeUndefined()
  })

  it('completes with output', () => {
    store.create('t-3', baseOptions)
    store.complete('t-3', 'done!')
    const t = store.get('t-3')
    expect(t?.status).toBe('completed')
    expect(t?.output).toBe('done!')
    expect(t?.completedAt).toBeTruthy()
  })

  it('fails with error', () => {
    store.create('t-4', baseOptions)
    store.fail('t-4', 'something went wrong')
    const t = store.get('t-4')
    expect(t?.status).toBe('failed')
    expect(t?.error).toBe('something went wrong')
  })

  it('getByStatus filters correctly', () => {
    store.create('t-5', baseOptions)
    store.create('t-6', baseOptions)
    store.fail('t-6', 'oops')
    const running = store.getByStatus('running')
    expect(running.map(t => t.id)).toContain('t-5')
    expect(running.map(t => t.id)).not.toContain('t-6')
  })

  it('getActive returns running and suspended', () => {
    store.create('t-7', baseOptions)
    store.create('t-8', baseOptions)
    store.suspend('t-8', 'question?')
    store.create('t-9', baseOptions)
    store.complete('t-9', 'done')
    const active = store.getActive()
    const ids = active.map(t => t.id)
    expect(ids).toContain('t-7')
    expect(ids).toContain('t-8')
    expect(ids).not.toContain('t-9')
  })

  it('appendMessages inserts rows and get() retrieves them in rowid order', () => {
    store.create('t-10', baseOptions)
    const m1: TextMessage = { kind: 'text', id: 'n1', role: 'user', content: 'first', createdAt: '2025-01-01T00:00:00Z' }
    const m2: TextMessage = { kind: 'text', id: 'n2', role: 'assistant', content: 'second', createdAt: '2025-01-01T00:00:01Z' }
    store.appendMessages('t-10', [m1])
    store.appendMessages('t-10', [m2])
    const t = store.get('t-10')
    expect(t?.history).toHaveLength(2)
    expect(t?.history[0]?.id).toBe('n1')
    expect(t?.history[1]?.id).toBe('n2')
  })

  it('create assigns colorSlot 0 to the first agent (Phase 18 D-03)', () => {
    const a = store.create('c-1', baseOptions)
    expect(a.colorSlot).toBe(0)
  })

  it('create assigns sequential unoccupied slots (Phase 18 D-04)', () => {
    const a = store.create('c-a', baseOptions)
    const b = store.create('c-b', baseOptions)
    const c = store.create('c-c', baseOptions)
    expect(a.colorSlot).toBe(0)
    expect(b.colorSlot).toBe(1)
    expect(c.colorSlot).toBe(2)
  })

  it('create picks next sequential slot even after an agent completes (color cycle fix)', () => {
    store.create('c-a', baseOptions)           // slot 0
    store.create('c-b', baseOptions)           // slot 1
    store.complete('c-b', 'done')              // completed, but still in recent window
    const c = store.create('c-c', baseOptions) // slot 1 still "occupied" in LRU window → takes slot 2
    expect(c.colorSlot).toBe(2)
  })

  it('create steals the LRU slot when all 7 are occupied (Phase 18 D-04/D-05)', async () => {
    const ids = ['s0','s1','s2','s3','s4','s5','s6']
    for (const id of ids) {
      store.create(id, baseOptions)
      // Ensure each insert has a strictly increasing updated_at via a 2ms gap.
      await new Promise(r => setTimeout(r, 2))
    }
    // All 7 slots occupied by running agents; s0 has the oldest updated_at.
    const overflow = store.create('s7', baseOptions)
    expect(overflow.colorSlot).toBe(0)
  })

  it('getRecent includes colorSlot on returned agents (Phase 18)', () => {
    store.create('r-1', baseOptions)
    const recent = store.getRecent(5)
    expect(recent[0]?.colorSlot).toBe(0)
  })

  it('compactHistory atomically deletes old rows and inserts the summary', () => {
    store.create('t-compact', baseOptions)
    const m1: TextMessage = { kind: 'text', id: 'c1', role: 'user', content: 'a', createdAt: '2025-01-01T00:00:00Z' }
    const m2: TextMessage = { kind: 'text', id: 'c2', role: 'assistant', content: 'b', createdAt: '2025-01-01T00:00:01Z' }
    const m3: TextMessage = { kind: 'text', id: 'c3', role: 'user', content: 'c', createdAt: '2025-01-01T00:00:02Z' }
    store.appendMessages('t-compact', [m1, m2, m3])
    const summary: SummaryMessage = {
      kind: 'summary', id: 'sum-1', content: 'summary of c1+c2',
      summarySpan: ['2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'],
      createdAt: '2025-01-01T00:00:03Z',
    }
    // Delete rows up to and including m2, then insert summary.
    store.compactHistory('t-compact', 'c2', summary)
    const t = store.get('t-compact')
    expect(t?.history).toHaveLength(2)
    expect(t?.history[0]?.id).toBe('sum-1')
    expect(t?.history[0]?.kind).toBe('summary')
    expect(t?.history[1]?.id).toBe('c3')
  })

  it('compactHistory with null summaryMsg performs delete-only (no insert)', () => {
    store.create('t-trim', baseOptions)
    const m1: TextMessage = { kind: 'text', id: 'tr1', role: 'user', content: 'a', createdAt: '2025-01-01T00:00:00Z' }
    const m2: TextMessage = { kind: 'text', id: 'tr2', role: 'user', content: 'b', createdAt: '2025-01-01T00:00:01Z' }
    store.appendMessages('t-trim', [m1, m2])
    store.compactHistory('t-trim', 'tr1', null)
    const t = store.get('t-trim')
    expect(t?.history).toHaveLength(1)
    expect(t?.history[0]?.id).toBe('tr2')
  })

  it('compactHistory is a no-op when deleteBeforeId does not exist', () => {
    store.create('t-nop', baseOptions)
    const m1: TextMessage = { kind: 'text', id: 'n1', role: 'user', content: 'a', createdAt: '2025-01-01T00:00:00Z' }
    store.appendMessages('t-nop', [m1])
    store.compactHistory('t-nop', 'does-not-exist', null)
    const t = store.get('t-nop')
    expect(t?.history).toHaveLength(1)
    expect(t?.history[0]?.id).toBe('n1')
  })

  it('deleteAll removes agent_messages rows before agents rows (FK-safe)', () => {
    store.create('t-del', baseOptions)
    const m1: TextMessage = { kind: 'text', id: 'd1', role: 'user', content: 'x', createdAt: '2025-01-01T00:00:00Z' }
    store.appendMessages('t-del', [m1])
    store.deleteAll()
    expect(store.get('t-del')).toBeNull()
    expect(store.count()).toBe(0)
  })

  it('get returns history=[] for a freshly created agent (no agent_messages rows)', () => {
    const a = store.create('t-empty', baseOptions)
    expect(a.history).toEqual([])
    const fetched = store.get('t-empty')
    expect(fetched?.history).toEqual([])
  })

  it('agent_messages table exists after migration with expected columns', () => {
    // Use the shared freshDb() helper via the existing beforeEach-constructed store's db.
    // Reach into the store constructor-time DB by creating a fresh one here.
    const db = freshDb()
    const cols = (db.prepare("PRAGMA table_info('agent_messages')").all() as { name: string }[])
      .map(c => c.name)
    expect(cols).toEqual(['id', 'agent_id', 'data', 'created_at'])
    const idxRow = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_messages_agent_rowid'").get()
    expect(idxRow).toBeDefined()
    // agents.history column MUST be gone
    const agentCols = (db.prepare("PRAGMA table_info('agents')").all() as { name: string }[]).map(c => c.name)
    expect(agentCols).not.toContain('history')
  })
})

// ─── AgentInboxStore ───────────────────────────────────────────────────────

describe('AgentInboxStore', () => {
  let store: AgentInboxStore

  beforeEach(() => {
    store = new AgentInboxStore(freshDb())
  })

  it('writes and polls messages', () => {
    store.write('t-1', 'update', 'new context')
    const msgs = store.poll('t-1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.type).toBe('update')
    expect(msgs[0]?.payload).toBe('new context')
  })

  it('markProcessed hides messages from poll', () => {
    store.write('t-1', 'retract', null)
    const before = store.poll('t-1')
    store.markProcessed(before[0]!.id)
    const after = store.poll('t-1')
    expect(after).toHaveLength(0)
  })

  it('poll only returns messages for the given agent', () => {
    store.write('t-1', 'update', 'for t1')
    store.write('t-2', 'update', 'for t2')
    expect(store.poll('t-1')).toHaveLength(1)
    expect(store.poll('t-2')).toHaveLength(1)
  })
})

// ─── QueueStore ───────────────────────────────────────────────────────────────

describe('QueueStore', () => {
  let store: QueueStore

  beforeEach(() => {
    store = new QueueStore(freshDb())
  })

  const makeEvent = (id: string): QueueEvent => ({
    type: 'user_message', id, channel: 'discord', text: 'hi', createdAt: '2025-01-01',
  })

  it('enqueues and claims events', () => {
    store.enqueue(makeEvent('e1'), 100)
    const claimed = store.claimNext('default')
    expect(claimed).not.toBeNull()
    expect(claimed!.event.type).toBe('user_message')
  })

  it("enqueue without explicit head_id stamps row with head_id='default' (DATA-01)", () => {
    // Direct DB read — we need to bypass the QueueStore API which Phase 29 does not expose head_id yet.
    // beforeEach builds the store on a freshDb(); we re-enter the same db via store internals indirectly:
    // create a fresh db + store for an isolated check.
    const db = freshDb()
    const localStore = new QueueStore(db)
    localStore.enqueue(makeEvent('e-default'), 50)
    const row = db.prepare("SELECT head_id FROM queue_events WHERE id = ?").get('e-default') as { head_id: string } | undefined
    expect(row?.head_id).toBe('default')
  })

  it('claimNext returns null when empty', () => {
    expect(store.claimNext('default')).toBeNull()
  })

  it('claims highest priority first', () => {
    store.enqueue(makeEvent('e1'), 10)
    store.enqueue(makeEvent('e2'), 100)
    const first = store.claimNext('default')
    expect(first!.event.id).toBe('e2')
  })

  it('ack marks as done', () => {
    store.enqueue(makeEvent('e3'), 10)
    const claimed = store.claimNext('default')!
    store.ack(claimed.rowId)
    // After ack, nothing left to claim
    expect(store.claimNext('default')).toBeNull()
  })

  it('requeueStale resets processing events', () => {
    store.enqueue(makeEvent('e4'), 10)
    store.claimNext('default')  // leaves it in 'processing'
    store.requeueStale('default')
    const claimed = store.claimNext('default')
    expect(claimed).not.toBeNull()
  })

  it('claimAllPendingUserMessages claims only user_message events', () => {
    store.enqueue(makeEvent('u1'), 100)
    store.enqueue(makeEvent('u2'), 100)
    store.enqueue({ type: 'agent_completed', id: 'w1', agentId: 'tent_1', output: 'done', createdAt: '2025-01-01' }, 30)

    const claimed = store.claimAllPendingUserMessages('default')
    expect(claimed).toHaveLength(2)
    expect(claimed.every(c => c.event.type === 'user_message')).toBe(true)
    // worker event is still pending
    const next = store.claimNext('default')
    expect(next!.event.type).toBe('agent_completed')
  })

  it('claimAllPendingUserMessages returns empty when no user messages pending', () => {
    store.enqueue({ type: 'agent_completed', id: 'w1', agentId: 'tent_1', output: 'done', createdAt: '2025-01-01' }, 30)
    expect(store.claimAllPendingUserMessages('default')).toHaveLength(0)
  })

  it('claimAllPendingUserMessages does not re-claim already-processing events', () => {
    store.enqueue(makeEvent('u1'), 100)
    store.claimNext('default')  // u1 is now 'processing'
    store.enqueue(makeEvent('u2'), 100)

    const claimed = store.claimAllPendingUserMessages('default')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.event.id).toBe('u2')
  })

  // ─── Phase 29: head_id isolation (DATA-03) ──────────────────────────────────

  it('claimNext(headId) never returns an event with a different head_id (DATA-03)', () => {
    const db = freshDb()
    const localStore = new QueueStore(db)
    // Insert two events with explicit head_ids via direct SQL since QueueStore.enqueue does not yet accept head_id.
    db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run('e-personal', 'user_message', JSON.stringify({ type: 'user_message', id: 'e-personal', channel: 'discord', text: 'p', createdAt: '2025-01-01' }), 100, 'personal')
    db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run('e-work', 'user_message', JSON.stringify({ type: 'user_message', id: 'e-work', channel: 'discord', text: 'w', createdAt: '2025-01-01' }), 100, 'work')

    const claimed = localStore.claimNext('personal')
    expect(claimed).not.toBeNull()
    expect(claimed!.event.id).toBe('e-personal')
    // The 'work' event must still be pending.
    const stillPending = db.prepare("SELECT id, status FROM queue_events WHERE id = 'e-work'").get() as { id: string; status: string }
    expect(stillPending.status).toBe('pending')
    // And claimNext('work') retrieves it.
    const workClaim = localStore.claimNext('work')
    expect(workClaim!.event.id).toBe('e-work')
  })

  it('claimNext(headId) returns null when no events for that head (DATA-03)', () => {
    const db = freshDb()
    const localStore = new QueueStore(db)
    db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run('e-work', 'user_message', JSON.stringify({ type: 'user_message', id: 'e-work', channel: 'x', text: 'w', createdAt: '2025-01-01' }), 100, 'work')
    expect(localStore.claimNext('personal')).toBeNull()
  })

  it('claimAllPendingBackground(headId) scopes to head (DATA-03)', () => {
    const db = freshDb()
    const localStore = new QueueStore(db)
    const bg = (id: string, head: string) =>
      db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(id, 'agent_completed', JSON.stringify({ type: 'agent_completed', id, agentId: 't1', output: 'x', createdAt: '2025-01-01' }), 30, head)
    bg('bg-p1', 'personal')
    bg('bg-p2', 'personal')
    bg('bg-w1', 'work')

    const personal = localStore.claimAllPendingBackground('personal')
    expect(personal.map(c => c.event.id).sort()).toEqual(['bg-p1', 'bg-p2'])
    const work = localStore.claimAllPendingBackground('work')
    expect(work.map(c => c.event.id)).toEqual(['bg-w1'])
  })

  it('claimAllPendingUserMessages(headId) scopes to head (DATA-03)', () => {
    const db = freshDb()
    const localStore = new QueueStore(db)
    const um = (id: string, head: string) =>
      db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(id, 'user_message', JSON.stringify({ type: 'user_message', id, channel: 'discord', text: 't', createdAt: '2025-01-01' }), 100, head)
    um('um-p1', 'personal')
    um('um-w1', 'work')

    const personal = localStore.claimAllPendingUserMessages('personal')
    expect(personal.map(c => c.event.id)).toEqual(['um-p1'])
    const work = localStore.claimAllPendingUserMessages('work')
    expect(work.map(c => c.event.id)).toEqual(['um-w1'])
  })

  it('claimNext(headId) respects priority within the head (DATA-03)', () => {
    const db = freshDb()
    const localStore = new QueueStore(db)
    const ins = (id: string, prio: number) =>
      db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', 'personal')`)
        .run(id, 'user_message', JSON.stringify({ type: 'user_message', id, channel: 'discord', text: 't', createdAt: '2025-01-01' }), prio)
    ins('low', 10)
    ins('high', 100)
    const first = localStore.claimNext('personal')
    expect(first!.event.id).toBe('high')
  })
})

// ─── UsageStore ───────────────────────────────────────────────────────────────

describe('UsageStore', () => {
  let store: UsageStore

  beforeEach(() => {
    store = new UsageStore(freshDb(), 'UTC')
  })

  it('records and retrieves by source', () => {
    store.record({ sourceType: 'head', sourceId: 'ev-1', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, costUsd: 0 })
    const entries = store.getBySource('head', 'ev-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.inputTokens).toBe(100)
    expect(entries[0]?.model).toBe('claude-sonnet-4-6')
  })

  it('summarizes total tokens', () => {
    store.record({ sourceType: 'head', sourceId: null, model: 'model-a', inputTokens: 100, outputTokens: 50, costUsd: 0 })
    store.record({ sourceType: 'agent', sourceId: 't-1', model: 'model-a', inputTokens: 200, outputTokens: 100, costUsd: 0 })
    store.record({ sourceType: 'curator', sourceId: null, model: 'model-b', inputTokens: 50, outputTokens: 25, costUsd: 0 })
    const summary = store.summarize()
    expect(summary.inputTokens).toBe(350)
    expect(summary.outputTokens).toBe(175)
    expect(summary.byModel['model-a']?.input).toBe(300)
    expect(summary.byModel['model-b']?.input).toBe(50)
  })

  it('getDailyTrend groups by local day in the configured timezone, across DST', () => {
    const db = freshDb()
    const tzStore = new UsageStore(db, 'America/New_York')

    // DST 2025 jumps at 07:00 UTC March 9 (02:00 EST → 03:00 EDT).
    //   u1: 2025-03-09 04:00 UTC = 23:00 March 8 EST → NY day "2025-03-08"
    //   u2: 2025-03-09 06:00 UTC = 01:00 March 9 EST → NY day "2025-03-09" (pre-jump, still EST)
    //   u3: 2025-03-09 08:00 UTC = 04:00 March 9 EDT → NY day "2025-03-09" (post-jump, now EDT)
    //   u4: 2025-03-10 02:00 UTC = 22:00 March 9 EDT → NY day "2025-03-09"
    const insert = db.prepare(
      `INSERT INTO usage (id, source_type, source_id, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, 'head', NULL, 'm', ?, ?, ?, ?)`
    )
    insert.run('u1', 100, 50, 1.0, '2025-03-09 04:00:00')
    insert.run('u2', 100, 50, 2.0, '2025-03-09 06:00:00')
    insert.run('u3', 100, 50, 3.0, '2025-03-09 08:00:00')
    insert.run('u4', 100, 50, 4.0, '2025-03-10 02:00:00')

    const since = new Date('2025-03-08T00:00:00Z')
    const trend = tzStore.getDailyTrend(since)

    expect(trend).toHaveLength(2)
    expect(trend[0]).toEqual({ day: '2025-03-08', costUsd: 1.0, inputTokens: 100, outputTokens: 50 })
    expect(trend[1]).toEqual({ day: '2025-03-09', costUsd: 9.0, inputTokens: 300, outputTokens: 150 })
  })
})

// ─── AppStateStore ────────────────────────────────────────────────────────────

describe('AppStateStore', () => {
  let store: AppStateStore

  beforeEach(() => {
    store = new AppStateStore(freshDb())
  })

  it('getLastActiveChannel defaults to empty string', () => {
    expect(store.getLastActiveChannel('default')).toBe('')
  })

  it('sets and gets last active channel', () => {
    store.setLastActiveChannel('default', 'discord')
    expect(store.getLastActiveChannel('default')).toBe('discord')
  })

  it('tryAcquireArchivalLock succeeds first time', () => {
    expect(store.tryAcquireArchivalLock('default')).toBe(true)
  })

  it('tryAcquireArchivalLock fails when already held', () => {
    store.tryAcquireArchivalLock('default')
    expect(store.tryAcquireArchivalLock('default')).toBe(false)
  })

  it('releaseArchivalLock allows re-acquisition', () => {
    store.tryAcquireArchivalLock('default')
    store.releaseArchivalLock('default')
    expect(store.tryAcquireArchivalLock('default')).toBe(true)
  })

  describe('AppStateStore — per-head isolation (Phase 30)', () => {
    let store: AppStateStore

    beforeEach(() => {
      store = new AppStateStore(freshDb())
    })

    it('setLastActiveChannel on one head does not affect another', () => {
      store.setLastActiveChannel('personal', 'discord')
      store.setLastActiveChannel('work', 'telegram')
      expect(store.getLastActiveChannel('personal')).toBe('discord')
      expect(store.getLastActiveChannel('work')).toBe('telegram')
    })

    it('getLastActiveChannel returns "" for an unset head even when other heads have a value', () => {
      store.setLastActiveChannel('personal', 'discord')
      expect(store.getLastActiveChannel('work')).toBe('')
    })

    it('tryAcquireArchivalLock is independent per head', () => {
      expect(store.tryAcquireArchivalLock('personal')).toBe(true)
      expect(store.tryAcquireArchivalLock('personal')).toBe(false)
      expect(store.tryAcquireArchivalLock('work')).toBe(true)
      expect(store.tryAcquireArchivalLock('work')).toBe(false)
    })

    it('releaseArchivalLock on one head does not release another', () => {
      store.tryAcquireArchivalLock('personal')
      store.tryAcquireArchivalLock('work')
      store.releaseArchivalLock('personal')
      expect(store.tryAcquireArchivalLock('personal')).toBe(true)
      expect(store.tryAcquireArchivalLock('work')).toBe(false)
    })

    it('rejects empty headId', () => {
      expect(() => store.getLastActiveChannel('')).toThrow(/invalid headId/)
      expect(() => store.setLastActiveChannel('', 'x')).toThrow(/invalid headId/)
      expect(() => store.tryAcquireArchivalLock('')).toThrow(/invalid headId/)
      expect(() => store.releaseArchivalLock('')).toThrow(/invalid headId/)
    })

    it('rejects headId containing colon (prevents key-collision injection)', () => {
      expect(() => store.getLastActiveChannel('a:b')).toThrow(/invalid headId/)
      expect(() => store.setLastActiveChannel('a:b', 'x')).toThrow(/invalid headId/)
      expect(() => store.tryAcquireArchivalLock('a:b')).toThrow(/invalid headId/)
      expect(() => store.releaseArchivalLock('a:b')).toThrow(/invalid headId/)
    })

    it('threshold methods remain global — no headId parameter (regression guard)', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      expect(store.getThresholds()).toHaveLength(1)
      expect(store.getThresholds()[0]!.id).toBe(t.id)
      // Type-level guarantee: these calls would fail tsc if headId became a parameter.
      store.updateThreshold(t.id, { amountUsd: 6 })
      store.deleteThreshold(t.id)
    })
  })

  describe('migration 006 — rename flat AppStateStore keys to default-prefixed', () => {
    it('renames pre-existing last_active_channel and archival_lock rows on upgrade', () => {
      // Simulate a pre-Phase-30 DB: apply migrations 001-005 only, manually insert
      // legacy flat keys, then apply 006 and confirm AppStateStore reads them under
      // the 'default' head.
      const db = freshDb()
      // freshDb() already runs ALL migrations including 006, so use raw inserts that
      // would be visible if 006 had renamed pre-existing rows. To simulate the
      // pre-006 state, insert with the OLD key names and observe that the seed-time
      // 006 already ran (which is a no-op on a fresh DB). Then re-insert with old
      // names and re-run only the 006 SQL to validate the UPDATE behavior.
      db.exec("INSERT INTO app_state (key, value) VALUES ('last_active_channel', 'telegram-legacy')")
      db.exec("INSERT INTO app_state (key, value) VALUES ('archival_lock', 'false')")
      // Re-execute the 006 migration body to exercise the rename path.
      const migrationPath = path.join(MIGRATIONS_DIR, '006_rename_app_state_keys.sql')
      const sql = fs.readFileSync(migrationPath, 'utf8')
      db.exec(sql)

      const store = new AppStateStore(db)
      expect(store.getLastActiveChannel('default')).toBe('telegram-legacy')
      // archival_lock value 'false' means the lock is free and can be acquired
      expect(store.tryAcquireArchivalLock('default')).toBe(true)
    })

    it('migration 006 is idempotent — re-running does not fail when default-prefixed row already exists', () => {
      const db = freshDb()
      // Manually create both the old AND the new key — exercise the NOT EXISTS guard
      db.exec("INSERT INTO app_state (key, value) VALUES ('last_active_channel', 'old-value')")
      db.exec("INSERT OR IGNORE INTO app_state (key, value) VALUES ('default:last_active_channel', 'new-value')")
      const migrationPath = path.join(MIGRATIONS_DIR, '006_rename_app_state_keys.sql')
      const sql = fs.readFileSync(migrationPath, 'utf8')
      // Must not throw on the PRIMARY KEY collision — NOT EXISTS guards it.
      expect(() => db.exec(sql)).not.toThrow()
      // The 'default:'-prefixed row wins; the legacy row is left behind (harmless).
      const store = new AppStateStore(db)
      expect(store.getLastActiveChannel('default')).toBe('new-value')
    })
  })

  describe('usage thresholds', () => {
    it('returns empty array when none set', () => {
      expect(store.getThresholds()).toEqual([])
    })

    it('addThreshold appends and returns the new record with a generated id', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      expect(t.id).toMatch(/^threshold_/)
      expect(t.period).toBe('day')
      expect(t.amountUsd).toBe(5)
      expect(t.action).toBe('alert')

      const all = store.getThresholds()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual(t)
    })

    // Regression guard for the explicit-field-listing bug: addThreshold builds
    // its record by listing fields explicitly, so any new field on UsageThreshold
    // must be added to the construction or it gets silently dropped on persist.
    // Combined with the read-side action default-to-'alert' coercion, a missing
    // action propagation would round-trip every block threshold back to 'alert'.
    // This test asserts that a 'block' action survives the full persist+read cycle.
    it('addThreshold round-trips the action field through persist+read (block)', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'block' })
      expect(t.action).toBe('block')

      const persisted = store.getThresholds()
      expect(persisted).toHaveLength(1)
      expect(persisted[0]?.action).toBe('block')
    })

    it('preserves multiple thresholds across periods', () => {
      const t1 = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      const t2 = store.addThreshold({ period: 'week', amountUsd: 25, action: 'alert' })
      const t3 = store.addThreshold({ period: 'month', amountUsd: 100, action: 'alert' })
      expect(store.getThresholds()).toEqual([t1, t2, t3])
    })

    it('updateThreshold patches fields by id and returns the merged record', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      const updated = store.updateThreshold(t.id, { amountUsd: 7 })
      expect(updated).toEqual({ id: t.id, period: 'day', amountUsd: 7, action: 'alert' })
      expect(store.getThresholds()).toEqual([updated])
    })

    it('updateThreshold returns null for unknown id and leaves the list unchanged', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      expect(store.updateThreshold('threshold_does_not_exist', { amountUsd: 99 })).toBeNull()
      expect(store.getThresholds()).toEqual([t])
    })

    it('updateThreshold supports partial patches (e.g. period only)', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      const updated = store.updateThreshold(t.id, { period: 'week' })
      expect(updated?.period).toBe('week')
      expect(updated?.amountUsd).toBe(5)
    })

    it('deleteThreshold removes by id and returns true', () => {
      const t1 = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      const t2 = store.addThreshold({ period: 'week', amountUsd: 25, action: 'alert' })
      expect(store.deleteThreshold(t1.id)).toBe(true)
      expect(store.getThresholds()).toEqual([t2])
    })

    it('deleteThreshold returns false for unknown id and leaves the list unchanged', () => {
      const t1 = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      expect(store.deleteThreshold('threshold_does_not_exist')).toBe(false)
      expect(store.getThresholds()).toEqual([t1])
    })

    it('returns [] gracefully when stored JSON is corrupted', () => {
      // This test wants its own db handle (separate from the beforeEach store)
      // so it can inject garbage into the underlying row without reaching
      // into the store's private fields.
      const db = freshDb()
      const localStore = new AppStateStore(db)
      db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('usage_thresholds', 'not-json')").run()
      expect(localStore.getThresholds()).toEqual([])
    })
  })

  describe('usage thresholds — fired state', () => {
    it('returns null when never fired', () => {
      expect(store.getThresholdFiredAt('t1')).toBeNull()
    })

    it('setThresholdFiredAt records a timestamp that getThresholdFiredAt reads back', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:30:00Z'))
      expect(store.getThresholdFiredAt('t1')?.toISOString()).toBe('2026-04-09T12:30:00.000Z')
    })

    it('setThresholdFiredAt defaults to now when no Date is passed', () => {
      store.setThresholdFiredAt('t1')
      const got = store.getThresholdFiredAt('t1')
      expect(got).toBeInstanceOf(Date)
      expect(Date.now() - got!.getTime()).toBeLessThan(1000)
    })

    it('setThresholdFiredAt overwrites prior fires for the same id', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:00:00Z'))
      store.setThresholdFiredAt('t1', new Date('2026-04-09T13:00:00Z'))
      expect(store.getThresholdFiredAt('t1')?.toISOString()).toBe('2026-04-09T13:00:00.000Z')
    })

    it('tracks fired state for multiple thresholds independently', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:00:00Z'))
      store.setThresholdFiredAt('t2', new Date('2026-04-09T13:00:00Z'))
      expect(store.getThresholdFiredAt('t1')?.toISOString()).toBe('2026-04-09T12:00:00.000Z')
      expect(store.getThresholdFiredAt('t2')?.toISOString()).toBe('2026-04-09T13:00:00.000Z')
    })

    it('getAllThresholdFiredAt returns the full fired-state map for the checker', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:00:00Z'))
      store.setThresholdFiredAt('t2', new Date('2026-04-09T13:00:00Z'))
      const all = store.getAllThresholdFiredAt()
      expect(Object.keys(all).sort()).toEqual(['t1', 't2'])
      expect(all['t1']?.toISOString()).toBe('2026-04-09T12:00:00.000Z')
      expect(all['t2']?.toISOString()).toBe('2026-04-09T13:00:00.000Z')
    })

    it('clearThresholdFiredAt removes a single entry without touching others', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:00:00Z'))
      store.setThresholdFiredAt('t2', new Date('2026-04-09T13:00:00Z'))
      store.clearThresholdFiredAt('t1')
      expect(store.getThresholdFiredAt('t1')).toBeNull()
      expect(store.getThresholdFiredAt('t2')?.toISOString()).toBe('2026-04-09T13:00:00.000Z')
    })

    it('clearThresholdFiredAt is a no-op for unknown ids', () => {
      store.setThresholdFiredAt('t1', new Date('2026-04-09T12:00:00Z'))
      store.clearThresholdFiredAt('unknown')
      expect(store.getThresholdFiredAt('t1')?.toISOString()).toBe('2026-04-09T12:00:00.000Z')
    })

    it('deleteThreshold clears its fired state automatically', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      store.setThresholdFiredAt(t.id, new Date('2026-04-09T12:00:00Z'))
      expect(store.getThresholdFiredAt(t.id)).not.toBeNull()
      store.deleteThreshold(t.id)
      expect(store.getThresholdFiredAt(t.id)).toBeNull()
    })

    it('updateThreshold clears fired state when period changes (avoids stale-stamp silence)', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      store.setThresholdFiredAt(t.id, new Date('2026-04-09T14:00:00Z'))
      store.updateThreshold(t.id, { period: 'month' })
      expect(store.getThresholdFiredAt(t.id)).toBeNull()
    })

    it('updateThreshold preserves fired state when period is unchanged but other fields edit', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      store.setThresholdFiredAt(t.id, new Date('2026-04-09T14:00:00Z'))
      store.updateThreshold(t.id, { amountUsd: 10 })
      expect(store.getThresholdFiredAt(t.id)?.toISOString()).toBe('2026-04-09T14:00:00.000Z')
    })

    it('updateThreshold preserves fired state when period is in the patch but unchanged', () => {
      const t = store.addThreshold({ period: 'day', amountUsd: 5, action: 'alert' })
      store.setThresholdFiredAt(t.id, new Date('2026-04-09T14:00:00Z'))
      store.updateThreshold(t.id, { period: 'day', amountUsd: 6 })
      expect(store.getThresholdFiredAt(t.id)?.toISOString()).toBe('2026-04-09T14:00:00.000Z')
    })

    it('returns empty map gracefully when stored JSON is corrupted', () => {
      const db = freshDb()
      const localStore = new AppStateStore(db)
      db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('usage_thresholds_fired', 'not-json')").run()
      expect(localStore.getThresholdFiredAt('t1')).toBeNull()
      expect(localStore.getAllThresholdFiredAt()).toEqual({})
    })

    it('skips entries with non-string values (e.g. number) and keeps the good ones', () => {
      // {"t_bad": 42, "t_good": "..."} — `new Date(42)` would silently produce
      // the epoch and make the threshold appear to have fired in 1970.
      const db = freshDb()
      const localStore = new AppStateStore(db)
      db.prepare(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES ('usage_thresholds_fired', '{\"t_bad\":42,\"t_good\":\"2026-04-09T12:00:00.000Z\"}')"
      ).run()
      expect(localStore.getThresholdFiredAt('t_bad')).toBeNull()
      expect(localStore.getThresholdFiredAt('t_good')?.toISOString()).toBe('2026-04-09T12:00:00.000Z')
      expect(localStore.getAllThresholdFiredAt()).toEqual({
        t_good: new Date('2026-04-09T12:00:00.000Z'),
      })
    })

    it('skips entries with unparseable date strings (would otherwise become NaN)', () => {
      // {"t_bad": "garbage", "t_good": "..."} — `new Date("garbage").getTime()`
      // is NaN, and `periodStart > NaN` is always false, silently disabling
      // the threshold forever. Skip + WARN is the only safe behavior.
      const db = freshDb()
      const localStore = new AppStateStore(db)
      db.prepare(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES ('usage_thresholds_fired', '{\"t_bad\":\"garbage\",\"t_good\":\"2026-04-09T12:00:00.000Z\"}')"
      ).run()
      expect(localStore.getThresholdFiredAt('t_bad')).toBeNull()
      expect(localStore.getThresholdFiredAt('t_good')?.toISOString()).toBe('2026-04-09T12:00:00.000Z')
    })
  })

  describe('seedDefaultThreshold', () => {
    it('fresh install seeds a $50/day block threshold exactly once', () => {
      const localStore = new AppStateStore(freshDb())
      expect(localStore.getThresholds()).toEqual([])
      expect(localStore.seedDefaultThreshold()).toBe(true)
      const list = localStore.getThresholds()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        period: 'day',
        amountUsd: 50,
        action: 'block',
      })
    })

    it('idempotent on second call', () => {
      const localStore = new AppStateStore(freshDb())
      expect(localStore.seedDefaultThreshold()).toBe(true)
      expect(localStore.seedDefaultThreshold()).toBe(false)
      const list = localStore.getThresholds()
      expect(list).toHaveLength(1)
      expect(list[0]?.amountUsd).toBe(50)
    })

    it('block-halt semantics fire at the seeded $50 amount', () => {
      const localStore = new AppStateStore(freshDb())
      localStore.seedDefaultThreshold()
      const crossings = findBlockingThresholds(localStore.getThresholds(), () => 50, new Date(), 'UTC')
      expect(crossings).toHaveLength(1)
      expect(crossings[0]?.threshold.amountUsd).toBe(50)
      const msg = formatThresholdBlock(crossings[0]!)
      expect(msg).toContain('Shrok has stopped')
      expect(msg).toContain('$50.00')
    })
  })

})

// ─── ScheduleStore ────────────────────────────────────────────────────────────

describe('ScheduleStore', () => {
  let store: ScheduleStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'))
    store = new ScheduleStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates and retrieves a schedule', () => {
    const s = store.create({ id: 's-1', taskName: 'email', cron: '*/3 * * * *', nextRun: '2025-01-01T00:03:00Z' })
    expect(s.id).toBe('s-1')
    expect(s.taskName).toBe('email')
    expect(s.cron).toBe('*/3 * * * *')
    expect(s.enabled).toBe(true)
  })

  it('lists schedules', () => {
    store.create({ id: 's-1', taskName: 'a', nextRun: '2025-01-01T01:00:00Z' })
    store.create({ id: 's-2', taskName: 'b', nextRun: '2025-01-01T02:00:00Z' })
    expect(store.list()).toHaveLength(2)
  })

  it('deletes a schedule', () => {
    store.create({ id: 's-1', taskName: 'a' })
    store.delete('s-1')
    expect(store.get('s-1')).toBeNull()
  })

  it('getDue returns only due schedules', () => {
    store.create({ id: 's-1', taskName: 'early', nextRun: '2025-01-01T00:00:00Z' })
    store.create({ id: 's-2', taskName: 'future', nextRun: '2025-12-31T00:00:00Z' })
    const due = store.getDue('2025-06-01T00:00:00Z')
    expect(due.map(s => s.id)).toContain('s-1')
    expect(due.map(s => s.id)).not.toContain('s-2')
  })

  it('updates enabled flag', () => {
    store.create({ id: 's-1', taskName: 'a', nextRun: '2025-01-01T01:00:00Z' })
    store.update('s-1', { enabled: false })
    expect(store.get('s-1')?.enabled).toBe(false)
  })

  it('markFired updates lastRun and nextRun', () => {
    store.create({ id: 's-1', taskName: 'a', cron: '0 * * * *' })
    store.markFired('s-1', '2025-01-01T01:00:00Z', '2025-01-01T02:00:00Z')
    const s = store.get('s-1')!
    expect(s.lastRun).toBe('2025-01-01T01:00:00Z')
    expect(s.nextRun).toBe('2025-01-01T02:00:00Z')
  })

  it('delete removes the schedule from the store', () => {
    store.create({ id: 's-1', taskName: 'a', runAt: '2025-01-01T00:00:00Z' })
    store.delete('s-1')
    expect(store.get('s-1')).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  // ── target_kind / kind (Plan 04-01) ─────────────────────────────────────────

  it('create({kind:"task"}) persists and reads back as kind: "task"', () => {
    const s = store.create({ id: 's-job', taskName: 'vacuum', kind: 'task', nextRun: '2025-01-01T00:00:00Z' })
    expect(s.kind).toBe('task')
    expect(store.get('s-job')!.kind).toBe('task')
  })

  it('create without kind defaults to "task"', () => {
    const s = store.create({ id: 's-task-default', taskName: 'email', nextRun: '2025-01-01T00:00:00Z' })
    expect(s.kind).toBe('task')
    expect(store.get('s-task-default')!.kind).toBe('task')
  })

  it('corrupt file is skipped gracefully by list()', () => {
    store.create({ id: 's-good', taskName: 'good', nextRun: '2025-01-01T00:00:00Z' })
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), 'not valid json', 'utf8')
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('s-good')
  })

  // ── kind:'reminder' (Plan 12-01) ────────────────────────────────────────────

  it('create({kind:"reminder"}) persists and reads back as kind: "reminder"', () => {
    const s = store.create({ id: 'rem-sched-1', kind: 'reminder', agentContext: 'Buy milk', runAt: '2026-05-01T09:00:00Z' })
    expect(s.kind).toBe('reminder')
    expect(s.agentContext).toBe('Buy milk')
    expect(store.get('rem-sched-1')!.kind).toBe('reminder')
    expect(store.get('rem-sched-1')!.agentContext).toBe('Buy milk')
  })

  it('list().filter(s => s.kind === "reminder") returns only reminder entries', () => {
    store.create({ id: 'rem-sched-2', kind: 'reminder', agentContext: 'Hello', runAt: '2026-05-01T09:00:00Z' })
    store.create({ id: 's-task-1', taskName: 'email', kind: 'task', nextRun: '2025-01-01T00:00:00Z' })
    const reminders = store.list().filter(s => s.kind === 'reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.id).toBe('rem-sched-2')
  })
})
