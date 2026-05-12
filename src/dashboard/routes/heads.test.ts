import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createHeadsRouter } from './heads.js'
import type { ResolvedHead } from '../../config.js'

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

describe('GET /api/heads (DASH-01)', () => {
  let server: Server
  let port: number

  async function startWithHeads(heads: ResolvedHead[]): Promise<void> {
    const app = express()
    app.use(express.json())
    // Bypass real auth — same pattern as settings.test.ts line 107
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/heads', createHeadsRouter(heads))
    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  }

  afterEach(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()))
  })

  async function getHeads(): Promise<{ heads: Array<{ id: string }> }> {
    const r = await fetch(`http://127.0.0.1:${port}/api/heads`)
    expect(r.status).toBe(200)
    return await r.json() as { heads: Array<{ id: string }> }
  }

  it('returns the configured head list as { heads: [{ id }, …] } (multi-head)', async () => {
    await startWithHeads([
      { id: 'default', channels: [] },
      { id: 'work', channels: [] },
      { id: 'personal', channels: [] },
    ])
    const body = await getHeads()
    expect(body).toEqual({
      heads: [{ id: 'default' }, { id: 'work' }, { id: 'personal' }],
    })
  })

  it('returns a single { id: "default" } entry for single-head deployments', async () => {
    await startWithHeads([{ id: 'default', channels: [] }])
    const body = await getHeads()
    expect(body).toEqual({ heads: [{ id: 'default' }] })
  })

  it('strips channels from the response — only id is exposed (D-08 minimal shape)', async () => {
    await startWithHeads([
      {
        id: 'work',
        channels: [
          { id: 'tg-work', vendor: 'telegram', botToken: 'SECRET-TOKEN', chatId: '123' },
        ],
      },
    ])
    const body = await getHeads()
    expect(body).toEqual({ heads: [{ id: 'work' }] })
    // Defense-in-depth: secret never leaks through this endpoint
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('SECRET-TOKEN')
    expect(raw).not.toContain('botToken')
    expect(raw).not.toContain('channels')
  })
})
