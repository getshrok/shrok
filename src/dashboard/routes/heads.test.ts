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

// ─── Task 2: POST + DELETE + lazy migration ─────────────────────────────────

interface MutFixture {
  server: Server
  port: number
  workspace: string
  configPath: string
  envFilePath: string
  db: DatabaseSync
  messages: MessageStore
  queue: QueueStore
  /** Lets the test mutate the resolved-heads view that the router sees on the next request. */
  setHeads(next: ResolvedHead[]): void
}

describe('POST/DELETE /api/heads (DASH-03)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-mut-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    let currentHeads = initialHeads
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/heads', createHeadsRouter({
      workspacePath: workspace,
      configPath,
      envFilePath,
      resolveCurrentHeads: () => currentHeads,
      db,
      messages,
      queue,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function post(body: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  async function del(id: string): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${id}`, { method: 'DELETE' })
    return { status: r.status, json: await r.json() }
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(fx.configPath, 'utf8')) as Record<string, unknown>
  }

  function seedMessage(headId: string, id: string): void {
    fx.messages.append({
      kind: 'text', id, role: 'user', content: `m-${id}`, createdAt: new Date().toISOString(),
    } as never, headId)
  }
  function seedQueue(headId: string, id: string): void {
    fx.db.prepare(`INSERT INTO queue_events (id, type, payload, priority, status, head_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(id, 'user_message', JSON.stringify({ type: 'user_message', id, channel: 'x', text: 't', createdAt: '2025-01-01' }), 100, headId)
  }
  function seedAppState(key: string, value: string): void {
    fx.db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(key, value)
  }
  function appStateCount(prefix: string): number {
    return (fx.db.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key LIKE ?").get(`${prefix}:%`) as { n: number }).n
  }
  function queueCount(headId: string): number {
    return (fx.db.prepare("SELECT COUNT(*) AS n FROM queue_events WHERE head_id = ?").get(headId) as { n: number }).n
  }

  // ── POST /api/heads ───────────────────────────────────────────────────────

  it('POST /api/heads creates a head with a valid kebab id and writes config.json heads[]', async () => {
    await start([{ id: 'default', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }] }, null, 2) + '\n')
    const res = await post({ id: 'work' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, head: { id: 'work', channels: [] } })
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
    ])
  })

  it('POST /api/heads rejects BadCase id with 400 (D-13)', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await post({ id: 'BadCase' })
    expect(res.status).toBe(400)
  })

  it('POST /api/heads rejects reserved "default" id with 400 (D-08)', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await post({ id: 'default' })
    expect(res.status).toBe(400)
  })

  it('POST /api/heads rejects duplicate id with 400', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }] }, null, 2) + '\n')
    const res = await post({ id: 'work' })
    expect(res.status).toBe(400)
  })

  it('POST /api/heads rejects missing/non-string id with 400', async () => {
    await start([{ id: 'default', channels: [] }])
    const r1 = await post({})
    expect(r1.status).toBe(400)
    const r2 = await post({ id: 42 })
    expect(r2.status).toBe(400)
  })

  it('POST /api/heads rejects id over 32 chars with 400 (D-13 regex)', async () => {
    await start([{ id: 'default', channels: [] }])
    const longId = 'a' + 'b'.repeat(32) // 33 chars
    const res = await post({ id: longId })
    expect(res.status).toBe(400)
  })

  // ── DELETE /api/heads/:id ─────────────────────────────────────────────────

  it('DELETE /api/heads/:id wipes messages + queue + app_state in one transaction (D-07)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }] }, null, 2) + '\n')

    // Seed state across both heads.
    seedMessage('work', 'mw1')
    seedMessage('work', 'mw2')
    seedMessage('default', 'md1')
    seedQueue('work', 'qw1')
    seedQueue('default', 'qd1')
    seedAppState('work:lastChannel', 'discord')
    seedAppState('work:archivalLock', 'false')
    seedAppState('default:lastChannel', 'telegram')

    const res = await del('work')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true })

    // work data wiped:
    expect(fx.messages.countForHead('work')).toBe(0)
    expect(queueCount('work')).toBe(0)
    expect(appStateCount('work')).toBe(0)
    // default data preserved:
    expect(fx.messages.countForHead('default')).toBe(1)
    expect(queueCount('default')).toBe(1)
    expect(appStateCount('default')).toBe(1)
    // config.json rewritten without 'work':
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([{ id: 'default', channels: [] }])
  })

  it('DELETE /api/heads/default returns 400 (non-deletable per D-08)', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await del('default')
    expect(res.status).toBe(400)
  })

  it('DELETE /api/heads/nonexistent returns 404', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await del('nope')
    expect(res.status).toBe(404)
  })

  // ── D-04 lazy migration ───────────────────────────────────────────────────

  it('lazy migration on first POST: synthesizes default head + strips channel env vars', async () => {
    // Pre-state: legacy single-head deployment — config.json has NO heads[] and
    // .env carries the 12 flat-key channel vars. resolveCurrentHeads returns
    // the synthesized default (mirrors what resolveHeads() does in production).
    await start([{
      id: 'default',
      channels: [
        { id: 'telegram-default', vendor: 'telegram', botToken: 'TG-TOK', chatId: '111' },
      ],
    }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      assistantName: 'Shrok',
      telegramChatId: '111',
      discordChannelId: '222',
    }, null, 2) + '\n')
    fs.writeFileSync(fx.envFilePath, [
      'OPENAI_API_KEY=sk-xxx',
      'TELEGRAM_BOT_TOKEN=TG-TOK',
      'TELEGRAM_CHAT_ID=111',
      'DISCORD_BOT_TOKEN=DC-TOK',
      'DISCORD_CHANNEL_ID=222',
      'SLACK_BOT_TOKEN=SLACK-TOK',
      '',
    ].join('\n'))

    const res = await post({ id: 'work' })
    expect(res.status).toBe(200)

    // config.json now has heads[] (with synthesized default + the new 'work')
    // and the shadowed flat-key fields are gone.
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: unknown[] }>
    expect(heads.map(h => h.id)).toEqual(['default', 'work'])
    expect(heads[0]!.channels).toEqual([
      { id: 'telegram-default', vendor: 'telegram', botToken: 'TG-TOK', chatId: '111' },
    ])
    expect(cfg['telegramChatId']).toBeUndefined()
    expect(cfg['discordChannelId']).toBeUndefined()
    expect(cfg['assistantName']).toBe('Shrok')   // unrelated keys preserved

    // .env had the 12 channel keys stripped.
    const envAfter = fs.readFileSync(fx.envFilePath, 'utf8')
    expect(envAfter).toContain('OPENAI_API_KEY=sk-xxx')
    expect(envAfter).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(envAfter).not.toContain('TELEGRAM_CHAT_ID')
    expect(envAfter).not.toContain('DISCORD_BOT_TOKEN')
    expect(envAfter).not.toContain('DISCORD_CHANNEL_ID')
    expect(envAfter).not.toContain('SLACK_BOT_TOKEN')
  })

  it('lazy migration is idempotent: second mutating POST does not re-strip env vars or re-write config.json contents', async () => {
    // Already-migrated state: heads[] present, .env stripped of channel keys.
    await start([{
      id: 'default',
      channels: [{ id: 'tg-default', vendor: 'telegram', botToken: 'TOK', chatId: '1' }],
    }])
    const seededConfig = {
      heads: [{ id: 'default', channels: [{ id: 'tg-default', vendor: 'telegram', botToken: 'TOK', chatId: '1' }] }],
      assistantName: 'Shrok',
    }
    fs.writeFileSync(fx.configPath, JSON.stringify(seededConfig, null, 2) + '\n')
    fs.writeFileSync(fx.envFilePath, 'OPENAI_API_KEY=sk-xxx\n')
    const envBefore = fs.readFileSync(fx.envFilePath, 'utf8')
    const envMtimeBefore = fs.statSync(fx.envFilePath).mtimeMs
    // Wait long enough that a re-write would change mtimeMs at filesystem resolution
    await new Promise(r => setTimeout(r, 20))

    const res = await post({ id: 'work' })
    expect(res.status).toBe(200)

    const cfgAfter = readConfig()
    const headsAfter = cfgAfter['heads'] as Array<{ id: string; channels: unknown[] }>
    expect(headsAfter[0]).toEqual(seededConfig.heads[0])  // no double-append
    for (const flatKey of ['telegramChatId','discordChannelId','slackChannelId','whatsappAllowedJid','zohoCliqChatId']) {
      expect(cfgAfter[flatKey]).toBeUndefined()
    }
    const envAfter = fs.readFileSync(fx.envFilePath, 'utf8')
    expect(envAfter).toBe(envBefore)                                // byte-identical
    expect(fs.statSync(fx.envFilePath).mtimeMs).toBe(envMtimeBefore) // .env NOT rewritten
  })
})
