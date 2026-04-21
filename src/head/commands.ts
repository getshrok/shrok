import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import bcryptjs from 'bcryptjs'
import type { Config } from '../config.js'
import type { AppStateStore } from '../db/app_state.js'

// ─── Slash command registry ───────────────────────────────────────────────────

export interface StatusInfo {
  uptimeSeconds: number
  estimatedSpendToday: number
  blockingThresholds: number
  activeAgents: number
  runningAgents: number
  suspendedAgents: number
}

export type UsageMode = 'off' | 'tokens' | 'cost' | 'full'

export interface SlashCommandContext {
  channel: string
  send: (msg: string) => Promise<void>
  appState: AppStateStore
  usageModes: Map<string, UsageMode>
  stop: () => void
  restart: () => void
  getStatus: () => StatusInfo
  forceArchive: () => Promise<number>
  clearHistory: () => void
  clearAgents: () => void
  retractAllAgents: () => Promise<number>
  clearQueue: () => void
  clearStewardRuns: () => void
  clearReminders: () => void
  config: Config
  getTopicCount: () => Promise<number>
  getDbStats: () => { messages: number; agents: number; schedules: number; reminders: number }
  getHeadContextStats: () => { messageCount: number; tokens: number; oldestCreatedAt: string | null; historyBudget: number; archivalThreshold: number }
  getMcpCapabilities: () => string[]
  getSpendSummary: (since?: string) => { costUsd: number; inputTokens: number; outputTokens: number }
  revokeDashboardSessions?: () => void
}

export interface SlashCommand {
  description: string
  handler: (args: string, ctx: SlashCommandContext) => Promise<void>
}

export function buildCommandRegistry(): Map<string, SlashCommand> {
  const registry = new Map<string, SlashCommand>()

  registry.set('debug', {
    description: 'Toggle full debug visibility (agent work, head tools, system events, steward runs) across all channels and the dashboard. Args: `on` | `off`',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      const current = ctx.appState.getConversationVisibility()
      const anyOn = current.agentWork || current.headTools || current.systemEvents || current.stewardRuns
      const turnOn = arg === 'on' ? true : arg === 'off' ? false : !anyOn
      ctx.appState.setConversationVisibility({
        ...current,
        agentWork: turnOn,
        headTools: turnOn,
        systemEvents: turnOn,
        stewardRuns: turnOn,
        // agentPills intentionally not touched — it's a dashboard UI concern
      })
      await ctx.send(`Debug visibility **${turnOn ? 'on' : 'off'}**.`)
    },
  })

  registry.set('xray', {
    description: 'Toggle agent work visibility (agent tool calls and results) across all channels and the dashboard. Args: `on` | `off`',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      const current = ctx.appState.getConversationVisibility()
      const turnOn = arg === 'on' ? true : arg === 'off' ? false : !current.agentWork
      ctx.appState.setConversationVisibility({ ...current, agentWork: turnOn })
      await ctx.send(`Agent work visibility **${turnOn ? 'on' : 'off'}**.`)
    },
  })

  registry.set('usage', {
    description: 'Show estimated LLM spend (24h / 7d / 30d / all-time). Pass `off` | `tokens` | `cost` | `full` to control the per-message footer instead.',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase() as UsageMode | ''
      const valid: UsageMode[] = ['off', 'tokens', 'cost', 'full']
      if (arg && valid.includes(arg as UsageMode)) {
        if (arg === 'off') ctx.usageModes.delete(ctx.channel)
        else ctx.usageModes.set(ctx.channel, arg as UsageMode)
        await ctx.send(`Usage footer set to **${arg}**.`)
        return
      }
      if (arg) {
        await ctx.send(`Unknown mode \`${arg}\`. Footer modes: \`off\` | \`tokens\` | \`cost\` | \`full\``)
        return
      }
      // No args → show spend summary.
      const now = Date.now()
      const dayMs = 24 * 60 * 60 * 1000
      const sinceIso = (offsetDays: number) => new Date(now - offsetDays * dayMs).toISOString()
      const today = ctx.getSpendSummary(sinceIso(1))
      const week = ctx.getSpendSummary(sinceIso(7))
      const month = ctx.getSpendSummary(sinceIso(30))
      const all = ctx.getSpendSummary()
      const fmt = (s: { costUsd: number; inputTokens: number; outputTokens: number }) =>
        `$${s.costUsd.toFixed(4).padStart(10)}   ${(s.inputTokens / 1000).toFixed(0).padStart(7)}K in / ${(s.outputTokens / 1000).toFixed(0).padStart(5)}K out`
      const currentFooter = ctx.usageModes.get(ctx.channel) ?? 'off'
      const lines = [
        '**Estimated spend**',
        '```',
        `24h:    ${fmt(today)}`,
        `7d:     ${fmt(week)}`,
        `30d:    ${fmt(month)}`,
        `total:  ${fmt(all)}`,
        '```',
        `_(per-message footer is **${currentFooter}** — change with \`~usage off|tokens|cost|full\`)_`,
      ]
      await ctx.send(lines.join('\n'))
    },
  })

  registry.set('status', {
    description: 'Show runtime status (uptime, estimated spend, active agents).',
    handler: async (_args, ctx) => {
      const s = ctx.getStatus()
      const h = Math.floor(s.uptimeSeconds / 3600)
      const m = Math.floor((s.uptimeSeconds % 3600) / 60)
      const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`
      const v = ctx.appState.getConversationVisibility()
      const debugAllOn = v.agentWork && v.headTools && v.systemEvents && v.stewardRuns
      const debugAnyOn = v.agentWork || v.headTools || v.systemEvents || v.stewardRuns
      const debugMode = debugAllOn ? 'on' : debugAnyOn ? 'partial' : 'off'
      const blockingSuffix = s.blockingThresholds > 0
        ? ` (${s.blockingThresholds} block threshold${s.blockingThresholds === 1 ? '' : 's'} active)`
        : ''
      const lines = [
        '**Status**',
        `Uptime:                 ${uptime}`,
        `Est. spend today:  $${s.estimatedSpendToday.toFixed(2)}${blockingSuffix}`,
        `Active agents:       ${s.activeAgents}`,
        `Xray mode:          ${v.agentWork ? 'on' : 'off'}`,
        `Debug mode:         ${debugMode}`,
      ]
      await ctx.send(lines.join('\n'))
    },
  })

  registry.set('restart', {
    description: 'Restart Shrok immediately.',
    handler: async (_args, ctx) => {
      const { runningAgents, suspendedAgents } = ctx.getStatus()
      const parts: string[] = []
      if (runningAgents > 0) parts.push(`${runningAgents} running agent${runningAgents === 1 ? '' : 's'} will be cancelled`)
      if (suspendedAgents > 0) parts.push(`${suspendedAgents} suspended agent${suspendedAgents === 1 ? '' : 's'} will resume after restart`)
      const msg = parts.length > 0
        ? `Restarting. ${parts.join('; ')}.`
        : 'Restarting, back in a moment.'
      ctx.restart()
      await ctx.send(msg).catch(() => {})
    },
  })

  registry.set('stop', {
    description: 'Shut Shrok down immediately.',
    handler: async (_args, ctx) => {
      const { runningAgents, suspendedAgents } = ctx.getStatus()
      const cancelled = runningAgents + suspendedAgents
      const agentWarning = cancelled > 0
        ? ` ${cancelled} agent${cancelled === 1 ? '' : 's'} in progress will be cancelled.`
        : ''
      const msg = `Shutting down.${agentWarning}\n\nShrok will not restart on its own. To bring it back: run \`npm start\` in the Shrok directory, or restart the container/service if using Docker or a process manager.`
      ctx.stop()
      await ctx.send(msg).catch(() => {})
    },
  })

  registry.set('context', {
    description: 'Show current unarchived head conversation token usage.',
    handler: async (_args, ctx) => {
      const s = ctx.getHeadContextStats()
      const pct = s.historyBudget > 0 ? Math.round((s.tokens / s.historyBudget) * 100) : 0
      const oldest = s.oldestCreatedAt ? s.oldestCreatedAt.replace('T', ' ').slice(0, 16) : '—'
      const lines = [
        '**Head context (unarchived)**',
        `Messages:           ${s.messageCount}`,
        `Tokens:               ~${s.tokens.toLocaleString()} / ${s.historyBudget.toLocaleString()} budget (${pct}%)`,
        `Oldest:                 ${oldest}`,
        `Archives at:        ~${s.archivalThreshold.toLocaleString()} tokens`,
      ]
      await ctx.send(lines.join('\n'))
    },
  })

  registry.set('archive', {
    description: 'Archive the entire conversation history into topic memory now.',
    handler: async (_args, ctx) => {
      await ctx.send('Archiving conversation history…')
      const count = await ctx.forceArchive()
      if (count === -1) {
        await ctx.send('Archival already in progress, try again in a moment.')
      } else if (count === 0) {
        await ctx.send('Nothing to archive.')
      } else {
        await ctx.send(`Archived ${count} message${count === 1 ? '' : 's'} into topic memory.`)
      }
    },
  })

  registry.set('reset', {
    description: 'Stop all running agents and clear conversation history, agents, and the event queue. Keeps schedules, reminders, usage, and archived memory.',
    handler: async (_args, ctx) => {
      const cancelled = await ctx.retractAllAgents()
      ctx.clearHistory()
      ctx.clearAgents()
      ctx.clearQueue()
      const agentNote = cancelled > 0 ? ` Stopped ${cancelled} running agent${cancelled === 1 ? '' : 's'}.` : ''
      await ctx.send(`Conversation reset.${agentNote} Schedules, reminders, usage, and memory are untouched.`)
    },
  })

  registry.set('resetthedatabaseimsupersureandnotmakingamistake', {
    description: 'Nuclear option — delete conversation history, agents, queue, steward runs, AND reminders. Keeps schedules, usage, and archived memory.',
    handler: async (_args, ctx) => {
      ctx.clearHistory()
      ctx.clearAgents()
      ctx.clearQueue()
      ctx.clearStewardRuns()
      ctx.clearReminders()
      await ctx.send('Conversation history, agents, queue, steward runs, and reminders cleared.')
    },
  })

  registry.set('doctor', {
    description: 'Run a health check and display system status.',
    handler: async (_args, ctx) => {
      const version = process.env['SHROK_VERSION'] ?? 'unknown'
      const lines: string[] = [`**Shrok Health Report** (v${version})`, '']
      const { config } = ctx

      // ── LLM ──────────────────────────────────────────────────────────────────
      const provider = config.llmProvider
      const llmKeyPresent = (
        (provider === 'anthropic'    && !!config.anthropicApiKey) ||
        (provider === 'gemini'       && !!config.geminiApiKey) ||
        (provider === 'openai'       && !!config.openaiApiKey)
      )
      lines.push(`**LLM** ${llmKeyPresent ? '✅' : '⚠️'} ${provider}${llmKeyPresent ? ' (key set)' : ' (key not set)'}`)

      // ── Search ────────────────────────────────────────────────────────────────
      const searchProvider = (process.env['SEARCH_PROVIDER'] ?? 'tavily').toLowerCase()
      const searchKeyPresent = searchProvider === 'brave'
        ? !!process.env['BRAVE_API_KEY']
        : !!process.env['TAVILY_API_KEY']
      const searchKeyName = searchProvider === 'brave' ? 'BRAVE_API_KEY' : 'TAVILY_API_KEY'
      lines.push(`**Search** ${searchKeyPresent ? '✅' : '⚠️'} ${searchProvider}${searchKeyPresent ? '' : ` (${searchKeyName} not set)`}`)

      // ── Memory ────────────────────────────────────────────────────────────────
      try {
        const topicCount = await ctx.getTopicCount()
        lines.push(`**Memory** ✅ ${topicCount} topic${topicCount === 1 ? '' : 's'} archived`)
      } catch (err) {
        lines.push(`**Memory** ❌ ${(err as Error).message}`)
      }

      // ── Database ──────────────────────────────────────────────────────────────
      try {
        const stats = ctx.getDbStats()
        let dbSize = ''
        try {
          const stat = await fs.stat(config.dbPath)
          dbSize = ` · ${formatBytes(stat.size)}`
        } catch { /* db path might not be resolvable */ }
        lines.push(`**Database** ✅ ${stats.messages.toLocaleString()} messages · ${stats.agents.toLocaleString()} agents · ${stats.schedules.toLocaleString()} schedules${dbSize}`)
      } catch (err) {
        lines.push(`**Database** ❌ ${(err as Error).message}`)
      }

      // ── Workspace ─────────────────────────────────────────────────────────────
      try {
        const resolvedWorkspace = config.workspacePath.replace(/^~/, process.env['HOME'] ?? '~')
        await fs.access(resolvedWorkspace, 4 /* fs.constants.W_OK */)
        lines.push(`**Workspace** ✅ ${config.workspacePath}`)
      } catch (err) {
        lines.push(`**Workspace** ❌ ${(err as Error).message}`)
      }

      // ── Media ─────────────────────────────────────────────────────────────────
      try {
        const resolvedWorkspace = config.workspacePath.replace(/^~/, process.env['HOME'] ?? '~')
        const mediaDir = path.join(resolvedWorkspace, 'media')
        const entries = await fs.readdir(mediaDir)
        let totalBytes = 0
        for (const entry of entries) {
          try { totalBytes += (await fs.stat(path.join(mediaDir, entry))).size } catch { /* skip */ }
        }
        lines.push(`**Media** ✅ ${entries.length} file${entries.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`)
      } catch {
        lines.push(`**Media** — no media directory`)
      }

      // ── Channels ──────────────────────────────────────────────────────────────
      const channelParts: string[] = []
      if (config.discordBotToken && config.discordChannelId) channelParts.push('✅ discord')
      else if (config.discordBotToken || config.discordChannelId) channelParts.push('⚠️ discord (partial config)')
      if (config.telegramBotToken && config.telegramChatId) channelParts.push('✅ telegram')
      else if (config.telegramBotToken || config.telegramChatId) channelParts.push('⚠️ telegram (partial config)')
      if (config.slackBotToken && config.slackAppToken && config.slackChannelId) channelParts.push('✅ slack')
      else if (config.slackBotToken || config.slackAppToken || config.slackChannelId) channelParts.push('⚠️ slack (partial config)')
      if (config.whatsappAllowedJid) channelParts.push('✅ whatsapp')
      lines.push(`**Channels** ${channelParts.length > 0 ? channelParts.join('  ') : '— none configured'}`)

      // ── MCP ───────────────────────────────────────────────────────────────────
      const caps = ctx.getMcpCapabilities()
      if (caps.length > 0) {
        lines.push(`**MCP** ✅ ${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'} (${caps.join(', ')})`)
      } else {
        lines.push(`**MCP** — none configured`)
      }

      // ── Spend ─────────────────────────────────────────────────────────────────
      const status = ctx.getStatus()
      const blockingSuffix = status.blockingThresholds > 0
        ? ` · ${status.blockingThresholds} block threshold${status.blockingThresholds === 1 ? '' : 's'} active`
        : ''
      lines.push(`**Spend today** $${status.estimatedSpendToday.toFixed(2)}${blockingSuffix}`)

      // ── Footer ────────────────────────────────────────────────────────────────
      lines.push(`\nUptime: ${formatUptime(status.uptimeSeconds)} · Active agents: ${status.activeAgents}`)

      await ctx.send(lines.join('\n'))
    },
  })

  registry.set('changedashboardpassword', {
    description: 'Set a new dashboard password. Args: `<new-password> <new-password>`',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      if (parts.length < 2 || !parts[0]) {
        await ctx.send('Usage: `~changedashboardpassword <new-password> <new-password>`')
        return
      }
      const [password, confirm] = parts
      if (password !== confirm) {
        await ctx.send('Passwords do not match.')
        return
      }
      if (password!.length < 8) {
        await ctx.send('Password must be at least 8 characters.')
        return
      }
      const newPassword = password!
      try {
        const hash = await bcryptjs.hash(newPassword, 12)
        const envFile = process.env['SHROK_ENV_FILE']
        if (!envFile) {
          await ctx.send('Could not locate .env file.')
          return
        }
        // Read, update, write the .env file
        const env: Record<string, string> = {}
        try {
          for (const line of fsSync.readFileSync(envFile, 'utf8').split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eq = trimmed.indexOf('=')
            if (eq === -1) continue
            env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
          }
        } catch { /* file may not exist yet */ }
        env['DASHBOARD_PASSWORD_HASH'] = hash
        const content = Object.entries(env)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => {
            // Use single quotes for values containing $ (e.g. bcrypt hashes)
            // to prevent shell expansion when users source the .env file
            if (v.includes('$')) return `${k}='${v.replaceAll("'", "'\\''")}'`
            if (/[\s"'#\\]/.test(v)) return `${k}="${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
            return `${k}=${v}`
          })
          .join('\n') + '\n'
        fsSync.mkdirSync(path.dirname(envFile), { recursive: true })
        fsSync.writeFileSync(envFile, content, { encoding: 'utf8', mode: 0o600 })
        // Update live config so the running dashboard accepts the new password immediately
        ;(ctx.config as Record<string, unknown>).dashboardPasswordHash = hash
        ctx.revokeDashboardSessions?.()
        await ctx.send('Dashboard password updated. All sessions revoked. Delete this message for security.')
      } catch (err) {
        await ctx.send(`Failed to update password: ${(err as Error).message}`)
      }
    },
  })

  registry.set('feedback', {
    description: 'Generate a pre-filled GitHub issue link for feedback, bugs, or feature requests. Use `--diagnostics` to include system info.',
    handler: async (args, ctx) => {
      const wantsDiag = args.includes('--diagnostics')
      const feedbackText = args.replace('--diagnostics', '').trim()

      if (!feedbackText) {
        await ctx.send('Usage: `~feedback [--diagnostics] your feedback here`\n\nDescribe the issue or suggestion and I\'ll generate a GitHub issue link for you to review and submit.')
        return
      }

      // Read version from package.json
      let version = 'unknown'
      try {
        const pkg = JSON.parse(fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
        version = pkg.version ?? 'unknown'
      } catch { /* ignore */ }

      // Build issue body
      const bodyParts: string[] = []
      bodyParts.push(feedbackText)
      bodyParts.push('')
      bodyParts.push('---')
      bodyParts.push('')
      bodyParts.push('**Environment**')
      bodyParts.push(`- Shrok: v${version}`)
      bodyParts.push(`- Provider: ${ctx.config.llmProvider}`)
      bodyParts.push(`- Node: ${process.version}`)
      bodyParts.push(`- OS: ${process.platform} ${process.arch}`)

      if (wantsDiag) {
        bodyParts.push('')
        bodyParts.push('**Diagnostics**')
        const status = ctx.getStatus()
        const stats = ctx.getDbStats()
        bodyParts.push(`- Context window: ${ctx.config.contextWindowTokens.toLocaleString()} tokens`)
        bodyParts.push(`- Memory budget: ${ctx.config.memoryBudgetPercent}%`)
        bodyParts.push(`- Active agents: ${status.activeAgents} (${status.runningAgents} running, ${status.suspendedAgents} suspended)`)
        bodyParts.push(`- Messages: ${stats.messages.toLocaleString()}`)
        bodyParts.push(`- Schedules: ${stats.schedules.toLocaleString()}`)
        try {
          const topicCount = await ctx.getTopicCount()
          bodyParts.push(`- Memory topics: ${topicCount}`)
        } catch { /* ignore */ }
        const channels: string[] = []
        if (ctx.config.discordBotToken) channels.push('discord')
        if (ctx.config.telegramBotToken) channels.push('telegram')
        if (ctx.config.slackBotToken) channels.push('slack')
        if (ctx.config.whatsappAllowedJid) channels.push('whatsapp')
        channels.push('dashboard')
        bodyParts.push(`- Channels: ${channels.join(', ')}`)
        const caps = ctx.getMcpCapabilities()
        if (caps.length > 0) bodyParts.push(`- MCP: ${caps.join(', ')}`)
      }

      // Build title from first line of feedback, capped
      const titleText = feedbackText.split('\n')[0]!.slice(0, 80)
      const title = `Feedback: ${titleText}`

      const body = bodyParts.join('\n')

      // GitHub URL length limit is ~8000 chars
      const MAX_URL_LEN = 7500
      const baseUrl = 'https://github.com/getshrok/shrok/issues/new'
      const params = new URLSearchParams({
        title,
        body: body.length > MAX_URL_LEN ? body.slice(0, MAX_URL_LEN) + '\n\n*(Diagnostics truncated — paste additional details below if relevant.)*' : body,
        labels: 'user-feedback',
      })

      const url = `${baseUrl}?${params.toString()}`

      await ctx.send(`Here's a feedback link ready to submit — review it and click **Create** if it looks right:\n\n${url}`)
    },
  })

  registry.set('help', {
    description: 'List available slash commands.',
    handler: async (_args, ctx) => {
      const lines = ['**Slash commands:**', '']
      for (const [name, cmd] of registry) {
        lines.push(`\`~${name}\` — ${cmd.description}`)
      }
      await ctx.send(lines.join('\n'))
    },
  })

  return registry
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
