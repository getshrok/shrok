/**
 * Focused unit tests for ActivationLoop injectable seams.
 *
 * Tests that getUptimeSeconds is wired through to the ~status command response.
 * Uses the same minimal loop wiring as multi-message-batching.test.ts.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ActivationLoop } from '../../src/head/activation.js'
import { ContextAssemblerImpl } from '../../src/head/assembler.js'
import { InjectorImpl } from '../../src/head/injector.js'
import { makeHeadBundle, makeSkillLoader, makeMcpRegistry, makeIdentityLoader } from '../integration/helpers.js'
import type { LLMRouter } from '../../src/types/llm.js'
import type { QueueEvent } from '../../src/types/core.js'
import { PRIORITY } from '../../src/types/core.js'
import { Memory } from '../../src/memory/index.js'
import { generateId } from '../../src/llm/util.js'

// ─── Stub LLM router (no real LLM needed) ─────────────────────────────────────

function makeStubRouter(): LLMRouter {
  return {
    async complete(_model, _messages, _tools, _opts) {
      return {
        content: 'ok',
        inputTokens: 5,
        outputTokens: 5,
        stopReason: 'end_turn' as const,
        model: 'mock',
      }
    },
  }
}

// ─── Minimal loop builder ─────────────────────────────────────────────────────

function makeLoop(getUptimeSeconds?: () => number) {
  const router = makeStubRouter()
  const bundle = makeHeadBundle(router)
  const { messages, workers: agents, queue, usage, appState, schedules, channelRouter, tx } = bundle

  const skillLoader = makeSkillLoader()
  const mcpRegistry = makeMcpRegistry()
  const identityLoader = makeIdentityLoader('You are Shrok.')

  const stubTopicMemory = {
    chunk: async () => {},
    retrieve: async () => [],
    compact: async () => {},
    getTopics: async () => [],
    deleteTopic: async () => {},
  } as unknown as Memory

  const config = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 4096,
    contextAssemblyTokenBudget: 50_000,
    timezone: 'UTC',
  } as import('../../src/config.js').Config

  const assembler = new ContextAssemblerImpl(
    identityLoader, messages, agents, skillLoader, config, mcpRegistry,
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
    } as any,
    config,
    scheduleStore: schedules,
    mcpRegistry: makeMcpRegistry(),
    transaction: tx,
    pollIntervalMs: 50,
    ...(getUptimeSeconds ? { getUptimeSeconds } : {}),
  })

  return { loop, queue, channelRouter, appState, usage, messages }
}

// ─── Drain helper ─────────────────────────────────────────────────────────────

async function drainLoop(
  loop: ActivationLoop,
  queue: ReturnType<typeof makeHeadBundle>['queue'],
  timeoutMs = 5_000,
): Promise<void> {
  loop.start()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 80))
    if (!queue.hasPending()) {
      await new Promise(resolve => setTimeout(resolve, 150))
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

describe('ActivationLoop — getUptimeSeconds injection', () => {
  it('uses injected getUptimeSeconds in ~status response', async () => {
    const { loop, queue, channelRouter } = makeLoop(() => 7262) // 2h 1m

    queue.enqueue(
      {
        type: 'user_message',
        id: generateId('ev'),
        channel: 'test',
        text: '~status',
        createdAt: new Date().toISOString(),
      } satisfies QueueEvent,
      PRIORITY.USER_MESSAGE,
    )

    await drainLoop(loop, queue)

    const responses = channelRouter.sent.map(s => s.text)
    expect(responses.length).toBeGreaterThan(0)
    const statusMsg = responses.join('\n')
    expect(statusMsg).toContain('2h 1m')
  })

  it('falls back to process.uptime() when getUptimeSeconds is not provided', async () => {
    const { loop, queue, channelRouter } = makeLoop(/* no injection */)

    queue.enqueue(
      {
        type: 'user_message',
        id: generateId('ev'),
        channel: 'test',
        text: '~status',
        createdAt: new Date().toISOString(),
      } satisfies QueueEvent,
      PRIORITY.USER_MESSAGE,
    )

    await drainLoop(loop, queue)

    const responses = channelRouter.sent.map(s => s.text)
    expect(responses.length).toBeGreaterThan(0)
    // Should contain some uptime — we just check the key label is present
    const statusMsg = responses.join('\n')
    expect(statusMsg).toContain('Uptime:')
  })
})

describe('ActivationLoop — pre-event threshold block check', () => {
  it('block-action threshold over budget releases the row, sends the message, and stops the loop', async () => {
    const { loop, queue, channelRouter, appState, usage, messages } = makeLoop()

    // Set an active channel so the block message has a destination.
    appState.setLastActiveChannel('test-channel')

    // Configure a block-action threshold at $0.01.
    appState.addThreshold({ period: 'day', amountUsd: 0.01, action: 'block' })

    // Pre-record usage that exceeds the threshold (any cost > $0.01).
    usage.record({ sourceType: 'head', sourceId: null, model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 1.0 })

    // Enqueue a user message and run one processOne tick directly. We don't
    // use drainLoop because the block stops the loop and drainLoop's polling
    // would race the loop.start/loop.stop transitions.
    const event: QueueEvent = {
      type: 'user_message',
      id: generateId('ev'),
      channel: 'test-channel',
      text: 'hello',
      createdAt: new Date().toISOString(),
    }
    queue.enqueue(event, PRIORITY.USER_MESSAGE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (loop as any).processOne()

    // The row should be released (back to 'pending'), not failed or done.
    // Pull from the underlying SQLite via the test helper bundle.
    expect(queue.hasPending()).toBe(true)

    // The user-facing block message went through both paths.
    expect(channelRouter.sent.length).toBeGreaterThan(0)
    const sentText = channelRouter.sent[0]!.text
    expect(sentText).toContain('Shrok has stopped')
    expect(sentText).toContain('$0.01')
    expect(sentText).toContain('preserved')

    // The block message was also persisted to MessageStore for the dashboard.
    const allMsgs = messages.getAll()
    const blockMsg = allMsgs.find(m => m.kind === 'text' && (m as { content?: string }).content?.includes('Shrok has stopped'))
    expect(blockMsg).toBeDefined()

    // The loop is stopped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loop as any).running).toBe(false)
  })
})
