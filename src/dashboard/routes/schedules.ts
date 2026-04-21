import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { ScheduleStore } from '../../db/schedules.js'
import type { UnifiedLoader } from '../../skills/unified.js'
import { nextRunAfter } from '../../scheduler/cron.js'
import { generateId } from '../../llm/util.js'

export function createSchedulesRouter(scheduleStore: ScheduleStore, timezone: string, unifiedLoader?: UnifiedLoader) {
  const router = express.Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({ schedules: scheduleStore.list() })
  })

  router.post('/', requireAuth, (req: Request, res: Response): void => {
    const { taskName, cron, runAt, conditions, agentContext } = req.body as {
      taskName?: unknown; cron?: unknown; runAt?: unknown; conditions?: unknown; agentContext?: unknown
    }

    const rawKind = (req.body as { kind?: unknown }).kind
    if (rawKind !== undefined && rawKind !== 'task' && rawKind !== 'reminder') {
      res.status(400).json({ error: "kind must be 'task' or 'reminder'" })
      return
    }
    const kind: 'task' | 'reminder' = rawKind === 'reminder' ? 'reminder' : 'task'

    if (kind === 'task') {
      if (typeof taskName !== 'string' || !taskName.trim()) {
        res.status(400).json({ error: 'taskName is required for task schedules' })
        return
      }
      if (unifiedLoader) {
        const resolved = unifiedLoader.tasksLoader.load(taskName)
        if (!resolved) {
          res.status(400).json({ error: `Unknown task: ${taskName}` })
          return
        }
      }
    }

    if (!cron && !runAt) {
      res.status(400).json({ error: 'Either cron or runAt is required' })
      return
    }

    let nextRun: string | undefined
    if (typeof cron === 'string' && cron) {
      try {
        nextRun = nextRunAfter(cron, new Date(), timezone).toISOString()
      } catch {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
    } else if (typeof runAt === 'string' && runAt) {
      if (isNaN(new Date(runAt).getTime())) {
        res.status(400).json({ error: 'Invalid runAt date' })
        return
      }
      nextRun = new Date(runAt).toISOString()
    }

    try {
      const createOpts: import('../../db/schedules.js').CreateScheduleOptions = { id: generateId('sched'), kind }
      if (kind === 'task' && typeof taskName === 'string') createOpts.taskName = taskName
      if (typeof cron === 'string' && cron) createOpts.cron = cron
      if (typeof runAt === 'string' && runAt) createOpts.runAt = runAt
      if (nextRun !== undefined) createOpts.nextRun = nextRun
      if (typeof conditions === 'string' && conditions) createOpts.conditions = conditions
      if (typeof agentContext === 'string' && agentContext) createOpts.agentContext = agentContext
      const schedule = scheduleStore.create(createOpts)
      res.json({ schedule })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.patch('/:id', requireAuth, (req: Request, res: Response): void => {
    const { id } = req.params as { id: string }
    const { enabled, cron, runAt, conditions, agentContext } = req.body as {
      enabled?: unknown; cron?: unknown; runAt?: unknown;
      conditions?: unknown; agentContext?: unknown
    }

    const patch: Parameters<typeof scheduleStore.update>[1] = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (typeof cron === 'string') patch.cron = cron
    if (typeof runAt === 'string') {
      if (runAt && isNaN(new Date(runAt).getTime())) {
        res.status(400).json({ error: 'Invalid runAt date' })
        return
      }
      patch.runAt = runAt
      if (runAt) patch.nextRun = new Date(runAt).toISOString()
    }
    if (typeof conditions === 'string') patch.conditions = conditions
    if (typeof agentContext === 'string') patch.agentContext = agentContext

    // Recompute nextRun if cron changed (overrides runAt-derived nextRun if both sent)
    if (typeof cron === 'string' && cron) {
      try {
        patch.nextRun = nextRunAfter(cron, new Date(), timezone).toISOString()
      } catch {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
    }

    const schedule = scheduleStore.update(id, patch)
    if (!schedule) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ schedule })
  })

  router.delete('/:id', requireAuth, (req: Request, res: Response): void => {
    const { id } = req.params as { id: string }
    scheduleStore.delete(id)
    res.json({ ok: true })
  })

  return router
}
