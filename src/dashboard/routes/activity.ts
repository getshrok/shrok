import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { MessageStore } from '../../db/messages.js'
import type { AgentStore } from '../../db/agents.js'
import type { StewardRunStore } from '../../db/steward_runs.js'

export interface ActivityEntry {
  id: string
  kind: 'message_in' | 'message_out' | 'agent_started' | 'agent_done' | 'agent_failed' | 'steward_nudge'
  timestamp: string
  summary: string
  detail?: string
}

function withDetail(base: Omit<ActivityEntry, 'detail'>, text: string | undefined | null): ActivityEntry {
  if (text) return { ...base, detail: text.slice(0, 120) }
  return { ...base }
}

export function createActivityRouter(
  messages: MessageStore,
  agents: AgentStore,
  stewardRuns: StewardRunStore,
): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const entries: ActivityEntry[] = []

    // Recent non-injected text messages
    for (const msg of messages.getRecentText(60)) {
      if (msg.kind !== 'text') continue
      entries.push(withDetail(
        {
          id: msg.id,
          kind: msg.role === 'user' ? 'message_in' : 'message_out',
          timestamp: msg.createdAt,
          summary: msg.role === 'user' ? 'Message received' : 'Response sent',
        },
        msg.content,
      ))
    }

    // Recent agents
    for (const agent of agents.getRecent(40)) {
      const label = agent.skillName ? ` (${agent.skillName})` : ''
      if (agent.status === 'completed') {
        entries.push(withDetail(
          { id: `${agent.id}-done`, kind: 'agent_done', timestamp: agent.completedAt ?? agent.updatedAt, summary: `Agent completed${label}` },
          agent.output,
        ))
      } else if (agent.status === 'failed') {
        entries.push(withDetail(
          { id: `${agent.id}-fail`, kind: 'agent_failed', timestamp: agent.updatedAt, summary: `Agent failed${label}` },
          agent.error,
        ))
      }
      entries.push(withDetail(
        { id: `${agent.id}-start`, kind: 'agent_started', timestamp: agent.createdAt, summary: `Agent started${label}` },
        agent.task,
      ))
    }

    // Recent steward runs — only those where at least one steward fired
    for (const run of stewardRuns.getRecent(60)) {
      const fired = run.stewards.filter(j => j.fired)
      if (fired.length === 0) continue
      const names = fired
        .map(j => j.name.replace(/Steward$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
        .join(', ')
      entries.push({ id: run.id, kind: 'steward_nudge', timestamp: run.createdAt, summary: `Steward nudge: ${names}` })
    }

    // Sort newest first, cap at 100
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    res.json({ entries: entries.slice(0, 100) })
  })

  return router
}
