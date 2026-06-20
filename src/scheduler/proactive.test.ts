import { describe, it, expect, vi } from 'vitest'
import { runProactiveDecision, runReminderDecision, runSensorDispatchDecision, type ProactiveContext, type ReminderDecisionContext, type SensorDispatchContext } from './proactive.js'
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
    const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toBe('task is relevant')
  })

  it('returns skip when LLM says skip', async () => {
    const router = makeRouter('{"action": "skip", "reason": "user is on vacation"}')
    const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('skip')
    expect(decision.reason).toBe('user is on vacation')
  })

  it('defaults to run on LLM error', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as LLMRouter
    const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toContain('defaulting to run')
  })

  it('defaults to run on malformed JSON', async () => {
    const router = makeRouter('I think we should run this task')
    const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
    // extractJson will throw on non-JSON → caught → default to run
    expect(decision.action).toBe('run')
  })

  it('defaults to run when action is missing', async () => {
    const router = makeRouter('{"reason": "no action field"}')
    const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
  })

  it('passes context to LLM prompt', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok"}')
    const ctx = makeContext({ skillName: 'email', scheduleCron: '*/30 * * * *' })
    await runProactiveDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).toContain('email')
    expect(promptContent).toContain('Every 30 minutes')
  })

  it('injects Run conditions block when conditions is set', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok"}')
    const ctx = makeContext({ conditions: 'Weekdays only' })
    await runProactiveDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).toContain('Run conditions:')
    expect(promptContent).toContain('Weekdays only')
  })

  it('omits Run conditions block when conditions is not set', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok"}')
    const ctx = makeContext()
    await runProactiveDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).not.toContain('Run conditions:')
  })

  it('omits Run conditions block when conditions is empty string', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok"}')
    const ctx = makeContext({ conditions: '' })
    await runProactiveDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).not.toContain('Run conditions:')
  })
})

// ─── runReminderDecision ──────────────────────────────────────────────────────

function makeReminderContext(overrides: Partial<ReminderDecisionContext> = {}): ReminderDecisionContext {
  return {
    reminderMessage: 'Follow up with Sarah about the proposal',
    reminderCron: null,
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
    const decision = await runReminderDecision(makeReminderContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('inject')
    expect(decision.reason).toBe('reminder is still relevant')
  })

  it('returns skip when LLM says skip', async () => {
    const router = makeRouter('{"action": "skip", "reason": "already discussed with Sarah"}')
    const decision = await runReminderDecision(makeReminderContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('skip')
    expect(decision.reason).toBe('already discussed with Sarah')
  })

  it('defaults to inject on LLM error', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as LLMRouter
    const decision = await runReminderDecision(makeReminderContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('inject')
    expect(decision.reason).toContain('defaulting to inject')
  })

  it('defaults to inject on malformed JSON', async () => {
    const router = makeRouter('I think this reminder should fire')
    const decision = await runReminderDecision(makeReminderContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('inject')
  })

  it('injects Run conditions block when conditions is set', async () => {
    const router = makeRouter('{"action": "inject", "reason": "ok"}')
    const ctx = makeReminderContext({ conditions: "Only while I'm home" })
    await runReminderDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).toContain('Run conditions:')
    expect(promptContent).toContain("Only while I'm home")
  })

  it('omits Run conditions block when conditions is not set', async () => {
    const router = makeRouter('{"action": "inject", "reason": "ok"}')
    const ctx = makeReminderContext()
    await runReminderDecision(ctx, router, 'dumb', makeUsageStore())

    const call = vi.mocked(router.complete).mock.calls[0]!
    const promptContent = (call[1]![0] as { content: string }).content
    expect(promptContent).not.toContain('Run conditions:')
  })
})

// ─── runSensorDispatchDecision ─────────────────────────────────────────────────

function makeSensorContext(overrides: Partial<SensorDispatchContext> = {}): SensorDispatchContext {
  return {
    slug: 'calendar',
    prompt: 'Create a reminder for the meeting in 10 minutes.',
    userMd: 'Software engineer.',
    recentHistory: [
      { role: 'user', content: 'Good morning!' },
      { role: 'assistant', content: 'Good morning! How can I help?' },
    ],
    ambientContext: '',
    currentTime: '2026-06-20T09:00:00Z',
    ...overrides,
  }
}

describe('runSensorDispatchDecision', () => {
  it('returns run when LLM says run', async () => {
    const router = makeRouter('{"action": "run", "reason": "task is relevant"}')
    const decision = await runSensorDispatchDecision(makeSensorContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toBe('task is relevant')
  })

  it('returns skip when LLM says skip with reason', async () => {
    const router = makeRouter('{"action": "skip", "reason": "user is in a meeting"}')
    const decision = await runSensorDispatchDecision(makeSensorContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('skip')
    expect(decision.reason).toBe('user is in a meeting')
  })

  it('defaults to run on LLM error (D-07 fail-open)', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as LLMRouter
    const decision = await runSensorDispatchDecision(makeSensorContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.reason).toContain('defaulting to run')
  })

  it('defaults to run on malformed/non-JSON LLM content', async () => {
    const router = makeRouter('I think we should run this sensor task')
    const decision = await runSensorDispatchDecision(makeSensorContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
  })

  it('threads the optional context field through when LLM returns it', async () => {
    const router = makeRouter('{"action": "run", "reason": "ok", "context": "user has a meeting at 2pm"}')
    const decision = await runSensorDispatchDecision(makeSensorContext(), router, 'dumb', makeUsageStore())
    expect(decision.action).toBe('run')
    expect(decision.context).toBe('user has a meeting at 2pm')
  })
})
