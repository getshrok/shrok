import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import { OPTIONAL_TOOL_NAMES } from '../../sub-agents/registry.js'

export function createToolsRouter() {
  const router = express.Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({ tools: [...OPTIONAL_TOOL_NAMES] })
  })

  return router
}
