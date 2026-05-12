import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import * as url from 'node:url'
import type { Server } from 'node:http'
import { createMessagesRouter } from './messages.js'
import { MessageStore } from '../../db/messages.js'
import { initDb } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../sql')

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

/**
 * Seed a text message directly with a specific head_id.
 * MessageStore.append() always writes head_id='default' (SQL DEFAULT — Plan 02 will add
 * the multi-head write path). For test seeding we use raw SQL INSERT matching the
 * established pattern in src/db/db.test.ts insertWithHead().
 */
function seedMessage(db: ReturnType<typeof initDb>, id: string, content: string, headId: string): void {
  db.prepare(
    "INSERT INTO messages (id, kind, role, content, injected, head_id, created_at) VALUES (?, 'text', 'user', ?, 0, ?, ?)"
  ).run(id, content, headId, new Date().toISOString())
}

describe('GET /api/messages — head-scoped filtering (DASH-02)', () => {
  let workspace: string
  let server: Server
  let port: number
  let store: MessageStore

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'messages-route-ws-'))
    const dbPath = path.join(workspace, 'shrok.db')
    const db = initDb(dbPath)
    runMigrations(db, MIGRATIONS_DIR)  // includes 005_multi_head which adds head_id column
    store = new MessageStore(db)

    // Seed: one message under each head via raw SQL (MessageStore.append() hardcodes
    // head_id='default'; head-stamped writes are introduced by Plan 02)
    seedMessage(db, 'msg-default', 'hello from default head', 'default')
    seedMessage(db, 'msg-work', 'hello from work head', 'work')

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/messages', createMessagesRouter(store))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  async function listMessages(query: string = ''): Promise<{ messages: Array<{ content?: string }> }> {
    const r = await fetch(`http://127.0.0.1:${port}/api/messages${query}`)
    expect(r.status).toBe(200)
    return await r.json() as { messages: Array<{ content?: string }> }
  }

  it('GET /api/messages?head=work returns only the work head message (D-05)', async () => {
    const body = await listMessages('?head=work')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.content).toBe('hello from work head')
  })

  it('GET /api/messages?head=default returns only the default head message', async () => {
    const body = await listMessages('?head=default')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.content).toBe('hello from default head')
  })

  it('GET /api/messages with no query param defaults to head=default (backward compat per D-05)', async () => {
    const body = await listMessages()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.content).toBe('hello from default head')
  })

  it('GET /api/messages?head=nonexistent returns an empty list, not the default-head messages', async () => {
    const body = await listMessages('?head=nonexistent')
    expect(body.messages).toEqual([])
  })

  it('repeated ?head=a&head=b query (Express parses as array) is rejected via type guard, defaulting to default head', async () => {
    // Per RESEARCH §Security Domain: typeof req.query['head'] === 'string' is the required guard.
    // When head is an array, it must NOT be passed to getAll() — fall back to 'default'.
    const body = await listMessages('?head=a&head=b')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.content).toBe('hello from default head')
  })
})
