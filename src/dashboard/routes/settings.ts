import express from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'
import { ENV_KEY_ALLOWLIST } from '../../config.js'
import { setLogLevel } from '../../logger.js'
import type { Config } from '../../config.js'
import { LLMApiError } from '../../llm/util.js'
import { AnthropicProvider } from '../../llm/anthropic.js'
import { GeminiProvider } from '../../llm/gemini.js'
import { OpenAIProvider } from '../../llm/openai.js'

// Hardcoded mapping: body field → ENV key. No dynamic key construction.
const ENV_FIELD_MAP: Record<string, string> = {
  // llmProvider removed — use llmProviderPriority instead (handled separately)
  anthropicApiKey:  'ANTHROPIC_API_KEY',
  geminiApiKey:     'GEMINI_API_KEY',
  openaiApiKey:     'OPENAI_API_KEY',
  discordBotToken:  'DISCORD_BOT_TOKEN',
  discordChannelId: 'DISCORD_CHANNEL_ID',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
  telegramChatId:   'TELEGRAM_CHAT_ID',
  slackBotToken:    'SLACK_BOT_TOKEN',
  slackAppToken:    'SLACK_APP_TOKEN',
  slackChannelId:   'SLACK_CHANNEL_ID',
  whatsappAllowedJid: 'WHATSAPP_ALLOWED_JID',
  zohoClientId:     'ZOHO_CLIENT_ID',
  zohoClientSecret: 'ZOHO_CLIENT_SECRET',
  zohoRefreshToken: 'ZOHO_REFRESH_TOKEN',
  zohoCliqChatId:   'ZOHO_CLIQ_CHAT_ID',
  webhookSecret:    'WEBHOOK_SECRET',
}

// Map env var → channel reload sentinel filename. When any of these env vars
// is changed via the Settings PUT, we touch the corresponding sentinel so the
// daemon can hot-reload the channel adapter without a full restart. Mirrors
// the sentinel set wired in src/index.ts (DISCORD/TELEGRAM/SLACK/WHATSAPP/
// ZOHO_CLIQ reload paths). API keys and webhook secret are excluded — those
// are read on the next LLM call / activation, no adapter reload needed.
const ENV_TO_RELOAD_SENTINEL: Record<string, string> = {
  DISCORD_BOT_TOKEN:    '.reload-discord',
  DISCORD_CHANNEL_ID:   '.reload-discord',
  TELEGRAM_BOT_TOKEN:   '.reload-telegram',
  TELEGRAM_CHAT_ID:     '.reload-telegram',
  SLACK_BOT_TOKEN:      '.reload-slack',
  SLACK_APP_TOKEN:      '.reload-slack',
  SLACK_CHANNEL_ID:     '.reload-slack',
  WHATSAPP_ALLOWED_JID: '.reload-whatsapp',
  ZOHO_CLIENT_ID:       '.reload-zoho-cliq',
  ZOHO_CLIENT_SECRET:   '.reload-zoho-cliq',
  ZOHO_REFRESH_TOKEN:   '.reload-zoho-cliq',
  ZOHO_CLIQ_CHAT_ID:    '.reload-zoho-cliq',
}

const CONFIG_JSON_FIELDS = new Set([
  'anthropicModelStandard', 'anthropicModelCapable', 'anthropicModelExpert',
  'geminiModelStandard', 'geminiModelCapable', 'geminiModelExpert',
  'openaiModelStandard', 'openaiModelCapable', 'openaiModelExpert',
  'headModel', 'agentModel', 'stewardModel', 'memoryChunkingModel', 'memoryArchivalModel', 'memoryRetrievalModel',
  'logLevel',
  'contextWindowTokens', 'relaySummary', 'headRelaySteward', 'headRelayStewardContextTokens', 'resumeStewardContextTokens', 'routingStewardEnabled', 'agentContextComposer', 'agentContinuationEnabled', 'nestedAgentSpawningEnabled', 'messageAgentStewardEnabled', 'spawnAgentStewardEnabled', 'scheduledRelayStewardEnabled', 'resumeStewardEnabled', 'bootstrapStewardEnabled', 'contextRelevanceStewardEnabled', 'memoryBudgetPercent', 'memoryQueryContextTokens',
  'traceHistoryTokens',
  'llmMaxTokens', 'snapshotTokenBudget', 'archivalThresholdFraction', 'contextAssemblyTokenBudget',
  'stewardContextTokenBudget',
  'loopSameArgsTrigger', 'loopErrorTrigger', 'loopPostNudgeErrorTrigger',
  'loopStewardToolInputChars', 'loopStewardToolResultChars', 'loopStewardSystemPromptChars', 'loopStewardMaxTokens',
  'accentColor', 'logoPath',
  'webhookHost', 'webhookPort',
])

const VALID_PROVIDERS = new Set(['anthropic', 'gemini', 'openai'])

const TEST_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
}

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
}

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1)
      const quoted = /^\s*["']/.test(val)
      if (!quoted) val = val.replace(/#.*$/, '')
      val = val.trim()
      const quoteChar = (val[0] === '"' || val[0] === "'") ? val[0] : null
      if (quoteChar && val.endsWith(quoteChar)) {
        val = val.slice(1, -1)
        if (quoteChar === '"') {
          val = val.replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\\\', '\\').replaceAll('\\"', '"')
        } else {
          val = val.replaceAll("\\'", "'")
        }
      }
      if (key) result[key] = val
    }
  } catch {
    // file not found or unreadable — return empty
  }
  return result
}

function writeEnvFile(filePath: string, env: Record<string, string>): void {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => {
      if (/[\s"'#\\]/.test(v) || v.includes('\n')) {
        const escaped = v
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"')
          .replaceAll('\n', '\\n')
          .replaceAll('\t', '\\t')
        return `${k}="${escaped}"`
      }
      return `${k}=${v}`
    })
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
}

function loadConfigJson(workspacePath: string): Record<string, unknown> {
  try {
    const p = path.join(workspacePath, 'config.json')
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseProviderPriority(env: Record<string, string>): string[] {
  const raw = env['LLM_PROVIDER_PRIORITY']
  if (raw) return raw.split(',').map(s => s.trim()).filter(s => VALID_PROVIDERS.has(s))
  const single = env['LLM_PROVIDER'] ?? 'anthropic'
  return [single]
}

export function createSettingsRouter(workspacePath: string, envFilePath: string, appState?: import('../../db/app_state.js').AppStateStore, events?: import('../events.js').DashboardEventBus) {
  const router = express.Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const env = parseEnvFile(envFilePath)
    const cfg = loadConfigJson(workspacePath)

    const str = (key: string, def = '') =>
      typeof cfg[key] === 'string' ? (cfg[key] as string) : def
    const num = (key: string, def: number) =>
      typeof cfg[key] === 'number' ? (cfg[key] as number) : def
    const bool = (key: string, def: boolean) =>
      typeof cfg[key] === 'boolean' ? (cfg[key] as boolean) : def

    const priority = parseProviderPriority(env)

    res.json({
      llmProvider: priority[0] ?? 'anthropic',
      llmProviderPriority: priority,
      anthropicApiKey: { isSet: !!env['ANTHROPIC_API_KEY'] },
      geminiApiKey:    { isSet: !!env['GEMINI_API_KEY'] },
      openaiApiKey:    { isSet: !!env['OPENAI_API_KEY'] },
      anthropicModelStandard: str('anthropicModelStandard', 'claude-haiku-4-5'),
      anthropicModelCapable:  str('anthropicModelCapable',  'claude-sonnet-4-6'),
      anthropicModelExpert:   str('anthropicModelExpert',   'claude-opus-4-6'),
      geminiModelStandard: str('geminiModelStandard', 'gemini-2.5-flash'),
      geminiModelCapable:  str('geminiModelCapable',  'gemini-3-flash'),
      geminiModelExpert:   str('geminiModelExpert',   'gemini-3.1-pro'),
      openaiModelStandard: str('openaiModelStandard', 'gpt-5.4-nano'),
      openaiModelCapable:  str('openaiModelCapable',  'gpt-5.4-mini'),
      openaiModelExpert:   str('openaiModelExpert',   'gpt-5.4'),
      discordBotToken:  { isSet: !!env['DISCORD_BOT_TOKEN'] },
      discordChannelId: env['DISCORD_CHANNEL_ID'] ?? '',
      telegramBotToken: { isSet: !!env['TELEGRAM_BOT_TOKEN'] },
      telegramChatId:   env['TELEGRAM_CHAT_ID'] ?? '',
      slackBotToken:    { isSet: !!env['SLACK_BOT_TOKEN'] },
      slackAppToken:    { isSet: !!env['SLACK_APP_TOKEN'] },
      slackChannelId:   env['SLACK_CHANNEL_ID'] ?? '',
      whatsappAllowedJid: env['WHATSAPP_ALLOWED_JID'] ?? '',
      zohoClientId:     { isSet: !!env['ZOHO_CLIENT_ID'] },
      zohoClientSecret: { isSet: !!env['ZOHO_CLIENT_SECRET'] },
      zohoRefreshToken: { isSet: !!env['ZOHO_REFRESH_TOKEN'] },
      zohoCliqChatId:   env['ZOHO_CLIQ_CHAT_ID'] ?? '',
      webhookSecret:    { isSet: !!env['WEBHOOK_SECRET'] },
      webhookHost:      str('webhookHost', '127.0.0.1'),
      webhookPort:      num('webhookPort', 8766),
      version:     process.env['SHROK_VERSION'] ?? 'unknown',
      logLevel:    str('logLevel',    'info'),
      headModel:     str('headModel',     'capable'),
      agentModel:    str('agentModel',    'capable'),
      stewardModel:    str('stewardModel',    'standard'),
      memoryChunkingModel:  str('memoryChunkingModel', '') || str('memoryArchivalModel', '') || str('memoryModel', 'capable'),
      memoryArchivalModel:  str('memoryArchivalModel', '') || str('memoryModel', 'standard'),
      memoryRetrievalModel: str('memoryRetrievalModel', '') || str('memoryModel', 'standard'),
      contextWindowTokens: num('contextWindowTokens', 100_000),
      relaySummary: bool('relaySummary', true),
      headRelaySteward: bool('headRelaySteward', false),
      routingStewardEnabled: bool('routingStewardEnabled', false),
      headRelayStewardContextTokens: num('headRelayStewardContextTokens', 2000),
      resumeStewardContextTokens: num('resumeStewardContextTokens', 4000),
      agentContextComposer: bool('agentContextComposer', false),
      agentContinuationEnabled: bool('agentContinuationEnabled', true),
      nestedAgentSpawningEnabled: bool('nestedAgentSpawningEnabled', false),
      messageAgentStewardEnabled: bool('messageAgentStewardEnabled', false),
      spawnAgentStewardEnabled: bool('spawnAgentStewardEnabled', false),
      scheduledRelayStewardEnabled: bool('scheduledRelayStewardEnabled', true),
      resumeStewardEnabled: bool('resumeStewardEnabled', true),
      bootstrapStewardEnabled: bool('bootstrapStewardEnabled', true),
      contextRelevanceStewardEnabled: bool('contextRelevanceStewardEnabled', true),
      memoryBudgetPercent: num('memoryBudgetPercent', 40),
      memoryQueryContextTokens: num('memoryQueryContextTokens', 3000),
      traceHistoryTokens: num('traceHistoryTokens', 2000),
      llmMaxTokens: num('llmMaxTokens', 16384),
      snapshotTokenBudget: num('snapshotTokenBudget', 100_000),
      archivalThresholdFraction: num('archivalThresholdFraction', 0.80),
      contextAssemblyTokenBudget: num('contextAssemblyTokenBudget', 100_000),
      stewardContextTokenBudget: num('stewardContextTokenBudget', 10_000),
      loopSameArgsTrigger: num('loopSameArgsTrigger', 3),
      loopErrorTrigger: num('loopErrorTrigger', 2),
      loopPostNudgeErrorTrigger: num('loopPostNudgeErrorTrigger', 1),
      loopStewardToolInputChars: num('loopStewardToolInputChars', 200),
      loopStewardToolResultChars: num('loopStewardToolResultChars', 300),
      loopStewardSystemPromptChars: num('loopStewardSystemPromptChars', 500),
      loopStewardMaxTokens: num('loopStewardMaxTokens', 128),
      assistantName: str('assistantName', 'Shrok'),
      conversationVisibility: appState?.getConversationVisibility() ?? { agentWork: false, headTools: false, systemEvents: false, stewardRuns: false, agentPills: false, memoryRetrievals: false },
      usageFootersEnabled: appState?.getUsageFootersEnabled() ?? false,
      accentColor: str('accentColor', '#8C51CD'),
      logoPath: str('logoPath', ''),
      timezone: str('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    })
  })

  router.put('/', requireAuth, (req: Request, res: Response): void => {
    const body = req.body as Record<string, unknown>

    // --- Env file updates ---
    const envVars = parseEnvFile(envFilePath)
    let envChanged = false

    // Handle provider priority (special: array → comma-separated string)
    if ('llmProviderPriority' in body && Array.isArray(body.llmProviderPriority)) {
      const priority = (body.llmProviderPriority as string[]).filter(s => VALID_PROVIDERS.has(s))
      if (priority.length > 0) {
        envVars['LLM_PROVIDER_PRIORITY'] = priority.join(',')
        delete envVars['LLM_PROVIDER']  // clean up legacy to prevent two-source-of-truth
        envChanged = true
      }
    }

    // Track which channel reload sentinels need touching after env writes.
    // We only touch when the env value actually differs from what's already
    // there — saves a no-op reload on a Save click that didn't change creds.
    const reloadSentinels = new Set<string>()

    for (const [bodyField, envKey] of Object.entries(ENV_FIELD_MAP)) {
      if (!(bodyField in body)) continue
      const value = body[bodyField]
      if (typeof value !== 'string') continue
      // Belt-and-suspenders: strict allowlist check before any write
      if (!(ENV_KEY_ALLOWLIST as readonly string[]).includes(envKey)) continue

      const before = envVars[envKey] ?? ''
      const after = value
      if (value === '') {
        delete envVars[envKey]
      } else {
        envVars[envKey] = value
      }
      envChanged = true
      // Trigger channel hot-reload only on actual change.
      const sentinel = ENV_TO_RELOAD_SENTINEL[envKey]
      if (sentinel && before !== after) reloadSentinels.add(sentinel)
    }

    if (envChanged) {
      try {
        writeEnvFile(envFilePath, envVars)
      } catch (err) {
        res.status(500).json({ error: `Failed to write .env: ${(err as Error).message}` })
        return
      }
      for (const sentinel of reloadSentinels) {
        try { fs.writeFileSync(path.join(workspacePath, sentinel), '') }
        catch (err) { console.warn(`[settings] Failed to touch ${sentinel}: ${(err as Error).message}`) }
      }
    }

    // --- config.json updates ---
    const configPath = path.join(workspacePath, 'config.json')
    const configJson = loadConfigJson(workspacePath)
    let configChanged = false

    for (const field of CONFIG_JSON_FIELDS) {
      if (!(field in body)) continue
      configJson[field] = body[field]
      configChanged = true
    }

    // --- Logo upload (base64 data URL) ---
    if (typeof body['logoDataUrl'] === 'string' && body['logoDataUrl']) {
      const dataUrl = body['logoDataUrl'] as string
      const ALLOWED_TYPES = new Set(['png', 'jpeg', 'gif', 'webp', 'svg+xml'])
      const match = dataUrl.match(/^data:image\/(\w[\w+]*);base64,(.+)$/)
      if (!match || !ALLOWED_TYPES.has(match[1]!)) {
        res.status(400).json({ error: 'Invalid logo — accepted formats: PNG, JPEG, GIF, WebP, SVG' })
        return
      }
      const buf = Buffer.from(match[2]!, 'base64')
      const ext = match[1] === 'svg+xml' ? 'svg' : match[1]!
      const filename = `logo.${ext}`
      const brandingDir = path.join(workspacePath, 'branding')
      fs.mkdirSync(brandingDir, { recursive: true })
      fs.writeFileSync(path.join(brandingDir, filename), buf)
      configJson['logoPath'] = filename
      configChanged = true
    }

    if (configChanged) {
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2) + '\n', 'utf8')
      } catch (err) {
        res.status(500).json({ error: `Failed to write config.json: ${(err as Error).message}` })
        return
      }
      // Hot-reload logLevel so it takes effect without a restart
      if ('logLevel' in body) {
        setLogLevel(body['logLevel'] as Config['logLevel'])
      }
    }

    // Persist conversation visibility categories
    if (appState && body['conversationVisibility'] && typeof body['conversationVisibility'] === 'object') {
      const v = body['conversationVisibility'] as Record<string, unknown>
      appState.setConversationVisibility({
        agentWork: !!v['agentWork'],
        headTools: !!v['headTools'],
        systemEvents: !!v['systemEvents'],
        stewardRuns: !!v['stewardRuns'],
        agentPills: !!v['agentPills'],
        memoryRetrievals: !!v['memoryRetrievals'],
      })
    }

    // Persist usage footers toggle
    if (appState && 'usageFootersEnabled' in body) {
      appState.setUsageFootersEnabled(!!body['usageFootersEnabled'])
    }

    // Emit theme_changed if accent color or logo changed
    if (events && ('accentColor' in body || 'logoDataUrl' in body)) {
      const cfg = loadConfigJson(workspacePath)
      const logoPath = cfg['logoPath'] as string || ''
      events.emit('dashboard', {
        type: 'theme_changed',
        payload: {
          accentColor: (cfg['accentColor'] as string) || '#8C51CD',
          logoUrl: logoPath ? `/api/branding/${logoPath}` : '/logo.svg',
        },
      })
    }

    res.json({ ok: true })
  })

  // Test a provider's connectivity
  router.post('/test-provider', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const { provider, apiKey } = req.body as { provider?: string; apiKey?: string }
    if (!provider || !VALID_PROVIDERS.has(provider)) {
      res.status(400).json({ error: 'Invalid provider' }); return
    }

    const env = parseEnvFile(envFilePath)
    const resolvedKey = apiKey || env[ENV_KEY_MAP[provider]!]
    if (!resolvedKey) {
      res.json({ ok: false, error: 'No API key configured' }); return
    }

    const model = TEST_MODELS[provider]!
    const start = Date.now()
    try {
      const p = provider === 'anthropic' ? new AnthropicProvider(resolvedKey)
              : provider === 'gemini' ? new GeminiProvider(resolvedKey)
              : new OpenAIProvider(resolvedKey)
      const result = await p.complete(
        [{ kind: 'text' as const, id: 'test', role: 'user' as const, content: 'Hi', createdAt: new Date().toISOString() }],
        [],
        { model, maxTokens: 10 }
      )
      res.json({ ok: true, model: result.model, latencyMs: Date.now() - start })
    } catch (err) {
      const type = err instanceof LLMApiError ? err.type : 'unknown'
      const rawMsg = (err as Error).message ?? 'Unknown error'
      // Redact anything that looks like an API key (sk-..., AIza..., key-..., etc.)
      const safeMsg = rawMsg.replace(/\b(sk-[a-zA-Z0-9_-]{10,}|AIza[a-zA-Z0-9_-]{10,}|key-[a-zA-Z0-9_-]{10,}|xox[bpas]-[a-zA-Z0-9-]+)\b/g, '[REDACTED]')
      res.json({ ok: false, error: safeMsg, type })
    }
  })

  return router
}
