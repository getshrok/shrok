// Local type definitions mirroring src/types/core.ts and src/db/steward_runs.ts
// Kept local to avoid cross-workspace import complexity.

export interface Attachment {
  type: 'image' | 'audio' | 'document' | 'video'
  mediaType: string
  filename?: string
  path?: string
  url?: string
  size?: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string
}

export interface MessageBase {
  id: string
  createdAt: string
  injected?: boolean
  tokens?: number
}

export interface TextMessage extends MessageBase {
  kind: 'text'
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  channel?: string
  eventId?: string
}

export interface ToolCallMessage extends MessageBase {
  kind: 'tool_call'
  content: string
  toolCalls: ToolCall[]
}

export interface ToolResultMessage extends MessageBase {
  kind: 'tool_result'
  toolResults: ToolResult[]
}

export interface SummaryMessage extends MessageBase {
  kind: 'summary'
  content: string
  summarySpan: [string, string]
}

export type Message = TextMessage | ToolCallMessage | ToolResultMessage | SummaryMessage

export interface StewardRun {
  id: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
  headId: string
}

export type AgentStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'retracted'

export interface EventUsageSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
}

export interface UsagePeriodSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  bySource: BySourceRow[]
  trend: UsageTrendDay[]
  cache?: {
    readTokens: number
    writeTokens: number
    totalInputTokens: number
  }
}

export interface UsageTrendDay {
  day: string
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export type BySourceBucket = 'head' | 'curator' | 'archival' | 'steward' | 'memory' | 'manual_agents' | 'scheduled_agent'

export interface BySourceRow {
  bucket: BySourceBucket
  name: string
  kind?: 'skill' | 'task'
  trigger?: 'scheduled' | 'manual' | 'ad_hoc' | 'unknown'
  inputTokens: number
  outputTokens: number
  costUsd: number
  maxPerMonthUsd?: number
}

export interface UsageResponse {
  periods: {
    today: UsagePeriodSummary
    week: UsagePeriodSummary
    month: UsagePeriodSummary
    allTime: UsagePeriodSummary
  }
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  bySourceType: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  bySource: BySourceRow[]
  trend: UsageTrendDay[]
  perEvent: Record<string, EventUsageSummary>
}

export interface StatusResponse {
  uptimeSeconds: number
  estimatedSpendToday: number
  blockingThresholds: number
  activeAgents: number
}

export interface MemoryEntity {
  name: string
  type: 'person' | 'project' | 'place' | 'organization' | 'other'
}

export interface MemoryTopic {
  topicId: string
  label: string
  summary: string
  entities: MemoryEntity[]
  tags: string[]
  firstSeenAt: string
  lastUpdatedAt: string
  estimatedTokens: number
  chunkCount: number
}

export interface MemoryChunk {
  chunkId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: string }>
  summary: string
  entities: MemoryEntity[]
  tags: string[]
  timeRange: { start: string; end: string } | null
  appendedAt: string
  archived?: boolean
  archivalLevel?: 'moderate' | 'heavy'
  coversChunkIds?: string[]
}

export interface MemoryRelation {
  source: string
  relation: string
  target: string
  topicIds: string[]
  firstSeen: string
  lastSeen: string
}

export interface SkillInfo {
  name: string
  description: string
  isSystem: boolean
  model: string | null
  triggerTools: string[] | null
  requiredEnv: string[]
  skillDeps: string[]
  mcpCapabilities: string[]
  npmDeps: string[]
  maxPerMonthUsd?: number | null
}

export interface SkillFile {
  name: string
  size: number
  isProtected: boolean
}

export interface ReadFileResult {
  content?: string
  binary?: boolean
  tooLarge?: boolean
  size: number
}

export interface SkillDetail extends SkillInfo {
  rawContent: string
  files: SkillFile[]
}

export interface IdentityFile {
  filename: string
  section: 'main' | 'agent' | 'stewards' | 'proactive' | 'memory'
  content: string
  isWorkspace: boolean
  isDangerous: boolean
}

export interface ActivityEntry {
  id: string
  kind: 'message_in' | 'message_out' | 'agent_started' | 'agent_done' | 'agent_failed' | 'steward_nudge'
  timestamp: string
  summary: string
  detail?: string
}

export interface TraceFile {
  filename: string
  sourceType: string
  sizeBytes: number
  modifiedAt: string
  isLatest: boolean
}

export interface EvalScenarioInfo {
  name: string
  description: string
  category: string
  rubric: string[]
  lastResult: { pass: boolean; createdAt: string; runId: string; minScore: number | null } | null
  estimatedCostUsd: number
  variants: string[]
}

export interface EvalResult {
  id: string
  runId: string
  scenario: string
  category: string
  pass: boolean
  dimensions: Record<string, { score: number; notes: string }>
  narrative: string
  overall: string
  createdAt: string
}

export interface EvalResultDetail extends EvalResult {
  history: Array<{ role: string; content: string }>
  output: unknown
  traces: Record<string, string>
}

export interface EvalRun {
  runId: string
  total: number
  passed: number
  startedAt: string
}

export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder' | 'script'
  cron: string | null
  runAt: string | null
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  conditions: string | null
  agentContext: string | null
  requiresAck: boolean
  nagIntervalMinutes: number | null
  ackPending: boolean
  createdAt: string
  updatedAt: string
  /** Phase 44 — delivery set for task schedules. Absent = owner-only. */
  deliverToHeadIds?: string[]
  /** Operator guidance injected into the relay steward's prompt to bias whether this
   *  task's output is surfaced. Task-only; absent = relay defaults apply. */
  relayGuidance?: string
  /** ISO UTC cutoff — recurring schedule auto-disables once its next fire is on/after this. */
  endDate: string | null
}

export interface ApiKeyStatus { isSet: boolean }

/** A dashboard login identity: a display name and an optional head it scopes to. */
export interface DashboardUser {
  name: string
  headId?: string
}

export interface SettingsData {
  llmProvider: 'anthropic' | 'gemini' | 'openai'
  llmProviderPriority: Array<'anthropic' | 'gemini' | 'openai'>
  anthropicApiKey: ApiKeyStatus
  geminiApiKey: ApiKeyStatus
  openaiApiKey: ApiKeyStatus
  anthropicModelStandard: string
  anthropicModelCapable: string
  anthropicModelExpert: string
  geminiModelStandard: string
  geminiModelCapable: string
  geminiModelExpert: string
  openaiModelStandard: string
  openaiModelCapable: string
  openaiModelExpert: string
  discordBotToken: ApiKeyStatus
  discordChannelId: string
  telegramBotToken: ApiKeyStatus
  telegramChatId: string
  slackBotToken: ApiKeyStatus
  slackAppToken: ApiKeyStatus
  slackChannelId: string
  whatsappAllowedJid: string
  zohoClientId: ApiKeyStatus
  zohoClientSecret: ApiKeyStatus
  zohoRefreshToken: ApiKeyStatus
  zohoCliqChatId: string
  webhookSecret: ApiKeyStatus
  webhookHost: string
  webhookPort: number
  version: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  headModel: string
  agentModel: string
  stewardModel: string
  memoryChunkingModel: string
  memoryArchivalModel: string
  memoryRetrievalModel: string
  contextWindowTokens: number
  relaySummary: boolean
  headRelaySteward: boolean
  routingStewardEnabled: boolean
  headRelayStewardContextTokens: number
  resumeStewardContextTokens: number
  agentContextComposer: boolean
  agentContinuationEnabled: boolean
  nestedAgentSpawningEnabled: boolean
  messageAgentStewardEnabled: boolean
  spawnAgentStewardEnabled: boolean
  scheduledRelayStewardEnabled: boolean
  resumeStewardEnabled: boolean
  bootstrapStewardEnabled: boolean
  preferenceStewardEnabled: boolean
  spawnStewardEnabled: boolean
  actionComplianceStewardEnabled: boolean
  contextRelevanceStewardEnabled: boolean
  memoryBudgetPercent: number
  memoryQueryContextTokens: number
  assistantName: string
  visAgentWork: boolean
  visHeadTools: boolean
  visSystemEvents: boolean
  visStewardRuns: boolean
  visAgentPills: boolean
  visMemoryRetrievals: boolean
  usageFootersEnabled: boolean
  accentColor: string
  logoPath: string
  dashboardUsers: DashboardUser[]
  timezone: string
  traceHistoryTokens: number
  llmMaxTokens: number
  snapshotTokenBudget: number
  archivalThresholdFraction: number
  contextAssemblyTokenBudget: number
  stewardContextTokenBudget: number
  loopSameArgsTrigger: number
  loopErrorTrigger: number
  loopPostNudgeErrorTrigger: number
  loopStewardToolInputChars: number
  loopStewardToolResultChars: number
  loopStewardSystemPromptChars: number
  loopStewardMaxTokens: number
  /** Global agent tool allowlist default: string[] = subset (TOOLCFG-02). Two-state: always a concrete array. */
  agentToolDefault: string[]
  /** Global head tool allowlist default: string[] = subset (TOOLCFG-01). Two-state: always a concrete array. */
  headToolDefault: string[]
}

/**
 * Measured token sizes of the shared, structural system-prompt blocks the head
 * assembles every turn. Drives the context-window budget bar in Settings.
 * Approximate — tiktoken cl100k_base. The memory/history/output split is NOT
 * here; the bar computes it client-side from the live Settings draft.
 */
export interface ContextWindowData {
  approximate: boolean
  tokenizer: string
  /** Identity files (the part that grows over time), as its own bar segment. */
  identityTokens: number
  /** identity + capabilities + skills + environment, tokenized as one string. */
  baseSystemTokens: number
  blocks: { capabilities: number; skills: number; environment: number }
  identityFiles: { name: string; tokens: number }[]
}

export type ThresholdAction = 'alert' | 'block'

export interface UsageThreshold {
  id: string
  period: 'day' | 'week' | 'month'
  amountUsd: number
  action: ThresholdAction
}

export interface ThresholdWithSpend extends UsageThreshold {
  currentSpend: number
  periodStart: string
}

/**
 * Phase 33 Plan 06 (D-02, D-13, D-15, D-17) — channel + head types mirrored from
 * `src/dashboard/routes/heads.ts`. The backend always returns secrets as `{ isSet }`
 * on GET; POST/PATCH accept plaintext for new/changed secrets only.
 */
export type ChannelConfigMasked =
  | { id: string; vendor: 'telegram'; botToken: { isSet: boolean }; chatId: string }
  | { id: string; vendor: 'discord';  botToken: { isSet: boolean }; channelId: string }
  | { id: string; vendor: 'slack';    botToken: { isSet: boolean }; appToken: { isSet: boolean }; channelId: string }
  | { id: string; vendor: 'whatsapp'; allowedJid: string }
  | { id: string; vendor: 'zoho-cliq'; clientId: { isSet: boolean }; clientSecret: { isSet: boolean }; refreshToken: { isSet: boolean }; chatId: string }

/** Shape POSTed to the channels sub-resource. Secrets are plaintext on the wire. */
export type ChannelConfigSubmit =
  | { id: string; vendor: 'telegram'; botToken: string; chatId: string }
  | { id: string; vendor: 'discord';  botToken: string; channelId: string }
  | { id: string; vendor: 'slack';    botToken: string; appToken: string; channelId: string }
  | { id: string; vendor: 'whatsapp'; allowedJid: string }
  | { id: string; vendor: 'zoho-cliq'; clientId: string; clientSecret: string; refreshToken: string; chatId: string }

/**
 * Tagged registry entry from GET /api/tools (D-08, TOOLCFG-08).
 * Each tool carries the layer(s) it can execute in today.
 * Pickers filter by: tools.filter(t => t.layers.includes('head'|'agent')).
 */
export type ToolLayer = 'head' | 'agent'
export interface ToolRegistryEntry {
  name: string
  layers: ToolLayer[]
}

export interface HeadDTO {
  id: string
  channels: ChannelConfigMasked[]
  customPrompt?: string
  /** Two-state: key absent = inherit global; string[] = subset (null rejected) */
  headToolsOverride?: string[]
  /** Two-state: key absent = inherit global; string[] = subset (null rejected) */
  agentToolsOverride?: string[]
}

export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus }; headId: string }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string }; headId: string }
  | { type: 'steward_run_added'; payload: StewardRun }
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing'; headId: string }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number }; headId: string }
