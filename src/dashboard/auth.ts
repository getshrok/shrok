import { randomBytes } from 'node:crypto'
import bcryptjs from 'bcryptjs'
import type { Request, Response, NextFunction } from 'express'
import type { Config } from '../config.js'

// ─── Token Store ──────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

export class TokenStore {
  private sessions = new Map<string, number>()  // token → expiresAt (ms)
  private sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [token, expiresAt] of this.sessions) {
      if (now > expiresAt) this.sessions.delete(token)
    }
  }, 60 * 60 * 1000).unref() // sweep expired sessions every hour

  create(): string {
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, Date.now() + SESSION_TTL_MS)
    return token
  }

  validate(token: string): boolean {
    const expiresAt = this.sessions.get(token)
    if (expiresAt === undefined) return false
    if (Date.now() > expiresAt) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  revoke(token: string): void {
    this.sessions.delete(token)
  }

  /** Revoke all sessions (e.g. after password change). */
  revokeAll(): void {
    this.sessions.clear()
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function sessionMiddleware(store: TokenStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = (req.cookies as Record<string, string> | undefined)?.['shrok_session']
    if (token && store.validate(token)) {
      res.locals['authenticated'] = true
    }
    next()
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals['authenticated']) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

/** Block cross-site GET requests that spawn subprocesses (SSE endpoints).
 *  Prevents lax-cookie cross-site nav from triggering test/eval runs. */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'Cross-site request blocked' })
    return
  }
  next()
}

// ─── Cookie helper ────────────────────────────────────────────────────────────

export function setSessionCookie(req: Request, res: Response, token: string, config: Config): void {
  res.cookie('shrok_session', token, {
    httpOnly: true,
    secure: config.dashboardHttps || req.secure,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
}

// ─── Login helper ─────────────────────────────────────────────────────────────

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcryptjs.compare(password, hash)
}
