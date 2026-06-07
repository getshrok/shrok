import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import { AGENT_TOOL_NAMES } from '../../sub-agents/registry.js'
import { HEAD_TOOLS } from '../../head/index.js'

export function createToolsRouter() {
  const router = express.Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({
      tools: [...AGENT_TOOL_NAMES],
      headTools: HEAD_TOOLS.map(t => t.name).sort(),
    })
  })

  return router
}
