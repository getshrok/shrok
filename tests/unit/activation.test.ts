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
    headId: 'default',
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
    appState.setLastActiveChannel('default', 'test-channel')

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
    const allMsgs = messages.getAll('default')
    const blockMsg = allMsgs.find(m => m.kind === 'text' && (m as { content?: string }).content?.includes('Shrok has stopped'))
    expect(blockMsg).toBeDefined()

    // The loop is stopped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loop as any).running).toBe(false)
  })
})

// ─── Per-head isolation helper ─────────────────────────────────────────────────

function makeLoopWithHeadId(
  bundle: ReturnType<typeof makeHeadBundle>,
  router: LLMRouter,
  headId: string,
): ActivationLoop {
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
  return new ActivationLoop({
    headId,
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
    mcpRegistry,
    transaction: tx,
    pollIntervalMs: 50,
  })
}

// ─── Per-head isolation tests (Phase 30 CORE-01) ─────────────────────────────

describe('ActivationLoop — per-head isolation (Phase 30 CORE-01)', () => {
  it('two loops on the same DB only claim events for their own head', async () => {
    const router = makeStubRouter()
    const bundle = makeHeadBundle(router)
    const { queue, db } = bundle

    const personalLoop = makeLoopWithHeadId(bundle, router, 'personal')
    const workLoop = makeLoopWithHeadId(bundle, router, 'work')

    // Insert queue_events rows directly with explicit head_id so we control the column.
    const personalEventJson = JSON.stringify({
      type: 'user_message',
      id: 'ev-personal-1',
      channel: 'test-personal',
      text: 'hello personal',
      createdAt: new Date().toISOString(),
    })
    const workEventJson = JSON.stringify({
      type: 'user_message',
      id: 'ev-work-1',
      channel: 'test-work',
      text: 'hello work',
      createdAt: new Date().toISOString(),
    })
    db.prepare(`
      INSERT INTO queue_events (id, type, payload, priority, status, head_id)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run('ev-personal-1', 'user_message', personalEventJson, 100, 'personal')
    db.prepare(`
      INSERT INTO queue_events (id, type, payload, priority, status, head_id)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run('ev-work-1', 'user_message', workEventJson, 100, 'work')

    // Personal loop claims only the personal row.
    const personalClaimed = queue.claimNext('personal')
    expect(personalClaimed?.event.id).toBe('ev-personal-1')
    expect(queue.claimNext('personal')).toBeNull()

    // Work loop sees its own row still pending.
    const workClaimed = queue.claimNext('work')
    expect(workClaimed?.event.id).toBe('ev-work-1')
    expect(queue.claimNext('work')).toBeNull()

    personalLoop.stop()
    workLoop.stop()
  })

  it('appState.lastActiveChannel set under one head is invisible to another', () => {
    const router = makeStubRouter()
    const bundle = makeHeadBundle(router)
    const { appState } = bundle

    appState.setLastActiveChannel('personal', 'discord-personal')
    appState.setLastActiveChannel('work', 'telegram-work')

    expect(appState.getLastActiveChannel('personal')).toBe('discord-personal')
    expect(appState.getLastActiveChannel('work')).toBe('telegram-work')
  })

  it('archival lock acquired under one head does not block another', () => {
    const router = makeStubRouter()
    const bundle = makeHeadBundle(router)
    const { appState } = bundle

    expect(appState.tryAcquireArchivalLock('personal')).toBe(true)
    expect(appState.tryAcquireArchivalLock('personal')).toBe(false)
    // 'work' is independent even though 'personal' is held
    expect(appState.tryAcquireArchivalLock('work')).toBe(true)

    appState.releaseArchivalLock('personal')
    expect(appState.tryAcquireArchivalLock('personal')).toBe(true)
    // 'work' still held
    expect(appState.tryAcquireArchivalLock('work')).toBe(false)
  })
})
