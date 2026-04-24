import { EventEmitter } from 'node:events'
import { log } from '../logger.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentRunner, SpawnOptions, AgentContext, AgentToolEntry } from '../types/agent.js'
import type { Skill } from '../types/skill.js'
import type { LLMRouter } from '../types/llm.js'
import type { Message, TextMessage, ToolCallMessage, ToolResultMessage, ToolCall, ToolResult } from '../types/core.js'
import type { AgentStore } from '../db/agents.js'
import type { AgentInboxStore } from '../db/agent_inbox.js'
import type { QueueStore } from '../db/queue.js'
import type { UsageStore } from '../db/usage.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { NoteStore } from '../db/notes.js'
import { classifyAndCompose } from '../head/classifier.js'
import type { AppStateStore } from '../db/app_state.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'
import { runToolLoop, type ToolExecutor } from '../llm/tool-loop.js'
import { generateId, generateAgentId, now, shortAgentId } from '../llm/util.js'
import { findBlockingThresholds } from '../usage-threshold.js'
import { AgentToolRegistryImpl, REPORT_STATUS_DEF, RESPOND_TO_MESSAGE_DEF } from './registry.js'
import { commitWorkspace } from '../workspace/git.js'
import { PRIORITY } from '../types/core.js'
import { runCompletionSteward, runSpawnAgentSteward } from '../head/steward.js'
import { adjustToolMessages, buildContextSnapshot } from './context.js'
import { injectSkillMemory } from './skill-memory.js'
import { truncateToolOutput } from './output-cap.js'
import { maybeArchiveHistory } from './archival.js'
import { timingMark } from '../timing.js'
import { assembleTools, buildSystemPrompt, type AgentDefaults, type ToolSurfaceDeps } from './tool-surface.js'
import type { UnifiedLoader } from '../skills/unified.js'

export type { AgentDefaults }

/**
 * Instruction-shaped message surfaced to the agent LLM when a slash-containing
 * skill name is encountered. Sub-skills are removed (Phase 7); the resolver
 * rejects slash names and this runner throws this literal message so the LLM
 * gets a short, actionable directive instead of a silent failure.
 *
 * Note: the tasks meta-skill (`skills/tasks/SKILL.md`) is available for
 * guidance on creating and editing tasks.
 */
export const SLASH_NAME_REJECTION =
  "Skill names must not contain '/'. Flat skills only. " +
  "For scheduled or one-off system tasks, create a task. " +
  "For flat-skill authoring, see skills/skills/SKILL.md."

// ─── LocalAgentRunner ────────────────────────────────────────────────────────

export interface LocalAgentRunnerOptions {
  agentStore: AgentStore
  inboxStore: AgentInboxStore
  queueStore: QueueStore
  usageStore: UsageStore
  skillLoader: SkillLoader
  /** Unified loader across skills + tasks. Threaded in Plan 04-01; consumed in Plans 04-02/04-03. Optional for back-compat with callers that don't build tasks. */
  unifiedLoader?: import('../skills/unified.js').UnifiedLoader
  skillsDir: string
  workspacePath: string | null
  mcpRegistry: McpRegistry
  identityLoader: IdentityLoader
  agentIdentityLoader: IdentityLoader
  llmRouter: LLMRouter
  scheduleStore?: ScheduleStore
  noteStore?: NoteStore
  appState?: AppStateStore
  agentDefaults?: AgentDefaults
  /** Env vars merged on top of process.env for every bash tool call in this runner (e.g. WORKSPACE_PATH override for evals). */
  envOverrides?: Record<string, string>
  pollIntervalMs?: number
  checkStatusTimeoutMs?: number
  archivalThreshold?: number
  /** Max chars of agent-visible tool OUTPUT before middle-truncation at the dispatch layer.
   *  0 or negative disables truncation (passthrough). Default 30_000. */
  toolOutputMaxChars?: number
  /** IANA timezone identifier — used by the threshold block check to compute period boundaries. */
  timezone: string
  agentModel?: string       // default model for agents with no skill/tier override
  stewardModel?: string       // model for agent context summaries
  snapshotTokenBudget?: number  // max tokens of head history passed to spawned agents
  agentContextComposer?: boolean  // when true, agents get classified+edited head history
  /** When false, no agent ever receives spawn_agent (byte-equivalent to pre-Milestone-1 behavior). Default true. Maps to config.nestedAgentSpawningEnabled. */
  nestedAgentSpawningEnabled?: boolean
  /** When true, a standard-tier LLM steward gates every depth-1 spawn_agent call and can reject with a short reason. On reject, the tool returns an instruction-shaped error containing the reason verbatim. When false, no steward call is made and the spawn proceeds subject only to NEST-* rules. Fail-open on infra errors. Default true. Maps to config.spawnAgentStewardEnabled. See STEW-01..08. */
  spawnAgentStewardEnabled?: boolean
}

export class LocalAgentRunner implements AgentRunner {
  private agentStore: AgentStore
  private inboxStore: AgentInboxStore
  private queueStore: QueueStore
  private usageStore: UsageStore
  private scheduleStore: ScheduleStore | null
  private noteStore: NoteStore | null
  private appState: AppStateStore | null
  private skillLoader: SkillLoader
  private unifiedLoader: UnifiedLoader | null
  private skillsDir: string
  private workspacePath: string | null
  private mcpRegistry: McpRegistry
  private identityLoader: IdentityLoader
  private agentIdentityLoader: IdentityLoader
  private llmRouter: LLMRouter
  private pollIntervalMs: number
  private checkStatusTimeoutMs: number
  private archivalThreshold: number
  private toolOutputMaxChars: number
  private agentDefaults: AgentDefaults
  private timezone: string
  private envOverrides: Record<string, string>
  private agentModel: string
  private stewardModel: string
  private snapshotTokenBudget: number
  private agentContextComposer: boolean
  private nestedAgentSpawningEnabled: boolean
  private spawnAgentStewardEnabled: boolean
  private toolRegistry = new AgentToolRegistryImpl()

  /** Per-agent EventEmitter for in-process wake signaling. */
  private emitters = new Map<string, EventEmitter>()
  /** Per-agent running promise (for awaitAll). */
  private tasks = new Map<string, Promise<void>>()
  /** Per-agent onVerbose callback, preserved across resume/continuation so agent work
   *  keeps flowing to channels after message_agent continues a completed agent. */
  private verboseCallbacks = new Map<string, (msg: string) => Promise<void>>()
  /** Per-agent AbortController: retract() calls .abort() to preempt in-flight bash
   *  calls (via ctx.abortSignal → child_process.execFile) and break out between
   *  LLM rounds (via runToolLoop's options.abortSignal). */
  private abortControllers = new Map<string, AbortController>()

  constructor(opts: LocalAgentRunnerOptions) {
    this.agentStore = opts.agentStore
    this.inboxStore = opts.inboxStore
    this.queueStore = opts.queueStore
    this.usageStore = opts.usageStore
    this.scheduleStore = opts.scheduleStore ?? null
    this.noteStore = opts.noteStore ?? null
    this.appState = opts.appState ?? null
    this.skillLoader = opts.skillLoader
    this.unifiedLoader = opts.unifiedLoader ?? null
    this.skillsDir = path.resolve(opts.skillsDir)
    this.workspacePath = opts.workspacePath !== null ? path.resolve(opts.workspacePath) : null
    this.mcpRegistry = opts.mcpRegistry
    this.identityLoader = opts.identityLoader
    this.agentIdentityLoader = opts.agentIdentityLoader
    this.llmRouter = opts.llmRouter
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000
    this.checkStatusTimeoutMs = opts.checkStatusTimeoutMs ?? 30_000
    this.archivalThreshold = opts.archivalThreshold ?? 120_000
    this.toolOutputMaxChars = opts.toolOutputMaxChars ?? 30_000
    this.agentDefaults = opts.agentDefaults ?? { env: null, allowedTools: null }
    this.envOverrides = opts.envOverrides ?? {}
    this.timezone = opts.timezone
    this.agentModel = opts.agentModel ?? 'capable'
    this.stewardModel = opts.stewardModel ?? 'standard'
    this.snapshotTokenBudget = opts.snapshotTokenBudget ?? 60_000
    this.agentContextComposer = opts.agentContextComposer ?? false
    this.nestedAgentSpawningEnabled = opts.nestedAgentSpawningEnabled ?? true
    this.spawnAgentStewardEnabled = opts.spawnAgentStewardEnabled ?? false
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async spawn(options: SpawnOptions): Promise<string> {
    let agentId = options.agentId
    if (!agentId) {
      if (!options.name) throw new Error('spawn() requires either agentId or name')
      agentId = generateAgentId(options.name)
    }

    // Resolve skill early — fail fast if unknown
    const skill = options.skillName ? this.resolveSkillByName(options.skillName) : null
    if (options.skillName && !skill) throw new Error(`Unknown skill: '${options.skillName}'`)

    // 260414-3pk: skill frontmatter no longer carries `model`; caller supplies
    // model or runner default (this.agentModel) applies downstream.
    // Resolve the model now so the DB record matches what actually runs.
    const effectiveOptions: SpawnOptions = { ...options, model: options.model ?? this.agentModel }

    // Assemble tool surface (may throw if MCP server down)
    const { toolEntries, failedMcpCapabilities } = await assembleTools(this.toolSurfaceDeps(), {
      agentId,
      options: effectiveOptions,
      skill,
    })

    // Persist agent record
    this.agentStore.create(agentId, effectiveOptions)

    // Preserve onVerbose so continuations via message_agent keep sending agent work to channels
    if (effectiveOptions.onVerbose) this.verboseCallbacks.set(agentId, effectiveOptions.onVerbose)

    const emitter = new EventEmitter()
    this.emitters.set(agentId, emitter)
    const abortController = new AbortController()
    this.abortControllers.set(agentId, abortController)

    // Run agent loop in background
    const task = this.runLoop(agentId, effectiveOptions, toolEntries, skill, emitter, failedMcpCapabilities).catch(err => {
      // Last-resort — runLoop has its own error handling; this catches any escape
      log.error(`[agent:${agentId}] Unhandled escape:`, err)
      try { this.agentStore.fail(agentId, (err as Error).message) } catch { /* ignore */ }
      // Notify the head so the user is told about the failure
      try {
        this.queueStore.enqueue({
          type: 'agent_failed',
          id: generateId('qe'),
          agentId,
          error: (err as Error).message,
          createdAt: new Date().toISOString(),
        } as import('../types/core.js').QueueEvent, 2)
      } catch { /* best effort */ }
    }).finally(() => {
      this.emitters.delete(agentId)
      this.tasks.delete(agentId)
      this.abortControllers.delete(agentId)
    })

    this.tasks.set(agentId, task)
    timingMark('agent.loop_queued', {
      sourceType: 'agent',
      sourceId: agentId,
      skill_name: effectiveOptions.name,
    })
    return agentId
  }

  async update(agentId: string, message: string): Promise<void> {
    // Suspended agents need a 'signal' type to resume; running agents get 'update'.
    const state = this.agentStore.get(agentId)
    if (state?.status === 'completed') {
      // Continuation: transition back to running and restart the loop.
      // Update workStart so the next completion only summarizes new work.
      this.agentStore.resume(agentId)
      this.agentStore.updateWorkStart(agentId, state.history?.length ?? 0)
      this.inboxStore.write(agentId, 'signal', message)
      await this.resumeSuspended(agentId, state)
      return
    }
    if (state?.status === 'suspended') {
      this.inboxStore.write(agentId, 'signal', message)
      const emitter = this.emitters.get(agentId)
      if (emitter) {
        emitter.emit('inbox')
      } else {
        await this.resumeSuspended(agentId, state)
      }
      return
    }
    this.inboxStore.write(agentId, 'update', message)
    this.emitters.get(agentId)?.emit('inbox')
  }

  /** @deprecated Use update() which now handles both running and suspended agents. */
  async signal(agentId: string, answer: string): Promise<void> {
    this.inboxStore.write(agentId, 'signal', answer)
    const emitter = this.emitters.get(agentId)
    if (emitter) {
      emitter.emit('inbox')
      return
    }
    const state = this.agentStore.get(agentId)
    if (state?.status === 'suspended') {
      await this.resumeSuspended(agentId, state)
    }
  }

  async retract(agentId: string): Promise<void> {
    const emitter = this.emitters.get(agentId)
    if (emitter) {
      // Ordering matters: inbox.write → emit → abort. The abort will cause runToolLoop
      // to throw AgentAbortedError; runLoopFrom's error handler probes the inbox for
      // a pending 'retract' message to distinguish cancel from genuine failure. If
      // abort() fires first, the handler would see an empty inbox and mark `failed`.
      this.inboxStore.write(agentId, 'retract', null)
      emitter.emit('inbox')
      this.abortControllers.get(agentId)?.abort()
      return
    }
    // Agent is not running in-process — retract directly if suspended
    const state = this.agentStore.get(agentId)
    if (state?.status === 'suspended') {
      this.agentStore.updateStatus(agentId, 'retracted')
      this.inboxStore.deleteForAgent(agentId)
    }
  }

  async checkStatus(agentId: string, timeoutMs?: number): Promise<{ text: string; stale: boolean }> {
    const emitter = this.emitters.get(agentId)

    // Agent already finished — return stored result immediately
    if (!emitter) {
      const state = this.agentStore.get(agentId)
      const text = state?.statusText ?? state?.output ?? state?.error ?? ''
      return { text, stale: false }
    }

    this.inboxStore.write(agentId, 'check_status', null)
    emitter.emit('inbox')

    // Wait for the agent to call report_status or time out
    const reported = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { emitter.off('status_reported', handler); resolve(false) }, timeoutMs ?? this.checkStatusTimeoutMs)
      const handler = () => { clearTimeout(timer); resolve(true) }
      emitter.once('status_reported', handler)
    })

    const state = this.agentStore.get(agentId)
    if (!state) return { text: '', stale: false }

    if (['completed', 'failed', 'retracted'].includes(state.status)) {
      const text = state.statusText ?? state.output ?? state.error ?? ''
      return { text, stale: false }
    }

    const text = state.statusText ?? ''
    return { text, stale: !reported }
  }

  async awaitAll(timeoutMs: number): Promise<void> {
    const tasks = [...this.tasks.values()]
    if (tasks.length === 0) return
    await Promise.race([
      Promise.allSettled(tasks),
      sleep(timeoutMs),
    ])
  }

  // ─── Tool surface assembly ───────────────────────────────────────────────────

  /** Resolve a skill or task by name.
   *
   *  When the unified loader is threaded (production wiring via Plan 04-01),
   *  bare names check both skills and tasks. Tasks carry full frontmatter
   *  (model/tools/env/deps), so a `trigger:'scheduled'` spawn whose skillName
   *  is a TASK.md target resolves its frontmatter the same way a skill would —
   *  the prerequisite for DISPATCH-02.
   *
   *  Slash-containing names are rejected with the instruction-shaped message
   *  defined in `SLASH_NAME_REJECTION` — flat skills only (Phase 7). Throwing
   *  here surfaces the literal directive to the spawn caller (which throws it
   *  on to the agent LLM) without a filesystem fallthrough.
   */
  private resolveSkillByName(name: string): Skill | null {
    if (name.includes('/')) {
      throw new Error(SLASH_NAME_REJECTION)
    }
    if (this.unifiedLoader) {
      const loaded = this.unifiedLoader.loadByName(name)
      return loaded?.skill ?? null
    }
    return this.skillLoader.load(name)
  }

  private toolSurfaceDeps(): ToolSurfaceDeps {
    return {
      skillLoader: this.skillLoader,
      ...(this.unifiedLoader ? { unifiedLoader: this.unifiedLoader } : {}),
      skillsDir: this.skillsDir,
      workspacePath: this.workspacePath,
      identityLoader: this.identityLoader,
      agentIdentityLoader: this.agentIdentityLoader,
      toolRegistry: this.toolRegistry,
      mcpRegistry: this.mcpRegistry,
      usageStore: this.usageStore,
      scheduleStore: this.scheduleStore,
      noteStore: this.noteStore,
      appState: this.appState,
      agentDefaults: this.agentDefaults,
      envOverrides: this.envOverrides,
      nestedAgentSpawningEnabled: this.nestedAgentSpawningEnabled,
      toolOutputMaxChars: this.toolOutputMaxChars,
      timezone: this.timezone,
    }
  }

  // ─── Resume suspended agent ──────────────────────────────────────────────────

  private async resumeSuspended(agentId: string, state: import('../types/agent.js').AgentState): Promise<void> {
    const savedVerbose = this.verboseCallbacks.get(agentId)
    const options: SpawnOptions = {
      prompt: state.task,
      model: state.model,
      trigger: state.trigger,
      ...(state.skillName ? { skillName: state.skillName } : {}),
      ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
      ...(savedVerbose ? { onVerbose: savedVerbose } : {}),
    }

    const skill = options.skillName ? this.resolveSkillByName(options.skillName) : null
    const { toolEntries } = await assembleTools(this.toolSurfaceDeps(), {
      agentId,
      options,
      skill,
    })
    const systemPrompt = buildSystemPrompt(this.toolSurfaceDeps(), skill)
    const history: Message[] = [...(state.history ?? [])]

    const emitter = new EventEmitter()
    this.emitters.set(agentId, emitter)
    const abortController = new AbortController()
    this.abortControllers.set(agentId, abortController)

    const task = this.runLoopFrom(agentId, options, toolEntries, systemPrompt, history, emitter, true).catch(err => {
      log.error(`[agent:${agentId}] Unhandled escape (resume):`, err)
      try { this.agentStore.fail(agentId, (err as Error).message) } catch { /* ignore */ }
    }).finally(() => {
      this.emitters.delete(agentId)
      this.tasks.delete(agentId)
      this.abortControllers.delete(agentId)
    })

    this.tasks.set(agentId, task)
  }

  // ─── Main loop ───────────────────────────────────────────────────────────────

  private async runLoop(
    agentId: string,
    options: SpawnOptions,
    toolEntries: AgentToolEntry[],
    skill: Skill | null,
    emitter: EventEmitter,
    failedMcpCapabilities: string[] = [],
  ): Promise<void> {
    timingMark('agent.loop_start', {
      sourceType: 'agent',
      sourceId: agentId,
      skill_name: options.name,
    })
    const systemPrompt = buildSystemPrompt(this.toolSurfaceDeps(), skill)

    const history: Message[] = []

    // Warn agent about unavailable MCP capabilities
    if (failedMcpCapabilities.length > 0) {
      history.push({
        kind: 'text',
        role: 'user',
        id: generateId('msg'),
        content: `[System notice: The following capabilities could not be loaded and are unavailable: ${failedMcpCapabilities.join(', ')}. You may need to work around their absence.]`,
        injected: true,
        createdAt: now(),
      } as TextMessage)
    }

    // Prepend head conversation history when the agent context composer is enabled.
    // When off, agents get only their spawn prompt — cheapest path, zero cross-contamination.
    // When on, agents get classified + selectively edited history relevant to their task.
    if (options.headHistory && options.headHistory.length > 0 && this.agentContextComposer) {
      const knownTools = new Set(toolEntries.map(e => e.definition.name))
      // Strip injected user-role text messages (steward nudges, system triggers)
      const filtered = options.headHistory.filter(
        m => !(m.kind === 'text' && (m as TextMessage).role === 'user' && m.injected)
      )
      const adjusted = adjustToolMessages(filtered, knownTools)
      const snapshot = buildContextSnapshot(adjusted, undefined, this.snapshotTokenBudget)

      // Three-way classification: KEEP, DROP, or EXTRACT (partial rewrite).
      // EXTRACT rewrites partially-relevant messages to contain only the relevant portion,
      // solving the multi-task-in-one-message problem.
      const { relevantIndices, replacements } = await classifyAndCompose(
        options.prompt,
        snapshot,
        this.llmRouter,
        this.stewardModel ?? 'standard',
        this.usageStore,
      )

      for (let i = 0; i < snapshot.length; i++) {
        if (!relevantIndices.has(i)) continue
        const msg = snapshot[i]!
        const replacement = replacements.get(i)
        if (replacement) {
          // EXTRACT'd message: replace content, preserve originating role.
          // Tool pairs collapse to role: 'assistant' (content describes assistant actions).
          const role = msg.kind === 'text'
            ? (msg as TextMessage).role
            : 'assistant'
          history.push({
            kind: 'text',
            id: msg.id,
            role,
            content: replacement,
            createdAt: msg.createdAt,
          })
        } else {
          history.push(msg)
        }
      }
    }

    // Record where the agent's own work begins — after all prepended head history.
    // Must stay before the first await (runLoopFrom) so it's set before any messages are appended.
    this.agentStore.updateWorkStart(agentId, history.length)

    // Inject the head's prompt as the agent's current task.
    // When agentContextComposer is on, relevant headHistory is prepended above.
    // When off, this prompt is the agent's only context — it must be self-contained.
    const agentFirstMessage = options.prompt
    const last = history.length > 0 ? history[history.length - 1] : null
    if (last && last.kind === 'text' && last.role === 'user') {
      ;(last as TextMessage).content += `\n\n${agentFirstMessage}`
      if (options.attachments?.length) {
        ;(last as TextMessage).attachments = [...(last as TextMessage).attachments ?? [], ...options.attachments]
      }
    } else {
      history.push({
        kind: 'text',
        role: 'user',
        id: generateId('msg'),
        content: agentFirstMessage,
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        createdAt: now(),
      } satisfies TextMessage)
    }

    // For skill-spawned agents, inject synthetic read_file calls for SKILL.md
    // and MEMORY.md so the agent sees the skill's instructions and state upfront.
    if (skill) {
      const skillDir = path.dirname(skill.path)
      const tcIds: string[] = []
      const toolCalls: ToolCall[] = []
      const toolResults: ToolResult[] = []

      // SKILL.md
      const skillTcId = generateId('tc')
      tcIds.push(skillTcId)
      toolCalls.push({ id: skillTcId, name: 'read_file', input: { path: skill.path } })
      toolResults.push({ toolCallId: skillTcId, name: 'read_file', content: truncateToolOutput(skill.instructions ?? '', this.toolOutputMaxChars, 'skill file') })

      // MEMORY.md (if it exists)
      const memPath = path.join(skillDir, 'MEMORY.md')
      try {
        const memory = fs.readFileSync(memPath, 'utf8')
        const memTcId = generateId('tc')
        toolCalls.push({ id: memTcId, name: 'read_file', input: { path: memPath } })
        toolResults.push({ toolCallId: memTcId, name: 'read_file', content: truncateToolOutput(memory, this.toolOutputMaxChars, 'skill file') })
      } catch { /* no memory file */ }

      // skill-deps: inject each dependency's SKILL.md + MEMORY.md
      const rawContent = (() => { try { return fs.readFileSync(skill.path, 'utf8') } catch { return '' } })()
      const depMatch = rawContent.match(/^---\n([\s\S]*?)\n---/)
      if (depMatch) {
        let inDeps = false
        for (const line of depMatch[1]!.split('\n')) {
          if (line.startsWith('skill-deps:')) { inDeps = true; continue }
          if (inDeps && line.match(/^\s+-\s+/)) {
            const dep = line.replace(/^\s+-\s+/, '').trim()
            const depSkillPath = path.join(this.skillsDir, dep, 'SKILL.md')
            try {
              const depContent = fs.readFileSync(depSkillPath, 'utf8')
              const depTcId = generateId('tc')
              toolCalls.push({ id: depTcId, name: 'read_file', input: { path: depSkillPath } })
              toolResults.push({ toolCallId: depTcId, name: 'read_file', content: truncateToolOutput(depContent, this.toolOutputMaxChars, 'skill file') })
              // Also try MEMORY.md in the same dir
              try {
                const depMem = fs.readFileSync(path.join(path.dirname(depSkillPath), 'MEMORY.md'), 'utf8')
                const depMemTcId = generateId('tc')
                toolCalls.push({ id: depMemTcId, name: 'read_file', input: { path: path.join(path.dirname(depSkillPath), 'MEMORY.md') } })
                toolResults.push({ toolCallId: depMemTcId, name: 'read_file', content: truncateToolOutput(depMem, this.toolOutputMaxChars, 'skill file') })
              } catch { /* no dep memory */ }
            } catch { /* dep skill not found */ }
          } else if (inDeps && !line.match(/^\s/)) { inDeps = false }
        }
      }

      history.push({
        kind: 'tool_call', id: generateId('msg'), createdAt: now(),
        content: '', toolCalls: toolCalls as [ToolCall, ...ToolCall[]],
      } as ToolCallMessage)
      history.push({
        kind: 'tool_result', id: generateId('msg'), createdAt: now(),
        toolResults: toolResults as [ToolResult, ...ToolResult[]],
      } as ToolResultMessage)
    }

    await this.runLoopFrom(agentId, options, toolEntries, systemPrompt, history, emitter, false)
  }

  private async runLoopFrom(
    agentId: string,
    options: SpawnOptions,
    toolEntries: AgentToolEntry[],
    systemPrompt: string,
    history: Message[],
    emitter: EventEmitter,
    isSuspended: boolean,
  ): Promise<void> {
    try {
      await this.loopIteration(agentId, options, toolEntries, systemPrompt, history, emitter, isSuspended)
    } catch (err) {
      log.error(`[agent:${agentId}] Error:`, (err as Error).message)
      try {
        // If a retract was pending in the inbox, honour it instead of reporting failure.
        // This covers the case where cancel_agent was called while the agent was blocked
        // on a long-running tool — the retract couldn't be checked until the tool returned,
        // and by then the tool or subsequent LLM call may have thrown.
        const pendingRetract = this.inboxStore.poll(agentId).some(m => m.type === 'retract')
        if (pendingRetract) {
          this.agentStore.updateStatus(agentId, 'retracted')
          log.info(`[agent:${agentId}] Retract honoured after error — marking as retracted, not failed`)
          return
        }

        this.agentStore.fail(agentId, (err as Error).message)
        if (options.parentAgentId) {
          this.inboxStore.write(options.parentAgentId, 'sub_agent_failed',
            JSON.stringify({ subWorkerId: agentId, error: (err as Error).message }))
          this.emitters.get(options.parentAgentId)?.emit('inbox')
        } else {
          this.queueStore.enqueue({
            type: 'agent_failed',
            id: generateId('qe'),
            agentId: agentId,
            error: (err as Error).message,
            createdAt: now(),
          }, PRIORITY.AGENT_FAILED)
        }
      } catch { /* ignore secondary failure */ }
    } finally {
      // Clean up inbox entries now that the agent has reached a terminal state
      try { this.inboxStore.deleteForAgent(agentId) } catch { /* ignore */ }
      // Commit any workspace changes the agent made — best-effort, never throws
      const summary = options.prompt.replace(/\s+/g, ' ').trim().slice(0, 100)
      if (this.workspacePath) commitWorkspace(this.workspacePath, `agent: ${summary}`)
    }
  }

  private async loopIteration(
    agentId: string,
    options: SpawnOptions,
    baseToolEntries: AgentToolEntry[],
    systemPrompt: string,
    history: Message[],
    emitter: EventEmitter,
    isSuspended: boolean,
  ): Promise<void> {
    let toolNudgeSent = false
    while (true) {
      // --- Threshold block check ---
      // If any block-action threshold is currently over budget, throw to stop
      // this agent run. The throw propagates to head's handleEvent error path.
      // Note: this check requires appState; if absent (unusual test fixture),
      // the block check is skipped — head's pre-event check is the real backstop.
      if (this.appState) {
        const blocking = findBlockingThresholds(
          this.appState.getThresholds(),
          (since) => this.usageStore.getCostSince(since),
          new Date(),
          this.timezone,
        )
        if (blocking.length > 0) {
          const c = blocking[0]!
          throw new Error(`Threshold ${c.threshold.period} $${c.threshold.amountUsd.toFixed(2)} blocked: $${c.currentSpend.toFixed(2)} of $${c.threshold.amountUsd.toFixed(2)}`)
        }
      }

      // --- Inbox check ---
      const inbox = this.inboxStore.poll(agentId)

      for (const msg of inbox) {
        if (msg.type === 'retract') {
          this.inboxStore.markProcessed(msg.id)
          this.agentStore.updateStatus(agentId, 'retracted')
          return
        }

        if (msg.type === 'update') {
          this.inboxStore.markProcessed(msg.id)
          history.push({
            kind: 'text', role: 'user',
            id: generateId('msg'),
            content: `[Message received: ${msg.payload ?? ''}]\nIf this requires a response, call respond_to_message. Otherwise, continue your current task.`,
            createdAt: now(),
          } satisfies TextMessage)
        }

        if (msg.type === 'signal') {
          this.inboxStore.markProcessed(msg.id)
          if (isSuspended) {
            // Resume: inject the answer as a user turn
            history.push({
              kind: 'text', role: 'user',
              id: generateId('msg'),
              content: msg.payload ?? '',
              createdAt: now(),
            } satisfies TextMessage)
            this.agentStore.resume(agentId)
            isSuspended = false
          }
          // If not suspended, the signal arrived after the agent already resumed — discard it.
        }

        if (msg.type === 'check_status' && isSuspended) {
          // Agent is suspended waiting for an answer — respond directly without an LLM call
          this.inboxStore.markProcessed(msg.id)
          const agentState = this.agentStore.get(agentId)
          const statusText = agentState?.pendingQuestion
            ? `Suspended: waiting for answer to: ${agentState.pendingQuestion}`
            : 'Suspended: waiting for signal'
          this.agentStore.updateStatusText(agentId, statusText)
          emitter.emit('status_reported')
        }

        if (
          msg.type === 'sub_agent_completed' ||
          msg.type === 'sub_agent_question' ||
          msg.type === 'sub_agent_failed'
        ) {
          this.inboxStore.markProcessed(msg.id)
          const payload = JSON.parse(msg.payload ?? '{}') as {
            subWorkerId: string
            output?: string
            question?: string
            error?: string
          }
          let content: string
          if (msg.type === 'sub_agent_completed') {
            content = `[Sub-agent ${payload.subWorkerId} completed]\n${payload.output ?? ''}`
          } else if (msg.type === 'sub_agent_question') {
            content = `[Sub-agent ${payload.subWorkerId} is paused and needs your help to continue:\n${payload.question ?? ''}]\nCall message_agent to provide the information, or cancel_agent to terminate it.`
          } else {
            content = `[Sub-agent ${payload.subWorkerId} failed: ${payload.error ?? 'unknown error'}]`
          }
          history.push({
            kind: 'text',
            role: 'user',
            id: generateId('msg'),
            content,
            createdAt: now(),
          } satisfies TextMessage)
        }
      }

      if (isSuspended) {
        // No signal yet — wait for inbox or poll interval, then retry
        await waitForInbox(emitter, this.pollIntervalMs)
        continue
      }

      // --- check_status injection ---
      // Add report_status transiently for ONE LLM call if a status check was requested.
      let toolEntries = baseToolEntries
      const checkStatusMsgs = inbox.filter(m => m.type === 'check_status')
      if (checkStatusMsgs.length > 0) {
        for (const m of checkStatusMsgs) this.inboxStore.markProcessed(m.id)
        history.push({
          kind: 'text', role: 'user',
          id: generateId('msg'),
          content: '[Status check requested. Call report_status with a brief summary of your current progress and next steps.]',
          createdAt: now(),
        } satisfies TextMessage)
        toolEntries = [...baseToolEntries, {
          definition: REPORT_STATUS_DEF,
          execute: async (input) => {
            const summary = input['summary'] as string
            this.agentStore.updateStatusText(agentId, summary)
            return 'Status reported.'
          },
        }]
      }

      // --- respond_to_message injection ---
      // Add respond_to_message transiently for ONE LLM call if an update message was received.
      const updateMsgs = inbox.filter(m => m.type === 'update')
      if (updateMsgs.length > 0) {
        toolEntries = [...toolEntries, {
          definition: RESPOND_TO_MESSAGE_DEF,
          execute: async () => 'Response sent.',  // no-op — executeAgentTool handles this
        }]
      }

      // --- Ensure history ends with a user message ---
      // Anthropic rejects calls where the last message is role:assistant (prefill).
      // If no inbox message added a user turn, inject a nudge.
      const lastMsg = history[history.length - 1]
      const lastIsAssistant = lastMsg && (
        lastMsg.kind === 'text' && lastMsg.role === 'assistant' ||
        lastMsg.kind === 'tool_call'
      )
      if (lastIsAssistant) {
        history.push({
          kind: 'text', role: 'user',
          id: generateId('msg'),
          content: '[Continue with your current task.]',
          createdAt: now(),
        } satisfies TextMessage)
      }

      // --- Compact history if needed ---
      await maybeArchiveHistory(agentId, history, {
        llmRouter: this.llmRouter,
        usageStore: this.usageStore,
        stewardModel: this.stewardModel,
        archivalThreshold: this.archivalThreshold,
        agentStore: this.agentStore,
        agentId,
      })

      // --- Run one tool loop pass ---
      const state = { suspended: false, completed: false }
      const abortController = this.abortControllers.get(agentId)
      const executor = this.buildAgentExecutor(agentId, options, toolEntries, history, emitter, state, abortController?.signal)

      const displayName = shortAgentId(agentId).replace(/-/g, ' ')
      const AGENT_CIRCLES = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫']
      // Phase 18 D-08/D-09: use the persisted color_slot instead of a per-invocation hash.
      // Null slot (pre-Phase-18 agents) → no circle prefix (no hash fallback — see RESEARCH.md).
      const circleIdx = this.agentStore.get(agentId)?.colorSlot ?? null
      const circlePrefix = circleIdx != null ? `${AGENT_CIRCLES[circleIdx] ?? ''} ` : ''
      // Only send xray output for head-spawned agents — scheduled/reminder/webhook agents are background noise.
      // onDebug is intentionally NOT threaded into the agent tool loop: agent internals belong to xray
      // (onVerbose). onDebug is for head-level internals only; passing both would duplicate every
      // thinking block / tool call / tool result into the channel.
      const agentVerbose = options.onVerbose && options.trigger === 'manual'
        ? (msg: string) => options.onVerbose!(`\`\`\`\n${circlePrefix}[${displayName}] ${msg}\n\`\`\``)
        : undefined

      await runToolLoop(this.llmRouter, {
        model: options.model ?? this.agentModel,
        stewardModel: this.stewardModel,
        tools: toolEntries.map(e => e.definition),
        systemPrompt,
        history,
        executor,
        usage: this.usageStore,
        sourceType: 'agent',
        sourceId: agentId,
        trigger: options.trigger,
        ...(options.skillName ? { targetName: options.skillName } : {}),
        appendMessage: async (msg) => {
          history.push(msg)
          this.agentStore.updateHistory(agentId, history)
          this.agentStore.emitMessageAdded(agentId, msg, options.trigger)
          // Auto-inject MEMORY.md when agent reads a SKILL.md inside the skills dir.
          if (msg.kind === 'tool_result') {
            injectSkillMemory(this.skillsDir, msg as ToolResultMessage, history, this.toolOutputMaxChars)
          }
        },
        refreshHistory: () => history,
        onRoundComplete: async () => {
          // Plan 24-02: deliver inbox messages mid-loop without waiting for end_turn.
          // Polls the agent's inbox between LLM rounds. For 'update' messages, injects
          // them into the in-memory history array (same pattern as the top-of-loop
          // injection at lines 672–679, but with instruction text that omits
          // respond_to_message — that tool is NOT in this runToolLoop's tool list).
          // For 'retract' messages, returns true to throw AgentAbortedError WITHOUT
          // calling markProcessed — the retract must remain in the inbox so
          // runLoopFrom's error handler (lines 602–608) finds it and classifies the
          // run as 'retracted' instead of 'failed'. Other inbox types (signal,
          // check_status, sub_agent_*) are left for the outer loopIteration to handle
          // after runToolLoop returns.
          const msgs = this.inboxStore.poll(agentId)
          for (const msg of msgs) {
            if (msg.type === 'retract') {
              // Do NOT markProcessed — runLoopFrom's error handler needs the unprocessed
              // retract to distinguish 'retracted' from 'failed'. Returning true causes
              // runToolLoop to throw AgentAbortedError; the outer error handler then
              // polls the inbox and finds this message.
              return true
            }
            if (msg.type === 'update') {
              this.inboxStore.markProcessed(msg.id)
              history.push({
                kind: 'text', role: 'user',
                id: generateId('msg'),
                content: `[Message received: ${msg.payload ?? ''}]\nContinue your current task, addressing this update if relevant.`,
                injected: true,
                createdAt: now(),
              } satisfies TextMessage)
            }
            // Other types (signal, check_status, sub_agent_completed/question/failed)
            // are intentionally NOT handled here — the outer loopIteration's top-of-loop
            // poll handles them when runToolLoop returns.
          }
          return false
        },
        ...(agentVerbose ? { onVerbose: agentVerbose } : {}),
        ...(abortController ? { abortSignal: abortController.signal } : {}),
      })

      // --- Handle outcomes ---
      if (state.completed) return
      if (state.suspended) {
        // Keep the loop alive in suspended-waiting mode so in-process signals
        // (emitter still alive) can wake us without needing a full re-spawn.
        isSuspended = true
        continue
      }

      // The model returned end_turn. Auto-complete if there's nothing pending
      // in the inbox AND no running sub-agents — otherwise the agent is
      // implicitly waiting for results.
      if (this.inboxStore.poll(agentId).length === 0 && !this.agentStore.hasRunningChildren(agentId)) {
        const workStart = this.agentStore.get(agentId)?.workStart ?? 0
        const hasCalledTool = history.slice(workStart).some(m => m.kind === 'tool_call')

        // No tools called yet — nudge once to use tools before involving the steward.
        if (!hasCalledTool && !toolNudgeSent) {
          toolNudgeSent = true
          history.push({
            kind: 'text', role: 'user',
            id: generateId('msg'),
            content: '[You responded without calling any tools. You must use your available tools to complete this task — do not answer from memory or training data.]',
            createdAt: now(),
          } satisfies TextMessage)
          continue
        }

        // Nudged and still no tools — fail without wasting a steward call.
        if (!hasCalledTool) {
          throw new Error('Agent completed without calling any tools after being prompted to do so.')
        }

        // Extract the agent's final text for classification.
        const lastAssistantText = [...history].reverse().find(m => m.kind === 'text' && m.role === 'assistant') as TextMessage | undefined
        const output = lastAssistantText?.content ?? ''

        // Run completion steward to classify output as done or question.
        const stewardResult = await runCompletionSteward(
          { task: options.prompt, output },
          this.llmRouter, this.stewardModel, this.usageStore,
        )

        if (stewardResult.type === 'question') {
          this.suspendAsQuestion(agentId, output, options, history)
          isSuspended = true
          continue
        }

        this.completeAgent(agentId, output, options, history)
        return
      }

      // If the inbox is empty but children are still running, wait for a child
      // to complete rather than busy-polling with LLM calls. The child will emit
      // 'inbox' when it finishes, which wakes us here.
      if (this.inboxStore.poll(agentId).length === 0) {
        await waitForInbox(emitter, this.pollIntervalMs)
      }

      // There are new inbox messages (or the poll timed out) — process them in the next iteration.
    }
  }

  private completeAgent(
    agentId: string,
    output: string,
    options: SpawnOptions,
    history: Message[],
  ): void {
    this.agentStore.complete(agentId, output, history)
    if (options.parentAgentId) {
      this.inboxStore.write(options.parentAgentId, 'sub_agent_completed',
        JSON.stringify({ subWorkerId: agentId, output }))
      this.emitters.get(options.parentAgentId)?.emit('inbox')
    } else {
      this.queueStore.enqueue({
        type: 'agent_completed',
        id: generateId('qe'),
        agentId: agentId,
        output,
        createdAt: now(),
      }, PRIORITY.AGENT_COMPLETED)
    }
  }

  private suspendAsQuestion(
    agentId: string, question: string, options: SpawnOptions, history: Message[],
  ): void {
    this.agentStore.suspend(agentId, history, question)
    if (options.parentAgentId) {
      this.inboxStore.write(options.parentAgentId, 'sub_agent_question',
        JSON.stringify({ subWorkerId: agentId, question }))
      this.emitters.get(options.parentAgentId)?.emit('inbox')
    } else {
      this.queueStore.enqueue({
        type: 'agent_question', id: generateId('qe'),
        agentId, question, createdAt: now(),
      }, PRIORITY.AGENT_QUESTION)
    }
  }

  // ─── Tool executor ───────────────────────────────────────────────────────────

  private buildAgentExecutor(
    agentId: string,
    options: SpawnOptions,
    toolEntries: AgentToolEntry[],
    history: Message[],
    emitter: EventEmitter,
    state: { suspended: boolean; completed: boolean },
    abortSignal?: AbortSignal,
  ): ToolExecutor {
    const toolMap = new Map(toolEntries.map(e => [e.definition.name, e]))

    const ctx: AgentContext = {
      agentId,
      suspend: () => { state.suspended = true },
      complete: (output: string) => {
        this.agentStore.complete(agentId, output, history)
        this.queueStore.enqueue({
          type: 'agent_completed',
          id: generateId('qe'),
          agentId: agentId,
          output,
          createdAt: now(),
        }, PRIORITY.AGENT_COMPLETED)
        state.completed = true
      },
      fail: (error: string) => { throw new Error(error) },
      ...(abortSignal ? { abortSignal } : {}),
    }

    return {
      execute: async (toolCall: ToolCall): Promise<ToolResult> => {
        const { name: toolName, input } = toolCall
        try {
          const result = await this.executeAgentTool(toolName, input, agentId, options, history, emitter, state, toolMap, ctx)
          if (typeof result === 'string') {
            return { toolCallId: toolCall.id, name: toolName, content: result }
          }
          return { ...result, toolCallId: toolCall.id, name: toolName }
        } catch (err) {
          return { toolCallId: toolCall.id, name: toolName, content: `Error: ${(err as Error).message}` }
        }
      },
    }
  }

  private async executeAgentTool(
    toolName: string,
    input: Record<string, unknown>,
    agentId: string,
    options: SpawnOptions,
    history: Message[],
    emitter: EventEmitter,
    state: { suspended: boolean; completed: boolean },
    toolMap: Map<string, AgentToolEntry>,
    ctx: AgentContext,
  ): Promise<string | ToolResult> {
    if (toolName === 'spawn_agent') {
      return this.handleSpawnAgent(agentId, options, input, history)
    }

    if (toolName === 'message_agent') {
      const targetId = input['subAgentId'] as string
      const target = this.agentStore.get(targetId)
      if (!target || target.parentAgentId !== agentId)
        return JSON.stringify({ error: true, message: `Agent ${targetId} is not a child of ${agentId}` })
      await this.update(targetId, input['message'] as string)
      return JSON.stringify({ ok: true })
    }


    if (toolName === 'cancel_agent') {
      const targetId = input['subAgentId'] as string
      const target = this.agentStore.get(targetId)
      if (!target || target.parentAgentId !== agentId)
        return JSON.stringify({ error: true, message: `Agent ${targetId} is not a child of ${agentId}` })
      await this.retract(targetId)
      return JSON.stringify({ ok: true })
    }

    if (toolName === 'report_status') {
      const summary = input['summary'] as string
      this.agentStore.updateStatusText(agentId, summary)
      emitter.emit('status_reported')
      return 'Status reported.'
    }

    if (toolName === 'respond_to_message') {
      const response = input['response'] as string
      this.agentStore.updateStatusText(agentId, response)
      if (options.parentAgentId) {
        this.inboxStore.write(options.parentAgentId, 'update',
          `[Response from sub-agent ${agentId}]: ${response}`)
        this.emitters.get(options.parentAgentId)?.emit('inbox')
      } else {
        this.queueStore.enqueue({
          type: 'agent_response', id: generateId('qe'),
          agentId, response, createdAt: now(),
        }, PRIORITY.AGENT_RESPONSE)
      }
      return 'Response sent.'
    }

    const entry = toolMap.get(toolName)
    if (!entry) return `Unknown tool: ${toolName}`
    return entry.execute(input, ctx)
  }

  // ─── Sub-agent spawning ──────────────────────────────────────────────────────

  private async handleSpawnAgent(
    parentId: string,
    parentOptions: SpawnOptions,
    input: Record<string, unknown>,
    history: Message[],
  ): Promise<string> {
    // Prevent runaway nesting: sub-agents cannot spawn sub-sub-agents.
    // An agent that itself has a parent is already a sub-agent — stop there.
    if (parentOptions.parentAgentId) {
      return JSON.stringify({ error: true, message: 'Sub-agents cannot spawn further sub-agents. Complete your task directly using the available tools.' })
    }

    // Read child task prompt once; used by the steward gate and as the spawn payload below.
    const childTaskPrompt = input['prompt'] as string

    // Steward gate (STEW-01..08, D-12). Skipped entirely when flag is off → byte-equivalent to pre-steward behavior.
    if (this.spawnAgentStewardEnabled) {
      const recent = history
        .filter((m): m is TextMessage => m.kind === 'text')
        .slice(-4)
        .map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
      const decision = await runSpawnAgentSteward(
        parentOptions.prompt,
        childTaskPrompt,
        recent,
        this.llmRouter,
        this.stewardModel,
        this.usageStore,
        undefined,
        parentOptions.onDebug,
      )
      if (!decision.pass) {
        const reason = decision.reason || 'delegate only when you need a fresh context window or separate domain'
        log.warn('[steward:spawn-agent] rejected spawn: ' + reason)
        parentOptions.onDebug?.(`\`[steward-spawn-agent]\` rejected: ${reason}`)
        return JSON.stringify({ error: true, message: `delegation rejected — ${reason}` })
      }
    }

    const modelArg = input['model'] as string | undefined
    const model = modelArg ?? parentOptions.model ?? this.agentModel

    const descriptionArg = input['description'] as string | undefined
    const childOptions: SpawnOptions = {
      prompt: childTaskPrompt,
      model,
      trigger: 'ad_hoc',
      parentAgentId: parentId,
      ...(descriptionArg ? { name: descriptionArg } : {}),
      ...(parentOptions.onDebug ? { onDebug: parentOptions.onDebug } : {}),
    }

    const subAgentId = await this.spawn(childOptions)
    return JSON.stringify({ subAgentId })
  }

}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForInbox(emitter: EventEmitter, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { emitter.off('inbox', handler); resolve() }, timeoutMs)
    const handler = () => { clearTimeout(timer); resolve() }
    emitter.once('inbox', handler)
  })
}
