import { describe, it, expect } from 'vitest'
import { ContextAssemblerImpl } from '../../src/head/assembler.js'
import { MessageStore } from '../../src/db/messages.js'
import { AgentStore } from '../../src/db/agents.js'
import { freshDb, makeSkillLoader, makeMcpRegistry, makeIdentityLoader } from '../integration/helpers.js'
import type { Config } from '../../src/config.js'
import type { QueueEvent } from '../../src/types/core.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STUB_CONFIG: Config = {
  contextWindowTokens: 200_000,
  archivalThresholdFraction: 0.9,
  llmMaxTokens: 4096,
  contextAssemblyTokenBudget: 50_000,
  timezone: 'UTC',
} as Config

const USER_MSG_TRIGGER: QueueEvent = {
  type: 'user_message',
  id: 'ev_1',
  channel: 'test',
  text: 'hello',
  createdAt: new Date().toISOString(),
}

function makeAssembler(getNow?: () => Date) {
  const db = freshDb()
  const messages = new MessageStore(db)
  const workers = new AgentStore(db)
  const args: ConstructorParameters<typeof ContextAssemblerImpl> = [
    makeIdentityLoader('You are Shrok.'),
    messages,
    workers,
    makeSkillLoader(),
    STUB_CONFIG,
    makeMcpRegistry(),
  ]
  if (getNow) {
    return new ContextAssemblerImpl(...args, getNow)
  }
  return new ContextAssemblerImpl(...args)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssemblerImpl — getNow injection', () => {
  it('includes the injected date in the system prompt', async () => {
    const fixedDate = new Date('2025-06-15T10:30:00Z')
    const assembler = makeAssembler(() => fixedDate)

    const { systemPrompt } = await assembler.assemble(USER_MSG_TRIGGER)

    // The date string should appear in the system prompt
    expect(systemPrompt).toContain('Current time:')
    // The year should be present (locale-formatted)
    expect(systemPrompt).toContain('2025')
  })

  it('produces different system prompts for different injected dates', async () => {
    const dateA = new Date('2025-01-01T00:00:00Z')
    const dateB = new Date('2026-12-31T23:59:59Z')

    const assemblerA = makeAssembler(() => dateA)
    const assemblerB = makeAssembler(() => dateB)

    const { systemPrompt: promptA } = await assemblerA.assemble(USER_MSG_TRIGGER)
    const { systemPrompt: promptB } = await assemblerB.assemble(USER_MSG_TRIGGER)

    expect(promptA).not.toBe(promptB)
  })

  it('includes the identity system prompt as the base', async () => {
    const assembler = makeAssembler(() => new Date())
    const { systemPrompt } = await assembler.assemble(USER_MSG_TRIGGER)
    expect(systemPrompt).toContain('You are Shrok.')
  })

  it('returns an empty history when no messages are stored', async () => {
    const assembler = makeAssembler(() => new Date())
    const { history } = await assembler.assemble(USER_MSG_TRIGGER)
    expect(history).toEqual([])
  })

  it('historyBudget is positive and less than contextWindowTokens', async () => {
    const assembler = makeAssembler(() => new Date())
    const { historyBudget } = await assembler.assemble(USER_MSG_TRIGGER)
    expect(historyBudget).toBeGreaterThan(0)
    expect(historyBudget).toBeLessThan(STUB_CONFIG.contextWindowTokens)
  })
})
