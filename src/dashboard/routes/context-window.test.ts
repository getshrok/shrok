import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createContextWindowRouter } from './context-window.js'
import type { IdentityLoader } from '../../identity/loader.js'
import type { SkillLoader } from '../../types/skill.js'
import type { Config } from '../../config.js'

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

// Identity loader with two known files; loadSystemPrompt merges them and embeds
// the {workspacePath} placeholder so we exercise the resolve step.
function makeIdentityLoader(): IdentityLoader {
  const files: Record<string, string> = {
    'AAA.md': 'I am the assistant. My workspace is {workspacePath}.',
    'BBB.md': 'I value clarity and brevity in all my responses to the user.',
  }
  return {
    loadSystemPrompt: () => Object.values(files).map(s => s.trim()).join('\n\n---\n\n'),
    listFiles: () => Object.keys(files).sort(),
    readFile: (name: string) => files[name] ?? null,
  }
}

const skillLoader: SkillLoader = {
  listAll: () => [],
} as unknown as SkillLoader

const config = {
  workspacePath: '/tmp/ws',
  llmProvider: 'anthropic',
  anthropicModelSmart: 'claude-test',
} as unknown as Config

describe('context-window router', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    const app = express()
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/context-window', createContextWindowRouter({
      config,
      workspacePath: '/tmp/ws',
      identityLoader: makeIdentityLoader(),
      skillLoader,
    }))
    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  async function get() {
    const r = await fetch(`http://127.0.0.1:${port}/api/context-window`)
    return { status: r.status, data: await r.json() as Record<string, unknown> }
  }

  it('returns measured, positive system-prompt token sizes', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.data['approximate']).toBe(true)
    expect(r.data['tokenizer']).toBe('cl100k_base')
    expect(r.data['identityTokens']).toBeGreaterThan(0)
    expect(r.data['baseSystemTokens']).toBeGreaterThan(0)
  })

  it('identity is a subset of the assembled base (identity + other === base)', async () => {
    const r = await get()
    const identity = r.data['identityTokens'] as number
    const base = r.data['baseSystemTokens'] as number
    // base = identity + capabilities + skills + environment, so identity never exceeds it
    expect(base).toBeGreaterThanOrEqual(identity)
    // "other system" the bar derives is non-negative
    expect(base - identity).toBeGreaterThanOrEqual(0)
  })

  it('lists per-identity-file sizes that roughly sum to the identity total', async () => {
    const r = await get()
    const files = r.data['identityFiles'] as { name: string; tokens: number }[]
    expect(files.map(f => f.name)).toEqual(['AAA.md', 'BBB.md'])
    const sum = files.reduce((a, f) => a + f.tokens, 0)
    const identity = r.data['identityTokens'] as number
    // Per-file tokenization isn't perfectly additive vs the merged string, but
    // should be in the same ballpark (within a small absolute margin).
    expect(Math.abs(sum - identity)).toBeLessThan(20)
  })
})
