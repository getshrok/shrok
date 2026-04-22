import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { AgentStore } from '../../db/agents.js'
import type { AgentRunner } from '../../types/agent.js'

export function createAgentsRouter(agents: AgentStore, agentRunner?: AgentRunner) {
  const router = Router()

  // List recent agents (all statuses, not just active)
  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const recent = agents.getRecent(20)
    res.json({ agents: recent.map(a => ({
      id: a.id,
      task: a.task,
      status: a.status,
      skillName: a.skillName ?? null,
      trigger: a.trigger,
      model: a.model,
      parentAgentId: a.parentAgentId ?? null,
      pendingQuestion: a.pendingQuestion ?? null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      completedAt: a.completedAt ?? null,
      colorSlot: a.colorSlot ?? null,
    })) })
  })

  // Get agent's message history
  router.get('/:id/history', requireAuth, (req: Request, res: Response): void => {
    const agent = agents.get(String(req.params.id))
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    res.json({
      history: agent.history ?? [],
      status: agent.status,
      task: agent.task,
      pendingQuestion: agent.pendingQuestion ?? null,
    })
  })

  // Cancel an agent
  router.post('/:id/cancel', requireAuth, (req: Request, res: Response): void => {
    if (!agentRunner) {
      res.status(503).json({ error: 'Agent runner not available' })
      return
    }
    const agent = agents.get(String(req.params.id))
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    void agentRunner.retract(String(req.params.id)).then(() => {
      res.json({ ok: true })
    }).catch(err => {
      res.status(500).json({ error: (err as Error).message })
    })
  })

  // Xray: flatten recent agent tool calls/results for the head timeline
  const AGENT_MGMT_TOOLS = new Set(['spawn_agent', 'message_agent', 'cancel_agent'])
  router.get('/xray-history', requireAuth, (_req: Request, res: Response): void => {
    const recent = agents.getRecent(50)
    const messages: Array<{ agentId: string; message: import('../../types/core.js').Message }> = []

    for (const agent of recent) {
      if (agent.trigger !== 'manual') continue  // xray only shows head-spawned agents
      if (!agent.history?.length) continue
      for (const msg of agent.history) {
        if (msg.kind === 'tool_call') {
          // Filter out agent management tool calls
          const filtered = msg.toolCalls.filter(tc => !AGENT_MGMT_TOOLS.has(tc.name))
          if (filtered.length === 0) continue
        }
        if (msg.kind === 'tool_result') {
          const filtered = msg.toolResults.filter(tr => !AGENT_MGMT_TOOLS.has(tr.name))
          if (filtered.length === 0) continue
        }
        if (msg.kind === 'tool_call' || msg.kind === 'tool_result') {
          messages.push({ agentId: agent.id, message: msg })
        }
      }
    }

    messages.sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))
    res.json({ messages })
  })

  return router
}
