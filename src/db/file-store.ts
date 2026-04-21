import * as fs from 'node:fs'
import * as path from 'node:path'
import { sync as writeFileSync } from 'write-file-atomic'
import { log } from '../logger.js'

// ─── ReadResult ───────────────────────────────────────────────────────────────

export type ReadResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' }
  | { status: 'corrupt'; error: string }

// ─── readJsonFile ─────────────────────────────────────────────────────────────

export function readJsonFile<T>(filePath: string): ReadResult<T> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { status: 'not_found' }
    return { status: 'corrupt', error: String(e.message) }
  }

  // Detect UTF-16 by checking raw buffer BOM bytes
  let buf: Buffer
  try {
    buf = fs.readFileSync(filePath)
  } catch {
    buf = Buffer.alloc(0)
  }
  if (buf.length >= 2) {
    const b0 = buf[0]
    const b1 = buf[1]
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      return { status: 'corrupt', error: 'UTF-16 encoding not supported' }
    }
  }

  // Strip UTF-8 BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  // Normalize line endings
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  try {
    return { status: 'ok', data: JSON.parse(raw) as T }
  } catch (err: unknown) {
    return { status: 'corrupt', error: (err as SyntaxError).message }
  }
}

// ─── writeJsonFile ────────────────────────────────────────────────────────────

export function writeJsonFile(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 })
}

// ─── createFileStore ──────────────────────────────────────────────────────────

export interface FileStore<T extends { id: string }> {
  save(record: T): void
  get(id: string): T | null
  list(): T[]
  delete(id: string): void
  has(id: string): boolean
  count(): number
  clear(): void
}

export function createFileStore<T extends { id: string }>(dir: string): FileStore<T> {
  fs.mkdirSync(dir, { recursive: true })

  function filePath(id: string): string {
    return path.join(dir, `${id}.json`)
  }

  return {
    save(record: T): void {
      writeJsonFile(filePath(record.id), record)
    },

    get(id: string): T | null {
      const result = readJsonFile<T>(filePath(id))
      if (result.status === 'ok') return result.data
      if (result.status === 'not_found') return null
      log.warn(`[file-store] corrupt file ${filePath(id)}: ${result.error}`)
      return null
    },

    list(): T[] {
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return []
      }
      return entries
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => {
          const id = f.slice(0, -5)
          return this.get(id)
        })
        .filter((r): r is T => r !== null)
    },

    delete(id: string): void {
      try {
        fs.unlinkSync(filePath(id))
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw e
      }
    },

    has(id: string): boolean {
      return fs.existsSync(filePath(id))
    },

    count(): number {
      try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length
      } catch {
        return 0
      }
    },

    clear(): void {
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const f of entries.filter(f => f.endsWith('.json'))) {
        try {
          fs.unlinkSync(path.join(dir, f))
        } catch { /* ignore */ }
      }
    },
  }
}
