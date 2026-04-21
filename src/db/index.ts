import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'

export { DatabaseSync, StatementSync }

export function initDb(path: string): DatabaseSync {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** Run fn inside a BEGIN/COMMIT transaction; rolls back on throw. */
export function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
