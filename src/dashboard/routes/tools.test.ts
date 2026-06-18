import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import * as url from 'node:url'
import type { Server } from 'node:http'
import { createToolsRouter, type ToolRegistryEntry } from './tools.js'
import { NOTE_TOOL_NAMES, REMINDER_TOOL_NAMES, SCHEDULE_TOOL_NAMES, HEAD_RUNNABLE_TOOL_NAMES } from '../../sub-agents/registry.js'

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

  it('bash_no_net is agent-only — intentionally absent from HEAD_RUNNABLE_TOOL_NAMES (WR-01)', async () => {
    // bash_no_net uses `unshare -n`, blocked in many environments; it is
    // deliberately excluded from HEAD_RUNNABLE_TOOL_NAMES (operators assign
    // plain `bash` to a head instead). If a future change makes it
    // head-assignable this guard fails loudly.
    await start()
    const body = await getTools()
    const bashNoNet = body.tools.find(t => t.name === 'bash_no_net')
    expect(bashNoNet).toBeDefined()
    expect(bashNoNet!.layers).toEqual(['agent'])
  })

  it('update_schedule is agent-only — intentionally absent from HEAD_RUNNABLE_TOOL_NAMES (WR-02)', async () => {
    // update_schedule is excluded from HEAD_RUNNABLE_TOOL_NAMES so the
    // head-runnable schedule set stays aligned with the shipped base agent
    // allowlist (config.json ships create/list/delete_schedule but not
    // update_schedule). Other schedule tools are head-runnable; this one is not.
    await start()
    const body = await getTools()
    const updateSchedule = body.tools.find(t => t.name === 'update_schedule')
    expect(updateSchedule).toBeDefined()
    expect(updateSchedule!.layers).toEqual(['agent'])
  })

  it('HEAD_RUNNABLE_TOOL_NAMES excludes update_schedule but includes the other schedule tools (WR-02)', async () => {
    expect(HEAD_RUNNABLE_TOOL_NAMES).not.toContain('update_schedule')
    expect(HEAD_RUNNABLE_TOOL_NAMES).toContain('create_schedule')
    expect(HEAD_RUNNABLE_TOOL_NAMES).toContain('list_schedules')
    expect(HEAD_RUNNABLE_TOOL_NAMES).toContain('delete_schedule')
  })

  it('note tools are DISABLED — absent from the registry', async () => {
    // Note tools were disabled (operator preference; see NOTE_TOOL_NAMES in registry.ts).
    // NOTE_TOOL_NAMES is now empty, and none of the legacy names should surface.
    expect(NOTE_TOOL_NAMES).toEqual([])
    await start()
    const body = await getTools()
    const names = new Set(body.tools.map(t => t.name))
    for (const legacy of ['write_note', 'read_note', 'list_notes', 'search_notes', 'delete_note']) {
      expect(names.has(legacy), `${legacy} should be absent`).toBe(false)
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

  // Phase 47 D-12: ported agent tools are now dual (head + agent) — positive coverage
  it('read_file is dual — carries both head and agent layers (Phase 47 retag)', async () => {
    await start()
    const body = await getTools()
    const readFile = body.tools.find(t => t.name === 'read_file')
    expect(readFile).toBeDefined()
    expect(readFile!.layers).toContain('head')
    expect(readFile!.layers).toContain('agent')
  })

  it('create_reminder is dual — carries both head and agent layers (Phase 47 retag)', async () => {
    await start()
    const body = await getTools()
    const createReminder = body.tools.find(t => t.name === 'create_reminder')
    expect(createReminder).toBeDefined()
    expect(createReminder!.layers).toContain('head')
    expect(createReminder!.layers).toContain('agent')
  })

  it('create_schedule is dual — carries both head and agent layers (Phase 47 retag)', async () => {
    await start()
    const body = await getTools()
    const createSchedule = body.tools.find(t => t.name === 'create_schedule')
    expect(createSchedule).toBeDefined()
    expect(createSchedule!.layers).toContain('head')
    expect(createSchedule!.layers).toContain('agent')
  })

  it('all HEAD_RUNNABLE_TOOL_NAMES appear in registry with both head and agent layers', async () => {
    await start()
    const body = await getTools()
    const byName = new Map(body.tools.map(t => [t.name, t]))
    for (const name of HEAD_RUNNABLE_TOOL_NAMES) {
      const entry = byName.get(name)
      expect(entry, `${name} missing from registry`).toBeDefined()
      expect(entry!.layers, `${name} not tagged as head`).toContain('head')
      expect(entry!.layers, `${name} not tagged as agent`).toContain('agent')
    }
  })

  it('every entry has exactly the { name, layers } shape — no extra keys (T-47-08)', async () => {
    await start()
    const body = await getTools()
    for (const entry of body.tools) {
      const keys = Object.keys(entry).sort()
      expect(keys).toEqual(['layers', 'name'])
    }
  })
})
