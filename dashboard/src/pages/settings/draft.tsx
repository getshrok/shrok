import type { SettingsData } from '../../types/api'

export interface DraftState {
  llmProviderPriority: string[]
  // API keys: null = no change, string = pending new value ('' = clear)
  anthropicApiKey: string | null
  geminiApiKey: string | null
  openaiApiKey: string | null
  discordBotToken: string | null
  telegramBotToken: string | null
  slackBotToken: string | null
  slackAppToken: string | null
  zohoClientId: string | null
  zohoClientSecret: string | null
  zohoRefreshToken: string | null
  webhookSecret: string | null
  webhookHost: string
  webhookPort: string
  // Plain string fields
  discordChannelId: string
  telegramChatId: string
  slackChannelId: string
  whatsappAllowedJid: string
  zohoCliqChatId: string
  // Model fields
  anthropicModelStandard: string
  anthropicModelCapable: string
  anthropicModelExpert: string
  geminiModelStandard: string
  geminiModelCapable: string
  geminiModelExpert: string
  openaiModelStandard: string
  openaiModelCapable: string
  openaiModelExpert: string
  // Role-based models
  headModel: string
  agentModel: string
  stewardModel: string
  memoryChunkingModel: string
  memoryArchivalModel: string
  memoryRetrievalModel: string
  // Behavior
  contextWindowTokens: number
  relaySummary: boolean
  headRelaySteward: boolean
  headRelayStewardContextTokens: number
  routingStewardEnabled: boolean
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
  accentColor: string
  logoDataUrl: string | null
  logLevel: string
  visAgentWork: boolean
  visHeadTools: boolean
  visSystemEvents: boolean
  visStewardRuns: boolean
  visAgentPills: boolean
  visMemoryRetrievals: boolean
  usageFootersEnabled: boolean
  traceHistoryTokens: number
  // Advanced
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

export function initDraft(s: SettingsData): DraftState {
  return {
    llmProviderPriority: s.llmProviderPriority,
    anthropicApiKey: null, geminiApiKey: null, openaiApiKey: null,
    discordBotToken: null, telegramBotToken: null, slackBotToken: null,
    slackAppToken: null,
    zohoClientId: null, zohoClientSecret: null, zohoRefreshToken: null,
    webhookSecret: null,
    webhookHost: s.webhookHost,
    webhookPort: String(s.webhookPort),
    discordChannelId: s.discordChannelId,
    telegramChatId: s.telegramChatId,
    slackChannelId: s.slackChannelId,
    whatsappAllowedJid: s.whatsappAllowedJid,
    zohoCliqChatId: s.zohoCliqChatId,
    anthropicModelStandard: s.anthropicModelStandard,
    anthropicModelCapable: s.anthropicModelCapable,
    anthropicModelExpert: s.anthropicModelExpert,
    geminiModelStandard: s.geminiModelStandard,
    geminiModelCapable: s.geminiModelCapable,
    geminiModelExpert: s.geminiModelExpert,
    openaiModelStandard: s.openaiModelStandard,
    openaiModelCapable: s.openaiModelCapable,
    openaiModelExpert: s.openaiModelExpert,
    headModel: s.headModel,
    agentModel: s.agentModel,
    stewardModel: s.stewardModel,
    memoryChunkingModel: s.memoryChunkingModel,
    memoryArchivalModel: s.memoryArchivalModel,
    memoryRetrievalModel: s.memoryRetrievalModel,
    contextWindowTokens: s.contextWindowTokens,
    relaySummary: s.relaySummary,
    headRelaySteward: s.headRelaySteward,
    headRelayStewardContextTokens: s.headRelayStewardContextTokens,
    routingStewardEnabled: s.routingStewardEnabled,
    resumeStewardContextTokens: s.resumeStewardContextTokens,
    agentContextComposer: s.agentContextComposer,
    agentContinuationEnabled: s.agentContinuationEnabled,
    nestedAgentSpawningEnabled: s.nestedAgentSpawningEnabled,
    messageAgentStewardEnabled: s.messageAgentStewardEnabled,
    spawnAgentStewardEnabled: s.spawnAgentStewardEnabled,
    scheduledRelayStewardEnabled: s.scheduledRelayStewardEnabled,
    resumeStewardEnabled: s.resumeStewardEnabled,
    bootstrapStewardEnabled: s.bootstrapStewardEnabled,
    preferenceStewardEnabled: s.preferenceStewardEnabled,
    spawnStewardEnabled: s.spawnStewardEnabled,
    actionComplianceStewardEnabled: s.actionComplianceStewardEnabled,
    contextRelevanceStewardEnabled: s.contextRelevanceStewardEnabled,
    memoryBudgetPercent: s.memoryBudgetPercent,
    memoryQueryContextTokens: s.memoryQueryContextTokens,
    accentColor: s.accentColor,
    logoDataUrl: null,
    logLevel: s.logLevel,
    visAgentWork:        s.visAgentWork,
    visHeadTools:        s.visHeadTools,
    visSystemEvents:     s.visSystemEvents,
    visStewardRuns:      s.visStewardRuns,
    visAgentPills:       s.visAgentPills,
    visMemoryRetrievals: s.visMemoryRetrievals,
    usageFootersEnabled: s.usageFootersEnabled,
    traceHistoryTokens: s.traceHistoryTokens,
    llmMaxTokens: s.llmMaxTokens,
    snapshotTokenBudget: s.snapshotTokenBudget,
    archivalThresholdFraction: s.archivalThresholdFraction,
    contextAssemblyTokenBudget: s.contextAssemblyTokenBudget,
    stewardContextTokenBudget: s.stewardContextTokenBudget,
    loopSameArgsTrigger: s.loopSameArgsTrigger,
    loopErrorTrigger: s.loopErrorTrigger,
    loopPostNudgeErrorTrigger: s.loopPostNudgeErrorTrigger,
    loopStewardToolInputChars: s.loopStewardToolInputChars,
    loopStewardToolResultChars: s.loopStewardToolResultChars,
    loopStewardSystemPromptChars: s.loopStewardSystemPromptChars,
    loopStewardMaxTokens: s.loopStewardMaxTokens,
  }
}

export function isDirty(draft: DraftState, s: SettingsData): boolean {
  if (draft.anthropicApiKey !== null) return true
  if (draft.geminiApiKey !== null) return true
  if (draft.openaiApiKey !== null) return true
  if (draft.discordBotToken !== null) return true
  if (draft.telegramBotToken !== null) return true
  if (draft.slackBotToken !== null) return true
  if (draft.slackAppToken !== null) return true
  if (draft.zohoClientId !== null) return true
  if (draft.zohoClientSecret !== null) return true
  if (draft.zohoRefreshToken !== null) return true
  if (draft.webhookSecret !== null) return true
  if (draft.webhookHost !== s.webhookHost) return true
  if (draft.webhookPort !== String(s.webhookPort)) return true
  if (JSON.stringify(draft.llmProviderPriority) !== JSON.stringify(s.llmProviderPriority)) return true
  if (draft.discordChannelId !== s.discordChannelId) return true
  if (draft.telegramChatId !== s.telegramChatId) return true
  if (draft.slackChannelId !== s.slackChannelId) return true
  if (draft.whatsappAllowedJid !== s.whatsappAllowedJid) return true
  if (draft.zohoCliqChatId !== s.zohoCliqChatId) return true
  if (draft.anthropicModelStandard !== s.anthropicModelStandard) return true
  if (draft.anthropicModelCapable !== s.anthropicModelCapable) return true
  if (draft.anthropicModelExpert !== s.anthropicModelExpert) return true
  if (draft.geminiModelStandard !== s.geminiModelStandard) return true
  if (draft.geminiModelCapable !== s.geminiModelCapable) return true
  if (draft.geminiModelExpert !== s.geminiModelExpert) return true
  if (draft.openaiModelStandard !== s.openaiModelStandard) return true
  if (draft.openaiModelCapable !== s.openaiModelCapable) return true
  if (draft.openaiModelExpert !== s.openaiModelExpert) return true
  if (draft.headModel !== s.headModel) return true
  if (draft.agentModel !== s.agentModel) return true
  if (draft.stewardModel !== s.stewardModel) return true
  if (draft.memoryChunkingModel !== s.memoryChunkingModel) return true
  if (draft.memoryArchivalModel !== s.memoryArchivalModel) return true
  if (draft.memoryRetrievalModel !== s.memoryRetrievalModel) return true
  if (draft.contextWindowTokens !== s.contextWindowTokens) return true
  if (draft.relaySummary !== s.relaySummary) return true
  if (draft.headRelaySteward !== s.headRelaySteward) return true
  if (draft.headRelayStewardContextTokens !== s.headRelayStewardContextTokens) return true
  if (draft.routingStewardEnabled !== s.routingStewardEnabled) return true
  if (draft.resumeStewardContextTokens !== s.resumeStewardContextTokens) return true
  if (draft.agentContextComposer !== s.agentContextComposer) return true
  if (draft.agentContinuationEnabled !== s.agentContinuationEnabled) return true
  if (draft.nestedAgentSpawningEnabled !== s.nestedAgentSpawningEnabled) return true
  if (draft.messageAgentStewardEnabled !== s.messageAgentStewardEnabled) return true
  if (draft.spawnAgentStewardEnabled !== s.spawnAgentStewardEnabled) return true
  if (draft.scheduledRelayStewardEnabled !== s.scheduledRelayStewardEnabled) return true
  if (draft.resumeStewardEnabled !== s.resumeStewardEnabled) return true
  if (draft.bootstrapStewardEnabled !== s.bootstrapStewardEnabled) return true
  if (draft.preferenceStewardEnabled !== s.preferenceStewardEnabled) return true
  if (draft.spawnStewardEnabled !== s.spawnStewardEnabled) return true
  if (draft.actionComplianceStewardEnabled !== s.actionComplianceStewardEnabled) return true
  if (draft.contextRelevanceStewardEnabled !== s.contextRelevanceStewardEnabled) return true
  if (draft.memoryBudgetPercent !== s.memoryBudgetPercent) return true
  if (draft.memoryQueryContextTokens !== s.memoryQueryContextTokens) return true
  if (draft.accentColor !== s.accentColor) return true
  if (draft.logoDataUrl !== null) return true
  if (draft.logLevel !== s.logLevel) return true
  if (draft.visAgentWork        !== s.visAgentWork)        return true
  if (draft.visHeadTools        !== s.visHeadTools)        return true
  if (draft.visSystemEvents     !== s.visSystemEvents)     return true
  if (draft.visStewardRuns      !== s.visStewardRuns)      return true
  if (draft.visAgentPills       !== s.visAgentPills)       return true
  if (draft.visMemoryRetrievals !== s.visMemoryRetrievals) return true
  if (draft.usageFootersEnabled !== s.usageFootersEnabled) return true
  if (draft.traceHistoryTokens !== s.traceHistoryTokens) return true
  if (draft.llmMaxTokens !== s.llmMaxTokens) return true
  if (draft.snapshotTokenBudget !== s.snapshotTokenBudget) return true
  if (draft.archivalThresholdFraction !== s.archivalThresholdFraction) return true
  if (draft.contextAssemblyTokenBudget !== s.contextAssemblyTokenBudget) return true
  if (draft.stewardContextTokenBudget !== s.stewardContextTokenBudget) return true
  if (draft.loopSameArgsTrigger !== s.loopSameArgsTrigger) return true
  if (draft.loopErrorTrigger !== s.loopErrorTrigger) return true
  if (draft.loopPostNudgeErrorTrigger !== s.loopPostNudgeErrorTrigger) return true
  if (draft.loopStewardToolInputChars !== s.loopStewardToolInputChars) return true
  if (draft.loopStewardToolResultChars !== s.loopStewardToolResultChars) return true
  if (draft.loopStewardSystemPromptChars !== s.loopStewardSystemPromptChars) return true
  if (draft.loopStewardMaxTokens !== s.loopStewardMaxTokens) return true
  return false
}

export function buildBody(draft: DraftState, s: SettingsData): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (JSON.stringify(draft.llmProviderPriority) !== JSON.stringify(s.llmProviderPriority)) body.llmProviderPriority = draft.llmProviderPriority
  if (draft.discordChannelId !== s.discordChannelId) body.discordChannelId = draft.discordChannelId
  if (draft.telegramChatId !== s.telegramChatId) body.telegramChatId = draft.telegramChatId
  if (draft.slackChannelId !== s.slackChannelId) body.slackChannelId = draft.slackChannelId
  if (draft.whatsappAllowedJid !== s.whatsappAllowedJid) body.whatsappAllowedJid = draft.whatsappAllowedJid
  if (draft.zohoCliqChatId !== s.zohoCliqChatId) body.zohoCliqChatId = draft.zohoCliqChatId
  if (draft.anthropicModelStandard !== s.anthropicModelStandard) body.anthropicModelStandard = draft.anthropicModelStandard
  if (draft.anthropicModelCapable !== s.anthropicModelCapable) body.anthropicModelCapable = draft.anthropicModelCapable
  if (draft.anthropicModelExpert !== s.anthropicModelExpert) body.anthropicModelExpert = draft.anthropicModelExpert
  if (draft.geminiModelStandard !== s.geminiModelStandard) body.geminiModelStandard = draft.geminiModelStandard
  if (draft.geminiModelCapable !== s.geminiModelCapable) body.geminiModelCapable = draft.geminiModelCapable
  if (draft.geminiModelExpert !== s.geminiModelExpert) body.geminiModelExpert = draft.geminiModelExpert
  if (draft.openaiModelStandard !== s.openaiModelStandard) body.openaiModelStandard = draft.openaiModelStandard
  if (draft.openaiModelCapable !== s.openaiModelCapable) body.openaiModelCapable = draft.openaiModelCapable
  if (draft.openaiModelExpert !== s.openaiModelExpert) body.openaiModelExpert = draft.openaiModelExpert
  if (draft.headModel !== s.headModel) body.headModel = draft.headModel
  if (draft.agentModel !== s.agentModel) body.agentModel = draft.agentModel
  if (draft.stewardModel !== s.stewardModel) body.stewardModel = draft.stewardModel
  if (draft.memoryChunkingModel !== s.memoryChunkingModel) body.memoryChunkingModel = draft.memoryChunkingModel
  if (draft.memoryArchivalModel !== s.memoryArchivalModel) body.memoryArchivalModel = draft.memoryArchivalModel
  if (draft.memoryRetrievalModel !== s.memoryRetrievalModel) body.memoryRetrievalModel = draft.memoryRetrievalModel
  if (draft.contextWindowTokens !== s.contextWindowTokens) body.contextWindowTokens = draft.contextWindowTokens
  if (draft.relaySummary !== s.relaySummary) body.relaySummary = draft.relaySummary
  if (draft.headRelaySteward !== s.headRelaySteward) body.headRelaySteward = draft.headRelaySteward
  if (draft.headRelayStewardContextTokens !== s.headRelayStewardContextTokens) body.headRelayStewardContextTokens = draft.headRelayStewardContextTokens
  if (draft.routingStewardEnabled !== s.routingStewardEnabled) body.routingStewardEnabled = draft.routingStewardEnabled
  if (draft.resumeStewardContextTokens !== s.resumeStewardContextTokens) body.resumeStewardContextTokens = draft.resumeStewardContextTokens
  if (draft.agentContextComposer !== s.agentContextComposer) body.agentContextComposer = draft.agentContextComposer
  if (draft.agentContinuationEnabled !== s.agentContinuationEnabled) body.agentContinuationEnabled = draft.agentContinuationEnabled
  if (draft.nestedAgentSpawningEnabled !== s.nestedAgentSpawningEnabled) body.nestedAgentSpawningEnabled = draft.nestedAgentSpawningEnabled
  if (draft.messageAgentStewardEnabled !== s.messageAgentStewardEnabled) body.messageAgentStewardEnabled = draft.messageAgentStewardEnabled
  if (draft.spawnAgentStewardEnabled !== s.spawnAgentStewardEnabled) body.spawnAgentStewardEnabled = draft.spawnAgentStewardEnabled
  if (draft.scheduledRelayStewardEnabled !== s.scheduledRelayStewardEnabled) body.scheduledRelayStewardEnabled = draft.scheduledRelayStewardEnabled
  if (draft.resumeStewardEnabled !== s.resumeStewardEnabled) body.resumeStewardEnabled = draft.resumeStewardEnabled
  if (draft.bootstrapStewardEnabled !== s.bootstrapStewardEnabled) body.bootstrapStewardEnabled = draft.bootstrapStewardEnabled
  if (draft.preferenceStewardEnabled !== s.preferenceStewardEnabled) body.preferenceStewardEnabled = draft.preferenceStewardEnabled
  if (draft.spawnStewardEnabled !== s.spawnStewardEnabled) body.spawnStewardEnabled = draft.spawnStewardEnabled
  if (draft.actionComplianceStewardEnabled !== s.actionComplianceStewardEnabled) body.actionComplianceStewardEnabled = draft.actionComplianceStewardEnabled
  if (draft.contextRelevanceStewardEnabled !== s.contextRelevanceStewardEnabled) body.contextRelevanceStewardEnabled = draft.contextRelevanceStewardEnabled
  if (draft.memoryBudgetPercent !== s.memoryBudgetPercent) body.memoryBudgetPercent = draft.memoryBudgetPercent
  if (draft.memoryQueryContextTokens !== s.memoryQueryContextTokens) body.memoryQueryContextTokens = draft.memoryQueryContextTokens
  if (draft.accentColor !== s.accentColor) body.accentColor = draft.accentColor
  if (draft.logoDataUrl !== null) body.logoDataUrl = draft.logoDataUrl
  if (draft.logLevel !== s.logLevel) body.logLevel = draft.logLevel
  if (draft.visAgentWork        !== s.visAgentWork)        body.visAgentWork        = draft.visAgentWork
  if (draft.visHeadTools        !== s.visHeadTools)        body.visHeadTools        = draft.visHeadTools
  if (draft.visSystemEvents     !== s.visSystemEvents)     body.visSystemEvents     = draft.visSystemEvents
  if (draft.visStewardRuns      !== s.visStewardRuns)      body.visStewardRuns      = draft.visStewardRuns
  if (draft.visAgentPills       !== s.visAgentPills)       body.visAgentPills       = draft.visAgentPills
  if (draft.visMemoryRetrievals !== s.visMemoryRetrievals) body.visMemoryRetrievals = draft.visMemoryRetrievals
  if (draft.usageFootersEnabled !== s.usageFootersEnabled) body.usageFootersEnabled = draft.usageFootersEnabled
  if (draft.traceHistoryTokens !== s.traceHistoryTokens) body.traceHistoryTokens = draft.traceHistoryTokens
  if (draft.llmMaxTokens !== s.llmMaxTokens) body.llmMaxTokens = draft.llmMaxTokens
  if (draft.snapshotTokenBudget !== s.snapshotTokenBudget) body.snapshotTokenBudget = draft.snapshotTokenBudget
  if (draft.archivalThresholdFraction !== s.archivalThresholdFraction) body.archivalThresholdFraction = draft.archivalThresholdFraction
  if (draft.contextAssemblyTokenBudget !== s.contextAssemblyTokenBudget) body.contextAssemblyTokenBudget = draft.contextAssemblyTokenBudget
  if (draft.stewardContextTokenBudget !== s.stewardContextTokenBudget) body.stewardContextTokenBudget = draft.stewardContextTokenBudget
  if (draft.loopSameArgsTrigger !== s.loopSameArgsTrigger) body.loopSameArgsTrigger = draft.loopSameArgsTrigger
  if (draft.loopErrorTrigger !== s.loopErrorTrigger) body.loopErrorTrigger = draft.loopErrorTrigger
  if (draft.loopPostNudgeErrorTrigger !== s.loopPostNudgeErrorTrigger) body.loopPostNudgeErrorTrigger = draft.loopPostNudgeErrorTrigger
  if (draft.loopStewardToolInputChars !== s.loopStewardToolInputChars) body.loopStewardToolInputChars = draft.loopStewardToolInputChars
  if (draft.loopStewardToolResultChars !== s.loopStewardToolResultChars) body.loopStewardToolResultChars = draft.loopStewardToolResultChars
  if (draft.loopStewardSystemPromptChars !== s.loopStewardSystemPromptChars) body.loopStewardSystemPromptChars = draft.loopStewardSystemPromptChars
  if (draft.loopStewardMaxTokens !== s.loopStewardMaxTokens) body.loopStewardMaxTokens = draft.loopStewardMaxTokens
  // API key pending changes
  if (draft.anthropicApiKey !== null) body.anthropicApiKey = draft.anthropicApiKey
  if (draft.geminiApiKey !== null) body.geminiApiKey = draft.geminiApiKey
  if (draft.openaiApiKey !== null) body.openaiApiKey = draft.openaiApiKey
  if (draft.discordBotToken !== null) body.discordBotToken = draft.discordBotToken
  if (draft.telegramBotToken !== null) body.telegramBotToken = draft.telegramBotToken
  if (draft.slackBotToken !== null) body.slackBotToken = draft.slackBotToken
  if (draft.slackAppToken !== null) body.slackAppToken = draft.slackAppToken
  if (draft.zohoClientId !== null) body.zohoClientId = draft.zohoClientId
  if (draft.zohoClientSecret !== null) body.zohoClientSecret = draft.zohoClientSecret
  if (draft.zohoRefreshToken !== null) body.zohoRefreshToken = draft.zohoRefreshToken
  if (draft.webhookSecret !== null) body.webhookSecret = draft.webhookSecret
  if (draft.webhookHost !== s.webhookHost) body.webhookHost = draft.webhookHost
  if (draft.webhookPort !== String(s.webhookPort)) body.webhookPort = Number(draft.webhookPort)
  return body
}

export interface SettingsTabProps {
  d: DraftState
  s: SettingsData
  set: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void
  isDeveloper: boolean
  inputClass: string
  selectClass: string
}
