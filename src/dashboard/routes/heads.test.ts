import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import * as url from 'node:url'
import type { Server } from 'node:http'
import { createHeadsRouter } from './heads.js'
import { initDb, type DatabaseSync } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'
import { MessageStore } from '../../db/messages.js'
import { QueueStore } from '../../db/queue.js'
import type { ResolvedHead } from '../../config.js'

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

function setupDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

interface Fixture {
  server: Server
  port: number
  workspace: string
  configPath: string
  envFilePath: string
  db: DatabaseSync
  messages: MessageStore
  queue: QueueStore
}

describe('GET /api/heads (DASH-01)', () => {
  let fx: Fixture

  async function start(heads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-ws-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/heads', createHeadsRouter({
      workspacePath: workspace,
      configPath,
      envFilePath,
      resolveCurrentHeads: () => heads,
      db,
      messages,
      queue,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = { server, port, workspace, configPath, envFilePath, db, messages, queue }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function getHeads(): Promise<{ heads: Array<{ id: string; channels: unknown[] }> }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads`)
    expect(r.status).toBe(200)
    return await r.json() as { heads: Array<{ id: string; channels: unknown[] }> }
  }

  it('returns the configured head list as { heads: [{ id, channels }, …] } (multi-head)', async () => {
    await start([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
      { id: 'personal', channels: [] },
    ])
    const body = await getHeads()
    expect(body).toEqual({
      heads: [
        { id: 'default', channels: [] },
        { id: 'work', channels: [] },
        { id: 'personal', channels: [] },
      ],
    })
  })

  it('returns a single { id: "default", channels: [] } entry for single-head deployments', async () => {
    await start([{ id: 'default', channels: [] }])
    const body = await getHeads()
    expect(body).toEqual({ heads: [{ id: 'default', channels: [] }] })
  })

  it('masks secret fields per D-17 — botToken returned as { isSet: true } when set, secret never leaks', async () => {
    await start([
      {
        id: 'work',
        channels: [
          { id: 'tg-work', vendor: 'telegram', botToken: 'SECRET-TOKEN', chatId: '123' },
        ],
      },
    ])
    const body = await getHeads()
    expect(body.heads[0]!.channels[0]).toEqual({
      id: 'tg-work',
      vendor: 'telegram',
      botToken: { isSet: true },
      chatId: '123',
    })
    // Defense-in-depth: secret never leaks through this endpoint
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('SECRET-TOKEN')
  })

  it('GET /api/heads returns { isSet: false } for unset secrets', async () => {
    // The Zod schema requires a non-empty botToken in normal operation, but the
    // mask function must still report isSet:false when the resolved data was
    // produced by tests / synthesis paths that allow an empty string.
    await start([{
      id: 'work',
      channels: [
        { id: 'tg-work', vendor: 'telegram', botToken: '', chatId: '123' } as never,
      ],
    }])
    const body = await getHeads()
    expect(body.heads[0]!.channels[0]).toEqual({
      id: 'tg-work',
      vendor: 'telegram',
      botToken: { isSet: false },
      chatId: '123',
    })
  })

  it('masks all secret fields across every vendor', async () => {
    await start([{
      id: 'multi',
      channels: [
        { id: 'tg', vendor: 'telegram', botToken: 'A', chatId: '1' },
        { id: 'dc', vendor: 'discord',  botToken: 'B', channelId: '2' },
        { id: 'sl', vendor: 'slack',    botToken: 'C', appToken: 'D', channelId: '3' },
        { id: 'wa', vendor: 'whatsapp', allowedJid: 'jid' },
        { id: 'zo', vendor: 'zoho-cliq', clientId: 'E', clientSecret: 'F', refreshToken: 'G', chatId: '4' },
      ],
    }])
    const body = await getHeads()
    const raw = JSON.stringify(body)
    // none of the secret values appear in the response
    for (const v of ['A','B','C','D','E','F','G']) {
      expect(raw).not.toContain(`"${v}"`)
    }
    expect(body.heads[0]!.channels).toHaveLength(5)
  })
})
