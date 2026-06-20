import type { Message, ToolResult } from './core.js'
import type { ToolDefinition } from './llm.js'

// ─── Tool surface ─────────────────────────────────────────────────────────────

/** Runtime context passed to every tool executor inside an agent. */
export interface AgentContext {
  agentId: string
  /** Phase 45 — required; used by ring_device to resolve HA channel */
  headId: string
  /** IANA timezone for model-facing output rendering (e.g. get_file_info time fields).
   *  Falls back to 'UTC' when absent. Optional so existing test fixtures remain valid. */
  timezone?: string
  /** Suspend the agent — tool executor should return after calling this. */
  suspend(): void
  /** Terminate the agent with a result. */
  complete(output: string): void
  /** Fail the agent with an error message. */
  fail(error: string): void
  /** When present and aborted, in-flight tool executors (bash, etc.) should cancel ASAP.
   *  Wired by LocalAgentRunner; undefined in environments that don't build one
   *  (unit tests passing plain ctx objects remain valid). */
  abortSignal?: AbortSignal
}

export interface AgentToolEntry {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: AgentContext) => Promise<string | ToolResult>
}

export interface AgentToolRegistry {
  builtins(): AgentToolEntry[]
  resolveOptional(toolNames: string[], cap?: number): AgentToolEntry[]
}

// ─── Status ───────────────────────────────────────────────────────────────────

export type AgentStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'retracted'

// ─── State ────────────────────────────────────────────────────────────────────

export interface AgentState {
  id: string
  skillName?: string
  status: AgentStatus
  model: string
  task: string
  trigger: 'manual' | 'scheduled' | 'ad_hoc' | 'sensor'
  /** Head this agent belongs to (Phase 34). Carried through the agents.head_id column. */
  headId: string
  /** Additional heads to deliver task completion to (Phase 44). Only populated on top-level
   *  scheduled agents. Empty array = owner-only (today's single-head behavior). */
  deliverToHeadIds: string[]
  /** Optional per-schedule operator guidance for the relay steward (set on the schedule,
   *  persisted here at spawn). Injected into the relay prompt at completion to bias the
   *  surface-vs-suppress decision for this scheduled task. Absent = no extra guidance. */
  relayGuidance?: string
  workStart: number              // index into history[] where agent's own work begins (after prepended head history)
  history: Message[]             // full message history; populated when suspended/completed
  pendingQuestion?: string
  statusText?: string
  output?: string
  error?: string
  parentAgentId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  colorSlot?: number              // 0–6 slot index; omitted when DB value is NULL (D-05)
}

/** A "background" trigger spawns a head-less agent with no human attached: scheduled tasks
 *  (Phase 44) and sensor sub-agent dispatches (Phase 52). Both must be treated identically at
 *  every "is this a background agent?" decision site: gated by the relay/output steward at
 *  completion (no head chatter — Phase 52 D-09), force-completed instead of suspended on
 *  ask_user (no human to answer — D-06), and attributed per-target in usage (D-08). New
 *  head-less triggers join here so a site can't silently miss one. Accepts a plain string so
 *  callers holding a widened/coalesced trigger (e.g. usage rows that may be 'unknown') can use it. */
export function isBackgroundTrigger(trigger: string | undefined): trigger is 'scheduled' | 'sensor' {
  return trigger === 'scheduled' || trigger === 'sensor'
}

// ─── Spawn options ────────────────────────────────────────────────────────────

export interface SpawnOptions {
  agentId?: string               // pre-assigned ID; generated internally if omitted
  name?: string                  // human-readable label, used as slug prefix when agentId not pre-set
  /** The ask — what the agent must accomplish, in the user's own words where possible.
   *  Stored as AgentState.task and used for summaries/classification. */
  task: string
  /** Verbatim conversation excerpts the head pastes through (constraints, prior turns,
   *  referenced details). Folded into the agent's first message after `task`. Not stored
   *  as the task, so summaries/history-classification stay clean. */
  context?: string
  model?: string                 // tier name or direct model ID; defaults to 'smart'
  trigger: AgentState['trigger']
  /** Required: head this agent belongs to. Determines which head's activation loop
   *  claims the agent's completion / question / response queue events. Phase 34 D-SPAWN-REQUIRED:
   *  no silent 'default' fallback — type-enforced so missed call sites are compile errors. */
  headId: string
  skillName?: string             // if spawned from a skill, associates the agent with that skill for tool-surface derivation
  parentAgentId?: string
  /** Optional delivery set (Phase 44). Only meaningful for top-level scheduled agents.
   *  Sub-agents and manual spawns leave this absent (treated as empty = owner-only). */
  deliverToHeadIds?: string[]
  /** Optional per-schedule relay-steward guidance (Schedule.relayGuidance), persisted on
   *  the agents row so it's available to the relay steward at completion. Only meaningful
   *  for scheduled agents; absent elsewhere. */
  relayGuidance?: string
  /** Head conversation history to prepend as context. Agent sees what led to the task. */
  headHistory?: Message[]
  /** Attachments from the triggering message to include in the agent's initial context. */
  attachments?: import('./core.js').Attachment[]
  /** If set, sub-agent debug output (tool calls, results, thinking) is forwarded here.
   *  Not persisted — only meaningful for the duration of the in-process run. */
  onDebug?: (msg: string) => Promise<void>
  /** Like onDebug but user-facing xray mode: no agent prefixes, spawn_agent hidden. */
  onVerbose?: (msg: string) => Promise<void>
}

// ─── Runner interface ─────────────────────────────────────────────────────────

export interface AgentRunner {
  /** Spawn a new agent. Returns agent ID. Non-blocking — agent runs async. */
  spawn(options: SpawnOptions): Promise<string>

  /** Push new context to a running agent via agent_inbox.
   *  `onVerbose` re-binds the agent's xray (tool-work) stream to the caller's
   *  current channel — without it a continued agent keeps streaming work to the
   *  channel it was first spawned from. */
  update(agentId: string, message: string, onVerbose?: (msg: string) => Promise<void>): Promise<void>

  /** Provide an answer to a suspended agent's question. Resumes execution. */
  signal(agentId: string, answer: string): Promise<void>

  /** Terminate a running or suspended agent. */
  retract(agentId: string): Promise<void>

  /** Request a fresh status report from the agent.
   *  Polls until the agent responds or timeoutMs elapses.
   *  Returns stale: true if the timeout elapsed before a fresh response arrived. */
  checkStatus(agentId: string, timeoutMs?: number): Promise<{ text: string; stale: boolean }>

  /** Wait for all currently-running agent tasks to settle.
   *  Resolves early if all tasks settle before the timeout. */
  awaitAll(timeoutMs: number): Promise<void>
}
