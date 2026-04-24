import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { AgentStore } from '../db/agents.js'
import { UsageStore } from '../db/usage.js'
import { maybeArchiveHistory } from './archival.js'
import type { ArchivalDeps } from './archival.js'
import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

function makeTextMsg(id: string, content: string = 'hello world '.repeat(20)): TextMessage {
  return { kind: 'text', role: 'user', id, content, createdAt: new Date().toISOString() }
}

/** Build a big history so estimateTokens exceeds the threshold */
function makeLargeHistory(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => makeTextMsg(`m${i}`, 'a'.repeat(500)))
}

function makeLLMRouter(response: LLMResponse): LLMRouter {
  return { complete: vi.fn().mockResolvedValue(response) }
}

function makeSuccessResponse(): LLMResponse {
  return {
    content: 'A concise summary of earlier context.',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 20,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

function makeDeps(
  agentStore: AgentStore,
  agentId: string,
  llmRouter: LLMRouter,
  usageStore?: UsageStore,
): ArchivalDeps {
  return {
    llmRouter,
    usageStore: usageStore ?? new UsageStore(freshDb(), 'UTC'),
    stewardModel: 'test-model',
    archivalThreshold: 100, // low threshold so any 30+ messages triggers archival
    agentStore,
    agentId,
  }
}

// ─── maybeArchiveHistory: compactHistory call-site tests ──────────────────────

describe('maybeArchiveHistory — compactHistory call sites (Plan 25-02)', () => {
  let db: ReturnType<typeof freshDb>
  let agentStore: AgentStore
  let agentId: string

  beforeEach(() => {
    db = freshDb()
    agentStore = new AgentStore(db)
    agentId = 'test-agent-archival'
    agentStore.create(agentId, { prompt: 'test task', trigger: 'manual' })
  })

  // ─── SUCCESS PATH: compactHistory called with summaryMsg ──────────────────

  it('success path calls compactHistory with (agentId, lastCompactedId, summaryMsg) — not updateHistory', async () => {
    const history = makeLargeHistory(20)
    // Seed all messages into DB
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    // Ensure updateHistory does not exist — if this test compiles and compactHistory is called,
    // the migration is correct. We also verify updateHistory is NOT called.
    const updateHistorySpy = vi.spyOn(agentStore as unknown as { updateHistory?: (...args: unknown[]) => void }, 'updateHistory' as never)

    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    // compactHistory must have been called exactly once
    expect(spy).toHaveBeenCalledTimes(1)

    // updateHistory must NOT have been called (it's deleted in Plan 01)
    expect(updateHistorySpy).not.toHaveBeenCalled()
  })

  it('success path passes the summaryMsg (not null) as the third argument to compactHistory', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    const [, , summaryArg] = spy.mock.calls[0]!
    expect(summaryArg).not.toBeNull()
    expect((summaryArg as Message).kind).toBe('summary')
    expect((summaryArg as { content: string }).content).toBe('A concise summary of earlier context.')
  })

  it('success path passes the id of the last compacted message as deleteBeforeId', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    const cutoff = Math.floor(history.length * 0.3)
    const expectedLastId = history[cutoff - 1]!.id

    await maybeArchiveHistory(agentId, history, deps)

    const [, deleteBeforeId] = spy.mock.calls[0]!
    expect(deleteBeforeId).toBe(expectedLastId)
  })

  it('success path replaces compacted messages with summaryMsg in-memory (splice behavior preserved)', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    const originalLength = history.length
    const cutoff = Math.floor(originalLength * 0.3)

    await maybeArchiveHistory(agentId, history, deps)

    // In-memory: history should have (originalLength - cutoff + 1) items (cutoff replaced by summary)
    expect(history.length).toBe(originalLength - cutoff + 1)
    expect(history[0]!.kind).toBe('summary')
  })

  // ─── EMPTY-TEXT TRIM PATH: compactHistory called with null ────────────────

  it('empty-text trim path calls compactHistory with null as third argument', async () => {
    // Build a history where all messages produce empty summaryText
    // tool_result messages with empty content produce empty string in the map
    const emptyToolResult: Message = {
      kind: 'tool_result',
      id: 'tr0',
      toolResults: [{ id: 'tc0', name: 'bash', content: '' }],
      createdAt: new Date().toISOString(),
    }
    // Pad with many empty tool results to exceed threshold
    const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
      ...emptyToolResult,
      id: `tr${i}`,
      toolResults: [{ id: `tc${i}`, name: 'bash', content: '' }],
    }))
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    // compactHistory must have been called
    expect(spy).toHaveBeenCalledTimes(1)
    // Third arg must be null (delete-only, no summary insert)
    const [, , summaryArg] = spy.mock.calls[0]!
    expect(summaryArg).toBeNull()
  })

  it('empty-text trim path removes compacted messages from in-memory history (splice preserved)', async () => {
    const emptyToolResult: Message = {
      kind: 'tool_result',
      id: 'tr0',
      toolResults: [{ id: 'tc0', name: 'bash', content: '' }],
      createdAt: new Date().toISOString(),
    }
    const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
      ...emptyToolResult,
      id: `tr${i}`,
      toolResults: [{ id: `tc${i}`, name: 'bash', content: '' }],
    }))
    agentStore.appendMessages(agentId, history)

    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    const originalLength = history.length
    const cutoff = Math.floor(originalLength * 0.3)

    await maybeArchiveHistory(agentId, history, deps)

    // In-memory: history should have (originalLength - cutoff) items (no summary inserted)
    expect(history.length).toBe(originalLength - cutoff)
  })

  // ─── FALLBACK PATH: compactHistory called with noticeMsg ─────────────────

  it('fallback path calls compactHistory with noticeMsg (TextMessage) when LLM throws', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockRejectedValue(new Error('LLM network error')),
    }
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    expect(spy).toHaveBeenCalledTimes(1)
    const [, , noticeArg] = spy.mock.calls[0]!
    expect(noticeArg).not.toBeNull()
    const notice = noticeArg as Message
    expect(notice.kind).toBe('text')
    // Should be a typed TextMessage (not a cast)
    expect((notice as TextMessage).role).toBe('user')
    expect((notice as TextMessage).injected).toBe(true)
    expect((notice as TextMessage).content).toContain('System notice')
  })

  it('fallback path sets noticeMsg as first item in in-memory history (unshift preserved)', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const llmRouter: LLMRouter = {
      complete: vi.fn().mockRejectedValue(new Error('LLM network error')),
    }
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    // In-memory: notice should be at index 0
    expect(history[0]!.kind).toBe('text')
    expect((history[0] as TextMessage).injected).toBe(true)
    expect((history[0] as TextMessage).content).toContain('System notice')
  })

  it('fallback path passes lastCompactedId correctly to compactHistory', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const spy = vi.spyOn(agentStore, 'compactHistory')
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockRejectedValue(new Error('LLM network error')),
    }
    const deps = makeDeps(agentStore, agentId, llmRouter)

    const cutoff = Math.floor(history.length * 0.3)
    const expectedLastId = history[cutoff - 1]!.id

    await maybeArchiveHistory(agentId, history, deps)

    const [, deleteBeforeId] = spy.mock.calls[0]!
    expect(deleteBeforeId).toBe(expectedLastId)
  })

  // ─── DATABASE INTEGRATION: compactHistory actually modifies the DB ─────────

  it('success path DB integration: compactHistory deletes old rows and inserts summary', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const llmRouter = makeLLMRouter(makeSuccessResponse())
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    // Reload from DB
    const state = agentStore.get(agentId)!
    // DB should have: summary row + remaining (non-compacted) rows
    const cutoff = Math.floor(20 * 0.3)
    // summary + (20 - cutoff) remaining
    expect(state.history.length).toBe(1 + (20 - cutoff))
    // summary appears at the beginning (lowest rowid since it was INSERTed after DELETE)
    expect(state.history[0]!.kind).toBe('summary')
  })

  it('fallback path DB integration: compactHistory deletes old rows and inserts notice', async () => {
    const history = makeLargeHistory(20)
    agentStore.appendMessages(agentId, history)

    const llmRouter: LLMRouter = {
      complete: vi.fn().mockRejectedValue(new Error('LLM error')),
    }
    const deps = makeDeps(agentStore, agentId, llmRouter)

    await maybeArchiveHistory(agentId, history, deps)

    const state = agentStore.get(agentId)!
    const cutoff = Math.floor(20 * 0.3)
    // notice + (20 - cutoff) remaining
    expect(state.history.length).toBe(1 + (20 - cutoff))
    // notice is first in DB order
    const first = state.history[0]! as TextMessage
    expect(first.kind).toBe('text')
    expect(first.injected).toBe(true)
  })
})
