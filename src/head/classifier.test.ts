import { describe, it, expect, vi } from 'vitest'
import { snapQuote, classifyAndCompose } from './classifier.js'
import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'

function txt(id: string, content: string, role: 'user' | 'assistant' = 'user'): TextMessage {
  return { kind: 'text', role, id, content, createdAt: new Date().toISOString() }
}

/** Stub router that returns one fixed JSON body for the composer's classify call. */
function routerReturning(content: string): LLMRouter {
  return {
    complete: vi.fn().mockResolvedValue({
      content, model: 'test', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', toolCalls: [],
    } satisfies LLMResponse),
  }
}

describe('snapQuote (verbatim verification ladder)', () => {
  it('tier-1: returns the quote unchanged when it is an exact substring', () => {
    expect(snapQuote('window seat', 'I want a window seat under $300')).toBe('window seat')
  })

  it('tier-2: snaps to the real SOURCE bytes across whitespace differences', () => {
    const src = 'book the\nwindow   seat please'
    const out = snapQuote('window seat', src)
    expect(out).toBe('window   seat')        // source whitespace, not the quote's single space
    expect(src.includes(out!)).toBe(true)    // it IS a real substring of the source
  })

  it('tier-3: returns null when the quote cannot be located even up-to-whitespace', () => {
    expect(snapQuote('aisle seat', 'I want a window seat')).toBeNull()
  })

  it('never throws on regex-special characters in the quote', () => {
    expect(() => snapQuote('($300)', 'price is ($300) total')).not.toThrow()
    expect(snapQuote('($300)', 'price is ($300) total')).toBe('($300)')
    expect(snapQuote('[unmatched', 'no match here')).toBeNull()
  })
})

describe('classifyAndCompose (keep/drop/extract → verbatim stitch)', () => {
  it('keep includes the whole message; drop excludes it', async () => {
    const msgs: Message[] = [txt('a', 'A about flight'), txt('b', 'B about dinner')]
    const router = routerReturning('[{"id":"msg_0","action":"keep"},{"id":"msg_1","action":"drop"}]')
    const { relevantIndices, replacements } = await classifyAndCompose('flight', msgs, router, 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(relevantIndices.has(1)).toBe(false)
    expect(replacements.size).toBe(0)
  })

  it('extract with a locatable quote replaces content with the verbatim span', async () => {
    const msgs: Message[] = [txt('m', 'book a flight to Boston and also call mom')]
    const router = routerReturning('[{"id":"msg_0","action":"extract","quotes":["book a flight to Boston"]}]')
    const { relevantIndices, replacements } = await classifyAndCompose('flight', msgs, router, 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(replacements.get(0)).toBe('book a flight to Boston')
  })

  it('extract with an UNLOCATABLE quote fails open to keep-whole (never drops content)', async () => {
    const msgs: Message[] = [txt('m', 'book a flight to Boston')]
    // The model hallucinated a span that is not in the source.
    const router = routerReturning('[{"id":"msg_0","action":"extract","quotes":["fly to Chicago"]}]')
    const { relevantIndices, replacements } = await classifyAndCompose('flight', msgs, router, 'dumb')
    expect(relevantIndices.has(0)).toBe(true)   // kept whole
    expect(replacements.has(0)).toBe(false)     // no paraphrased replacement
  })

  it('extract with empty quotes keeps the whole message (fail open)', async () => {
    const msgs: Message[] = [txt('m', 'book a flight to Boston')]
    const router = routerReturning('[{"id":"msg_0","action":"extract","quotes":[]}]')
    const { relevantIndices, replacements } = await classifyAndCompose('flight', msgs, router, 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(replacements.has(0)).toBe(false)
  })

  it('a missing classification fails open to keep (empty array keeps everything)', async () => {
    const msgs: Message[] = [txt('a', 'A'), txt('b', 'B')]
    const { relevantIndices } = await classifyAndCompose('x', msgs, routerReturning('[]'), 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(relevantIndices.has(1)).toBe(true)
  })

  it('a kept tool_call/result pair includes both original indices', async () => {
    const call: Message = {
      kind: 'tool_call', id: 'tc', createdAt: new Date().toISOString(), content: '',
      toolCalls: [{ id: 'x', name: 'search', input: { q: 'boston' } }],
    }
    const result: Message = {
      kind: 'tool_result', id: 'tr', createdAt: new Date().toISOString(),
      toolResults: [{ toolCallId: 'x', name: 'search', content: 'found flights' }],
    }
    const router = routerReturning('[{"id":"pair_0","action":"keep"}]')
    const { relevantIndices } = await classifyAndCompose('flight', [call, result], router, 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(relevantIndices.has(1)).toBe(true)
  })

  it('on a non-JSON classifier response, fails open and keeps everything', async () => {
    const msgs: Message[] = [txt('a', 'A'), txt('b', 'B')]
    const { relevantIndices } = await classifyAndCompose('x', msgs, routerReturning('not json'), 'dumb')
    expect(relevantIndices.has(0)).toBe(true)
    expect(relevantIndices.has(1)).toBe(true)
  })
})
