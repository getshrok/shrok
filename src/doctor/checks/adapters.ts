// Live-layer checks: token-validation probes per configured channel.
//
// Only runs when ctx.deep is true. Each probe hits a cheap "who am I?" style
// endpoint with a 5s timeout. WhatsApp is intentionally skipped (Baileys
// requires a persistent pairing session — no single-shot probe).

import type { Check, CheckOutcome, Ctx } from '../types.js'
import type { Config } from '../../config.js'

interface AdapterProbe {
  name: string
  /** Returns null when the channel isn't fully configured → skip. */
  build(config: Config): { url: string; init: RequestInit } | null
  host: string
}

const DISCORD_PROBE: AdapterProbe = {
  name: 'discord',
  host: 'discord.com',
  build: (c) => {
    if (!c.discordBotToken || !c.discordChannelId) return null
    return {
      url: 'https://discord.com/api/v10/users/@me',
      init: {
        method: 'GET',
        headers: { 'Authorization': `Bot ${c.discordBotToken}` },
        signal: AbortSignal.timeout(5000),
      },
    }
  },
}

const TELEGRAM_PROBE: AdapterProbe = {
  name: 'telegram',
  host: 'api.telegram.org',
  build: (c) => {
    if (!c.telegramBotToken || !c.telegramChatId) return null
    return {
      url: `https://api.telegram.org/bot${c.telegramBotToken}/getMe`,
      init: {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      },
    }
  },
}

const SLACK_PROBE: AdapterProbe = {
  name: 'slack',
  host: 'slack.com',
  build: (c) => {
    if (!c.slackBotToken || !c.slackAppToken || !c.slackChannelId) return null
    return {
      url: 'https://slack.com/api/auth.test',
      init: {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.slackBotToken}` },
        signal: AbortSignal.timeout(5000),
      },
    }
  },
}

function buildAdapterCheck(probe: AdapterProbe): Check {
  return {
    id: `live.${probe.name}`,
    title: `${probe.name} token probe`,
    layer: 'live',
    async run(ctx: Ctx): Promise<CheckOutcome> {
      if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
      const spec = probe.build(ctx.config)
      if (!spec) return { status: 'skip', detail: `${probe.name}: not fully configured` }
      try {
        const res = await ctx.fetch(spec.url, spec.init)
        if (res.status === 200) {
          return { status: 'ok', detail: `${probe.name} token validated` }
        }
        if (res.status === 401 || res.status === 403) {
          return {
            status: 'fail',
            detail: `${probe.name} returned ${res.status}`,
            hint: `API key rejected by ${probe.name} — regenerate the bot token`,
          }
        }
        if (res.status >= 500) {
          return { status: 'warn', detail: `${probe.name} returned ${res.status}`, hint: `${probe.name} transient error?` }
        }
        return { status: 'warn', detail: `${probe.name} returned ${res.status}`, hint: `unexpected status from ${probe.name}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          status: 'warn',
          detail: `network error reaching ${probe.host}: ${msg}`,
          hint: `could not reach ${probe.host} — check network`,
        }
      }
    },
  }
}

const WHATSAPP_SKIP_CHECK: Check = {
  id: 'live.whatsapp',
  title: 'whatsapp token probe',
  layer: 'live',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
    if (!ctx.config.whatsappAllowedJid) return { status: 'skip', detail: 'whatsapp: not configured' }
    return {
      status: 'skip',
      detail: 'whatsapp: no offline probe (Baileys requires a paired session)',
    }
  },
}

export function buildAdapterChecks(): Check[] {
  return [
    buildAdapterCheck(DISCORD_PROBE),
    buildAdapterCheck(TELEGRAM_PROBE),
    buildAdapterCheck(SLACK_PROBE),
    WHATSAPP_SKIP_CHECK,
  ]
}
