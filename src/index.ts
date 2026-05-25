import * as fs from 'node:fs'
import * as os from 'node:os'
import { restartProcess } from './restart.js'

// Load .env file before reading config. SHROK_ENV_FILE overrides the default path.
// Default is {workspacePath}/.env so credentials persist across container restarts in Docker.
// Falls back to the legacy ~/.shrok/.env path for existing installs that haven't migrated.
/** Parse a .env file and load its variables into process.env.
 *  @param overwrite If true, overwrites existing env vars (used for hot-reload).
 *                   If false, only sets vars not already in process.env (used at boot). */
function loadEnvFile(overwrite = false): void {
  if (!process.env['SHROK_ENV_FILE']) {
    const ws = process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'] ?? `${os.homedir()}/.shrok/workspace`
    process.env['SHROK_ENV_FILE'] = `${ws}/.env`
  }
  const envFile = process.env['SHROK_ENV_FILE']
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1)
      // Strip inline comment if value is unquoted (e.g. KEY=value # comment)
      const quoted = /^\s*["']/.test(val)
      if (!quoted) val = val.replace(/#.*$/, '')
      // Strip matched surrounding quotes, then unescape any inner escaped quotes
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
      if (key && (overwrite || !(key in process.env))) process.env[key] = val
    }
  } catch {
    // env file not found — fine, rely on process env
  }
}

loadEnvFile()

import OpenAI from 'openai'
import { loadConfig, extractSecretValues, resolveHeads, type ResolvedHead } from './config.js'
import { setLogLevel, setLogFile, log, registerSecrets } from './logger.js'
import { initTracer } from './tracer.js'
import { initDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { pruneOldData } from './db/maintenance.js'
import { createLLMRouter } from './llm/index.js'
import { resolveContextWindow } from './llm/model-info.js'
import { McpRegistryImpl } from './mcp/registry.js'
import { nextRunAfter } from './scheduler/cron.js'
import * as path from 'node:path'
import { ensureWorkspaceRepo } from './workspace/git.js'
import { ChannelRouterImpl } from './channels/router.js'
import { buildSystem } from './system.js'
import { DiscordAdapter } from './channels/discord/adapter.js'
import { TelegramAdapter } from './channels/telegram/adapter.js'
import { SlackAdapter } from './channels/slack/adapter.js'
import { ZohoCliqAdapter } from './channels/zoho-cliq/adapter.js'
import { ZohoCliqStateStore } from './db/zoho_cliq_state.js'
// WhatsApp adapter is dynamically imported — Baileys is an optional dependency
import { DashboardChannelAdapter } from './channels/dashboard/adapter.js'
import { VoiceChannelAdapter } from './channels/voice/adapter.js'
import { HomeAssistantChannelAdapter } from './channels/home-assistant/adapter.js'
import { ScheduleEvaluatorImpl } from './scheduler/index.js'
import { WebhookListenerImpl } from './webhook/index.js'
import { DashboardServer } from './dashboard/server.js'
import { DashboardEventBus } from './dashboard/events.js'
import { StewardRunStore } from './db/steward_runs.js'
import { generateId, now } from './llm/util.js'
import { checkThresholds, formatThresholdAlert } from './usage-threshold.js'
import type { ChannelAdapter, InboundMessage } from './types/channel.js'
import { fileURLToPath } from 'node:url'
import { setStewardWorkspaceDir } from './head/steward.js'
import { buildPrefixedText } from './head/sender-prefix.js'
import { transcribeInboundAudio } from './head/transcribe-attachments.js'
import { setProactiveWorkspaceDir } from './scheduler/proactive.js'
import { setMemoryPromptsWorkspaceDir } from './memory/prompts.js'
import { readAssistantName } from './config-file.js'
import { applyTimezoneEnv } from './timezone-env.js'

async function main() {
  // Set SHROK_ROOT so agents can find the install directory (e.g. to run npm scripts)
  if (!process.env['SHROK_ROOT']) {
    process.env['SHROK_ROOT'] = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  }

  const config = loadConfig()
  applyTimezoneEnv(config)
  registerSecrets(extractSecretValues(config))
  setLogLevel(config.logLevel)

  let version = 'unknown'
  try { version = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version } catch { /* fine */ }
  process.env['SHROK_VERSION'] = version
  log.info(`[startup] Shrok v${version}`)
  log.info(`[startup] logLevel: ${config.logLevel}`)

  // Clear any stale restart sentinel from a previous run (prevents restart loop
  // when not running under the daemon wrapper which does its own cleanup)
  const startupSentinel = path.join(os.homedir(), '.shrok', '.restart-requested')
  try { fs.unlinkSync(startupSentinel) } catch {}

  // Idempotent first-boot: daemon registration, CLI wrappers, PATH setup.
  // No-ops if everything is already in place.
  const { runFirstBoot } = await import('./first-boot.js')
  await runFirstBoot(process.env['SHROK_ROOT']!, config.workspacePath)

  const traceDir = path.join(config.workspacePath, 'data', 'trace')
  initTracer(traceDir, config.traceHistoryTokens)

  // Tee all log output to process-latest.log in the trace dir so it survives dashboard restarts.
  // Rotate the file if it has grown beyond 500 KB.
  const processLogPath = path.join(traceDir, 'process-latest.log')
  try {
    const stat = fs.statSync(processLogPath)
    if (stat.size > 500 * 1024) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1)
      fs.renameSync(processLogPath, path.join(traceDir, `process-${ts}.log`))
    }
  } catch { /* file doesn't exist yet — fine */ }
  setLogFile(processLogPath)

  // Rotate process log periodically (every 30 min) so long uptimes don't fill disk
  setInterval(() => {
    try {
      const stat = fs.statSync(processLogPath)
      if (stat.size > 500 * 1024) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1)
        fs.renameSync(processLogPath, path.join(traceDir, `process-${ts}.log`))
        setLogFile(processLogPath) // reopen after rename
      }
    } catch { /* fine */ }
  }, 30 * 60 * 1000).unref()

  // ── Process lock (port-based) ────────────────────────────────────────────────
  // Check if the dashboard port is already in use — if so, another instance is running.
  // This replaces PID file locking which was unreliable (stale files after crashes/SIGKILL).
  {
    const net = await import('node:net')
    const portInUse = await new Promise<boolean>(resolve => {
      const server = net.createServer()
      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'EADDRINUSE')
      })
      server.once('listening', () => {
        server.close(() => resolve(false))
      })
      server.listen(config.dashboardPort)
    })
    if (portInUse) {
      log.error(`[startup] Another instance is already running (port ${config.dashboardPort} in use). Exiting.`)
      process.exit(1)
    }
  }
  // Clean up any stale PID file from previous versions
  try { fs.unlinkSync(path.join(config.workspacePath, 'data', 'shrok.pid')) } catch { /* fine */ }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── DB ──────────────────────────────────────────────────────────────────────
  const db = initDb(config.dbPath)
  runMigrations(db, config.migrationsDir)
  const zohoCliqState = new ZohoCliqStateStore(db)

  // ── Core services (pre-buildSystem) ─────────────────────────────────────────
  const dashboardEvents = new DashboardEventBus()
  const llmRouter = createLLMRouter(config)
  const mcpRegistry = McpRegistryImpl.fromFile(config.mcpConfigPath, config.mcpTimeoutMs)
  const workspacePath = config.workspacePath.replace(/^~/, os.homedir())

  // Resolve actual context window from provider API (fallback: table → config default)
  const headModelId = config.llmProvider === 'anthropic' ? config.anthropicModelExpert
    : config.llmProvider === 'gemini' ? config.geminiModelExpert
    : config.openaiModelExpert
  const headApiKey = config.llmProvider === 'anthropic' ? (config.anthropicApiKey ?? '')
    : config.llmProvider === 'gemini' ? (config.geminiApiKey ?? '')
    : (config.openaiApiKey ?? '')
  const userContextWindow = config.contextWindowTokens
  const modelContextWindow = await resolveContextWindow(config.llmProvider, headModelId, headApiKey)
  config.contextWindowTokens = Math.min(userContextWindow, modelContextWindow)
  config.snapshotTokenBudget = config.contextWindowTokens

  ensureWorkspaceRepo(workspacePath)
  fs.mkdirSync(path.join(workspacePath, 'media'), { recursive: true })

  const stewardsWorkspaceDir = path.join(workspacePath, 'stewards')
  const proactiveWorkspaceDir = path.join(workspacePath, 'proactive')
  setStewardWorkspaceDir(stewardsWorkspaceDir)
  setProactiveWorkspaceDir(proactiveWorkspaceDir)
  const memoryPromptsWorkspaceDir = path.join(workspacePath, 'memory-prompts')
  setMemoryPromptsWorkspaceDir(memoryPromptsWorkspaceDir)

  // Set SHROK_SKILLS_DIR for agent bash tool env
  const skillsPath = config.skillsDir ? path.resolve(config.skillsDir) : path.join(workspacePath, 'skills')
  process.env['SHROK_SKILLS_DIR'] = skillsPath

  // Phase 31 (CONF-03): resolve the canonical head list once. When heads[] is
  // configured, this returns each named head; otherwise it synthesizes a single
  // 'default' head from flat keys for backward compat (CONF-02, D-03).
  const resolvedHeads: ResolvedHead[] = resolveHeads(config)
  const isMultiHead = (config.heads?.length ?? 0) > 0
  log.info(`[startup] Resolved ${resolvedHeads.length} head(s): ${resolvedHeads.map(h => h.id).join(', ')}`)

  // ── Per-head systems ───────────────────────────────────────────────────────
  interface HeadSystem {
    head: ResolvedHead
    channelRouter: ChannelRouterImpl
    system: ReturnType<typeof buildSystem>
    channelAdapters: ChannelAdapter[]
    routeMessage: (msg: InboundMessage) => Promise<void>
  }
  const headSystems: HeadSystem[] = []

  // Hot-reload sentinels only apply to the synthesized 'default' head (Phase 31
  // limitation per RESEARCH §Pitfall 5). Named heads from config.heads[]
  // reconfigure by restarting the process.
  let currentDiscordAdapter: DiscordAdapter | null = null
  let currentTelegramAdapter: TelegramAdapter | null = null
  let currentWhatsAppAdapter: ChannelAdapter | null = null
  let currentSlackAdapter: SlackAdapter | null = null
  let currentZohoCliqAdapter: ZohoCliqAdapter | null = null

  // Shared services across heads — instantiated below the loop, reused by all.
  // Captured by each head's routeMessage closure via the per-head system.
  // Phase 33 D-09: one DashboardChannelAdapter per head, attached as
  // `dashboard:${head.id}` on each head's router. The startup loop collects
  // them into a Map<headId, adapter> that the dashboard's messages router
  // uses to look up the right adapter for /send.
  const dashboardAdapters = new Map<string, DashboardChannelAdapter>()
  // Phase 41: collect Home Assistant adapters (one per configured HA channel)
  // into an array typed to match DashboardServerOptions.homeAssistantAdapters?
  const haAdapters: HomeAssistantChannelAdapter[] = []

  // Phase me4: shared OpenAI client for inbound audio transcription at the headRouteMessage
  // seam. Constructed once (outside the per-head loop) — all heads share the same API key.
  // null when OPENAI_API_KEY is not set → transcribeInboundAudio returns msg unchanged.
  const ingestionOpenAI = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null

  for (const head of resolvedHeads) {
    const headRouter = new ChannelRouterImpl()

    const headSystem = buildSystem({
      db, config, llmRouter, channelRouter: headRouter, mcpRegistry,
      dashboardEventBus: dashboardEvents,
      headId: head.id,
      // Phase 35 D-08: re-resolve heads each call so dashboard edits between scheduler ticks
      // land without a process restart (mirrors DashboardServer.resolveCurrentHeads pattern).
      resolveCurrentHeads: () => resolveHeads(loadConfig()),
    })
    const { activationLoop: headLoop } = headSystem
    const { queue: headQueue, appState, messages: headMessages, agents: headAgents } = headSystem.stores

    // Startup recovery, per head
    headQueue.requeueStale(head.id)
    appState.releaseArchivalLock(head.id)

    const orphans = headMessages.sanitizeOrphans()
    if (orphans > 0) log.warn(`[startup] head=${head.id}: removed ${orphans} orphaned tool message(s)`)

    if (appState.seedDefaultThreshold()) {
      log.info(`[startup] head=${head.id}: created default daily spend block threshold ($50.00)`)
    }

    // Per-head orphaned-agent reaping
    const orphanedAgents = headAgents.getByStatus('running')
    for (const t of orphanedAgents) {
      const pendingRetract = headSystem.stores.agentInbox.poll(t.id).some(m => m.type === 'retract')
      if (pendingRetract) { headAgents.updateStatus(t.id, 'retracted'); continue }
      headAgents.fail(t.id, 'process restarted mid-execution')
      headQueue.enqueue({
        type: 'agent_failed', id: generateId('qe'), agentId: t.id,
        error: 'process restarted mid-execution', createdAt: new Date().toISOString(),
      }, 50, head.id)
    }

    // Per-head routeMessage closure — captures head.id + this head's loop + queue.
    // Made async (Phase me4): awaits transcribeInboundAudio before enqueue so the head
    // sees transcript text on the first turn. Callers ignore the return value (fire-and-forget
    // is safe — confirmed across all adapter .onMessage usages).
    const headRouteMessage = async (msg: InboundMessage): Promise<void> => {
      if (msg.text.trim().startsWith('~')) {
        headLoop.handleCommand(msg.text.trim(), msg.channel).catch(err => {
          log.error(`[routeMessage:${head.id}] handleCommand rejected: ${err instanceof Error ? err.message : String(err)}`)
        })
        return
      }
      const routed = await transcribeInboundAudio(msg, ingestionOpenAI)
      headQueue.enqueue(
        { type: 'user_message', id: generateId('qe'), channel: routed.channel,
          text: buildPrefixedText(routed.text, msg.senderName),
          ...(routed.attachments?.length ? { attachments: routed.attachments } : {}),
          createdAt: new Date().toISOString() },
        100,
        head.id,
      )
      headLoop.notify()
    }

    // Build adapters declared in this head's channels[]
    const headChannelAdapters: ChannelAdapter[] = []
    for (const ch of head.channels) {
      let adapter: ChannelAdapter
      if (ch.vendor === 'discord') {
        const d = new DiscordAdapter(ch.botToken, ch.channelId, path.join(workspacePath, 'media'), ch.id, head.id)
        if (!isMultiHead) currentDiscordAdapter = d
        adapter = d
      } else if (ch.vendor === 'telegram') {
        const t = new TelegramAdapter(ch.botToken, ch.chatId, path.join(workspacePath, 'media'), ch.id, head.id)
        if (!isMultiHead) currentTelegramAdapter = t
        adapter = t
      } else if (ch.vendor === 'slack') {
        const s = new SlackAdapter(ch.botToken, ch.appToken, ch.channelId, path.join(workspacePath, 'media'), ch.id, head.id)
        if (!isMultiHead) currentSlackAdapter = s
        adapter = s
      } else if (ch.vendor === 'whatsapp') {
        const { WhatsAppAdapter } = await import('./channels/whatsapp/adapter.js')
        const whatsappAuthDir = path.join(workspacePath, 'whatsapp', 'auth')
        const whatsappQrPath = path.join(workspacePath, 'whatsapp-qr.txt')
        const w = new WhatsAppAdapter(whatsappAuthDir, ch.allowedJid, whatsappQrPath, path.join(workspacePath, 'media'), ch.id, head.id)
        if (!isMultiHead) currentWhatsAppAdapter = w
        adapter = w
      } else if (ch.vendor === 'zoho-cliq') {
        const z = new ZohoCliqAdapter(
          ch.clientId, ch.clientSecret, ch.refreshToken, ch.chatId,
          path.join(workspacePath, 'media'), config.zohoCliqPollInterval,
          readAssistantName(workspacePath), zohoCliqState, workspacePath,
          ch.id, head.id,
        )
        if (!isMultiHead) currentZohoCliqAdapter = z
        adapter = z
      } else if (ch.vendor === 'home-assistant') {
        const ha = new HomeAssistantChannelAdapter(ch.id, head.id, ch)
        adapter = ha
        haAdapters.push(ha)   // Phase 41: collect for DashboardServer.homeAssistantAdapters
      } else {
        // Exhaustiveness guard — discriminated union covers all six vendors
        const _exhaustive: never = ch
        throw new Error(`unreachable: unhandled vendor in channels[]: ${JSON.stringify(_exhaustive)}`)
      }

      try {
        adapter.onMessage(headRouteMessage)
        headRouter.register(adapter)
        await adapter.start()
        headChannelAdapters.push(adapter)
        log.info(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) connected`)
      } catch (err) {
        log.warn(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) failed to start: ${(err as Error).message}`)
      }
    }

    // Phase 33 D-09: one DashboardChannelAdapter per head, attached as
    // `dashboard:${head.id}` on each head's router. The startup loop
    // collects them into a Map<headId, adapter> that the dashboard's
    // messages router uses to look up the right adapter for /send.
    // Note: `headMessages` resolves to the same shared MessageStore instance
    // in every iteration (RESEARCH Risk 2 / Assumption A1). This is correct
    // per D-12 — head isolation comes from `head_id` on each row, not from
    // separate store instances.
    const dash = new DashboardChannelAdapter(`dashboard:${head.id}`, head.id)
    dash.setEventBus(dashboardEvents)
    dash.setMessageStore(headMessages)
    dash.onMessage(headRouteMessage)
    headRouter.register(dash)
    await dash.start()
    headChannelAdapters.push(dash)
    dashboardAdapters.set(head.id, dash)
    log.info(`[startup] head=${head.id}: Dashboard channel adapter ready`)

    headSystems.push({ head, channelRouter: headRouter, system: headSystem, channelAdapters: headChannelAdapters, routeMessage: headRouteMessage })
  }

  // Pick the primary head's system for global services (scheduler, webhook, dashboard server, voice)
  const primary = headSystems[0]
  if (!primary) throw new Error('[startup] resolveHeads returned an empty list — should never happen')
  const { activationLoop, agentRunner, stores, topicMemory, skillLoader, identityLoader, agentIdentityLoader, systemSkillNames, taskKindLoader, unifiedLoader } = primary.system
  const { messages, agents, queue, usage, appState, schedules, stewardRuns } = stores
  pruneOldData(db)

  // Flatten all per-head adapters into a single array for shutdown iteration
  const channelAdapters: ChannelAdapter[] = headSystems.flatMap(h => h.channelAdapters)

  const stopProcess = () => {
    for (const { system: s } of headSystems) s.activationLoop.stop()
    setTimeout(() => process.exit(0), 500)
  }
  const restartProcessFn = () => {
    for (const { system: s } of headSystems) s.activationLoop.stop()
    setTimeout(() => restartProcess(), 500)
  }
  const emergencyStop = () => {
    const cancelled = agents.cancelAllActive()
    log.warn(`[emergency-stop] Cancelled ${cancelled} active agent(s), halting process`)
    for (const { system: s } of headSystems) s.activationLoop.stop()
    setTimeout(() => process.exit(0), 500)
    return cancelled
  }
  const getStatus = () => {
    const running = agents.getByStatus('running')
    const suspended = agents.getByStatus('suspended')
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      estimatedSpendToday: usage.getEstimatedCostToday(),
      blockingThresholds: appState.getThresholds().filter(t => t.action === 'block').length,
      activeAgents: running.length + suspended.length,
      runningAgents: running.length,
      suspendedAgents: suspended.length,
    }
  }

  // ── Scheduler ────────────────────────────────────────────────────────────────
  const scheduler = new ScheduleEvaluatorImpl(queue, schedules, config.timezone)
  scheduler.start()
  log.info('[startup] Scheduler started')

  // ── Webhook ──────────────────────────────────────────────────────────────────
  let webhook: WebhookListenerImpl | null = null
  if (config.webhookSecret) {
    webhook = new WebhookListenerImpl(queue, config.webhookPort, config.webhookSecret, config.webhookRateLimitPerMinute, config.webhookHost)
    await webhook.start()
    log.info(`[startup] Webhook listener on port ${config.webhookPort}`)
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────────
  const dashboard = new DashboardServer({
    config, messages, agents, usage, stewardRuns, events: dashboardEvents,
    controls: {
      stop: stopProcess, restart: restartProcessFn, emergencyStop, getStatus,
    },
    topicMemory,
    identity: {
      mainLoader: identityLoader,
      mainWorkspaceDir: config.identityDir.replace(/^~/, os.homedir()),
      agentLoader: agentIdentityLoader,
      agentWorkspaceDir: path.join(workspacePath, 'sub-agents'),
      stewardsWorkspaceDir,
      proactiveWorkspaceDir,
      memoryPromptsWorkspaceDir,
    },
    skills: {
      loader: skillLoader,
      systemSkillNames,
    },
    tasks: { loader: taskKindLoader },
    unifiedLoader,
    db,
    evalResultsDir: path.join(workspacePath, 'eval-results'),
    dashboardAdapters,
    homeAssistantAdapters: haAdapters,   // Phase 41: wire HA adapters so /v1 router mounts
    schedules,
    mcpRegistry,
    agentRunner,
    appState,
    resolvedHeads,
    queue,
    resolveCurrentHeads: () => resolveHeads(loadConfig()),
  })
  await dashboard.start()
  log.info(`[startup] Dashboard listening on port ${config.dashboardPort}`)

  // ── Voice channel (optional — only if OPENAI_API_KEY is configured) ────────
  // Phase 19 D-01: attach AFTER dashboard.start() resolves so getHttpServer()
  // returns a live http.Server. Gated on openaiApiKey — without it, Whisper/TTS
  // calls cannot succeed, so skip startup rather than fail at first voice turn.
  if (config.openaiApiKey) {
    const httpServer = dashboard.getHttpServer()
    if (httpServer) {
      const voiceOpenai = new OpenAI({ apiKey: config.openaiApiKey })
      const voiceAdapter = new VoiceChannelAdapter(httpServer, voiceOpenai)
      voiceAdapter.onMessage(primary.routeMessage)
      primary.channelRouter.register(voiceAdapter)
      await voiceAdapter.start()
      channelAdapters.push(voiceAdapter)
      log.info('[startup] Voice WebSocket adapter ready at /api/voice/ws')
    } else {
      log.warn('[startup] Voice adapter skipped: dashboard.getHttpServer() returned null')
    }
  } else {
    log.debug('[startup] Voice adapter skipped: OPENAI_API_KEY not set')
  }

  // Wire session revocation so ~changedashboardpassword invalidates all sessions
  primary.system.activationLoop.setRevokeDashboardSessions(() => dashboard.revokeAllSessions())

  // ── Restart sentinel ─────────────────────────────────────────────────────────
  // The update skill writes ~/.shrok/.restart-requested when done.
  // Checked after each activation completes (not on a timer) to avoid killing
  // the process while an agent is still running.
  const SENTINEL_PATH = path.join(os.homedir(), '.shrok', '.restart-requested')
  const DISCORD_RELOAD_PATH = path.join(workspacePath, '.reload-discord')
  const TELEGRAM_RELOAD_PATH = path.join(workspacePath, '.reload-telegram')
  const SLACK_RELOAD_PATH = path.join(workspacePath, '.reload-slack')
  const WHATSAPP_RELOAD_PATH = path.join(workspacePath, '.reload-whatsapp')
  const ZOHO_CLIQ_RELOAD_PATH = path.join(workspacePath, '.reload-zoho-cliq')

  // Check for restart sentinel after each activation completes (not on a timer).
  // This prevents the race where the sentinel is found while an agent is still running.
  primary.system.activationLoop.onPostActivation(() => {
    if (fs.existsSync(SENTINEL_PATH)) {
      log.info('[restart] Restart sentinel detected — initiating graceful shutdown')
      // Don't delete the sentinel here — the daemon wrapper needs to see it
      // to know it should restart (vs exit). The daemon deletes it after reading.
      // The daemon also clears stale sentinels before each start to prevent loops.
      void shutdown()
    }
  })

  // Run the threshold checker after each activation. The pure function returns
  // crossings; we eagerly stamp fired state, log a breadcrumb, and deliver
  // a user-facing alert via MessageStore + channelRouter.
  primary.system.activationLoop.onPostActivation(() => {
    try {
      const checkNow = new Date()
      const crossings = checkThresholds({
        thresholds: appState.getThresholds(),
        firedAt: appState.getAllThresholdFiredAt(),
        getCostSince: (since) => usage.getCostSince(since),
        now: checkNow,
        tz: config.timezone,
      })
      for (const crossing of crossings) {
        // Eager stamp — channelRouter retries internally and falls back to
        // another channel; re-firing on every activation if delivery breaks
        // would spam without delivering anything new.
        appState.setThresholdFiredAt(crossing.threshold.id, checkNow)

        log.info(
          `[threshold] fired: ${crossing.threshold.period} $${crossing.threshold.amountUsd.toFixed(2)} ` +
          `($${crossing.currentSpend.toFixed(2)}/$${crossing.threshold.amountUsd.toFixed(2)})`,
        )

        // Deliver to the active channel + persist to MessageStore so the
        // dashboard conversation also shows the alert.
        const channel = appState.getLastActiveChannel(primary.head.id)
        if (!channel) continue

        const text = formatThresholdAlert(crossing)
        messages.append({
          kind: 'text',
          role: 'assistant',
          id: generateId('msg'),
          content: text,
          channel,
          createdAt: now(),
        }, primary.head.id)
        void primary.channelRouter.send(channel, text).catch(err =>
          log.warn('[threshold] failed to send alert:', (err as Error).message),
        )
      }
    } catch (err) {
      // A failure in the threshold checker must NOT break the activation loop.
      // Log and continue — the worst case is one missed alert.
      log.error('[threshold] checker failed:', (err as Error).message)
    }
  })

  // Helper for the hot-reload blocks: pull the old adapter out of the
  // channelAdapters array before stopping it, so shutdown doesn't end up
  // calling .stop() twice on superseded instances.
  const retireAdapter = async (existing: ChannelAdapter | null, label: string): Promise<void> => {
    if (!existing) return
    const idx = channelAdapters.indexOf(existing)
    if (idx >= 0) channelAdapters.splice(idx, 1)
    await existing.stop().catch(() => {})
    log.info(`[hot-reload] Stopped existing ${label} adapter`)
  }

  const sentinelInterval = setInterval(() => {

    // NOTE (WR-04): All hot-reload blocks below are guarded by !isMultiHead.
    // In multi-head mode (isMultiHead=true) these blocks are skipped entirely —
    // named heads reconfigure by restarting the process.
    // primary.routeMessage is always correct inside these blocks because
    // isMultiHead=false guarantees resolvedHeads[0] is the synthesized 'default'
    // head, so primary === headSystems[0] and primary.routeMessage routes to the
    // correct (and only) head's queue.
    // DO NOT lift the !isMultiHead guard without also replacing primary.routeMessage
    // with the specific head's routeMessage to avoid cross-head misrouting.

    if (!isMultiHead) {
      if (fs.existsSync(DISCORD_RELOAD_PATH)) {
        fs.unlinkSync(DISCORD_RELOAD_PATH)
        log.info('[hot-reload] Discord reload sentinel detected')
        void (async () => {
          try {
            // Re-parse the env file to pick up vars written by config:set
            loadEnvFile(true)

            const token = process.env['DISCORD_BOT_TOKEN']
            const channelId = process.env['DISCORD_CHANNEL_ID']
            if (!token || !channelId) {
              log.warn('[hot-reload] Discord sentinel found but DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID still missing')
              return
            }

            await retireAdapter(currentDiscordAdapter, 'Discord')

            const discord = new DiscordAdapter(token, channelId, path.join(workspacePath, 'media'), 'discord', 'default')
            discord.onMessage(primary.routeMessage)
            primary.channelRouter.register(discord)
            await discord.start()
            currentDiscordAdapter = discord
            channelAdapters.push(discord)
            log.info('[hot-reload] Discord adapter loaded successfully')
          } catch (err) {
            log.error('[hot-reload] Failed to reload Discord:', (err as Error).message)
          }
        })()
      }
    }

    if (!isMultiHead) {
      if (fs.existsSync(TELEGRAM_RELOAD_PATH)) {
        fs.unlinkSync(TELEGRAM_RELOAD_PATH)
        log.info('[hot-reload] Telegram reload sentinel detected')
        void (async () => {
          try {
            // Re-parse the env file to pick up vars written by config:set
            loadEnvFile(true)

            const token = process.env['TELEGRAM_BOT_TOKEN']
            const chatId = process.env['TELEGRAM_CHAT_ID']
            if (!token || !chatId) {
              log.warn('[hot-reload] Telegram sentinel found but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID still missing')
              return
            }

            await retireAdapter(currentTelegramAdapter, 'Telegram')

            const telegram = new TelegramAdapter(token, chatId, path.join(workspacePath, 'media'), 'telegram', 'default')
            telegram.onMessage(primary.routeMessage)
            primary.channelRouter.register(telegram)
            await telegram.start()
            currentTelegramAdapter = telegram
            channelAdapters.push(telegram)
            log.info('[hot-reload] Telegram adapter loaded successfully')
          } catch (err) {
            log.error('[hot-reload] Failed to reload Telegram:', (err as Error).message)
          }
        })()
      }
    }

    if (!isMultiHead) {
      if (fs.existsSync(SLACK_RELOAD_PATH)) {
        fs.unlinkSync(SLACK_RELOAD_PATH)
        log.info('[hot-reload] Slack reload sentinel detected')
        void (async () => {
          try {
            // Re-parse the env file to pick up vars written by config:set
            loadEnvFile(true)

            const botToken = process.env['SLACK_BOT_TOKEN']
            const appToken = process.env['SLACK_APP_TOKEN']
            const channelId = process.env['SLACK_CHANNEL_ID']
            if (!botToken || !appToken || !channelId) {
              log.warn('[hot-reload] Slack sentinel found but SLACK_BOT_TOKEN, SLACK_APP_TOKEN, or SLACK_CHANNEL_ID still missing')
              return
            }

            await retireAdapter(currentSlackAdapter, 'Slack')

            const slack = new SlackAdapter(botToken, appToken, channelId, path.join(workspacePath, 'media'), 'slack', 'default')
            slack.onMessage(primary.routeMessage)
            primary.channelRouter.register(slack)
            await slack.start()
            currentSlackAdapter = slack
            channelAdapters.push(slack)
            log.info('[hot-reload] Slack adapter loaded successfully')
          } catch (err) {
            log.error('[hot-reload] Failed to reload Slack:', (err as Error).message)
          }
        })()
      }
    }

    if (!isMultiHead) {
      if (fs.existsSync(WHATSAPP_RELOAD_PATH)) {
        fs.unlinkSync(WHATSAPP_RELOAD_PATH)
        log.info('[hot-reload] WhatsApp reload sentinel detected')
        void (async () => {
          try {
            // Re-parse the env file to pick up vars written by config:set
            loadEnvFile(true)

            const allowedJid = process.env['WHATSAPP_ALLOWED_JID']
            if (!allowedJid) {
              log.warn('[hot-reload] WhatsApp sentinel found but WHATSAPP_ALLOWED_JID still missing')
              return
            }

            await retireAdapter(currentWhatsAppAdapter, 'WhatsApp')

            const { WhatsAppAdapter } = await import('./channels/whatsapp/adapter.js')
            const whatsappAuthDir = path.join(workspacePath, 'whatsapp', 'auth')
            const whatsappQrPath = path.join(workspacePath, 'whatsapp-qr.txt')
            const whatsapp = new WhatsAppAdapter(whatsappAuthDir, allowedJid, whatsappQrPath, path.join(workspacePath, 'media'), 'whatsapp', 'default')
            whatsapp.onMessage(primary.routeMessage)
            primary.channelRouter.register(whatsapp)
            await whatsapp.start()
            currentWhatsAppAdapter = whatsapp
            channelAdapters.push(whatsapp)
            log.info('[hot-reload] WhatsApp adapter started — check logs or whatsapp-qr.txt for QR if prompted')
          } catch (err) {
            log.error('[hot-reload] Failed to reload WhatsApp:', (err as Error).message)
          }
        })()
      }
    }

    if (!isMultiHead) {
      if (fs.existsSync(ZOHO_CLIQ_RELOAD_PATH)) {
        fs.unlinkSync(ZOHO_CLIQ_RELOAD_PATH)
        log.info('[hot-reload] Zoho Cliq reload sentinel detected')
        void (async () => {
          try {
            // Re-parse the env file to pick up vars written by config:set
            loadEnvFile(true)

            const clientId = process.env['ZOHO_CLIENT_ID']
            const clientSecret = process.env['ZOHO_CLIENT_SECRET']
            const refreshToken = process.env['ZOHO_REFRESH_TOKEN']
            const chatId = process.env['ZOHO_CLIQ_CHAT_ID']
            if (!clientId || !clientSecret || !refreshToken || !chatId) {
              log.warn('[hot-reload] Zoho Cliq sentinel found but required env vars still missing')
              return
            }

            await retireAdapter(currentZohoCliqAdapter, 'Zoho Cliq')

            const cliq = new ZohoCliqAdapter(clientId, clientSecret, refreshToken, chatId, path.join(workspacePath, 'media'), config.zohoCliqPollInterval, readAssistantName(workspacePath), zohoCliqState, workspacePath, 'zoho-cliq', 'default')
            cliq.onMessage(primary.routeMessage)
            primary.channelRouter.register(cliq)
            await cliq.start()
            currentZohoCliqAdapter = cliq
            channelAdapters.push(cliq)
            log.info('[hot-reload] Zoho Cliq adapter loaded successfully')
          } catch (err) {
            log.error('[hot-reload] Failed to reload Zoho Cliq:', (err as Error).message)
          }
        })()
      }
    }

  }, 10_000)

  // ── Start all per-head activation loops ───────────────────────────────────────
  for (const { system: s, head: h } of headSystems) {
    s.activationLoop.start()
    s.activationLoop.announceOnline()
    log.info(`[startup] head=${h.id} activation loop running`)
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  const shutdown = async () => {
    clearInterval(sentinelInterval)
    log.info('[shutdown] Stopping...')

    // Hard exit after 30 seconds if graceful shutdown hangs
    setTimeout(() => {
      log.warn('[shutdown] Graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, 30_000).unref()

    for (const adapter of channelAdapters) {
      try { await adapter.stop() } catch (err) { log.error('[shutdown] Channel stop error:', err) }
    }
    scheduler.stop()
    if (webhook) {
      try { await webhook.stop() } catch (err) { log.error('[shutdown] Webhook stop error:', err) }
    }
    try { await dashboard.stop() } catch (err) { log.error('[shutdown] Dashboard stop error:', err) }

    // Signal all running agents
    const running = agents.getByStatus('running')
    await Promise.all(running.map(t => agentRunner.retract(t.id).catch(() => {})))

    // Wait for in-flight agents to settle
    await agentRunner.awaitAll(5_000)

    // Mark any that didn't drain in time as failed
    for (const t of agents.getByStatus('running')) {
      agents.fail(t.id, 'process shutdown before agent could complete')
    }

    for (const { system: s } of headSystems) s.activationLoop.stop()
    db.close()
    log.info('[shutdown] Done.')
    process.exit(0)
  }

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })

  process.on('uncaughtException', (err) => {
    log.error('[fatal] Uncaught exception — shutting down', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    log.error('[warn] Unhandled promise rejection:', reason)
    // Don't exit — floating rejections are usually non-fatal (e.g. a channel
    // send that failed after the response was already delivered). Log and continue.
  })
}

main().catch(err => {
  log.error('[fatal]', err)
  process.exit(1)
})
