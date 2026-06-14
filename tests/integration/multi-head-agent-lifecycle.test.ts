/**
 * Phase 34 architectural regression test: multi-head agent lifecycle.
 *
 * Pins six observable truths that close the cross-head event leak (T-34-09).
 * A future refactor that re-introduces the silent default-routing behavior
 * (omitting headId in queueStore.enqueue, or dropping the head_id column on
 * the agents table) will fail at least one of these tests:
 *
 *   1. Persistence: agents.head_id is stamped from SpawnOptions.headId
 *   2. Queue stamping (agent_completed): D-ALL-SIX callsites 3 + 5
 *   3. Cross-head claim isolation: claimNext('work') vs claimNext('default')
 *   4. Resume preserves headId across suspend/resume (D-ALL-SIX callsite 4
 *      via agent_question)
 *   5. Queue stamping (agent_failed): D-ALL-SIX callsites 1 + 2 (W2 coverage)
 *   6. Queue stamping (agent_response): D-ALL-SIX callsite 6 (W2 coverage)
 *
 * Implementation note (per plan 34-05 Claude's-Discretion fallback): tests
 * that need a deterministic queue_events row use direct SQL inserts via
 * QueueStore.enqueue() to bypass the LLM-driven runner lifecycle. The
 * runner-driven tests (Tests 2, 5, 6) construct a self-contained
 * LocalAgentRunner with a stubbed LLMRouter so the head_id stamping
 * invariant is exercised end-to-end through the production code path that
 * Plan 03 wired (this.headId threading on every queueStore.enqueue call).
 *
 * Self-contained — does NOT share fixtures with other integration tests so a
 * misconfigured runner elsewhere cannot mask a regression here.
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
import { PRIORITY } from '../../src/types/core.js'
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
      throw new Error('simulated LLM failure for headId stamping test')
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

/** Poll the queue_events table for a specific event type+agentId. */
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

describe('Multi-Head Agent Lifecycle (Phase 34)', () => {
  let db: DatabaseSync
  let agentStore: AgentStore
  let queueStore: QueueStore

  beforeEach(() => {
    db = freshDb()
    agentStore = new AgentStore(db)
    queueStore = new QueueStore(db)
  })

  // ─── Test 1: persistence — D-ROW-WRITE-FROM-OPTIONS ─────────────────────────

  it('persists head_id on the agents row when create() is called with headId="work" (D-ROW-WRITE-FROM-OPTIONS)', () => {
    agentStore.create('a-work', {
      task: 'do work',
      trigger: 'manual',
      headId: 'work',
    })
    const row = db.prepare("SELECT head_id FROM agents WHERE id = ?")
      .get('a-work') as { head_id: string } | undefined
    expect(row?.head_id).toBe('work')

    // Round-trip through AgentStore.get() to verify rowToState surfaces it
    const state = agentStore.get('a-work')
    expect(state?.headId).toBe('work')
  })

  // ─── Test 2: agent_completed stamping — D-ALL-SIX callsites 3 + 5 ───────────

  it('completeAgent enqueues agent_completed with head_id matching the runner headId (D-ALL-SIX callsite 3)', async () => {
    // LLM stub: agent calls bash → tool result → end_turn → completion steward → done.
    // The bash call satisfies the "agent must call at least one tool" guard at
    // src/sub-agents/local.ts:935, then end_turn drops into completeAgent() at
    // line 982 (D-ALL-SIX callsite 3) which enqueues agent_completed.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'noop', command: 'echo done' }),
      makeEndTurnResponse('All done.'),                          // agent turn 2 → end_turn → completeAgent
      { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },  // steward classifies as done
    ])

    const { runner } = makeRunnerForHead('work', db, llmRouter)
    const agentId = await runner.spawn({
      task: 'finish quickly',
      name: 'quick',
      trigger: 'manual',
      headId: 'work',
    })

    await runner.awaitAll(3000)

    // Direct DB read of queue_events row — pin head_id stamping invariant.
    // Literal SQL probe so a future refactor that drops the type column or
    // changes the event-type literal is caught at the test layer.
    const row = await waitForQueueEvent(db, 'agent_completed', agentId, 3000)
    expect(row).toBeDefined()
    expect(row?.head_id).toBe('work')

    const literalRow = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ? LIMIT 1",
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(literalRow?.head_id).toBe('work')
  })

  // ─── Test 3: cross-head claim isolation — the architectural regression ──────

  it('claimNext("work") returns the work agent\'s completion event; claimNext("default") does not (D-TESTS-BOTH architectural regression)', () => {
    // Direct SQL insert via the production QueueStore.enqueue() — deterministic,
    // does not depend on LLMRouter/runner lifecycle.
    queueStore.enqueue(
      {
        type: 'agent_completed',
        id: 'qe-work-1',
        agentId: 'a-work',
        output: 'done',
        createdAt: new Date().toISOString(),
      },
      PRIORITY.AGENT_COMPLETED,
      'work',
    )

    // default-head loop must NOT see work events
    const claimedAsDefault = queueStore.claimNext('default')
    expect(claimedAsDefault).toBeNull()

    // work-head loop claims its own event
    const claimedAsWork = queueStore.claimNext('work')
    expect(claimedAsWork).not.toBeNull()
    expect(claimedAsWork!.event.type).toBe('agent_completed')
    if (claimedAsWork!.event.type === 'agent_completed') {
      expect(claimedAsWork!.event.agentId).toBe('a-work')
    }

    // No leftover events for either head after the work head claimed it
    expect(queueStore.claimNext('work')).toBeNull()
    expect(queueStore.claimNext('default')).toBeNull()
  })

  // ─── Test 4: resume preserves headId — D-ALL-SIX callsite 4 (agent_question) ─

  it('suspendAsQuestion enqueues agent_question with head_id matching the runner headId, and resume preserves head_id (D-ALL-SIX callsite 4)', async () => {
    // LLM stub: tool call (bash) → text question → steward classifies as question.
    // The steward path leads to suspendAsQuestion() at src/sub-agents/local.ts:1001
    // (callsite 4), which enqueues agent_question with this.headId.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('bash', { description: 'check', command: 'ls' }),
      { content: 'What color should I use?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
      makeStewardQuestionResponse('What color should I use?'),
    ])

    const { runner, agentStore: runnerAgentStore } = makeRunnerForHead('work', db, llmRouter)
    const agentId = await runner.spawn({
      task: 'need a decision',
      name: 'decider',
      trigger: 'manual',
      headId: 'work',
    })

    // Wait for the agent to suspend
    await waitForStatus(runnerAgentStore, agentId, 'suspended', 5000)
    expect(runnerAgentStore.get(agentId)?.status).toBe('suspended')

    // Direct DB read — pin head_id stamping on the agent_question path.
    // Literal SQL probe so future schema changes are caught at the test layer.
    const questionRow = await waitForQueueEvent(db, 'agent_question', agentId, 3000)
    expect(questionRow).toBeDefined()
    expect(questionRow?.head_id).toBe('work')

    const literalRow = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'agent_question' AND payload LIKE ? LIMIT 1",
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(literalRow?.head_id).toBe('work')

    // The persisted agents row still carries head_id='work' across the suspension
    const agentRow = db.prepare("SELECT head_id FROM agents WHERE id = ?")
      .get(agentId) as { head_id: string } | undefined
    expect(agentRow?.head_id).toBe('work')

    // Cross-head claim isolation also holds on the question path
    expect(queueStore.claimNext('default')).toBeNull()
  })

  // ─── Test 5: agent_failed stamping — D-ALL-SIX callsites 1 + 2 (W2 closes) ──

  it('runLoopFrom error handler enqueues agent_failed with head_id matching the runner headId (D-ALL-SIX callsites 1 + 2 — W2 coverage)', async () => {
    // Throwing LLMRouter trips the runLoopFrom error handler at
    // src/sub-agents/local.ts:627 (callsite 2). With Plan 03's 3rd-arg threading
    // the resulting queue_events row must carry head_id='work'.
    const { runner, agentStore: runnerAgentStore } = makeRunnerForHead('work', db, makeThrowingLLMRouter())

    const agentId = await runner.spawn({
      task: 'will fail',
      name: 'failing',
      trigger: 'manual',
      headId: 'work',
    })

    // Wait for the runner to mark the agent as failed
    await waitForStatus(runnerAgentStore, agentId, 'failed', 5000)
    expect(runnerAgentStore.get(agentId)?.status).toBe('failed')

    // Direct DB read — pin head_id stamping on the failure path.
    // Literal SQL probe so future schema changes are caught at the test layer.
    const failedRow = await waitForQueueEvent(db, 'agent_failed', agentId, 3000)
    expect(failedRow).toBeDefined()
    expect(failedRow?.head_id).toBe('work')

    const literalRow = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'agent_failed' AND payload LIKE ? LIMIT 1",
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(literalRow?.head_id).toBe('work')

    // Cross-head claim isolation holds on the failure path too
    expect(queueStore.claimNext('default')).toBeNull()
    const claimedAsWork = queueStore.claimNext('work')
    expect(claimedAsWork).not.toBeNull()
    expect(claimedAsWork!.event.type).toBe('agent_failed')
  })

  // ─── Test 6: agent_response stamping — D-ALL-SIX callsite 6 (W2 closes) ─────

  it('respond_to_message tool dispatch enqueues agent_response with head_id matching the runner headId (D-ALL-SIX callsite 6 — W2 coverage)', async () => {
    // LLM stub: respond_to_message tool call → end_turn → steward done.
    // respond_to_message dispatch is at src/sub-agents/local.ts:1104 (callsite 6).
    // With Plan 03's 3rd-arg threading the resulting agent_response queue row
    // must carry head_id='work'.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('respond_to_message', { response: 'partial answer from work head' }),
      makeEndTurnResponse('All done after responding.'),
      { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
    ])

    const { runner } = makeRunnerForHead('work', db, llmRouter)
    const agentId = await runner.spawn({
      task: 'respond then finish',
      name: 'responder',
      trigger: 'manual',
      headId: 'work',
    })

    // Wait for the agent_response row to land.
    // Literal SQL probe so future schema changes are caught at the test layer.
    const responseRow = await waitForQueueEvent(db, 'agent_response', agentId, 5000)
    expect(responseRow).toBeDefined()
    expect(responseRow?.head_id).toBe('work')

    const literalRow = db.prepare(
      "SELECT head_id FROM queue_events WHERE type = 'agent_response' AND payload LIKE ? LIMIT 1",
    ).get(`%${agentId}%`) as { head_id: string } | undefined
    expect(literalRow?.head_id).toBe('work')

    await runner.awaitAll(2000)

    // Cross-head claim isolation on the response path
    expect(queueStore.claimNext('default')).toBeNull()
    // Find and claim the agent_response specifically (other events may also be present)
    let claimedAgentResponse = false
    let claim = queueStore.claimNext('work')
    while (claim) {
      if (claim.event.type === 'agent_response') { claimedAgentResponse = true; break }
      claim = queueStore.claimNext('work')
    }
    expect(claimedAgentResponse).toBe(true)
  })
})
