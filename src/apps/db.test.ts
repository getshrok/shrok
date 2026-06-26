// src/apps/db.test.ts
// Tests for the HOST/test-facing per-app node:sqlite helper (D-03, D-11a).
// Apps do NOT import db.ts — they open their own node:sqlite via import.meta.url.
// This helper is for the host + tests to open an app's DB by path.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { appDb } from './db.js'

describe('appDb', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function makeTmpAppDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-appdb-test-'))
    tmpDirs.push(d)
    return d
  }

  it('returns the same DatabaseSync instance for the same (appDir, name)', () => {
    const appDir = makeTmpAppDir()
    const db1 = appDb(appDir, 'data')
    const db2 = appDb(appDir, 'data')
    expect(db1).toBe(db2)
  })

  it('creates a different instance for a different appDir', () => {
    const dir1 = makeTmpAppDir()
    const dir2 = makeTmpAppDir()
    const db1 = appDb(dir1, 'data')
    const db2 = appDb(dir2, 'data')
    expect(db1).not.toBe(db2)
  })

  it('co-locates the sqlite file inside the appDir', () => {
    const appDir = makeTmpAppDir()
    appDb(appDir, 'data')
    expect(fs.existsSync(path.join(appDir, 'data.sqlite'))).toBe(true)
  })

  it('sqlite file is inside the appDir (not somewhere else)', () => {
    const appDir = makeTmpAppDir()
    appDb(appDir, 'notes')
    expect(fs.existsSync(path.join(appDir, 'notes.sqlite'))).toBe(true)
  })

  it('throws on an invalid name containing path separators', () => {
    const appDir = makeTmpAppDir()
    expect(() => appDb(appDir, '../evil')).toThrow('Invalid app name')
  })

  it('throws on a name with spaces', () => {
    const appDir = makeTmpAppDir()
    expect(() => appDb(appDir, 'has space')).toThrow('Invalid app name')
  })

  it('throws on an empty name', () => {
    const appDir = makeTmpAppDir()
    expect(() => appDb(appDir, '')).toThrow('Invalid app name')
  })

  it('accepts valid names: alphanumeric, hyphens, underscores', () => {
    const appDir = makeTmpAppDir()
    expect(() => appDb(appDir, 'data')).not.toThrow()
    expect(() => appDb(appDir, 'my-notes')).not.toThrow()
    expect(() => appDb(appDir, 'My_DB')).not.toThrow()
  })
})
