/**
 * System factory — the single entry point for wiring the Shrok model.
 *
 * Both production (src/index.ts) and evals (scripts/eval/harness.ts) call
 * buildSystem() with their own external dependencies. The internal wiring
 * (stores, loaders, runners, assembler, injector, activation loop) is
 * identical in both cases.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transaction } from './db/index.js'
import { MessageStore } from './db/messages.js'
import { AgentStore } from './db/agents.js'
import { AgentInboxStore } from './db/agent_inbox.js'
import { ScheduleStore } from './db/schedules.js'
import { NoteStore } from './db/notes.js'
import { QueueStore } from './db/queue.js'
import { UsageStore } from './db/usage.js'
import { AppStateStore } from './db/app_state.js'
import { writeAssistantName } from './config-file.js'
import { StewardRunStore } from './db/steward_runs.js'
import { createTopicMemory } from './memory/index.js'
import { FileSystemKindLoader, FileSystemSkillLoader } from './skills/loader.js'
import { UnifiedLoader } from './skills/unified.js'
import { LocalAgentRunner } from './sub-agents/local.js'
import { FileSystemIdentityLoader } from './identity/loader.js'
import { InjectorImpl } from './head/injector.js'
import { ContextAssemblerImpl } from './head/assembler.js'
import { HEAD_TOOLS } from './head/index.js'
import { ActivationLoop } from './head/activation.js'
import type { DatabaseSync } from './db/index.js'
import type { Config } from './config.js'
import type { LLMRouter, ToolDefinition } from './types/llm.js'
import type { ChannelRouter } from './types/channel.js'
import type { McpRegistry } from './mcp/registry.js'
import type { ContextAssembler } from './head/assembler.js'
import type { AgentRunner } from './types/agent.js'
import type { SkillLoader } from './types/skill.js'
import type { IdentityLoader } from './identity/loader.js'
import type { Memory } from './memory/index.js'
import type { DashboardEventBus } from './dashboard/events.js'
import type { Steward } from './head/steward.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Stores {
  messages: MessageStore
  agents: AgentStore
  queue: QueueStore
  usage: UsageStore
  appState: AppStateStore
  schedules: ScheduleStore
  notes: NoteStore
  stewardRuns: StewardRunStore
  agentInbox: AgentInboxStore
}

export interface SystemDeps {
  /** SQLite database — file-backed in production, :memory: in evals. */
  db: DatabaseSync
  /** Fully resolved config. */
  config: Config
  /** LLM provider router. */
  llmRouter: LLMRouter
  /** Channel router — real ChannelRouterImpl in production, mock in evals. */
  channelRouter: ChannelRouter
  /** MCP tool registry — real in production, stub in evals. */
  mcpRegistry: McpRegistry

  // ── Optional overrides ──────────────────────────────────────────────────

  /** Pre-created stores — all-or-nothing. If provided, buildSystem uses them.
   *  If omitted, buildSystem creates all stores from deps.db. */
  stores?: Stores
  /** Dashboard event bus for SSE updates. Production passes a real bus. */
  dashboardEventBus?: DashboardEventBus
  /** Activation loop poll interval. Default: undefined (uses ActivationLoop default). Evals use 200ms. */
  pollIntervalMs?: number
  /** Wrap the real assembler (e.g. eval CapturingAssembler). Applied after construction. */
  assemblerWrapper?: (assembler: ContextAssembler) => ContextAssembler
  /** Override HEAD_TOOLS for testing. */
  headTools?: ToolDefinition[]
  /** Override terminal tool names for testing. */
  terminalToolNames?: string[]
  /** Override the note returned in spawn_agent tool results. */
  spawnAgentNote?: string
  /** Replace agent runner with a no-op stub. */
  stubAgentRunner?: boolean
  /** Override config.agentContextComposer for this build. */
  agentContextComposer?: boolean
  /** Pre-created topic memory — if provided, buildSystem uses it instead of creating one. */
  topicMemory?: Memory
  /** Override stewards for testing (e.g. [] to disable all stewards). */
  stewards?: Steward[]
}

export interface System {
  activationLoop: ActivationLoop
  agentRunner: AgentRunner
  stores: Stores
  topicMemory: Memory
  skillLoader: SkillLoader
  identityLoader: IdentityLoader
  agentIdentityLoader: IdentityLoader
  config: Config
  systemSkillNames: Set<string>
  taskKindLoader: FileSystemKindLoader
  unifiedLoader: UnifiedLoader
  tx: (fn: () => void) => void
}

// ─── Identity defaults paths ─────────────────────────────────────────────────

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const IDENTITY_DEFAULTS_DIR = path.resolve(SRC_DIR, 'identity', 'defaults')
const AGENT_IDENTITY_DEFAULTS_DIR = path.resolve(SRC_DIR, 'identity', 'sub-agents')

// ─── Factory ─────────────────────────────────────────────────────────────────

export function buildSystem(deps: SystemDeps): System {
  const { db, config, llmRouter, channelRouter, mcpRegistry } = deps

  // ── Workspace path (needed for file-backed stores and memory) ───────────
  const workspacePath = config.workspacePath.replace(/^~/, os.homedir())

  // ── Stores ──────────────────────────────────────────────────────────────
  const stores: Stores = deps.stores ?? {
    messages: new MessageStore(db, deps.dashboardEventBus),
    agents: new AgentStore(db, deps.dashboardEventBus),
    queue: new QueueStore(db),
    usage: new UsageStore(db, config.timezone),
    appState: new AppStateStore(db),
    schedules: new ScheduleStore(path.join(workspacePath, 'schedules')),
    notes: new NoteStore(db),
    stewardRuns: new StewardRunStore(db, deps.dashboardEventBus),
    agentInbox: new AgentInboxStore(db),
  }

  // ── Topic Memory ────────────────────────────────────────────────────────
  const makeMemoryLlm = (model: string) => (system: string, user: string) =>
    llmRouter.complete(
      model,
      [{ kind: 'text' as const, id: 'mem-llm', role: 'user' as const, content: user, createdAt: new Date().toISOString() }],
      [], { systemPrompt: system, maxTokens: 8192 },
    ).then(r => r.content)

  // workspacePath already resolved above (before stores block)

  const topicMemory = deps.topicMemory ?? createTopicMemory(
    path.join(workspacePath, 'topics'),
    makeMemoryLlm(config.memoryArchivalModel),
    undefined,
    makeMemoryLlm(config.memoryArchivalModel),
    config.memoryRetrievalModel !== config.memoryArchivalModel
      ? makeMemoryLlm(config.memoryRetrievalModel)
      : undefined,
    config.memoryChunkingModel !== config.memoryArchivalModel
      ? makeMemoryLlm(config.memoryChunkingModel)
      : undefined,
  )

  // ── Skills ──────────────────────────────────────────────────────────────
  const skillsPath = config.skillsDir
    ? path.resolve(config.skillsDir)
    : path.join(workspacePath, 'skills')
  fs.mkdirSync(skillsPath, { recursive: true })

  // Seed workspace with system skills that aren't already present
  const systemSkillsPath = path.resolve(SRC_DIR, '../skills')
  const systemSkillNames = new Set<string>()
  try {
    for (const entry of fs.readdirSync(systemSkillsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      systemSkillNames.add(entry.name)
      const dest = path.join(skillsPath, entry.name)
      if (!fs.existsSync(dest)) {
        fs.cpSync(path.join(systemSkillsPath, entry.name), dest, { recursive: true })
      }
    }
  } catch { /* system skills dir missing (e.g. test env) — skip seeding */ }

  // Construct kind-scoped loaders directly (FileSystemKindLoader) so the kind
  // field is accurate. The skills-scoped loader is what every existing consumer
  // (injector, assembler, tool-surface) receives — tasks stay structurally
  // invisible to those paths per ISO-01.
  const skillKindLoader = new FileSystemKindLoader({ root: skillsPath, kind: 'skill', filename: 'SKILL.md' })
  const skillLoader: SkillLoader = skillKindLoader

  // ── Tasks (v1.1, Plan 04-01) ─────────────────────────────────────────────
  const tasksPath = path.join(workspacePath, 'tasks')
  fs.mkdirSync(tasksPath, { recursive: true })

  // Seed workspace with bundled tasks that aren't already present (mirrors skills seeding)
  const systemTasksPath = path.resolve(SRC_DIR, '../tasks')
  try {
    for (const entry of fs.readdirSync(systemTasksPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dest = path.join(tasksPath, entry.name)
      if (!fs.existsSync(dest)) {
        fs.cpSync(path.join(systemTasksPath, entry.name), dest, { recursive: true })
      }
    }
  } catch { /* system tasks dir missing (e.g. test env) — skip seeding */ }
  const taskKindLoader = new FileSystemKindLoader({ root: tasksPath, kind: 'task', filename: 'TASK.md' })
  const unifiedLoader = new UnifiedLoader(skillKindLoader, taskKindLoader)
  unifiedLoader.warnCollisions()

  // ── Identity ────────────────────────────────────────────────────────────
  const identityDir = config.identityDir
  const identityLoader: IdentityLoader = new FileSystemIdentityLoader(identityDir, IDENTITY_DEFAULTS_DIR)
  const agentIdentityLoader: IdentityLoader = new FileSystemIdentityLoader(
    path.join(workspacePath, 'sub-agents'),
    AGENT_IDENTITY_DEFAULTS_DIR,
  )

  // ── Agent Runner ────────────────────────────────────────────────────────
  const agentContextComposer = deps.agentContextComposer ?? config.agentContextComposer
  const agentRunner: AgentRunner = deps.stubAgentRunner
    ? {
        spawn: async () => 'stub',
        update: async () => {},
        signal: async () => {},
        retract: async () => {},
        checkStatus: async () => ({ text: '', stale: true }),
        awaitAll: async () => {},
      }
    : new LocalAgentRunner({
        agentStore: stores.agents,
        inboxStore: stores.agentInbox,
        queueStore: stores.queue,
        usageStore: stores.usage,
        scheduleStore: stores.schedules,
        noteStore: stores.notes,
        appState: stores.appState,
        skillLoader,
        unifiedLoader,
        skillsDir: skillsPath,
        workspacePath,
        mcpRegistry,
        identityLoader,
        agentIdentityLoader,
        llmRouter,
        agentDefaults: config.workerDefaults,
        envOverrides: {
          WORKSPACE_PATH: workspacePath,
          SHROK_SKILLS_DIR: skillsPath,
          // Expose the project's model/provider to every spawned agent so skills
          // can keep their own LLM calls in lock-step with shrok's config without
          // guessing. Values may be tier names ('standard'|'capable'|'expert')
          // or direct model IDs — skills can decide how to interpret.
          SHROK_LLM_PROVIDER: config.llmProvider,
          SHROK_AGENT_MODEL: config.agentModel,
          SHROK_STEWARD_MODEL: config.stewardModel,
        },
        archivalThreshold: Math.floor(config.contextWindowTokens * config.archivalThresholdFraction),
        toolOutputMaxChars: config.toolOutputMaxChars,
        timezone: config.timezone,
        agentModel: config.agentModel,
        stewardModel: config.stewardModel,
        snapshotTokenBudget: config.snapshotTokenBudget,
        agentContextComposer,
        nestedAgentSpawningEnabled: config.nestedAgentSpawningEnabled,
        spawnAgentStewardEnabled: config.spawnAgentStewardEnabled,
      })

  // ── Injector ────────────────────────────────────────────────────────────
  const injector = new InjectorImpl(
    stores.messages,
    stores.agents,
    new Set(HEAD_TOOLS.map(t => t.name)),
    config.agentContinuationEnabled,
  )

  // ── Context Assembler ───────────────────────────────────────────────────
  const baseAssembler: ContextAssembler = new ContextAssemblerImpl(
    identityLoader,
    stores.messages,
    stores.agents,
    skillLoader,
    config,
    mcpRegistry,
    undefined,
    topicMemory,
    llmRouter,
  )
  const assembler = deps.assemblerWrapper ? deps.assemblerWrapper(baseAssembler) : baseAssembler

  // ── Identity change callback (extract assistant name from SOUL.md) ────
  const onIdentityChanged = (file: string, content: string) => {
    if (file !== 'SOUL.md') return
    void (async () => {
      try {
        const result = await llmRouter.complete(
          config.stewardModel,
          [{ kind: 'text' as const, id: 'name-extract', role: 'user' as const, content, createdAt: new Date().toISOString() }],
          [{ name: 'extract_name', description: 'Extract the assistant name', inputSchema: {
            type: 'object' as const,
            properties: { name: { type: 'string', description: 'The assistant name found in the file' } },
            required: ['name'],
          }}],
          { systemPrompt: 'Extract the assistant\'s name from this identity file. Call extract_name with the name. If no name is specified, use "Shrok".', maxTokens: 256 },
        )
        const toolCall = result.toolCalls?.[0]
        const name = toolCall ? (JSON.parse(typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input)) as { name: string }).name : 'Shrok'
        writeAssistantName(workspacePath, name)
        deps.dashboardEventBus?.emit('dashboard', { type: 'assistant_name_changed', payload: { name } })
      } catch { /* extraction failed — keep existing name */ }
    })()
  }

  // ── Tool Executor Options ───────────────────────────────────────────────
  const toolExecutorOpts = {
    agentRunner,
    agentStore: stores.agents,
    skillLoader,
    unifiedLoader,
    topicMemory,
    usageStore: stores.usage,
    identityDir,
    identityLoader,
    messages: stores.messages,
    llmRouter,
    stewardModel: config.stewardModel,
    resumeStewardContextTokens: config.resumeStewardContextTokens,
    resumeStewardEnabled: config.resumeStewardEnabled,
    agentContinuationEnabled: config.agentContinuationEnabled,
    messageAgentStewardEnabled: config.messageAgentStewardEnabled,
    onIdentityChanged,
    ...(deps.spawnAgentNote !== undefined ? { spawnAgentNote: deps.spawnAgentNote } : {}),
  }

  // ── Activation Loop ─────────────────────────────────────────────────────
  const tx = (fn: () => void) => transaction(db, fn)

  const activationLoop = new ActivationLoop({
    queueStore: stores.queue,
    messages: stores.messages,
    appState: stores.appState,
    usageStore: stores.usage,
    topicMemory,
    agentStore: stores.agents,
    llmRouter,
    channelRouter,
    assembler,
    injector,
    toolExecutorOpts,
    config,
    scheduleStore: stores.schedules,
    mcpRegistry,
    stewardRunStore: stores.stewardRuns,
    ...(deps.dashboardEventBus ? { events: deps.dashboardEventBus } : {}),
    transaction: tx,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.headTools !== undefined ? { headTools: deps.headTools } : {}),
    ...(deps.terminalToolNames !== undefined ? { terminalToolNames: deps.terminalToolNames } : {}),
    ...(deps.stewards !== undefined ? { stewards: deps.stewards } : {}),
  })

  return {
    activationLoop,
    agentRunner,
    stores,
    topicMemory,
    skillLoader,
    identityLoader,
    agentIdentityLoader,
    config,
    systemSkillNames,
    taskKindLoader,
    unifiedLoader,
    tx,
  }
}
