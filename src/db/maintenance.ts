import { log } from '../logger.js'
import type { DatabaseSync } from './index.js'

/**
 * Prune stale rows from tables that grow unboundedly, then VACUUM the DB.
 * Called once at startup — before the activation loop starts — so VACUUM
 * does not block live writes.
 *
 * Retention policy:
 *   usage        — 90 days  (circuit-breaker only needs today; 90 days is generous for review)
 *   agents       — 30 days  after completion/failure (history JSON can be large)
 *   queue_events — 7 days   after done/failed (no value after processing)
 *
 * messages is intentionally excluded — archival already deletes them when they
 * are moved to topic memory; touching that table here would be redundant.
 */
export function pruneOldData(db: DatabaseSync, retentionDays = { usage: 90, agents: 30, queue: 7 }): void {
  const deleted = {
    usage: 0,
    agents: 0,
    queue: 0,
  }

  try {
    const r1 = db.prepare(
      `DELETE FROM usage WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(retentionDays.usage) as { changes: number }
    deleted.usage = r1.changes
  } catch (err) {
    log.warn('[maintenance] Failed to prune usage table:', (err as Error).message)
  }

  try {
    const r2 = db.prepare(
      `DELETE FROM agents
       WHERE status IN ('completed', 'failed', 'retracted')
         AND COALESCE(completed_at, created_at) < datetime('now', '-' || ? || ' days')`
    ).run(retentionDays.agents) as { changes: number }
    deleted.agents = r2.changes
  } catch (err) {
    log.warn('[maintenance] Failed to prune agents table:', (err as Error).message)
  }

  try {
    const r3 = db.prepare(
      `DELETE FROM queue_events
       WHERE status IN ('done', 'failed')
         AND processed_at < datetime('now', '-' || ? || ' days')`
    ).run(retentionDays.queue) as { changes: number }
    deleted.queue = r3.changes
  } catch (err) {
    log.warn('[maintenance] Failed to prune queue_events table:', (err as Error).message)
  }

  const totalDeleted = deleted.usage + deleted.agents + deleted.queue
  if (totalDeleted > 0) {
    log.info(`[maintenance] Pruned ${deleted.usage} usage, ${deleted.agents} agent, ${deleted.queue} queue rows`)
    try {
      db.exec('VACUUM')
      log.info('[maintenance] VACUUM complete')
    } catch (err) {
      log.warn('[maintenance] VACUUM failed:', (err as Error).message)
    }
  }
}
