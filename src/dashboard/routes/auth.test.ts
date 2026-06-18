import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createAuthRouter } from './auth.js'
import { TokenStore } from '../auth.js'
import type { Config } from '../../config.js'

// bcrypt hash of 'testpassword' (10 rounds) — same fixture as auth.test.ts
const PW = 'testpassword'
const PW_HASH = '$2b$10$a5llDz4NfLmJxaPABRldiuWQZRpVMRSlYLWCxW92yruHV2ravYCWq'
// bcrypt hash of 'backuppass' (10 rounds) — backup-password fixture
const BACKUP_PW = 'backuppass'
const BACKUP_PW_HASH = '$2b$10$6agTDnqM3Lpzn4EF6DtPe.8oycRI4EWIIKrq8.B1t4fwL6zOto4zi'

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

let server: Server | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server) { await new Promise<void>(r => server!.close(() => r())); server = undefined }
  if (workspace) { fs.rmSync(workspace, { recursive: true, force: true }); workspace = undefined }
})

/** Spin up an auth router whose config.json carries the given dashboard users. */
async function start(users: string[], backupHash?: string): Promise<number> {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-route-ws-'))
  fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ dashboardUsers: users }), 'utf8')
  const config = { workspacePath: workspace, dashboardPasswordHash: PW_HASH, dashboardHttps: false } as Config
  if (backupHash) config.dashboardBackupPasswordHash = backupHash
  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter(new TokenStore(), config))
  const port = await getFreePort()
  await new Promise<void>((resolve, reject) => {
    server = app.listen(port, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })
  return port
}

async function login(port: number, body: Record<string, unknown>): Promise<{ status: number; setCookie: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, setCookie: r.headers.get('set-cookie') }
}

describe('POST /api/auth/login — dashboard user identity pick', () => {
  // NOTE: the login rate limiter is a module-global keyed on IP; all tests hit
  // 127.0.0.1. A successful login clears the counter, so the success-first
  // ordering below keeps consecutive failures well under the 5-attempt limit.

  it('valid user + correct password → 200 and sets a session cookie', async () => {
    const port = await start(['Zoey', 'Ashley'])
    const res = await login(port, { password: PW, user: 'Ashley' })
    expect(res.status).toBe(200)
    expect(res.setCookie).toContain('shrok_session=')
  })

  it('user not in the configured list → 400 (no login)', async () => {
    const port = await start(['Zoey', 'Ashley'])
    const res = await login(port, { password: PW, user: 'Mallory' })
    expect(res.status).toBe(400)
    expect(res.setCookie).toBeNull()
  })

  it('missing user when users are configured → 400', async () => {
    const port = await start(['Zoey', 'Ashley'])
    const res = await login(port, { password: PW })
    expect(res.status).toBe(400)
  })

  it('valid user but wrong password → 401', async () => {
    const port = await start(['Zoey', 'Ashley'])
    const res = await login(port, { password: 'nope', user: 'Ashley' })
    expect(res.status).toBe(401)
  })

  it('no users configured → password alone logs in, any submitted user is ignored', async () => {
    const port = await start([])
    const res = await login(port, { password: PW, user: 'whatever' })
    expect(res.status).toBe(200)
    expect(res.setCookie).toContain('shrok_session=')
  })
})

describe('POST /api/auth/login — backup password', () => {
  it('backup password logs in when a backup hash is configured', async () => {
    const port = await start([], BACKUP_PW_HASH)
    const res = await login(port, { password: BACKUP_PW })
    expect(res.status).toBe(200)
    expect(res.setCookie).toContain('shrok_session=')
  })

  it('primary password still works when a backup hash is configured', async () => {
    const port = await start([], BACKUP_PW_HASH)
    const res = await login(port, { password: PW })
    expect(res.status).toBe(200)
    expect(res.setCookie).toContain('shrok_session=')
  })

  it('backup password rejected when no backup hash is configured', async () => {
    const port = await start([])
    const res = await login(port, { password: BACKUP_PW })
    expect(res.status).toBe(401)
  })

  it('wrong password still rejected when a backup hash is configured', async () => {
    const port = await start([], BACKUP_PW_HASH)
    const res = await login(port, { password: 'neither-one' })
    expect(res.status).toBe(401)
  })
})
