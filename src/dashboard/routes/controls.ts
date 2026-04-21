import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'

export function createControlsRouter(controls: {
  stop: () => void
  restart: () => void
  emergencyStop: () => number
}): Router {
  const router = Router()

  router.post('/stop', requireAuth, (_req: Request, res: Response): void => {
    res.json({ ok: true })
    controls.stop()  // respond first, then exit
  })

  router.post('/restart', requireAuth, (_req: Request, res: Response): void => {
    res.json({ ok: true })
    controls.restart()
  })

  router.post('/emergency-stop', requireAuth, (_req: Request, res: Response): void => {
    const cancelled = controls.emergencyStop()
    res.json({ ok: true, cancelledAgents: cancelled })
    // Process exits after the response is sent (emergencyStop calls stop internally)
  })

  return router
}
