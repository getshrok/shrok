import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { ResolvedHead } from '../../config.js'

/**
 * GET /api/heads — returns the resolved head list for the dashboard head selector
 * (Phase 32 D-08).
 *
 * Response shape: { heads: Array<{ id: string }> }. Only `id` is projected so
 * channel credentials never leak through this endpoint.
 */
export function createHeadsRouter(resolvedHeads: ResolvedHead[]): Router {
  const router = Router()
  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({ heads: resolvedHeads.map(h => ({ id: h.id })) })
  })
  return router
}
