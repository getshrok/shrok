import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createIdentityRouter } from './identity.js'
import type { IdentityLoader } from '../../identity/loader.js'
import { setMemoryPromptsWorkspaceDir, __resetMemoryPromptsWorkspaceDirForTests } from '../../memory/prompts.js'

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

// Noop IdentityLoader — returns empty file list and null for any readFile call.
function makeNoopLoader(): IdentityLoader {
  return {
    loadSystemPrompt: () => '',
    listFiles: () => [],
    readFile: (_filename: string) => null,
  }
}

describe('identity router — memory section', () => {
  let tmpMain: string
  let tmpAgent: string
  let tmpStewards: string
  let tmpProactive: string
  let tmpMemory: string
  let server: Server
  let port: number

  beforeEach(async () => {
    tmpMain = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-id-main-'))
    tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-id-agent-'))
    tmpStewards = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-id-stewards-'))
    tmpProactive = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-id-proactive-'))
    tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-id-memory-'))

    setMemoryPromptsWorkspaceDir(tmpMemory)

    const app = express()
    app.use(express.json())
    // Bypass requireAuth
    app.use((_req, res, next) => {
      res.locals['authenticated'] = true
      next()
    })
    app.use('/api/identity', createIdentityRouter(
      makeNoopLoader(),
      tmpMain,
      makeNoopLoader(),
      tmpAgent,
      tmpStewards,
      tmpProactive,
      tmpMemory,
    ))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    __resetMemoryPromptsWorkspaceDirForTests()
    for (const dir of [tmpMain, tmpAgent, tmpStewards, tmpProactive, tmpMemory]) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  async function get(): Promise<{ status: number; data: Record<string, unknown> }> {
    const r = await fetch(`http://127.0.0.1:${port}/api/identity`)
    const data = await r.json() as Record<string, unknown>
    return { status: r.status, data }
  }

  async function put(section: string, filename: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
    const r = await fetch(`http://127.0.0.1:${port}/api/identity/${section}/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return { status: r.status, data }
  }

  it('Test 1: GET returns memory section entries', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    const files = (r.data as { files: Array<{ filename: string; section: 'main' | 'agent' | 'stewards' | 'proactive' | 'memory'; isWorkspace: boolean }> }).files
    // Verify the memory section is present with exactly the four shipped defaults
    const memoryEntries = files.filter(f => f.section === 'memory')
    expect(memoryEntries.length).toBe(4)
    const filenames = memoryEntries.map(e => e.filename).sort()
    expect(filenames).toEqual([
      'MEMORY-ARCHIVER.md',
      'MEMORY-CHUNKER.md',
      'MEMORY-ROUTER.md',
      'MEMORY-SUMMARY-UPDATE.md',
    ])
    // All should be section: 'memory' and isWorkspace=false (no workspace overrides yet)
    for (const entry of memoryEntries) {
      expect(entry).toMatchObject({ section: 'memory', isWorkspace: false })
    }
  })

  it('Test 2: memory entry isWorkspace=true when override exists', async () => {
    // Write a workspace override for MEMORY-CHUNKER.md
    fs.writeFileSync(path.join(tmpMemory, 'MEMORY-CHUNKER.md'), 'CHUNKER-OVERRIDE', 'utf8')
    setMemoryPromptsWorkspaceDir(tmpMemory)

    const r = await get()
    const files = (r.data as { files: Array<{ filename: string; section: string; isWorkspace: boolean }> }).files
    const memoryEntries = files.filter(f => f.section === 'memory')

    const chunker = memoryEntries.find(e => e.filename === 'MEMORY-CHUNKER.md')
    expect(chunker?.isWorkspace).toBe(true)

    // Other three remain false
    const others = memoryEntries.filter(e => e.filename !== 'MEMORY-CHUNKER.md')
    for (const entry of others) {
      expect(entry.isWorkspace).toBe(false)
    }
  })

  it('Test 3: memory entry content matches workspace override', async () => {
    const wsContent = 'WS-OVERRIDE'
    fs.writeFileSync(path.join(tmpMemory, 'MEMORY-ROUTER.md'), wsContent, 'utf8')
    setMemoryPromptsWorkspaceDir(tmpMemory)

    const r = await get()
    const files = (r.data as { files: Array<{ filename: string; section: string; content: string }> }).files
    const router = files.find(f => f.section === 'memory' && f.filename === 'MEMORY-ROUTER.md')
    expect(router?.content).toBe(wsContent)
  })

  it('Test 4: PUT writes to workspace dir', async () => {
    const r = await put('memory', 'MEMORY-ARCHIVER.md', { content: 'ARCHIVER-V2' })
    expect(r.status).toBe(200)
    expect((r.data as { ok: boolean }).ok).toBe(true)
    const written = fs.readFileSync(path.join(tmpMemory, 'MEMORY-ARCHIVER.md'), 'utf8')
    expect(written).toBe('ARCHIVER-V2')
  })

  it('Test 5: PUT creates workspace dir if missing', async () => {
    // Use a non-existent subdirectory
    const missingDir = path.join(os.tmpdir(), `shrok-id-missing-${Date.now()}`)
    // Do not create it
    expect(fs.existsSync(missingDir)).toBe(false)

    setMemoryPromptsWorkspaceDir(missingDir)

    // Rebuild the app with the new dir
    await new Promise<void>(r => server.close(() => r()))
    const app2 = express()
    app2.use(express.json())
    app2.use((_req, res, next) => {
      res.locals['authenticated'] = true
      next()
    })
    app2.use('/api/identity', createIdentityRouter(
      makeNoopLoader(),
      tmpMain,
      makeNoopLoader(),
      tmpAgent,
      tmpStewards,
      tmpProactive,
      missingDir,
    ))
    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app2.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })

    const r = await put('memory', 'MEMORY-ARCHIVER.md', { content: 'CONTENT' })
    expect(r.status).toBe(200)
    expect(fs.existsSync(missingDir)).toBe(true)
    expect(fs.existsSync(path.join(missingDir, 'MEMORY-ARCHIVER.md'))).toBe(true)

    // Cleanup
    fs.rmSync(missingDir, { recursive: true, force: true })
  })

  it('Test 6: PUT unknown filename returns 404', async () => {
    // MEMORY-UNKNOWN.md matches SAFE_FILENAME but is not in the shipped list
    const r = await put('memory', 'MEMORY-UNKNOWN.md', { content: 'data' })
    expect(r.status).toBe(404)
  })

  it('Test 7: PUT lowercase filename returns 400', async () => {
    // memory-chunker.md fails the SAFE_FILENAME regex
    const r = await put('memory', 'memory-chunker.md', { content: 'data' })
    expect(r.status).toBe(400)
  })

  it('Test 8: PUT unknown section returns 400', async () => {
    const r = await put('foo', 'MEMORY-CHUNKER.md', { content: 'data' })
    expect(r.status).toBe(400)
  })

  it('Test 9: PUT without content body returns 400', async () => {
    const r = await put('memory', 'MEMORY-CHUNKER.md', {})
    expect(r.status).toBe(400)
  })

  it('Test 10: memory entries have isDangerous=false', async () => {
    const r = await get()
    const files = (r.data as { files: Array<{ filename: string; section: string; isDangerous: boolean }> }).files
    const memoryEntries = files.filter(f => f.section === 'memory')
    expect(memoryEntries.length).toBe(4)
    for (const entry of memoryEntries) {
      expect(entry.isDangerous).toBe(false)
    }
  })
})
