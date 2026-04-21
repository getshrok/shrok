import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('loads with defaults', () => {
    const cfg = loadConfig()

    expect(cfg.llmProvider).toBe('anthropic')
    expect(cfg.anthropicModelStandard).toBe('claude-haiku-4-5-20251001')
    expect(cfg.anthropicModelCapable).toBe('claude-sonnet-4-6')
    expect(cfg.anthropicModelExpert).toBe('claude-opus-4-6')
    expect(cfg.webhookPort).toBe(8766)
    expect(cfg.webhookRateLimitPerMinute).toBe(60)
    expect(cfg.contextWindowTokens).toBe(100_000)
    expect(cfg.archivalThresholdFraction).toBe(0.80)
    expect(cfg.mcpConfigPath).toBe('./mcp.json')
    expect(cfg.logLevel).toBe('info')
  })

  it('applies default paths', () => {
    delete process.env['WORKSPACE_PATH']
    const cfg = loadConfig()
    expect(cfg.dbPath).toBe(path.join(os.homedir(), '.shrok/workspace/data/shrok.db'))
    expect(cfg.skillsDir).toBeUndefined()
    expect(cfg.workspacePath).toBe(path.join(os.homedir(), '.shrok/workspace'))
    expect(cfg.identityDir).toBe(path.join(os.homedir(), '.shrok/workspace/identity'))
    expect(cfg.migrationsDir).toBe('./sql')
  })

  it('reads API keys from env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
    const cfg = loadConfig()
    expect(cfg.anthropicApiKey).toBe('sk-ant-test')
    expect(cfg.openaiApiKey).toBe('sk-openai-test')
  })

  it('reads bot tokens from env', () => {
    process.env['DISCORD_BOT_TOKEN'] = 'discord-token'
    process.env['DISCORD_CHANNEL_ID'] = '123456'
    process.env['TELEGRAM_BOT_TOKEN'] = 'telegram-token'
    process.env['TELEGRAM_CHAT_ID'] = '789'
    const cfg = loadConfig()
    expect(cfg.discordBotToken).toBe('discord-token')
    expect(cfg.discordChannelId).toBe('123456')
    expect(cfg.telegramBotToken).toBe('telegram-token')
    expect(cfg.telegramChatId).toBe('789')
  })

  it('reads webhook secret from env', () => {
    process.env['WEBHOOK_SECRET'] = 'my-secret'
    const cfg = loadConfig()
    expect(cfg.webhookSecret).toBe('my-secret')
  })

  it('non-secret env vars are ignored', () => {
    process.env['LOG_LEVEL'] = 'debug'
    process.env['MCP_CONFIG_PATH'] = '/custom/mcp.json'
    const cfg = loadConfig()
    expect(cfg.logLevel).toBe('info')
    expect(cfg.mcpConfigPath).toBe('./mcp.json')
  })

  it('reads LLM_PROVIDER from env (legacy migration)', () => {
    process.env['LLM_PROVIDER'] = 'gemini'
    const cfg = loadConfig()
    expect(cfg.llmProvider).toBe('gemini')
    expect(cfg.llmProviderPriority).toEqual(['gemini'])
  })

  it('reads LLM_PROVIDER_PRIORITY from env', () => {
    process.env['LLM_PROVIDER_PRIORITY'] = 'openai,anthropic'
    const cfg = loadConfig()
    expect(cfg.llmProviderPriority).toEqual(['openai', 'anthropic'])
    expect(cfg.llmProvider).toBe('openai')
  })

  it('LLM_PROVIDER_PRIORITY takes precedence over LLM_PROVIDER', () => {
    process.env['LLM_PROVIDER'] = 'gemini'
    process.env['LLM_PROVIDER_PRIORITY'] = 'openai,anthropic'
    const cfg = loadConfig()
    expect(cfg.llmProviderPriority).toEqual(['openai', 'anthropic'])
    expect(cfg.llmProvider).toBe('openai')
  })

  it('defaults to anthropic when neither provider env is set', () => {
    const cfg = loadConfig()
    expect(cfg.llmProviderPriority).toEqual(['anthropic'])
    expect(cfg.llmProvider).toBe('anthropic')
  })

  it('WORKSPACE_PATH env overrides workspacePath', () => {
    process.env['WORKSPACE_PATH'] = '/custom/workspace'
    const cfg = loadConfig()
    expect(cfg.workspacePath).toBe('/custom/workspace')
  })
})

describe('Milestone 1 nested spawning flags', () => {
  const originalEnv = process.env
  let tmpConfigPath: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    tmpConfigPath = path.join(os.tmpdir(), `shrok-test-config-${Date.now()}.json`)
    process.env['USER_CONFIG_PATH'] = tmpConfigPath
  })

  afterEach(() => {
    process.env = originalEnv
    try { fs.unlinkSync(tmpConfigPath) } catch { /* ignore */ }
  })

  it('nestedAgentSpawningEnabled defaults to false', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.nestedAgentSpawningEnabled).toBe(false)
  })

  it('spawnAgentStewardEnabled defaults to false', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
  })

  it('setting nestedAgentSpawningEnabled true does not affect spawnAgentStewardEnabled default', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ nestedAgentSpawningEnabled: true }))
    const cfg = loadConfig()
    expect(cfg.nestedAgentSpawningEnabled).toBe(true)
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
  })

  it('setting spawnAgentStewardEnabled false does not affect nestedAgentSpawningEnabled', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ spawnAgentStewardEnabled: false }))
    const cfg = loadConfig()
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
    expect(cfg.nestedAgentSpawningEnabled).toBe(false)
  })

  it('JSON boolean false round-trips correctly for both flags', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ nestedAgentSpawningEnabled: false, spawnAgentStewardEnabled: false }))
    const cfg = loadConfig()
    expect(cfg.nestedAgentSpawningEnabled).toBe(false)
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
  })
})

describe('Phase 15 preference/compliance/spawn steward flags', () => {
  const originalEnv = process.env
  let tmpConfigPath: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    tmpConfigPath = path.join(os.tmpdir(), `shrok-test-config-p15-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    process.env['USER_CONFIG_PATH'] = tmpConfigPath
  })

  afterEach(() => {
    process.env = originalEnv
    try { fs.unlinkSync(tmpConfigPath) } catch { /* ignore */ }
  })

  it('preferenceStewardEnabled defaults to true', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.preferenceStewardEnabled).toBe(true)
  })

  it('actionComplianceStewardEnabled defaults to false', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.actionComplianceStewardEnabled).toBe(false)
  })

  it('spawnStewardEnabled defaults to false', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.spawnStewardEnabled).toBe(false)
  })

  it('preferenceStewardEnabled can be overridden to false via config.json', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ preferenceStewardEnabled: false }))
    const cfg = loadConfig()
    expect(cfg.preferenceStewardEnabled).toBe(false)
  })

  it('actionComplianceStewardEnabled can be overridden to true via config.json', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ actionComplianceStewardEnabled: true }))
    const cfg = loadConfig()
    expect(cfg.actionComplianceStewardEnabled).toBe(true)
  })

  it('spawnStewardEnabled can be overridden to true via config.json', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ spawnStewardEnabled: true }))
    const cfg = loadConfig()
    expect(cfg.spawnStewardEnabled).toBe(true)
  })

  it('spawnAgentStewardEnabled still exists and defaults to false (regression guard)', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({}))
    const cfg = loadConfig()
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
  })

  it('spawnStewardEnabled is independent of spawnAgentStewardEnabled', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ spawnStewardEnabled: true, spawnAgentStewardEnabled: false }))
    const cfg = loadConfig()
    expect(cfg.spawnStewardEnabled).toBe(true)
    expect(cfg.spawnAgentStewardEnabled).toBe(false)
  })
})

describe('dailySpendLimitUsd removal (Phase 8)', () => {
  const originalEnv = process.env
  let tmpConfigPath: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    tmpConfigPath = path.join(os.tmpdir(), `shrok-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    process.env['USER_CONFIG_PATH'] = tmpConfigPath
  })

  afterEach(() => {
    process.env = originalEnv
    try { fs.unlinkSync(tmpConfigPath) } catch { /* ignore */ }
  })

  it('ConfigSchema drops dailySpendLimitUsd — loaded config has no such property', () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ dailySpendLimitUsd: 200 }))
    const cfg = loadConfig() as Record<string, unknown>
    expect('dailySpendLimitUsd' in cfg).toBe(false)
    expect(cfg['dailySpendLimitUsd']).toBeUndefined()
  })

})
