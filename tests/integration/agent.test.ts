/**
 * Agent integration tests — real model calls against LocalAgentRunner.
 *
 * Each test spawns a real agent and waits for it to reach a terminal state.
 * Prompts are directive: they leave no ambiguity about which tool the model
 * should call, keeping tests reliable and cheap (Haiku throughout).
 *
 * Skip automatically when ANTHROPIC_API_KEY is not set.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { HAVE_API_KEY, makeRealRouter, makeRunner, logTokens } from './helpers.js'

// ─── Guard ────────────────────────────────────────────────────────────────────

if (!HAVE_API_KEY) {
  describe.skip('agent integration (no ANTHROPIC_API_KEY)', () => {})
} else {

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('agent integration', () => {
  let router: ReturnType<typeof makeRealRouter>

  beforeAll(() => {
    router = makeRealRouter()
  })

  // ── Basic completion ───────────────────────────────────────────────────────

  it('agent completes and captures output', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'basic-completion',
      prompt: `Respond with exactly the phrase "task complete" and nothing else.`,
      trigger: 'manual',
    })

    await runner.awaitAll(45_000)

    const state = agentStore.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.output).toBeTruthy()
    logTokens(usageStore)
  })

  // ── Bash tool ─────────────────────────────────────────────────────────────

  it('agent uses bash then returns result', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'bash-tool',
      prompt: `Run this exact bash command: echo integration-test-marker
Then respond with the output of the command. Do nothing else.`,
      trigger: 'manual',
    })

    await runner.awaitAll(45_000)

    const state = agentStore.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.output).toContain('integration-test-marker')
    logTokens(usageStore)
  })

  // ── Suspend on question ────────────────────────────────────────────────────

  it('agent asks a question and suspends when given ambiguous task', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'suspend-question',
      prompt: `You need to move some files to a destination folder, but you do not know which destination folder to use.
Before doing anything, you must ask which destination folder to use. Do not proceed without an answer.
Call bash with "echo starting" first, then respond asking for the folder.`,
      trigger: 'manual',
    })

    // Give the agent time to reach suspended state
    await new Promise(resolve => setTimeout(resolve, 20_000))

    const state = agentStore.get(id)
    expect(state?.status).toBe('suspended')
    expect(state?.pendingQuestion).toBeTruthy()
    logTokens(usageStore)
  })

  // ── Resume after signal ────────────────────────────────────────────────────

  it('suspended agent resumes and completes after signal', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'resume-signal',
      prompt: `You need to organize files but you don't know the destination folder.
First, call bash with "echo starting". Then respond asking "Which folder should I use?" and wait for an answer.
Once you receive the answer, respond with "organized into: " followed by the folder name you were given.
Do not do anything else.`,
      trigger: 'manual',
    })

    // Wait for suspension
    let state = agentStore.get(id)
    const deadline = Date.now() + 20_000
    while (state?.status !== 'suspended' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
      state = agentStore.get(id)
    }

    expect(state?.status).toBe('suspended')

    // Signal with an answer
    await runner.signal(id, 'Use the /tmp/organized folder')
    await runner.awaitAll(30_000)

    state = agentStore.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.output).toContain('/tmp/organized')
    logTokens(usageStore)
  })

  // ── File write + read ──────────────────────────────────────────────────────

  it('agent writes a file with write_file and reads it back with read_file', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)
    const testPath = `/tmp/shrok-integration-${Date.now()}.txt`

    const id = await runner.spawn({
      name: 'file-write-read',
      prompt: `Do these steps in order:
1. Call write_file with path="${testPath}" and content="hello from integration test".
2. Call read_file with path="${testPath}".
3. Respond with the content you read back.
Do not deviate. Execute all three steps.`,
      trigger: 'manual',
    })

    await runner.awaitAll(45_000)

    const state = agentStore.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.output).toContain('hello from integration test')
    logTokens(usageStore)
  })

  // ── Usage recording ────────────────────────────────────────────────────────

  it('agent run records token usage', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'usage-recording',
      prompt: `Respond with "done" immediately.`,
      trigger: 'manual',
    })

    await runner.awaitAll(30_000)

    expect(agentStore.get(id)?.status).toBe('completed')
    const entries = usageStore.getBySource('agent', id)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]!.inputTokens).toBeGreaterThan(0)
    logTokens(usageStore)
  })

  // ── Sub-agent completion routes to parent ──────────────────────────────────

  it('sub-agent result is delivered to parent inbox and parent completes', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router, undefined, {
      spawnAgentStewardEnabled: false,
    })

    // Parent spawns a sub-agent to do the actual work, then waits for its result
    const id = await runner.spawn({
      name: 'parent-sub-agent',
      prompt: `Your job:
1. Call spawn_agent with description="sub-task runner" and prompt="Respond with exactly: sub done"
2. Wait for the sub-agent to complete. You will receive a [Sub-agent ... completed] message in the conversation.
3. Once you see the sub-agent completed message, respond with "parent done: " followed by the sub-agent's output.
Do not respond before the sub-agent has finished.`,
      trigger: 'manual',
    })

    await runner.awaitAll(55_000)

    const state = agentStore.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.output).toContain('parent done')
    logTokens(usageStore)
  })

  // ── Cancel running agent ───────────────────────────────────────────────────

  it('retracted agent ends up in retracted status', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    // Agent that asks a question — designed to suspend via the completion steward
    const id = await runner.spawn({
      name: 'retract-test',
      prompt: `Call bash with "echo ready". Then respond asking "ready to start?" and wait for the answer before doing anything.`,
      trigger: 'manual',
    })

    // Wait until it suspends
    const deadline = Date.now() + 20_000
    let state = agentStore.get(id)
    while (state?.status !== 'suspended' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
      state = agentStore.get(id)
    }

    expect(state?.status).toBe('suspended')

    await runner.retract(id)
    await runner.awaitAll(15_000)

    state = agentStore.get(id)
    expect(state?.status).toBe('retracted')
    logTokens(usageStore)
  })

  // ── Nested spawning: depth-2 child (TEST-06) ──────────────────────────────

  it('depth-1 agent spawns a depth-2 child agent (nested spawning)', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router, undefined, {
      nestedAgentSpawningEnabled: true,
      spawnAgentStewardEnabled: false,
    })

    const id = await runner.spawn({
      name: 'nested-parent',
      prompt: `Your job:\n1. Call spawn_agent with prompt="Run bash command: echo grandchild-done-marker then respond with the output" and description="nested bash child"\n2. Wait for the sub-agent to complete. You will receive a completed message.\n3. Once you see the sub-agent completed message, respond with "parent received" followed by whatever the sub-agent said.\nDo not do anything else.`,
      trigger: 'manual',
    })

    await runner.awaitAll(90_000)

    const parentState = agentStore.get(id)
    expect(parentState?.status).toBe('completed')

    // D-02: assert child records via agentStore -- getDescendantIds returns [parentId, ...childIds]
    const descendants = agentStore.getDescendantIds(id)
    expect(descendants.length).toBeGreaterThanOrEqual(2) // parent + at least 1 child
    const childIds = descendants.filter(d => d !== id)
    expect(childIds.length).toBeGreaterThan(0)

    // Verify the child has parentAgentId pointing to our depth-1 agent
    const childState = agentStore.get(childIds[0]!)
    expect(childState?.parentAgentId).toBe(id)
    expect(childState?.status).toBe('completed')

    logTokens(usageStore)
  })

  // ── Nested spawning: flag-off rollback (TEST-07) ──────────────────────────

  it('nestedAgentSpawningEnabled=false prevents depth-1 agent from spawning', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router, undefined, {
      nestedAgentSpawningEnabled: false,
    })

    const id = await runner.spawn({
      name: 'flag-off-test',
      prompt: `First, run this bash command: echo flag-off-test-marker\nThen try to call spawn_agent with prompt="echo child done".\nIf spawn_agent is not available as a tool, respond with "no spawn tool available".`,
      trigger: 'manual',
    })

    await runner.awaitAll(90_000)

    const parentState = agentStore.get(id)
    expect(parentState?.status).toBe('completed')

    // D-05: assert zero child agent records
    const descendants = agentStore.getDescendantIds(id)
    const childIds = descendants.filter(d => d !== id)
    expect(childIds.length).toBe(0)

    logTokens(usageStore)
  })

  // ── Nested spawning: steward reject (D-06/D-08) ───────────────────────────

  it('steward rejects trivial delegation and agent completes without spawning', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router, undefined, {
      nestedAgentSpawningEnabled: true,
      spawnAgentStewardEnabled: true,
    })

    const id = await runner.spawn({
      name: 'steward-reject-test',
      prompt: `Your task is to respond with the word "hello".\nCall spawn_agent with prompt="Respond with hello" to delegate this.\nIf the spawn is rejected, respond with "did it myself: hello".`,
      trigger: 'manual',
    })

    await runner.awaitAll(90_000)

    const parentState = agentStore.get(id)
    expect(parentState?.status).toBe('completed')

    // D-08: steward should reject this trivial delegation -- no child spawned
    const descendants = agentStore.getDescendantIds(id)
    const childIds = descendants.filter(d => d !== id)
    expect(childIds.length).toBe(0)

    logTokens(usageStore)
  })
})

} // end HAVE_API_KEY guard
