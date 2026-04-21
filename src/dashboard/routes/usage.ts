import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { UsageStore, BySourceRow } from '../../db/usage.js'
import type { AppStateStore } from '../../db/app_state.js'
import type { DashboardEventBus } from '../events.js'
import type { UnifiedLoader } from '../../skills/unified.js'
import { dayStartUtc, daysAgoStart } from '../../period.js'
import { validateCreateThreshold, validateUpdateThreshold, enrichThresholds } from '../../usage-threshold.js'

function toSqliteUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

export function createUsageRouter(
  usage: UsageStore,
  tz: string,
  appState?: AppStateStore,
  events?: DashboardEventBus,
  unifiedLoader?: UnifiedLoader,
): Router {
  const router = Router()

  // Decorate scheduled rows with kind (skill|task). Tasks take precedence on
  // collision per spec — probe tasks first, then skills. Loader optional so
  // fixtures that don't wire it still work (kind stays undefined).
  const decorateBySource = (rows: BySourceRow[]): BySourceRow[] => rows.map(row => {
    if (row.bucket !== 'scheduled_agent' || !unifiedLoader) return row
    const task = unifiedLoader.tasksLoader.load(row.name)
    if (task) {
      const cap = task.frontmatter['max-per-month-usd']
      return { ...row, kind: 'task' as const, ...(cap != null ? { maxPerMonthUsd: cap } : {}) }
    }
    const skill = unifiedLoader.skillsLoader.load(row.name)
    if (skill) return { ...row, kind: 'skill' as const }
    return row
  })

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const todaySince = dayStartUtc(tz)
    const weekSince  = daysAgoStart(tz, 6)
    const monthSince = daysAgoStart(tz, 29)

    const today   = usage.getSummary(toSqliteUtc(todaySince))
    const week    = usage.getSummary(toSqliteUtc(weekSince))
    const month   = usage.getSummary(toSqliteUtc(monthSince))
    const allTime = usage.getSummary()

    const cacheToday   = usage.getCacheSummary(toSqliteUtc(todaySince))
    const cacheWeek    = usage.getCacheSummary(toSqliteUtc(weekSince))
    const cacheMonth   = usage.getCacheSummary(toSqliteUtc(monthSince))
    const cacheAllTime = usage.getCacheSummary()

    // Per-period trend: today=1 day, week=7, month=30, allTime=full history.
    const trendToday   = usage.getDailyTrend(todaySince)
    const trendWeek    = usage.getDailyTrend(weekSince)
    const trendMonth   = usage.getDailyTrend(monthSince)
    // For allTime the cheapest "since" is epoch — getDailyTrend bins server-side.
    const trendAllTime = usage.getDailyTrend(new Date(0))

    const perEvent = usage.getAllEventSummaries()

    type CacheStats = { cacheReadTokens: number; cacheWriteTokens: number; totalInputTokens: number }
    const buildPeriod = (s: typeof today, trend: ReturnType<typeof usage.getDailyTrend>, cache: CacheStats) => ({
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      byModel: s.byModel,
      bySource: decorateBySource(s.bySource),
      trend,
      cache: {
        readTokens: cache.cacheReadTokens,
        writeTokens: cache.cacheWriteTokens,
        totalInputTokens: cache.totalInputTokens,
      },
    })

    res.json({
      periods: {
        today:   buildPeriod(today,   trendToday,   cacheToday),
        week:    buildPeriod(week,    trendWeek,    cacheWeek),
        month:   buildPeriod(month,   trendMonth,   cacheMonth),
        allTime: buildPeriod(allTime, trendAllTime, cacheAllTime),
      },
      // Back-compat fields (consumers reading top-level shapes — drop in v2).
      byModel: month.byModel,
      bySourceType: month.bySourceType,
      bySource: decorateBySource(month.bySource),
      trend: trendMonth,
      perEvent,
    })
  })

  // ─── Thresholds ──────────────────────────────────────────────────────────
  // Conditionally registered when appState is provided. In production wiring
  // (server.ts) appState is always passed; the guard is for fixtures that
  // construct the router without it.
  if (appState) {
    router.get('/thresholds', requireAuth, (_req: Request, res: Response): void => {
      const enriched = enrichThresholds(
        appState.getThresholds(),
        (since) => usage.getCostSince(since),
        new Date(),
        tz,
      )
      res.json({ thresholds: enriched })
    })

    router.post('/thresholds', requireAuth, (req: Request, res: Response): void => {
      const result = validateCreateThreshold(req.body)
      if (!result.ok) { res.status(400).json({ error: result.error }); return }
      const threshold = appState.addThreshold(result.value)
      // Emit AFTER the storage call: if addThreshold throws, no event fires
      // and the client never thinks state changed. Don't reorder for symmetry.
      events?.emit('dashboard', { type: 'thresholds_changed' })
      res.json({ threshold })
    })

    router.patch('/thresholds/:id', requireAuth, (req: Request, res: Response): void => {
      const { id } = req.params as { id: string }
      const result = validateUpdateThreshold(req.body)
      if (!result.ok) { res.status(400).json({ error: result.error }); return }
      // Note: AppStateStore.updateThreshold already clears fired-state when
      // the period changes (task 5). Don't add duplicate clearing here.
      const updated = appState.updateThreshold(id, result.value)
      if (!updated) { res.status(404).json({ error: 'Threshold not found' }); return }
      events?.emit('dashboard', { type: 'thresholds_changed' })
      res.json({ threshold: updated })
    })

    router.delete('/thresholds/:id', requireAuth, (req: Request, res: Response): void => {
      const { id } = req.params as { id: string }
      const found = appState.deleteThreshold(id)
      if (!found) { res.status(404).json({ error: 'Threshold not found' }); return }
      events?.emit('dashboard', { type: 'thresholds_changed' })
      res.json({ ok: true })
    })
  }

  return router
}
