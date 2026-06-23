import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolCall, ToolResult } from '../types/core.js'
import { PRIORITY } from '../types/core.js'
import { generateId, now } from '../llm/util.js'
import type { ToolDefinition } from '../types/llm.js'
import type { AgentRunner } from '../types/agent.js'
import type { Memory } from '../memory/index.js'
import type { SkillLoader } from '../types/skill.js'
import type { UsageStore } from '../db/usage.js'
import type { MessageStore } from '../db/messages.js'
import type { ToolExecutor } from '../llm/tool-loop.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { LLMRouter } from '../types/llm.js'
import type { TextMessage } from '../types/core.js'
import { runResumeSteward, runMessageAgentSteward } from './steward.js'
import { applyIdentityEdits } from './identity-edit.js'
import {
  VIEW_IMAGE_DEF, executeViewImage,
  HEAD_RUNNABLE_TOOL_NAMES,
  getOptionalTool,
  buildReminderTools,
  buildScheduleTools,
} from '../sub-agents/registry.js'
import type { AgentToolEntry } from '../types/agent.js'
import { RING_DEVICE_DEF, executeRingDevice } from '../ring/tool.js'
import { DESCRIPTION_PARAM_SPEC } from '../tool-description.js'
import { timingMark } from '../timing.js'
import { nextRunAfter } from '../scheduler/cron.js'
import { formatModelTime, parseModelTime } from '../util/model-time.js'

// ─── HEAD_TOOLS definitions ───────────────────────────────────────────────────

/**
 * Build the head's spawn_agent tool definition.
 *
 * The `model` argument is present (and required) ONLY when the operator has set
 * `config.agentModel` to "dynamic" — i.e. they want the head to pick the worker
 * tier per task. When `agentModel` is a fixed tier/model, the arg is omitted
 * entirely: the operator's configured model is authoritative for every agent and
 * the head has no say (see #37). The dispatch layer also ignores any `model` that
 * sneaks in when not dynamic (defense-in-depth).
 */
export function buildHeadSpawnAgentDef(agentModelDynamic: boolean): ToolDefinition {
  const baseDesc = 'Spawn an agent to handle a task asynchronously. Write a single all-in-one `task`: say what the user wants AND give the agent everything it needs to do it well. Say what is wanted, not how to do it — the agent is capable and decides the approach.'
  const tierDesc = ' Pick the worker tier per task via `model`: dumb for trivial single-fact lookups / web searches, smart for everyday work, genius for hard multi-step reasoning.'
  const ackDesc = ' Always include a brief acknowledgment in your response when calling this tool (e.g. "On it." or "Checking now.") — the user needs to know you\'re working on it, and the loop exits immediately after.'

  const properties: Record<string, unknown> = {
    description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
    task: { type: 'string', description: 'The all-in-one request for the agent: what the user wants PLUS all the relevant detail, constraints, preferences, and context the agent needs. Give as much as helps — and relay things VERBATIM where it matters (the user\'s exact wording, names, IDs, links, exact values), since a paraphrase can lose information the agent can\'t recover. Say what is wanted, not how to do it: don\'t prescribe a method or spell out steps — the agent is capable and works out the how (and self-corrects if you over-prescribe). Good: "Book me a flight to Boston. The user said: \'I need to get to Boston Thursday before 5pm, under $300, window seat.\'"' },
    name: { type: 'string', description: 'Short human-readable name for this agent — 2-5 words describing what it\'s doing (e.g. "github-pr-123-review", "morning-email-triage", "fix-login-bug"). Used as the agent\'s ID prefix so you can identify it later. Multiple agents can run in parallel — be specific.' },
  }
  const required = ['description', 'task', 'name']

  if (agentModelDynamic) {
    properties['model'] = { type: 'string', enum: ['dumb', 'smart', 'genius'], description: 'Worker capability tier for THIS task (required). dumb = trivial single-fact lookups / web searches only; smart = everyday work; genius = hard multi-step / reasoning-heavy work.' }
    required.push('model')
  }

  return {
    name: 'spawn_agent',
    description: baseDesc + (agentModelDynamic ? tierDesc : '') + ackDesc,
    inputSchema: { type: 'object', properties, required },
  }
}

/**
 * Build the head's message_head tool definition. `head` accepts a recipient's
 * display name; the description lists the OTHER heads (every head except `selfId`)
 * so the model knows who it can relay to. With fewer than two heads there are no
 * valid recipients and the description says so.
 */
export function buildMessageHeadDef(
  roster: ReadonlyArray<{ id: string; displayName: string }>,
  selfId: string,
): ToolDefinition {
  const others = roster.filter(h => h.id !== selfId)
  const recipientList = others.length > 0
    ? others.map(h => `"${h.displayName}"`).join(', ')
    : 'none configured'
  return {
    name: 'message_head',
    description:
      'Relay a message to another person through their own line to you. Use this when the user asks you to tell / let / notify / pass something along to someone else (e.g. "let Zoey know dinner moved to 7pm"). The recipient is notified on their own channel, attributed to the person who asked. ' +
      `Valid recipients (by name): ${recipientList}.`,
    inputSchema: {
      type: 'object',
      properties: {
        head: { type: 'string', description: 'The recipient\'s name, e.g. "Zoey".' },
        message: { type: 'string', description: 'What to relay, in your own words.' },
      },
      required: ['head', 'message'],
    },
  }
}

export const HEAD_TOOLS: ToolDefinition[] = [
  // Static default uses the non-dynamic variant (default config agentModel is a
  // fixed tier). system.ts swaps in the dynamic variant when agentModel === 'dynamic'.
  buildHeadSpawnAgentDef(false),
  {
    name: 'message_agent',
    description: 'Continue an agent — works for running, paused, and completed agents. Write a single all-in-one `message`: the follow-up the agent should pick up from, including everything it needs.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        message: { type: 'string', description: 'The all-in-one follow-up delivered to the agent: the new user turns, their reply to a paused agent\'s question, any added detail or corrections — plus whatever context helps the agent continue. Relay things VERBATIM where it matters (the user\'s exact wording, choices, names, IDs, links, exact values), since a paraphrase can lose information the agent can\'t recover. Good: "The user said: \'yes go ahead, the window seat one under $300\'."' },
      },
      required: ['agentId', 'message'],
    },
  },
  // Static fallback definition so the name propagates to HEAD_TOOL_NAMES (and thus
  // the allowlist default + Settings registry). system.ts swaps in the per-head
  // buildMessageHeadDef(roster, selfId) variant which lists actual recipients.
  buildMessageHeadDef([], ''),
  {
    name: 'cancel_agent',
    description: 'Terminate a running or suspended agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'list_identity_files',
    description: 'List all files in the identity directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_identity',
    description: 'Get the current contents of an identity file before editing it with write_identity. All identity files are already loaded verbatim into your context at the start of every turn, so this points you to the in-context copy rather than re-sending the text — read it directly from your context.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename, e.g. USER.md' },
      },
      required: ['file'],
    },
  },
  {
    name: 'write_identity',
    description: 'Edit an existing identity file with targeted replacements. Provide `edits` as a list of { oldText, newText } changes; each oldText must match the file EXACTLY ONCE — include enough surrounding context to be unique, or it is rejected. Copy oldText verbatim from the file as it appears in your context (every identity file is included in your context each turn — do not call anything to fetch it). To clear a file, use one edit whose oldText is its full current contents and whose newText is "". Use list_identity_files to see which files exist — editing a non-existent file is an error. Changes take effect on the next activation. USER.md stores facts about the user: preferences, personal details, people in their life, and anything they ask to be remembered. SOUL.md stores personality, tone, and the assistant\'s name.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename, e.g. USER.md' },
        edits: {
          type: 'array',
          description: 'Replacements applied in order. Each replaces an exact oldText with newText.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to find and replace (must match the file exactly once).' },
              newText: { type: 'string', description: 'Text to replace it with. Use "" to delete the matched text.' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['file', 'edits'],
    },
  },
  VIEW_IMAGE_DEF,
  {
    name: 'send_file',
    description: 'Send a file to the user through their current channel. Use when the user asked for a file and an agent created one.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
        path: { type: 'string', description: 'Path to the file.' },
      },
      required: ['description', 'path'],
    },
  },
  {
    name: 'get_usage',
    description: 'Returns estimated spend (USD) and token counts for the configured LLM account, broken down by model and source type, over a time window. Costs are ESTIMATED from per-token pricing tracked at request time and may drift slightly from the provider\'s billed total. Use this to answer "how much have I spent" instead of spawning an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Enter a start date and time in workspace-local format: `YYYY-MM-DD HH:MM` (24-hour, no Z, no offset, no timezone suffix — the time is interpreted in the workspace timezone). Example: "2026-04-15 09:00". Omit for all-time.' },
      },
    },
  },
  {
    name: 'acknowledge_reminder',
    description: 'Acknowledge an acknowledgment-required reminder, stopping its nag loop. ' +
      'Only call this for reminders that explicitly require acknowledgment (requiresAck: true) — ' +
      'NEVER call this on an ordinary reminder that does not require acknowledgment; use cancel_reminder if you need to cancel an ordinary reminder. ' +
      'Call this only when the user has explicitly confirmed, in their own message, that they have seen and handled the reminder. ' +
      'NEVER call this in the same turn that the reminder fires — the firing event is the reminder nagging, NOT the user acknowledging it; delivering or replying to it is not confirmation. ' +
      'The reminder ID is provided in the reminder event that triggered this activation.',
    inputSchema: {
      type: 'object',
      properties: {
        reminderId: { type: 'string', description: 'The ID of the acknowledgment-required reminder to acknowledge. Found in the reminder event that triggered this activation.' },
      },
      required: ['reminderId'],
    },
  },
  RING_DEVICE_DEF,
]

/**
 * The names of the head-executable tools — derived from HEAD_TOOLS so they
 * cannot drift. Used as the pre-feature default for the global head-tool layer
 * (TOOLCFG-01/07): a no-config install resolves the head to exactly these names.
 * Consumed by src/config.ts as `headToolDefaults.allowedTools` default and by
 * src/dashboard/routes/tools.ts for the per-layer tag registry.
 */
export const HEAD_TOOL_NAMES: string[] = HEAD_TOOLS.map(t => t.name)

// ─── HeadToolExecutor ─────────────────────────────────────────────────────────

export interface HeadToolExecutorOptions {
  /** Required: head this executor belongs to. Phase 34 D-EXEC-OPTION — the executor
   *  injects this value into SpawnOptions when handling the spawn_agent dispatch case,
   *  so agents spawned via the head tool surface inherit the spawning head's identity.
   *  Mirrors ActivationLoopOptions.headId rather than InjectorImpl's positional pattern
   *  because this interface is already an options grab-bag (15+ fields). */
  headId: string
  agentRunner: AgentRunner
  agentStore?: import('../db/agents.js').AgentStore
  skillLoader: SkillLoader
  /** Unified loader across skills + tasks. Threaded in Plan 04-01; consumed by activation.ts and registry.ts in Plans 04-02/04-03. Optional for back-compat. */
  unifiedLoader?: import('../skills/unified.js').UnifiedLoader
  topicMemory: Memory
  usageStore: UsageStore
  identityDir: string
  identityLoader: IdentityLoader
  messages: MessageStore
  /** Returns the current head conversation history for passing to spawned agents. */
  getHistory?: () => import('../types/core.js').Message[]
  /** Returns attachments from the triggering event message, if any. */
  getAttachments?: () => import('../types/core.js').Attachment[]
  onDebug?: (msg: string) => Promise<void>
  onVerbose?: (msg: string) => Promise<void>
  /** Override the note returned in the spawn_agent tool result (for eval: encourages Round 2 text). */
  spawnAgentNote?: string
  /** LLM router for running stewards (e.g. resume steward). */
  llmRouter?: LLMRouter
  /** Model tier for steward calls. */
  stewardModel?: string
  /** Token budget for resume steward context. */
  resumeStewardContextTokens?: number
  /** Whether the resume steward validates answers to suspended agents. */
  resumeStewardEnabled?: boolean
  /** Whether message_agent can resume completed agents. */
  agentContinuationEnabled?: boolean
  /** Whether the message-agent steward validates calls (gates check-ins and continuations). */
  messageAgentStewardEnabled?: boolean
  /** When true (config.agentModel === 'dynamic'), the head's spawn_agent carries a
   *  required `model` arg and the head's choice is honored. When false, any incoming
   *  `model` is ignored — the operator's configured agent model is authoritative (#37). */
  agentModelDynamic?: boolean
  /** Called after an identity file is written. Used to extract assistant name from SOUL.md. */
  onIdentityChanged?: (file: string, content: string) => void
  /** Called when Head queues a file for delivery to the user via send_file. */
  onFileQueued?: (att: import('../types/core.js').Attachment) => void
  /** Schedule store for the acknowledge_reminder head-direct tool (D-06). Optional — existing
   *  callers without a store remain tsc-clean. Mirrored from the agentStore? optional pattern. */
  scheduleStore?: import('../db/schedules.js').ScheduleStore
  /** IANA timezone string for cron-resume computation in acknowledge_reminder (D-07).
   *  Falls back to 'UTC' when absent. Optional so existing callers remain tsc-clean. */
  timezone?: string
  /** Phase 45 — RingRunner for ring_device dispatch. Optional so existing callers
   *  without a runner remain tsc-clean (mirrors scheduleStore? pattern). */
  ringRunner?: import('../ring/runner.js').RingRunner
  /** Phase 47 — NoteStore for head-direct note tools (write_note, read_note, etc.).
   *  Optional so existing callers without a store remain tsc-clean.
   *  Mirrored from the scheduleStore? optional pattern. */
  noteStore?: import('../db/notes.js').NoteStore
  /** Shared queue store for cross-head relay (message_head). All heads' stores wrap
   *  the same db + wake hook, so enqueuing with another head's id wakes that head's
   *  loop. Optional so existing test callers stay tsc-clean (mirrors scheduleStore?). */
  queueStore?: import('../db/queue.js').QueueStore
  /** Roster of all heads {id, displayName} for resolving message_head recipients
   *  and the sender's own display name. Optional (single-head installs omit it). */
  headRoster?: ReadonlyArray<{ id: string; displayName: string }>
}

/** Tools the head can dispatch to agent-registry executors (Phase 47, D-04).
 *  Built once at construction time. Excludes view_image/get_usage/ring_device
 *  which are already native head cases (D-05). */
function buildHeadToolMap(opts: HeadToolExecutorOptions): Map<string, AgentToolEntry> {
  const map = new Map<string, AgentToolEntry>()
  const tz = opts.timezone ?? 'UTC'

  // OPTIONAL tools (filesystem/bash/web) — exclude the three already-native dual tools
  const DUAL_NATIVE = new Set(['view_image', 'get_usage', 'ring_device'])
  for (const name of HEAD_RUNNABLE_TOOL_NAMES) {
    if (DUAL_NATIVE.has(name)) continue  // D-05: native cases win; skip to avoid double-registration
    const entry = getOptionalTool(name)
    if (entry !== undefined) {
      map.set(name, entry)
    }
    // note/reminder/schedule names are not in OPTIONAL_TOOLS — handled by builders below
  }

  // Note tools are DISABLED (operator preference; see NOTE_TOOL_NAMES in registry.ts) —
  // intentionally not registered as head-dispatchable, so the head can neither be offered
  // nor execute them. NoteStore stays wired for the dashboard's read-only view only.

  // Reminder and schedule tools — available when scheduleStore is present
  if (opts.scheduleStore !== undefined) {
    for (const entry of buildReminderTools(opts.scheduleStore, tz, opts.headId, opts.headRoster ?? [])) {
      map.set(entry.definition.name, entry)
    }
    for (const entry of buildScheduleTools(opts.scheduleStore, tz, opts.unifiedLoader ?? null, opts.headId)) {
      map.set(entry.definition.name, entry)
    }
  }

  return map
}

export class HeadToolExecutor implements ToolExecutor {
  private readonly headToolMap: Map<string, AgentToolEntry>

  constructor(private opts: HeadToolExecutorOptions) {
    this.headToolMap = buildHeadToolMap(opts)
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const result = await this.dispatch(toolCall)
      if (typeof result === 'string') {
        return { toolCallId: toolCall.id, name: toolCall.name, content: result }
      }
      return { ...result, toolCallId: toolCall.id, name: toolCall.name }
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: JSON.stringify({ error: true, message: (err as Error).message ?? 'unknown error' }),
      }
    }
  }

  private async dispatch(toolCall: ToolCall): Promise<string | ToolResult> {
    const { name, input } = toolCall

    switch (name) {
      // ── Agent management ───────────────────────────────────────────────────
      case 'spawn_agent': {
        const spawnOpts: import('../types/agent.js').SpawnOptions = {
          task: input['task'] as string,
          name: input['name'] as string,
          trigger: 'manual',
          headId: this.opts.headId,                       // Phase 34 D-EXEC-OPTION: agent inherits the spawning head's identity
          // Honor the head's model choice only in dynamic mode; otherwise the operator's
          // configured agent model wins and any incoming `model` is ignored (#37).
          ...(this.opts.agentModelDynamic && input['model'] ? { model: input['model'] as string } : {}),
          ...(this.opts.getHistory ? { headHistory: this.opts.getHistory() } : {}),
          ...(this.opts.onDebug ? { onDebug: this.opts.onDebug } : {}),
          ...(this.opts.onVerbose ? { onVerbose: this.opts.onVerbose } : {}),
          ...(this.opts.getAttachments ? { attachments: this.opts.getAttachments() } : {}),
        }
        const agentId = await this.opts.agentRunner.spawn(spawnOpts)
        timingMark('head.spawn_called', {
          sourceType: 'head',
          agent_id: agentId,
          skill_name: spawnOpts.name,
        })
        const note = this.opts.spawnAgentNote ?? 'Agent is running. End your response now — you will be activated again when the agent completes.'
        return JSON.stringify({ agentId, note })
      }

      case 'message_agent': {
        const agentId = input['agentId'] as string
        // `message` is the all-in-one follow-up: the stewards judge it AND it is delivered
        // to the agent directly (the head writes a rich message; no composer in between).
        const message = input['message'] as string
        if (this.opts.agentStore) {
          const state = this.opts.agentStore.get(agentId)
          if (state?.status === 'failed' || state?.status === 'retracted') {
            return JSON.stringify({ error: true, message: `Agent ${agentId} is ${state.status} — it is no longer running. Check the tool_result for its output.` })
          }
          if (state?.status === 'completed' && !this.opts.agentContinuationEnabled) {
            return JSON.stringify({ error: true, message: `Agent ${agentId} is completed — it is no longer running. Check the tool_result for its output.` })
          }

          if (state?.status === 'completed') {
            // Continuation: validate the message is user-driven before resuming (gated by config)
            const task = state.task ?? ''
            if (this.opts.messageAgentStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecentText(this.opts.headId, 4)
                .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt }))
              const pass = await runMessageAgentSteward(
                task, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent is completed. To continue it, the user must request continuation — don\'t resume agents unprompted.',
                })
              }
            }
          } else if (state?.status === 'suspended') {
            // Suspended agent — validate the answer is real before resuming (gated by config)
            const question = state.pendingQuestion ?? ''
            if (question && this.opts.resumeStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecent(this.opts.headId, this.opts.resumeStewardContextTokens ?? 4000)
                .filter((m): m is TextMessage => m.kind === 'text' && !m.injected)
                .map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
              const pass = await runResumeSteward(
                question, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent needs a real answer from the user, not a placeholder. Ask the user for the information and call message_agent when you have their actual response.',
                })
              }
            }
          } else {
            // Running agent — reject unprompted check-ins (gated by config)
            const task = state?.task ?? ''
            if (this.opts.messageAgentStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecentText(this.opts.headId, 4)
                .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt }))
              const pass = await runMessageAgentSteward(
                task, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent is still working. You\'ll be activated when it completes — no need to check in.',
                })
              }
            }
          }
        }
        // Deliver the head's all-in-one `message` directly to the agent. The head writes a
        // rich follow-up (new turns / reply / added detail), so it becomes the agent's
        // content as-is — no composer or wrapper in between (it arrives as the agent's next
        // user turn, and the head is effectively the agent's "user"). Delivery is UNIFORM
        // across running/completed/suspended agents. The head's current xray callback streams
        // a continued agent's work to THIS activation's channel, not the one it was first
        // spawned from.
        await this.opts.agentRunner.update(agentId, message, this.opts.onVerbose)
        return JSON.stringify({ ok: true })
      }

      case 'message_head': {
        const roster = this.opts.headRoster ?? []
        const others = roster.filter(h => h.id !== this.opts.headId)
        if (!this.opts.queueStore || others.length === 0) {
          return JSON.stringify({ error: true, message: 'There are no other people to relay to.' })
        }
        const target = (input['head'] as string | undefined)?.trim() ?? ''
        const message = (input['message'] as string | undefined) ?? ''
        const norm = target.toLowerCase()
        const match = others.find(h => h.displayName.toLowerCase() === norm)
          ?? others.find(h => h.id.toLowerCase() === norm)
        if (!match) {
          const valid = others.map(h => h.displayName).join(', ')
          return JSON.stringify({ error: true, message: `No recipient named "${target}". Valid recipients: ${valid}.` })
        }
        const selfName = roster.find(h => h.id === this.opts.headId)?.displayName ?? this.opts.headId
        this.opts.queueStore.enqueue(
          {
            type: 'head_message',
            id: generateId('qe'),
            fromHeadId: this.opts.headId,
            fromHeadName: selfName,
            text: message,
            createdAt: now(),
          },
          PRIORITY.HEAD_MESSAGE,
          match.id,
        )
        return JSON.stringify({ ok: true, relayedTo: match.displayName })
      }

      case 'cancel_agent': {
        await this.opts.agentRunner.retract(input['agentId'] as string)
        return JSON.stringify({ ok: true })
      }

      case 'get_usage': {
        const tz = this.opts.timezone ?? 'UTC'
        const sinceRaw = input['since'] as string | undefined
        if (sinceRaw !== undefined) {
          let parsed: Date
          try {
            parsed = parseModelTime(sinceRaw, tz)
          } catch (e) {
            return JSON.stringify({ error: true, message: (e as Error).message })
          }
          const summary = this.opts.usageStore.getSummary(parsed.toISOString())
          return JSON.stringify({
            since: formatModelTime(parsed, tz),
            estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            byModel: summary.byModel,
            bySourceType: summary.bySourceType,
            bySource: summary.bySource,
          })
        }
        const summary = this.opts.usageStore.getSummary()
        return JSON.stringify({
          since: 'all-time',
          estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          byModel: summary.byModel,
          bySourceType: summary.bySourceType,
          bySource: summary.bySource,
        })
      }

      // ── Identity ─────────────────────────────────────────────────────────────
      case 'list_identity_files': {
        return JSON.stringify(this.opts.identityLoader.listFiles())
      }

      case 'read_identity': {
        const file = input['file'] as string
        const baseName = path.basename(file)
        const knownFiles = this.opts.identityLoader.listFiles()
        if (!knownFiles.includes(baseName)) {
          return JSON.stringify({ error: true, message: `Identity file "${baseName}" does not exist. Use list_identity_files to see available files.` })
        }
        // Identity files are injected verbatim into the system prompt at the start of
        // every turn, so the head already has the current contents in front of it.
        // Rather than re-sending the body (which can grow large enough to truncate the
        // history window), point the head at the copy it already holds. This still gives
        // the head a real tool to reach for so it never spawns an agent just to "read".
        const content = this.opts.identityLoader.readFile(baseName)
        if (content === null) {
          return JSON.stringify({ error: true, message: `Could not read identity file "${baseName}".` })
        }
        if (content.trim() === '') {
          return `"${baseName}" is currently empty.`
        }
        return `The current contents of "${baseName}" are already included verbatim in your context — every identity file is loaded into your system prompt at the start of each turn. Read "${baseName}" directly from your context above; there is no need to fetch it separately before editing.`
      }

      case 'write_identity': {
        const file = input['file'] as string
        const edits = input['edits'] as Array<{ oldText: string; newText: string }> | undefined
        const baseName = path.basename(file)
        const knownFiles = this.opts.identityLoader.listFiles()
        if (!knownFiles.includes(baseName)) {
          return JSON.stringify({ error: true, message: `Identity file "${baseName}" does not exist. Use list_identity_files to see available files.` })
        }

        const current = this.opts.identityLoader.readFile(baseName)
        if (current === null) {
          return JSON.stringify({ error: true, message: `Could not read identity file "${baseName}".` })
        }

        // Apply edits all-or-nothing to an in-memory copy; only write on full success.
        let applied: { content: string; diff: string }
        try {
          applied = applyIdentityEdits(current, edits ?? [])
        } catch (err) {
          return JSON.stringify({ error: true, message: (err as Error).message })
        }

        const filePath = path.join(this.opts.identityDir, baseName)
        const tempPath = path.join(this.opts.identityDir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.md`)
        await fs.promises.writeFile(tempPath, applied.content, 'utf8')
        await fs.promises.rename(tempPath, filePath)
        if (baseName === 'SOUL.md' && this.opts.onIdentityChanged) {
          this.opts.onIdentityChanged(baseName, applied.content)
        }

        return `Applied ${edits!.length} edit${edits!.length === 1 ? '' : 's'} to ${baseName}:\n${applied.diff}`
      }

      // ── Vision ──────────────────────────────────────────────────────────────
      case 'view_image': {
        return executeViewImage(input)
      }

      // ── File delivery ──────────────────────────────────────────────────────
      case 'send_file': {
        const filePath = input['path'] as string
        if (!filePath) return JSON.stringify({ error: true, message: 'path is required' })
        const resolved = path.resolve(filePath)
        if (!fs.existsSync(resolved)) {
          return JSON.stringify({ error: true, message: `File not found: ${filePath}` })
        }
        const stat = fs.statSync(resolved)
        const ext = path.extname(resolved).toLowerCase()
        const mimeTypes: Record<string, string> = {
          '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
          '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip',
        }
        const mediaType = mimeTypes[ext] ?? 'application/octet-stream'
        const isImage = mediaType.startsWith('image/')
        const isAudio = mediaType.startsWith('audio/')
        const isVideo = mediaType.startsWith('video/')
        const attType = isImage ? 'image' as const : isAudio ? 'audio' as const : isVideo ? 'video' as const : 'document' as const
        const att: import('../types/core.js').Attachment = {
          type: attType, mediaType,
          filename: path.basename(resolved),
          path: resolved,
          size: stat.size,
        }
        this.opts.onFileQueued?.(att)
        return JSON.stringify({ ok: true, file: att.filename, size: `${(stat.size / 1024).toFixed(0)}KB` })
      }

      // ── Reminders ──────────────────────────────────────────────────────────
      case 'acknowledge_reminder': {
        const reminderId = input['reminderId'] as string
        const schedule = this.opts.scheduleStore?.get(reminderId) ?? null
        if (!schedule) {
          // D-09: already acked + deleted (one-time) or never existed → benign no-op
          return JSON.stringify({ ok: true, note: 'Reminder already acknowledged or not found.' })
        }
        if (schedule.requiresAck === false || schedule.kind !== 'reminder') {
          // D-08 layer b: server-side structural defense — hard error on ordinary reminder or task
          return JSON.stringify({ error: true, message: `Reminder '${reminderId}' does not require acknowledgment. Use cancel_reminder if you want to cancel it.` })
        }
        if (!schedule.ackPending) {
          // D-09: recurring reminder currently between occurrences, or already acked
          return JSON.stringify({ ok: true, note: 'Reminder already acknowledged.' })
        }
        if (schedule.cron === null) {
          // ACK-04 + ACK-06: one-time → delete entirely (armed nag is gone with the row)
          this.opts.scheduleStore!.delete(reminderId)
        } else {
          // ACK-05 + ACK-06: recurring → clear ackPending, re-point nextRun to base cron cadence
          // MUST use nextRunAfter (NOT now+nagInterval) — nag interval is the scheduler's domain
          const tz = schedule.cronTimezone ?? this.opts.timezone ?? 'UTC'
          const resumeAt = nextRunAfter(schedule.cron, new Date(), tz).toISOString()
          this.opts.scheduleStore!.update(reminderId, { ackPending: false, nextRun: resumeAt })
        }
        return JSON.stringify({ ok: true })
      }

      // ── Ring device ────────────────────────────────────────────────────────
      // Delegate to the module-singleton executeRingDevice (set by initRingTool at
      // startup, src/index.ts) so the head and sub-agent surfaces share one resolver
      // and one runner. Returns its own safe no-op when not initialized.
      case 'ring_device': {
        return await executeRingDevice(input, this.opts.headId)
      }

      // ── Phase 47 fallthrough — agent-registry executors run in head loop ──
      // Any non-natively-cased tool name that the head was assigned falls through
      // here and is dispatched to its agent-registry executor with a head-built ctx.
      // Native cases above (get_usage/view_image/ring_device/spawn_agent/…) never
      // reach default — D-05 is enforced by switch ordering, not by a runtime guard.
      default: {
        const entry = this.headToolMap.get(name)
        if (entry !== undefined) {
          // Build a head ctx satisfying AgentContext. abortSignal is intentionally
          // omitted (D-09): head-run bash ships uncancellable; registry executors
          // that read abortSignal see undefined and treat it as no signal (optional).
          // suspend/complete/fail are no-ops that satisfy the type — registry executors
          // never call them (verified: they only read headId/timezone/abortSignal).
          const ctx: import('../types/agent.js').AgentContext = {
            agentId: `head:${this.opts.headId}`,
            headId: this.opts.headId,
            timezone: this.opts.timezone ?? 'UTC',
            suspend: () => {},
            complete: () => {},
            fail: () => {},
          }
          return await entry.execute(input, ctx)
        } else {
          return JSON.stringify({ error: true, message: `Unknown tool: ${name}` })
        }
      }
    }
  }
}
