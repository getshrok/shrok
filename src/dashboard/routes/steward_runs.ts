import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { StewardRunStore } from '../../db/steward_runs.js'

export function createStewardRunsRouter(stewardRuns: StewardRunStore): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({ stewardRuns: stewardRuns.getAll() })
  })

  return router
}
