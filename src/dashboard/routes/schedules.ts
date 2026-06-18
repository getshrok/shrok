import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { ScheduleStore } from '../../db/schedules.js'
import type { UnifiedLoader } from '../../skills/unified.js'
import { nextRunAfter } from '../../scheduler/cron.js'
import { isValidCadence, CADENCE_ERROR_MESSAGE } from '../../scheduler/cadence.js'
import { generateId } from '../../llm/util.js'

export function createSchedulesRouter(
  scheduleStore: ScheduleStore,
  timezone: string,
  resolveCurrentHeads: () => Array<{ id: string }>,
  unifiedLoader?: UnifiedLoader,
) {
  const router = express.Router()

  // Plan 35-03 D-12: GET returns schedules across all heads, each row carries
  // its headId. scheduleStore.list() (no filter) defaults to cross-head per
  // Plan 35-01 D-01.
  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    res.json({ schedules: scheduleStore.list() })
  })

  router.post('/', requireAuth, (req: Request, res: Response): void => {
    // Plan 35-03 D-11: headId is required on POST and must match a known head.
    // Fail fast at the top of the handler BEFORE any other work — schedules are
    // administrative, the user must know which head the schedule belongs to.
    // Explicitly NOT applying D-FALLBACK-FIRST (Phase 33 /send policy): for
    // admin-surface routes a 404 is the correct signal, not silent fallback.
    const rawHeadId = (req.body as { headId?: unknown }).headId
    if (typeof rawHeadId !== 'string' || !rawHeadId.trim()) {
      res.status(400).json({ error: 'headId is required and must be a non-empty string' })
      return
    }
    const headId = rawHeadId
    const heads = resolveCurrentHeads()
    if (!heads.some(h => h.id === headId)) {
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }

    const { taskName, cron, runAt, conditions, agentContext, relayGuidance } = req.body as {
      taskName?: unknown; cron?: unknown; runAt?: unknown; conditions?: unknown; agentContext?: unknown; relayGuidance?: unknown
    }

    // D-04: validate ack↔nag coupling, floor, and ceiling before any other logic
    const { requiresAck, nagIntervalMinutes } = req.body as { requiresAck?: unknown; nagIntervalMinutes?: unknown }
    const ackBool = requiresAck === true
    const nagNum = typeof nagIntervalMinutes === 'number' ? nagIntervalMinutes : 0

    // Coupling: requiresAck requires a nag interval
    if (ackBool && nagNum === 0) {
      res.status(400).json({ error: 'requiresAck requires a nag interval (minimum 1 minute)' })
      return
    }
    // Coupling: nag without ack
    if (!ackBool && nagNum > 0) {
      res.status(400).json({ error: 'nagIntervalMinutes only applies when requiresAck is true' })
      return
    }
    // Floor: 1 minute (D-03) — catches fractional non-integer values (e.g. 0.5)
    if (ackBool && nagNum > 0 && nagNum < 1) {
      res.status(400).json({ error: 'nag interval must be at least 1 minute' })
      return
    }
    // Integer: nag cadence must be a whole number of minutes (WR-03). Mirrors the
    // create_reminder tool's Number.isInteger guard — the < 1 floor above only
    // catches fractional values in (0,1), so 60.7 etc. would otherwise persist.
    if (typeof nagIntervalMinutes === 'number' && !Number.isInteger(nagIntervalMinutes)) {
      res.status(400).json({ error: 'nagIntervalMinutes must be an integer number of minutes' })
      return
    }
    // Ceiling: 30 days = 43200 minutes
    if (nagNum > 43200) {
      res.status(400).json({ error: 'nag interval must be at most 30 days (43200 minutes)' })
      return
    }

    const rawKind = (req.body as { kind?: unknown }).kind
    if (rawKind !== undefined && rawKind !== 'task' && rawKind !== 'reminder' && rawKind !== 'script') {
      res.status(400).json({ error: "kind must be 'task', 'reminder', or 'script'" })
      return
    }
    const kind: 'task' | 'reminder' | 'script' = rawKind === 'reminder' ? 'reminder' : rawKind === 'script' ? 'script' : 'task'

    // Phase 44 D-08: deliverToHeadIds — task-only, validate shape + known heads, dedupe
    let deliverToHeadIds: string[] | undefined
    if (kind === 'task') {
      const rawDeliverTo = (req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds
      if (rawDeliverTo !== undefined) {
        if (!Array.isArray(rawDeliverTo)) {
          res.status(400).json({ error: 'deliverToHeadIds must be an array of head id strings' })
          return
        }
        const ids = rawDeliverTo as unknown[]
        if (!ids.every(id => typeof id === 'string' && (id as string).trim())) {
          res.status(400).json({ error: 'deliverToHeadIds must contain non-empty strings' })
          return
        }
        const currentHeads = resolveCurrentHeads()
        for (const hid of ids) {
          if (!currentHeads.some(h => h.id === hid)) {
            res.status(404).json({ error: `deliverToHeadIds: head "${hid as string}" not found` })
            return
          }
        }
        const deduped = [...new Set(ids as string[])]
        if (deduped.length > 0) deliverToHeadIds = deduped
      }
    } else if ((req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds !== undefined) {
      // 400 on reminder/script kinds — clearer than silently ignoring (D-08)
      res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
      return
    }

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
    } else if (kind === 'script') {
      // SENSOR-05: script schedules carry the sensor slug in taskName. It is deliberately
      // NOT validated against the tasks loader (it names a sensor, not a task — Plan 01),
      // but it MUST be present: the scheduler reads schedule.taskName as the slug and skips
      // any null row, so a missing slug would silently produce an inoperable schedule.
      if (typeof taskName !== 'string' || !taskName.trim()) {
        res.status(400).json({ error: 'taskName (sensor slug) is required for script schedules' })
        return
      }
    }

    if (!cron && !runAt) {
      res.status(400).json({ error: 'Either cron or runAt is required' })
      return
    }

    let nextRun: string | undefined
    if (typeof cron === 'string' && cron) {
      if (!isValidCadence(cron)) {
        res.status(400).json({ error: CADENCE_ERROR_MESSAGE })
        return
      }
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

    // D-10: startAt override — when cron + startAt provided, set nextRun=startAt (keep cron)
    const startAt = (req.body as { startAt?: unknown }).startAt
    if (typeof startAt === 'string' && startAt && typeof cron === 'string' && cron) {
      const d = new Date(startAt)
      if (isNaN(d.getTime())) {
        res.status(400).json({ error: 'Invalid startAt date' })
        return
      }
      if (d <= new Date()) {
        res.status(400).json({ error: 'startAt must be in the future' })
        return
      }
      nextRun = d.toISOString()  // D-10: override cron-computed nextRun with start date
    }

    // Immediate first run for cron sensors — mirrors the create_schedule tool
    // (registry.ts): fire on the next tick, then follow the cron cadence (the
    // scheduler recomputes nextRun from cron after each fire). A sensor exists to
    // produce ambient output, so it should start right after it's scheduled instead
    // of waiting for the first cron boundary. Skipped when an explicit startAt was
    // given (the operator asked for a specific start).
    if (kind === 'script' && typeof cron === 'string' && cron && !(typeof startAt === 'string' && startAt)) {
      nextRun = new Date().toISOString()
    }

    try {
      // Plan 35-03 D-11: headId comes from the validated req body — schedule
      // belongs to the head the client picked.
      const createOpts: import('../../db/schedules.js').CreateScheduleOptions = { id: generateId('sched'), headId, kind }
      if ((kind === 'task' || kind === 'script') && typeof taskName === 'string') createOpts.taskName = taskName
      if (typeof cron === 'string' && cron) createOpts.cron = cron
      if (typeof runAt === 'string' && runAt) createOpts.runAt = runAt
      if (nextRun !== undefined) createOpts.nextRun = nextRun
      if (typeof conditions === 'string' && conditions) createOpts.conditions = conditions
      if (typeof agentContext === 'string' && agentContext) createOpts.agentContext = agentContext
      if (typeof relayGuidance === 'string' && relayGuidance) createOpts.relayGuidance = relayGuidance
      // D-04: apply validated ack/nag fields
      if (ackBool) createOpts.requiresAck = true
      if (ackBool && nagNum > 0) createOpts.nagIntervalMinutes = nagNum
      // Phase 44 D-08: persist delivery set (task-only, already validated + deduped above)
      if (deliverToHeadIds !== undefined) createOpts.deliverToHeadIds = deliverToHeadIds
      const schedule = scheduleStore.create(createOpts)
      res.json({ schedule })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.patch('/:id', requireAuth, (req: Request, res: Response): void => {
    const { id } = req.params as { id: string }
    // Plan 35-03 D-13: schedules cannot be reassigned to a different head via
    // PATCH. Reject at the top before any patch construction so the on-disk row
    // is provably untouched. To move a schedule between heads, delete and
    // recreate. Mirrors agent-side D-10 update_schedule reject from Plan 35-02.
    // Check value (not just key presence): JSON.stringify drops undefined props
    // anyway, and in-process callers that idiomatically construct bodies with
    // `headId: undefined` should not trip this guard — only a real reassignment
    // attempt (defined value) should 400.
    const bodyObj = (req.body !== null && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {}
    if (bodyObj['headId'] !== undefined) {
      res.status(400).json({ error: 'headId cannot be reassigned via PATCH. To move a schedule to a different head, delete and recreate.' })
      return
    }
    const { enabled, cron, runAt, conditions, agentContext, relayGuidance } = req.body as {
      enabled?: unknown; cron?: unknown; runAt?: unknown;
      conditions?: unknown; agentContext?: unknown; relayGuidance?: unknown
    }

    const patch: Parameters<typeof scheduleStore.update>[1] = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (typeof cron === 'string' && cron) patch.cron = cron
    if (typeof runAt === 'string') {
      if (!runAt) {
        res.status(400).json({ error: 'runAt cannot be empty (use cron to make a schedule recurring, or send a valid ISO timestamp)' })
        return
      }
      if (isNaN(new Date(runAt).getTime())) {
        res.status(400).json({ error: 'Invalid runAt date' })
        return
      }
      patch.runAt = runAt
      patch.nextRun = new Date(runAt).toISOString()
    }
    if (typeof conditions === 'string') patch.conditions = conditions
    if (typeof agentContext === 'string') patch.agentContext = agentContext
    if (typeof relayGuidance === 'string') patch.relayGuidance = relayGuidance

    // Recompute nextRun if cron changed (overrides runAt-derived nextRun if both sent)
    if (typeof cron === 'string' && cron) {
      if (!isValidCadence(cron)) {
        res.status(400).json({ error: CADENCE_ERROR_MESSAGE })
        return
      }
      try {
        // WR-02 (consistency): honor the schedule's own cronTimezone override here
        // too, mirroring the D-12 ack-off recompute below.
        const existingForTz = scheduleStore.get(id)
        patch.nextRun = nextRunAfter(cron, new Date(), existingForTz?.cronTimezone ?? timezone).toISOString()
      } catch {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
    }

    // D-11: requiresAck/nagIntervalMinutes editable via PATCH with same coupling/floor/ceiling validation
    const { requiresAck: patchRequiresAck, nagIntervalMinutes: patchNagInterval } = bodyObj as {
      requiresAck?: unknown; nagIntervalMinutes?: unknown
    }

    if (typeof patchRequiresAck === 'boolean') {
      const patchNag = typeof patchNagInterval === 'number' ? patchNagInterval : 0
      // Integer guard (WR-03): reject fractional nag cadences before any other
      // nag logic, matching the POST handler and the create_reminder tool.
      if (typeof patchNagInterval === 'number' && !Number.isInteger(patchNagInterval)) {
        res.status(400).json({ error: 'nagIntervalMinutes must be an integer number of minutes' })
        return
      }
      if (patchRequiresAck && patchNag === 0) {
        res.status(400).json({ error: 'requiresAck requires a nag interval (minimum 1 minute)' })
        return
      }
      if (patchRequiresAck && patchNag > 0 && patchNag < 1) {
        res.status(400).json({ error: 'nag interval must be at least 1 minute' })
        return
      }
      if (patchNag > 43200) {
        res.status(400).json({ error: 'nag interval must be at most 30 days (43200 minutes)' })
        return
      }
      patch.requiresAck = patchRequiresAck
      if (patchRequiresAck) {
        patch.nagIntervalMinutes = patchNag > 0 ? patchNag : null
      } else {
        // D-12: turning ack off — clear nag, and if ackPending clear that + recompute nextRun
        patch.nagIntervalMinutes = null
        const existing = scheduleStore.get(id)
        if (existing?.ackPending) {
          patch.ackPending = false
          if (existing.cron) {
            // WR-02: recompute in the schedule's own timezone, not the workspace
            // default — a per-schedule cronTimezone override must be honored or the
            // first post-ack fire shifts by the UTC offset.
            patch.nextRun = nextRunAfter(existing.cron, new Date(), existing.cronTimezone ?? timezone).toISOString()
          } else if (existing.runAt !== null && existing.runAt > new Date().toISOString()) {
            // One-time reminder whose runAt is still in the future: re-arm it.
            patch.nextRun = existing.runAt
          } else {
            // WR-04: a one-time reminder that already fired and is nagging has a
            // past runAt. Restoring it as nextRun would make getDue() match
            // (nextRun <= now) and re-fire on the next poll instead of going
            // quiet. Clear nextRun so the delivered reminder stops firing.
            patch.nextRun = null
          }
        }
      }
    } else if (typeof patchNagInterval === 'number') {
      // D-04 standalone-nag coupling guard (direct-API path where requiresAck is ABSENT from body):
      // read the existing row to check stored requiresAck before applying a bare nag patch
      const existing = scheduleStore.get(id)
      const patchNag = patchNagInterval
      // Integer guard (WR-03): reject fractional nag cadences on the bare-nag path too.
      if (!Number.isInteger(patchNag)) {
        res.status(400).json({ error: 'nagIntervalMinutes must be an integer number of minutes' })
        return
      }
      if (patchNag > 43200) {
        res.status(400).json({ error: 'nag interval must be at most 30 days (43200 minutes)' })
        return
      }
      if (existing?.requiresAck === true && patchNag < 1) {
        res.status(400).json({ error: 'requiresAck requires a nag interval (minimum 1 minute)' })
        return
      }
      patch.nagIntervalMinutes = patchNag
    }

    // Phase 44 D-08: delivery set is editable via PATCH (unlike headId, which is banned D-13).
    // Use !== undefined (not key-presence) — mirrors the D-13 headId guard rationale so
    // in-process callers with { deliverToHeadIds: undefined } don't accidentally trip this.
    const rawDeliverTo = bodyObj['deliverToHeadIds']
    if (rawDeliverTo !== undefined) {
      const existing = scheduleStore.get(id)
      if (!existing) { res.status(404).json({ error: 'Not found' }); return }
      if (existing.kind !== 'task') {
        res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
        return
      }
      if (!Array.isArray(rawDeliverTo) || !(rawDeliverTo as unknown[]).every(x => typeof x === 'string' && (x as string).trim())) {
        res.status(400).json({ error: 'deliverToHeadIds must be an array of non-empty head id strings' })
        return
      }
      const ids = rawDeliverTo as string[]
      const currentHeads = resolveCurrentHeads()
      for (const hid of ids) {
        if (!currentHeads.some(h => h.id === hid)) {
          res.status(404).json({ error: `deliverToHeadIds: head "${hid}" not found` })
          return
        }
      }
      patch.deliverToHeadIds = [...new Set(ids)]  // empty array = cleared (owner-only after store.update)
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
