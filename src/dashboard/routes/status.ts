import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'

export interface StatusInfo {
  uptimeSeconds: number
  estimatedSpendToday: number
  blockingThresholds: number
  activeAgents: number
  runningAgents: number
  suspendedAgents: number
}

export function createStatusRouter(getStatus: () => StatusInfo): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json(getStatus())
  })

  return router
}
