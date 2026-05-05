import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ContextAssemblerImpl } from './assembler.js'
import {
  setMemoryPromptsWorkspaceDir,
  __resetMemoryPromptsWorkspaceDirForTests,
  MEMORY_PROMPTS_DIR,
} from '../memory/prompts.js'
import type { Memory, RetrieveResult } from '../memory/index.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { Config } from '../config.js'
import type { QueueEvent } from '../types/core.js'

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

function makeMinimalConfig(): Config {
  return {
    llmProvider: 'anthropic',
    llmProviderPriority: ['anthropic'],
    anthropicApiKey: '',
    anthropicModelCapable: 'claude-sonnet-4-6',
    anthropicModelFast: 'claude-haiku-3-5',
    geminiApiKey: '',
    geminiModelCapable: 'gemini-3-flash-preview',
    geminiModelFast: 'gemini-3-flash-preview',
    openaiApiKey: '',
    openaiModelCapable: 'gpt-5.4',
    openaiModelFast: 'gpt-5.4',
    contextWindowTokens: 100_000,
    llmMaxTokens: 4096,
    memoryBudgetPercent: 40,
    memoryQueryContextTokens: 0,
    memoryRetrievalModel: 'standard',
    workspacePath: os.tmpdir(),
    timezone: 'UTC',
    maxConcurrentAgents: 4,
    agentTimeoutMs: 60_000,
    enableVoice: false,
    voiceProvider: 'elevenlabs',
    elevenLabsApiKey: '',
    elevenLabsVoiceId: '',
    openaiTtsVoice: 'alloy',
    openaiTtsModel: 'tts-1',
    deepgramApiKey: '',
    sttProvider: 'deepgram',
    discord: false,
    discordToken: '',
    discordChannelId: '',
    telegram: false,
    telegramBotToken: '',
    slack: false,
    slackBotToken: '',
    slackAppToken: '',
    whatsapp: false,
    whatsappPhoneId: '',
    whatsappToken: '',
    zohoCliq: false,
    zohoCliqToken: '',
    zohoCliqBotName: '',
    port: 3000,
    logLevel: 'info',
    stewardModel: 'standard',
    proactiveWorkspaceDir: '',
    stewardsWorkspaceDir: '',
    memoryPromptsWorkspaceDir: '',
    enableMemory: true,
    memoryPath: '',
    archivalFraction: 0.3,
    archivalWindowTokens: 50_000,
    agentHistoryEnabled: false,
    agentHistoryTokenBudget: 0,
  } as unknown as Config
}

function makeIdentityLoader(): IdentityLoader {
  return {
    loadSystemPrompt: () => 'System prompt',
  } as unknown as IdentityLoader
}

function makeMessageStore(): MessageStore {
  return {
    getRecent: () => [],
    getRecentTextByTokens: () => [],
    append: () => {},
    deleteByIds: () => {},
  } as unknown as MessageStore
}

function makeAgentStore(): AgentStore {
  return {
    get: () => null,
  } as unknown as AgentStore
}

function makeSkillLoader(): SkillLoader {
  return {
    load: () => null,
    listAll: () => [],
  } as unknown as SkillLoader
}

function makeMcpRegistry(): McpRegistry {
  return {
    listCapabilities: () => [],
    loadTools: async () => [],
  } as unknown as McpRegistry
}

function makeScheduleTrigger(): QueueEvent {
  return {
    id: 'evt-1',
    type: 'schedule_trigger',
    taskName: 'test-task',
    createdAt: new Date().toISOString(),
    priority: 10,
  } as unknown as QueueEvent
}

function makeMockMemory(retrieveSpy: (args: unknown[]) => void): Memory {
  return {
    chunk: async () => {},
    getTopics: async () => [],
    retrieve: async (...args: unknown[]) => {
      retrieveSpy(args)
      return [] as RetrieveResult[]
    },
    retrieveByEntity: async () => [],
    retrieveByIds: async () => [],
    compact: async () => {},
    deleteTopic: async () => {},
  } as unknown as Memory
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssemblerImpl + loadMemoryPromptOverrides wiring', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-test-'))
    setMemoryPromptsWorkspaceDir(tmpDir)
  })

  afterEach(() => {
    __resetMemoryPromptsWorkspaceDirForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retrieve receives prompts from loadMemoryPromptOverrides when workspace router file exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ROUTER.md'), 'WS-ROUTER')

    let capturedArgs: unknown[] = []
    const topicMemory = makeMockMemory(args => { capturedArgs = args })

    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      () => new Date('2026-01-01T00:00:00Z'),
      topicMemory,
      // no router — schedule_trigger bypasses rewriteQueryForRetrieval
    )

    await assembler.assemble(makeScheduleTrigger())

    // retrieve should have been called
    expect(capturedArgs.length).toBe(3)
    const promptsArg = capturedArgs[2] as { router?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(promptsArg?.router).toBe('WS-ROUTER')
  })

  it('retrieve receives loaded defaults when no workspace overrides exist', async () => {
    // No workspace MEMORY-*.md files — loader reads shipped defaults
    const shippedRouter = fs.readFileSync(
      path.join(MEMORY_PROMPTS_DIR, 'MEMORY-ROUTER.md'),
      'utf8',
    ).trim()

    let capturedArgs: unknown[] = []
    const topicMemory = makeMockMemory(args => { capturedArgs = args })

    const assembler = new ContextAssemblerImpl(
      makeIdentityLoader(),
      makeMessageStore(),
      makeAgentStore(),
      makeSkillLoader(),
      makeMinimalConfig(),
      makeMcpRegistry(),
      () => new Date('2026-01-01T00:00:00Z'),
      topicMemory,
    )

    await assembler.assemble(makeScheduleTrigger())

    expect(capturedArgs.length).toBe(3)
    const promptsArg = capturedArgs[2] as { router?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(promptsArg?.router).toBe(shippedRouter)
  })
})
