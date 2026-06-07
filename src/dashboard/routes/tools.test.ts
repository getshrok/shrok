import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import * as url from 'node:url'
import type { Server } from 'node:http'
import { createToolsRouter, type ToolRegistryEntry } from './tools.js'
import { NOTE_TOOL_NAMES, REMINDER_TOOL_NAMES, SCHEDULE_TOOL_NAMES } from '../../sub-agents/registry.js'

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

describe('GET /api/tools — tagged registry (D-08, TOOLCFG-08)', () => {
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

  async function getTools(): Promise<{ tools: ToolRegistryEntry[] }> {
    const r = await fetch(`http://127.0.0.1:${fx!.port}/api/tools`)
    expect(r.status).toBe(200)
    return r.json() as Promise<{ tools: ToolRegistryEntry[] }>
  }

  it('response is a single array (no disjoint headTools key)', async () => {
    await start()
    const body = await getTools()
    expect(Array.isArray(body.tools)).toBe(true)
    // The old disjoint shape must be gone
    expect((body as Record<string, unknown>)['headTools']).toBeUndefined()
  })

  it('each entry has name (string) and layers (non-empty array of head|agent)', async () => {
    await start()
    const body = await getTools()
    for (const entry of body.tools) {
      expect(typeof entry.name).toBe('string')
      expect(Array.isArray(entry.layers)).toBe(true)
      expect(entry.layers.length).toBeGreaterThan(0)
      for (const layer of entry.layers) {
        expect(['head', 'agent']).toContain(layer)
      }
    }
  })

  it('result is sorted deterministically by name', async () => {
    await start()
    const body = await getTools()
    const sorted = [...body.tools].sort((a, b) => a.name.localeCompare(b.name))
    expect(body.tools.map(t => t.name)).toEqual(sorted.map(t => t.name))
  })

  it('view_image has both head and agent layers (dual-context tool)', async () => {
    await start()
    const body = await getTools()
    const viewImage = body.tools.find(t => t.name === 'view_image')
    expect(viewImage).toBeDefined()
    expect(viewImage!.layers).toContain('head')
    expect(viewImage!.layers).toContain('agent')
  })

  it('spawn_agent is head-only (not in agent layer)', async () => {
    await start()
    const body = await getTools()
    const spawnAgent = body.tools.find(t => t.name === 'spawn_agent')
    expect(spawnAgent).toBeDefined()
    expect(spawnAgent!.layers).toContain('head')
    expect(spawnAgent!.layers).not.toContain('agent')
  })

  it('bash is dual — runnable by both head and agent (Phase 47 retag)', async () => {
    await start()
    const body = await getTools()
    const bash = body.tools.find(t => t.name === 'bash')
    expect(bash).toBeDefined()
    expect(bash!.layers).toContain('agent')
    expect(bash!.layers).toContain('head')
  })

  it('all NOTE tool names appear with the agent layer', async () => {
    await start()
    const body = await getTools()
    const byName = new Map(body.tools.map(t => [t.name, t]))
    for (const name of NOTE_TOOL_NAMES) {
      const entry = byName.get(name)
      expect(entry, `${name} missing from registry`).toBeDefined()
      expect(entry!.layers, `${name} not tagged as agent`).toContain('agent')
    }
  })

  it('all REMINDER tool names appear with the agent layer', async () => {
    await start()
    const body = await getTools()
    const byName = new Map(body.tools.map(t => [t.name, t]))
    for (const name of REMINDER_TOOL_NAMES) {
      const entry = byName.get(name)
      expect(entry, `${name} missing from registry`).toBeDefined()
      expect(entry!.layers, `${name} not tagged as agent`).toContain('agent')
    }
  })

  it('all SCHEDULE tool names appear with the agent layer', async () => {
    await start()
    const body = await getTools()
    const byName = new Map(body.tools.map(t => [t.name, t]))
    for (const name of SCHEDULE_TOOL_NAMES) {
      const entry = byName.get(name)
      expect(entry, `${name} missing from registry`).toBeDefined()
      expect(entry!.layers, `${name} not tagged as agent`).toContain('agent')
    }
  })

  it('structural invariant: every tool in config.json workerDefaults.allowedTools appears in registry with agent layer', async () => {
    await start()
    const body = await getTools()
    const byName = new Map(body.tools.map(t => [t.name, t]))

    // Load the repo's shipped default allowedTools
    const configRaw = fs.readFileSync(REPO_CONFIG_PATH, 'utf8')
    const config = JSON.parse(configRaw) as {
      workerDefaults?: { allowedTools?: string[] }
    }
    const defaultAllowedTools = config.workerDefaults?.allowedTools ?? []
    expect(defaultAllowedTools.length).toBeGreaterThan(0)

    const missingTools = defaultAllowedTools.filter(t => !byName.has(t))
    expect(missingTools, `Tools in config.json missing from registry: ${missingTools.join(', ')}`).toEqual([])
  })
})
