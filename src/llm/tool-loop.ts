import type { Message, ToolCall, ToolResult } from '../types/core.js'
import type { LLMRouter, LLMResponse, ToolDefinition } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'
import type { UsageEntry } from '../db/usage.js'
import { estimateCost } from './pricing.js'
import { generateId, now } from './util.js'
import { trace } from '../tracer.js'
import { log } from '../logger.js'
import { timingMark } from '../timing.js'

// ─── Channel-verbose description helper ──────────────────────────────────────

/** Sanitize a tool_call input.description field for emission in the channel
 *  verbose stream. Returns null when the description is absent/invalid and the
 *  caller should fall back to today's byte-identical `→ name\n{json}` form.
 *
 *  Sanitization order (matters — do not reorder):
 *    1. typeof check: non-string → null
 *    2. trim outer whitespace
 *    3. collapse any run of interior whitespace (newlines, tabs, CRs,
 *       multiple spaces) to a single space — the verbose stream emits
 *       `→ name (desc)\n{json}` as a single-line header, and an interior
 *       newline would break the header/body boundary
 *    4. replace backticks with single-quotes (prevents inline-code
 *       rendering artifacts when the verbose stream is rendered in the
 *       dashboard)
 *    5. empty check after trim+collapse+replace → null
 *    6. truncate to 200 chars (slice(0, 197) + '…') */
export function descriptionForChannel(input: Record<string, unknown>): string | null {
  const d = input['description']
  if (typeof d !== 'string') return null
  const trimmed = d.trim().replace(/\s+/g, ' ').replace(/`/g, "'")
  if (trimmed === '') return null
  return trimmed.length > 200 ? trimmed.slice(0, 197) + '…' : trimmed
}

// ─── Loop detection error ─────────────────────────────────────────────────────

export class LoopDetectedError extends Error {
  constructor(public readonly reason: string) {
    super(`runToolLoop: loop detected — ${reason}`)
    this.name = 'LoopDetectedError'
  }
}

// ─── Agent aborted error ──────────────────────────────────────────────────────

/** Thrown by runToolLoop when its abortSignal flips to aborted between rounds.
 *  The LocalAgentRunner's existing pending-retract inbox check turns this into
 *  a `retracted` status generically — callers don't need to introspect. */
export class AgentAbortedError extends Error {
  constructor() {
    super('runToolLoop: aborted')
    this.name = 'AgentAbortedError'
  }
}

// ─── Tool executor interface ──────────────────────────────────────────────────

export interface ToolExecutor {
  execute(toolCall: ToolCall): Promise<ToolResult>
}

// ─── Tool loop options ────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  model: string
  tools: ToolDefinition[]
  systemPrompt: string
  history: Message[]
  executor: ToolExecutor
  usage: UsageStore
  sourceType: UsageEntry['sourceType']
  sourceId: string | null
  /** Attribution: denormalized onto usage rows so scheduled-task spend self-describes
   *  without needing the agents JOIN (see sql/026_usage_attribution.sql). */
  trigger?: 'scheduled' | 'manual' | 'ad_hoc'
  targetName?: string
  maxRounds?: number             // default: unlimited (loop steward is the stop mechanism)
  stewardModel?: string            // model for the loop steward (defaults to 'standard')

  /** If any of these tool names are called, exit the loop immediately after
   *  appending tool results — no follow-up LLM call. The tool's response content
   *  (e.g. "On it.") is returned as the final response. */
  terminalTools?: string[]

  /** Called after each round to get a fresh history slice.
   *  Head: DB read combining activation window + prior context.
   *  Worker: returns its local array (no DB read needed). */
  refreshHistory: () => Message[]

  /** Persist a new message to the caller's store (DB or local array).
   *  The tool loop generates id and createdAt before calling.
   *  When isFinal is true, this is the last assistant message (end_turn). */
  appendMessage: (msg: Message, opts?: { isFinal?: boolean }) => Promise<void>

  /** If set, called with debug-formatted strings for each LLM turn, tool call, and result.
   *  Only wired up when the channel has debug mode enabled. */
  onDebug?: (msg: string) => Promise<void>

  /** Like onDebug but user-facing: shows thinking + tool calls as one entity,
   *  hides spawn_agent calls/results, no agent prefixes. */
  onVerbose?: (msg: string) => Promise<void>

  /** Loop detection: rounds with identical tool+args before LLM steward fires. Default: 3. */
  loopSameArgsTrigger?: number
  /** Loop detection: consecutive errors from same tool before LLM steward fires. Default: 2. */
  loopErrorTrigger?: number
  /** Loop detection: errors after a nudge before aborting. Default: 1. */
  loopPostNudgeErrorTrigger?: number
  /** Loop steward: max chars per tool input. Default: 200. */
  loopStewardToolInputChars?: number
  /** Loop steward: max chars per tool result. Default: 300. */
  loopStewardToolResultChars?: number
  /** Loop steward: max chars of system prompt. Default: 500. */
  loopStewardSystemPromptChars?: number
  /** Loop steward: max output tokens. Default: 128. */
  loopStewardMaxTokens?: number

  /** When present and aborted, the loop exits between rounds (before the next llm.complete
   *  and before tool execution) by throwing AgentAbortedError. In-flight tool calls are
   *  separately aborted via ctx.abortSignal on the executor side. */
  abortSignal?: AbortSignal

  /** Called between rounds, after tool results are appended and after loop detection runs,
   *  before the terminal-tools exit check and before the next llmRouter.complete call.
   *  The callback receives no arguments — it closes over the caller's `history` array
   *  (passed in via ToolLoopOptions.history) and may mutate it directly to inject
   *  user-role messages mid-loop.
   *
   *  Return `true` to abort the loop immediately — runToolLoop throws AgentAbortedError,
   *  the same error class as the abortSignal path. Return `false` to continue normally.
   *  Head activation callers (src/head/activation.ts) leave this undefined and behavior
   *  is byte-equivalent to today. */
  onRoundComplete?: () => Promise<boolean>
}

// ─── responseToMessage ────────────────────────────────────────────────────────

/** Strip timestamp prefixes that the model may echo from context (e.g. "[0m ago] ", "[3h ago] ", "[Apr 3, 2:15 PM] "). */
export function stripTimestampEcho(text: string): string {
  return text.replace(/^\[\d+[mhd] ago\] /, '').replace(/^\[\w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M\] /, '')
}

/** Convert an LLM response to one or two messages.
 *  When the response has both text and tool calls, split into a text message
 *  followed by a tool_call message with empty content. This keeps tool_call
 *  messages as pure tool invocations — intermediate text stored separately
 *  can't break tool_call → tool_result adjacency. */
function responseToMessages(id: string, resp: LLMResponse): Message[] {
  const content = stripTimestampEcho(resp.content.replaceAll(' — ', '- ').replaceAll('—', '- '))
  if (resp.toolCalls && resp.toolCalls.length > 0) {
    const messages: Message[] = []
    // Split: text goes as a separate assistant message if non-empty
    if (content.trim()) {
      messages.push({ kind: 'text', role: 'assistant', id: generateId('msg'), content, createdAt: now() })
    }
    // Tool calls get their own message with empty content
    messages.push({
      kind: 'tool_call', id, content: '',
      toolCalls: resp.toolCalls as [ToolCall, ...ToolCall[]],
      createdAt: now(),
    })
    return messages
  }
  return [{ kind: 'text', role: 'assistant', id, content, createdAt: now() }]
}

// ─── Loop detection helpers ───────────────────────────────────────────────────

function isErrorResult(content: string): boolean {
  try { return (JSON.parse(content) as { error?: boolean })?.error === true }
  catch { return content.startsWith('Error:') }
}

async function callLoopSteward(
  llmRouter: LLMRouter,
  model: string,
  systemPrompt: string,
  history: Message[],
  limits: { toolInputChars: number; toolResultChars: number; systemPromptChars: number; maxTokens: number },
): Promise<{ abort: boolean; reason: string }> {
  const recentHistory = history.slice(-8).map(m => {
    if (m.kind === 'tool_call')
      return `[calls] ${m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input).slice(0, limits.toolInputChars)})`).join(', ')}`
    if (m.kind === 'tool_result')
      return `[results] ${m.toolResults.map(tr => `${tr.name}: ${tr.content.slice(0, limits.toolResultChars)}`).join(' | ')}`
    return null
  }).filter(Boolean).join('\n')

  const prompt = `An AI agent may be stuck in a loop. Analyze its recent behavior and decide whether to abort or let it continue.

Agent task (truncated):
${systemPrompt.slice(0, limits.systemPromptChars)}

Recent tool call/result history:
${recentHistory}

Respond with JSON only: {"verdict": "abort" or "continue", "reason": "one sentence"}
- "abort": agent is repeating identical calls with no sign of progress or adaptation
- "continue": agent is making genuine progress, exploring alternatives, or repetition is justified`

  const response = await llmRouter.complete(
    model,
    [{ kind: 'text', role: 'user', id: 'loop-steward', content: prompt, createdAt: new Date().toISOString() }],
    [],
    { maxTokens: limits.maxTokens, jsonSchema: { name: 'loop_steward', schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['abort', 'continue'] }, reason: { type: 'string' } }, required: ['verdict', 'reason'], additionalProperties: false } } },
  )
  const match = response.content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('loop steward returned unparseable response')
  const parsed = JSON.parse(match[0]) as { verdict: string; reason: string }
  return { abort: parsed.verdict === 'abort', reason: parsed.reason ?? '' }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runToolLoop(
  llmRouter: LLMRouter,
  options: ToolLoopOptions
): Promise<LLMResponse> {
  const maxRounds = options.maxRounds ?? Infinity
  if (maxRounds < 1) throw new Error(`runToolLoop: maxRounds must be >= 1, got ${maxRounds}`)
  let history = options.history
  let rounds = 0
  const tctx = { sourceType: options.sourceType, sourceId: options.sourceId ?? '-' }

  const SAME_ARGS_TRIGGER = options.loopSameArgsTrigger ?? 3
  const ERROR_TRIGGER = options.loopErrorTrigger ?? 2
  const POST_NUDGE_ERROR_TRIGGER = options.loopPostNudgeErrorTrigger ?? 1
  const recentFingerprints: Set<string>[] = []  // sliding window, newest-first
  const consecutiveErrors = new Map<string, number>()
  let nudgeSent = false

  const t = trace.begin(
    options.sourceType,
    options.sourceId ?? 'unknown',
    options.model,
    options.systemPrompt,
    history,
    options.tools.map(t => t.name),
  )

  while (rounds < maxRounds) {
    // Step 1: check for abort before starting a new round (between-rounds exit).
    // In-flight tool abortion is handled by options.abortSignal flowing into the executor.
    if (options.abortSignal?.aborted) throw new AgentAbortedError()

    // Step 2: call the model
    timingMark('llm.call_start', { ...tctx, round: rounds + 1, model: options.model })
    const response = await llmRouter.complete(
      options.model,
      history,
      options.tools,
      {
        systemPrompt: options.systemPrompt,
      }
    )
    timingMark('llm.call_end', {
      ...tctx,
      round: rounds + 1,
      model: response.model,
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
    })
    // Step 3: record usage
    options.usage.record({
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: estimateCost(
        response.model, response.inputTokens, response.outputTokens,
        response.cacheReadInputTokens, response.cacheCreationInputTokens,
      ),
      cacheReadTokens: response.cacheReadInputTokens ?? 0,
      cacheWriteTokens: response.cacheCreationInputTokens ?? 0,
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(options.targetName ? { targetName: options.targetName } : {}),
    })

    t.llmResponse(rounds + 1, response)

    // Step 4: append assistant turn (may be split into text + tool_call)
    const isFinal = !response.toolCalls || response.toolCalls.length === 0
    const assistantMsgs = responseToMessages(generateId('msg'), response)
    for (const msg of assistantMsgs) await options.appendMessage(msg, { isFinal })

    // Step 5: if no tool calls, we're done
    if (isFinal) {
      t.end(rounds + 1, response)
      return response
    }

    // Debug: intermediate thinking text (has content but isn't the final response)
    if (options.onDebug && response.content.trim()) {
      await options.onDebug(`\`\`\`\n[thinking]\n${response.content}\n\`\`\``)
    }
    if (options.onVerbose && response.content.trim()) {
      await options.onVerbose(response.content)
    }

    // Debug: outgoing tool calls
    if (options.onDebug) {
      for (const tc of response.toolCalls!) {
        const inputStr = JSON.stringify(tc.input, null, 2)
        const preview = inputStr.length > 800 ? inputStr.slice(0, 797) + '…' : inputStr
        await options.onDebug(`\`\`\`\n→ ${tc.name}\n${preview}\n\`\`\``)
      }
    }
    if (options.onVerbose) {
      const AGENT_TOOLS = new Set(['spawn_agent', 'message_agent', 'cancel_agent'])
      for (const tc of response.toolCalls!) {
        if (AGENT_TOOLS.has(tc.name)) continue
        const inputStr = JSON.stringify(tc.input, null, 2)
        const preview = inputStr.length > 800 ? inputStr.slice(0, 797) + '…' : inputStr
        const desc = descriptionForChannel(tc.input)
        if (desc !== null) {
          await options.onVerbose(`→ ${tc.name} (${desc})\n${preview}`)
        } else {
          await options.onVerbose(`→ ${tc.name}\n${preview}`)
        }
      }
    }

    // Step 6: execute each tool call with per-call error handling
    const toolResults: ToolResult[] = await Promise.all(
      response.toolCalls!.map(async (tc: ToolCall) => {
        try {
          timingMark('tool.exec_start', { ...tctx, round: rounds + 1, tool_name: tc.name })
          const result = await options.executor.execute(tc)
          timingMark('tool.exec_end', { ...tctx, round: rounds + 1, tool_name: tc.name })
          t.toolResult(tc, result)
          return result
        } catch (err) {
          timingMark('tool.exec_end', { ...tctx, round: rounds + 1, tool_name: tc.name, error: true })
          const message = err instanceof Error ? err.message : 'unknown error'
          const result = {
            toolCallId: tc.id,
            name: tc.name,
            content: JSON.stringify({ error: true, message }),
          }
          t.toolResult(tc, result)
          return result
        }
      })
    )

    // Post-tool-exec abort check: if a long-running tool returned (possibly because
    // SIGTERM fired via ctx.abortSignal), don't persist results or continue into
    // another LLM round — bail out immediately so the retract reconciliation path
    // turns this into a clean `retracted` status instead of `failed`.
    if (options.abortSignal?.aborted) throw new AgentAbortedError()

    // Debug: tool results
    if (options.onDebug) {
      for (const result of toolResults) {
        const preview = result.content.length > 800 ? result.content.slice(0, 797) + '…' : result.content
        await options.onDebug(`\`\`\`\n← ${result.name}\n${preview}\n\`\`\``)
      }
    }
    if (options.onVerbose) {
      const AGENT_TOOLS = new Set(['spawn_agent', 'message_agent', 'cancel_agent'])
      for (const result of toolResults) {
        if (AGENT_TOOLS.has(result.name)) continue
        const preview = result.content.length > 800 ? result.content.slice(0, 797) + '…' : result.content
        await options.onVerbose(`← ${result.name}\n${preview}`)
      }
    }

    // Step 7: append tool results turn
    const resultsMsg: Message = {
      kind: 'tool_result',
      id: generateId('msg'),
      toolResults: toolResults as [ToolResult, ...ToolResult[]],
      createdAt: now(),
    }
    await options.appendMessage(resultsMsg)

    // ── Loop detection ─────────────────────────────────────────────────────────
    const roundFps = new Set(response.toolCalls!.map(tc => `${tc.name}\0${JSON.stringify(tc.input)}`))
    recentFingerprints.unshift(roundFps)
    if (recentFingerprints.length > SAME_ARGS_TRIGGER) recentFingerprints.pop()

    let loopSuspected = false

    // Trigger A: same tool+args in every round of the window
    if (recentFingerprints.length === SAME_ARGS_TRIGGER) {
      for (const fp of recentFingerprints[0]!) {
        if (recentFingerprints.every(r => r.has(fp))) { loopSuspected = true; break }
      }
    }

    // Trigger B: same tool erroring consecutively
    for (const result of toolResults) {
      if (isErrorResult(result.content)) {
        const n = (consecutiveErrors.get(result.name) ?? 0) + 1
        consecutiveErrors.set(result.name, n)
        const trigger = nudgeSent ? POST_NUDGE_ERROR_TRIGGER : ERROR_TRIGGER
        if (n >= trigger) loopSuspected = true
      } else {
        consecutiveErrors.delete(result.name)
      }
    }

    if (loopSuspected) {
      const verdict = await callLoopSteward(llmRouter, options.stewardModel ?? 'standard', options.systemPrompt, history, {
          toolInputChars: options.loopStewardToolInputChars ?? 200,
          toolResultChars: options.loopStewardToolResultChars ?? 300,
          systemPromptChars: options.loopStewardSystemPromptChars ?? 500,
          maxTokens: options.loopStewardMaxTokens ?? 128,
        })
        .catch((err: unknown) => { throw new LoopDetectedError(`loop steward failed: ${(err as Error).message}`) })
      if (verdict.abort) {
        if (nudgeSent) {
          // Already nudged — abort for real
          throw new LoopDetectedError(verdict.reason)
        }
        // First abort verdict — inject a corrective nudge and let the agent try again
        const nudgeContent = `[Note: ${verdict.reason}. Please try a different approach rather than repeating the same steps.]`
        await options.appendMessage({ kind: 'text', role: 'user', id: generateId('msg'), content: nudgeContent, createdAt: now() })
        nudgeSent = true
        // Reset counters so the agent gets a fresh window after the nudge
        recentFingerprints.length = 0
        consecutiveErrors.clear()
        log.info(`[tool-loop] loop steward: nudge sent — ${verdict.reason}`)
        if (options.onDebug) await options.onDebug(`[loop-steward] nudge: ${verdict.reason}`)
      } else {
        log.info(`[tool-loop] loop steward: continue — ${verdict.reason}`)
        if (options.onDebug) await options.onDebug(`[loop-steward] continue: ${verdict.reason}`)
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Mid-loop callback (Plan 24-01) ────────────────────────────────────────
    // Fired after tool results are in history and after loop detection. The
    // callback may mutate `history` directly (it closes over the same array
    // refreshHistory returns). Returning true throws AgentAbortedError — same
    // error class as the abortSignal path, handled identically by callers.
    if (options.onRoundComplete) {
      const shouldAbort = await options.onRoundComplete()
      if (shouldAbort) throw new AgentAbortedError()
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Step 7b: if a terminal tool was called, stop here — no follow-up LLM call
    if (options.terminalTools?.some(name => response.toolCalls!.some((tc: ToolCall) => tc.name === name))) {
      const terminalResponse = { ...response, toolCalls: [] as ToolCall[], stopReason: 'end_turn' as const }
      t.end(rounds + 1, terminalResponse)
      return terminalResponse
    }

    // Step 8: refresh history
    history = options.refreshHistory()

    rounds++
  }

  t.end(rounds, { content: '', inputTokens: 0, outputTokens: 0, stopReason: 'max_tokens', model: 'unknown' })
  throw new Error(`runToolLoop: reached maxRounds (${maxRounds}) without end_turn — possible tool loop`)
}
