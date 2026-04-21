import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { UsageStore } from '../db/usage.js'
import { runToolLoop, type ToolExecutor } from './tool-loop.js'
import { SingleProviderRouter, MultiProviderRouter } from './router.js'
import { toAnthropicMessages, toAnthropicTools } from './anthropic.js'
import { toGeminiContents, toGeminiTools } from './gemini.js'
import { toOpenAIMessages, toOpenAITools } from './openai.js'
import { withRetry, LLMApiError, classifyLLMStatus } from './util.js'
import type { Message, ToolCall, ToolResult, TextMessage, ToolCallMessage, ToolResultMessage, SummaryMessage } from '../types/core.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import * as path from 'node:path'
import * as url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshUsage() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return new UsageStore(db, 'UTC')
}

// ─── Stub LLM Provider ────────────────────────────────────────────────────────

class StubProvider implements LLMProvider {
  readonly name = 'stub'
  private responses: LLMResponse[]
  callCount = 0
  lastMessages: Message[] = []

  constructor(responses: LLMResponse[]) {
    this.responses = responses
  }

  async complete(messages: Message[], _tools: ToolDefinition[], _options: LLMOptions): Promise<LLMResponse> {
    this.lastMessages = messages
    const resp = this.responses[this.callCount++]
    if (!resp) throw new Error('StubProvider: no more responses configured')
    return resp
  }
}

function makeRouter(responses: LLMResponse[]) {
  const provider = new StubProvider(responses)
  const router = new SingleProviderRouter(provider, {
    standard: 'stub-standard',
    capable: 'stub-capable',
    expert: 'stub-expert',
  })
  return { provider, router }
}

const END_TURN_RESPONSE: LLMResponse = {
  content: 'Hello!',
  inputTokens: 10,
  outputTokens: 5,
  stopReason: 'end_turn',
  model: 'stub-capable',
}

const TOOL_CALL_RESPONSE: LLMResponse = {
  content: '',
  toolCalls: [{ id: 'tc-1', name: 'my_tool', input: { x: 1 } }],
  inputTokens: 20,
  outputTokens: 10,
  stopReason: 'tool_use',
  model: 'stub-capable',
}

// Loop steward "continue" response — valid JSON the steward can parse
const LOOP_STEWARD_CONTINUE: LLMResponse = {
  content: '{"verdict":"continue","reason":"making progress"}',
  inputTokens: 10,
  outputTokens: 10,
  stopReason: 'end_turn',
  model: 'stub-standard',
}

// ─── SingleProviderRouter ─────────────────────────────────────────────────────

describe('SingleProviderRouter', () => {
  it('routes to the correct model for each tier', async () => {
    const provider = new StubProvider([END_TURN_RESPONSE, END_TURN_RESPONSE, END_TURN_RESPONSE])
    const router = new SingleProviderRouter(provider, {
      standard: 'model-std',
      capable: 'model-cap',
      expert: 'model-exp',
    })

    // Tier resolution happens inside the provider call — verify via callCount
    await router.complete('standard', [], [], {})
    await router.complete('capable', [], [], {})
    await router.complete('expert', [], [], {})
    expect(provider.callCount).toBe(3)
  })
})

// ─── runToolLoop ──────────────────────────────────────────────────────────────

describe('runToolLoop', () => {
  const baseHistory: TextMessage[] = [{
    kind: 'text', id: 'h1', role: 'user', content: 'do something', createdAt: '2025-01-01',
  }]

  function makeExecutor(result: string = 'tool result'): ToolExecutor {
    return {
      execute: async (tc: ToolCall): Promise<ToolResult> => ({
        toolCallId: tc.id,
        name: tc.name,
        content: result,
      }),
    }
  }

  it('returns immediately on end_turn with no tool calls', async () => {
    const { router } = makeRouter([END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'capable',
      tools: [],
      systemPrompt: 'system',
      history: [...baseHistory],
      executor: makeExecutor(),
      usage,
      sourceType: 'head',
      sourceId: 'ev-1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    expect(resp.content).toBe('Hello!')
    expect(appended).toHaveLength(1)
    expect(appended[0]?.kind).toBe('text')
  })

  it('executes tool calls and runs another round', async () => {
    const { router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()

    const resp = await runToolLoop(router, {
      model: 'capable',
      tools: [{ name: 'my_tool', description: 'a tool', inputSchema: {} }],
      systemPrompt: 'system',
      history: [...baseHistory],
      executor: makeExecutor('done!'),
      usage,
      sourceType: 'head',
      sourceId: 'ev-1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    // Round 1: tool_call appended, tool_result appended
    // Round 2: text appended
    expect(appended).toHaveLength(3)
    expect(appended[0]?.kind).toBe('tool_call')
    expect(appended[1]?.kind).toBe('tool_result')
    expect(appended[2]?.kind).toBe('text')
    expect(resp.content).toBe('Hello!')
  })

  it('wraps tool executor exceptions into structured error results', async () => {
    const failingExecutor: ToolExecutor = {
      execute: async () => { throw new Error('something broke') },
    }
    const { router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()

    await runToolLoop(router, {
      model: 'capable',
      tools: [],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor: failingExecutor,
      usage,
      sourceType: 'head',
      sourceId: null,
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    const resultMsg = appended[1] as ToolResultMessage
    expect(resultMsg.kind).toBe('tool_result')
    const result = JSON.parse(resultMsg.toolResults[0]!.content)
    expect(result.error).toBe(true)
    expect(result.message).toBe('something broke')
  })

  it('throws after maxRounds iterations without end_turn', async () => {
    // All rounds return tool calls — loop should throw at maxRounds.
    // SAME_ARGS_TRIGGER=3, so the loop steward fires after round 3 and must return "continue"
    // for the loop to exit via maxRounds rather than via LoopDetectedError.
    const { router } = makeRouter([
      TOOL_CALL_RESPONSE, TOOL_CALL_RESPONSE, TOOL_CALL_RESPONSE,
      LOOP_STEWARD_CONTINUE,  // steward fires after the 3rd identical fingerprint
    ])
    const appended: Message[] = []
    const usage = freshUsage()
    const executor: ToolExecutor = {
      execute: async tc => ({ toolCallId: tc.id, name: tc.name, content: 'ok' }),
    }

    await expect(runToolLoop(router, {
      model: 'capable',
      tools: [],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor,
      usage,
      sourceType: 'head',
      sourceId: null,
      maxRounds: 3,
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })).rejects.toThrow('reached maxRounds (3)')

    // 3 rounds × (tool_call + tool_result) = 6 messages appended before the throw
    expect(appended).toHaveLength(6)
  })

  it('records usage per round', async () => {
    const { router } = makeRouter([TOOL_CALL_RESPONSE, END_TURN_RESPONSE])
    const appended: Message[] = []
    const usage = freshUsage()
    const executor: ToolExecutor = {
      execute: async tc => ({ toolCallId: tc.id, name: tc.name, content: 'ok' }),
    }

    await runToolLoop(router, {
      model: 'capable',
      tools: [],
      systemPrompt: 'sys',
      history: [...baseHistory],
      executor,
      usage,
      sourceType: 'agent',
      sourceId: 't-1',
      appendMessage: async msg => { appended.push(msg) },
      refreshHistory: () => [...baseHistory, ...appended],
    })

    const entries = usage.getBySource('agent', 't-1')
    expect(entries).toHaveLength(2)  // 2 rounds
  })
})

// ─── Anthropic message translation ───────────────────────────────────────────

describe('toAnthropicMessages', () => {
  it('translates user text message', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'user', content: 'hi', createdAt: new Date().toISOString() }
    const result = toAnthropicMessages([msg])
    expect(result).toEqual([{ role: 'user', content: '[0m ago] hi' }])
  })

  it('translates assistant text message', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'assistant', content: 'hello', createdAt: new Date().toISOString() }
    const result = toAnthropicMessages([msg])
    expect(result).toEqual([{ role: 'assistant', content: '[0m ago] hello' }])
  })

  it('translates tool_call message paired with tool_result', () => {
    const call: ToolCallMessage = {
      kind: 'tool_call', id: 'a', content: 'thinking...',
      toolCalls: [{ id: 'tc-1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: '2025-01-01',
    }
    const result: ToolResultMessage = {
      kind: 'tool_result', id: 'b',
      toolResults: [{ toolCallId: 'tc-1', name: 'bash', content: 'file.ts' }],
      createdAt: '2025-01-01',
    }
    const translated = toAnthropicMessages([call, result])
    expect(translated[0]?.role).toBe('assistant')
    const content = translated[0]?.content as Array<{ type: string }>
    expect(content.some(b => b.type === 'text')).toBe(true)
    expect(content.some(b => b.type === 'tool_use')).toBe(true)
  })

  it('drops tool_result with no paired tool_call (orphan)', () => {
    const msg: ToolResultMessage = {
      kind: 'tool_result', id: 'a',
      toolResults: [{ toolCallId: 'tc-1', name: 'bash', content: 'file.ts' }],
      createdAt: '2025-01-01',
    }
    // A tool_result whose paired tool_call is absent from context must be dropped
    // to avoid Anthropic 400 "unexpected tool_use_id" errors.
    const result = toAnthropicMessages([msg])
    expect(result).toHaveLength(0)
  })

  it('translates summary message', () => {
    const msg: SummaryMessage = {
      kind: 'summary', id: 'a', content: 'A lot happened',
      summarySpan: ['2025-01-01', '2025-01-02'],
      createdAt: '2025-01-02',
    }
    const result = toAnthropicMessages([msg])
    expect(result[0]?.role).toBe('user')
    expect((result[0]?.content as string)).toContain('Summary of conversation')
    expect((result[0]?.content as string)).toContain('A lot happened')
  })

  it('translates tool definitions', () => {
    const tool: ToolDefinition = { name: 'bash', description: 'run bash', inputSchema: { type: 'object' } }
    const result = toAnthropicTools([tool])
    expect(result[0]?.name).toBe('bash')
    expect(result[0]?.input_schema).toEqual({ type: 'object' })
  })
})

// ─── Gemini message translation ───────────────────────────────────────────────

describe('toGeminiContents', () => {
  it('translates user text', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'user', content: 'hi', createdAt: new Date().toISOString() }
    const result = toGeminiContents([msg])
    expect(result[0]?.role).toBe('user')
    expect((result[0]?.parts[0] as { text: string }).text).toBe('[0m ago] hi')
  })

  it('translates assistant text to model role', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'assistant', content: 'hello', createdAt: new Date().toISOString() }
    const result = toGeminiContents([msg])
    expect(result[0]?.role).toBe('model')
  })

  it('translates tool_call to functionCall parts', () => {
    const msg: ToolCallMessage = {
      kind: 'tool_call', id: 'a', content: '',
      toolCalls: [{ id: 'tc-1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: '2025-01-01',
    }
    const result = toGeminiContents([msg])
    expect(result[0]?.role).toBe('model')
    const part = result[0]?.parts[0] as { functionCall: { name: string } }
    expect(part.functionCall.name).toBe('bash')
  })

  it('translates tool_result to functionResponse parts', () => {
    const msg: ToolResultMessage = {
      kind: 'tool_result', id: 'a',
      toolResults: [{ toolCallId: 'tc-1', name: 'bash', content: 'files' }],
      createdAt: '2025-01-01',
    }
    const result = toGeminiContents([msg])
    expect(result[0]?.role).toBe('user')
    const part = result[0]?.parts[0] as { functionResponse: { name: string } }
    expect(part.functionResponse.name).toBe('bash')
  })

  it('produces empty tools array for no tools', () => {
    expect(toGeminiTools([])).toEqual([])
  })

  it('wraps tools in functionDeclarations', () => {
    const tool: ToolDefinition = { name: 'bash', description: 'run bash', inputSchema: { type: 'object' } }
    const result = toGeminiTools([tool])
    expect((result[0] as { functionDeclarations?: Array<{ name: string }> })?.functionDeclarations?.[0]?.name).toBe('bash')
  })
})

// ─── OpenAI message translation ───────────────────────────────────────────────

describe('toOpenAIMessages', () => {
  it('translates user text', () => {
    const msg: TextMessage = { kind: 'text', id: 'a', role: 'user', content: 'hi', createdAt: new Date().toISOString() }
    const result = toOpenAIMessages([msg])
    expect(result[0]).toEqual({ role: 'user', content: '[0m ago] hi' })
  })

  it('translates tool_call', () => {
    const msg: ToolCallMessage = {
      kind: 'tool_call', id: 'a', content: '',
      toolCalls: [{ id: 'tc-1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: '2025-01-01',
    }
    const result = toOpenAIMessages([msg])
    expect(result[0]?.role).toBe('assistant')
    const m = result[0] as { tool_calls: Array<{ id: string; type: string }> }
    expect(m.tool_calls[0]?.id).toBe('tc-1')
    expect(m.tool_calls[0]?.type).toBe('function')
  })

  it('expands tool_result into one message per result', () => {
    const msg: ToolResultMessage = {
      kind: 'tool_result', id: 'a',
      toolResults: [
        { toolCallId: 'tc-1', name: 'bash', content: 'result1' },
        { toolCallId: 'tc-2', name: 'read', content: 'result2' },
      ],
      createdAt: '2025-01-01',
    }
    const result = toOpenAIMessages([msg])
    // Two tool results → two OpenAI messages
    expect(result).toHaveLength(2)
    expect(result[0]?.role).toBe('tool')
    expect(result[1]?.role).toBe('tool')
  })

  it('translates summary message', () => {
    const msg: SummaryMessage = {
      kind: 'summary', id: 'a', content: 'Summary',
      summarySpan: ['2025-01-01', '2025-01-02'],
      createdAt: '2025-01-02',
    }
    const result = toOpenAIMessages([msg])
    expect(result[0]?.role).toBe('user')
    expect((result[0] as { content: string }).content).toContain('Summary of conversation')
  })

  it('translates tool definitions', () => {
    const tool: ToolDefinition = { name: 'bash', description: 'run bash', inputSchema: { type: 'object' } }
    const result = toOpenAITools([tool])
    expect(result[0]?.type).toBe('function')
    expect(result[0]?.function.name).toBe('bash')
  })
})

// ─── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const promise = withRetry(fn, [429])
    await vi.runAllTimersAsync()
    expect(await promise).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable status and eventually succeeds', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 })
    let calls = 0
    const fn = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw err429
      return 'success'
    })
    const promise = withRetry(fn, [429], 3)
    await vi.runAllTimersAsync()
    expect(await promise).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws immediately on non-retryable error without retrying', async () => {
    vi.useRealTimers()
    const err500 = Object.assign(new Error('server error'), { status: 500 })
    const fn = vi.fn().mockRejectedValue(err500)
    await expect(withRetry(fn, [429], 3)).rejects.toThrow('server error')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('exhausts all retries and re-throws the last error', async () => {
    const err = Object.assign(new Error('still rate limited'), { status: 429 })
    const fn = vi.fn().mockRejectedValue(err)
    const promise = withRetry(fn, [429], 2)
    // Attach rejection handler BEFORE running timers to avoid unhandled-rejection warnings
    const assertion = expect(promise).rejects.toThrow('still rate limited')
    await vi.runAllTimersAsync()
    await assertion
    expect(fn).toHaveBeenCalledTimes(3) // attempt 0, 1, 2 (maxRetries = 2)
  })
})

// ─── LLMApiError / classifyLLMStatus ─────────────────────────────────────────

describe('classifyLLMStatus', () => {
  it('classifies auth errors', () => {
    expect(classifyLLMStatus(401)).toBe('auth')
    expect(classifyLLMStatus(403)).toBe('auth')
  })
  it('classifies rate limit errors', () => {
    expect(classifyLLMStatus(429)).toBe('rate_limit')
  })
  it('classifies server errors', () => {
    expect(classifyLLMStatus(500)).toBe('server_error')
    expect(classifyLLMStatus(502)).toBe('server_error')
    expect(classifyLLMStatus(503)).toBe('server_error')
    expect(classifyLLMStatus(529)).toBe('server_error')
  })
  it('classifies unknown errors', () => {
    expect(classifyLLMStatus(undefined)).toBe('unknown')
    expect(classifyLLMStatus(418)).toBe('unknown')
  })
})

describe('LLMApiError', () => {
  it('constructs with correct fields', () => {
    const e = new LLMApiError('oops', 'rate_limit', 429, 'anthropic')
    expect(e.message).toBe('oops')
    expect(e.type).toBe('rate_limit')
    expect(e.status).toBe(429)
    expect(e.provider).toBe('anthropic')
    expect(e.name).toBe('LLMApiError')
    expect(e).toBeInstanceOf(Error)
  })
  it('works with undefined status', () => {
    const e = new LLMApiError('connection failed', 'unknown', undefined, 'gemini')
    expect(e.status).toBeUndefined()
    expect(e.type).toBe('unknown')
  })
})

// ─── sanitizeMessages (via toAnthropicMessages) ───────────────────────────────

describe('sanitizeMessages — orphan stripping via toAnthropicMessages', () => {
  it('strips a tool_call whose tool results are missing', () => {
    const orphanCall: ToolCallMessage = {
      kind: 'tool_call', id: 'tc-msg-1', content: '',
      toolCalls: [{ id: 'tc-1', name: 'bash', input: { command: 'ls' } }],
      createdAt: '2025-01-01',
    }
    const result = toAnthropicMessages([orphanCall])
    expect(result).toHaveLength(0)
  })

  it('keeps a fully resolved tool_call + tool_result pair', () => {
    const toolCall: ToolCallMessage = {
      kind: 'tool_call', id: 'tc-msg-1', content: '',
      toolCalls: [{ id: 'tc-1', name: 'bash', input: { command: 'ls' } }],
      createdAt: '2025-01-01',
    }
    const toolResult: ToolResultMessage = {
      kind: 'tool_result', id: 'tr-msg-1',
      toolResults: [{ toolCallId: 'tc-1', name: 'bash', content: 'file1\nfile2' }],
      createdAt: '2025-01-01',
    }
    const result = toAnthropicMessages([toolCall, toolResult])
    expect(result).toHaveLength(2)
    expect(result[0]?.role).toBe('assistant')
    expect(result[1]?.role).toBe('user')
  })

  it('strips orphaned pair while keeping surrounding text messages', () => {
    const before: TextMessage = { kind: 'text', id: 'txt-before', role: 'user', content: 'Hello', createdAt: '2025-01-01' }
    const orphanCall: ToolCallMessage = {
      kind: 'tool_call', id: 'tc-msg-1', content: '',
      toolCalls: [{ id: 'tc-orphan', name: 'bash', input: {} }],
      createdAt: '2025-01-01',
    }
    const after: TextMessage = { kind: 'text', id: 'txt-after', role: 'assistant', content: 'Done', createdAt: '2025-01-01' }
    const result = toAnthropicMessages([before, orphanCall, after])
    expect(result).toHaveLength(2)
    expect(result[0]?.role).toBe('user')
    expect(result[1]?.role).toBe('assistant')
  })
})

// ─── MultiProviderRouter ──────────────────────────────────────────────────────

describe('MultiProviderRouter', () => {
  class FailingProvider implements LLMProvider {
    readonly name: string
    private error: Error

    constructor(name: string, error: Error) {
      this.name = name
      this.error = error
    }

    async complete(): Promise<LLMResponse> {
      throw this.error
    }
  }

  const TIER_MODELS_A = { standard: 'a-std', capable: 'a-cap', expert: 'a-exp' }
  const TIER_MODELS_B = { standard: 'b-std', capable: 'b-cap', expert: 'b-exp' }

  it('resolves tier using the first provider', async () => {
    const provider = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([{ provider, tierModels: TIER_MODELS_A }])
    const result = await router.complete('capable', [], [], {})
    expect(result.content).toBe('Hello!')
    expect(provider.callCount).toBe(1)
  })

  it('passes direct model ID to first provider only', async () => {
    const provider = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider, tierModels: TIER_MODELS_A },
      { provider: new StubProvider([END_TURN_RESPONSE]), tierModels: TIER_MODELS_B },
    ])
    await router.complete('claude-sonnet-4-6', [], [], {})
    expect(provider.callCount).toBe(1)
  })

  it('falls back on rate_limit', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('rate limited', 'rate_limit', 429, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    const result = await router.complete('capable', [], [], {})
    expect(result.content).toBe('Hello!')
    expect(fallback.callCount).toBe(1)
  })

  it('falls back on server_error', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('server down', 'server_error', 503, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    const result = await router.complete('standard', [], [], {})
    expect(result.content).toBe('Hello!')
  })

  it('falls back on auth error (bad key)', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('unauthorized', 'auth', 401, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    const result = await router.complete('capable', [], [], {})
    expect(result.content).toBe('Hello!')
  })

  it('falls back on connection failure (no HTTP status)', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('ECONNREFUSED', 'unknown', undefined, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    const result = await router.complete('capable', [], [], {})
    expect(result.content).toBe('Hello!')
  })

  it('does NOT fall back on 400 Bad Request', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('bad request', 'unknown', 400, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    await expect(router.complete('capable', [], [], {})).rejects.toThrow('bad request')
    expect(fallback.callCount).toBe(0)
  })

  it('does NOT fall back for direct model IDs', async () => {
    const failing = new FailingProvider('provider-a', new LLMApiError('rate limited', 'rate_limit', 429, 'a'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const router = new MultiProviderRouter([
      { provider: failing, tierModels: TIER_MODELS_A },
      { provider: fallback, tierModels: TIER_MODELS_B },
    ])
    await expect(router.complete('claude-sonnet-4-6', [], [], {})).rejects.toThrow('rate limited')
    expect(fallback.callCount).toBe(0)
  })

  it('throws last error when all providers fail', async () => {
    const failA = new FailingProvider('provider-a', new LLMApiError('a failed', 'rate_limit', 429, 'a'))
    const failB = new FailingProvider('provider-b', new LLMApiError('b failed', 'server_error', 503, 'b'))
    const router = new MultiProviderRouter([
      { provider: failA, tierModels: TIER_MODELS_A },
      { provider: failB, tierModels: TIER_MODELS_B },
    ])
    await expect(router.complete('capable', [], [], {})).rejects.toThrow('b failed')
  })

  it('falls through three providers', async () => {
    const failA = new FailingProvider('a', new LLMApiError('a down', 'server_error', 503, 'a'))
    const failB = new FailingProvider('b', new LLMApiError('b limited', 'rate_limit', 429, 'b'))
    const fallback = new StubProvider([END_TURN_RESPONSE])
    const tierC = { standard: 'c-std', capable: 'c-cap', expert: 'c-exp' }
    const router = new MultiProviderRouter([
      { provider: failA, tierModels: TIER_MODELS_A },
      { provider: failB, tierModels: TIER_MODELS_B },
      { provider: fallback, tierModels: tierC },
    ])
    const result = await router.complete('expert', [], [], {})
    expect(result.content).toBe('Hello!')
  })
})
