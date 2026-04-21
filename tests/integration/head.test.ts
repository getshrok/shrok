/**
 * Head activation integration tests — real model calls through ActivationLoop.
 *
 * Each test enqueues an event into the queue and runs the activation loop until
 * the queue drains, then asserts on the resulting message history and/or
 * channel output.
 *
 * Skip automatically when ANTHROPIC_API_KEY is not set.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { HAVE_API_KEY, makeRealRouter, makeHeadBundle, makeSkillLoader, makeMcpRegistry, makeIdentityLoader, makeRunner, logTokens } from './helpers.js'
import { Memory } from '../../src/memory/index.js'
import { ActivationLoop } from '../../src/head/activation.js'
import { ContextAssemblerImpl } from '../../src/head/assembler.js'
import { InjectorImpl } from '../../src/head/injector.js'
import { generateId } from '../../src/llm/util.js'
import type { QueueEvent } from '../../src/types/core.js'
import { PRIORITY } from '../../src/types/core.js'

// ─── Guard ────────────────────────────────────────────────────────────────────

if (!HAVE_API_KEY) {
  describe.skip('head integration (no ANTHROPIC_API_KEY)', () => {})
} else {

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUserMessageEvent(text: string): QueueEvent {
  return {
    type: 'user_message',
    id: generateId('ev'),
    channel: 'test',
    text,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Run the activation loop until the queue is empty (and no workers are active),
 * then stop. Pass `workers` when the head can spawn real workers so we don't
 * stop prematurely during the window between spawn and agent_completed.
 */
async function drainLoop(
  loop: ActivationLoop,
  queue: ReturnType<typeof makeHeadBundle>['queue'],
  workers?: ReturnType<typeof makeHeadBundle>['workers'],
  timeoutMs = 45_000,
): Promise<void> {
  loop.start()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const queueIdle = !queue.hasPending()
    const workersIdle = !workers || workers.getActive().length === 0
    if (queueIdle && workersIdle) {
      // One more beat to let the final activation finish writing its response
      await new Promise(resolve => setTimeout(resolve, 600))
      if (!queue.hasPending() && (!workers || workers.getActive().length === 0)) {
        loop.stop()
        return
      }
    }
  }
  loop.stop()
  throw new Error('drainLoop: timed out waiting for queue to drain')
}

/** Build a fully-wired ActivationLoop with a real LLM router. */
function makeLoop(router: ReturnType<typeof makeRealRouter>) {
  const bundle = makeHeadBundle(router)
  const skillLoader = makeSkillLoader()
  const mcpRegistry = makeMcpRegistry()
  const identityLoader = makeIdentityLoader(
    'You are a helpful AI assistant. Be concise. Follow instructions precisely.'
  )

  const stubTopicMemory = {
    chunk: async () => {},
    retrieve: async () => [],
    compact: async () => {},
    getTopics: async () => [],
    deleteTopic: async () => {},
  } as unknown as Memory

  const assembler = new ContextAssemblerImpl(
    identityLoader,
    bundle.messages,
    bundle.workers,
    skillLoader,
    {
      contextAssemblyTokenBudget: 50_000,
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.60,
      llmMaxTokens: 4096,
    } as import('../../src/config.js').Config,
    mcpRegistry,
  )

  const injector = new InjectorImpl(bundle.messages)

  // Share the same DB so agent_completed events land in the head's queue
  const agentRunner = makeRunner(router, bundle.db).runner

  const loop = new ActivationLoop({
    queueStore: bundle.queue,
    messages: bundle.messages,
    appState: bundle.appState,
    usageStore: bundle.usage,
    topicMemory: stubTopicMemory,
    llmRouter: router,
    channelRouter: bundle.channelRouter,
    assembler,
    injector,
    toolExecutorOpts: {
      agentRunner,
      scheduleStore: bundle.schedules,
      skillLoader,
      topicMemory: stubTopicMemory,
      usageStore: bundle.usage,
      identityDir: '/tmp',
      identityLoader,
    },
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.60,
      llmMaxTokens: 4096,
      contextAssemblyTokenBudget: 50_000,
    } as import('../../src/config.js').Config,
    transaction: bundle.tx,
    pollIntervalMs: 200,
  })

  return { loop, ...bundle }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('head activation integration', () => {
  let router: ReturnType<typeof makeRealRouter>

  beforeAll(() => {
    router = makeRealRouter()
  })

  // ── Simple conversation ────────────────────────────────────────────────────

  it('head responds to a simple greeting', async () => {
    const { loop, queue, channelRouter, usage } = makeLoop(router)

    queue.enqueue(makeUserMessageEvent('Say exactly: "hello integration test"'), PRIORITY.USER_MESSAGE)
    await drainLoop(loop, queue)

    expect(channelRouter.sent.length).toBeGreaterThan(0)
    const response = channelRouter.sent[0]!.text.toLowerCase()
    expect(response).toContain('hello')
    expect(channelRouter.sent[0]!.channel).toBe('test')
    logTokens(usage)
  })

  // ── No tool use for conversational message ─────────────────────────────────

  it('head answers a factual question without spawning workers', async () => {
    const { loop, queue, channelRouter, messages, usage } = makeLoop(router)

    queue.enqueue(makeUserMessageEvent('What is 2 + 2? Answer with just the number.'), PRIORITY.USER_MESSAGE)
    await drainLoop(loop, queue)

    expect(channelRouter.sent.length).toBeGreaterThan(0)
    const response = channelRouter.sent[0]!.text
    expect(response).toContain('4')

    // Verify no tool calls in history (should be pure text response)
    const history = messages.getRecent(Infinity)
    const toolCalls = history.filter(m => m.kind === 'tool_call' && !m.injected)
    expect(toolCalls.length).toBe(0)
    logTokens(usage)
  })

  // ── Tool use: list_schedules ───────────────────────────────────────────────

  it('head uses list_schedules tool when asked about schedules', async () => {
    const { loop, queue, messages, usage } = makeLoop(router)

    queue.enqueue(makeUserMessageEvent('List my current schedules. Use the list_schedules tool.'), PRIORITY.USER_MESSAGE)
    await drainLoop(loop, queue)

    const history = messages.getRecent(Infinity)
    const toolCalls = history.filter(m => m.kind === 'tool_call')
    const calledNames = toolCalls.flatMap(m => m.kind === 'tool_call' ? m.toolCalls.map(tc => tc.name) : [])
    expect(calledNames).toContain('list_schedules')
    logTokens(usage)
  })

  // ── Tool use: spawn_agent ──────────────────────────────────────────────────

  it('head spawns an agent when given a task requiring background work', async () => {
    const { loop, queue, messages, usage } = makeLoop(router)

    queue.enqueue(
      makeUserMessageEvent('Spawn an agent with this exact prompt: "Respond with the word done immediately." Use the spawn_agent tool now.'),
      PRIORITY.USER_MESSAGE,
    )
    await drainLoop(loop, queue)

    const history = messages.getRecent(Infinity)
    const toolCalls = history.filter(m => m.kind === 'tool_call')
    const calledNames = toolCalls.flatMap(m => m.kind === 'tool_call' ? m.toolCalls.map(tc => tc.name) : [])
    expect(calledNames).toContain('spawn_agent')
    logTokens(usage)
  })

  // ── End-to-end: user → head spawns worker → worker runs → head reports back ─

  it('full loop: user message triggers worker that runs and reports result back to head', { timeout: 120_000 }, async () => {
    const { loop, queue, workers, channelRouter, usage } = makeLoop(router)

    // The marker string lets us verify the actual worker output reached the head response.
    queue.enqueue(
      makeUserMessageEvent(
        'Call spawn_agent RIGHT NOW with this exact prompt: ' +
        '"Run bash command `echo e2e-complete` and respond with the output. Do not do anything else." ' +
        'Do not explain. Just call spawn_agent immediately.'
      ),
      PRIORITY.USER_MESSAGE,
    )

    // Drain until queue idle AND no workers still running
    await drainLoop(loop, queue, workers, 90_000)

    // The head should have spoken at least once (after spawning) and again after the result arrived.
    // The combined channel output should contain the bash marker.
    const allText = channelRouter.sent.map(s => s.text).join('\n')
    expect(allText).toContain('e2e-complete')
    logTokens(usage)
  })

  // ── Agent completed event triggers head activation ────────────────────────

  it('head activates and responds when agent_completed event arrives', async () => {
    const { loop, queue, workers, channelRouter, usage } = makeLoop(router)

    // Simulate an agent that already completed
    const agentId = generateId('tent')
    workers.create(agentId, { prompt: 'test task', trigger: 'manual' })
    workers.complete(agentId, 'the answer is 42', [])

    const completedEvent: QueueEvent = {
      type: 'agent_completed',
      id: generateId('ev'),
      agentId,
      output: 'the answer is 42',
      createdAt: new Date().toISOString(),
    }

    // Enqueue a user message first so the head sets a last-active channel,
    // then the agent_completed arrives. Head processes both activations.
    queue.enqueue(makeUserMessageEvent('I am here.'), PRIORITY.USER_MESSAGE)
    queue.enqueue(completedEvent, PRIORITY.AGENT_COMPLETED)

    await drainLoop(loop, queue, undefined, 50_000)

    // At least 1 response (could be 2 — one per activation)
    expect(channelRouter.sent.length).toBeGreaterThan(0)
    logTokens(usage)
  })

  // ── Multi-turn: context carries across activations ─────────────────────────

  it('head retains context across two sequential activations', async () => {
    const { loop, queue, channelRouter, usage } = makeLoop(router)

    // First turn: establish a fact
    queue.enqueue(makeUserMessageEvent('Remember: the magic number is 7777.'), PRIORITY.USER_MESSAGE)
    await drainLoop(loop, queue, undefined, 30_000)

    // Second turn: recall it
    queue.enqueue(makeUserMessageEvent('What is the magic number I just told you?'), PRIORITY.USER_MESSAGE)
    await drainLoop(loop, queue, undefined, 30_000)

    const lastResponse = channelRouter.sent[channelRouter.sent.length - 1]!.text
    expect(lastResponse).toContain('7777')
    logTokens(usage)
  })
})

} // end HAVE_API_KEY guard
