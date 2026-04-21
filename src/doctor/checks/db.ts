// DB-layer check: can we open the database and bring migrations current?
//
// Reuses the production path (initDb + runMigrations) so a pass here strongly
// implies the daemon will also be able to start its DB.

import type { Check, CheckOutcome, Ctx } from '../types.js'
import { initDb } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'

export const dbCheck: Check = {
  id: 'config.db',
  title: 'database opens and migrations current',
  layer: 'config',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) {
      return { status: 'skip', detail: 'config did not load' }
    }
    let db: ReturnType<typeof initDb> | null = null
    try {
      db = initDb(ctx.config.dbPath)
      runMigrations(db, ctx.config.migrationsDir)
      return { status: 'ok', detail: `opened ${ctx.config.dbPath}; migrations from ${ctx.config.migrationsDir} applied` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'fail',
        detail: msg,
        hint: 'try `npm run migrate` or check dbPath permissions',
      }
    } finally {
      try { db?.close() } catch { /* best-effort */ }
    }
  },
}
