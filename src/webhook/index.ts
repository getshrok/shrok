import express, { type Request, type Response } from 'express'
import { log } from '../logger.js'
import * as crypto from 'node:crypto'
import type { Server } from 'node:http'
import type { QueueStore } from '../db/queue.js'
import { PRIORITY } from '../types/core.js'

export interface WebhookListener {
  start(): Promise<void>
  stop(): Promise<void>
}

/** Fixed-window rate limiter: counts per source per 60-second window. */
class RateLimiter {
  private windows = new Map<string, { count: number; windowStart: number }>()
  private limitPerMinute: number

  constructor(limitPerMinute: number) {
    this.limitPerMinute = limitPerMinute
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  allow(source: string): boolean {
    const now = Date.now()
    const windowMs = 60_000
    const entry = this.windows.get(source)

    if (!entry || now - entry.windowStart >= windowMs) {
      this.windows.set(source, { count: 1, windowStart: now })
      this.evictStale(now, windowMs)
      return true
    }

    if (entry.count >= this.limitPerMinute) {
      return false
    }

    entry.count++
    return true
  }

  private evictStale(now: number, windowMs: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= windowMs) this.windows.delete(key)
    }
  }
}

function verifySignature(body: Buffer, secret: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false
  // Accept "sha256=<hex>" format
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

export class WebhookListenerImpl implements WebhookListener {
  private queueStore: QueueStore
  private port: number
  private host: string
  private secret: string | undefined
  private rateLimiter: RateLimiter
  private server: Server | null = null

  constructor(
    queueStore: QueueStore,
    port: number,
    secret: string | undefined,
    rateLimitPerMinute: number,
    host = '127.0.0.1',
  ) {
    this.queueStore = queueStore
    this.port = port
    this.host = host
    this.secret = secret
    this.rateLimiter = new RateLimiter(rateLimitPerMinute)
  }

  async start(): Promise<void> {
    if (!this.secret) {
      log.warn('[webhook] WEBHOOK_SECRET is not set — all incoming requests will be rejected with 503')
    }

    const app = express()

    // Capture raw body for HMAC verification before JSON parsing
    app.use(express.raw({ type: '*/*' }))

    app.post('/webhook/:source', (req: Request, res: Response) => {
      const source = req.params['source'] as string
      const rawBody = req.body as Buffer

      // Signature verification — reject all requests if no secret is configured
      if (!this.secret) {
        res.status(503).json({ error: 'Webhook not configured: WEBHOOK_SECRET is not set' })
        return
      }
      const sig = req.headers['x-hub-signature-256'] as string | undefined
        ?? req.headers['x-signature'] as string | undefined
      if (!verifySignature(rawBody, this.secret, sig)) {
        res.status(401).json({ error: 'Invalid signature' })
        return
      }

      // Rate limiting
      if (!this.rateLimiter.allow(source)) {
        res.status(429).json({ error: 'Rate limit exceeded' })
        return
      }

      // Parse body
      let parsed: Record<string, unknown> = {}
      try {
        if (rawBody.length > 0) {
          parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
        }
      } catch {
        // Non-JSON body — treat as empty payload
      }

      const event = (req.query['event'] as string) ?? (parsed['event'] as string) ?? 'webhook'
      const payload = parsed

      const eventId = `qe_wh_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      this.queueStore.enqueue(
        {
          type: 'webhook',
          id: eventId,
          source,
          event,
          payload,
          createdAt: new Date().toISOString(),
        },
        PRIORITY.WEBHOOK,
      )

      res.status(200).json({ ok: true })
    })

    await new Promise<void>((resolve, reject) => {
      this.server = app.listen(this.port, this.host, () => resolve())
      this.server!.once('error', reject)
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) { resolve(); return }
      this.server.close(err => (err ? reject(err) : resolve()))
    })
    this.server = null
  }
}
