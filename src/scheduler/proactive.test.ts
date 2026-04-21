import { describe, it, expect, vi } from 'vitest'
import { runProactiveDecision, runReminderDecision, type ProactiveContext, type ReminderDecisionContext } from './proactive.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'

function makeContext(overrides: Partial<ProactiveContext> = {}): ProactiveContext {
  return {
    skillName: 'email-triage',
    skillDescription: 'Triage unread emails',
    skillInstructions: 'Check inbox and summarize important emails.',
    scheduleCron: '0 9 * * *',
    lastRun: '2026-04-03T09:00:00Z',
    lastSkipped: null,
    lastSkipReason: null,
    userMd: 'Software engineer, prefers morning updates.',
    recentHistory: [
      { role: 'user', content: 'Good morning!' },
      { role: 'assistant', content: 'Good morning! How can I help?' },
    ],
    ambientContext: '',
    currentTime: '2026-04-04T09:00:00Z',
    ...overrides,
  }
}

function makeRouter(content: string): LLMRouter {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      inputTokens: 100,
      outputTokens: 20,
      model: 'claude-haiku-4-5-20251001',
      stopReason: 'end_turn',
    }),
  } as unknown as LLMRouter
}

function makeUsageStore(): UsageStore {
  return { record: vi.fn() } as unknown as UsageStore
}

describe('runProactiveDecision', () => {
  it('returns run when LLM says run', async () => {
    const router = makeRouter('{"action": "run", "reason": "task is relevant"}')
    const decision = await runProactiveDecision(makeContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toBe('task is relevant')
  })

  it('returns skip when LLM says skip', async () => {
    const router = makeRouter('{"action": "skip", "reason": "user is on vacation"}')
    const decision = await runProactiveDecision(makeContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('skip')
    expect(decision.reason).toBe('user is on vacation')
  })

  it('defaults to run on LLM error', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as LLMRouter
    const decision = await runProactiveDecision(makeContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toContain('defaulting to run')
  })

  it('defaults to run on malformed JSON', async () => {
    const router = makeRouter('I think we should run this task')
    const decision = await runProactiveDecision(makeContext(), router, 'standard', makeUsageStore())
    // extractJson will throw on non-JSON → caught → default to run
    expect(decision.action).toBe('run')
  })

  it('defaults to run when action is missing', async () => {
    const router = makeRouter('{"reason": "no action field"}')
    const decision = await runProactiveDecision(makeContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('run')
  })

  it('passes context to LLM prompt', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok"}')
    const ctx = makeContext({ skillName: 'email', scheduleCron: '*/30 * * * *' })
    await runProactiveDecision(ctx, router, 'standard', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).toContain('email')
    expect(promptContent).toContain('Every 30 minutes')
  })
})

// ─── runReminderDecision ──────────────────────────────────────────────────────

function makeReminderContext(overrides: Partial<ReminderDecisionContext> = {}): ReminderDecisionContext {
  return {
    reminderMessage: 'Follow up with Sarah about the proposal',
    reminderCron: null,
    lastFired: null,
    userMd: 'Software engineer.',
    recentHistory: [
      { role: 'user', content: 'Good morning!' },
      { role: 'assistant', content: 'Good morning! How can I help?' },
    ],
    ambientContext: '',
    currentTime: '2026-04-05T09:00:00Z',
    ...overrides,
  }
}

describe('runReminderDecision', () => {
  it('returns inject when LLM says inject', async () => {
    const router = makeRouter('{"action": "inject", "reason": "reminder is still relevant"}')
    const decision = await runReminderDecision(makeReminderContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('inject')
    expect(decision.reason).toBe('reminder is still relevant')
  })

  it('returns skip when LLM says skip', async () => {
    const router = makeRouter('{"action": "skip", "reason": "already discussed with Sarah"}')
    const decision = await runReminderDecision(makeReminderContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('skip')
    expect(decision.reason).toBe('already discussed with Sarah')
  })

  it('defaults to inject on LLM error', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as LLMRouter
    const decision = await runReminderDecision(makeReminderContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('inject')
    expect(decision.reason).toContain('defaulting to inject')
  })

  it('defaults to inject on malformed JSON', async () => {
    const router = makeRouter('I think this reminder should fire')
    const decision = await runReminderDecision(makeReminderContext(), router, 'standard', makeUsageStore())
    expect(decision.action).toBe('inject')
  })
})
