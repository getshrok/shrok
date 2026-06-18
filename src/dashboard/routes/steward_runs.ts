import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { StewardRunStore } from '../../db/steward_runs.js'

export function createStewardRunsRouter(stewardRuns: StewardRunStore): Router {
  const router = Router()

  router.get('/', requireAuth, (req: Request, res: Response): void => {
    const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
    res.json({ stewardRuns: stewardRuns.getRecent(60, head) })
  })

  return router
}
