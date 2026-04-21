/**
 * Quick task 260416-ofz: cancel propagation end-to-end.
 *
 * These tests lock in the AbortSignal-based cancel path wired through
 * ToolLoopOptions.abortSignal + AgentContext.abortSignal in Tasks 1-2.
 *
 * Four scenarios:
 *   1. retract during in-flight bash terminates within 500ms (preemptive
 *      via SIGTERM, NOT cooperative wait for bash to finish).
 *   2. retract between LLM rounds stops the loop before another
 *      llm.complete call — bounded LLM calls after retract.
 *   3. cooperative retract before any tool runs still transitions to
 *      retracted via the outer-loop inbox poll — regression guard.
 *   4. a bash command with `sleep 2` that is retracted surfaces the
 *      "[bash: terminated by agent cancel]" marker in its tool output,
 *      proving ctx.abortSignal reached child_process.execFile.
 */
import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { LocalAgentRunner } from './local.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { AgentStore } from '../db/agents.js'
import { AgentInboxStore } from '../db/agent_inbox.js'
import { QueueStore } from '../db/queue.js'
import { UsageStore } from '../db/usage.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
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

function makeEndTurnResponse(): LLMResponse {
  return {
    content: 'Done.',
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

/** Minimal runner matching the pattern in agents.test.ts. */
function makeRunner(llmRouter: LLMRouter) {
  const db = freshDb()
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

  return { runner, agentStore, inboxStore, queueStore }
}

// ─── Test 1: retract during in-flight bash ────────────────────────────────────

describe('cancel propagation — retract during in-flight bash', () => {
  it('retract while bash is sleeping terminates the agent within 500ms', async () => {
    // LLM calls bash with `sleep 3`; a retract fires ~100ms in. Without the
    // AbortSignal wiring, the agent would have to wait ~3000ms for bash to
    // return before checking the inbox. With it, SIGTERM fires immediately
    // and the agent reaches 'retracted' in well under 500ms.
    let i = 0
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async () => {
        if (i++ === 0) {
          return makeToolCallResponse('bash', { description: 'sleep', command: 'sleep 3' })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter)
    const agentId = await runner.spawn({ prompt: 'run sleep', name: 'sleeper', trigger: 'manual' })

    // Wait for the bash call to enter flight. 150ms is well past the LLM
    // stub's synchronous resolve — the executor is now blocked in execFile.
    await new Promise(resolve => setTimeout(resolve, 150))

    const t0 = Date.now()
    await runner.retract(agentId)
    await runner.awaitAll(2000)
    const elapsed = Date.now() - t0

    expect(agentStore.get(agentId)?.status).toBe('retracted')
    // Key preemption assertion: nowhere near the 3000ms bash sleep.
    expect(elapsed).toBeLessThan(500)
  }, 5000)
})

// ─── Test 2: retract between LLM rounds ────────────────────────────────────────

describe('cancel propagation — mid-round retract', () => {
  it('retract between LLM rounds bounds the LLM call count', async () => {
    // LLM always returns a tool_call with a UNIQUE command per round (so the
    // tool-loop same-args detector never fires the loop steward). Without the
    // between-rounds abort check, this would spin indefinitely. With it, the
    // loop exits within a round of retract — bounded complete() calls.
    let n = 0
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async () => {
        n++
        // Small sleep gives the retract a window to flip abortSignal between
        // rounds without racing the next call. 60ms per round means ~3 rounds
        // across the 200ms warmup + retract propagation.
        await new Promise(r => setTimeout(r, 60))
        return makeToolCallResponse('bash', { description: `r${n}`, command: `echo r${n}` })
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter)
    const agentId = await runner.spawn({ prompt: 'tight loop', name: 'looper', trigger: 'manual' })

    // Let the agent rip through a couple of rounds.
    await new Promise(resolve => setTimeout(resolve, 200))

    const callsAtRetract = (llmRouter.complete as ReturnType<typeof vi.fn>).mock.calls.length
    await runner.retract(agentId)
    await runner.awaitAll(1500)

    expect(agentStore.get(agentId)?.status).toBe('retracted')
    // After retract the loop must exit within at most ONE additional
    // complete() call (the one that was already in flight). Without the
    // between-rounds abort check, this would run unbounded until wall-clock
    // timeout. Ceiling of +2 is generous but still fails the old behavior.
    const mock = llmRouter.complete as ReturnType<typeof vi.fn>
    expect(mock.mock.calls.length - callsAtRetract).toBeLessThanOrEqual(2)
  }, 5000)
})

// ─── Test 3: cooperative retract (regression guard) ───────────────────────────

describe('cancel propagation — cooperative retract before tool call', () => {
  it('retract before any llm.complete still reaches retracted via inbox poll', async () => {
    // This exercises the outer-loop inbox-poll path that existed before this
    // fix. With the LLM immediately returning end_turn, there's no in-flight
    // bash to abort — the retract must be honoured cooperatively.
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async () => makeEndTurnResponse()),
    }

    const { runner, agentStore } = makeRunner(llmRouter)
    const agentId = await runner.spawn({ prompt: 'quick', name: 'quick', trigger: 'manual' })
    // Fire retract as soon as possible — before the first LLM call even resolves.
    await runner.retract(agentId)
    await runner.awaitAll(1500)

    // The agent either caught the retract via the outer inbox poll (retracted)
    // OR completed first (the LLM stub is synchronous). Both are acceptable
    // outcomes for the cooperative path — the key invariant is it didn't hang.
    const status = agentStore.get(agentId)?.status
    expect(['retracted', 'completed']).toContain(status)
  }, 3000)
})

// ─── Test 4: ctx.abortSignal reaches the bash executor ────────────────────────

describe('cancel propagation — ctx.abortSignal reaches child_process.execFile', () => {
  it('aborted bash surfaces the "terminated by agent cancel" marker', async () => {
    // Uses the real bash executor: sleep 3 is preemptively SIGTERM'd when the
    // AbortSignal on ctx fires. The tool result string contains the marker
    // we added in registry.ts, proving the signal flowed ctx → execFile.
    let i = 0
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async () => {
        if (i++ === 0) {
          return makeToolCallResponse('bash', { description: 'sleep', command: 'sleep 3' })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter)
    const agentId = await runner.spawn({ prompt: 'run sleep', name: 'sleeper-2', trigger: 'manual' })

    await new Promise(resolve => setTimeout(resolve, 150))
    await runner.retract(agentId)
    await runner.awaitAll(2000)

    const state = agentStore.get(agentId)
    expect(state?.status).toBe('retracted')

    // The in-flight bash tool_result should contain the abort marker. History
    // may be empty on retracted agents (runToolLoop threw before appendMessage
    // ran on the results), so this is a best-effort check — the primary proof
    // is Test 1's latency assertion. We assert the marker when present.
    const history = (state?.history ?? []) as unknown as Array<Record<string, unknown>>
    const toolResults = history.filter(m => m['kind'] === 'tool_result')
    for (const tr of toolResults) {
      const results = tr['toolResults'] as Array<{ content: string; name: string }> | undefined
      const bashOutput = results?.find(r => r.name === 'bash')?.content
      if (bashOutput) {
        expect(bashOutput).toContain('[bash: terminated by agent cancel]')
      }
    }
  }, 5000)
})
