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

export type BySourceBucket = 'head' | 'curator' | 'archival' | 'manual_agents' | 'scheduled_agent'

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

export interface SkillDetail extends SkillInfo {
  rawContent: string
  files: SkillFile[]
}

export interface IdentityFile {
  filename: string
  section: 'main' | 'agent' | 'stewards' | 'proactive'
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
  taskName: string | null
  kind: 'task' | 'reminder'
  cron: string | null
  runAt: string | null
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  conditions: string | null
  agentContext: string | null
  createdAt: string
  updatedAt: string
}

export interface ApiKeyStatus { isSet: boolean }

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
  contextRelevanceStewardEnabled: boolean
  memoryBudgetPercent: number
  memoryQueryContextTokens: number
  assistantName: string
  conversationVisibility: {
    agentWork: boolean
    headTools: boolean
    systemEvents: boolean
    stewardRuns: boolean
    agentPills: boolean
    memoryRetrievals: boolean
  }
  usageFootersEnabled: boolean
  accentColor: string
  logoPath: string
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

export type DashboardEvent =
  | { type: 'message_added'; payload: Message }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger?: string } }
  | { type: 'steward_run_added'; payload: StewardRun }
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing' }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string } }
