import { z } from 'zod'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sync as writeFileAtomic } from 'write-file-atomic'

const WorkerDefaultsSchema = z.object({
  // Env vars available to bash subprocesses in ad hoc workers. null = unrestricted (full process.env).
  env: z.array(z.string()).nullable().default(null),
  // Tool allowlist for ad hoc workers. null = unrestricted (all tools).
  allowedTools: z.array(z.string()).nullable().default(null),
}).default({})

const ConfigSchema = z.object({
  // LLM
  llmProvider: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),  // derived from priority[0] at load time
  llmProviderPriority: z.array(z.enum(['anthropic', 'gemini', 'openai'])).default(['anthropic']),
  anthropicApiKey: z.string().optional(),
  anthropicModelStandard: z.string().default('claude-haiku-4-5-20251001'),
  anthropicModelCapable: z.string().default('claude-sonnet-4-6'),
  anthropicModelExpert: z.string().default('claude-opus-4-6'),
  geminiApiKey: z.string().optional(),
  geminiModelStandard: z.string().default('gemini-3.1-flash-lite-preview'),
  geminiModelCapable: z.string().default('gemini-3-flash-preview'),
  geminiModelExpert: z.string().default('gemini-3.1-pro-preview'),
  openaiApiKey: z.string().optional(),
  openaiModelStandard: z.string().default('gpt-5.4-mini'),
  openaiModelCapable: z.string().default('gpt-5.4'),
  openaiModelExpert: z.string().default('gpt-5.4-pro'),

  // Role-based model selection — each accepts a tier name ('standard','capable','expert')
  // or a direct model ID. Router resolves tier names to concrete model IDs transparently.
  headModel:     z.string().default('capable'),   // head conversation
  agentModel:    z.string().default('capable'),   // default for spawned agents
  composerModel: z.string().default('standard'),  // legacy — unused, kept for backward compat
  stewardModel:    z.string().default('standard'),  // loop steward, summaries, internal reasoning
  memoryModel:   z.string().default('standard'),  // legacy fallback — unused if chunking/archival/retrieval set
  memoryChunkingModel:  z.string().default('capable'),  // topic segmentation + labels + entities (runs on every chunk call)
  memoryArchivalModel:  z.string().default('standard'),  // compressing aged chunks into dense summaries (rarer)
  memoryRetrievalModel: z.string().default('standard'),  // topic routing (retrieval-time)

  // Channels
  discordBotToken: z.string().optional(),
  discordChannelId: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  slackBotToken: z.string().optional(),
  slackAppToken: z.string().optional(),
  slackChannelId: z.string().optional(),
  whatsappAllowedJid: z.string().optional(),
  zohoCliqChatId: z.string().optional(),
  zohoCliqPollInterval: z.coerce.number().default(10_000),
  voicePort: z.coerce.number().default(8765),

  // Webhook
  webhookPort: z.coerce.number().default(8766),
  webhookSecret: z.string().optional(),
  webhookRateLimitPerMinute: z.coerce.number().default(60),

  // Path to mcp.json — maps capability names to MCP server configs.
  // Silently ignored if the file does not exist.
  mcpConfigPath: z.string().default('./mcp.json'),
  // Timeout (ms) for MCP stdio operations: connect, listTools, and tool calls.
  mcpTimeoutMs: z.coerce.number().default(30_000),

  // Paths
  dbPath: z.string(),
  migrationsDir: z.string().default('./sql'),
  workspacePath: z.string().default('~/.shrok/workspace'),
  skillsDir: z.string().optional(),  // overrides default workspace/skills location
  identityDir: z.string(),

  // Behavior
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  llmMaxTokens: z.coerce.number().default(16384),
  // Token budget for the context snapshot passed to each spawned agent (head history they can see).
  snapshotTokenBudget: z.coerce.number().default(100_000),
  // Hard ceiling on total assembled context per turn (tokens). Acts as a safety
  // cap, NOT an operating budget — memory retrieval auto-scales below this and
  // typically pulls only what's relevant to the query, so this number only matters
  // when many memories are pulled at once. Raise it if dense-recall turns ever feel
  // truncated; lower it to bound worst-case cost/latency. Default 100,000.
  contextWindowTokens: z.coerce.number().default(100_000),
  // Fraction of the context window at which archival triggers (0–1).
  archivalThresholdFraction: z.coerce.number().default(0.80),
  // Total token budget for a head activation's assembled context.
  contextAssemblyTokenBudget: z.coerce.number().default(100_000),
  // IANA timezone identifier (e.g. "America/New_York") used for day/week/month boundaries
  // in usage tracking and the daily spend circuit breaker. Defaults to the host's
  // detected zone, or "UTC" if it can't be resolved (e.g. in a stripped Docker image).
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  // Whether the relay steward condenses agent work before the head sees it.
  // When false, full agent work history flows through — richer but more expensive.
  // Pre-pass on user messages to hint at the best approach (skill, tool, agent).
  routingStewardEnabled: z.coerce.boolean().default(false),
  relaySummary: z.coerce.boolean().default(true),
  // Post-process head responses with a haiku steward to remove agent leaks and suppress filler.
  headRelaySteward: z.coerce.boolean().default(false),
  // Token budget for recent conversation context given to the head relay steward.
  headRelayStewardContextTokens: z.coerce.number().min(100).max(10000).default(2000),
  // Token budget for conversation context given to the resume steward (validates answers to paused agents).
  resumeStewardContextTokens: z.coerce.number().min(500).max(20000).default(4000),
  // When true, agents receive classified + edited head history (premium — extra LLM calls).
  // When false, agents receive only their spawn prompt (cheap, no cross-contamination).
  agentContextComposer: z.coerce.boolean().default(false),
  // When true, message_agent can resume completed agents with new instructions.
  agentContinuationEnabled: z.coerce.boolean().default(true),
  // Steward that validates message_agent calls before passing them to running/completed agents.
  // Off by default — when on, rejects head check-ins that don't reflect real user intent.
  messageAgentStewardEnabled: z.coerce.boolean().default(false),
  // Allow head-spawned agents to themselves spawn one level of children.
  // Max depth: 1 (no sub-agents) when false, 2 (sub-agents can spawn one
  // layer of sub-sub-agents, but no deeper) when true. Enforced at tool-
  // assembly time in src/sub-agents/tool-surface.ts: an agent receives
  // `spawn_agent` iff this flag is true AND its own `parentAgentId` is
  // null. Defense-in-depth: src/sub-agents/local.ts handleSpawnAgent also
  // rejects at runtime if the caller already has a parent. Default off —
  // runaway token spend from sub-sub-agent fanout is the failure mode we
  // want to force operators to opt into. See NEST-01..07, CFG-01, CFG-02.
  nestedAgentSpawningEnabled: z.coerce.boolean().default(false),
  // When true, a standard-tier LLM steward gates every depth-1 spawn_agent
  // call before the spawn executes, returning pass/reject + a short reason.
  // On reject the spawn_agent tool returns an instruction-shaped error
  // ("delegation rejected — <reason>") so the parent
  // self-executes. Structurally mirrors runMessageAgentSteward
  // (src/head/steward.ts:415). Independent of nestedAgentSpawningEnabled;
  // turning this off does not turn nesting off. Default true. See STEW-*,
  // CFG-03, CFG-04. Consumed by Phase 2, not this phase.
  spawnAgentStewardEnabled: z.coerce.boolean().default(false),
  // Steward that decides whether a scheduled task's output should reach the user.
  scheduledRelayStewardEnabled: z.coerce.boolean().default(true),
  // Steward that validates answers being passed to suspended agents.
  resumeStewardEnabled: z.coerce.boolean().default(true),
  // Steward that nudges the head to finish first-time onboarding.
  bootstrapStewardEnabled: z.coerce.boolean().default(true),
  // Conversation detail (moved from app_state in Phase 17). Each flag controls a
  // category of behind-the-scenes activity surfaced in the dashboard conversation
  // view and debug channel echo. visAgentWork defaults on; others default off.
  visAgentWork: z.coerce.boolean().default(true),
  visHeadTools: z.coerce.boolean().default(false),
  visSystemEvents: z.coerce.boolean().default(false),
  visStewardRuns: z.coerce.boolean().default(false),
  visAgentPills: z.coerce.boolean().default(false),
  visMemoryRetrievals: z.coerce.boolean().default(false),
  // Per-message footer showing estimated cost + token usage on assistant messages.
  usageFootersEnabled: z.coerce.boolean().default(false),
  // Post-activation steward: nudges the head to call write_identity when the user stated
  // a fact or preference that wasn't captured. On by default — prompt is conservative.
  preferenceStewardEnabled: z.coerce.boolean().default(true),
  // Post-activation steward: nudges the head when it committed to a spawn but didn't call
  // spawn_agent/message_agent/cancel_agent. Off by default — observe before enabling.
  spawnStewardEnabled: z.coerce.boolean().default(false),
  // Post-activation steward: checks for missed spawns, hallucinated current facts, and
  // computed answers that should have been delegated. Overlaps spawnSteward by design.
  // Off by default — noisier than the other two, user opts in explicitly.
  actionComplianceStewardEnabled: z.coerce.boolean().default(false),
  // Steward that trims older conversation history before the head LLM call (Haiku-based).
  // Reduces token cost when the head runs on an expensive model. Off by default.
  contextRelevanceStewardEnabled: z.coerce.boolean().default(false),
  // Percentage of available context budget allocated to memory retrieval (0–100).
  // The remainder is the recent conversation history budget — this is the knob that
  // actually shapes per-turn behavior. Memory side is a CEILING the router rarely
  // hits (it pulls only what's relevant); history side is a real budget the head
  // fills up to. Raise % for stronger long-term recall at the cost of less recent
  // chat in context; lower % to keep more verbatim recent history. Default 45%.
  memoryBudgetPercent: z.coerce.number().min(0).max(100).default(45),
  // Number of recent messages the query rewriter reads to resolve pronouns and references
  // before memory retrieval. 0 = disabled (raw trigger text used as-is). Default 6.
  memoryQueryContextTokens: z.coerce.number().min(0).max(50000).default(3000),
  // Token budget for the conversation history passed to stewards (preference, compliance, etc.).
  stewardContextTokenBudget: z.coerce.number().default(10_000),
  // Loop detection: how many consecutive rounds with identical tool+args before the LLM steward is invoked.
  loopSameArgsTrigger: z.coerce.number().min(2).default(3),
  // Loop detection: how many consecutive errors from the same tool before the LLM steward is invoked.
  loopErrorTrigger: z.coerce.number().min(1).default(2),
  // Loop detection: after a nudge, how many more errors before aborting.
  loopPostNudgeErrorTrigger: z.coerce.number().min(1).default(1),
  // Loop steward: max characters of each tool call's input shown to the steward.
  loopStewardToolInputChars: z.coerce.number().min(50).default(200),
  // Loop steward: max characters of each tool result shown to the steward.
  loopStewardToolResultChars: z.coerce.number().min(50).default(300),
  // Max chars of agent-visible tool OUTPUT before middle-truncation at the dispatch layer.
  // 0 or negative disables truncation (passthrough). See src/sub-agents/output-cap.ts.
  toolOutputMaxChars: z.coerce.number().default(30_000),
  // Loop steward: max characters of the system prompt shown to the steward.
  loopStewardSystemPromptChars: z.coerce.number().min(100).default(500),
  // Loop steward: max output tokens for the steward's response.
  loopStewardMaxTokens: z.coerce.number().min(32).default(128),
  traceHistoryTokens: z.coerce.number().default(2000),
  // Proactive scheduling — Phase 1: shadow mode (log decisions only), Phase 2: live gating
  proactiveShadow: z.coerce.boolean().default(false),
  proactiveEnabled: z.coerce.boolean().default(true),

  // Dashboard
  dashboardPort: z.coerce.number().default(8888),
  dashboardHost: z.string().default('127.0.0.1'),
  dashboardPasswordHash: z.string().optional(),
  dashboardHttps: z.coerce.boolean().default(false),

  // Webhook
  webhookHost: z.string().default('127.0.0.1'),

  // Worker defaults — apply to ad hoc workers (no skill). Skills override via frontmatter.
  workerDefaults: WorkerDefaultsSchema,
})

export type Config = z.infer<typeof ConfigSchema>

function loadJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function loadConfig(): Config {
  const baseJsonPath = './config.json'
  const baseJson = loadJsonFile(baseJsonPath)
  const rawWorkspace =
    process.env['WORKSPACE_PATH'] ??
    (baseJson['workspacePath'] as string | undefined) ??
    '~/.shrok/workspace'
  const resolvedWorkspace = rawWorkspace.replace(/^~/, os.homedir())
  const userConfigPath = process.env['USER_CONFIG_PATH'] ?? path.join(resolvedWorkspace, 'config.json')

  // User config lives in the workspace folder — "what I've changed from the defaults."
  const userJson = loadJsonFile(userConfigPath)

  // Deep-merge workerDefaults from JSON sources; user overrides base field-by-field
  const jsonWorkerDefaults = {
    ...(baseJson['workerDefaults'] as Record<string, unknown> ?? {}),
    ...(userJson['workerDefaults'] as Record<string, unknown> ?? {}),
  }
  // Merge, then strip null/empty-string values so null in config means "not set, use default."
  // This lets users write null in their workspace config to reset a field to its default.
  const merged = {
    ...baseJson,
    ...userJson,
    ...(Object.keys(jsonWorkerDefaults).length > 0 ? { workerDefaults: jsonWorkerDefaults } : {}),
  }
  // Provider choices are env-only — strip from JSON so config.json cannot set them
  delete (merged as Record<string, unknown>)['llmProvider']

  const jsonConfig = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== null && (typeof v !== 'string' || v !== ''))
  )

  // Resolve identity dir: explicit config override, or default to workspace/identity.
  const rawIdentity = typeof jsonConfig['identityDir'] === 'string' ? jsonConfig['identityDir'] as string : undefined
  const resolvedIdentity = rawIdentity
    ? rawIdentity.replace(/^~/, os.homedir())
    : path.join(resolvedWorkspace, 'identity')

  // Resolve db path: explicit config override, or default to workspace/data/shrok.db.
  const rawDbPath = typeof jsonConfig['dbPath'] === 'string' ? jsonConfig['dbPath'] as string : undefined
  const resolvedDbPath = rawDbPath ?? path.join(resolvedWorkspace, 'data', 'shrok.db')

  // Secrets and provider choices come from env vars.
  // Everything else belongs in the config file.
  const secrets = {
    llmProvider: process.env['LLM_PROVIDER'],
    llmProviderPriority: process.env['LLM_PROVIDER_PRIORITY']
      ? process.env['LLM_PROVIDER_PRIORITY'].split(',').map(s => s.trim())
      : process.env['LLM_PROVIDER']
        ? [process.env['LLM_PROVIDER']]
        : undefined,
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    geminiApiKey: process.env['GEMINI_API_KEY'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
    discordBotToken: process.env['DISCORD_BOT_TOKEN'],
    discordChannelId: process.env['DISCORD_CHANNEL_ID'],
    telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'],
    telegramChatId: process.env['TELEGRAM_CHAT_ID'],
    slackBotToken: process.env['SLACK_BOT_TOKEN'],
    slackAppToken: process.env['SLACK_APP_TOKEN'],
    slackChannelId: process.env['SLACK_CHANNEL_ID'],
    whatsappAllowedJid: process.env['WHATSAPP_ALLOWED_JID'],
    webhookSecret: process.env['WEBHOOK_SECRET'],
    dashboardPasswordHash: process.env['DASHBOARD_PASSWORD_HASH'],
    workspacePath: process.env['WORKSPACE_PATH'],  // bootstrap — also used above
  }

  const filteredSecrets = Object.fromEntries(
    Object.entries(secrets).filter(([, v]) => v !== undefined && v !== '')
  )

  const result = ConfigSchema.safeParse({ ...jsonConfig, identityDir: resolvedIdentity, dbPath: resolvedDbPath, ...filteredSecrets })
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Configuration error:\n${issues}`)
  }

  // Derive llmProvider from priority list (single source of truth)
  result.data.llmProvider = result.data.llmProviderPriority[0] ?? 'anthropic'

  // Ensure workspacePath has ~ resolved — the Zod default doesn't expand it
  result.data.workspacePath = result.data.workspacePath.replace(/^~/, os.homedir())

  return result.data
}

// Config fields whose values should be masked in log output.
const SECRET_FIELDS = [
  'anthropicApiKey',
  'geminiApiKey',
  'openaiApiKey',
  'discordBotToken',
  'telegramBotToken',
  'slackBotToken',
  'slackAppToken',
  'webhookSecret',
  'dashboardPasswordHash',
] as const satisfies ReadonlyArray<keyof Config>

/** Extract populated secret string values from a Config for log redaction registration. */
export function extractSecretValues(config: Config): string[] {
  return SECRET_FIELDS
    .map(f => config[f])
    .filter((v): v is string => typeof v === 'string' && v.length >= 8)
}

// Env vars that `config:set` is allowed to write. Mirrors the secrets read by
// loadConfig (minus WORKSPACE_PATH which is a bootstrap path, not a credential).
// Single source of truth — the setter and the reader cannot drift.
export const ENV_KEY_ALLOWLIST = [
  'LLM_PROVIDER',
  'LLM_PROVIDER_PRIORITY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_CHANNEL_ID',
  'WHATSAPP_ALLOWED_JID',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_CLIQ_CHAT_ID',
  'SEARCH_PROVIDER',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'WEBHOOK_SECRET',
] as const

/**
 * Merge `patch` into {workspacePath}/config.json, preserving all other existing keys.
 * Creates the file (and parent directory) if missing. No-op if patch is empty.
 *
 * Used by the dashboard Settings PUT handler and by slash commands that mutate
 * behavioral config (e.g. ~debug, ~xray). Single write path keeps the file-format
 * concerns (2-space indent, trailing newline) in one place.
 */
export function updateUserConfig(patch: Partial<Config>, workspacePath: string): void {
  const keys = Object.keys(patch)
  if (keys.length === 0) return
  const resolvedWorkspace = workspacePath.replace(/^~/, os.homedir())
  const configPath = path.join(resolvedWorkspace, 'config.json')
  const current = loadJsonFile(configPath)
  const merged: Record<string, unknown> = { ...current }
  for (const k of keys) {
    merged[k] = (patch as Record<string, unknown>)[k]
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileAtomic(configPath, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8' })
}
