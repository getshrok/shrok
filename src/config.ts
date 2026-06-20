import { z } from 'zod'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sync as writeFileAtomic } from 'write-file-atomic'
import { HEAD_TOOL_NAMES } from './head/index.js'

const WorkerDefaultsSchema = z.object({
  // Env vars available to bash subprocesses in ad hoc workers. null = unrestricted (full process.env).
  env: z.array(z.string()).nullable().default(null),
  // Tool allowlist for ad hoc workers (the global AGENT layer default).
  // Phase 46 two-state model (D-04/D-05): an explicit string[] is the allowed
  // subset; check every box in the agent picker to "allow everything that layer
  // can run". `null` is ONLY tolerated for backward-compat with pre-Phase-46
  // config.json — it is normalized to fall-through by resolveAllowlist (NOT
  // "all tools" anymore). Because resolveAllowlist falls through legacy-null and
  // there is no further default below the global layer, a legacy `null` here
  // resolves to NO agent tools. The base config.json ships the concrete 25-tool
  // array, so fresh/normal installs never hit the null path. To allow tools, set
  // an explicit array — do not rely on `null = all` (that meaning is gone).
  allowedTools: z.array(z.string()).nullable().default(null),
}).default({})

// ─── Multi-head channel config (Phase 31, CONF-01) ───────────────────────────
// Discriminated union: `vendor` decides which credentials are required.
// The `id` field becomes the adapter's .id (used by ChannelRouter.register
// and stamped on enqueued events as head_id).
export const ChannelConfigSchema = z.discriminatedUnion('vendor', [
  z.object({
    id: z.string().min(1),
    vendor: z.literal('telegram'),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    vendor: z.literal('discord'),
    botToken: z.string().min(1),
    channelId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    vendor: z.literal('slack'),
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    channelId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    vendor: z.literal('whatsapp'),
    allowedJid: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    vendor: z.literal('zoho-cliq'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    vendor: z.literal('home-assistant'),
    haBaseUrl: z.string().url(),
    haVoiceSatelliteEntityId: z.string().regex(
      /^assist_satellite\.[a-z0-9_]+$/,
      'haVoiceSatelliteEntityId must match assist_satellite.<object_id>',
    ),
    haMediaPlayerEntityId: z.string().optional(),  // explicit override; derived if absent (Phase 45 RING-07)
    haLedEntityId: z.string().optional(),          // explicit override; derived if absent (Phase 45 RING-07)
  }),
])

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>

export const HeadConfigSchema = z.object({
  id: z.string().min(1),
  channels: z.array(ChannelConfigSchema),
  customPrompt: z.string().optional(),
  /** Human-friendly name for this head's person (e.g. "Zoey"). Used to address
   *  the head in cross-head relays (message_head) and for attribution. Falls back
   *  to `id` when absent. */
  displayName: z.string().optional(),
  // Per-head tool override fields (TOOLCFG-03, TOOLCFG-04).
  // key-absent = inherit global default, null = all tools, array = only those tools.
  headToolsOverride: z.array(z.string()).nullable().optional(),
  agentToolsOverride: z.array(z.string()).nullable().optional(),
})

export type HeadConfig = z.infer<typeof HeadConfigSchema>

/** Canonical head list produced by resolveHeads() — used by startup wiring. */
export interface ResolvedHead {
  id: string
  channels: ChannelConfig[]
  customPrompt?: string
  /** Human-friendly name for cross-head relay addressing/attribution; falls back to `id`. */
  displayName?: string
  // Per-head tool allowlist overrides (TOOLCFG-03, TOOLCFG-04).
  // key-absent = inherit global default, null = all tools, array = only those tools.
  headToolsOverride?: string[] | null
  agentToolsOverride?: string[] | null
}

/** A dashboard login identity: a display name and an optional head it scopes to. */
const DashboardUserSchema = z.object({
  name: z.string(),
  headId: z.string().optional(),
})

const ConfigSchema = z.object({
  // LLM
  llmProvider: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),  // derived from priority[0] at load time
  llmProviderPriority: z.array(z.enum(['anthropic', 'gemini', 'openai'])).default(['anthropic']),
  anthropicApiKey: z.string().optional(),
  anthropicModelDumb: z.string().default('claude-haiku-4-5-20251001'),
  anthropicModelSmart: z.string().default('claude-sonnet-4-6'),
  anthropicModelGenius: z.string().default('claude-opus-4-6'),
  geminiApiKey: z.string().optional(),
  geminiModelDumb: z.string().default('gemini-3.1-flash-lite-preview'),
  geminiModelSmart: z.string().default('gemini-3-flash-preview'),
  geminiModelGenius: z.string().default('gemini-3.1-pro-preview'),
  openaiApiKey: z.string().optional(),
  openaiModelDumb: z.string().default('gpt-5.4-mini'),
  openaiModelSmart: z.string().default('gpt-5.4'),
  openaiModelGenius: z.string().default('gpt-5.4-pro'),

  // Role-based model selection — each accepts a tier name ('dumb','smart','genius')
  // or a direct model ID. Router resolves tier names to concrete model IDs transparently.
  // Tier heuristic: dumb = trivial lookups, smart = everyday work (default), genius = heavy reasoning.
  headModel:     z.string().default('smart'),   // head conversation
  agentModel:    z.string().default('smart'),   // default for spawned agents; or 'dynamic' = head picks the tier per spawn (#37)
  composerModel: z.string().default('dumb'),  // legacy — unused, kept for backward compat
  stewardModel:    z.string().default('dumb'),  // loop steward, summaries, internal reasoning
  memoryModel:   z.string().default('dumb'),  // legacy fallback — unused if chunking/archival/retrieval set
  memoryChunkingModel:  z.string().default('smart'),  // topic segmentation + labels + entities (runs on every chunk call)
  memoryArchivalModel:  z.string().default('dumb'),  // compressing aged chunks into dense summaries (rarer)
  memoryRetrievalModel: z.string().default('dumb'),  // topic routing (retrieval-time)

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

  // Self-hosted TTS and STT (optional). When `ttsBaseUrl` / `sttBaseUrl` are set,
  // voice output / input use these OpenAI-audio-compatible endpoints as the PRIMARY
  // synthesizer / transcriber and fall back to OpenAI when unreachable (the
  // self-hosted box may be powered off). `voiceOpenaiFallback` (default true) is a
  // single toggle governing OpenAI fallback for BOTH STT and TTS — set to false to
  // keep voice fully self-hosted with no OpenAI calls.
  // These are behavioral settings → config.json, not .env: the self-hosted endpoints
  // are tailnet-scoped and unauthenticated, so there is no secret to keep.
  ttsBaseUrl: z.string().optional(),                       // e.g. http://100.80.122.111:8001/v1
  ttsModel: z.string().default('chatterbox-turbo'),        // self-hosted model id
  ttsVoice: z.string().default('Adrian.wav'),              // self-hosted voice (see GET /v1/audio/voices)
  ttsResponseFormat: z.enum(['mp3', 'wav', 'opus']).default('mp3'),  // audio codec the endpoint returns
  sttBaseUrl: z.string().optional(),                       // e.g. http://100.80.122.111:8000/v1 (self-hosted Whisper)
  voiceOpenaiFallback: z.coerce.boolean().default(true),   // when false, OpenAI is never used as voice fallback (STT or TTS)

  // Webhook
  webhookPort: z.coerce.number().default(8766),
  webhookSecret: z.string().optional(),
  webhookRateLimitPerMinute: z.coerce.number().default(60),

  // Path to mcp.json — maps capability names to MCP server configs.
  // Silently ignored if the file does not exist.
  mcpConfigPath: z.string().default('./mcp.json'),
  // Timeout (ms) for MCP stdio operations: connect, listTools, and tool calls.
  mcpTimeoutMs: z.coerce.number().default(30_000),

  // Timeout (ms) for each channel adapter's start() during boot. A channel
  // whose connect never settles logs and is skipped rather than wedging the
  // whole startup (dashboard, scheduler, and activation loop are gated behind
  // channel bring-up). See issue #40.
  channelStartTimeoutMs: z.coerce.number().default(30_000),

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
  // Total token budget for a head turn's assembled context (system + memory + history).
  // This is the dominant driver of time-to-first-token: prefill latency scales with how
  // many tokens are sent, so a smaller budget makes EVERY turn faster (sporadic or active,
  // cached or cold) at the cost of less retained conversation history and less retrieved
  // memory per turn. Default is 40,000 — a balance between retained context and prefill
  // speed. (The original 100,000 default dragged 20k–90k-token prefills through the head
  // model on routine turns, the main source of perceived slowness; 30,000 was leaner but
  // a bit forgetful.) Raise it (Settings → Behavior, per instance) if a head feels like
  // it's forgetting recent context or missing relevant memories, or lower it for speed.
  contextWindowTokens: z.coerce.number().default(40_000),
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
  // chat in context; lower % to keep more verbatim recent history. Default 30%
  // (70% history / 30% memory) — favors keeping recent back-and-forth in context.
  memoryBudgetPercent: z.coerce.number().min(0).max(100).default(30),
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

  // Ring delivery layer (Phase 45)
  publicBaseUrl: z.string().url().optional(),                          // device-reachable base URL override (RING-08)
  ringVolume: z.coerce.number().min(0).max(1).default(1.0),           // HA media_player volume (0.0–1.0; RING-09). Default max — it's an alarm (issue #19).
  ringCapHours: z.coerce.number().min(1).max(72).default(24),         // auto-dismiss cap in hours (RING-10)

  // Dashboard
  dashboardPort: z.coerce.number().default(8888),
  dashboardHost: z.string().default('127.0.0.1'),
  dashboardPasswordHash: z.string().optional(),
  // Optional backup login password (bcrypt hash). config.json-only — never read
  // from env and never written by the Settings API. Drop a hash here by hand to
  // get a second working password without changing the primary one. Accepts the
  // same login as dashboardPasswordHash.
  dashboardBackupPasswordHash: z.string().optional(),
  dashboardHttps: z.coerce.boolean().default(false),
  // Operator-managed login identities shown as a forced pick at dashboard login.
  // The chosen name is bound to the session and prepended to dashboard messages
  // (`[Ashley]: …`) so a head can tell who's talking; an optional headId scopes the
  // dashboard to that head on login. Empty = no picker, no prefix. Legacy entries
  // stored as bare strings are coerced to { name } for backward compatibility.
  dashboardUsers: z.preprocess(
    v => (Array.isArray(v) ? v.map(u => (typeof u === 'string' ? { name: u } : u)) : v),
    z.array(DashboardUserSchema),
  ).default([]),

  // Webhook
  webhookHost: z.string().default('127.0.0.1'),

  // Worker defaults — apply to ad hoc workers (no skill). Skills override via frontmatter.
  // workerDefaults.allowedTools is the GLOBAL AGENT layer (TOOLCFG-02) — do not duplicate.
  workerDefaults: WorkerDefaultsSchema,
  // Global head-tools default (TOOLCFG-01/07). Two-state:
  //   absent in config.json  → defaults to HEAD_TOOL_NAMES (the 10 head-compatible tools)
  //   [array]                → only those tools
  // Per-head headToolsOverride takes precedence. Legacy null is tolerated at parse time
  // but normalized to fall-through in resolveAllowlist (never means "all tools" in the
  // feature path; D-05).
  headToolDefaults: z.object({
    allowedTools: z.array(z.string()).nullable().default(HEAD_TOOL_NAMES),
  }).default({}),

  // Phase 31 (CONF-01): optional multi-head adapter registry. When present,
  // flat adapter keys above are ignored entirely (D-04). When absent, startup
  // synthesizes a single implicit 'default' head from the flat keys (D-03).
  heads: z.array(HeadConfigSchema).optional(),
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

/**
 * Mapping from legacy tier names to their new equivalents.
 * Exported so tests and the router can share the same canonical map.
 */
export const LEGACY_TIER_ALIAS: Record<string, string> = {
  standard: 'dumb',
  capable: 'smart',
  expert: 'genius',
}

/**
 * Non-destructive in-memory normalizer — converts legacy model config keys and
 * role-default values to the new dumb/smart/genius vocabulary.
 *
 * (1) Provider model keys: if a new key (e.g. `anthropicModelDumb`) is absent but the
 *     legacy key (`anthropicModelStandard`) is present, copy the legacy value into the
 *     new key.  New key always wins when both are present.
 *
 * (2) Role-model field values: if a field value is one of 'standard'/'capable'/'expert',
 *     rewrite it to 'dumb'/'smart'/'genius' via LEGACY_TIER_ALIAS.
 *
 * Does NOT write back to disk — purely in-memory transformation.
 */
export function normalizeLegacyModelConfig(merged: Record<string, unknown>): Record<string, unknown> {
  const out = { ...merged }

  // Provider key migration: Standard→Dumb, Capable→Smart, Expert→Genius
  const providerPairs: Array<[string, string]> = [
    ['anthropicModelStandard', 'anthropicModelDumb'],
    ['anthropicModelCapable', 'anthropicModelSmart'],
    ['anthropicModelExpert', 'anthropicModelGenius'],
    ['geminiModelStandard', 'geminiModelDumb'],
    ['geminiModelCapable', 'geminiModelSmart'],
    ['geminiModelExpert', 'geminiModelGenius'],
    ['openaiModelStandard', 'openaiModelDumb'],
    ['openaiModelCapable', 'openaiModelSmart'],
    ['openaiModelExpert', 'openaiModelGenius'],
  ]
  for (const [legacy, newKey] of providerPairs) {
    // New key wins — only copy legacy if new is absent
    if (!(newKey in out) && legacy in out) {
      out[newKey] = out[legacy]
    }
  }

  // Role-value migration: rewrite tier VALUE strings
  const roleFields = [
    'headModel', 'agentModel', 'composerModel', 'stewardModel',
    'memoryModel', 'memoryChunkingModel', 'memoryArchivalModel', 'memoryRetrievalModel',
  ]
  for (const field of roleFields) {
    const val = out[field]
    if (typeof val === 'string' && val in LEGACY_TIER_ALIAS) {
      out[field] = LEGACY_TIER_ALIAS[val]
    }
  }

  return out
}

/**
 * The curated global AGENT-tool default (Phase 46, D-06/D-07): the concrete
 * agent-tool subset shipped in the base repo `config.json`
 * (`workerDefaults.allowedTools` — the ~25-tool pre-feature set).
 *
 * Phase 46 WR-04: the Settings GET coalesces a legacy-null effective agent
 * default to THIS list (mirroring the head side's coalesce to HEAD_TOOL_NAMES)
 * so the dashboard never presents the agent default as an empty (lock-out)
 * subset on a pre-feature install. Read once from the base config.json so it
 * stays the single source of truth — no hand-duplicated tool list to drift.
 */
export const AGENT_TOOL_DEFAULT: readonly string[] = (() => {
  const base = loadJsonFile('./config.json')
  const wd = base['workerDefaults']
  if (wd && typeof wd === 'object' && !Array.isArray(wd)) {
    const at = (wd as Record<string, unknown>)['allowedTools']
    if (Array.isArray(at) && at.every(v => typeof v === 'string')) {
      return at as string[]
    }
  }
  return []
})()

export function loadConfig(): Config {
  const baseJsonPath = './config.json'
  const baseJson = loadJsonFile(baseJsonPath)
  const rawWorkspace =
    process.env['SHROK_WORKSPACE_PATH'] ??
    process.env['WORKSPACE_PATH'] ??
    (baseJson['workspacePath'] as string | undefined) ??
    '~/.shrok/workspace'
  const resolvedWorkspace = rawWorkspace.replace(/^~/, os.homedir())
  const userConfigPath = process.env['USER_CONFIG_PATH'] ?? path.join(resolvedWorkspace, 'config.json')

  // User config lives in the workspace folder — "what I've changed from the defaults."
  // Normalize legacy model key names and tier-value strings BEFORE merging so that a
  // user's old key (e.g. anthropicModelCapable) is promoted to the new key
  // (anthropicModelSmart) and properly overrides the base config's default value.
  const rawUserJson = loadJsonFile(userConfigPath)
  const userJson = normalizeLegacyModelConfig(rawUserJson)

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

  // Also normalize the base config's legacy keys and role-default values (belt-and-suspenders).
  // The user normalization above handles most cases; this catches a base config that was never
  // updated (should not happen for the repo base config, but covers external base configs).
  const normalizedMerged = normalizeLegacyModelConfig(merged as Record<string, unknown>)

  const jsonConfig = Object.fromEntries(
    Object.entries(normalizedMerged).filter(([, v]) => v !== null && (typeof v !== 'string' || v !== ''))
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
    workspacePath: process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'],  // bootstrap — also used above
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
  'dashboardBackupPasswordHash',
] as const satisfies ReadonlyArray<keyof Config>

/** Extract populated secret string values from a Config for log redaction registration. */
export function extractSecretValues(config: Config): string[] {
  const out: string[] = []
  // Flat top-level secrets (legacy and zero-config path).
  for (const f of SECRET_FIELDS) {
    const v = config[f]
    if (typeof v === 'string' && v.length >= 8) out.push(v)
  }
  // Phase 31 (CONF-01): walk heads[].channels and pull every inline credential.
  // The discriminated union shape guarantees the credential field names per vendor.
  if (config.heads) {
    for (const head of config.heads) {
      for (const ch of head.channels) {
        const candidates: (string | undefined)[] = []
        switch (ch.vendor) {
          case 'telegram':  candidates.push(ch.botToken, ch.chatId); break
          case 'discord':   candidates.push(ch.botToken, ch.channelId); break
          case 'slack':     candidates.push(ch.botToken, ch.appToken, ch.channelId); break
          case 'whatsapp':  candidates.push(ch.allowedJid); break
          case 'zoho-cliq': candidates.push(ch.clientId, ch.clientSecret, ch.refreshToken, ch.chatId); break
          case 'home-assistant': {
            const haToken = process.env['HA_ACCESS_TOKEN']
            if (haToken) candidates.push(haToken)
            break
          }
        }
        for (const v of candidates) {
          if (typeof v === 'string' && v.length >= 8) out.push(v)
        }
      }
    }
  }
  return out
}

/**
 * Phase 31 (CONF-02): canonical head resolution.
 *
 * D-04: When `config.heads` is present and non-empty, return it as-is —
 *       flat adapter keys are ignored entirely (no merging).
 * D-03: When `config.heads` is absent, synthesize a single implicit 'default'
 *       head whose channels are derived from flat adapter keys.
 *       Synthesized channel `id` uses the plain vendor name (e.g. 'telegram')
 *       rather than a prefix — Claude's discretion per CONTEXT.md.
 * When no flat keys are set either, return `[{id:'default', channels:[]}]` so
 *       startup still constructs exactly one default head (CONF-02 zero-config).
 */
export function resolveHeads(config: Config): ResolvedHead[] {
  if (config.heads && config.heads.length > 0) {
    return config.heads.map(h => ({
      id: h.id,
      channels: h.channels,
      ...(h.customPrompt !== undefined ? { customPrompt: h.customPrompt } : {}),
      ...(h.displayName !== undefined ? { displayName: h.displayName } : {}),
      // Carry per-head tool overrides forward only when the key is present.
      // Absent key = inherit global — must NOT become present-as-undefined
      // (exactOptionalPropertyTypes: the three states must stay distinct).
      ...(h.headToolsOverride !== undefined ? { headToolsOverride: h.headToolsOverride } : {}),
      ...(h.agentToolsOverride !== undefined ? { agentToolsOverride: h.agentToolsOverride } : {}),
    }))
  }
  const channels: ChannelConfig[] = []
  if (config.telegramBotToken && config.telegramChatId) {
    channels.push({
      id: 'telegram',
      vendor: 'telegram',
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
    })
  }
  if (config.discordBotToken && config.discordChannelId) {
    channels.push({
      id: 'discord',
      vendor: 'discord',
      botToken: config.discordBotToken,
      channelId: config.discordChannelId,
    })
  }
  if (config.slackBotToken && config.slackAppToken && config.slackChannelId) {
    channels.push({
      id: 'slack',
      vendor: 'slack',
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      channelId: config.slackChannelId,
    })
  }
  if (config.whatsappAllowedJid) {
    channels.push({
      id: 'whatsapp',
      vendor: 'whatsapp',
      allowedJid: config.whatsappAllowedJid,
    })
  }
  // Zoho Cliq credentials come from env (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
  // ZOHO_REFRESH_TOKEN, ZOHO_CLIQ_CHAT_ID) — synthesize the default channel
  // only when all four are present, mirroring the existing flat-key startup
  // gate in src/index.ts:352.
  const zClientId = process.env['ZOHO_CLIENT_ID']
  const zClientSecret = process.env['ZOHO_CLIENT_SECRET']
  const zRefreshToken = process.env['ZOHO_REFRESH_TOKEN']
  const zChatId = process.env['ZOHO_CLIQ_CHAT_ID']
  if (zClientId && zClientSecret && zRefreshToken && zChatId) {
    channels.push({
      id: 'zoho-cliq',
      vendor: 'zoho-cliq',
      clientId: zClientId,
      clientSecret: zClientSecret,
      refreshToken: zRefreshToken,
      chatId: zChatId,
    })
  }
  return [{ id: 'default', channels }]
}

// Env vars that `config:set` is allowed to write. Mirrors the secrets read by
// loadConfig (minus SHROK_WORKSPACE_PATH which is a bootstrap path, not a credential).
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
  'HA_ACCESS_TOKEN',
  'HA_INBOUND_API_KEY',   // Phase 41: bearer key HA presents on /v1/* (D-02)
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
