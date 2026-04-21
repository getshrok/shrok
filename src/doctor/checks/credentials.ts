// Credentials-layer checks: offline validation of provider keys + channel pairs.
//
// "Offline" is enforced: no check in this module calls ctx.fetch. Shape checks
// are heuristic (prefix/length) — a true validation requires a live probe (see
// checks/providers.ts + checks/adapters.ts behind --deep).

import type { Check, CheckOutcome, Ctx } from '../types.js'
import type { Config } from '../../config.js'

type ProviderName = 'anthropic' | 'openai' | 'gemini'

interface ProviderSpec {
  name: ProviderName
  envVar: string
  configKey: keyof Config
  /** Returns null if shape looks OK, else a short complaint. */
  shapeComplaint(key: string): string | null
}

const PROVIDER_SPECS: Record<ProviderName, ProviderSpec> = {
  anthropic: {
    name: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    configKey: 'anthropicApiKey',
    shapeComplaint: k => k.startsWith('sk-ant-') ? null : 'anthropic keys usually start with `sk-ant-`',
  },
  openai: {
    name: 'openai',
    envVar: 'OPENAI_API_KEY',
    configKey: 'openaiApiKey',
    shapeComplaint: k => k.startsWith('sk-') ? null : 'openai keys usually start with `sk-`',
  },
  gemini: {
    name: 'gemini',
    envVar: 'GEMINI_API_KEY',
    configKey: 'geminiApiKey',
    shapeComplaint: k => k.length >= 30 ? null : 'gemini keys are typically ≥30 characters',
  },
}

function buildProviderCheck(spec: ProviderSpec): Check {
  return {
    id: `creds.${spec.name}`,
    title: `${spec.name} api key`,
    layer: 'creds',
    async run(ctx: Ctx): Promise<CheckOutcome> {
      if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
      const key = ctx.config[spec.configKey] as string | undefined
      if (!key) {
        return {
          status: 'fail',
          detail: `${spec.envVar} not set`,
          hint: `set ${spec.envVar} in your workspace .env (or process env)`,
        }
      }
      const complaint = spec.shapeComplaint(key)
      if (complaint) {
        return {
          status: 'warn',
          detail: complaint,
          hint: 'key shape looks unusual — verify it matches the dashboard',
        }
      }
      return { status: 'ok', detail: 'key present and shape looks valid' }
    },
  }
}

interface ChannelSpec {
  name: string
  fields: { envVar: string; configKey: keyof Config }[]
}

const CHANNEL_SPECS: ChannelSpec[] = [
  {
    name: 'discord',
    fields: [
      { envVar: 'DISCORD_BOT_TOKEN', configKey: 'discordBotToken' },
      { envVar: 'DISCORD_CHANNEL_ID', configKey: 'discordChannelId' },
    ],
  },
  {
    name: 'telegram',
    fields: [
      { envVar: 'TELEGRAM_BOT_TOKEN', configKey: 'telegramBotToken' },
      { envVar: 'TELEGRAM_CHAT_ID', configKey: 'telegramChatId' },
    ],
  },
  {
    name: 'slack',
    fields: [
      { envVar: 'SLACK_BOT_TOKEN', configKey: 'slackBotToken' },
      { envVar: 'SLACK_APP_TOKEN', configKey: 'slackAppToken' },
      { envVar: 'SLACK_CHANNEL_ID', configKey: 'slackChannelId' },
    ],
  },
  {
    name: 'whatsapp',
    fields: [
      { envVar: 'WHATSAPP_ALLOWED_JID', configKey: 'whatsappAllowedJid' },
    ],
  },
]

function buildChannelCheck(spec: ChannelSpec): Check {
  return {
    id: `creds.${spec.name}`,
    title: `${spec.name} channel config`,
    layer: 'creds',
    async run(ctx: Ctx): Promise<CheckOutcome> {
      if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
      const present = spec.fields.filter(f => ctx.config![f.configKey])
      const missing = spec.fields.filter(f => !ctx.config![f.configKey])
      if (present.length === 0) {
        return { status: 'skip', detail: 'not configured' }
      }
      if (missing.length > 0) {
        const missingNames = missing.map(f => f.envVar).join(', ')
        return {
          status: 'fail',
          detail: `${spec.name} partially configured — missing: ${missingNames}`,
          hint: `set ${missingNames} or unset all ${spec.name} fields to disable the channel`,
        }
      }
      return { status: 'ok', detail: `${spec.name} fully configured` }
    },
  }
}

/**
 * Build the credentials check suite for a given provider priority list. Provider
 * checks are emitted in the order they appear in the priority list (so the
 * operator sees their primary provider first), followed by all channel checks.
 */
export function buildCredentialsChecks(priority: ProviderName[]): Check[] {
  const providerChecks: Check[] = []
  const seen = new Set<ProviderName>()
  for (const p of priority) {
    if (seen.has(p)) continue
    seen.add(p)
    const spec = PROVIDER_SPECS[p]
    if (spec) providerChecks.push(buildProviderCheck(spec))
  }
  const channelChecks = CHANNEL_SPECS.map(s => buildChannelCheck(s))
  return [...providerChecks, ...channelChecks]
}

/** Eager suite for the default provider set — handy for tests that don't need priority control. */
export const credentialsChecks: Check[] = buildCredentialsChecks(['anthropic', 'openai', 'gemini'])
