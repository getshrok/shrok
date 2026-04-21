import type { QueueEvent, Message } from '../types/core.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import { generateId, now } from '../llm/util.js'
import type { TextMessage, AgentWork } from '../types/core.js'
import { adjustToolMessages } from '../sub-agents/context.js'
import { systemTrigger, systemEvent, agentResult, priorTool, priorResult, _descriptionForMarker } from '../markers.js'

/** Extract an agent's own work messages from its history (excludes head-prepended
 *  context and the final response). Shared between injector and activation. */
export function extractAgentOwnWork(agent: { history?: Message[]; workStart?: number }): Message[] {
  if (!agent.history?.length || agent.workStart == null) return []
  return agent.history.slice(agent.workStart, -1)
}

// ─── Work summary input caps ─────────────────────────────────────────────────
// Defaults protect the steward from pathologically large agent histories
// (a single ~30KB read_file tool_result, or 30+ bash dumps). Per-entry caps
// keep each line digestible; the total cap keeps the whole prompt bounded.
const DEFAULT_TOOL_RESULT_CAP = 1024
const DEFAULT_TOOL_CALL_INPUT_CAP = 512
const DEFAULT_TEXT_CAP = 1024
const DEFAULT_TOTAL_CAP = 16_384  // ≈ 4K tokens

export interface WorkSummaryCaps {
  toolResultChars?: number
  toolCallInputChars?: number
  textChars?: number
  totalChars?: number
}

function clip(s: string, cap: number): string {
  if (s.length <= cap) return s
  return s.slice(0, cap) + `…[+${s.length - cap} chars elided]`
}

// Detect tool results that represent failures (non-zero exit, explicit error
// JSON, stderr with body, thrown exceptions, timeouts). Intentionally
// conservative — preserving a noisy success costs context budget, but
// evicting a real failure destroys the exact signal the summary steward
// needs most. See .planning comment / commit for rationale.
const FAILURE_PATTERNS = [
  /^\s*\{\s*"error"\s*:/,                    // {"error": "..."} blobs
  /\bexit code:\s*[1-9]/i,                   // shell non-zero
  /\bstderr:\s*\S/i,                         // stderr with body
  /^error:\s/im,                             // "Error: ..." lines
  /\btimed?\s*out\b/i,                       // timed out / timeout
  /\bstack trace\b/i,                        // stack traces
  /\bTraceback \(most recent/,               // python
  /at [^\s]+ \(.+?:\d+:\d+\)/,               // JS stack frame
]

function looksLikeFailure(content: string): boolean {
  for (const re of FAILURE_PATTERNS) {
    if (re.test(content)) return true
  }
  return false
}

type Entry = { text: string; failure: boolean }

/** Format agent work messages as plain text for the work summary steward.
 *  Input should be pre-adjustToolMessages.
 *  Per-entry and total-size caps protect the steward from pathological
 *  histories (huge file reads, bash dumps). When the total cap trips,
 *  non-failure entries are evicted first (newest-wins within that bucket)
 *  so the steward can still narrate the bug/fallback even if a verbose
 *  success would have crowded it out under pure newest-wins eviction. */
export function formatWorkForSummary(messages: Message[], caps: WorkSummaryCaps = {}): string {
  const trCap = caps.toolResultChars ?? DEFAULT_TOOL_RESULT_CAP
  const tcCap = caps.toolCallInputChars ?? DEFAULT_TOOL_CALL_INPUT_CAP
  const txCap = caps.textChars ?? DEFAULT_TEXT_CAP
  const totalCap = caps.totalChars ?? DEFAULT_TOTAL_CAP

  const entries: Entry[] = []
  for (const m of messages) {
    if (m.kind === 'text') {
      if (m.content) entries.push({ text: `[text] ${clip(m.content, txCap)}`, failure: false })
    } else if (m.kind === 'tool_call') {
      for (const tc of m.toolCalls) {
        entries.push({ text: `[tool_call] ${tc.name}: ${clip(JSON.stringify(tc.input), tcCap)}`, failure: false })
      }
    } else if (m.kind === 'tool_result') {
      for (const tr of m.toolResults) {
        const failure = looksLikeFailure(tr.content)
        entries.push({ text: `[tool_result] ${tr.name}: ${clip(tr.content, trCap)}`, failure })
      }
    }
  }

  // Check whether we're under budget already.
  const totalLen = entries.reduce((n, e) => n + e.text.length + 1, 0)
  if (totalLen <= totalCap) return entries.map(e => e.text).join('\n')

  // Over budget — two-pass eviction. First mark which indices we're keeping
  // by walking backwards and budgeting, skipping non-failures if we need to.
  // Failures always get kept unless the failure total alone exceeds the cap
  // (in which case we keep the newest failures that fit).
  const keep = new Array<boolean>(entries.length).fill(false)
  let budget = totalCap
  // Pass 1: keep failures newest-first.
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i]!.failure) continue
    const cost = entries[i]!.text.length + 1
    if (cost > budget) continue  // skip failures that don't fit; don't stop
    keep[i] = true
    budget -= cost
  }
  // Pass 2: fill remaining budget with successes, newest-first.
  for (let i = entries.length - 1; i >= 0; i--) {
    if (keep[i] || entries[i]!.failure) continue
    const cost = entries[i]!.text.length + 1
    if (cost > budget) break  // newest-first → once one doesn't fit, stop
    keep[i] = true
    budget -= cost
  }

  const kept: string[] = []
  let elided = 0
  let keptFailure = false
  let elidedSuccess = false
  for (let i = 0; i < entries.length; i++) {
    if (keep[i]) {
      kept.push(entries[i]!.text)
      if (entries[i]!.failure) keptFailure = true
    } else {
      elided++
      if (!entries[i]!.failure) elidedSuccess = true
    }
  }
  if (elided === 0) return kept.join('\n')
  const preservedNote = keptFailure && elidedSuccess ? ', failures preserved' : ''
  return `[… ${elided} earlier entries elided${preservedNote}]\n` + kept.join('\n')
}

export interface Injector {
  injectAgentEvent(event: QueueEvent & { type: 'agent_completed' | 'agent_question' | 'agent_failed' | 'agent_response' }, workSummaryOverride?: string): void
  injectWebhookEvent(event: QueueEvent & { type: 'webhook' }): void
}

export class InjectorImpl implements Injector {
  constructor(
    private messages: MessageStore,
    private agentStore?: AgentStore,
    private headToolNames: Set<string> = new Set(),
    private agentContinuationEnabled: boolean = false,
  ) {}

  injectAgentEvent(event: QueueEvent & { type: 'agent_completed' | 'agent_question' | 'agent_failed' | 'agent_response' }, workSummaryOverride?: string): void {
    // Extract the agent's own work messages (raw, canonical) for both the head-formatted
    // transcript and consumer-adaptive rendering via agentWork.
    let ownWork: Message[] = []
    if (this.agentStore) {
      const agent = this.agentStore.get(event.agentId)
      if (agent) ownWork = extractAgentOwnWork(agent)
    }

    // Build the head-formatted transcript for the content field.
    // When an override is provided (append-only path: work-summary steward ran pre-injection),
    // skip the raw render loop entirely and use the override directly.
    let workSection = ''
    if (event.type === 'agent_completed' && workSummaryOverride !== undefined) {
      workSection = '\n\n' + workSummaryOverride
    } else if (ownWork.length > 0) {
      const adjusted = adjustToolMessages(ownWork, this.headToolNames)
      const lines: string[] = []
      for (const m of adjusted) {
        if (m.kind === 'text') {
          if (m.content) lines.push(m.content)
        } else if (m.kind === 'tool_call') {
          if (m.content) lines.push(m.content)
          for (const tc of m.toolCalls) {
            const intent = _descriptionForMarker(tc.input)
            lines.push(priorTool({
              name: tc.name,
              input: JSON.stringify(tc.input),
              ...(intent !== null ? { intent } : {}),
            }))
          }
        } else if (m.kind === 'tool_result') {
          for (const tr of m.toolResults) {
            lines.push(priorResult(tr.name, tr.content))
          }
        }
      }
      if (lines.length > 0) workSection = '\n\n' + lines.join('\n')
    }

    // Attach structured agentWork for consumer-adaptive rendering.
    const agentWork: AgentWork | undefined = ownWork.length > 0
      ? {
          agentId: event.agentId,
          task: this.agentStore?.get(event.agentId)?.task ?? '',
          work: ownWork,  // raw Message[] — adjustToolMessages applied per-consumer
          output: event.type === 'agent_completed' ? event.output
                : event.type === 'agent_question'  ? event.question
                : event.type === 'agent_failed'    ? event.error
                : event.response,
        }
      : undefined

    // Agent responses (mid-task): lightweight injection — just the response text.
    // No work summary or agent-result dump; the agent is still running.
    if (event.type === 'agent_response') {
      this.messages.append({
        kind: 'text',
        id: generateId('msg'),
        createdAt: now(),
        role: 'user',
        content: systemTrigger('agent-response', { agent: event.agentId }, event.response),
        injected: true,
      } as TextMessage)
      return
    }

    // Agent questions (paused): only inject the trigger with the question text.
    // Agent paused with a question — relay its full response so the head can
    // pass along URLs, instructions, etc. that the agent included.
    if (event.type === 'agent_question') {
      this.messages.append({
        kind: 'text',
        id: generateId('msg'),
        createdAt: now(),
        role: 'user',
        content: systemTrigger('agent-paused', { agent: event.agentId }, `An agent paused and needs your help to continue:\n\n${event.question}\n\nRelay this to the user in your own words. When they reply, use message_agent to pass their response and resume the agent.`),
        injected: true,
      } as TextMessage)
      return
    }

    // Completed and failed: inject agent-result + trigger
    let newContent: string
    let triggerText: string
    if (event.type === 'agent_completed') {
      newContent = agentResult('completed', event.agentId, workSection, event.output)
      if (this.agentContinuationEnabled) {
        newContent += '\nTo continue this agent\'s work, use message_agent with its ID and new instructions.'
      }
      triggerText = systemTrigger('agent-completed', { agent: event.agentId })
    } else {
      newContent = agentResult('failed', event.agentId, workSection, event.error)
      triggerText = systemTrigger('agent-failed', { agent: event.agentId })
    }

    // Forward inject: single user-role message with agent result.
    // Using user-role prevents the head from seeing the XML tags as its own
    // prior output (which causes tag hallucination). The agent-result content
    // in a user message is enough to prompt the head to respond — no separate
    // trigger message needed.
    const resultMsg: TextMessage = {
      kind: 'text',
      id: generateId('msg'),
      createdAt: now(),
      role: 'user',
      content: newContent,
      ...(agentWork ? { agentWork } : {}),
      injected: true,
    }
    this.messages.append(resultMsg)
  }


  injectWebhookEvent(event: QueueEvent & { type: 'webhook' }): void {
    const payloadBody = event.payload ? (typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload)) : undefined
    const eventContent = systemEvent('webhook', { source: event.source ?? '', event: event.event ?? '' }, payloadBody)

    const eventMsg: TextMessage = {
      kind: 'text',
      id: generateId('msg'),
      createdAt: now(),
      role: 'assistant',
      content: eventContent,
      injected: true,
    }

    const triggerMsg: TextMessage = {
      kind: 'text',
      id: generateId('msg'),
      createdAt: now(),
      role: 'user',
      content: systemTrigger('respond'),
      injected: true,
    }

    this.messages.append(eventMsg)
    this.messages.append(triggerMsg)
  }
}
