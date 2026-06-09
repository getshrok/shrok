import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolCall, ToolResult } from '../types/core.js'
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
import {
  VIEW_IMAGE_DEF, executeViewImage,
  HEAD_RUNNABLE_TOOL_NAMES,
  getOptionalTool,
  buildNoteTools,
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

export const HEAD_TOOLS: ToolDefinition[] = [
  {
    name: 'spawn_agent',
    description: 'Spawn an agent to handle a task asynchronously. Your job is to RELAY, not to author: pass the user\'s request through in their own words via `task`, and paste the relevant conversation verbatim into `context` — let the natural conversation be the agent\'s prompt rather than writing a fresh one. Tell the agent what is wanted, not how to do it; the agent decides the approach. Tier guide: omit for everyday work (smart default); use genius for hard multi-step reasoning; use dumb for trivial single-fact lookups. Always include a brief acknowledgment in your response when calling this tool (e.g. "On it." or "Checking now.") — the user needs to know you\'re working on it, and the loop exits immediately after.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
        task: { type: 'string', description: 'What the agent must accomplish, stated as the ask itself. Lead with the user\'s own words — quote them. Your only job here is to resolve what the agent can\'t see (pronouns, "that thing", which of several options) into concrete terms. Do not invent an approach, add steps, or prescribe how — the agent decides that. Write original prose only when the user\'s words alone wouldn\'t make the goal clear.' },
        context: { type: 'string', description: 'Relevant messages or excerpts from the current conversation, pasted VERBATIM — constraints, preferences, prior turns, referenced details, names, links, IDs. Quote the actual words; do not summarize. Bad: "user wants a flight to Boston". Good: "I need to get to Boston Thursday before 5pm, under $300, window seat". Every paraphrase loses information the agent can\'t recover. When unsure whether something is relevant, include it.' },
        name: { type: 'string', description: 'Short human-readable name for this agent — 2-5 words describing what it\'s doing (e.g. "github-pr-123-review", "morning-email-triage", "fix-login-bug"). Used as the agent\'s ID prefix so you can identify it later. Multiple agents can run in parallel — be specific.' },
        model: { type: 'string', enum: ['dumb', 'smart', 'genius'], description: 'Worker capability tier. dumb = trivial single-fact lookups / web searches only; smart = everyday work (default); genius = hard multi-step / reasoning-heavy work. Omit to use smart.' },
      },
      required: ['description', 'task', 'name'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send a message to an agent — works for running, paused, and completed agents. For running agents, delivers new context or instructions. For paused agents, provides the information they need and resumes them. For completed agents, resumes them with new instructions to continue where they left off.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['agentId', 'message'],
    },
  },
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
    name: 'write_identity',
    description: 'Overwrite an existing identity file. Use list_identity_files to see which files exist — writing to a non-existent file is an error. Changes take effect on the next activation. USER.md stores facts about the user: preferences, personal details, people in their life, and anything they ask to be remembered. SOUL.md stores personality, tone, and the assistant\'s name.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename, e.g. USER.md' },
        content: { type: 'string' },
      },
      required: ['file', 'content'],
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
      'Call this only when the user has explicitly confirmed they have seen and handled the reminder. ' +
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
 * The names of the 10 head-executable tools — derived from HEAD_TOOLS so they
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

  // Note tools — always available when noteStore is present
  if (opts.noteStore !== undefined) {
    for (const entry of buildNoteTools(opts.noteStore)) {
      map.set(entry.definition.name, entry)
    }
  }

  // Reminder and schedule tools — available when scheduleStore is present
  if (opts.scheduleStore !== undefined) {
    for (const entry of buildReminderTools(opts.scheduleStore, tz, opts.headId)) {
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
          ...(input['context'] ? { context: input['context'] as string } : {}),
          name: input['name'] as string,
          trigger: 'manual',
          headId: this.opts.headId,                       // Phase 34 D-EXEC-OPTION: agent inherits the spawning head's identity
          ...(input['model'] ? { model: input['model'] as string } : {}),
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
        await this.opts.agentRunner.update(agentId, message)
        return JSON.stringify({ ok: true })
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

      case 'write_identity': {
        const file = input['file'] as string
        let content = input['content'] as string
        const baseName = path.basename(file)
        const knownFiles = this.opts.identityLoader.listFiles()
        if (!knownFiles.includes(baseName)) {
          return JSON.stringify({ error: true, message: `Identity file "${baseName}" does not exist. Use list_identity_files to see available files.` })
        }

        const filePath = path.join(this.opts.identityDir, baseName)
        const tempPath = path.join(this.opts.identityDir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.md`)
        await fs.promises.writeFile(tempPath, content, 'utf8')
        await fs.promises.rename(tempPath, filePath)
        if (baseName === 'SOUL.md' && this.opts.onIdentityChanged) {
          this.opts.onIdentityChanged(baseName, content)
        }

        return JSON.stringify({ ok: true })
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
