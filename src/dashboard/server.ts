import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { Config, ResolvedHead } from '../config.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { UsageStore } from '../db/usage.js'
import type { StewardRunStore } from '../db/steward_runs.js'
import type { DashboardEventBus } from './events.js'
import { TokenStore, sessionMiddleware, requireSameOrigin } from './auth.js'
import { normalizeDashboardUsers } from './dashboard-users.js'
import { createAuthRouter } from './routes/auth.js'
import { createMessagesRouter } from './routes/messages.js'
import { createHeadsRouter } from './routes/heads.js'
import { createStewardRunsRouter } from './routes/steward_runs.js'
import { createUsageRouter } from './routes/usage.js'
import { createStreamRouter } from './routes/stream.js'
import { createControlsRouter } from './routes/controls.js'
import { createStatusRouter } from './routes/status.js'
import { createActivityRouter } from './routes/activity.js'
import { createTracesRouter } from './routes/traces.js'
import { createMemoryRouter } from './routes/memory.js'
import { createIdentityRouter } from './routes/identity.js'
import { createKindRouter } from './routes/kind.js'
import { createSensorsRouter } from './routes/sensors.js'
import { readAssistantName } from '../config-file.js'
import { createTestsRouter } from './routes/tests.js'
import { createEvalsRouter } from './routes/evals.js'
import { createSchedulesRouter } from './routes/schedules.js'
import { createToolsRouter } from './routes/tools.js'
import { createMcpRouter } from './routes/mcp.js'
import { createSettingsRouter } from './routes/settings.js'
import { createContextWindowRouter } from './routes/context-window.js'
import { createMediaRouter } from './routes/media.js'
import { createDocsRouter } from './routes/docs.js'
import { createAgentsRouter } from './routes/agents.js'
import type { StatusInfo } from './routes/status.js'
import type { Memory } from '../memory/index.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { SkillLoader } from '../types/skill.js'
import type { UnifiedLoader } from '../skills/unified.js'
import type { DatabaseSync } from '../db/index.js'
import type { DashboardChannelAdapter } from '../channels/dashboard/adapter.js'
import type { HomeAssistantChannelAdapter } from '../channels/home-assistant/adapter.js'
import { createHomeAssistantRouter } from '../channels/home-assistant/router.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { AgentRunner } from '../types/agent.js'
import type { QueueStore } from '../db/queue.js'

export interface DashboardServerOptions {
  config: Config
  messages: MessageStore
  agents: AgentStore
  usage: UsageStore
  stewardRuns: StewardRunStore
  events: DashboardEventBus
  controls?: {
    stop: () => void
    restart: () => void
    emergencyStop: () => number
    getStatus: () => StatusInfo
  }
  topicMemory?: Memory
  identity?: {
    mainLoader: IdentityLoader
    mainWorkspaceDir: string
    agentLoader: IdentityLoader
    agentWorkspaceDir: string
    stewardsWorkspaceDir?: string
    proactiveWorkspaceDir?: string
    memoryPromptsWorkspaceDir?: string
  }
  skills?: {
    loader: SkillLoader
    systemSkillNames: Set<string>
  }
  tasks?: {
    loader: SkillLoader
  }
  sensors?: {
    workspacePath: string
  }
  unifiedLoader?: UnifiedLoader
  db?: DatabaseSync
  evalResultsDir?: string
  dashboardAdapters: Map<string, DashboardChannelAdapter>
  schedules?: ScheduleStore
  mcpRegistry?: McpRegistry
  agentRunner?: AgentRunner
  appState?: import('../db/app_state.js').AppStateStore
  /** Phase 32 (D-08): canonical head list for /api/heads. When omitted,
   *  the server falls back to a single synthetic 'default' head so legacy
   *  callers and tests that don't pass this option keep working. */
  resolvedHeads?: ResolvedHead[]
  /** Phase 33 Plan 04: required by the heads CRUD router for the
   *  delete-head wipe transaction (D-07). */
  queue?: QueueStore
  /** Phase 33 Plan 04: fresh head list re-read from disk per request,
   *  so the heads router sees the latest config.json without an in-memory
   *  cache. When omitted, falls back to `resolvedHeads`. */
  resolveCurrentHeads?: () => ResolvedHead[]
  /** Phase 41: Home Assistant inbound adapters. When present, mounts /v1/chat/completions
   *  for each adapter before the SPA catch-all. Auth is bearer-token (HA_INBOUND_API_KEY);
   *  /v1/* is excluded from the dashboard CSRF guard (HACV-06). */
  homeAssistantAdapters?: HomeAssistantChannelAdapter[]
}

export class DashboardServer {
  private server: Server | null = null
  private tokenStore = new TokenStore()

  constructor(private opts: DashboardServerOptions) {}

  /** Revoke all dashboard sessions (e.g. after password change). */
  revokeAllSessions(): void { this.tokenStore.revokeAll() }

  /** Resolve the login-picked display name for the session in a raw `Cookie` header,
   *  if any. The voice WebSocket authenticates via the same `shrok_session` cookie as
   *  the rest of the dashboard, so this lets it attribute spoken messages to the
   *  logged-in user (the `[Name]:` prefix), exactly like the typed-message path. Returns
   *  undefined when there's no cookie, no session, or no name bound to it. */
  resolveSessionUser(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() !== 'shrok_session') continue
      const token = decodeURIComponent(part.slice(eq + 1).trim())
      return this.tokenStore.getUser(token)
    }
    return undefined
  }

  /** Expose the underlying http.Server so channel adapters (e.g. VoiceChannelAdapter)
   *  can attach a WebSocket upgrade listener. Returns null before .start() resolves
   *  or after .stop() runs. (Phase 19 D-01) */
  getHttpServer(): Server | null {
    return this.server
  }

  async start(): Promise<void> {
    const { config, messages, agents, stewardRuns, events, controls } = this.opts
    const workspacePath = config.workspacePath.replace(/^~/, os.homedir())
    const traceDir = path.join(workspacePath, 'data', 'trace')
    const app = express()

    // Trust reverse proxies only when behind one (dashboardHttps or non-localhost binding).
    // Without this guard, X-Forwarded-For can be spoofed to bypass the login rate limiter.
    if (config.dashboardHttps || config.dashboardHost === '0.0.0.0') {
      app.set('trust proxy', 1)
    }

    app.use(helmet({ contentSecurityPolicy: false })) // CSP off — dashboard is a SPA with inline styles
    // Cross-origin isolation — required for SharedArrayBuffer (ONNX WASM used by voice VAD).
    // Localhost gets a browser exemption automatically; remote access (phone, tablet) does not.
    // 'credentialless' COEP allows cross-origin subresources that don't send credentials,
    // which covers all the static assets we load without breaking cookie-authenticated API calls.
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      next()
    })
    app.use(cookieParser())
    app.use(express.json({ limit: '50mb' }))
    app.use(sessionMiddleware(this.tokenStore))

    // CSRF protection: block cross-origin state-changing requests
    app.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
      if (req.path.startsWith('/v1/')) return next()   // HA bearer-auth; /v1 router validates
      requireSameOrigin(req, res, next)
    })

    // API routes
    app.use('/api/auth', createAuthRouter(this.tokenStore, config))
    app.use('/api/messages', createMessagesRouter(messages, this.opts.dashboardAdapters, path.join(config.workspacePath.replace(/^~/, os.homedir()), 'media')))
    const envFilePathEarly = process.env['SHROK_ENV_FILE'] ?? path.join(workspacePath, '.env')
    const fallbackResolvedHeads: ResolvedHead[] = this.opts.resolvedHeads ?? [{ id: 'default', channels: [] }]
    const resolveCurrentHeads = this.opts.resolveCurrentHeads ?? (() => this.opts.resolvedHeads ?? fallbackResolvedHeads)
    // Heads CRUD router needs db + messages + queue for DELETE / PATCH wipe & rename
    // (Phase 33 D-07, D-14). When the host didn't pass them (legacy callers / tests
    // that only exercise GET), wire stub stores against an in-memory DB so the
    // factory's required fields are populated without affecting GET behavior.
    const headsDb = this.opts.db
    const headsMessages = this.opts.messages
    const headsQueue = this.opts.queue
    if (headsDb && headsQueue) {
      app.use('/api/heads', createHeadsRouter({
        workspacePath,
        configPath: path.join(workspacePath, 'config.json'),
        envFilePath: envFilePathEarly,
        resolveCurrentHeads,
        db: headsDb,
        messages: headsMessages,
        queue: headsQueue,
        // Plan 35-03 D-16: scheduleStore wired so DELETE /api/heads/:id can
        // cascade-delete schedules + reminders. In real production wiring
        // schedules is always present when db + queue are present; assert
        // the non-null so we don't need a cascade-vs-no-cascade branch.
        scheduleStore: this.opts.schedules!,
      }))
    } else {
      // Tests / legacy: GET-only router with a noop deps payload. POST/PATCH/DELETE
      // will throw at call time because db/queue are missing, which is acceptable —
      // any caller that needs mutations passes db + queue.
      app.use('/api/heads', createHeadsRouter({
        workspacePath,
        configPath: path.join(workspacePath, 'config.json'),
        envFilePath: envFilePathEarly,
        resolveCurrentHeads,
        db: null as unknown as DatabaseSync,
        messages: headsMessages,
        queue: null as unknown as QueueStore,
        // GET-only path: cascade never runs. Same pattern as db/queue above.
        scheduleStore: null as unknown as ScheduleStore,
      }))
    }
    app.use('/api/steward-runs', createStewardRunsRouter(stewardRuns))
    app.use('/api/usage', createUsageRouter(this.opts.usage, config.timezone, this.opts.appState, this.opts.events, this.opts.unifiedLoader))
    app.use('/api/stream', createStreamRouter(events))
    app.use('/api/agents', createAgentsRouter(agents, this.opts.agentRunner))
    app.use('/api/activity', createActivityRouter(messages, agents, stewardRuns))
    app.use('/api/traces', createTracesRouter(traceDir))
    if (this.opts.topicMemory) {
      app.use('/api/memory', createMemoryRouter(this.opts.topicMemory, config.workspacePath))
    }
    if (this.opts.identity) {
      const { mainLoader, mainWorkspaceDir, agentLoader, agentWorkspaceDir, stewardsWorkspaceDir, proactiveWorkspaceDir, memoryPromptsWorkspaceDir } = this.opts.identity
      app.use('/api/identity', createIdentityRouter(mainLoader, mainWorkspaceDir, agentLoader, agentWorkspaceDir, stewardsWorkspaceDir ?? '', proactiveWorkspaceDir ?? '', memoryPromptsWorkspaceDir ?? ''))
    }
    if (this.opts.skills) {
      const skillsOpts: import('./routes/kind.js').CreateKindRouterOptions = {
        kind: 'skill',
        notFoundLabel: 'Skill',
        systemNames: this.opts.skills.systemSkillNames,
        usageStore: this.opts.usage,
        ...(this.opts.unifiedLoader ? { unifiedLoader: this.opts.unifiedLoader } : {}),
        ...(this.opts.schedules ? { scheduleStore: this.opts.schedules } : {}),
      }
      app.use('/api/skills', createKindRouter(this.opts.skills.loader, skillsOpts))
    }
    if (this.opts.tasks) {
      const tasksOpts: import('./routes/kind.js').CreateKindRouterOptions = {
        kind: 'task',
        notFoundLabel: 'Task',
        usageStore: this.opts.usage,
        ...(this.opts.unifiedLoader ? { unifiedLoader: this.opts.unifiedLoader } : {}),
        ...(this.opts.schedules ? { scheduleStore: this.opts.schedules } : {}),
      }
      app.use('/api/tasks', createKindRouter(this.opts.tasks.loader, tasksOpts))
    }
    if (this.opts.sensors) {
      app.use('/api/sensors', createSensorsRouter(this.opts.sensors))
    }
    app.use('/api/tools', createToolsRouter())
    if (this.opts.mcpRegistry) {
      app.use('/api/mcp', createMcpRouter(this.opts.mcpRegistry))
    }
    const envFilePath = process.env['SHROK_ENV_FILE'] ?? path.join(workspacePath, '.env')
    app.use('/api/settings', createSettingsRouter(workspacePath, envFilePath, config, this.opts.appState, this.opts.events))
    // Context-window budget bar (dashboard Settings → Behavior). Measures the
    // shared system-prompt blocks; the memory/history/output split is computed
    // client-side from the live draft. Needs the identity loader to mean anything.
    if (this.opts.identity) {
      app.use('/api/context-window', createContextWindowRouter({
        config,
        workspacePath,
        identityLoader: this.opts.identity.mainLoader,
        ...(this.opts.skills ? { skillLoader: this.opts.skills.loader } : {}),
        ...(this.opts.mcpRegistry ? { mcpRegistry: this.opts.mcpRegistry } : {}),
      }))
    }
    app.use('/api/media', createMediaRouter(path.join(workspacePath, 'media')))
    // Docs viewer: serve the repo's checked-in /docs tree to the dashboard.
    // Resolved from the compiled module location so it works in both native
    // (tsx from src/) and Docker (dist/) runs — same pattern as tests.ts.
    const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs')
    app.use('/api/docs', createDocsRouter(docsDir))

    // Phase 45 RING-06: serve bundled beep at /media/ring.mp3 — unauthenticated,
    // literal-match (NO :filename path param, NO traversal), mounted BEFORE
    // express.static + SPA catch-all so neither can shadow it.
    const ringAssetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/ring.mp3')
    app.get('/media/ring.mp3', (_req, res) => {
      res.setHeader('Content-Type', 'audio/mpeg')
      res.sendFile(ringAssetPath)
    })

    // Public (unauthenticated) theme endpoint for the login page
    app.get('/api/theme', (_req, res) => {
      let cfg: Record<string, unknown> = {}
      try {
        const p = path.join(workspacePath, 'config.json')
        if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
      } catch { /* ignore */ }
      const logoPath = (cfg['logoPath'] as string) || ''
      const dashboardUsers = normalizeDashboardUsers(cfg['dashboardUsers'])
      res.json({
        accentColor: (cfg['accentColor'] as string) || '#8C51CD',
        logoUrl: logoPath ? `/api/branding/${logoPath}` : '/logo.svg',
        assistantName: readAssistantName(workspacePath),
        dashboardUsers,
        version: process.env['SHROK_VERSION'] ?? 'unknown',
      })
    })
    // Public branding assets (logo) — separate from workspace media/ which requires auth
    const brandingDir = path.join(workspacePath, 'branding')
    app.get('/api/branding/:filename', (req, res) => {
      const filename = String(req.params['filename'])
      const resolved = path.resolve(brandingDir, filename)
      const base = path.resolve(brandingDir)
      if ((resolved !== base && !resolved.startsWith(base + path.sep)) || !fs.existsSync(resolved)) {
        res.status(404).send('Not found')
        return
      }
      res.sendFile(resolved)
    })
    app.use('/api/tests', createTestsRouter())
    if (this.opts.schedules) {
      // Plan 35-03 D-11: schedules router takes resolveCurrentHeads as a 3rd
      // required arg so POST /api/schedules can validate body.headId against
      // the live head list. Reuses the same callback wired into the heads
      // router above so dashboard config edits between requests land without
      // a process restart.
      app.use('/api/schedules', createSchedulesRouter(this.opts.schedules, this.opts.config.timezone, resolveCurrentHeads, this.opts.unifiedLoader))
    }
    if (this.opts.db && this.opts.evalResultsDir) {
      app.use('/api/evals', createEvalsRouter(this.opts.db, this.opts.evalResultsDir))
    }
    if (controls) {
      app.use('/api/controls', createControlsRouter(controls))
      app.use('/api/status', createStatusRouter(controls.getStatus))
    }

    // Phase 41: Home Assistant inbound endpoint — mount BEFORE the SPA catch-all
    // so /v1/chat/completions is not intercepted by the GET '*' fallback (HACV-06).
    // HA_INBOUND_API_KEY is read at start() time (not module-eval time) — Pitfall 4.
    if (this.opts.homeAssistantAdapters?.length) {
      const haInboundApiKey = process.env['HA_INBOUND_API_KEY']
      // Never mount /v1 without a configured key — CR-01: an empty key must not
      // produce an open endpoint. The adapter constructor (D-02) already throws
      // on a missing key at boot; this is defense-in-depth at the mount site.
      if (haInboundApiKey) {
        for (const haAdapter of this.opts.homeAssistantAdapters) {
          app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))
        }
      }
    }

    // Serve built frontend in production (dashboard/dist must exist)
    const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist')
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath))
      // SPA fallback — send index.html for non-API routes only.
      // API typos get a proper 404 JSON instead of silent HTML.
      app.get('/api/*', (_req, res) => { res.status(404).json({ error: 'Not found' }) })
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'))
      })
    }

    await new Promise<void>((resolve, reject) => {
      const host = config.dashboardHost ?? '127.0.0.1'
      this.server = app.listen(config.dashboardPort, host, () => resolve())
      this.server.once('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) => {
      this.server!.close(err => (err ? reject(err) : resolve()))
    })
    this.server = null
  }
}
