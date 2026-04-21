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
    const msgs = store.getRecent(10_000)
    expect(msgs).toHaveLength(1)
    const m = msgs[0] as TextMessage
    expect(m.kind).toBe('text')
    expect(m.content).toBe('hello')
    expect(m.channel).toBe('discord')
  })

  it('appends tool_call messages', () => {
    const msg: ToolCallMessage = {
      kind: 'tool_call', id: 'msg-2', content: '',
      toolCalls: [{ id: 'tc1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: '2025-01-01T00:00:01Z',
    }
    store.append(msg)
    const msgs = store.getRecent(10_000)
    expect(msgs[0]?.kind).toBe('tool_call')
  })

  it('appends tool_result messages', () => {
    const msg: ToolResultMessage = {
      kind: 'tool_result', id: 'msg-3',
      toolResults: [{ toolCallId: 'tc1', name: 'bash', content: 'file.ts' }],
      createdAt: '2025-01-01T00:00:02Z',
    }
    store.append(msg)
    const msgs = store.getRecent(10_000)
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
    const msgs = store.getRecent(costPerMsg * 3)
    expect(msgs.length).toBeLessThanOrEqual(3)
  })

  it('getSince returns only messages at or after the datetime', () => {
    store.append({ kind: 'text', id: 'early', role: 'user', content: 'early', createdAt: '2025-01-01T00:00:00Z' })
    store.append({ kind: 'text', id: 'late', role: 'user', content: 'late', createdAt: '2025-01-02T00:00:00Z' })
    const msgs = store.getSince('2025-01-02T00:00:00Z')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.id).toBe('late')
  })

  it('getRecentBefore returns messages before datetime', () => {
    store.append({ kind: 'text', id: 'a', role: 'user', content: 'a', createdAt: '2025-01-01T00:00:00Z' })
    store.append({ kind: 'text', id: 'b', role: 'user', content: 'b', createdAt: '2025-01-02T00:00:00Z' })
    const msgs = store.getRecentBefore('2025-01-02T00:00:00Z', 10_000)
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
    const msgs = store.getRecent(100_000)
    const m = msgs[0] as TextMessage
    expect(m.attachments).toHaveLength(2)
    expect(m.attachments![0]!.type).toBe('image')
    expect(m.attachments![0]!.filename).toBe('photo.jpg')
    expect(m.attachments![0]!.size).toBe(12345)
    expect(m.attachments![1]!.durationSeconds).toBe(8.5)
  })

  it('message without attachments has no attachments key', () => {
    store.append({ kind: 'text', id: 'msg-noatt', role: 'user', content: 'plain', createdAt: '2025-01-01T00:00:10Z' })
    const msgs = store.getRecent(100_000)
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
    const msgs = store.getRecent(10_000)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.kind).toBe('summary')
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
    const msgs: TextMessage[] = [{ kind: 'text', id: 'm1', role: 'user', content: 'hi', createdAt: '2025-01-01' }]
    store.suspend('t-2', msgs, 'should I continue?')
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
    store.complete('t-3', 'done!', [])
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
    store.suspend('t-8', [], 'question?')
    store.create('t-9', baseOptions)
    store.complete('t-9', 'done', [])
    const active = store.getActive()
    const ids = active.map(t => t.id)
    expect(ids).toContain('t-7')
    expect(ids).toContain('t-8')
    expect(ids).not.toContain('t-9')
  })

  it('appendToHistory adds a message to serialized history', () => {
    store.create('t-10', baseOptions)
    const note: TextMessage = { kind: 'text', id: 'n1', role: 'user', content: 'note', createdAt: '2025-01-01' }
    store.appendToHistory('t-10', note)
    const t = store.get('t-10')
    expect(t?.history).toHaveLength(1)
    expect(t?.history[0]?.id).toBe('n1')
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
    const claimed = store.claimNext()
    expect(claimed).not.toBeNull()
    expect(claimed!.event.type).toBe('user_message')
  })

  it('claimNext returns null when empty', () => {
    expect(store.claimNext()).toBeNull()
  })

  it('claims highest priority first', () => {
    store.enqueue(makeEvent('e1'), 10)
    store.enqueue(makeEvent('e2'), 100)
    const first = store.claimNext()
    expect(first!.event.id).toBe('e2')
  })

  it('ack marks as done', () => {
    store.enqueue(makeEvent('e3'), 10)
    const claimed = store.claimNext()!
    store.ack(claimed.rowId)
    // After ack, nothing left to claim
    expect(store.claimNext()).toBeNull()
  })

  it('requeueStale resets processing events', () => {
    store.enqueue(makeEvent('e4'), 10)
    store.claimNext()  // leaves it in 'processing'
    store.requeueStale()
    const claimed = store.claimNext()
    expect(claimed).not.toBeNull()
  })

  it('claimAllPendingUserMessages claims only user_message events', () => {
    store.enqueue(makeEvent('u1'), 100)
    store.enqueue(makeEvent('u2'), 100)
    store.enqueue({ type: 'agent_completed', id: 'w1', agentId: 'tent_1', output: 'done', createdAt: '2025-01-01' }, 30)

    const claimed = store.claimAllPendingUserMessages()
    expect(claimed).toHaveLength(2)
    expect(claimed.every(c => c.event.type === 'user_message')).toBe(true)
    // worker event is still pending
    const next = store.claimNext()
    expect(next!.event.type).toBe('agent_completed')
  })

  it('claimAllPendingUserMessages returns empty when no user messages pending', () => {
    store.enqueue({ type: 'agent_completed', id: 'w1', agentId: 'tent_1', output: 'done', createdAt: '2025-01-01' }, 30)
    expect(store.claimAllPendingUserMessages()).toHaveLength(0)
  })

  it('claimAllPendingUserMessages does not re-claim already-processing events', () => {
    store.enqueue(makeEvent('u1'), 100)
    store.claimNext()  // u1 is now 'processing'
    store.enqueue(makeEvent('u2'), 100)

    const claimed = store.claimAllPendingUserMessages()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.event.id).toBe('u2')
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
    expect(store.getLastActiveChannel()).toBe('')
  })

  it('sets and gets last active channel', () => {
    store.setLastActiveChannel('discord')
    expect(store.getLastActiveChannel()).toBe('discord')
  })

  it('tryAcquireArchivalLock succeeds first time', () => {
    expect(store.tryAcquireArchivalLock()).toBe(true)
  })

  it('tryAcquireArchivalLock fails when already held', () => {
    store.tryAcquireArchivalLock()
    expect(store.tryAcquireArchivalLock()).toBe(false)
  })

  it('releaseArchivalLock allows re-acquisition', () => {
    store.tryAcquireArchivalLock()
    store.releaseArchivalLock()
    expect(store.tryAcquireArchivalLock()).toBe(true)
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
    const s = store.create({ id: 's-1', skillName: 'email', cron: '*/3 * * * *', nextRun: '2025-01-01T00:03:00Z' })
    expect(s.id).toBe('s-1')
    expect(s.skillName).toBe('email')
    expect(s.cron).toBe('*/3 * * * *')
    expect(s.enabled).toBe(true)
  })

  it('lists schedules', () => {
    store.create({ id: 's-1', skillName: 'a', nextRun: '2025-01-01T01:00:00Z' })
    store.create({ id: 's-2', skillName: 'b', nextRun: '2025-01-01T02:00:00Z' })
    expect(store.list()).toHaveLength(2)
  })

  it('deletes a schedule', () => {
    store.create({ id: 's-1', skillName: 'a' })
    store.delete('s-1')
    expect(store.get('s-1')).toBeNull()
  })

  it('getDue returns only due schedules', () => {
    store.create({ id: 's-1', skillName: 'early', nextRun: '2025-01-01T00:00:00Z' })
    store.create({ id: 's-2', skillName: 'future', nextRun: '2025-12-31T00:00:00Z' })
    const due = store.getDue('2025-06-01T00:00:00Z')
    expect(due.map(s => s.id)).toContain('s-1')
    expect(due.map(s => s.id)).not.toContain('s-2')
  })

  it('updates enabled flag', () => {
    store.create({ id: 's-1', skillName: 'a', nextRun: '2025-01-01T01:00:00Z' })
    store.update('s-1', { enabled: false })
    expect(store.get('s-1')?.enabled).toBe(false)
  })

  it('markFired updates lastRun and nextRun', () => {
    store.create({ id: 's-1', skillName: 'a', cron: '0 * * * *' })
    store.markFired('s-1', '2025-01-01T01:00:00Z', '2025-01-01T02:00:00Z')
    const s = store.get('s-1')!
    expect(s.lastRun).toBe('2025-01-01T01:00:00Z')
    expect(s.nextRun).toBe('2025-01-01T02:00:00Z')
  })

  it('completeOneTime disables the schedule', () => {
    store.create({ id: 's-1', skillName: 'a', runAt: '2025-01-01T00:00:00Z' })
    store.completeOneTime('s-1', '2025-01-01T00:00:00Z')
    const s = store.get('s-1')!
    expect(s.enabled).toBe(false)
    expect(s.nextRun).toBeNull()
  })

  // ── target_kind / kind (Plan 04-01) ─────────────────────────────────────────

  it('create({kind:"task"}) persists and reads back as kind: "task"', () => {
    const s = store.create({ id: 's-job', skillName: 'vacuum', kind: 'task', nextRun: '2025-01-01T00:00:00Z' })
    expect(s.kind).toBe('task')
    expect(store.get('s-job')!.kind).toBe('task')
  })

  it('create without kind defaults to "task"', () => {
    const s = store.create({ id: 's-task-default', skillName: 'email', nextRun: '2025-01-01T00:00:00Z' })
    expect(s.kind).toBe('task')
    expect(store.get('s-task-default')!.kind).toBe('task')
  })

  it('corrupt file is skipped gracefully by list()', () => {
    store.create({ id: 's-good', skillName: 'good', nextRun: '2025-01-01T00:00:00Z' })
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), 'not valid json', 'utf8')
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('s-good')
  })

  // ── kind:'reminder' (Plan 12-01) ────────────────────────────────────────────

  it('create({kind:"reminder"}) persists and reads back as kind: "reminder"', () => {
    const s = store.create({ id: 'rem-sched-1', skillName: 'rem-sched-1', kind: 'reminder', agentContext: 'Buy milk', runAt: '2026-05-01T09:00:00Z' })
    expect(s.kind).toBe('reminder')
    expect(s.agentContext).toBe('Buy milk')
    expect(store.get('rem-sched-1')!.kind).toBe('reminder')
    expect(store.get('rem-sched-1')!.agentContext).toBe('Buy milk')
  })

  it('list().filter(s => s.kind === "reminder") returns only reminder entries', () => {
    store.create({ id: 'rem-sched-2', skillName: 'rem-sched-2', kind: 'reminder', agentContext: 'Hello', runAt: '2026-05-01T09:00:00Z' })
    store.create({ id: 's-task-1', skillName: 'email', kind: 'task', nextRun: '2025-01-01T00:00:00Z' })
    const reminders = store.list().filter(s => s.kind === 'reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.id).toBe('rem-sched-2')
  })
})
