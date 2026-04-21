import { type DatabaseSync, type StatementSync } from './index.js'
import { periodStart, makeLocalYmdFormatter } from '../period.js'

export interface EventUsageSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
}

export interface UsageEntry {
  sourceType: 'head' | 'agent' | 'curator' | 'archival'
  sourceId: string | null   // queue_event.id for head; agent.id for agent; null otherwise
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number    // pre-computed at record time
  /** Prompt-cache token counts. See sql/027_usage_cache_tokens.sql. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Denormalized from the agents row so scheduled-task spend self-describes
   *  without needing the agents JOIN. See sql/026_usage_attribution.sql. */
  trigger?: 'scheduled' | 'manual' | 'ad_hoc'
  /** Semantic "target name" — the skill-or-task name (NOT the slug label). */
  targetName?: string
}

interface UsageRow {
  id: string
  source_type: string
  source_id: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: string
}

function rowToEntry(row: UsageRow): UsageEntry {
  return {
    sourceType: row.source_type as UsageEntry['sourceType'],
    sourceId: row.source_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  }
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  byModel: Record<string, { input: number; output: number }>
}

export type BySourceBucket = 'head' | 'curator' | 'archival' | 'manual_agents' | 'scheduled_agent'

export interface BySourceRow {
  bucket: BySourceBucket
  name: string
  kind?: 'skill' | 'task'
  trigger?: 'scheduled' | 'manual' | 'ad_hoc' | 'unknown'
  inputTokens: number
  outputTokens: number
  costUsd: number
  maxPerMonthUsd?: number
}

export interface UsageSummaryFull {
  inputTokens: number
  outputTokens: number
  costUsd: number
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  bySourceType: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  bySource: BySourceRow[]
}

export interface UsageTrendDay {
  day: string
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export class UsageStore {
  private stmtRecord: StatementSync
  private stmtGetBySource: StatementSync
  private stmtSummarize: StatementSync
  private stmtSummarizeSince: StatementSync
  private stmtSummarizeBySourceType: StatementSync
  private stmtSummarizeBySourceTypeSince: StatementSync
  private stmtAllHeadEventUsage: StatementSync
  private stmtCostSince: StatementSync
  private stmtSummaryByModel: StatementSync
  private stmtSummaryByModelSince: StatementSync
  private stmtSummaryBySourceTypeCost: StatementSync
  private stmtSummaryBySourceTypeCostSince: StatementSync
  private stmtSummaryAgentByTriggerSkill: StatementSync
  private stmtSummaryAgentByTriggerSkillSince: StatementSync
  private stmtTrendRows: StatementSync
  private stmtCacheStats: StatementSync
  private stmtCacheStatsSince: StatementSync
  private stmtTaskMonthlySpend: StatementSync

  constructor(db: DatabaseSync, private timezone: string) {
    this.stmtRecord = db.prepare(`
      INSERT INTO usage (id, source_type, source_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_write_tokens, trigger, target_name)
      VALUES (@id, @source_type, @source_id, @model, @input_tokens, @output_tokens, @cost_usd, @cache_read_tokens, @cache_write_tokens, @trigger, @target_name)
    `)

    this.stmtGetBySource = db.prepare(
      'SELECT * FROM usage WHERE source_type = ? AND source_id IS ? ORDER BY created_at ASC'
    )

    this.stmtSummarize = db.prepare(
      'SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage GROUP BY model'
    )

    this.stmtSummarizeSince = db.prepare(
      'SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage WHERE created_at >= ? GROUP BY model'
    )

    this.stmtSummarizeBySourceType = db.prepare(
      'SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage WHERE source_type = ?'
    )

    this.stmtSummarizeBySourceTypeSince = db.prepare(
      'SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage WHERE source_type = ? AND created_at >= ?'
    )

    this.stmtAllHeadEventUsage = db.prepare(
      'SELECT source_id, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage WHERE source_type = \'head\' AND source_id IS NOT NULL GROUP BY source_id, model'
    )

    this.stmtCostSince = db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE created_at >= ?'
    )

    this.stmtSummaryByModel = db.prepare(
      'SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage GROUP BY model'
    )

    this.stmtSummaryByModelSince = db.prepare(
      'SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage WHERE created_at >= ? GROUP BY model'
    )

    this.stmtSummaryBySourceTypeCost = db.prepare(
      'SELECT source_type, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage GROUP BY source_type'
    )

    this.stmtSummaryBySourceTypeCostSince = db.prepare(
      'SELECT source_type, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage WHERE created_at >= ? GROUP BY source_type'
    )

    this.stmtSummaryAgentByTriggerSkill = db.prepare(
      `SELECT COALESCE(u.trigger, a.trigger, 'unknown') AS trigger,
              COALESCE(u.target_name, a.skill_name)     AS target_name,
              SUM(u.input_tokens)  AS input,
              SUM(u.output_tokens) AS output,
              SUM(u.cost_usd)      AS cost
       FROM usage u
       LEFT JOIN agents a ON u.source_id = a.id
       WHERE u.source_type = 'agent'
       GROUP BY COALESCE(u.trigger, a.trigger, 'unknown'),
                COALESCE(u.target_name, a.skill_name)`
    )

    this.stmtSummaryAgentByTriggerSkillSince = db.prepare(
      `SELECT COALESCE(u.trigger, a.trigger, 'unknown') AS trigger,
              COALESCE(u.target_name, a.skill_name)     AS target_name,
              SUM(u.input_tokens)  AS input,
              SUM(u.output_tokens) AS output,
              SUM(u.cost_usd)      AS cost
       FROM usage u
       LEFT JOIN agents a ON u.source_id = a.id
       WHERE u.source_type = 'agent' AND u.created_at >= ?
       GROUP BY COALESCE(u.trigger, a.trigger, 'unknown'),
                COALESCE(u.target_name, a.skill_name)`
    )

    this.stmtTrendRows = db.prepare(
      'SELECT created_at, cost_usd AS cost, input_tokens AS input, output_tokens AS output FROM usage WHERE created_at >= ? ORDER BY created_at'
    )

    this.stmtCacheStats = db.prepare(
      'SELECT COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(input_tokens), 0) AS total_input FROM usage'
    )

    this.stmtCacheStatsSince = db.prepare(
      'SELECT COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(input_tokens), 0) AS total_input FROM usage WHERE created_at >= ?'
    )

    this.stmtTaskMonthlySpend = db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE target_name = ? AND created_at >= ?'
    )
  }

  record(entry: UsageEntry): void {
    const id = `usage_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    this.stmtRecord.run({
      id,
      source_type: entry.sourceType,
      source_id: entry.sourceId,
      model: entry.model,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cost_usd: entry.costUsd,
      cache_read_tokens: entry.cacheReadTokens ?? 0,
      cache_write_tokens: entry.cacheWriteTokens ?? 0,
      trigger: entry.trigger ?? null,
      target_name: entry.targetName ?? null,
    })
  }

  getBySource(sourceType: UsageEntry['sourceType'], sourceId: string | null): UsageEntry[] {
    return (this.stmtGetBySource.all(sourceType, sourceId) as unknown as UsageRow[]).map(rowToEntry)
  }

  getBySourceType(sourceType: UsageEntry['sourceType'], since?: string): { inputTokens: number; outputTokens: number } {
    const row = since
      ? this.stmtSummarizeBySourceTypeSince.get(sourceType, since) as unknown as { input: number | null; output: number | null } | undefined
      : this.stmtSummarizeBySourceType.get(sourceType) as unknown as { input: number | null; output: number | null } | undefined
    return { inputTokens: row?.input ?? 0, outputTokens: row?.output ?? 0 }
  }

  /** Returns actual USD cost for all usage since the given UTC instant. */
  getCostSince(since: Date): number {
    // SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' (space, no Z).
    const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19)
    const row = this.stmtCostSince.get(sinceStr) as unknown as { total: number }
    return row.total ?? 0
  }

  /** Returns actual USD cost for all usage since local midnight today (in the configured `timezone`). */
  getEstimatedCostToday(): number {
    return this.getCostSince(periodStart(this.timezone, 'day'))
  }

  /** Returns a map of event.id → cost summary for all head activations. Single query, no N+1. */
  getAllEventSummaries(): Record<string, EventUsageSummary> {
    const rows = this.stmtAllHeadEventUsage.all() as unknown as { source_id: string; model: string; input: number; output: number; cost: number }[]
    const byEvent: Record<string, { byModel: Record<string, { input: number; output: number; cost: number }>; inputTokens: number; outputTokens: number; costUsd: number }> = {}
    for (const row of rows) {
      const e = (byEvent[row.source_id] ??= { byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0 })
      e.byModel[row.model] = { input: row.input, output: row.output, cost: row.cost }
      e.inputTokens += row.input
      e.outputTokens += row.output
      e.costUsd += row.cost
    }
    const result: Record<string, EventUsageSummary> = {}
    for (const [eventId, data] of Object.entries(byEvent)) {
      const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {}
      for (const [model, t] of Object.entries(data.byModel)) {
        byModel[model] = { inputTokens: t.input, outputTokens: t.output, costUsd: t.cost }
      }
      result[eventId] = {
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        costUsd: data.costUsd,
        byModel,
      }
    }
    return result
  }

  summarize(since?: string): UsageSummary {
    const rows = since
      ? this.stmtSummarizeSince.all(since) as unknown as { model: string; input: number; output: number; cost: number }[]
      : this.stmtSummarize.all() as unknown as { model: string; input: number; output: number; cost: number }[]

    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0
    const byModel: Record<string, { input: number; output: number }> = {}

    for (const row of rows) {
      totalInput += row.input
      totalOutput += row.output
      totalCost += row.cost ?? 0
      byModel[row.model] = { input: row.input, output: row.output }
    }

    return { inputTokens: totalInput, outputTokens: totalOutput, costUsd: totalCost, byModel }
  }

  getSummary(since?: string): UsageSummaryFull {
    type ModelRow = { model: string; input: number; output: number; cost: number }
    type SourceRow = { source_type: string; input: number; output: number; cost: number }

    const modelRows = (since
      ? this.stmtSummaryByModelSince.all(since)
      : this.stmtSummaryByModel.all()) as unknown as ModelRow[]

    const sourceRows = (since
      ? this.stmtSummaryBySourceTypeCostSince.all(since)
      : this.stmtSummaryBySourceTypeCost.all()) as unknown as SourceRow[]

    let totalInput = 0, totalOutput = 0, totalCost = 0
    const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {}
    for (const r of modelRows) {
      totalInput += r.input
      totalOutput += r.output
      totalCost += r.cost ?? 0
      byModel[r.model] = { inputTokens: r.input, outputTokens: r.output, costUsd: r.cost ?? 0 }
    }

    const bySourceType: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {}
    for (const r of sourceRows) {
      bySourceType[r.source_type] = { inputTokens: r.input, outputTokens: r.output, costUsd: r.cost ?? 0 }
    }

    // ─── bySource: per-bucket ranked list ─────────────────────────────────
    type AgentRow = { trigger: string; target_name: string | null; input: number; output: number; cost: number }
    const agentRows = (since
      ? this.stmtSummaryAgentByTriggerSkillSince.all(since)
      : this.stmtSummaryAgentByTriggerSkill.all()) as unknown as AgentRow[]

    const bySource: BySourceRow[] = []

    // Seed head/curator/archival from bySourceType. Skip the legacy 'agent'
    // row — it's replaced by the per-bucket breakdown below.
    for (const bucket of ['head', 'curator', 'archival'] as const) {
      const st = bySourceType[bucket]
      if (!st || (st.inputTokens === 0 && st.outputTokens === 0 && st.costUsd === 0)) continue
      bySource.push({
        bucket,
        name: bucket,
        inputTokens: st.inputTokens,
        outputTokens: st.outputTokens,
        costUsd: st.costUsd,
      })
    }

    // Walk agent rows. scheduled + non-null target_name → per-target_name row;
    // everything else → single manual_agents bucket.
    const scheduledBySkill = new Map<string, { input: number; output: number; cost: number }>()
    let manualInput = 0, manualOutput = 0, manualCost = 0
    let hasManual = false
    for (const r of agentRows) {
      if (r.trigger === 'scheduled' && r.target_name) {
        const acc = scheduledBySkill.get(r.target_name) ?? { input: 0, output: 0, cost: 0 }
        acc.input += r.input
        acc.output += r.output
        acc.cost += r.cost ?? 0
        scheduledBySkill.set(r.target_name, acc)
      } else {
        hasManual = true
        manualInput += r.input
        manualOutput += r.output
        manualCost += r.cost ?? 0
      }
    }
    if (hasManual) {
      bySource.push({
        bucket: 'manual_agents',
        name: 'manual_agents',
        inputTokens: manualInput,
        outputTokens: manualOutput,
        costUsd: manualCost,
      })
    }
    for (const [skillName, acc] of scheduledBySkill) {
      bySource.push({
        bucket: 'scheduled_agent',
        name: skillName,
        trigger: 'scheduled',
        inputTokens: acc.input,
        outputTokens: acc.output,
        costUsd: acc.cost,
      })
    }

    bySource.sort((a, b) => b.costUsd - a.costUsd)

    return { inputTokens: totalInput, outputTokens: totalOutput, costUsd: totalCost, byModel, bySourceType, bySource }
  }

  getDailyTrend(since: Date): UsageTrendDay[] {
    const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19)
    type Row = { created_at: string; cost: number; input: number; output: number }
    const rows = this.stmtTrendRows.all(sinceStr) as unknown as Row[]

    // Build the formatter ONCE — Intl.DateTimeFormat construction is 10–100µs,
    // and we'd otherwise pay that for every row in the window.
    const formatDay = makeLocalYmdFormatter(this.timezone)

    const byDay = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>()
    for (const r of rows) {
      // SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC (no Z). Append Z to parse.
      const day = formatDay(new Date(r.created_at + 'Z'))
      let acc = byDay.get(day)
      if (!acc) {
        acc = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
        byDay.set(day, acc)
      }
      acc.costUsd += r.cost ?? 0
      acc.inputTokens += r.input
      acc.outputTokens += r.output
    }

    return Array.from(byDay, ([day, sums]) => ({ day, ...sums }))
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  /** Returns total USD spent by the given task (target_name) since the first day of the current UTC month. */
  getTaskMonthlySpend(targetName: string): number {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const sinceStr = monthStart.toISOString().replace('T', ' ').slice(0, 19)
    const row = this.stmtTaskMonthlySpend.get(targetName, sinceStr) as unknown as { total: number }
    return row.total ?? 0
  }

  getCacheSummary(since?: string): { cacheReadTokens: number; cacheWriteTokens: number; totalInputTokens: number } {
    type Row = { cache_read: number; cache_write: number; total_input: number }
    const row = (since
      ? this.stmtCacheStatsSince.get(since)
      : this.stmtCacheStats.get()) as unknown as Row
    return {
      cacheReadTokens: row.cache_read,
      cacheWriteTokens: row.cache_write,
      totalInputTokens: row.total_input,
    }
  }
}
