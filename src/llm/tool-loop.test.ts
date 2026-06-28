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
import { descriptionForChannel, runToolLoop, AgentAbortedError, LoopDetectedError, stripLeadingBracketPrefixes, type ToolExecutor } from './tool-loop.js'
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

// Records the LLMOptions of every complete() call so tests can assert what the
// loop forwarded to the provider.
class CapturingProvider implements LLMProvider {
  readonly name = 'capturing'
  readonly received: LLMOptions[] = []
  callCount = 0
  private responses: LLMResponse[]
  constructor(responses: LLMResponse[]) { this.responses = responses }
  async complete(_msgs: Message[], _tools: ToolDefinition[], opts: LLMOptions): Promise<LLMResponse> {
    this.received.push(opts)
    const resp = this.responses[this.callCount++]
    if (!resp) throw new Error('CapturingProvider: no more responses configured')
    return resp
  }
}

describe('runToolLoop maxTokens pass-through', () => {
  const baseOpts = () => ({
    model: 'smart',
    tools: [],
    systemPrompt: 'sys',
    history: [...baseHistory],
    executor: makeExecutor(),
    usage: freshUsage(),
    sourceType: 'agent' as const,
    sourceId: 'agt_1',
    appendMessage: async () => {},
    refreshHistory: () => [...baseHistory],
  })

  it('forwards options.maxTokens to the provider complete() call', async () => {
    const provider = new CapturingProvider([END_TURN_RESPONSE])
    const router = new SingleProviderRouter(provider, { dumb: 'stub-dumb', smart: 'stub-smart', genius: 'stub-genius' })
    await runToolLoop(router, { ...baseOpts(), maxTokens: 16384 })
    expect(provider.received[0]?.maxTokens).toBe(16384)
  })

  it('omits maxTokens when unset so the provider fallback (8192) applies', async () => {
    const provider = new CapturingProvider([END_TURN_RESPONSE])
    const router = new SingleProviderRouter(provider, { dumb: 'stub-dumb', smart: 'stub-smart', genius: 'stub-genius' })
    await runToolLoop(router, baseOpts())
    expect(provider.received[0]?.maxTokens).toBeUndefined()
  })
})

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

// ─── Loop detection — Trigger B (consecutive-error) regression ────────────────
//
// Reproduces the `check-health-import-reminder` misfire: an agent doing adaptive
// filesystem exploration (reading several DISTINCT paths, some absent) was killed
// as "stuck in a loop", including in a round where it had just SUCCEEDED reading
// the file holding the answer. Two fixes are pinned here:
//   #1 Trigger B fingerprints on tool name + input — distinct-path errors are
//      exploration, not a loop, and must not accumulate.
//   #2 A round containing ANY successful tool result cannot raise the loop
//      signal — a parallel batch that retrieved a real result alongside misses
//      is not stuck.

/** Provider that serves scripted main-loop responses and, when it sees a
 *  loop-steward call (detected via the `loop_steward` jsonSchema), records it
 *  and votes ABORT — so any spurious Trigger B firing surfaces as either a
 *  steward call or (post-nudge) a thrown LoopDetectedError. */
class LoopTestProvider implements LLMProvider {
  readonly name = 'stub'
  private mainResponses: LLMResponse[]
  mainIdx = 0
  stewardCalls = 0
  constructor(mainResponses: LLMResponse[]) { this.mainResponses = mainResponses }
  async complete(_msgs: Message[], _tools: ToolDefinition[], opts: LLMOptions): Promise<LLMResponse> {
    if (opts.jsonSchema?.name === 'loop_steward') {
      this.stewardCalls++
      return {
        content: JSON.stringify({ verdict: 'abort', reason: 'test-abort' }),
        inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', model: 'stub-dumb',
      }
    }
    const r = this.mainResponses[this.mainIdx++]
    if (!r) throw new Error('LoopTestProvider: no more main responses configured')
    return r
  }
}

function loopRouter(mainResponses: LLMResponse[]) {
  const provider = new LoopTestProvider(mainResponses)
  const router = new SingleProviderRouter(provider, {
    dumb: 'stub-dumb', smart: 'stub-smart', genius: 'stub-genius',
  })
  return { provider, router }
}

/** One tool_call round calling `read_file` with the given path. */
function readCall(path: string, id: string): LLMResponse {
  return {
    content: '', toolCalls: [{ id, name: 'read_file', input: { path } }],
    inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', model: 'stub-smart',
  }
}

/** A round with multiple parallel read_file calls (mirrors a fan-out batch). */
function multiReadCall(paths: string[], idPrefix: string): LLMResponse {
  return {
    content: '',
    toolCalls: paths.map((p, i) => ({ id: `${idPrefix}-${i}`, name: 'read_file', input: { path: p } })) as unknown as [ToolCall, ...ToolCall[]],
    inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', model: 'stub-smart',
  }
}

/** Executor: any path in `missing` errors (ENOENT-style); everything else succeeds. */
function fsExecutor(missing: Set<string>): ToolExecutor {
  return {
    execute: async (tc: ToolCall): Promise<ToolResult> => {
      const p = (tc.input as { path?: string }).path ?? ''
      if (missing.has(p)) {
        return { toolCallId: tc.id, name: tc.name, content: `Error: ENOENT: no such file or directory, open '${p}'` }
      }
      return { toolCallId: tc.id, name: tc.name, content: `contents of ${p}` }
    },
  }
}

function loopTools(): ToolDefinition[] {
  return [{ name: 'read_file', description: 'read a file', inputSchema: {} }]
}

describe('runToolLoop — loop Trigger B regression', () => {
  it('#1: errors on DISTINCT inputs do not accumulate into a loop signal', async () => {
    // Two rounds each erroring read_file on a *different* path. Old (name-keyed)
    // logic would hit ERROR_TRIGGER=2 and invoke the steward; with name+input
    // fingerprinting each path counts once, so the steward never fires.
    const { provider, router } = loopRouter([
      readCall('/a', 'r1'),
      readCall('/b', 'r2'),
      END_TURN_RESPONSE,
    ])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'smart', tools: loopTools(), systemPrompt: 'sys', history: [...baseHistory],
      executor: fsExecutor(new Set(['/a', '/b'])), usage, sourceType: 'agent', sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    expect(resp.content).toBe('Hello!')
    expect(provider.stewardCalls).toBe(0)
  })

  it('#2: a round with a successful read suppresses the error trigger for that round', async () => {
    // Same failing path twice (fp count would reach 2 = ERROR_TRIGGER), but the
    // second round also reads a file that SUCCEEDS — progress guard suppresses it.
    const { provider, router } = loopRouter([
      readCall('/missing', 'r1'),
      multiReadCall(['/missing', '/found'], 'r2'),
      END_TURN_RESPONSE,
    ])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'smart', tools: loopTools(), systemPrompt: 'sys', history: [...baseHistory],
      executor: fsExecutor(new Set(['/missing'])), usage, sourceType: 'agent', sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    expect(resp.content).toBe('Hello!')
    expect(provider.stewardCalls).toBe(0)
  })

  it('still catches a genuine loop: the SAME failing call repeated with no progress', async () => {
    // Same path errors in two consecutive barren rounds → fp count hits
    // ERROR_TRIGGER=2 → steward fires. First abort verdict injects a nudge
    // (does not throw); the loop then ends normally.
    const { provider, router } = loopRouter([
      readCall('/missing', 'r1'),
      readCall('/missing', 'r2'),
      END_TURN_RESPONSE,
    ])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'smart', tools: loopTools(), systemPrompt: 'sys', history: [...baseHistory],
      executor: fsExecutor(new Set(['/missing'])), usage, sourceType: 'agent', sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    expect(resp.content).toBe('Hello!')
    expect(provider.stewardCalls).toBeGreaterThanOrEqual(1)
    // A corrective nudge (user-role text) was injected after the abort verdict.
    expect(appended.some(m => m.kind === 'text' && m.role === 'user' && m.content.includes('try a different approach'))).toBe(true)
  })

  it('full repro: post-nudge round with a success + distinct-path misses is NOT aborted', async () => {
    // Mirrors check-health-import-reminder end-to-end:
    //   round 1+2  same failing path → nudge (post-nudge trigger now = 1)
    //   round 3    read the answer file (success) + two distinct absent siblings
    //   round 4    end_turn
    // Old logic aborted in round 3 (post-nudge, name-keyed errors hit 1). With
    // both fixes the success-bearing round 3 cannot raise the signal, so the
    // loop reaches end_turn instead of throwing LoopDetectedError.
    const { provider, router } = loopRouter([
      readCall('/missing', 'r1'),
      readCall('/missing', 'r2'),
      multiReadCall(['/answer', '/graph.json', '/topics.json'], 'r3'),
      END_TURN_RESPONSE,
    ])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'smart', tools: loopTools(), systemPrompt: 'sys', history: [...baseHistory],
      executor: fsExecutor(new Set(['/missing', '/graph.json', '/topics.json'])),
      usage, sourceType: 'agent', sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    expect(resp.content).toBe('Hello!')
    // Steward fired exactly once — at the round-2 nudge, never again in round 3.
    expect(provider.stewardCalls).toBe(1)
  })

  it('regression sanity: WITHOUT the success guard this exact case would abort', async () => {
    // Confirms the test exercises the formerly-fatal path: a post-nudge barren
    // round repeating the SAME failing call (no success) still aborts hard.
    const { provider, router } = loopRouter([
      readCall('/missing', 'r1'),
      readCall('/missing', 'r2'),   // → nudge
      readCall('/missing', 'r3'),   // post-nudge repeat, no success → abort
    ])
    const appended: Message[] = []
    const usage = freshUsage()

    await expect(runToolLoop(router, {
      model: 'smart', tools: loopTools(), systemPrompt: 'sys', history: [...baseHistory],
      executor: fsExecutor(new Set(['/missing'])), usage, sourceType: 'agent', sourceId: 'agt_1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })).rejects.toBeInstanceOf(LoopDetectedError)

    expect(provider.stewardCalls).toBe(2)
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
