import type { Message, ToolResult } from './core.js'
import type { ToolDefinition } from './llm.js'

// ─── Tool surface ─────────────────────────────────────────────────────────────

/** Runtime context passed to every tool executor inside an agent. */
export interface AgentContext {
  agentId: string
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
  trigger: 'manual' | 'scheduled' | 'ad_hoc'
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
}

// ─── Spawn options ────────────────────────────────────────────────────────────

export interface SpawnOptions {
  agentId?: string               // pre-assigned ID; generated internally if omitted
  name?: string                  // human-readable label, used as slug prefix when agentId not pre-set
  prompt: string
  model?: string                 // tier name or direct model ID; defaults to 'capable'
  trigger: AgentState['trigger']
  skillName?: string             // if spawned from a skill, associates the agent with that skill for tool-surface derivation
  parentAgentId?: string
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

  /** Push new context to a running agent via agent_inbox. */
  update(agentId: string, message: string): Promise<void>

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
