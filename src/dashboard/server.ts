import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { Config } from '../config.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { UsageStore } from '../db/usage.js'
import type { StewardRunStore } from '../db/steward_runs.js'
import type { DashboardEventBus } from './events.js'
import { TokenStore, sessionMiddleware, requireSameOrigin } from './auth.js'
import { createAuthRouter } from './routes/auth.js'
import { createMessagesRouter } from './routes/messages.js'
import { createStewardRunsRouter } from './routes/steward_runs.js'
import { createUsageRouter } from './routes/usage.js'
import { createStreamRouter } from './routes/stream.js'
import { createControlsRouter } from './routes/controls.js'
import { createStatusRouter } from './routes/status.js'
import { createActivityRouter } from './routes/activity.js'
import { createTracesRouter } from './routes/traces.js'
import { createMemoryRouter } from './routes/memory.js'
import { createIdentityRouter } from './routes/identity.js'
import { createSkillsRouter } from './routes/skills.js'
import { createKindRouter } from './routes/kind.js'
import { readAssistantName } from '../config-file.js'
import { createTestsRouter } from './routes/tests.js'
import { createEvalsRouter } from './routes/evals.js'
import { createSchedulesRouter } from './routes/schedules.js'
import { createToolsRouter } from './routes/tools.js'
import { createMcpRouter } from './routes/mcp.js'
import { createSettingsRouter } from './routes/settings.js'
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
import type { ScheduleStore } from '../db/schedules.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { AgentRunner } from '../types/agent.js'

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
  unifiedLoader?: UnifiedLoader
  db?: DatabaseSync
  evalResultsDir?: string
  channelAdapter?: DashboardChannelAdapter
  schedules?: ScheduleStore
  mcpRegistry?: McpRegistry
  agentRunner?: AgentRunner
  appState?: import('../db/app_state.js').AppStateStore
}

export class DashboardServer {
  private server: Server | null = null
  private tokenStore = new TokenStore()

  constructor(private opts: DashboardServerOptions) {}

  /** Revoke all dashboard sessions (e.g. after password change). */
  revokeAllSessions(): void { this.tokenStore.revokeAll() }

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
      requireSameOrigin(req, res, next)
    })

    // API routes
    app.use('/api/auth', createAuthRouter(this.tokenStore, config))
    app.use('/api/messages', createMessagesRouter(messages, this.opts.channelAdapter, path.join(config.workspacePath.replace(/^~/, os.homedir()), 'media')))
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
      app.use('/api/skills', createSkillsRouter(this.opts.skills.loader, this.opts.skills.systemSkillNames))
    }
    if (this.opts.tasks) {
      app.use('/api/tasks', createKindRouter(this.opts.tasks.loader, { kind: 'task', notFoundLabel: 'Task' }))
    }
    app.use('/api/tools', createToolsRouter())
    if (this.opts.mcpRegistry) {
      app.use('/api/mcp', createMcpRouter(this.opts.mcpRegistry))
    }
    const envFilePath = process.env['SHROK_ENV_FILE'] ?? path.join(workspacePath, '.env')
    app.use('/api/settings', createSettingsRouter(workspacePath, envFilePath, config, this.opts.appState, this.opts.events))
    app.use('/api/media', createMediaRouter(path.join(workspacePath, 'media')))
    // Docs viewer: serve the repo's checked-in /docs tree to the dashboard.
    // Resolved from the compiled module location so it works in both native
    // (tsx from src/) and Docker (dist/) runs — same pattern as tests.ts.
    const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs')
    app.use('/api/docs', createDocsRouter(docsDir))

    // Public (unauthenticated) theme endpoint for the login page
    app.get('/api/theme', (_req, res) => {
      let cfg: Record<string, unknown> = {}
      try {
        const p = path.join(workspacePath, 'config.json')
        if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
      } catch { /* ignore */ }
      const logoPath = (cfg['logoPath'] as string) || ''
      res.json({
        accentColor: (cfg['accentColor'] as string) || '#8C51CD',
        logoUrl: logoPath ? `/api/branding/${logoPath}` : '/logo.svg',
        assistantName: readAssistantName(workspacePath),
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
      app.use('/api/schedules', createSchedulesRouter(this.opts.schedules, this.opts.config.timezone, this.opts.unifiedLoader))
    }
    if (this.opts.db && this.opts.evalResultsDir) {
      app.use('/api/evals', createEvalsRouter(this.opts.db, this.opts.evalResultsDir))
    }
    if (controls) {
      app.use('/api/controls', createControlsRouter(controls))
      app.use('/api/status', createStatusRouter(controls.getStatus))
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
