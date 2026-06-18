import { type DatabaseSync, type StatementSync } from './index.js'
import type { DashboardEventBus } from '../dashboard/events.js'

export interface StewardRun {
  id: string
  headId: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
}

interface StewardRunRow {
  id: string
  head_id: string
  stewards: string
  created_at: string
}

function rowToRun(row: StewardRunRow): StewardRun {
  return {
    id: row.id,
    headId: row.head_id,
    stewards: JSON.parse(row.stewards) as Array<{ name: string; ran: boolean; fired: boolean }>,
    createdAt: row.created_at,
  }
}

export class StewardRunStore {
  private stmtInsert: StatementSync
  private stmtGetAll: StatementSync

  constructor(private db: DatabaseSync, private eventBus?: DashboardEventBus) {
    this.stmtInsert = db.prepare(`
      INSERT INTO steward_runs (id, stewards, created_at, head_id)
      VALUES (@id, @stewards, @created_at, @head_id)
    `)

    this.stmtGetAll = db.prepare(`
      SELECT * FROM steward_runs ORDER BY created_at ASC
    `)
  }

  append(run: StewardRun): void {
    this.stmtInsert.run({ id: run.id, stewards: JSON.stringify(run.stewards), created_at: run.createdAt, head_id: run.headId })
    this.eventBus?.emit('dashboard', { type: 'steward_run_added', payload: run })
  }

  getAll(): StewardRun[] {
    return (this.stmtGetAll.all() as unknown as StewardRunRow[]).map(rowToRun)
  }

  /** Returns the N most recent steward runs, newest first.
   *  When headId is provided, only runs belonging to that head are returned.
   *  When omitted, runs across all heads are returned (backward-compatible). */
  getRecent(limit: number, headId?: string): StewardRun[] {
    const rows = headId !== undefined
      ? this.db.prepare('SELECT * FROM steward_runs WHERE head_id = ? ORDER BY created_at DESC LIMIT ?').all(headId, limit) as unknown as StewardRunRow[]
      : this.db.prepare('SELECT * FROM steward_runs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as StewardRunRow[]
    return rows.map(rowToRun)
  }

  clear(): void {
    this.db.prepare('DELETE FROM steward_runs').run()
  }
}
