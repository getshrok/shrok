import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { McpRegistry } from '../../mcp/registry.js'

export function createMcpRouter(mcpRegistry: McpRegistry) {
  const router = express.Router()

  router.get('/capabilities', requireAuth, (_req: Request, res: Response): void => {
    res.json({ capabilities: mcpRegistry.listCapabilities().sort() })
  })

  return router
}
