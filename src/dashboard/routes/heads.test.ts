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
import { ScheduleStore } from '../../db/schedules.js'
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
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
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

  // Issue #12: GET returns customPrompt when the head has one
  it('GET /api/heads returns customPrompt for a head that has one', async () => {
    await start([
      { id: 'work', channels: [], customPrompt: 'Be concise.' },
      { id: 'default', channels: [] },
    ])
    const body = await getHeads() as { heads: Array<{ id: string; channels: unknown[]; customPrompt?: string }> }
    const workHead = body.heads.find(h => h.id === 'work')
    expect(workHead?.customPrompt).toBe('Be concise.')
    const defaultHead = body.heads.find(h => h.id === 'default')
    expect('customPrompt' in (defaultHead ?? {})).toBe(false)
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
  /** Plan 35-03 D-16: the same ScheduleStore the router uses for cascade-delete. Tests need a handle to seed schedules before issuing DELETE. */
  scheduleStore: ScheduleStore
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
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
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

  // ── Plan 35-03 D-16/D-17: DELETE cascade to schedules + reminders ──────────

  it('DELETE /api/heads/:id cascades to schedules + reminders and returns counts in body', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }] }, null, 2) + '\n')

    // Seed 'work' with 2 tasks + 1 reminder
    fx.scheduleStore.create({ id: 'w-t1', headId: 'work', kind: 'task', taskName: 't1', runAt: '2026-01-01T00:00:00Z' })
    fx.scheduleStore.create({ id: 'w-t2', headId: 'work', kind: 'task', taskName: 't2', runAt: '2026-01-02T00:00:00Z' })
    fx.scheduleStore.create({ id: 'w-r1', headId: 'work', kind: 'reminder', agentContext: 'r1', runAt: '2026-01-03T00:00:00Z' })
    // Seed 'default' with 1 task — must NOT be cascaded
    fx.scheduleStore.create({ id: 'd-t1', headId: 'default', kind: 'task', taskName: 't1', runAt: '2026-01-04T00:00:00Z' })

    const res = await del('work')
    expect(res.status).toBe(200)
    // D-17: response body carries split counts in addition to legacy { ok: true }
    expect(res.json).toEqual({ ok: true, deletedSchedules: 2, deletedReminders: 1 })

    // Disk state: 'work' wiped, 'default' preserved.
    const remaining = fx.scheduleStore.list()
    expect(remaining.map(s => s.id)).toEqual(['d-t1'])
  })

  it('DELETE /api/heads/:id with zero schedules returns zero counts (D-17)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'fresh', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }, { id: 'fresh', channels: [] }] }, null, 2) + '\n')

    const res = await del('fresh')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, deletedSchedules: 0, deletedReminders: 0 })
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

// ─── Task 3: PATCH /api/heads/:id rename (3-table atomic UPDATE) ────────────

describe('PATCH /api/heads/:id (DASH-03 rename, D-14)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-patch-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
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
  function appStateValue(key: string): string | undefined {
    const row = fx.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value
  }
  function queueCount(headId: string): number {
    return (fx.db.prepare("SELECT COUNT(*) AS n FROM queue_events WHERE head_id = ?").get(headId) as { n: number }).n
  }

  it('PATCH /api/heads/:id renames the head and atomically migrates 3 tables (D-14)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    // Seed state under 'work' (and a sibling under 'default' that must NOT change).
    seedMessage('work', 'mw1')
    seedMessage('work', 'mw2')
    seedMessage('default', 'md1')
    seedQueue('work', 'qw1')
    seedQueue('default', 'qd1')
    seedAppState('work:lastChannel', 'discord')
    seedAppState('work:archivalLock', 'false')
    seedAppState('default:lastChannel', 'telegram')

    const res = await patch('work', { newId: 'work-new' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, head: { id: 'work-new' } })

    // messages migrated:
    expect(fx.messages.countForHead('work-new')).toBe(2)
    expect(fx.messages.countForHead('work')).toBe(0)
    // queue_events migrated:
    expect(queueCount('work-new')).toBe(1)
    expect(queueCount('work')).toBe(0)
    // app_state keys re-prefixed (substr-anchored, not REPLACE):
    expect(appStateValue('work-new:lastChannel')).toBe('discord')
    expect(appStateValue('work-new:archivalLock')).toBe('false')
    expect(appStateValue('work:lastChannel')).toBeUndefined()
    expect(appStateValue('work:archivalLock')).toBeUndefined()
    // Sibling head untouched:
    expect(fx.messages.countForHead('default')).toBe(1)
    expect(queueCount('default')).toBe(1)
    expect(appStateValue('default:lastChannel')).toBe('telegram')
    // config.json rewritten:
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([
      { id: 'default', channels: [] },
      { id: 'work-new', channels: [] },
    ])
  })

  it('PATCH rejects invalid newId regex with 400 (D-13)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    const res = await patch('work', { newId: 'BadCase' })
    expect(res.status).toBe(400)
  })

  it('PATCH rejects newId that matches an existing head with 400', async () => {
    await start([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
      { id: 'home', channels: [] },
    ])
    const res = await patch('work', { newId: 'home' })
    expect(res.status).toBe(400)
  })

  it('PATCH rejects newId "default" with 400 (reserved)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    const res = await patch('work', { newId: 'default' })
    expect(res.status).toBe(400)
  })

  it('PATCH rejects renaming "default" with 400 (mirrors DELETE policy, D-08)', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await patch('default', { newId: 'whatever' })
    expect(res.status).toBe(400)
  })

  it('PATCH returns 404 for unknown head', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await patch('nope', { newId: 'still-nope' })
    expect(res.status).toBe(404)
  })

  it('PATCH rejects missing/non-string newId with 400', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    const r1 = await patch('work', {})
    expect(r1.status).toBe(400)
    const r2 = await patch('work', { newId: 42 })
    expect(r2.status).toBe(400)
  })

  it('PATCH with newId === oldId is a no-op success', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')
    seedMessage('work', 'm1')
    const res = await patch('work', { newId: 'work' })
    expect(res.status).toBe(200)
    expect(fx.messages.countForHead('work')).toBe(1)
  })

  it('PATCH rollback: when third UPDATE fails, messages and queue_events stay at old head_id', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')
    seedMessage('work', 'm1')
    seedQueue('work', 'qw1')
    seedAppState('work:lastChannel', 'discord')

    // Inject a failure into the third (app_state) UPDATE by monkey-patching
    // db.prepare to throw when it sees the substr-anchored rename SQL.
    const origPrepare = fx.db.prepare.bind(fx.db)
    let appStateCalls = 0
    ;(fx.db as unknown as { prepare: typeof origPrepare }).prepare = ((sql: string) => {
      if (sql.includes('UPDATE app_state SET key')) {
        appStateCalls += 1
        return {
          run: () => { throw new Error('forced rollback') },
        } as never
      }
      return origPrepare(sql)
    }) as never

    const res = await patch('work', { newId: 'work-new' })
    // Restore prepare before any further assertions touch the db.
    ;(fx.db as unknown as { prepare: typeof origPrepare }).prepare = origPrepare

    // The third statement was invoked at least once, and the request did NOT succeed.
    expect(appStateCalls).toBeGreaterThan(0)
    expect(res.status).not.toBe(200)

    // ROLLBACK: messages and queue_events stay under 'work', not migrated.
    expect(fx.messages.countForHead('work')).toBe(1)
    expect(fx.messages.countForHead('work-new')).toBe(0)
    expect(queueCount('work')).toBe(1)
    expect(queueCount('work-new')).toBe(0)
    // app_state untouched too.
    expect(appStateValue('work:lastChannel')).toBe('discord')
    expect(appStateValue('work-new:lastChannel')).toBeUndefined()
  })

  // Issue #12: customPrompt independent of rename
  it('PATCH with only { customPrompt } persists it without requiring newId', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { customPrompt: 'Be brief.' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; customPrompt?: string }>
    const workHead = heads.find(h => h.id === 'work')
    expect(workHead?.customPrompt).toBe('Be brief.')
    // id must be unchanged
    expect(workHead?.id).toBe('work')
  })

  it('PATCH with only { newId } still renames and does not require customPrompt', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { newId: 'work-renamed' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string }>
    expect(heads.find(h => h.id === 'work-renamed')).toBeDefined()
    expect(heads.find(h => h.id === 'work')).toBeUndefined()
  })

  it('PATCH with { customPrompt: "" } persists empty string (explicit clear)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { customPrompt: '' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; customPrompt?: string }>
    const workHead = heads.find(h => h.id === 'work')
    expect(workHead?.customPrompt).toBe('')
  })

  it('PATCH /api/heads/default with customPrompt-only body is allowed (renaming reserved, but customPrompt is not)', async () => {
    await start([{ id: 'default', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('default', { customPrompt: 'Global default instructions.' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; customPrompt?: string }>
    const defaultHead = heads.find(h => h.id === 'default')
    expect(defaultHead?.customPrompt).toBe('Global default instructions.')
  })
})

// ─── Plan 33-05 Task 1: POST /api/heads/:id/channels ────────────────────────

describe('POST /api/heads/:id/channels (DASH-04 add channel)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-postch-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function postChannel(headId: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${headId}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(fx.configPath, 'utf8')) as Record<string, unknown>
  }

  function telegramFixture(id = 'tg-work', chatId = '123', botToken = 'BOT-TOKEN'): {
    id: string; vendor: 'telegram'; botToken: string; chatId: string
  } {
    return { id, vendor: 'telegram', botToken, chatId }
  }

  it('POST /api/heads/:id/channels adds a channel and returns masked', async () => {
    await start([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
    ])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await postChannel('work', telegramFixture('tg-work', '123', 'BOT-TOKEN'))
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      channel: {
        id: 'tg-work',
        vendor: 'telegram',
        botToken: { isSet: true },
        chatId: '123',
      },
    })
    // Response body must NOT leak the plaintext secret
    const raw = JSON.stringify(res.json)
    expect(raw).not.toContain('BOT-TOKEN')

    // The plaintext IS persisted to disk (D-18 inline channels in config.json)
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    const workHead = heads.find(h => h.id === 'work')!
    expect(workHead.channels).toHaveLength(1)
    expect(workHead.channels[0]).toEqual({
      id: 'tg-work', vendor: 'telegram', botToken: 'BOT-TOKEN', chatId: '123',
    })
  })

  it('POST rejects duplicate channel id on the SAME head with 400', async () => {
    await start([
      { id: 'work', channels: [{ id: 'tg-work', vendor: 'telegram', botToken: 'TOK', chatId: '1' }] },
    ])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'work', channels: [{ id: 'tg-work', vendor: 'telegram', botToken: 'TOK', chatId: '1' }] }],
    }, null, 2) + '\n')

    const res = await postChannel('work', telegramFixture('tg-work', '2', 'TOK2'))
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/already in use/)
  })

  it('POST rejects duplicate channel id on a DIFFERENT head with 400 (D-15 cross-head uniqueness)', async () => {
    await start([
      { id: 'work', channels: [{ id: 'tg-shared', vendor: 'telegram', botToken: 'TOK', chatId: '1' }] },
      { id: 'home', channels: [] },
    ])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [
        { id: 'work', channels: [{ id: 'tg-shared', vendor: 'telegram', botToken: 'TOK', chatId: '1' }] },
        { id: 'home', channels: [] },
      ],
    }, null, 2) + '\n')

    const res = await postChannel('home', telegramFixture('tg-shared', '2', 'TOK2'))
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/already in use/)
  })

  it('POST rejects bad-case channel id with 400 (kebab regex)', async () => {
    await start([{ id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'work', channels: [] }] }, null, 2) + '\n')

    const res = await postChannel('work', telegramFixture('BadCase'))
    expect(res.status).toBe(400)
  })

  it('POST rejects invalid ChannelConfig shape with 400', async () => {
    await start([{ id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'work', channels: [] }] }, null, 2) + '\n')

    // Missing chatId — Zod's discriminated union should reject this
    const res = await postChannel('work', { id: 'tg-work', vendor: 'telegram', botToken: 'TOK' })
    expect(res.status).toBe(400)
  })

  it('POST returns 404 for nonexistent head', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await postChannel('ghost', telegramFixture('tg-ghost'))
    expect(res.status).toBe(404)
  })

  it('POST adds a SECOND telegram channel to the same head (DASH-04 multi-of-same-vendor)', async () => {
    await start([
      { id: 'work', channels: [{ id: 'tg-work', vendor: 'telegram', botToken: 'TOK1', chatId: '111' }] },
    ])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'work', channels: [{ id: 'tg-work', vendor: 'telegram', botToken: 'TOK1', chatId: '111' }] }],
    }, null, 2) + '\n')

    const res = await postChannel('work', telegramFixture('tg-work-2', '222', 'TOK2'))
    expect(res.status).toBe(200)
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    const workHead = heads.find(h => h.id === 'work')!
    expect(workHead.channels).toHaveLength(2)
    expect(workHead.channels.map(c => c['id'])).toEqual(['tg-work', 'tg-work-2'])
  })

  it('POST response masks secrets — botToken returned as { isSet: true }', async () => {
    await start([{ id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'work', channels: [] }] }, null, 2) + '\n')

    const res = await postChannel('work', telegramFixture('tg-work', '123', 'SUPER-SECRET'))
    expect(res.status).toBe(200)
    const body = res.json as { channel: Record<string, unknown> }
    expect(body.channel['botToken']).toEqual({ isSet: true })
    expect(JSON.stringify(body)).not.toContain('SUPER-SECRET')
  })
})

// ─── Plan 33-05 Task 2: PATCH + DELETE /api/heads/:id/channels/:channelId ──

describe('PATCH/DELETE /api/heads/:id/channels/:channelId (DASH-04 edit + remove)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-chedit-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function patchChannel(headId: string, channelId: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${headId}/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  async function deleteChannel(headId: string, channelId: string): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${headId}/channels/${channelId}`, {
      method: 'DELETE',
    })
    return { status: r.status, json: await r.json() }
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(fx.configPath, 'utf8')) as Record<string, unknown>
  }

  function seedWork(): void {
    const work = {
      id: 'work',
      channels: [{ id: 'tg-work', vendor: 'telegram' as const, botToken: 'ORIGINAL-TOKEN', chatId: '123' }],
    }
    fx.setHeads([work])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [work] }, null, 2) + '\n')
  }

  // ── PATCH /:id/channels/:channelId ──────────────────────────────────────────

  it('PATCH preserves botToken when client omits the field (D-17 secret preservation)', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'tg-work', { chatId: '999' })
    expect(res.status).toBe(200)
    // Response masks the secret — still { isSet: true }
    const body = res.json as { channel: Record<string, unknown> }
    expect(body.channel['botToken']).toEqual({ isSet: true })
    expect(body.channel['chatId']).toBe('999')
    // Disk: botToken preserved, chatId updated
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    expect(heads[0]!.channels[0]).toEqual({
      id: 'tg-work', vendor: 'telegram', botToken: 'ORIGINAL-TOKEN', chatId: '999',
    })
  })

  it('PATCH updates botToken when client sends a new value', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'tg-work', { botToken: 'NEW-TOKEN' })
    expect(res.status).toBe(200)
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    expect(heads[0]!.channels[0]!['botToken']).toBe('NEW-TOKEN')
    expect(heads[0]!.channels[0]!['chatId']).toBe('123') // preserved
    // Response does NOT leak the new token
    expect(JSON.stringify(res.json)).not.toContain('NEW-TOKEN')
  })

  it('PATCH rejects vendor change with 400 (discriminated-union invariant)', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'tg-work', { vendor: 'discord', channelId: 'X' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/vendor cannot change/)
  })

  it('PATCH rejects invalid Zod shape with 400 (empty chatId)', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'tg-work', { chatId: '' })
    expect(res.status).toBe(400)
  })

  it('PATCH returns 404 for nonexistent channel', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'ghost', { chatId: '9' })
    expect(res.status).toBe(404)
  })

  it('PATCH returns 404 for nonexistent head', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await patchChannel('ghost', 'tg-work', { chatId: '9' })
    expect(res.status).toBe(404)
  })

  it('PATCH renames a channel; cross-head uniqueness excludes self', async () => {
    const work = {
      id: 'work',
      channels: [{ id: 'tg-work', vendor: 'telegram' as const, botToken: 'TOK', chatId: '1' }],
    }
    const home = {
      id: 'home',
      channels: [{ id: 'tg-home', vendor: 'telegram' as const, botToken: 'TOK2', chatId: '2' }],
    }
    await start([work, home])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [work, home] }, null, 2) + '\n')
    const res = await patchChannel('work', 'tg-work', { id: 'tg-work-renamed' })
    expect(res.status).toBe(200)
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    const workHead = heads.find(h => h.id === 'work')!
    expect(workHead.channels[0]!['id']).toBe('tg-work-renamed')
    // Sibling channel on home untouched
    const homeHead = heads.find(h => h.id === 'home')!
    expect(homeHead.channels[0]!['id']).toBe('tg-home')
  })

  it('PATCH rename to an ID used on another head returns 400', async () => {
    const work = {
      id: 'work',
      channels: [{ id: 'tg-work', vendor: 'telegram' as const, botToken: 'TOK', chatId: '1' }],
    }
    const home = {
      id: 'home',
      channels: [{ id: 'tg-home', vendor: 'telegram' as const, botToken: 'TOK2', chatId: '2' }],
    }
    await start([work, home])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [work, home] }, null, 2) + '\n')
    const res = await patchChannel('work', 'tg-work', { id: 'tg-home' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/already in use/)
  })

  it('PATCH rejects rename to a non-kebab id with 400', async () => {
    await start([])
    seedWork()
    const res = await patchChannel('work', 'tg-work', { id: 'BadCase' })
    expect(res.status).toBe(400)
  })

  // ── DELETE /:id/channels/:channelId ─────────────────────────────────────────

  it('DELETE removes the channel from config.json', async () => {
    const work = {
      id: 'work',
      channels: [
        { id: 'tg-work', vendor: 'telegram' as const, botToken: 'TOK', chatId: '1' },
        { id: 'dc-work', vendor: 'discord' as const, botToken: 'TOK2', channelId: 'C' },
      ],
    }
    await start([work])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [work] }, null, 2) + '\n')
    const res = await deleteChannel('work', 'tg-work')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true })
    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; channels: Array<Record<string, unknown>> }>
    expect(heads[0]!.channels).toHaveLength(1)
    expect(heads[0]!.channels[0]!['id']).toBe('dc-work')
  })

  it('DELETE returns 404 for missing channel', async () => {
    await start([])
    seedWork()
    const res = await deleteChannel('work', 'ghost-channel')
    expect(res.status).toBe(404)
  })

  it('DELETE returns 404 for missing head', async () => {
    await start([{ id: 'default', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({ heads: [{ id: 'default', channels: [] }] }, null, 2) + '\n')
    const res = await deleteChannel('ghost-head', 'tg-anything')
    expect(res.status).toBe(404)
  })
})

// ─── Plan 33-07: GET /api/heads/:id/counts + DELETE confirmId guard (D-06) ──

describe('GET /api/heads/:id/counts + DELETE confirmId (D-06 typed-confirmation)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-counts-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function getCounts(id: string): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${id}/counts`)
    return { status: r.status, json: await r.json() }
  }

  async function delWithBody(id: string, body: unknown | undefined): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = { method: 'DELETE' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${id}`, init)
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

  // ── GET /api/heads/:id/counts ────────────────────────────────────────────

  it('GET /api/heads/:id/counts returns message + queue + channel counts', async () => {
    await start([{
      id: 'work',
      channels: [
        { id: 'tg-work', vendor: 'telegram', botToken: 'TOK', chatId: '1' },
        { id: 'dc-work', vendor: 'discord', botToken: 'TOK2', channelId: 'C' },
      ],
    }])
    seedMessage('work', 'mw1')
    seedMessage('work', 'mw2')
    seedMessage('work', 'mw3')
    seedQueue('work', 'qw1')
    // Sibling-head data must NOT count toward 'work'.
    seedMessage('default', 'md1')
    seedQueue('default', 'qd1')

    const res = await getCounts('work')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ messages: 3, queueEvents: 1, channels: 2 })
  })

  it('GET /api/heads/:id/counts returns 404 for nonexistent head', async () => {
    await start([{ id: 'default', channels: [] }])
    const res = await getCounts('nonexistent')
    expect(res.status).toBe(404)
  })

  it('GET /api/heads/:id/counts returns zeros for a head with no data', async () => {
    await start([{ id: 'fresh', channels: [] }])
    const res = await getCounts('fresh')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ messages: 0, queueEvents: 0, channels: 0 })
  })

  // ── DELETE confirmId guard ───────────────────────────────────────────────

  it('DELETE /api/heads/:id with matching confirmId succeeds', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await delWithBody('work', { confirmId: 'work' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true })
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([{ id: 'default', channels: [] }])
  })

  it('DELETE /api/heads/:id with mismatched confirmId returns 400 and does NOT delete', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')
    seedMessage('work', 'mw1')

    const res = await delWithBody('work', { confirmId: 'mismatch' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/confirmId does not match/)
    // Head NOT deleted — still in config + data preserved.
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
    ])
    expect(fx.messages.countForHead('work')).toBe(1)
  })

  it('DELETE /api/heads/:id with no body still succeeds (backward compat)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await delWithBody('work', undefined)
    expect(res.status).toBe(200)
    const cfg = readConfig()
    expect(cfg['heads']).toEqual([{ id: 'default', channels: [] }])
  })
})

// ─── Plan 46-03 Task 2: PATCH tri-state tool overrides (TOOLCFG-03/04/09) ───

describe('PATCH /api/heads/:id tool overrides (TOOLCFG-03/04/09)', () => {
  let fx: MutFixture

  async function start(initialHeads: ResolvedHead[]): Promise<void> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-route-tooloverride-'))
    const configPath = path.join(workspace, 'config.json')
    const envFilePath = path.join(workspace, '.env')
    const db = setupDb()
    const messages = new MessageStore(db)
    const queue = new QueueStore(db)
    const scheduleStore = new ScheduleStore(path.join(workspace, 'schedules'))
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
      scheduleStore,
    }))
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = {
      server, port, workspace, configPath, envFilePath, db, messages, queue, scheduleStore,
      setHeads: (next) => { currentHeads = next },
    }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    if (fx?.workspace) fs.rmSync(fx.workspace, { recursive: true, force: true })
  })

  async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  async function getHeads(): Promise<unknown> {
    const r = await fetch(`http://127.0.0.1:${fx.port}/api/heads`)
    return r.json()
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(fx.configPath, 'utf8')) as Record<string, unknown>
  }

  it('PATCH with agentToolsOverride array persists the array into config.json heads[]', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { agentToolsOverride: ['bash', 'read_file'] })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, head: { id: 'work', agentToolsOverride: ['bash', 'read_file'] } })

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; agentToolsOverride?: unknown }>
    const workHead = heads.find(h => h.id === 'work')
    expect(workHead?.agentToolsOverride).toEqual(['bash', 'read_file'])
  })

  it('PATCH with headToolsOverride: null persists null (all tools)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    // Pre-seed with an existing override to show null replaces it
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [], headToolsOverride: ['spawn_agent'] }],
    }, null, 2) + '\n')

    const res = await patch('work', { headToolsOverride: null })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, head: { id: 'work', headToolsOverride: null } })

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; headToolsOverride?: unknown }>
    const workHead = heads.find(h => h.id === 'work')
    // null must be written verbatim (not dropped)
    expect('headToolsOverride' in (workHead as object)).toBe(true)
    expect(workHead?.headToolsOverride).toBeNull()
  })

  it('PATCH with headToolsOverride: "__inherit__" removes the key from config.json (reset to inherit)', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    // Pre-seed with an existing override
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [], headToolsOverride: ['spawn_agent'] }],
    }, null, 2) + '\n')

    const res = await patch('work', { headToolsOverride: '__inherit__' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; headToolsOverride?: unknown }>
    const workHead = heads.find(h => h.id === 'work')
    // Key must be ABSENT (not present-as-null or present-as-undefined)
    expect('headToolsOverride' in (workHead as object)).toBe(false)
  })

  it('PATCH with agentToolsOverride: "__inherit__" removes the agentToolsOverride key', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [], agentToolsOverride: ['bash'] }],
    }, null, 2) + '\n')

    const res = await patch('work', { agentToolsOverride: '__inherit__' })
    expect(res.status).toBe(200)

    const cfg = readConfig()
    const heads = cfg['heads'] as Array<{ id: string; agentToolsOverride?: unknown }>
    const workHead = heads.find(h => h.id === 'work')
    expect('agentToolsOverride' in (workHead as object)).toBe(false)
  })

  it('PATCH with a non-array, non-null, non-sentinel value returns 400', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { headToolsOverride: 42 })
    expect(res.status).toBe(400)
  })

  it('PATCH with agentToolsOverride containing non-strings returns 400', async () => {
    await start([{ id: 'default', channels: [] }, { id: 'work', channels: [] }])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [{ id: 'default', channels: [] }, { id: 'work', channels: [] }],
    }, null, 2) + '\n')

    const res = await patch('work', { agentToolsOverride: [42, 'bash'] })
    expect(res.status).toBe(400)
  })

  it('GET /api/heads reflects a previously-set headToolsOverride on the head', async () => {
    await start([
      { id: 'default', channels: [] },
      { id: 'work', channels: [], headToolsOverride: ['spawn_agent', 'message_agent'] },
    ])
    fs.writeFileSync(fx.configPath, JSON.stringify({
      heads: [
        { id: 'default', channels: [] },
        { id: 'work', channels: [], headToolsOverride: ['spawn_agent', 'message_agent'] },
      ],
    }, null, 2) + '\n')

    const body = await getHeads() as { heads: Array<{ id: string; headToolsOverride?: unknown }> }
    const workHead = body.heads.find(h => h.id === 'work')
    expect(workHead?.headToolsOverride).toEqual(['spawn_agent', 'message_agent'])
    // default head has no override key — must be absent
    const defaultHead = body.heads.find(h => h.id === 'default')
    expect('headToolsOverride' in (defaultHead as object)).toBe(false)
  })
})
