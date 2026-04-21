/**
 * Shared helpers for integration tests.
 *
 * Tests are skipped automatically when ANTHROPIC_API_KEY is not set.
 * All tiers map to claude-haiku-4-5-20251001 to keep costs low.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, transaction } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { AgentStore } from '../../src/db/agents.js'
import { AgentInboxStore } from '../../src/db/agent_inbox.js'
import { QueueStore } from '../../src/db/queue.js'
import { UsageStore } from '../../src/db/usage.js'
import { MessageStore } from '../../src/db/messages.js'
import { AppStateStore } from '../../src/db/app_state.js'
import { ScheduleStore } from '../../src/db/schedules.js'
import { AnthropicProvider } from '../../src/llm/anthropic.js'
import { SingleProviderRouter } from '../../src/llm/router.js'
import { LocalAgentRunner } from '../../src/sub-agents/local.js'
import type { LLMRouter } from '../../src/types/llm.js'
import type { SkillLoader } from '../../src/types/skill.js'
import type { McpRegistry } from '../../src/mcp/registry.js'
import type { IdentityLoader } from '../../src/identity/loader.js'
import type { ChannelRouter, ChannelAdapter } from '../../src/types/channel.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
export const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

// ─── API key guard ────────────────────────────────────────────────────────────

export const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'] ?? ''
export const HAVE_API_KEY = ANTHROPIC_API_KEY.length > 0

// ─── Real LLM router ─────────────────────────────────────────────────────────

/** All tiers point at Haiku to keep integration test costs minimal. */
const HAIKU = 'claude-haiku-4-5-20251001'

export function makeRealRouter(): LLMRouter {
  const provider = new AnthropicProvider(ANTHROPIC_API_KEY)
  return new SingleProviderRouter(provider, {
    standard: HAIKU,
    capable: HAIKU,
    expert: HAIKU,
  })
}

// ─── In-memory DB ─────────────────────────────────────────────────────────────

export function freshDb() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

// ─── Minimal stubs ───────────────────────────────────────────────────────────

export function makeSkillLoader(): SkillLoader {
  return {
    load: () => null,
    loadByPath: () => null,
    listAll: () => [],
    write: async () => undefined,
    delete: async () => undefined,
    watch: () => undefined,
  }
}

export function makeMcpRegistry(): McpRegistry {
  return {
    listCapabilities: () => [],
    loadTools: async () => [],
  }
}

export function makeIdentityLoader(systemPrompt = 'You are a helpful assistant.'): IdentityLoader {
  return {
    loadSystemPrompt: () => systemPrompt,
    listFiles: () => ['AGENT.md'],
    readFile: () => systemPrompt,
  }
}

/** Channel router that captures sent messages for assertions. */
export function makeChannelRouter(): ChannelRouter & { sent: Array<{ channel: string; text: string }> } {
  const sent: Array<{ channel: string; text: string }> = []
  return {
    sent,
    register: (_adapter: ChannelAdapter) => {},
    send: async (channel: string, text: string) => { sent.push({ channel, text }) },
    sendDebug: async (_channel: string, _text: string) => {},
    sendTyping: async (_channel: string) => {},
    getLastActiveChannel: () => null,
    getFirstChannel: () => null,
  }
}

// ─── Agent runner factory ─────────────────────────────────────────────────────

export interface RunnerBundle {
  runner: LocalAgentRunner
  agentStore: AgentStore
  inboxStore: AgentInboxStore
  queueStore: QueueStore
  usageStore: UsageStore
}

export interface MakeRunnerOpts {
  nestedAgentSpawningEnabled?: boolean
  spawnAgentStewardEnabled?: boolean
}

export function makeRunner(llmRouter: LLMRouter, db = freshDb(), opts?: MakeRunnerOpts): RunnerBundle {
  const agentStore = new AgentStore(db)
  const inboxStore = new AgentInboxStore(db)
  const queueStore = new QueueStore(db)
  const usageStore = new UsageStore(db, 'UTC')

  const runner = new LocalAgentRunner({
    agentStore,
    inboxStore,
    queueStore,
    usageStore,
    skillLoader: makeSkillLoader(),
    skillsDir: '/tmp',
    workspacePath: '/tmp',
    mcpRegistry: makeMcpRegistry(),
    identityLoader: makeIdentityLoader(),
    agentIdentityLoader: makeIdentityLoader(),
    llmRouter,
    pollIntervalMs: 200,
    timezone: 'UTC',
    checkStatusTimeoutMs: 10_000,
    nestedAgentSpawningEnabled: opts?.nestedAgentSpawningEnabled,
    spawnAgentStewardEnabled: opts?.spawnAgentStewardEnabled,
  })

  return { runner, agentStore, inboxStore, queueStore, usageStore }
}

// ─── Token logging ────────────────────────────────────────────────────────────

/** Print a compact token summary that shows up in vitest verbose output. */
export function logTokens(usage: UsageStore): void {
  const { inputTokens, outputTokens } = usage.summarize()
  const total = inputTokens + outputTokens
  console.log(`  [tokens] in=${inputTokens.toLocaleString()}  out=${outputTokens.toLocaleString()}  total=${total.toLocaleString()}`)
}

// ─── Head activation helpers ──────────────────────────────────────────────────

export function makeHeadBundle(llmRouter: LLMRouter) {
  const db = freshDb()
  const messages = new MessageStore(db)
  const agents = new AgentStore(db)
  const queue = new QueueStore(db)
  const usage = new UsageStore(db, 'UTC')
  const appState = new AppStateStore(db)
  const schedules = new ScheduleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'int-schedules-')))
  const channelRouter = makeChannelRouter()

  const tx = (fn: () => void) => transaction(db, fn)

  return { db, messages, workers: agents, queue, usage, appState, schedules, channelRouter, tx }
}
