import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import { restartProcess } from '../restart.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../logger.js'
import type { QueueEvent, Message, TextMessage, ToolCallMessage, ToolResultMessage, ToolCall, ToolResult } from '../types/core.js'
import type { LLMRouter } from '../types/llm.js'
import type { Memory } from '../memory/index.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { QueueStore } from '../db/queue.js'
import type { AppStateStore } from '../db/app_state.js'
import type { UsageStore, UsageEntry } from '../db/usage.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { ChannelRouter } from '../types/channel.js'
import type { Config } from '../config.js'
import { findBlockingThresholds, formatThresholdBlock } from '../usage-threshold.js'
import type { ContextAssembler } from './assembler.js'
import type { Injector } from './injector.js'
import { HEAD_TOOLS, HeadToolExecutor, type HeadToolExecutorOptions } from './index.js'
import type { ToolDefinition } from '../types/llm.js'
import { archiveMessages } from './archival.js'
import { buildCommandRegistry, type SlashCommand, type UsageMode } from './commands.js'
import { runToolLoop, LoopDetectedError, stripTimestampEcho } from '../llm/tool-loop.js'
import { runStewards, runRelaySteward, runWorkSummarySteward, runHeadRelaySteward, runRoutingSteward, runContextRelevanceSteward, DEFAULT_STEWARDS } from './steward.js'
import { extractAgentOwnWork, formatWorkForSummary } from './injector.js'
import { systemTrigger, systemEvent, systemNudge, MARKER_TAGS, LEGACY_MARKER_PREFIXES } from '../markers.js'
import { timingMark } from '../timing.js'
import type { StewardRunStore } from '../db/steward_runs.js'
import type { DashboardEventBus } from '../dashboard/events.js'
import { estimateTokens, estimateStringTokens } from '../db/token.js'
import { generateId, generateAgentId, now, LLMApiError } from '../llm/util.js'
import { runProactiveDecision, runReminderDecision } from '../scheduler/proactive.js'
import { formatIanaTimeLine } from '../util/time.js'
import { ensureSkillDeps } from '../sub-agents/env.js'

function providerStatusUrl(provider: string): string {
  if (provider === 'gemini') return 'https://status.cloud.google.com'
  if (provider === 'openai') return 'https://status.openai.com'
  return 'https://status.anthropic.com'
}

/** Strip attachment blobs from history messages so old images aren't re-sent to the LLM. */
function stripAttachmentsFromHistory(messages: Message[]): Message[] {
  return messages.map(m => {
    if (m.kind === 'text' && (m as TextMessage).attachments?.length) {
      return { ...m, attachments: [] }
    }
    if (m.kind === 'tool_result') {
      const tr = m as ToolResultMessage
      const hasAny = tr.toolResults.some(r => r.attachments?.length)
      if (hasAny) {
        return {
          ...m,
          toolResults: tr.toolResults.map(r =>
            r.attachments?.length ? { ...r, attachments: [] } : r
          ) as [ToolResult, ...ToolResult[]],
        }
      }
    }
    return m
  })
}

/** Check if any messages in the array carry attachments. */
function hasAttachmentsInHistory(messages: Message[]): boolean {
  return messages.some(m =>
    (m.kind === 'text' && !!(m as TextMessage).attachments?.length) ||
    (m.kind === 'tool_result' && (m as ToolResultMessage).toolResults.some(r => !!r.attachments?.length))
  )
}

// ─── ActivationLoop ───────────────────────────────────────────────────────────

export interface ActivationLoopOptions {
  queueStore: QueueStore
  messages: MessageStore
  appState: AppStateStore
  usageStore: UsageStore
  topicMemory: Memory
  agentStore: AgentStore
  llmRouter: LLMRouter
  channelRouter: ChannelRouter
  assembler: ContextAssembler
  injector: Injector
  toolExecutorOpts: HeadToolExecutorOptions
  config: Config
  scheduleStore: ScheduleStore
  mcpRegistry: McpRegistry
  stewardRunStore?: StewardRunStore
  events?: DashboardEventBus
  transaction: (fn: () => void) => void
  maintenance?: () => void
  pollIntervalMs?: number
  getUptimeSeconds?: () => number
  /** Override HEAD_TOOLS for testing (e.g. strip acknowledgment requirement from spawn_agent). */
  headTools?: ToolDefinition[]
  /** Override terminal tool names for testing (e.g. [] to force Round 2 after every spawn). */
  terminalToolNames?: string[]
  /** Override stewards for testing (e.g. [] to disable all stewards). */
  stewards?: import('./steward.js').Steward[]
  /** Revoke all dashboard sessions (called on password change). */
  revokeDashboardSessions?: () => void
}

/** Strip hallucinated system marker tags from model output before sending to the channel. */
function stripMarkerContent(text: string): string {
  const markers = [...MARKER_TAGS, ...LEGACY_MARKER_PREFIXES]
  const idx = markers.reduce((min, m) => {
    const i = text.indexOf(m)
    return i >= 0 && i < min ? i : min
  }, Infinity)
  return (idx < Infinity ? text.slice(0, idx) : text).trim()
}

/** Default token budget for steward context history. */
const STEWARD_CONTEXT_TOKEN_BUDGET = 10_000

/**
 * Build a token-budgeted history for stewards. Walks backward from most recent,
 * includes full message content (no character truncation), stops when budget is exhausted.
 */
function buildStewardHistory(
  messages: TextMessage[],
  tokenBudget = STEWARD_CONTEXT_TOKEN_BUDGET,
): Array<{ role: string; content: string; createdAt?: string }> {
  const result: Array<{ role: string; content: string; createdAt?: string }> = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const cost = estimateStringTokens(`[${m.role}] ${m.content}`)
    if (used + cost > tokenBudget) break
    result.unshift({ role: m.role, content: m.content, createdAt: m.createdAt })
    used += cost
  }
  return result
}

export class ActivationLoop {
  private running = false
  private emitter = new EventEmitter()
  private opts: ActivationLoopOptions
  private pollIntervalMs: number
  private usageModes = new Map<string, UsageMode>()
  private commands: Map<string, SlashCommand> = buildCommandRegistry()
  private postActivationCallbacks: Array<() => void> = []

  /** Late-bind session revocation (dashboard created after activation loop). */
  setRevokeDashboardSessions(fn: () => void): void { this.opts.revokeDashboardSessions = fn }

  private readAmbientContext(): string {
    try {
      const ws = this.opts.config.workspacePath?.replace(/^~/, os.homedir())
      if (!ws) return ''
      return fs.readFileSync(path.join(ws, 'AMBIENT.md'), 'utf8').trim()
    } catch { return '' }
  }

  // Track event IDs whose user messages have already been appended to history.
  // Prevents double-appending when the rate-limit retry re-calls handleEvent.
  private appendedEventIds = new Set<string>()

  constructor(opts: ActivationLoopOptions) {
    this.opts = opts
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000
  }

  /** Notify the loop that a new event is available — skip the poll wait. */
  notify(): void {
    this.emitter.emit('event')
  }

  /** Run a ~ command immediately, bypassing the queue.
   *  Called by channel adapters so commands respond even while an activation is running. */
  async handleCommand(text: string, channel: string): Promise<void> {
    try {
      await this.runCommand(text, channel)
    } catch (err) {
      log.error(`[activation] command failed: ${err instanceof Error ? err.message : String(err)}`)
      try {
        await this.opts.channelRouter.send(channel, `Command failed: ${err instanceof Error ? err.message : String(err)}`)
      } catch { /* best effort */ }
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.drain()
  }

  announceOnline(): void {
    const channel = this.opts.appState.getLastActiveChannel()
      || this.opts.channelRouter.getFirstChannel()
    if (!channel) return
    // Inject a system message so the head announces it just came online.
    this.opts.queueStore.enqueue(
      { type: 'user_message', id: generateId('qe'), channel, text: systemTrigger('greeting', undefined, 'Send a brief greeting to the user.'), createdAt: new Date().toISOString() },
      100,
    )
    this.notify()
  }

  stop(): void {
    this.running = false
    this.emitter.emit('stop')
  }

  onPostActivation(callback: () => void): void {
    this.postActivationCallbacks.push(callback)
  }

  private async drain(): Promise<void> {
    while (this.running) {
      try {
        await this.processOne()
      } catch (err) {
        log.error('[activation] Unhandled error in drain loop:', (err as Error).message)
      }
    }
  }

  private async processOne(): Promise<void> {
    const claimed = this.opts.queueStore.claimNext()

    if (!claimed) {
      // Nothing to process — wait for poll interval or notification
      await this.waitForEvent()
      return
    }

    const { rowId, event } = claimed

    // ── Threshold block check ──────────────────────────────────────────────────
    // Pre-event check: any block-action threshold currently over budget halts
    // the loop before this activation runs. Release (not fail) preserves the
    // user's message for retry after the threshold is raised or the period
    // rolls over. Loop stops to avoid hot-looping the released row.
    const blocking = findBlockingThresholds(
      this.opts.appState.getThresholds(),
      (since) => this.opts.usageStore.getCostSince(since),
      new Date(),
      this.opts.config.timezone,
    )
    if (blocking.length > 0) {
      this.opts.queueStore.release(rowId)
      for (const c of blocking) {
        log.error(`[circuit-breaker] threshold ${c.threshold.period} $${c.threshold.amountUsd.toFixed(2)} blocked: $${c.currentSpend.toFixed(2)} of $${c.threshold.amountUsd.toFixed(2)}`)
      }
      const channel = this.opts.appState.getLastActiveChannel()
      if (channel) {
        const text = formatThresholdBlock(blocking[0]!)
        this.opts.messages.append({
          kind: 'text',
          role: 'assistant',
          id: generateId('msg'),
          content: text,
          channel,
          createdAt: now(),
        })
        await this.opts.channelRouter.send(channel, text)
      }
      this.stop()
      return
    }
    // ──────────────────────────────────────────────────────────────────────────

    try {
      await this.handleEvent(event)
      this.opts.queueStore.ack(rowId)
    } catch (err) {
      // Rate limit: wait for the retry-after window and try once more rather than
      // dropping the message. The Codex/OpenAI TPM window is ~60s; Anthropic similar.
      // Skip retry entirely if the wait exceeds 2 min (quota exhausted, not just throttled).
      if (err instanceof LLMApiError && err.type === 'rate_limit') {
        const waitMs = err.retryAfterMs ?? 60_000
        if (waitMs <= 120_000) {
          log.warn(`[activation] Rate limited by ${err.provider} — waiting ${Math.round(waitMs / 1000)}s before retry`)
          const notifyChannel = event.type === 'user_message'
            ? event.channel
            : this.opts.appState.getLastActiveChannel()
          if (notifyChannel) {
            const anthropicHint = err.provider === 'anthropic'
              ? ' New Anthropic accounts are on Tier 1 (~30k tokens/min); pre-purchasing $40+ in credits at console.anthropic.com → Settings → Billing jumps you to Tier 2 and usually fixes this.'
              : ''
            void this.opts.channelRouter.send(
              notifyChannel,
              `⏳ ${err.provider} is rate-limiting me — waiting ~${Math.round(waitMs / 1000)}s before retrying.${anthropicHint}`,
            ).catch(sendErr => log.warn('[activation] Failed to send rate-limit notice:', (sendErr as Error).message))
          }
          await new Promise(r => setTimeout(r, waitMs))
          try {
            await this.handleEvent(event)
            this.opts.queueStore.ack(rowId)
            return
          } catch (retryErr) {
            err = retryErr
          }
        } else {
          log.warn(`[activation] Quota exhausted by ${err.provider} — reset in ${Math.round(waitMs / 60_000)}m, skipping retry`)
        }
      }

      // Server error (502/503/529): retry up to 3 times with exponential backoff (2s, 4s, 8s).
      // These are transient provider outages — worth retrying before surfacing to the user.
      if (err instanceof LLMApiError && err.type === 'server_error') {
        for (let attempt = 0; attempt < 3; attempt++) {
          const waitMs = 2_000 * (2 ** attempt)
          log.warn(`[activation] Server error from ${err.provider} — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/3)`)
          await new Promise(r => setTimeout(r, waitMs))
          try {
            await this.handleEvent(event)
            this.opts.queueStore.ack(rowId)
            return
          } catch (retryErr) {
            err = retryErr
            if (!(err instanceof LLMApiError) || err.type !== 'server_error') break
          }
        }
      }

      log.error(`[activation] Failed to handle event ${event.type}:`, (err as Error).message)
      this.opts.queueStore.fail(rowId)

      if (event.type === 'user_message') {
        const channel = this.opts.appState.getLastActiveChannel()
        if (channel) {
          const anthropicHint = err instanceof LLMApiError && err.provider === 'anthropic'
            ? '\n\nCommon Anthropic issues: new accounts are on Tier 1 (~30k tokens/min) which causes slow responses — this improves after ~$40 in usage. You can reach this immediately by pre-purchasing credits at console.anthropic.com → Settings → Billing. There is also a default $100/month spend cap that blocks all requests when reached. Check https://console.anthropic.com → Settings → Limits.'
            : ''
          const msg = err instanceof LLMApiError
            ? err.type === 'auth'
              ? `I couldn't reach the AI provider — the API key may be invalid or expired. You can fix this by asking me to reconfigure your provider.` + anthropicHint
              : err.type === 'rate_limit'
                ? err.retryAfterMs && err.retryAfterMs > 120_000
                  ? `The AI provider quota is exhausted — resets in about ${Math.round(err.retryAfterMs / 60_000)} minutes.` + anthropicHint
                  : `The AI provider is still rate-limiting after retrying. Try again in a moment — if it persists, check ${providerStatusUrl(err.provider)}.` + anthropicHint
                : err.type === 'server_error'
                  ? `The AI provider is having an outage. Nothing to do but wait — check ${providerStatusUrl(err.provider)} for status.`
                  : `I ran into an unexpected error and couldn't respond. Check the logs for details.` + anthropicHint
            : err instanceof LoopDetectedError
              ? `I stopped early: ${err.reason}`
              : (err as Error).message?.includes('maxRounds')
              ? `I got stuck in a loop and had to stop. Try rephrasing your request.`
              : `I ran into an unexpected error and couldn't respond. Check the logs for details.`
          // Save to DB so it appears in the dashboard (dashboard adapter.send is a no-op)
          this.opts.messages.append({
            kind: 'text',
            role: 'assistant',
            id: generateId('msg'),
            content: msg,
            channel,
            createdAt: now(),
          })
          await this.opts.channelRouter.send(channel, msg)
        }
      }
    }

    // After each activation, check if archival is needed (non-blocking)
    void this.maybeArchive()

    // Run post-activation hooks (e.g., restart sentinel check)
    for (const cb of this.postActivationCallbacks) cb()
  }

  private async runCommand(text: string, channel: string): Promise<void> {
    this.opts.appState.setLastActiveChannel(channel)
    const spaceIdx = text.indexOf(' ')
    const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
    const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
    const command = this.commands.get(cmdName)
    if (command) {
      await command.handler(args, {
        channel,
        send: async (msg) => {
          this.opts.messages.append({
            kind: 'text',
            role: 'assistant',
            id: generateId('msg'),
            content: msg,
            channel,
            createdAt: now(),
          })
          await this.opts.channelRouter.send(channel, msg)
        },
        appState: this.opts.appState,
        usageModes: this.usageModes,
        getStatus: () => {
          const running = this.opts.agentStore.getByStatus('running')
          const suspended = this.opts.agentStore.getByStatus('suspended')
          return {
            uptimeSeconds: this.opts.getUptimeSeconds?.() ?? Math.floor(process.uptime()),
            estimatedSpendToday: this.opts.usageStore.getEstimatedCostToday(),
            blockingThresholds: this.opts.appState.getThresholds().filter(t => t.action === 'block').length,
            activeAgents: running.length + suspended.length,
            runningAgents: running.length,
            suspendedAgents: suspended.length,
          }
        },
        stop: () => { this.stop(); setTimeout(() => process.exit(0), 500) },
        restart: () => {
          this.stop()
          setTimeout(() => restartProcess(), 500)
        },
        forceArchive: async () => {
          const allMessages = this.opts.messages.getRecent(Infinity)
          if (allMessages.length === 0) return 0
          if (!this.opts.appState.tryAcquireArchivalLock()) return -1
          try {
            const result = await archiveMessages(allMessages, {
              topicMemory: this.opts.topicMemory,
              messages: this.opts.messages,
            }, 1.0)
            try { this.opts.maintenance?.() } catch { /* best effort */ }
            return result?.archivedMessageIds.length ?? 0
          } finally {
            this.opts.appState.releaseArchivalLock()
          }
        },
        clearHistory: () => this.opts.messages.deleteAll(),
        clearAgents: () => this.opts.agentStore.deleteAll(),
        retractAllAgents: async () => {
          const active = this.opts.agentStore.getActive()
          for (const a of active) {
            await this.opts.toolExecutorOpts.agentRunner.retract(a.id)
          }
          return active.length
        },
        clearQueue: () => this.opts.queueStore.deleteAll(),
        clearStewardRuns: () => this.opts.stewardRunStore?.clear(),
        clearReminders: () => {
          const all = this.opts.scheduleStore.list().filter(s => s.kind === 'reminder')
          for (const s of all) this.opts.scheduleStore.delete(s.id)
        },
        config: this.opts.config,
        getTopicCount: async () => (await this.opts.topicMemory.getTopics()).length,
        getDbStats: () => ({
          messages: this.opts.messages.count(),
          agents: this.opts.agentStore.count(),
          schedules: this.opts.scheduleStore.count(),
          reminders: this.opts.scheduleStore.list().filter(s => s.kind === 'reminder').length,
        }),
        getHeadContextStats: () => {
          const all = this.opts.messages.getAll()
          const memoryFraction = (this.opts.config.memoryBudgetPercent ?? 40) / 100
          const historyBudget = Math.floor(this.opts.config.contextWindowTokens * (1 - memoryFraction))
          const archivalThreshold = Math.floor(historyBudget * this.opts.config.archivalThresholdFraction)
          return {
            messageCount: all.length,
            tokens: estimateTokens(all),
            oldestCreatedAt: all[0]?.createdAt ?? null,
            historyBudget,
            archivalThreshold,
          }
        },
        getMcpCapabilities: () => this.opts.mcpRegistry.listCapabilities(),
        getSpendSummary: (since?: string) => {
          const s = this.opts.usageStore.getSummary(since)
          return { costUsd: s.costUsd, inputTokens: s.inputTokens, outputTokens: s.outputTokens }
        },
        ...(this.opts.revokeDashboardSessions ? { revokeDashboardSessions: this.opts.revokeDashboardSessions } : {}),
      })
    } else {
      await this.opts.channelRouter.send(channel, `Unknown command: \`~${cmdName}\`. Type \`~help\` for available commands.`)
    }
  }

  private async handleEvent(event: QueueEvent): Promise<void> {
    timingMark('head.event_received', {
      sourceType: 'head',
      event_type: event.type,
      ...('channel' in event && event.channel ? { channel: event.channel } : {}),
      ...('id' in event && event.id ? { event_id: event.id } : {}),
    })
    if (event.type === 'schedule_trigger') {
      await this.handleScheduleTrigger(event)
      return
    }

    let typingInterval: ReturnType<typeof setInterval> | null = null
    let coalescedEvents: Array<{ rowId: string; event: QueueEvent }> = []

    // Mark activation start before any messages are written — the user message
    // and synthetic view_image injections must fall within the activation window
    // so their attachments survive stripAttachmentsFromHistory.
    const activationStart = now()

    if (event.type === 'user_message') {
      // Slash command — meta control, not a conversation message
      if (event.text.trim().startsWith('~')) {
        await this.runCommand(event.text.trim(), event.channel)
        return
      }

      // Append user message to history immediately so the dashboard shows it
      // before the routing steward runs (avoids the message appearing to be swallowed).
      if (!this.appendedEventIds.has(event.id)) {
        this.appendedEventIds.add(event.id)
        // Keep all attachments on the user message for dashboard display.
        // Image attachments are also injected via synthetic view_image below.
        // Non-image attachments are surfaced to the LLM via the formatter's attachmentStub().
        const imageAttachments = event.attachments?.filter(a => a.type === 'image' && a.path) ?? []
        this.opts.messages.append({
          kind: 'text',
          role: 'user',
          id: generateId('msg'),
          content: event.text,
          ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          ...(event.injected ? { injected: true } : {}),
          channel: event.channel,
          createdAt: now(),
        })
        // Inject synthetic view_image for uploaded images so the head sees them immediately
        if (imageAttachments.length > 0) {
          const toolCalls: ToolCall[] = imageAttachments.map(a => ({
            id: generateId('tc'), name: 'view_image', input: { path: a.path! } as Record<string, unknown>,
          }))
          const toolResults: ToolResult[] = toolCalls.map((tc, i) => {
            const a = imageAttachments[i]!
            return {
              toolCallId: tc.id, name: 'view_image',
              content: `Viewing image: ${a.path} (${a.filename ?? 'uploaded image'})`,
              attachments: [a],
            }
          })
          this.opts.messages.append({
            kind: 'tool_call', id: generateId('msg'), createdAt: now(), content: '',
            toolCalls: toolCalls as [ToolCall, ...ToolCall[]],
          } as ToolCallMessage)
          this.opts.messages.append({
            kind: 'tool_result', id: generateId('msg'), createdAt: now(),
            toolResults: toolResults as [ToolResult, ...ToolResult[]],
          } as ToolResultMessage)
        }
        this.opts.appState.setLastActiveChannel(event.channel)
      }

      // Routing steward: hint at the best approach for this message.
      // Runs after the user message is appended so the dashboard shows it immediately.
      let routingHint: string | null = null
      if (this.opts.config.routingStewardEnabled && event.text.length >= 10 && !event.text.includes('type="greeting"')) {
        const skills = this.opts.toolExecutorOpts.skillLoader.listAll()
        const skillList = skills.map(s => `- ${s.name}: ${s.frontmatter.description}`).join('\n')
        const recent = this.opts.messages.getRecent(2000)
          .filter((m): m is TextMessage => m.kind === 'text' && !m.injected)
          .slice(-5)
          .map(m => ({ role: m.role, content: m.content }))
        // Pass recently completed agents so the steward can suggest continuation
        const completedAgents = this.opts.config.agentContinuationEnabled
          ? this.opts.agentStore.getRecent(5)
              .filter(a => a.status === 'completed')
              .slice(0, 3)
              .map(a => ({ id: a.id, task: a.task }))
          : []
        // Pass attachment filenames/types so the steward can reason about "what's in this?" etc.
        const attachments = event.attachments?.map(a => ({
          filename: a.filename ?? a.path?.split(/[/\\]/).pop() ?? 'file',
          type: a.type,
          mediaType: a.mediaType,
        })) ?? []
        routingHint = await runRoutingSteward(
          event.text, skillList, recent,
          this.opts.llmRouter, this.opts.config.stewardModel,
          this.opts.usageStore, event.id,
          completedAgents,
          attachments,
        )
      }

      // Inject routing hint as a separate nudge message (after user message + images)
      if (routingHint) {
        this.opts.messages.append({
          kind: 'text',
          role: 'user',
          id: generateId('msg'),
          content: systemNudge(routingHint),
          injected: true,
          channel: event.channel,
          createdAt: now(),
        })
      }

      // Start typing indicator — fire immediately, then repeat every 5s so it
      // stays active across the full LLM call (Discord: 10s, Telegram: 5s expiry).
      const typingChannel = event.channel
      void this.opts.channelRouter.sendTyping(typingChannel)
      typingInterval = setInterval(() => {
        void this.opts.channelRouter.sendTyping(typingChannel)
      }, 5_000)
    } else {
      // Background event: claim coalesced events (same-type background events
      // pending in the queue). Stewards run BEFORE injection (append-only):
      // relay steward gates scheduled agent_completed entirely; work-summary
      // steward computes the content the injector will use.
      coalescedEvents = this.opts.queueStore.claimAllPendingBackground()
    }

    try {
    // ── Append-only injection path for background events ──────────────────
    // Build the list of agent_completed events across primary + coalesced.
    const completedEvents: Array<QueueEvent & { type: 'agent_completed' }> = []
    if (event.type === 'agent_completed') completedEvents.push(event as QueueEvent & { type: 'agent_completed' })
    for (const { event: ev } of coalescedEvents) {
      if (ev.type === 'agent_completed') completedEvents.push(ev as QueueEvent & { type: 'agent_completed' })
    }

    // Relay steward: for scheduled agent completions, decide if output warrants
    // activation. Runs BEFORE injection — !relay suppresses the injection entirely
    // (no retroactive delete needed).
    const suppressedEventIds = new Set<string>()
    let primarySuppressed = false
    if (event.type !== 'user_message' && this.opts.config.scheduledRelayStewardEnabled) {
      const { identityLoader, skillLoader } = this.opts.toolExecutorOpts
      for (const ce of completedEvents) {
        const a = this.opts.agentStore.get(ce.agentId)
        if (a?.trigger !== 'scheduled') continue
        const skill = a.skillName ? skillLoader.load(a.skillName) : null
        const relay = await runRelaySteward({
          output: ce.output,
          task: a.task,
          skillInstructions: skill?.instructions ?? '',
          userMd: identityLoader.readFile('USER.md') ?? '',
          soulMd: identityLoader.readFile('SOUL.md') ?? '',
          currentTime: formatIanaTimeLine(new Date(), this.opts.config.timezone),
        }, this.opts.llmRouter, this.opts.config.stewardModel, this.opts.usageStore, ce.id)
        if (!relay) {
          suppressedEventIds.add(ce.id)
          if (ce.id === event.id) primarySuppressed = true
          log.info(`[activation] Relay steward suppressed scheduled agent_completed for ${ce.agentId} — no injection performed`)
        }
      }
    }

    // If the primary event is suppressed, ack any coalesced suppressed rows and
    // return without activation. Mirrors the previous "early return" semantics.
    if (primarySuppressed) {
      for (const { rowId, event: ev } of coalescedEvents) {
        if (suppressedEventIds.has(ev.id)) {
          this.opts.queueStore.ack(rowId)
        }
      }
      return
    }

    // Work-summary steward: pre-compute overrides for every non-suppressed
    // agent_completed event. Injector will use these instead of raw tool dumps.
    const overrides = new Map<string, string>()
    if (event.type !== 'user_message') {
      for (const ce of completedEvents) {
        if (suppressedEventIds.has(ce.id)) continue
        const tag = `[work-summary:${ce.agentId}]`
        const a = this.opts.agentStore.get(ce.agentId)
        if (!a) { log.info(`${tag} skip: no agent`); continue }
        const ownWork = extractAgentOwnWork(a)
        if (ownWork.length === 0) { log.info(`${tag} skip: empty ownWork (workStart=${a.workStart}, history len=${a.history?.length ?? 0})`); continue }
        const formatted = formatWorkForSummary(ownWork)
        if (!formatted) { log.info(`${tag} skip: empty formatted (ownWork=${ownWork.length})`); continue }
        if (this.opts.config.relaySummary === false) { log.info(`${tag} skip: relaySummary disabled`); continue }
        const inTokens = estimateStringTokens(formatted)
        log.info(`${tag} running: ownWork=${ownWork.length} msgs, formatted=${formatted.length} chars (~${inTokens} tokens)`)
        const summary = await runWorkSummarySteward(
          { task: a.task, work: formatted },
          this.opts.llmRouter, this.opts.config.stewardModel,
          this.opts.usageStore, ce.id,
        )
        if (summary) {
          overrides.set(ce.id, summary)
          log.info(`${tag} applied summary (~${inTokens} tokens in, ~${estimateStringTokens(summary)} tokens out)`)
        } else {
          const toolCalls = ownWork.reduce((n, m) => n + (m.kind === 'tool_call' ? m.toolCalls.length : 0), 0)
          const stub = `(work summary unavailable — ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} elided)`
          overrides.set(ce.id, stub)
          log.info(`${tag} failed — stub applied (${toolCalls} tool calls elided)`)
        }
      }
    }

    // Inject (with override) + ack inside one transaction so a crash between
    // messages DB write and queue ack can't leave duplicate injections.
    if (event.type !== 'user_message') {
      this.opts.transaction(() => {
        for (const { rowId, event: ev } of coalescedEvents) {
          if (!suppressedEventIds.has(ev.id)) {
            this.injectEvent(ev, overrides.get(ev.id))
          }
          this.opts.queueStore.ack(rowId)
        }
        this.injectEvent(event, overrides.get(event.id))
      })
    }

    const context = await this.opts.assembler.assemble(event)
    const { identityLoader } = this.opts.toolExecutorOpts
    // Snapshot BOOTSTRAP.md content before the tool loop so the steward can detect
    // whether onboarding is still in progress. Uses the same fallback logic as the
    // rest of the identity system: workspace file if present, otherwise defaults.
    const bootstrapMdAtStart = identityLoader.readFile('BOOTSTRAP.md') ?? ''

    const debugChannel = event.type === 'user_message'
      ? event.channel
      : this.opts.appState.getLastActiveChannel()
    const visibility = this.opts.appState.getConversationVisibility()
    const onVerbose = debugChannel && visibility.agentWork
      ? (msg: string) => this.opts.channelRouter.sendDebug(debugChannel, msg)
      : null
    // onDebug fires for "deeper internals" echo — head tool previews, thinking blocks, system event dumps.
    // agentPills is intentionally excluded: it's a dashboard pill-bar UI concern, not a debug stream concept.
    const onDebug = debugChannel && (visibility.headTools || visibility.systemEvents || visibility.stewardRuns)
      ? (msg: string) => this.opts.channelRouter.sendDebug(debugChannel, msg)
      : null

    if (context.memoryBlock) {
      if (debugChannel && visibility.memoryRetrievals) {
        await this.opts.channelRouter.sendDebug(debugChannel, `\`\`\`\n[memory retrieved]\n${context.memoryBlock}\n\`\`\``)
      }
      this.opts.events?.emit('dashboard', { type: 'memory_retrieval', payload: { text: context.memoryBlock, eventId: event.id, tokens: estimateStringTokens(context.memoryBlock) } })
    }

    const eventAttachments = event.type === 'user_message' && event.attachments?.length
      ? event.attachments
      : undefined
    const pendingFileAttachments: import('../types/core.js').Attachment[] = []
    let lastAssistantContent: string | null = null
    const executor = new HeadToolExecutor({
      ...this.opts.toolExecutorOpts,
      agentStore: this.opts.agentStore,
      getHistory: () => context.history,
      ...(onDebug ? { onDebug } : {}),
      ...(onVerbose ? { onVerbose } : {}),
      ...(eventAttachments ? { getAttachments: () => eventAttachments } : {}),
      onFileQueued: (att) => pendingFileAttachments.push(att),
    })

    // Debug: show injected system event messages for background events
    if (onDebug && event.type !== 'user_message') {
      const injectedMsg = [...context.history].reverse().find(
        m => m.kind === 'text' && (m as TextMessage).role === 'assistant' && m.injected
      ) as TextMessage | undefined
      const content = injectedMsg?.content ?? formatInjectedEvent(event)
      await onDebug(`\`\`\`\n[injected assistant] ${content}\n\`\`\``)
    }

    // Channel for sending intermediate and final text
    const sendChannel = event.type === 'user_message'
      ? event.channel
      : this.opts.appState.getLastActiveChannel()

    const buildHistory = () => {
      const activationMessages = this.opts.messages.getSince(activationStart)
      const activationCost = estimateTokens(activationMessages)
      const priorBudget = Math.max(0, context.historyBudget - activationCost)
      const priorHistory = this.opts.messages.getRecentBefore(activationStart, priorBudget)
      return [...stripAttachmentsFromHistory(priorHistory), ...activationMessages]
    }

    // Context-relevance steward: trim history before the head LLM call
    let filteredBuildHistory = buildHistory
    if (this.opts.config.contextRelevanceStewardEnabled) {
      const fullHistory = buildHistory()
      if (fullHistory.length > 5) {  // No point filtering tiny histories
        try {
          const keepIndices = await runContextRelevanceSteward(
            fullHistory.map(m => ({
              role: m.kind === 'text' ? (m as TextMessage).role : 'tool',
              content: m.kind === 'text' ? (m as TextMessage).content : m.kind === 'tool_call' ? (m as ToolCallMessage).toolCalls[0].name : '(tool result)',
              createdAt: m.createdAt,
              ...(( m as TextMessage).injected !== undefined ? { injected: (m as TextMessage).injected } : {}),
            })),
            event.type === 'user_message' ? event.text : (event as { text?: string }).text ?? '',
            this.opts.llmRouter,
            this.opts.config.stewardModel,
            this.opts.usageStore,
            event.id,
            onDebug ?? undefined,
          )
          const keepSet = new Set(keepIndices)
          const filteredPrior = fullHistory.filter((_, i) => keepSet.has(i))
          onDebug?.(`\`[context-relevance]\` kept ${filteredPrior.length}/${fullHistory.length} messages`)
          // Return filtered prior history + any messages added during this activation
          // (the head's own tool calls/results from prior rounds in the current turn).
          // Without this, refreshHistory returns a stale snapshot and the model can't
          // see its own prior actions, causing spawn loops.
          filteredBuildHistory = () => {
            const activationMessages = this.opts.messages.getSince(activationStart)
            return [...filteredPrior, ...activationMessages]
          }
        } catch (err) {
          log.warn('[activation] context-relevance steward failed, using full history:', (err as Error).message)
        }
      }
    }

    const toolLoopOpts = {
      model: this.opts.config.headModel,
      stewardModel: this.opts.config.stewardModel,
      tools: this.opts.headTools ?? HEAD_TOOLS,
      terminalTools: this.opts.terminalToolNames ?? [],
      systemPrompt: context.systemPrompt,
      history: filteredBuildHistory(),
      executor,
      usage: this.opts.usageStore,
      sourceType: 'head' as const,
      sourceId: event.id,
      appendMessage: async (msg: Message, opts?: { isFinal?: boolean }) => {
        const isGreeting = event.type === 'user_message' && event.text.includes('type="greeting"')

        // Steward processing for assistant text — runs before storage
        if (msg.kind === 'text' && msg.role === 'assistant') {
          // Strip marker content (system tags) before steward sees the text
          const cleaned = stripMarkerContent(msg.content)
          if (!cleaned) return  // all marker content, nothing to store
          msg = { ...msg, content: cleaned }

          if (this.opts.config.headRelaySteward && !isGreeting) {
            const recent = this.opts.messages.getRecent(this.opts.config.headRelayStewardContextTokens)
              .filter((m): m is TextMessage => m.kind === 'text' && !m.injected && !m.content.includes('type="greeting"'))
              .map(m => ({ role: m.role, content: m.content }))
            const relayed = await runHeadRelaySteward(msg.content, recent, this.opts.llmRouter, this.opts.config.stewardModel, this.opts.usageStore, onDebug ?? undefined)
            msg = { ...msg, content: relayed }
          }

          lastAssistantContent = msg.content

          // Attach pending files from send_file (final round only)
          if (opts?.isFinal && pendingFileAttachments.length) {
            const mediaDir = path.join(this.opts.config.workspacePath.replace(/^~/, os.homedir()), 'media')
            for (const att of pendingFileAttachments) {
              if (att.path && !att.path.startsWith(mediaDir)) {
                const dest = path.join(mediaDir, att.filename ?? path.basename(att.path))
                fs.mkdirSync(mediaDir, { recursive: true })
                fs.copyFileSync(att.path, dest)
                att.path = dest
              }
            }
            msg = { ...msg, attachments: [...(msg.attachments ?? []), ...pendingFileAttachments] } as typeof msg
          }
        }

        // Store — once, in final form (with attachments if any)
        if (msg.kind === 'text' && msg.role === 'assistant' && event.type === 'user_message') {
          this.opts.messages.append({ ...msg, eventId: event.id })
        } else {
          this.opts.messages.append(msg)
        }

        // Deliver intermediate assistant text to external channels
        // (final round delivery happens post-loop, may include file attachments)
        if (msg.kind === 'text' && msg.role === 'assistant' && sendChannel && !opts?.isFinal) {
          await this.opts.channelRouter.send(sendChannel, msg.content)
          lastAssistantContent = null  // already delivered — prevent post-loop duplicate
        }
      },
      ...(onDebug ? { onDebug } : {}),
      // onVerbose intentionally not passed to the head's tool loop —
      // head text goes through appendMessage → relay steward → DB → SSE.
      // Agent tool loops get onVerbose via local.ts for xray output.
      loopSameArgsTrigger: this.opts.config.loopSameArgsTrigger,
      loopErrorTrigger: this.opts.config.loopErrorTrigger,
      loopPostNudgeErrorTrigger: this.opts.config.loopPostNudgeErrorTrigger,
      loopStewardToolInputChars: this.opts.config.loopStewardToolInputChars,
      loopStewardToolResultChars: this.opts.config.loopStewardToolResultChars,
      loopStewardSystemPromptChars: this.opts.config.loopStewardSystemPromptChars,
      loopStewardMaxTokens: this.opts.config.loopStewardMaxTokens,
      refreshHistory: filteredBuildHistory,
    }

    let finalResponse: import('../types/llm.js').LLMResponse
    try {
      finalResponse = await runToolLoop(this.opts.llmRouter, toolLoopOpts)
    } catch (err) {
      // If a 400 occurs and there are attachments in history, retry without them.
      // A bad attachment (wrong media type, expired URL, unsupported format) can
      // cause persistent 400s that brick the instance. Degraded (no image) is
      // vastly better than stuck forever.
      if (err instanceof LLMApiError && err.status === 400
          && hasAttachmentsInHistory(toolLoopOpts.history)) {
        log.warn(`[activation] 400 with attachments in history — retrying without: ${err.message}`)
        toolLoopOpts.history = stripAttachmentsFromHistory(toolLoopOpts.history)
        finalResponse = await runToolLoop(this.opts.llmRouter, toolLoopOpts)
      } else {
        throw err
      }
    }

    // Batching: if new user messages arrived while the LLM was running, fold the
    // intermediate response into history and re-activate rather than delivering.
    if (event.type === 'user_message') {
      let buffered = this.opts.queueStore.claimAllPendingUserMessages()
      while (buffered.length > 0) {
        log.info(`[activation] Re-activating: ${buffered.length} user message(s) arrived during LLM call`)
        let hasNewMessages = false
        for (const { rowId, event: ev } of buffered) {
          if (ev.type !== 'user_message') continue
          if (ev.text.trim().startsWith('~')) {
            // Command arrived during LLM run — execute it, don't inject into conversation
            await this.runCommand(ev.text.trim(), ev.channel)
            this.opts.queueStore.ack(rowId)
            continue
          }
          this.opts.messages.append({
            kind: 'text',
            role: 'user',
            id: generateId('msg'),
            content: ev.text,
            channel: ev.channel,
            createdAt: now(),
          })
          this.opts.appState.setLastActiveChannel(ev.channel)
          this.opts.queueStore.ack(rowId)
          hasNewMessages = true
        }
        if (hasNewMessages) {
          finalResponse = await runToolLoop(this.opts.llmRouter, { ...toolLoopOpts, history: toolLoopOpts.refreshHistory() })
        }
        buffered = this.opts.queueStore.claimAllPendingUserMessages()
      }

    }

    // Send final response to external channels (dashboard already has it via SSE from appendMessage).
    // The steward already processed the text in appendMessage — lastAssistantContent has the final version.
    const usageMode = sendChannel ? this.usageModes.get(sendChannel) : undefined
    // Send final response to external channels (dashboard already has it via SSE).
    // Attachments were already included in the stored message by appendMessage.
    if (lastAssistantContent && sendChannel) {
      if (pendingFileAttachments.length) {
        await this.opts.channelRouter.send(sendChannel, lastAssistantContent, pendingFileAttachments)
      } else {
        await this.opts.channelRouter.send(sendChannel, lastAssistantContent)
      }
    }

    // Steward: catch mandatory actions the head missed (runs after response delivery)
    const activationMsgs = this.opts.messages.getSince(activationStart)
    const toolsCalledThisTurn = activationMsgs
      .filter((m): m is ToolCallMessage => m.kind === 'tool_call')
      .flatMap(m => m.toolCalls)
      .map(tc => tc.name)

    if (finalResponse.content.trim() !== '' || toolsCalledThisTurn.includes('spawn_agent')) {
      const recentHistory = buildStewardHistory(
        this.opts.messages.getAll()
          .filter((m): m is TextMessage => m.kind === 'text' && m.createdAt < activationStart),
        this.opts.config.stewardContextTokenBudget,
      )

      // Note: schedule_trigger is handled by handleScheduleTrigger and returns early above,
      // so event.type here is never 'schedule_trigger'.
      const activationType: import('./steward.js').StewardContext['activationType'] =
        event.type === 'user_message' ? 'user_message'
        : event.type === 'agent_completed' ? 'agent_completed'
        : event.type === 'agent_failed' ? 'agent_failed'
        : event.type === 'agent_question' ? 'agent_question'
        : event.type === 'webhook' ? 'webhook'
        : 'other'

      const triggerText = event.type === 'user_message' ? event.text
        : event.type === 'agent_completed' ? event.output
        : event.type === 'agent_question' ? event.question
        : event.type === 'agent_failed' ? event.error
        : event.type === 'webhook' ? `${event.source}:${event.event}`
        : ''

      const stewardChannel = event.type === 'user_message'
        ? event.channel
        : (this.opts.appState.getLastActiveChannel() ?? '')

      // Filter out stewards disabled by config. Currently only bootstrapSteward is in DEFAULT_STEWARDS.
      const rawStewards = this.opts.stewards ?? DEFAULT_STEWARDS
      const stewards = rawStewards.filter(s => {
        if (s.name === 'bootstrapSteward' && !this.opts.config.bootstrapStewardEnabled) return false
        return true
      })

      if (stewardChannel) {
        await runStewards(stewards, {
          triggerText,
          activationType,
          headResponse: finalResponse.content,
          currentUserMd: identityLoader.readFile('USER.md') ?? '',
          currentSoulMd: identityLoader.readFile('SOUL.md') ?? '',
          currentBootstrapMd: bootstrapMdAtStart,
          activationStart,
          toolsCalledThisTurn,
          recentHistory,
        }, this.opts.llmRouter, this.opts.config.stewardModel, this.opts.queueStore, stewardChannel, this.opts.usageStore, event.id, onDebug ?? undefined, (results) => {
          this.opts.stewardRunStore?.append({
            id: generateId('jr'),
            stewards: results,
            createdAt: new Date().toISOString(),
          })
        })
      }
    }

    if (usageMode && sendChannel) {
      if (event.type === 'user_message') {
        // Head cost for this activation
        const headUsage = this.opts.usageStore.getBySource('head', event.id)
        if (headUsage.length > 0) {
          await this.opts.channelRouter.send(sendChannel, buildSpendLine('[head]', usageMode, headUsage))
        }
      } else if (event.type === 'agent_completed' || event.type === 'agent_question' || event.type === 'agent_failed' || event.type === 'agent_response') {
        // Agent + all descendant cost
        const ids = this.opts.agentStore.getDescendantIds(event.agentId)
        const allUsage = ids.flatMap(id => this.opts.usageStore.getBySource('agent', id))
        if (allUsage.length > 0) {
          await this.opts.channelRouter.send(sendChannel, buildSpendLine(`[agent ${event.agentId}]`, usageMode, allUsage))
        }
        // Head cost for this activation (delivering the agent result)
        const headUsage = this.opts.usageStore.getBySource('head', event.id)
        if (headUsage.length > 0) {
          await this.opts.channelRouter.send(sendChannel, buildSpendLine('[head]', usageMode, headUsage))
        }
      }
    }
    this.opts.events?.emit('dashboard', { type: 'usage_updated' })
    } finally {
      if (typingInterval !== null) clearInterval(typingInterval)
    }
  }

  private async handleScheduleTrigger(event: QueueEvent & { type: 'schedule_trigger' }): Promise<void> {
    const { taskName, kind } = event
    let proactiveContext: string | undefined

    // Reminder branch: kind='reminder' fires via schedule store (Plan 12-01)
    if (kind === 'reminder') {
      const schedule = this.opts.scheduleStore.get(event.scheduleId)
      if (!schedule) {
        log.warn(`[scheduler] reminder:${event.scheduleId} — schedule row not found, skipping`)
        return
      }
      // channel resolved at fire time per REM-06
      const channel = this.opts.appState.getLastActiveChannel()
      if (!channel) {
        log.warn(`[scheduler] reminder:${event.scheduleId} — no active channel, skipping`)
        if (schedule.cron === null) {
          this.opts.scheduleStore.delete(event.scheduleId)
        }
        return
      }
      if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
        const recentMsgs = this.opts.messages.getRecentTextByTokens(this.opts.config.stewardContextTokenBudget, estimateTokens).reverse()
        const { identityLoader } = this.opts.toolExecutorOpts
        const decision = await runReminderDecision({
          reminderMessage: schedule.agentContext ?? '',
          reminderCron: schedule.cron ?? null,
          userMd: identityLoader.readFile('USER.md') ?? '',
          recentHistory: recentMsgs
            .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt })),
          ambientContext: this.readAmbientContext(),
          currentTime: formatIanaTimeLine(new Date(), this.opts.config.timezone),
        }, this.opts.llmRouter, this.opts.config.stewardModel, this.opts.usageStore, event.id)
        if (this.opts.config.proactiveShadow) {
          log.info(`[proactive:reminder:shadow] ${event.scheduleId}: ${decision.action} — ${decision.reason}`)
        }
        if (this.opts.config.proactiveEnabled && decision.action === 'skip') {
          this.opts.scheduleStore.markSkipped(event.scheduleId, new Date().toISOString(), decision.reason)
          log.info(`[proactive:reminder] Skipped ${event.scheduleId}: ${decision.reason}`)
          return
        }
      }
      if (schedule.cron === null) {
        this.opts.scheduleStore.delete(event.scheduleId)
      } else {
        this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
      }
      const message = schedule.agentContext ?? ''
      const agentId = generateAgentId(event.scheduleId)
      const prompt = [
        'Deliver the following reminder message to the user.',
        'Write only the reminder message as your final response — no preamble, no commentary.',
        '',
        `Reminder: ${message}`,
      ].join('\n')
      log.info(`[scheduler] fired reminder:${event.scheduleId}`)
      await this.opts.toolExecutorOpts.agentRunner.spawn({
        agentId,
        prompt,
        trigger: 'scheduled',
      })
      return
    }

    // Resolve target via tasksLoader.
    const unified = this.opts.toolExecutorOpts.unifiedLoader
    const loadedTask = unified?.tasksLoader.load(taskName ?? '') ?? null
    if (!loadedTask) {
      log.warn(`[scheduler] task ${taskName ?? '(unknown)'} not found — skipping`)
      return
    }
    const loaded = { kind: 'task' as const, meta: loadedTask.frontmatter, body: loadedTask.instructions, skill: loadedTask }

    // Fetch schedule row once — used for proactive context and agentContext prompt append.
    const schedule = this.opts.scheduleStore.get(event.scheduleId)

    // Proactive decision: run an LLM steward to decide whether this schedule should fire
    if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
      const recentMsgs = this.opts.messages.getRecentTextByTokens(this.opts.config.stewardContextTokenBudget, estimateTokens).reverse()
      const { identityLoader } = this.opts.toolExecutorOpts

      const decision = await runProactiveDecision({
        skillName: taskName!,
        skillDescription: loaded.meta.description ?? '',
        skillInstructions: loaded.body,
        scheduleCron: schedule?.cron ?? null,
        lastRun: schedule?.lastRun ?? null,
        lastSkipped: schedule?.lastSkipped ?? null,
        lastSkipReason: schedule?.lastSkipReason ?? null,
        userMd: identityLoader.readFile('USER.md') ?? '',
        recentHistory: recentMsgs
          .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt })),
        ambientContext: this.readAmbientContext(),
        currentTime: formatIanaTimeLine(new Date(), this.opts.config.timezone),
      }, this.opts.llmRouter, this.opts.config.stewardModel,
         this.opts.usageStore, event.id)

      if (this.opts.config.proactiveShadow) {
        log.info(`[proactive:shadow] ${kind}:${taskName}: ${decision.action} — ${decision.reason}`)
      }

      if (this.opts.config.proactiveEnabled && decision.action === 'skip') {
        this.opts.scheduleStore.markSkipped(event.scheduleId, new Date().toISOString(), decision.reason)
        // Intentionally NOT injecting into head history — quiet-hours/no-op skips
        // would otherwise pile up N-per-hour of meaningless system events. The skip
        // is still recorded on the schedule row (markSkipped) for dashboard visibility.
        log.info(`[proactive] Skipped ${kind}:${taskName}: ${decision.reason}`)
        return
      }

      proactiveContext = decision.context
    }

    // Budget enforcement: skip if monthly spend meets or exceeds max-per-month-usd.
    const cap = loaded.meta['max-per-month-usd']
    if (typeof cap === 'number' && cap > 0) {
      const spend = this.opts.usageStore.getTaskMonthlySpend(taskName!)
      if (spend >= cap) {
        const reason = `monthly budget exceeded ($${spend.toFixed(2)}/$${cap.toFixed(2)})`
        // Notify user once per schedule when budget is first hit (not on repeated skips)
        const scheduleRow = this.opts.scheduleStore.get(event.scheduleId)
        const previousReason = scheduleRow?.lastSkipReason ?? ''
        if (!previousReason.startsWith('monthly budget exceeded')) {
          const channel = this.opts.appState.getLastActiveChannel()
          if (channel) {
            await this.opts.channelRouter.send(channel,
              `Task **${taskName}** has hit its monthly budget ($${cap.toFixed(2)}) and won't run again until next month. You can raise the cap in the task's settings if needed.`)
          }
        }
        this.opts.scheduleStore.markSkipped(event.scheduleId, new Date().toISOString(), reason)
        log.info(`[scheduler] task:${taskName} skipped — ${reason}`)
        return
      }
    }

    // Mark lastRun now that the proactive steward has approved it.
    // nextRun was already advanced by the scheduler tick to prevent re-firing.
    if (schedule?.cron === null) {
      this.opts.scheduleStore.delete(event.scheduleId)
    } else {
      this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
    }

    // Spawn path: narrative is anchored by the append-only agent_completed
    // injection (see injectAgentEvent). No synthetic spawn_agent pair needed.
    const agentId = generateAgentId(taskName!)

    // Tasks-only: use the task body directly as the prompt (D-15).
    const basePrompt = loaded.body
    const scheduleAgentContext = schedule?.agentContext ?? null
    const parts = [basePrompt]
    if (proactiveContext) parts.push(`Context from recent conversation: ${proactiveContext}`)
    if (scheduleAgentContext) parts.push(`Schedule context: ${scheduleAgentContext}`)
    const prompt = parts.join('\n\n')

    // Install npm-deps union: task's own deps + bundled skills' deps.
    {
      const taskDeps: string[] = loaded.meta['npm-deps'] ?? []
      const skillDepNames: string[] = loaded.meta['skill-deps'] ?? []
      const bundledSkillDeps: string[] = []
      for (const depName of skillDepNames) {
        const depSkill = unified?.skillsLoader.load(depName)
        if (depSkill?.frontmatter['npm-deps']?.length) {
          bundledSkillDeps.push(...depSkill.frontmatter['npm-deps'])
        }
      }
      const allDeps = [...new Set([...taskDeps, ...bundledSkillDeps])]
      if (allDeps.length > 0) {
        await ensureSkillDeps(path.dirname(loadedTask.path), allDeps)
      }
    }

    // Spawn directly — no head LLM call needed; target is known deterministically.
    // model is task-only; cast to reach it since SkillFrontmatter does not expose it.
    const scheduledModel = (loaded.meta as unknown as { model?: string }).model
    log.info(`[scheduler] fired task:${taskName}`)
    // skill_name on the agents row now records the task name — the semantic 'target name'.
    // Required so usage attribution can bucket scheduled task spend by name (see sql/026_usage_attribution.sql).
    // Relies on unifiedLoader being wired so resolveSkillByName() finds task names too — true in production;
    // test mocks spawn directly.
    await this.opts.toolExecutorOpts.agentRunner.spawn({
      agentId,
      prompt,
      trigger: 'scheduled',
      skillName: taskName!,
      ...(scheduledModel ? { model: scheduledModel } : {}),
    })
  }

  private injectEvent(event: QueueEvent, workSummaryOverride?: string): void {
    switch (event.type) {
      case 'agent_completed':
        this.opts.injector.injectAgentEvent(event, workSummaryOverride)
        break
      case 'agent_question':
      case 'agent_failed':
      case 'agent_response':
        this.opts.injector.injectAgentEvent(event)
        break
      case 'webhook':
        this.opts.injector.injectWebhookEvent(event)
        break
    }
  }

  private async waitForEvent(): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { cleanup(); resolve() }, this.pollIntervalMs)
      const handler = () => { cleanup(); resolve() }
      const cleanup = () => {
        clearTimeout(timer)
        this.emitter.off('event', handler)
        this.emitter.off('stop', handler)
      }
      this.emitter.once('event', handler)
      this.emitter.once('stop', handler)
    })
  }

  private async maybeArchive(): Promise<void> {
    try {
      const allMessages = this.opts.messages.getRecent(Infinity)
      const tokenCount = estimateTokens(allMessages)
      const memoryFraction = (this.opts.config.memoryBudgetPercent ?? 40) / 100
      const historyBudget = this.opts.config.contextWindowTokens * (1 - memoryFraction)
      const threshold = Math.floor(historyBudget * this.opts.config.archivalThresholdFraction)

      if (tokenCount <= threshold) return

      // Acquire lock (atomic)
      if (!this.opts.appState.tryAcquireArchivalLock()) return

      void this.runArchival(allMessages)
    } catch (err) {
      log.error('[activation] Archival check failed:', (err as Error).message)
    }
  }

  private async runArchival(allMessages: Message[]): Promise<void> {
    try {
      await archiveMessages(allMessages, {
        topicMemory: this.opts.topicMemory,
        messages: this.opts.messages,
      })

      // Cancel suspended agents whose context has been archived away.
      // If the head no longer has the agent-paused trigger in its live history,
      // the conversation has moved on and the question will never be answered.
      const oldest = this.opts.messages.getAll()[0]
      if (oldest) {
        const suspended = this.opts.agentStore.getByStatus('suspended')
        for (const agent of suspended) {
          if (agent.createdAt < oldest.createdAt) {
            this.opts.agentStore.updateStatus(agent.id, 'retracted')
            log.info(`[archival] Cancelled stale suspended agent ${agent.id} (created ${agent.createdAt})`)
          }
        }
      }

      try { this.opts.maintenance?.() } catch (err) {
        log.warn('[archival] Maintenance failed:', (err as Error).message)
      }
    } catch (err) {
      log.error('[archival] Failed:', (err as Error).message)
      // Notify user that memory may be degraded
      try {
        this.opts.messages.append({
          kind: 'text',
          role: 'user',
          id: generateId('msg'),
          content: '[System notice: Memory archival encountered an error. Some older conversation may not be saved to long-term memory. This is usually temporary.]',
          injected: true,
          createdAt: now(),
        } as TextMessage)
      } catch { /* best effort */ }
    } finally {
      this.opts.appState.releaseArchivalLock()
    }
  }
}

function buildSpendLine(label: string, mode: UsageMode, entries: UsageEntry[]): string {
  const byModel: Record<string, { input: number; output: number; cost: number }> = {}
  for (const e of entries) {
    const m = (byModel[e.model] ??= { input: 0, output: 0, cost: 0 })
    m.input += e.inputTokens
    m.output += e.outputTokens
    m.cost += e.costUsd
  }
  const totalIn = entries.reduce((s, e) => s + e.inputTokens, 0)
  const totalOut = entries.reduce((s, e) => s + e.outputTokens, 0)
  const totalCost = entries.reduce((s, e) => s + e.costUsd, 0)
  const models = Object.keys(byModel)

  if (mode === 'full' && models.length > 1) {
    const lines = [`-# ${label} est. cost: $${totalCost.toFixed(4)}`]
    for (const [model, t] of Object.entries(byModel)) {
      lines.push(`-# ${model}: in: ${t.input.toLocaleString()} | out: ${t.output.toLocaleString()} | $${t.cost.toFixed(4)}`)
    }
    return lines.join('\n')
  }

  const parts: string[] = [label]
  if (mode === 'tokens' || mode === 'full') {
    parts.push(`in: ${totalIn.toLocaleString()}`, `out: ${totalOut.toLocaleString()}`)
  }
  if (mode === 'full') parts.push(`model: ${models[0] ?? '?'}`)
  if (mode === 'cost' || mode === 'full') parts.push(`est. cost: $${totalCost.toFixed(4)}`)
  return `-# ${parts.join(' | ')}`
}

function formatInjectedEvent(event: QueueEvent): string {
  switch (event.type) {
    case 'agent_completed':
      return systemEvent('agent-completed', { agent: event.agentId }, event.output.slice(0, 300))
    case 'agent_question':
      return systemEvent('agent-paused', { agent: event.agentId }, event.question.slice(0, 300))
    case 'agent_failed':
      return systemEvent('agent-failed', { agent: event.agentId }, event.error.slice(0, 300))
    case 'agent_response':
      return systemEvent('agent-response', { agent: event.agentId }, event.response.slice(0, 300))
    case 'schedule_trigger':
      return systemEvent('schedule-trigger', { scheduleId: event.scheduleId ?? '', taskName: event.taskName ?? '' })
    case 'webhook':
      return systemEvent('webhook', { source: event.source ?? '', event: event.event ?? '' })
    default:
      return JSON.stringify(event).slice(0, 150)
  }
}
