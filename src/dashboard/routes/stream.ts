import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { DashboardEventBus, DashboardEvent } from '../events.js'

export function createStreamRouter(events: DashboardEventBus): Router {
  const router = Router()

  router.get('/', requireAuth, (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const listener = (data: DashboardEvent): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    events.on('dashboard', listener)

    // Send a comment every 30s to prevent proxy timeouts
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n')
    }, 30_000)

    req.on('close', () => {
      clearInterval(heartbeat)
      events.off('dashboard', listener)
    })
  })

  return router
}
