import { type DatabaseSync, type StatementSync } from './index.js'
import type { DashboardEventBus } from '../dashboard/events.js'

export interface StewardRun {
  id: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
}

interface StewardRunRow {
  id: string
  stewards: string
  created_at: string
}

function rowToRun(row: StewardRunRow): StewardRun {
  return {
    id: row.id,
    stewards: JSON.parse(row.stewards) as Array<{ name: string; ran: boolean; fired: boolean }>,
    createdAt: row.created_at,
  }
}

export class StewardRunStore {
  private stmtInsert: StatementSync
  private stmtGetAll: StatementSync

  constructor(private db: DatabaseSync, private eventBus?: DashboardEventBus) {
    this.stmtInsert = db.prepare(`
      INSERT INTO steward_runs (id, stewards, created_at)
      VALUES (@id, @stewards, @created_at)
    `)

    this.stmtGetAll = db.prepare(`
      SELECT * FROM steward_runs ORDER BY created_at ASC
    `)
  }

  append(run: StewardRun): void {
    this.stmtInsert.run({ id: run.id, stewards: JSON.stringify(run.stewards), created_at: run.createdAt })
    this.eventBus?.emit('dashboard', { type: 'steward_run_added', payload: run })
  }

  getAll(): StewardRun[] {
    return (this.stmtGetAll.all() as unknown as StewardRunRow[]).map(rowToRun)
  }

  /** Returns the N most recent steward runs, newest first. */
  getRecent(limit: number): StewardRun[] {
    return (this.db.prepare('SELECT * FROM steward_runs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as StewardRunRow[]).map(rowToRun)
  }

  clear(): void {
    this.db.prepare('DELETE FROM steward_runs').run()
  }
}
