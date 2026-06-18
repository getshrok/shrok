import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { TokenStore, setSessionCookie, verifyPassword, requireAuth } from '../auth.js'
import { normalizeDashboardUsers } from '../dashboard-users.js'
import type { Config } from '../../config.js'

/** Read the operator-configured dashboard login identities fresh from config.json
 *  so a name added via Settings works without a server restart. Returns [] on any
 *  read/parse error or when the field is absent. */
function readDashboardUsers(workspacePath: string): string[] {
  try {
    const p = path.join(workspacePath.replace(/^~/, os.homedir()), 'config.json')
    if (!fs.existsSync(p)) return []
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    return normalizeDashboardUsers(cfg['dashboardUsers']).map(u => u.name)
  } catch {
    return []
  }
}

// Simple per-IP rate limiter for login attempts
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const LOGIN_MAX_ENTRIES = 10_000
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

// Sweep expired entries every 5 minutes to prevent unbounded growth from rotating IPs
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip)
  }
}, 5 * 60 * 1000).unref()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    // Hard cap: if map is huge despite sweeps, reject new IPs (fail-closed)
    if (!entry && loginAttempts.size >= LOGIN_MAX_ENTRIES) return true
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return false
  }
  entry.count++
  return entry.count > LOGIN_MAX_ATTEMPTS
}

function clearRateLimit(ip: string): void {
  loginAttempts.delete(ip)
}

export function createAuthRouter(store: TokenStore, config: Config): Router {
  const router = Router()

  router.post('/login', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'

        if (isRateLimited(ip)) {
          res.status(429).json({ error: 'Too many login attempts — try again later' })
          return
        }

        if (!config.dashboardPasswordHash) {
          res.status(503).json({ error: 'Dashboard password not configured — run npm run setup' })
          return
        }

        const { password, user } = req.body as { password?: string; user?: string }
        if (typeof password !== 'string' || !password) {
          res.status(400).json({ error: 'Missing password' })
          return
        }

        // Identity pick: when dashboard users are configured, the chosen name
        // must be one of them (defends against a stale/forged pick). When none
        // are configured, ignore any submitted user — behavior is unchanged.
        const dashboardUsers = readDashboardUsers(config.workspacePath)
        let resolvedUser: string | undefined
        if (dashboardUsers.length > 0) {
          if (typeof user !== 'string' || !dashboardUsers.includes(user)) {
            res.status(400).json({ error: 'Select who you are to sign in' })
            return
          }
          resolvedUser = user
        }

        let valid = await verifyPassword(password, config.dashboardPasswordHash)
        if (!valid && config.dashboardBackupPasswordHash) {
          valid = await verifyPassword(password, config.dashboardBackupPasswordHash)
        }
        if (!valid) {
          res.status(401).json({ error: 'Invalid password' })
          return
        }

        clearRateLimit(ip)

        const token = store.create(resolvedUser)
        setSessionCookie(req, res, token, config)
        res.json({ ok: true })
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
      }
    })()
  })

  router.post('/logout', (req: Request, res: Response): void => {
    const token = (req.cookies as Record<string, string> | undefined)?.['shrok_session']
    if (token) store.revoke(token)
    res.clearCookie('shrok_session', { path: '/' })
    res.json({ ok: true })
  })

  router.get('/me', requireAuth, (_req: Request, res: Response): void => {
    res.json({ ok: true })
  })

  return router
}
