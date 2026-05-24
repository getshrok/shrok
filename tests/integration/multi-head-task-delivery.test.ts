/**
 * Phase 44 architectural regression test: multi-head task delivery.
 *
 * Pins five observable truths that close the multi-head delivery gap (T-44-12).
 * A future refactor that re-introduces single-head completion routing, removes
 * the scheduled-question gate, or fans out agent_failed will fail at least one
 * of these tests:
 *
 *   1. Fan-out: one agent with deliverToHeadIds:['b'] → two agent_completed events
 *      ({head_id:'a'} and {head_id:'b'}), same agentId, exactly ONE agents row.
 *   2. Dedup: owner listed in both headId and deliverToHeadIds → two rows total,
 *      not three (the Set dedup in [...new Set([this.headId, ...])] holds).
 *   3. No-delivery-set regression: absent deliverToHeadIds → single completion
 *      event head_id='a' (byte-equivalent to pre-Phase-44 behavior).
 *   4. Question-suppression (D-06): trigger:'scheduled' + steward returns 'question'
 *      → agent reaches status:'completed', not 'suspended'.
 *   5. agent_failed owner-only (D-05): failing scheduled agent with
 *      deliverToHeadIds:['b'] → exactly one agent_failed event, head_id='a'
 *      (owner), none for head_id='b'.
 *
 * Self-contained — does NOT import shared test helpers so a misconfigured
 * helper elsewhere cannot silently mask a regression here
 * (Phase 34 D-SELF-CONTAINED-REGRESSION-TEST precedent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { AgentStore } from '../../src/db/agents.js'
import { AgentInboxStore } from '../../src/db/agent_inbox.js'
import { QueueStore } from '../../src/db/queue.js'
import { UsageStore } from '../../src/db/usage.js'
import { LocalAgentRunner } from '../../src/sub-agents/local.js'
import type { LLMRouter, LLMResponse } from '../../src/types/llm.js'
import type { SkillLoader } from '../../src/types/skill.js'
import type { McpRegistry } from '../../src/mcp/registry.js'
import type { IdentityLoader } from '../../src/identity/loader.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

// ─── Test fixtures ────────────────────────────────────────────────────────────

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function makeLLMRouter(responses: LLMResponse[]): LLMRouter {
  let i = 0
  return {
    complete: vi.fn().mockImplementation(async () => {
      const resp = responses[i] ?? responses[responses.length - 1]!
      i++
      return resp
    }),
  }
}

function makeThrowingLLMRouter(): LLMRouter {
  return {
    complete: vi.fn().mockImplementation(async () => {
      throw new Error('simulated LLM failure for agent_failed owner-only test')
    }),
  }
}

function makeEndTurnResponse(content = 'Done.'): LLMResponse {
  return {
    content,
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

function makeToolCallResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 10,
    stopReason: 'tool_use',
    toolCalls: [{ id: `tc_${Math.random().toString(36).slice(2, 9)}`, name: toolName, input }],
  }
}

/** Completion steward response — classify agent output as a question. */
function makeStewardQuestionResponse(question: string): LLMResponse {
  return {
    content: JSON.stringify({ type: 'question', question }),
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

/** Build a minimal LocalAgentRunner bound to a specific head. The bundle
 *  shares the supplied DB so direct SQL probes from the test can read the
 *  agents and queue_events tables. */
function makeRunnerForHead(headId: string, db: DatabaseSync, llmRouter: LLMRouter) {
  const agentStore = new AgentStore(db)
  const inboxStore = new AgentInboxStore(db)
  const queueStore = new QueueStore(db)
  const usageStore = new UsageStore(db, 'UTC')

  const skillLoader: SkillLoader = {
    load: vi.fn().mockReturnValue(null),
    listAll: vi.fn().mockReturnValue([]),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn(),
  } as unknown as SkillLoader

  const mcpRegistry: McpRegistry = {
    listCapabilities: vi.fn().mockReturnValue([]),
    loadTools: vi.fn().mockResolvedValue([]),
  }

  const identityLoader: IdentityLoader = {
    loadSystemPrompt: vi.fn().mockReturnValue('You are a helpful assistant.'),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
  }

  const agentIdentityLoader: IdentityLoader = {
    loadSystemPrompt: vi.fn().mockReturnValue(''),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
  }

  const runner = new LocalAgentRunner({
    headId,
    agentStore,
    inboxStore,
    queueStore,
    usageStore,
    skillLoader,
    skillsDir: '/tmp',
    workspacePath: null,
    mcpRegistry,
    identityLoader,
    agentIdentityLoader,
    llmRouter,
    pollIntervalMs: 50,
    checkStatusTimeoutMs: 500,
    timezone: 'UTC',
  })

  return { runner, agentStore, inboxStore, queueStore, usageStore }
}

/** Poll the queue_events table for a specific event type+agentId (first match). */
async function waitForQueueEvent(
  db: DatabaseSync,
  type: string,
  agentId: string,
  timeoutMs = 5000,
): Promise<{ head_id: string; payload: string } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = db.prepare(
      `SELECT head_id, payload FROM queue_events WHERE type = ? AND payload LIKE ? LIMIT 1`,
    ).get(type, `%${agentId}%`) as { head_id: string; payload: string } | undefined
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return undefined
}

/** Poll until at least `minCount` rows exist for the given event type+agentId. */
async function waitForAllQueueEvents(
  db: DatabaseSync,
  type: string,
  agentId: string,
  minCount: number,
  timeoutMs = 5000,
): Promise<Array<{ head_id: string; payload: string }>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = db.prepare(
      `SELECT head_id, payload FROM queue_events WHERE type = ? AND payload LIKE ?`,
    ).all(type, `%${agentId}%`) as Array<{ head_id: string; payload: string }>
    if (rows.length >= minCount) return rows
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return db.prepare(
    `SELECT head_id, payload FROM queue_events WHERE type = ? AND payload LIKE ?`,
  ).all(type, `%${agentId}%`) as Array<{ head_id: string; payload: string }>
}

async function waitForStatus(
  agentStore: AgentStore,
  agentId: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (agentStore.get(agentId)?.status === status) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Multi-Head Task Delivery (Phase 44)', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = freshDb()
  })

  // ─── Test 1: fan-out (both fan-out sites) ────────────────────────────────────

  it('fan-out: deliverToHeadIds:["b"] on a scheduled agent produces two distinct agent_completed events (head_id "a" and "b") with one agents row (D-FAN-OUT-BOTH-SITES)', async () => {
    // LLM stub: tool call → end_turn → steward done.
    // The agent runs once; completeAgent() fans out to heads 'a' and 'b'.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'noop', command: 'echo done' }),
      makeEndTurnResponse('Fan-out complete.'),
      { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
    ])

    const { runner, agentStore } = makeRunnerForHead('a', db, llmRouter)
    const agentId = await runner.spawn({
      prompt: 'fan-out test',
      name: 'fan-out-agent',
      trigger: 'scheduled',
      headId: 'a',
      deliverToHeadIds: ['b'],
    })

    await runner.awaitAll(5000)

    // Wait for both head_id values to appear in queue_events
    const rows = await waitForAllQueueEvents(db, 'agent_completed', agentId, 2, 5000)

    // Both 'a' and 'b' must be present — same agentId, different head_id
    const headIds = new Set(rows.map(r => r.head_id))
    expect(headIds).toEqual(new Set(['a', 'b']))

    // Literal SQL probe — two rows, not one, not three
    const allRows = db.prepare(
      `SELECT head_id FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ?`,
    ).all(`%${agentId}%`) as Array<{ head_id: string }>
    expect(allRows.length).toBe(2)
    expect(new Set(allRows.map(r => r.head_id))).toEqual(new Set(['a', 'b']))

    // Core promise: the work ran ONCE — exactly one agents row for this agentId
    const agentCountRow = db.prepare(
      `SELECT COUNT(*) AS n FROM agents WHERE id = ?`,
    ).get(agentId) as { n: number }
    expect(agentCountRow.n).toBe(1)

    // Agent reached completed status
    expect(agentStore.get(agentId)?.status).toBe('completed')
  })

  // ─── Test 2: dedup — owner in both headId and deliverToHeadIds ───────────────

  it('dedup: owner "a" listed in both headId and deliverToHeadIds:["a","b"] yields exactly two agent_completed events (D-DEDUP-OWNER)', async () => {
    // The Set dedup [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
    // ensures the owner is not double-enqueued.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'noop', command: 'echo dedup' }),
      makeEndTurnResponse('Dedup complete.'),
      { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
    ])

    const { runner } = makeRunnerForHead('a', db, llmRouter)
    const agentId = await runner.spawn({
      prompt: 'dedup test',
      name: 'dedup-agent',
      trigger: 'scheduled',
      headId: 'a',
      deliverToHeadIds: ['a', 'b'],   // owner 'a' listed explicitly — must be deduped
    })

    await runner.awaitAll(5000)

    // Wait for at least 2 rows
    const rows = await waitForAllQueueEvents(db, 'agent_completed', agentId, 2, 5000)

    // Exactly two rows: 'a' and 'b' — 'a' is NOT double-enqueued
    expect(rows.length).toBe(2)
    const headIds = new Set(rows.map(r => r.head_id))
    expect(headIds).toEqual(new Set(['a', 'b']))

    // Literal SQL count — must be exactly 2
    const countRow = db.prepare(
      `SELECT COUNT(*) AS n FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ?`,
    ).get(`%${agentId}%`) as { n: number }
    expect(countRow.n).toBe(2)
  })

  // ─── Test 3: no-delivery-set regression ─────────────────────────────────────

  it('no-delivery-set regression: absent deliverToHeadIds yields exactly one agent_completed event with head_id "a" (byte-equivalent to pre-Phase-44)', async () => {
    // Absent deliverToHeadIds → deliverySet === [this.headId] → single enqueue.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'noop', command: 'echo regression' }),
      makeEndTurnResponse('Regression check done.'),
      { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
    ])

    const { runner } = makeRunnerForHead('a', db, llmRouter)
    const agentId = await runner.spawn({
      prompt: 'regression test',
      name: 'regression-agent',
      trigger: 'scheduled',
      headId: 'a',
      // deliverToHeadIds intentionally absent — pre-Phase-44 behavior
    })

    await runner.awaitAll(5000)

    // First event must exist with head_id 'a'
    const row = await waitForQueueEvent(db, 'agent_completed', agentId, 5000)
    expect(row).toBeDefined()
    expect(row?.head_id).toBe('a')

    // Exactly one row — no phantom delivery to any other head
    const countRow = db.prepare(
      `SELECT COUNT(*) AS n FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ?`,
    ).get(`%${agentId}%`) as { n: number }
    expect(countRow.n).toBe(1)

    // Literal SQL probe
    const literalRow = db.prepare(
      `SELECT head_id FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ? LIMIT 1`,
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(literalRow?.head_id).toBe('a')
  })

  // ─── Test 4: question-suppression (D-06) ────────────────────────────────────

  it('question-suppression (D-06): a scheduled agent whose steward classifies output as "question" reaches status "completed", not "suspended"', async () => {
    // D-06: suspendAsQuestion() force-completes when trigger === 'scheduled' because
    // scheduled agents have no human attached — the question text becomes output.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'check', command: 'ls' }),
      { content: 'Should I use option A or B?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
      makeStewardQuestionResponse('Should I use option A or B?'),
    ])

    const { runner, agentStore } = makeRunnerForHead('a', db, llmRouter)
    const agentId = await runner.spawn({
      prompt: 'question-suppression test',
      name: 'question-agent',
      trigger: 'scheduled',     // D-06 gate — must not suspend
      headId: 'a',
    })

    await runner.awaitAll(5000)

    // Agent must reach 'completed', NOT 'suspended'
    await waitForStatus(agentStore, agentId, 'completed', 5000)
    expect(agentStore.get(agentId)?.status).toBe('completed')

    // An agent_completed event must exist for this agentId
    const completedRow = await waitForQueueEvent(db, 'agent_completed', agentId, 3000)
    expect(completedRow).toBeDefined()
    expect(completedRow?.head_id).toBe('a')

    // No agent_question event must exist — the question was force-completed
    const questionRow = db.prepare(
      `SELECT head_id FROM queue_events WHERE type = 'agent_question' AND payload LIKE ? LIMIT 1`,
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(questionRow).toBeUndefined()
  })

  // ─── Test 5: agent_failed owner-only (D-05) ──────────────────────────────────

  it('agent_failed owner-only (D-05): a failing scheduled agent with deliverToHeadIds:["b"] enqueues agent_failed only for head_id "a" (owner), none for "b"', async () => {
    // D-05: agent_failed enqueue stays owner-only (this.headId) — the fan-out loop
    // is NOT applied to the failure path. This ensures failure notifications are
    // not noisy across all delivery heads.
    const { runner, agentStore } = makeRunnerForHead('a', db, makeThrowingLLMRouter())

    const agentId = await runner.spawn({
      prompt: 'will fail',
      name: 'failing-agent',
      trigger: 'scheduled',
      headId: 'a',
      deliverToHeadIds: ['b'],   // 'b' must NOT receive the agent_failed event
    })

    // Wait for the agent to reach failed status
    await waitForStatus(agentStore, agentId, 'failed', 5000)
    expect(agentStore.get(agentId)?.status).toBe('failed')

    // Exactly ONE agent_failed event for this agentId
    const failedRows = db.prepare(
      `SELECT head_id FROM queue_events WHERE type = 'agent_failed' AND payload LIKE ?`,
    ).all(`%${agentId}%`) as Array<{ head_id: string }>
    expect(failedRows.length).toBe(1)

    // The one event belongs to the owner 'a', not 'b'
    expect(failedRows[0]?.head_id).toBe('a')

    // Literal SQL probe — no row with head_id='b' for agent_failed
    const bRow = db.prepare(
      `SELECT head_id FROM queue_events WHERE type = 'agent_failed' AND head_id = 'b' AND payload LIKE ? LIMIT 1`,
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(bRow).toBeUndefined()
  })
})
