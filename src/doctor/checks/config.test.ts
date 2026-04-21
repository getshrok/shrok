import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Config } from '../../config.js'
import type { Ctx } from '../types.js'
import { configLoadCheck, configPathsCheck } from './config.js'

function makeCtx(overrides: Partial<Ctx>): Ctx {
  return {
    config: null,
    configError: null,
    deep: false,
    fetch: vi.fn(),
    fs,
    now: () => 0,
    ...overrides,
  }
}

describe('configLoadCheck', () => {
  it('returns ok when config loaded (no error)', async () => {
    const cfg = { workspacePath: '/tmp', dbPath: '/tmp/shrok.db' } as unknown as Config
    const out = await configLoadCheck.run(makeCtx({ config: cfg }))
    expect(out.status).toBe('ok')
    expect(out.detail).toContain('/tmp')
  })

  it('returns fail with the error message when config failed to load', async () => {
    const err = new Error('ANTHROPIC_API_KEY invalid')
    const out = await configLoadCheck.run(makeCtx({ configError: err }))
    expect(out.status).toBe('fail')
    expect(out.detail).toContain('ANTHROPIC_API_KEY invalid')
  })
})

describe('configPathsCheck', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ } }
    tmp = null
  })

  it('returns ok when workspacePath exists + is writable and dbPath parent exists', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-doctor-'))
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
    const cfg = { workspacePath: tmp, dbPath: path.join(tmp, 'data', 'shrok.db') } as unknown as Config
    const out = await configPathsCheck.run(makeCtx({ config: cfg }))
    expect(out.status).toBe('ok')
  })

  it('returns fail when workspacePath does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'shrok-doctor-missing-' + Date.now())
    const cfg = { workspacePath: missing, dbPath: path.join(missing, 'data', 'shrok.db') } as unknown as Config
    const out = await configPathsCheck.run(makeCtx({ config: cfg }))
    expect(out.status).toBe('fail')
    expect(out.hint).toMatch(/WORKSPACE_PATH/)
  })

  it('returns fail when workspacePath is not writable', async () => {
    if (process.getuid?.() === 0) return // skip as root — chmod is a no-op
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-doctor-'))
    fs.chmodSync(tmp, 0o400)
    try {
      const cfg = { workspacePath: tmp, dbPath: path.join(tmp, 'data', 'shrok.db') } as unknown as Config
      const out = await configPathsCheck.run(makeCtx({ config: cfg }))
      expect(out.status).toBe('fail')
      expect(out.hint).toMatch(/chmod/)
    } finally {
      // restore perms so cleanup works
      fs.chmodSync(tmp, 0o700)
    }
  })

  it('skips gracefully when config did not load', async () => {
    const out = await configPathsCheck.run(makeCtx({ config: null, configError: new Error('x') }))
    expect(out.status).toBe('skip')
    expect(out.detail).toContain('config did not load')
  })
})
