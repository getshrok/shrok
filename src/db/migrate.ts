import * as fs from 'node:fs'
import * as path from 'node:path'
import { type DatabaseSync, transaction } from './index.js'

export function runMigrations(db: DatabaseSync, migrationsDir: string): void {
  // Ensure the migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set<string>(
    (db.prepare('SELECT filename FROM _migrations').all() as unknown as { filename: string }[])
      .map(r => r.filename)
  )

  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d+.*\.sql$/.test(f))
    .sort()

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (filename) VALUES (?)'
  )

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    transaction(db, () => {
      db.exec(sql)
      insertMigration.run(file)
    })
  }
}
