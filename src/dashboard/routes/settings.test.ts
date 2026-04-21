import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createSettingsRouter } from './settings.js'
import type { Config } from '../../config.js'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

// Minimal Config-shaped object with the defaults that the GET handler consumes.
// Mirrors src/config.ts ConfigSchema defaults exactly — update both in lock-step.
function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicModelStandard: 'claude-haiku-4-5-20251001',
    anthropicModelCapable: 'claude-sonnet-4-6',
    anthropicModelExpert: 'claude-opus-4-6',
    geminiModelStandard: 'gemini-2.0-flash',
    geminiModelCapable: 'gemini-2.5-pro',
    geminiModelExpert: 'gemini-2.5-pro',
    openaiModelStandard: 'gpt-4o-mini',
    openaiModelCapable: 'gpt-4o',
    openaiModelExpert: 'gpt-4o',
    headModel: 'capable',
    agentModel: 'capable',
    stewardModel: 'standard',
    memoryChunkingModel: 'capable',
    memoryArchivalModel: 'standard',
    memoryRetrievalModel: 'standard',
    logLevel: 'info',
    webhookHost: '127.0.0.1',
    webhookPort: 8766,
    contextWindowTokens: 100_000,
    relaySummary: true,
    headRelaySteward: false,
    routingStewardEnabled: false,
    headRelayStewardContextTokens: 2000,
    resumeStewardContextTokens: 4000,
    agentContextComposer: false,
    agentContinuationEnabled: true,
    nestedAgentSpawningEnabled: false,
    messageAgentStewardEnabled: false,
    spawnAgentStewardEnabled: false,
    scheduledRelayStewardEnabled: true,
    resumeStewardEnabled: true,
    bootstrapStewardEnabled: true,
    preferenceStewardEnabled: true,
    spawnStewardEnabled: false,
    actionComplianceStewardEnabled: false,
    contextRelevanceStewardEnabled: false,
    memoryBudgetPercent: 45,
    memoryQueryContextTokens: 3000,
    traceHistoryTokens: 2000,
    llmMaxTokens: 16384,
    snapshotTokenBudget: 100_000,
    archivalThresholdFraction: 0.80,
    contextAssemblyTokenBudget: 100_000,
    stewardContextTokenBudget: 10_000,
    loopSameArgsTrigger: 3,
    loopErrorTrigger: 2,
    loopPostNudgeErrorTrigger: 1,
    loopStewardToolInputChars: 200,
    loopStewardToolResultChars: 300,
    loopStewardSystemPromptChars: 500,
    loopStewardMaxTokens: 128,
    timezone: 'UTC',
    ...overrides,
  } as Config
}

describe('PUT /api/settings — channel hot-reload sentinels', () => {
  let workspace: string
  let envFile: string
  let server: Server
  let port: number

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ws-'))
    envFile = path.join(workspace, '.env')
    fs.writeFileSync(envFile, [
      'DISCORD_BOT_TOKEN=existing-discord-token',
      'DISCORD_CHANNEL_ID=12345',
      'TELEGRAM_BOT_TOKEN=existing-telegram-token',
      'ZOHO_CLIQ_CHAT_ID=cliq-chat-1',
    ].join('\n') + '\n', 'utf8')

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/settings', createSettingsRouter(workspace, envFile, makeTestConfig()))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  async function put(body: Record<string, unknown>): Promise<number> {
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.status
  }

  function exists(sentinel: string): boolean {
    return fs.existsSync(path.join(workspace, sentinel))
  }

  it('changing a discord field touches .reload-discord only', async () => {
    expect(await put({ discordChannelId: 'changed-channel' })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
    expect(exists('.reload-telegram')).toBe(false)
    expect(exists('.reload-slack')).toBe(false)
    expect(exists('.reload-whatsapp')).toBe(false)
    expect(exists('.reload-zoho-cliq')).toBe(false)
  })

  it('changing fields across two channels touches both sentinels', async () => {
    expect(await put({
      discordBotToken: 'new-token',
      slackBotToken: 'new-slack-token',
    })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
    expect(exists('.reload-slack')).toBe(true)
    expect(exists('.reload-telegram')).toBe(false)
  })

  it('submitting unchanged value does NOT touch the sentinel', async () => {
    expect(await put({ discordChannelId: '12345' })).toBe(200)  // same as before
    expect(exists('.reload-discord')).toBe(false)
  })

  it('clearing a channel cred (empty string) still touches sentinel', async () => {
    expect(await put({ discordBotToken: '' })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
  })

  it('non-channel field changes (accentColor) do NOT touch any sentinel', async () => {
    expect(await put({ accentColor: '#abcdef' })).toBe(200)
    expect(exists('.reload-discord')).toBe(false)
    expect(exists('.reload-telegram')).toBe(false)
    expect(exists('.reload-slack')).toBe(false)
    expect(exists('.reload-whatsapp')).toBe(false)
    expect(exists('.reload-zoho-cliq')).toBe(false)
  })

  it('zoho cliq fields touch .reload-zoho-cliq', async () => {
    expect(await put({ zohoClientId: 'abc', zohoCliqChatId: 'cliq-2' })).toBe(200)
    expect(exists('.reload-zoho-cliq')).toBe(true)
    // and the .env actually got updated
    const env = fs.readFileSync(envFile, 'utf8')
    expect(env).toContain('ZOHO_CLIENT_ID=abc')
    expect(env).toContain('ZOHO_CLIQ_CHAT_ID=cliq-2')
  })

  it('api key changes (anthropic) do NOT touch any reload sentinel', async () => {
    expect(await put({ anthropicApiKey: 'sk-ant-abc' })).toBe(200)
    for (const s of ['.reload-discord', '.reload-telegram', '.reload-slack', '.reload-whatsapp', '.reload-zoho-cliq']) {
      expect(exists(s), `${s} should not exist`).toBe(false)
    }
  })
})

describe('GET /api/settings — config-derived defaults', () => {
  let workspace: string
  let envFile: string
  let server: Server
  let port: number

  async function startWithConfig(cfg: Config): Promise<void> {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-get-ws-'))
    envFile = path.join(workspace, '.env')
    fs.writeFileSync(envFile, '', 'utf8')
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/settings', createSettingsRouter(workspace, envFile, cfg))
    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  }

  afterEach(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()))
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
  })

  async function getBody(): Promise<Record<string, unknown>> {
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`)
    return await r.json() as Record<string, unknown>
  }

  it('returns anthropic model defaults from config (not old literals)', async () => {
    await startWithConfig(makeTestConfig())
    const b = await getBody()
    expect(b['anthropicModelStandard']).toBe('claude-haiku-4-5-20251001')
    expect(b['anthropicModelCapable']).toBe('claude-sonnet-4-6')
    expect(b['anthropicModelExpert']).toBe('claude-opus-4-6')
  })

  it('returns corrected gemini model defaults from config', async () => {
    await startWithConfig(makeTestConfig())
    const b = await getBody()
    expect(b['geminiModelStandard']).toBe('gemini-2.0-flash')
    expect(b['geminiModelCapable']).toBe('gemini-2.5-pro')
    expect(b['geminiModelExpert']).toBe('gemini-2.5-pro')
  })

  it('returns corrected openai model defaults from config', async () => {
    await startWithConfig(makeTestConfig())
    const b = await getBody()
    expect(b['openaiModelStandard']).toBe('gpt-4o-mini')
    expect(b['openaiModelCapable']).toBe('gpt-4o')
    expect(b['openaiModelExpert']).toBe('gpt-4o')
  })

  it('returns drift-corrected numeric and boolean defaults from config', async () => {
    await startWithConfig(makeTestConfig())
    const b = await getBody()
    expect(b['memoryBudgetPercent']).toBe(45)
    expect(b['contextRelevanceStewardEnabled']).toBe(false)
  })

  it('workspace config.json override wins over config-derived default', async () => {
    await startWithConfig(makeTestConfig())
    fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ memoryBudgetPercent: 10 }), 'utf8')
    const b = await getBody()
    expect(b['memoryBudgetPercent']).toBe(10)
  })

  it('returns the three Phase 15 steward flags with config-derived defaults', async () => {
    await startWithConfig(makeTestConfig())
    const b = await getBody()
    expect(b['preferenceStewardEnabled']).toBe(true)
    expect(b['spawnStewardEnabled']).toBe(false)
    expect(b['actionComplianceStewardEnabled']).toBe(false)
  })

  it('workspace config.json override wins for preferenceStewardEnabled (regression: Phase 13 pattern)', async () => {
    await startWithConfig(makeTestConfig())
    fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ preferenceStewardEnabled: false }), 'utf8')
    const b = await getBody()
    expect(b['preferenceStewardEnabled']).toBe(false)
  })
})
