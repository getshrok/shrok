/**
 * Deterministic unit tests for the Head's message batching logic.
 *
 * When a correction arrives in the queue BEFORE the LLM responds to the first
 * message, the activation loop should fold both messages into a single LLM call
 * rather than responding to Tuesday then issuing a second response for Wednesday.
 *
 * This tests the batching mechanism at the QueueStore + ActivationLoop level —
 * specifically `claimAllPendingUserMessages()` and the while-loop that re-runs
 * the tool loop when new messages are found.
 *
 * No real LLM calls are made — the LLM router is mocked.
 */

import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ActivationLoop } from '../../src/head/activation.js'
import { ContextAssemblerImpl } from '../../src/head/assembler.js'
import { InjectorImpl } from '../../src/head/injector.js'
import { makeHeadBundle, makeSkillLoader, makeMcpRegistry, makeIdentityLoader } from '../integration/helpers.js'
import { Memory } from '../../src/memory/index.js'
import { generateId } from '../../src/llm/util.js'
import { PRIORITY } from '../../src/types/core.js'
import type { QueueEvent, Message } from '../../src/types/core.js'
import type { LLMRouter } from '../../src/types/llm.js'

// ─── Mock LLM router ──────────────────────────────────────────────────────────

/**
 * A mock router that:
 * 1. On the first call simulates "latency" by enqueuing the second message into
 *    the queue before returning — so the batching loop can find it.
 * 2. Records every call with its full message history.
 */
function makeBatchingRouter(
  onFirstCall: () => void,
): { router: LLMRouter; calls: Array<{ historySnapshot: Message[] }> } {
  const calls: Array<{ historySnapshot: Message[] }> = []
  let callCount = 0

  const router: LLMRouter = {
    async complete(_model, messages, _tools, _opts) {
      callCount++
      calls.push({ historySnapshot: [...messages] })

      if (callCount === 1) {
        // Simulate network latency: the second user message arrives while we are
        // "waiting" for the LLM. Call the callback to inject it.
        onFirstCall()
      }

      return {
        content: `Acknowledged. I saw ${messages.filter(m => m.kind === 'text' && m.role === 'user').length} user message(s).`,
        inputTokens: 10,
        outputTokens: 10,
        stopReason: 'end_turn' as const,
        model: 'mock-model',
      }
    },
  }

  return { router, calls }
}

// ─── Loop builder ─────────────────────────────────────────────────────────────

function makeLoop(router: LLMRouter) {
  // makeHeadBundle creates all stores on a single shared DB; we use its db and tx.
  const bundle = makeHeadBundle(router)
  const { db, messages, workers: agents, queue, usage, appState, schedules, channelRouter, tx } = bundle

  const skillLoader = makeSkillLoader()
  const mcpRegistry = makeMcpRegistry()
  const identityLoader = makeIdentityLoader('You are a helpful assistant.')

  const stubTopicMemory = {
    chunk: async () => {},
    retrieve: async () => [],
    compact: async () => {},
    getTopics: async () => [],
    deleteTopic: async () => {},
  } as unknown as Memory

  const config = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99, // disable archival
    llmMaxTokens: 4096,
    contextAssemblyTokenBudget: 50_000,
    timezone: 'UTC',
  } as import('../../src/config.js').Config

  const assembler = new ContextAssemblerImpl(
    identityLoader,
    messages,
    agents,
    skillLoader,
    config,
    mcpRegistry,
  )

  const injector = new InjectorImpl(messages)
  const stubRunner = { spawn: async () => {} } as any

  const loop = new ActivationLoop({
    queueStore: queue,
    messages,
    appState,
    usageStore: usage,
    topicMemory: stubTopicMemory,
    agentStore: agents,
    llmRouter: router,
    channelRouter,
    assembler,
    injector,
    toolExecutorOpts: {
      agentRunner: stubRunner,
      scheduleStore: schedules,
      skillLoader,
      topicMemory: stubTopicMemory,
      usageStore: usage,
      identityDir: '/tmp',
      identityLoader,
      messages,
    } as any, // HeadToolExecutorOptions — identityLoader stub lacks listFiles/readFile
    config,
    transaction: tx,
    pollIntervalMs: 50,
    stewards: [],  // disable stewards so only head LLM calls are counted
  })

  return { loop, queue, messages, channelRouter, agents, appState }
}

// ─── Drain helper ─────────────────────────────────────────────────────────────

async function drainLoop(
  loop: ActivationLoop,
  queue: ReturnType<typeof makeHeadBundle>['queue'],
  timeoutMs = 10_000,
): Promise<void> {
  loop.start()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 80))
    if (!queue.hasPending()) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (!queue.hasPending()) {
        loop.stop()
        return
      }
    }
  }
  loop.stop()
  throw new Error('drainLoop: timed out')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('message batching', () => {
  it('QueueStore.claimAllPendingUserMessages returns messages enqueued after claimNext', () => {
    // This tests the queue's batching primitive directly, without the full loop.
    const { queue } = makeHeadBundle({} as LLMRouter)

    const ev1: QueueEvent = {
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test',
      text: 'set a meeting for Tuesday',
      createdAt: new Date().toISOString(),
    }
    const ev2: QueueEvent = {
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test',
      text: 'wait, make that Wednesday',
      createdAt: new Date(Date.now() + 10).toISOString(),
    }

    queue.enqueue(ev1, PRIORITY.USER_MESSAGE)
    queue.enqueue(ev2, PRIORITY.USER_MESSAGE)

    // claimNext claims ev1
    const claimed = queue.claimNext()
    expect(claimed).not.toBeNull()
    expect((claimed!.event as QueueEvent & { type: 'user_message' }).text).toBe('set a meeting for Tuesday')

    // claimAllPendingUserMessages should return ev2
    const pending = queue.claimAllPendingUserMessages()
    expect(pending.length).toBe(1)
    expect((pending[0]!.event as QueueEvent & { type: 'user_message' }).text).toBe('wait, make that Wednesday')
  })

  it('both messages are appended to history before the re-run LLM call', async () => {
    // We will intercept the router calls and record what history was visible.
    const callHistories: Message[][] = []

    // The queue reference needs to be captured before makeLoop returns so we can
    // enqueue the second message during the first LLM call.
    let queueRef: ReturnType<typeof makeHeadBundle>['queue'] | null = null
    let appStateRef: ReturnType<typeof makeHeadBundle>['appState'] | null = null

    const router: LLMRouter = {
      async complete(_model, messages, _tools, _opts) {
        callHistories.push([...messages])

        if (callHistories.length === 1 && queueRef) {
          // Enqueue the follow-up correction while LLM is "processing"
          queueRef.enqueue({
            type: 'user_message',
            id: generateId('ev'),
            channel: 'test',
            text: 'wait, make that Wednesday',
            createdAt: new Date().toISOString(),
          }, PRIORITY.USER_MESSAGE)
        }

        return {
          content: 'Sure.',
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn' as const,
          model: 'mock-model',
        }
      },
    }

    const { loop, queue, messages, appState } = makeLoop(router)
    queueRef = queue
    appStateRef = appState

    // Enqueue the first message
    queue.enqueue({
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test',
      text: 'set a meeting for Tuesday',
      createdAt: new Date().toISOString(),
    }, PRIORITY.USER_MESSAGE)

    await drainLoop(loop, queue)

    // The LLM should have been called at least twice:
    // - Once for the first message ("Tuesday")
    // - Once after the batched message ("Wednesday") was found
    expect(callHistories.length).toBeGreaterThanOrEqual(2)

    // The second (re-run) call should have BOTH messages in history
    const lastCallHistory = callHistories[callHistories.length - 1]!
    const userTexts = lastCallHistory
      .filter((m): m is Extract<Message, { kind: 'text'; role: 'user' }> =>
        m.kind === 'text' && m.role === 'user'
      )
      .map(m => m.content)

    expect(userTexts).toContain('set a meeting for Tuesday')
    expect(userTexts).toContain('wait, make that Wednesday')

    // The order should be Tuesday before Wednesday
    const tuesdayIdx = userTexts.indexOf('set a meeting for Tuesday')
    const wednesdayIdx = userTexts.indexOf('wait, make that Wednesday')
    expect(tuesdayIdx).toBeLessThan(wednesdayIdx)
  })

  it('when no second message arrives, the LLM is called exactly once', async () => {
    const callCount = { value: 0 }

    const router: LLMRouter = {
      async complete(_model, _messages, _tools, _opts) {
        callCount.value++
        return {
          content: 'Done.',
          inputTokens: 5,
          outputTokens: 5,
          stopReason: 'end_turn' as const,
          model: 'mock-model',
        }
      },
    }

    const { loop, queue } = makeLoop(router)

    queue.enqueue({
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test',
      text: 'set a meeting for Tuesday',
      createdAt: new Date().toISOString(),
    }, PRIORITY.USER_MESSAGE)

    await drainLoop(loop, queue)

    // No second message arrived — the LLM should have been called exactly once
    expect(callCount.value).toBe(1)
  })

  it('two messages are visible in MessageStore after batching', async () => {
    let queueRef: ReturnType<typeof makeHeadBundle>['queue'] | null = null
    let injectionDone = false

    const router: LLMRouter = {
      async complete(_model, _messages, _tools, _opts) {
        if (!injectionDone && queueRef) {
          injectionDone = true
          queueRef.enqueue({
            type: 'user_message',
            id: generateId('ev'),
            channel: 'test',
            text: 'wait, make that Wednesday',
            createdAt: new Date().toISOString(),
          }, PRIORITY.USER_MESSAGE)
        }
        return {
          content: 'Acknowledged.',
          inputTokens: 5,
          outputTokens: 5,
          stopReason: 'end_turn' as const,
          model: 'mock-model',
        }
      },
    }

    const { loop, queue, messages } = makeLoop(router)
    queueRef = queue

    queue.enqueue({
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test',
      text: 'set a meeting for Tuesday',
      createdAt: new Date().toISOString(),
    }, PRIORITY.USER_MESSAGE)

    await drainLoop(loop, queue)

    const history = messages.getAll()
    const userMessages = history.filter(m => m.kind === 'text' && m.role === 'user' && !m.injected)

    const texts = userMessages.map(m => m.kind === 'text' ? m.content : '')
    expect(texts).toContain('set a meeting for Tuesday')
    expect(texts).toContain('wait, make that Wednesday')
  })
})
