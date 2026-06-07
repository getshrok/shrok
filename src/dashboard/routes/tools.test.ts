import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import * as url from 'node:url'
import type { Server } from 'node:http'
import { createToolsRouter } from './tools.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
/** Path to the repo's base config.json — the authoritative shipped default. */
const REPO_CONFIG_PATH = path.resolve(__dirname, '../../../config.json')

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

interface Fixture {
  server: Server
  port: number
}

describe('GET /api/tools', () => {
  let fx: Fixture | null = null

  async function start(): Promise<void> {
    const app = express()
    app.use(express.json())
    // Simulate authenticated session for unit tests
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/tools', createToolsRouter())
    const port = await getFreePort()
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    fx = { server, port }
  }

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx!.server.close(() => r()))
    fx = null
  })

  async function getTools(): Promise<{ tools: string[]; headTools: string[] }> {
    const r = await fetch(`http://127.0.0.1:${fx!.port}/api/tools`)
    expect(r.status).toBe(200)
    return r.json() as Promise<{ tools: string[]; headTools: string[] }>
  }

  it('returns { tools, headTools } with both arrays sorted', async () => {
    await start()
    const body = await getTools()
    expect(Array.isArray(body.tools)).toBe(true)
    expect(Array.isArray(body.headTools)).toBe(true)
    // Both arrays should be sorted
    const toolsSorted = [...body.tools].sort()
    expect(body.tools).toEqual(toolsSorted)
    const headToolsSorted = [...body.headTools].sort()
    expect(body.headTools).toEqual(headToolsSorted)
  })

  it('tools includes all note tool names previously missing (write_note, read_note, list_notes, search_notes, delete_note)', async () => {
    await start()
    const body = await getTools()
    expect(body.tools).toContain('write_note')
    expect(body.tools).toContain('read_note')
    expect(body.tools).toContain('list_notes')
    expect(body.tools).toContain('search_notes')
    expect(body.tools).toContain('delete_note')
  })

  it('tools includes all reminder tool names previously missing (create_reminder, list_reminders, cancel_reminder)', async () => {
    await start()
    const body = await getTools()
    expect(body.tools).toContain('create_reminder')
    expect(body.tools).toContain('list_reminders')
    expect(body.tools).toContain('cancel_reminder')
  })

  it('tools includes all schedule tool names previously missing (create_schedule, list_schedules, delete_schedule)', async () => {
    await start()
    const body = await getTools()
    expect(body.tools).toContain('create_schedule')
    expect(body.tools).toContain('list_schedules')
    expect(body.tools).toContain('delete_schedule')
  })

  it('structural invariant: every tool in config.json workerDefaults.allowedTools appears in GET /api/tools .tools', async () => {
    await start()
    const body = await getTools()
    const toolSet = new Set(body.tools)

    // Load the repo's shipped default allowedTools
    const configRaw = fs.readFileSync(REPO_CONFIG_PATH, 'utf8')
    const config = JSON.parse(configRaw) as {
      workerDefaults?: { allowedTools?: string[] }
    }
    const defaultAllowedTools = config.workerDefaults?.allowedTools ?? []
    expect(defaultAllowedTools.length).toBeGreaterThan(0)

    const missingTools = defaultAllowedTools.filter(t => !toolSet.has(t))
    expect(missingTools).toEqual([])
  })
})
