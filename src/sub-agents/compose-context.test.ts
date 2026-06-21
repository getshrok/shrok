import { describe, it, expect, vi } from 'vitest'
import { composeVerbatimContext } from './compose-context.js'
import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'

function txt(id: string, content: string, role: 'user' | 'assistant' = 'user', injected = false): TextMessage {
  return { kind: 'text', role, id, content, createdAt: new Date().toISOString(), ...(injected ? { injected: true } : {}) }
}

function routerReturning(content: string): LLMRouter {
  return {
    complete: vi.fn().mockResolvedValue({
      content, model: 'test', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', toolCalls: [],
    } satisfies LLMResponse),
  }
}

const BUDGET = 60_000

describe('composeVerbatimContext', () => {
  it('strips injected user nudges before composing (they are not part of the conversation)', async () => {
    const history: Message[] = [txt('n', 'SYSTEM NUDGE', 'user', true), txt('u', 'the real user message')]
    // After stripping the injected nudge, the only entry is the real message → msg_0.
    const router = routerReturning('[{"id":"msg_0","action":"keep"}]')
    const out = await composeVerbatimContext(history, 'topic', router, 'dumb', undefined, new Set(), BUDGET)
    expect(out.text).toContain('the real user message')
    expect(out.text).not.toContain('SYSTEM NUDGE')
    expect(out.empty).toBe(false)
  })

  it('keep preserves the originating role of each message', async () => {
    const history: Message[] = [txt('u', 'user line', 'user'), txt('a', 'assistant line', 'assistant')]
    const router = routerReturning('[{"id":"msg_0","action":"keep"},{"id":"msg_1","action":"keep"}]')
    const out = await composeVerbatimContext(history, 't', router, 'dumb', undefined, new Set(), BUDGET)
    expect(out.messages.map(m => (m as TextMessage).role)).toEqual(['user', 'assistant'])
    expect(out.text).toBe('[user] user line\n\n[assistant] assistant line')
  })

  it('extract delivers the verbatim SOURCE span (snapped), not the model bytes', async () => {
    const history: Message[] = [txt('u', 'book a flight   to Boston and call mom')]  // double space
    // model returns single-spaced quote; snapQuote must recover the real source bytes
    const router = routerReturning('[{"id":"msg_0","action":"extract","quotes":["book a flight to Boston"]}]')
    const out = await composeVerbatimContext(history, 'flight', router, 'dumb', undefined, new Set(), BUDGET)
    expect(out.messages).toHaveLength(1)
    expect((out.messages[0] as TextMessage).content).toBe('book a flight   to Boston')
    expect(out.text).toContain('book a flight   to Boston')
    expect(out.text).not.toContain('call mom')
  })

  it('empty:true when every message is dropped', async () => {
    const history: Message[] = [txt('u', 'totally unrelated')]
    const router = routerReturning('[{"id":"msg_0","action":"drop"}]')
    const out = await composeVerbatimContext(history, 'flight', router, 'dumb', undefined, new Set(), BUDGET)
    expect(out.empty).toBe(true)
    expect(out.messages).toHaveLength(0)
    expect(out.text).toBe('')
  })

  it('empty:true and no LLM call when history is empty', async () => {
    const router = routerReturning('[]')
    const out = await composeVerbatimContext([], 'flight', router, 'dumb', undefined, new Set(), BUDGET)
    expect(out.empty).toBe(true)
    expect(router.complete).not.toHaveBeenCalled()
  })
})
