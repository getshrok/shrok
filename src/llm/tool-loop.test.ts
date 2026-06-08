/**
 * Phase 3: descriptionForChannel sanitization contract tests.
 *
 * Locks in:
 *   1. typeof check: non-string returns null
 *   2. Empty / whitespace-only after trim returns null
 *   3. Backtick replacement: ` → ' (protects the outer markdown code fence)
 *   4. 200-char truncation: slice(0, 197) + '…'
 *   5. Sanitization order: trim THEN backtick-strip THEN empty-check THEN truncate
 */
import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { descriptionForChannel, runToolLoop, AgentAbortedError, stripLeadingBracketPrefixes, type ToolExecutor } from './tool-loop.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { UsageStore } from '../db/usage.js'
import { SingleProviderRouter } from './router.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import type { Message, ToolCall, ToolResult, TextMessage } from '../types/core.js'

describe('descriptionForChannel — valid input', () => {
  it('returns the string unchanged for a plain description', () => {
    expect(descriptionForChannel({ description: 'running tests' })).toBe('running tests')
  })

  it('trims surrounding whitespace', () => {
    expect(descriptionForChannel({ description: '  running tests  ' })).toBe('running tests')
  })

  it('returns a single character description unchanged', () => {
    expect(descriptionForChannel({ description: 'a' })).toBe('a')
  })
})

describe('descriptionForChannel — null cases', () => {
  it('returns null for empty string', () => {
    expect(descriptionForChannel({ description: '' })).toBeNull()
  })

  it('returns null for whitespace-only spaces', () => {
    expect(descriptionForChannel({ description: '   ' })).toBeNull()
  })

  it('returns null for mixed whitespace (tab/newline/cr)', () => {
    expect(descriptionForChannel({ description: '\t\n  \r' })).toBeNull()
  })

  it('returns null for a non-string (number)', () => {
    expect(descriptionForChannel({ description: 42 })).toBeNull()
  })

  it('returns null when the description key is absent', () => {
    expect(descriptionForChannel({})).toBeNull()
  })
})

describe('descriptionForChannel — whitespace collapse (WR-02)', () => {
  it('collapses an interior newline to a single space', () => {
    expect(descriptionForChannel({ description: 'a\nb' })).toBe('a b')
  })

  it('collapses an interior tab to a single space', () => {
    expect(descriptionForChannel({ description: 'a\tb' })).toBe('a b')
  })

  it('collapses an interior carriage return to a single space', () => {
    expect(descriptionForChannel({ description: 'a\rb' })).toBe('a b')
  })

  it('collapses mixed runs of whitespace to a single space and trims edges', () => {
    expect(descriptionForChannel({ description: '  a  \n  b  ' })).toBe('a b')
  })

  it('collapses a multi-line description with many blank lines', () => {
    expect(descriptionForChannel({ description: 'install deps\n\nthen run tests' })).toBe(
      'install deps then run tests',
    )
  })

  it('collapses runs of spaces between words', () => {
    expect(descriptionForChannel({ description: 'a    b' })).toBe('a b')
  })
})

describe('descriptionForChannel — backtick replacement', () => {
  it('replaces backticks in "use `npm test`" with single quotes', () => {
    expect(descriptionForChannel({ description: 'use `npm test`' })).toBe("use 'npm test'")
  })

  it('replaces three backticks with three single quotes (non-empty, non-null)', () => {
    expect(descriptionForChannel({ description: '```' })).toBe("'''")
  })

  it('leaves a description with no backticks unchanged', () => {
    expect(descriptionForChannel({ description: 'no backticks here' })).toBe('no backticks here')
  })
})

describe('descriptionForChannel — 200-char truncation', () => {
  it('returns a 199-char string unchanged', () => {
    const s = 'a'.repeat(199)
    const out = descriptionForChannel({ description: s })
    expect(out).toBe(s)
    expect(out!.length).toBe(199)
  })

  it('returns a 200-char string unchanged (exact boundary)', () => {
    const s = 'a'.repeat(200)
    const out = descriptionForChannel({ description: s })
    expect(out).toBe(s)
    expect(out!.length).toBe(200)
  })

  it('truncates a 201-char string to 197 chars + ellipsis', () => {
    const s = 'a'.repeat(201)
    const out = descriptionForChannel({ description: s })
    expect(out!.length).toBe(198)
    expect(out!.endsWith('…')).toBe(true)
    expect(out!.slice(0, 197)).toBe('a'.repeat(197))
  })

  it('truncates a 1000-char string to 197 chars + ellipsis', () => {
    const s = 'a'.repeat(1000)
    const out = descriptionForChannel({ description: s })
    expect(out!.length).toBe(198)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('uses a single ellipsis char (U+2026), not three dots', () => {
    const s = 'a'.repeat(300)
    const out = descriptionForChannel({ description: s })
    expect(out!.slice(-1)).toBe('…')
    expect(out!.slice(-3)).not.toBe('...')
  })
})

// ─── Helpers for runToolLoop onRoundComplete tests ────────────────────────────

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshUsage() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return new UsageStore(db, 'UTC')
}

class StubProvider implements LLMProvider {
  readonly name = 'stub'
  private responses: LLMResponse[]
  callCount = 0
  constructor(responses: LLMResponse[]) { this.responses = responses }
  async complete(_msgs: Message[], _tools: ToolDefinition[], _opts: LLMOptions): Promise<LLMResponse> {
    const resp = this.responses[this.callCount++]
    if (!resp) throw new Error('StubProvider: no more responses configured')
    return resp
  }
}

function makeRouter(responses: LLMResponse[]) {
  const provider = new StubProvider(responses)
  const router = new SingleProviderRouter(provider, {
    dumb: 'stub-dumb', smart: 'stub-smart', genius: 'stub-genius',
  })
  return { provider, router }
}

const TOOL_CALL_RESPONSE: LLMResponse = {
  content: '', toolCalls: [{ id: 'tc-1', name: 'my_tool', input: { x: 1 } }],
  inputTokens: 20, outputTokens: 10, stopReason: 'tool_use', model: 'stub-smart',
}
const TOOL_CALL_RESPONSE_2: LLMResponse = {
  content: '', toolCalls: [{ id: 'tc-2', name: 'my_tool', input: { x: 2 } }],
  inputTokens: 20, outputTokens: 10, stopReason: 'tool_use', model: 'stub-smart',
}
const END_TURN_RESPONSE: LLMResponse = {
  content: 'Hello!', inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', model: 'stub-smart',
}

const baseHistory: TextMessage[] = [{
  kind: 'text', id: 'h1', role: 'user', content: 'do something', createdAt: '2025-01-01',
}]

function makeExecutor(): ToolExecutor {
  return {
    execute: async (tc: ToolCall): Promise<ToolResult> => ({
      toolCallId: tc.id, name: tc.name, content: 'ok',
    }),
  }
}

describe('runToolLoop onRoundComplete callback', () => {
  it('fires once per non-final round (after each tool_result append, before next LLM call)', async () => {
    // 3 LLM rounds (tool_call, tool_call, end_turn) → callback fires exactly 2 times
    const { provider, router } = makeRouter([TOOL_CALL_RESPONSE, TOOL_CALL_RESPONSE_2, END_TURN_RESPONSE])
    const callback = vi.fn().mockResolvedValue(false)
    const appended: Message[] = []
    const usage = freshUsage()

    await runToolLoop(router, {
      model: 'smart',
      tools: [{ name: 'my_tool', description: 't', inputSchema: {} }],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'agent',
      sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
      onRoundComplete: callback,
    })

    expect(callback).toHaveBeenCalledTimes(2)
    expect(provider.callCount).toBe(3)
  })

  it('returning true throws AgentAbortedError and skips the next LLM call', async () => {
    const { provider, router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const callback = vi.fn().mockResolvedValue(true)
    const appended: Message[] = []
    const usage = freshUsage()

    await expect(runToolLoop(router, {
      model: 'smart',
      tools: [{ name: 'my_tool', description: 't', inputSchema: {} }],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'agent',
      sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
      onRoundComplete: callback,
    })).rejects.toBeInstanceOf(AgentAbortedError)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(provider.callCount).toBe(1)  // second LLM call never fires
  })

  it('returning false continues the loop normally', async () => {
    const { provider, router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const callback = vi.fn().mockResolvedValue(false)
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'smart',
      tools: [{ name: 'my_tool', description: 't', inputSchema: {} }],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'agent',
      sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
      onRoundComplete: callback,
    })

    expect(resp.content).toBe('Hello!')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(provider.callCount).toBe(2)
  })

  it('undefined callback is byte-equivalent to existing behavior (no callback fires)', async () => {
    const { provider, router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()

    await runToolLoop(router, {
      model: 'smart',
      tools: [{ name: 'my_tool', description: 't', inputSchema: {} }],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'agent',
      sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
      // onRoundComplete intentionally omitted
    })

    expect(provider.callCount).toBe(2)
    expect(appended).toHaveLength(3)  // tool_call + tool_result + final text
    expect(appended[0]?.kind).toBe('tool_call')
    expect(appended[1]?.kind).toBe('tool_result')
    expect(appended[2]?.kind).toBe('text')
  })

  it('callback fires after tool_result append and before next LLM call', async () => {
    const { provider, router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()
    let appendedAtCallback = -1
    let providerCallsAtCallback = -1
    const callback = vi.fn().mockImplementation(async () => {
      appendedAtCallback = appended.length
      providerCallsAtCallback = provider.callCount
      return false
    })

    await runToolLoop(router, {
      model: 'smart',
      tools: [{ name: 'my_tool', description: 't', inputSchema: {} }],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'agent',
      sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
      onRoundComplete: callback,
    })

    // At the (single) callback invocation: tool_call + tool_result both appended,
    // and the second LLM call has NOT yet happened.
    expect(appendedAtCallback).toBe(2)
    expect(providerCallsAtCallback).toBe(1)
  })
})

// ─── stripLeadingBracketPrefixes (Phase 36 D-11/D-12) ─────────────────────────

describe('stripLeadingBracketPrefixes', () => {
  describe('preserves all existing timestamp strip cases (regression)', () => {
    it('strips [5m ago] prefix', () => {
      expect(stripLeadingBracketPrefixes('[5m ago] hi')).toBe('hi')
    })

    it('strips [3h ago] prefix', () => {
      expect(stripLeadingBracketPrefixes('[3h ago] hi')).toBe('hi')
    })

    it('strips [2d ago] prefix', () => {
      expect(stripLeadingBracketPrefixes('[2d ago] hi')).toBe('hi')
    })

    it('strips [Apr 3, 2:15 PM] prefix', () => {
      expect(stripLeadingBracketPrefixes('[Apr 3, 2:15 PM] hi')).toBe('hi')
    })

    it('strips [Apr 3, 12:00 AM] prefix', () => {
      expect(stripLeadingBracketPrefixes('[Apr 3, 12:00 AM] hi')).toBe('hi')
    })

    it('strips [now] prefix', () => {
      expect(stripLeadingBracketPrefixes('[now] hi')).toBe('hi')
    })

    it('strips [just now] prefix', () => {
      expect(stripLeadingBracketPrefixes('[just now] hi')).toBe('hi')
    })
  })

  describe('strips new bracket-name prefixes (D-11)', () => {
    it('strips [Ashley]: prefix (with colon)', () => {
      expect(stripLeadingBracketPrefixes('[Ashley]: hi')).toBe('hi')
    })

    it('strips [Ashley] prefix (without colon)', () => {
      expect(stripLeadingBracketPrefixes('[Ashley] hi')).toBe('hi')
    })

    it("strips compound [5m ago] [Jarvis]: → 'sunny all day' (user's specifics example)", () => {
      expect(stripLeadingBracketPrefixes('[5m ago] [Jarvis]: sunny all day')).toBe('sunny all day')
    })

    it("strips three-prefix chain [a] [b] [c]: x → 'x'", () => {
      expect(stripLeadingBracketPrefixes('[a] [b] [c]: x')).toBe('x')
    })

    it("strips bracketed name with internal whitespace [ Ashley ]: hi → 'hi'", () => {
      expect(stripLeadingBracketPrefixes('[ Ashley ]: hi')).toBe('hi')
    })

    it("strips [Ashley 🎉]: hi → 'hi' (emoji-name passthrough)", () => {
      expect(stripLeadingBracketPrefixes('[Ashley 🎉]: hi')).toBe('hi')
    })
  })

  describe('does NOT strip non-leading or malformed brackets (anti-regression)', () => {
    it("leaves middle-of-line bracket unchanged: 'say [Ashley]: hi' → unchanged", () => {
      expect(stripLeadingBracketPrefixes('say [Ashley]: hi')).toBe('say [Ashley]: hi')
    })

    it("leaves line-2 bracket unchanged: 'hi\\n[Ashley]: world' → unchanged", () => {
      expect(stripLeadingBracketPrefixes('hi\n[Ashley]: world')).toBe('hi\n[Ashley]: world')
    })

    it("leaves unclosed bracket unchanged: '[unclosed hi' → unchanged", () => {
      expect(stripLeadingBracketPrefixes('[unclosed hi')).toBe('[unclosed hi')
    })

    it("leaves empty brackets unchanged: '[] hi' → unchanged", () => {
      expect(stripLeadingBracketPrefixes('[] hi')).toBe('[] hi')
    })

    it("leaves no-bracket text unchanged: 'plain text' → unchanged", () => {
      expect(stripLeadingBracketPrefixes('plain text')).toBe('plain text')
    })

    it("leaves empty string unchanged: '' → ''", () => {
      expect(stripLeadingBracketPrefixes('')).toBe('')
    })
  })
})
