import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { UsageStore } from './usage.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function insertAgent(db: DatabaseSync, id: string, skillName: string, trigger: string | null): void {
  // agents table columns (per sql/010): id, skill_name, status, task, instructions, tier, tools, capabilities, trigger, ...
  // We hand-write the minimum needed; unset columns rely on table defaults / nullability.
  if (trigger === null) {
    db.prepare(`INSERT INTO agents (id, skill_name, status, task, trigger) VALUES (?, ?, 'completed', '', NULL)`).run(id, skillName)
  } else {
    db.prepare(`INSERT INTO agents (id, skill_name, status, task, trigger) VALUES (?, ?, 'completed', '', ?)`).run(id, skillName, trigger)
  }
}

describe('UsageStore.getSummary.bySource', () => {
  let db: DatabaseSync
  let usage: UsageStore

  beforeEach(() => {
    db = freshDb()
    usage = new UsageStore(db, 'UTC')
  })

  it('aggregates by bucket: head, curator, archival, manual_agents, scheduled_agent per skill_name', () => {
    // Seed agents.
    insertAgent(db, 'agent_A', 'foo', 'manual')
    insertAgent(db, 'agent_B', 'bar', 'ad_hoc')
    insertAgent(db, 'agent_C', 'daily-report', 'scheduled')
    insertAgent(db, 'agent_D', 'daily-report', 'scheduled')

    // head / curator / archival
    usage.record({ sourceType: 'head', sourceId: 'evt1', model: 'm', inputTokens: 100, outputTokens: 10, costUsd: 1.0 })
    usage.record({ sourceType: 'curator', sourceId: null, model: 'm', inputTokens: 50, outputTokens: 5, costUsd: 0.5 })
    usage.record({ sourceType: 'archival', sourceId: null, model: 'm', inputTokens: 20, outputTokens: 2, costUsd: 0.2 })

    // agent rows
    usage.record({ sourceType: 'agent', sourceId: 'agent_A', model: 'm', inputTokens: 10, outputTokens: 1, costUsd: 0.10 })
    usage.record({ sourceType: 'agent', sourceId: 'agent_B', model: 'm', inputTokens: 20, outputTokens: 2, costUsd: 0.20 })
    usage.record({ sourceType: 'agent', sourceId: 'agent_C', model: 'm', inputTokens: 30, outputTokens: 3, costUsd: 2.00 })
    usage.record({ sourceType: 'agent', sourceId: 'agent_D', model: 'm', inputTokens: 40, outputTokens: 4, costUsd: 3.00 })

    const summary = usage.getSummary()
    const bySource = summary.bySource

    // head / curator / archival each appear once
    const head = bySource.find(r => r.bucket === 'head')
    const curator = bySource.find(r => r.bucket === 'curator')
    const archival = bySource.find(r => r.bucket === 'archival')
    expect(head).toBeDefined()
    expect(head!.costUsd).toBeCloseTo(1.0, 6)
    expect(curator!.costUsd).toBeCloseTo(0.5, 6)
    expect(archival!.costUsd).toBeCloseTo(0.2, 6)

    // manual_agents collapses A + B
    const manual = bySource.filter(r => r.bucket === 'manual_agents')
    expect(manual).toHaveLength(1)
    expect(manual[0]!.costUsd).toBeCloseTo(0.30, 6)
    expect(manual[0]!.trigger).toBeUndefined()

    // scheduled_agent: C + D collapse on skill_name
    const scheduled = bySource.filter(r => r.bucket === 'scheduled_agent')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.name).toBe('daily-report')
    expect(scheduled[0]!.costUsd).toBeCloseTo(5.0, 6)
    expect(scheduled[0]!.trigger).toBe('scheduled')

    // sorted desc by costUsd
    for (let i = 1; i < bySource.length; i++) {
      expect(bySource[i - 1]!.costUsd).toBeGreaterThanOrEqual(bySource[i]!.costUsd)
    }

    // legacy bySourceType back-compat
    expect(summary.bySourceType.head).toBeDefined()
    expect(summary.bySourceType.agent).toBeDefined()
    expect(summary.bySourceType.agent!.costUsd).toBeCloseTo(5.30, 6)
  })

  it('folds agents with unknown trigger (orphaned source_id) into manual_agents', () => {
    // Usage row references a source_id with no matching agents row — LEFT JOIN
    // yields NULL for trigger/skill_name, COALESCE maps trigger to 'unknown'.
    usage.record({ sourceType: 'agent', sourceId: 'agent_missing', model: 'm', inputTokens: 5, outputTokens: 1, costUsd: 0.05 })

    const summary = usage.getSummary()
    const manual = summary.bySource.filter(r => r.bucket === 'manual_agents')
    expect(manual).toHaveLength(1)
    expect(manual[0]!.costUsd).toBeCloseTo(0.05, 6)
  })

  it('record() persists trigger + target_name columns (ATTR-02)', () => {
    usage.record({
      sourceType: 'agent', sourceId: 'agent_X', model: 'm',
      inputTokens: 1, outputTokens: 1, costUsd: 0.01,
      trigger: 'scheduled', targetName: 'nightly-vacuum',
    })
    const row = db.prepare(`SELECT trigger, target_name FROM usage WHERE source_id = 'agent_X'`).get() as { trigger: string; target_name: string }
    expect(row.trigger).toBe('scheduled')
    expect(row.target_name).toBe('nightly-vacuum')
  })

  it('bySource: new path — u.trigger + u.target_name authoritative with no agents row (ATTR-02)', () => {
    // No agents row inserted for 'nope'; the denormalized usage columns alone
    // must drive the scheduled_agent bucket via COALESCE(u.trigger, a.trigger).
    usage.record({
      sourceType: 'agent', sourceId: 'nope', model: 'm',
      inputTokens: 7, outputTokens: 3, costUsd: 1.23,
      trigger: 'scheduled', targetName: 'nightly-vacuum',
    })
    const { bySource } = usage.getSummary()
    const scheduled = bySource.filter(r => r.bucket === 'scheduled_agent')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.name).toBe('nightly-vacuum')
    expect(scheduled[0]!.costUsd).toBeCloseTo(1.23, 6)
    expect(scheduled[0]!.trigger).toBe('scheduled')
  })

  it('bySource: legacy fallback — u.trigger/target_name NULL still bucket via agents JOIN (ATTR-02)', () => {
    // Pre-026 usage row: no trigger/targetName passed; COALESCE must fall
    // through to agents.trigger + agents.skill_name.
    insertAgent(db, 'agent_L', 'daily-ping', 'scheduled')
    usage.record({
      sourceType: 'agent', sourceId: 'agent_L', model: 'm',
      inputTokens: 4, outputTokens: 2, costUsd: 0.42,
    })
    const { bySource } = usage.getSummary()
    const scheduled = bySource.filter(r => r.bucket === 'scheduled_agent')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.name).toBe('daily-ping')
    expect(scheduled[0]!.costUsd).toBeCloseTo(0.42, 6)
  })
})

describe('UsageStore.getCacheSummary', () => {
  let db: DatabaseSync
  let usage: UsageStore

  beforeEach(() => {
    db = freshDb()
    usage = new UsageStore(db, 'UTC')
  })

  it('records cache token columns and getCacheSummary returns them', () => {
    usage.record({
      sourceType: 'head', sourceId: null, model: 'm',
      inputTokens: 1000, outputTokens: 100, costUsd: 0.01,
      cacheReadTokens: 500, cacheWriteTokens: 100,
    })
    const summary = usage.getCacheSummary()
    expect(summary.cacheReadTokens).toBe(500)
    expect(summary.cacheWriteTokens).toBe(100)
    expect(summary.totalInputTokens).toBe(1000)
  })

  it('accumulates cache fields across multiple entries; entries without cache fields default to 0', () => {
    usage.record({
      sourceType: 'head', sourceId: null, model: 'm',
      inputTokens: 1000, outputTokens: 100, costUsd: 0.01,
      cacheReadTokens: 500, cacheWriteTokens: 100,
    })
    // Entry without cache fields — should default to 0
    usage.record({
      sourceType: 'agent', sourceId: null, model: 'm',
      inputTokens: 200, outputTokens: 50, costUsd: 0.005,
    })
    const summary = usage.getCacheSummary()
    expect(summary.cacheReadTokens).toBe(500)
    expect(summary.cacheWriteTokens).toBe(100)
    expect(summary.totalInputTokens).toBe(1200)
  })

  it('since filter restricts results to the given period', () => {
    // Insert a row with a specific created_at in the past
    const pastDate = '2020-01-01 00:00:00'
    db.prepare(`
      INSERT INTO usage (id, source_type, source_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_write_tokens)
      VALUES ('u_old', 'head', NULL, 'm', 800, 80, 0.01, 400, 50)
    `).run()
    db.prepare(`UPDATE usage SET created_at = ? WHERE id = 'u_old'`).run(pastDate)

    // Insert a recent row
    usage.record({
      sourceType: 'head', sourceId: null, model: 'm',
      inputTokens: 300, outputTokens: 30, costUsd: 0.005,
      cacheReadTokens: 150, cacheWriteTokens: 20,
    })

    // Without since — should include both rows
    const all = usage.getCacheSummary()
    expect(all.cacheReadTokens).toBe(550)
    expect(all.cacheWriteTokens).toBe(70)

    // With since='2021-01-01 00:00:00' — should only include the recent row
    const recent = usage.getCacheSummary('2021-01-01 00:00:00')
    expect(recent.cacheReadTokens).toBe(150)
    expect(recent.cacheWriteTokens).toBe(20)
    expect(recent.totalInputTokens).toBe(300)
  })
})
