/**
 * Standalone migration runner. Used by setup.ts and useful for CI.
 * Exits 0 on success, 1 on failure.
 */

import { loadConfig } from '../src/config.js'
import { initDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

const cfg = loadConfig()
const db = initDb(cfg.dbPath)
runMigrations(db, cfg.migrationsDir)
db.close()
console.log('migrations complete')
