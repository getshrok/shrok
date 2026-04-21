/**
 * Integration test: the model emits `description` as the first property on
 * in-scope tool-call inputs when steered by schema ordering + required-ness.
 *
 * Real-Haiku round trip. Uses the existing directive-prompt pattern so the
 * model has no choice about which tool to call — the assertion then verifies
 * the steering mechanism (schema property order, required array prepending)
 * actually reaches the wire and the model complies.
 *
 * One call is enough to validate the mechanism per CONTEXT.md — even with
 * the Phase 1 scope expansion to eight schemas (D-03, D-06), a single
 * representative bash call proves the steering primitive works.
 *
 * Skipped automatically when ANTHROPIC_API_KEY is not set.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { HAVE_API_KEY, makeRealRouter, makeRunner, logTokens } from './helpers.js'
import type { Message, ToolCallMessage } from '../../src/types/core.js'

// ─── Guard ────────────────────────────────────────────────────────────────────

if (!HAVE_API_KEY) {
  describe.skip('tool-description integration (no ANTHROPIC_API_KEY)', () => {
    it('skipped: set ANTHROPIC_API_KEY to run', () => {})
  })
} else {

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('tool-description integration', () => {
  let router: ReturnType<typeof makeRealRouter>

  beforeAll(() => {
    router = makeRealRouter()
  })

  it('real Haiku emits `description` as the first property of a bash tool-call input', async () => {
    const { runner, agentStore, usageStore } = makeRunner(router)

    const id = await runner.spawn({
      name: 'tool-desc-test',
      // Directive prompt: no ambiguity about which tool to call.
      // The `description` param is driven by schema required-ness, not by
      // mentioning it in the prompt — mentioning it would confound the test.
      prompt: `Run this exact bash command: echo tool-description-marker
Then respond with the output of the command. Do nothing else.`,
      trigger: 'manual',
    })

    await runner.awaitAll(45_000)

    const state = agentStore.get(id)
    expect(state?.status).toBe('completed')

    const history: Message[] = state?.history ?? []
    const toolCallMsg = history.find(
      (m): m is ToolCallMessage => m.kind === 'tool_call'
    )
    expect(toolCallMsg, 'agent history must contain at least one tool_call message').toBeDefined()

    const bashCall = toolCallMsg!.toolCalls.find(tc => tc.name === 'bash')
    expect(bashCall, 'expected a bash tool_call in history').toBeDefined()

    const input = bashCall!.input as Record<string, unknown>
    const keys = Object.keys(input)

    // Core assertion: schema steering worked — description is FIRST.
    expect(keys[0]).toBe('description')

    // And it's a non-empty string (sanity — not asserting content).
    expect(typeof input['description']).toBe('string')
    expect((input['description'] as string).trim().length).toBeGreaterThan(0)

    logTokens(usageStore)
  })
}) // end describe

} // end HAVE_API_KEY guard
