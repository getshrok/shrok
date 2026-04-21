import { describe, it, expect, vi, afterEach } from 'vitest'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Config } from '../../config.js'
import type { Ctx } from '../types.js'
import { processPidCheck, processPortCheck } from './process.js'

function makeCtx(cfg: Partial<Config>): Ctx {
  return {
    config: { ...(cfg as Config) },
    configError: null,
    deep: false,
    fetch: vi.fn(),
    fs,
    now: () => 0,
  }
}

describe('processPidCheck', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ } }
    tmp = null
  })

  it('returns warn when no pid file present', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-doctor-'))
    const ctx = makeCtx({ workspacePath: tmp, dashboardPort: 8765 })
    const out = await processPidCheck.run(ctx)
    expect(out.status).toBe('warn')
    expect(out.detail).toContain('no PID file')
    expect(out.hint).toMatch(/shrok start/)
  })

  it('returns ok when a pid file exists and the PID is numeric', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-doctor-'))
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'data', 'shrok.pid'), '12345\n')
    const ctx = makeCtx({ workspacePath: tmp, dashboardPort: 8765 })
    const out = await processPidCheck.run(ctx)
    expect(out.status).toBe('ok')
    expect(out.detail).toContain('12345')
  })
})

describe('processPortCheck', () => {
  it('returns ok when something is listening on the configured dashboard port', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const ctx = makeCtx({ workspacePath: '/tmp', dashboardPort: port })
    const out = await processPortCheck.run(ctx)
    await new Promise<void>(r => server.close(() => r()))
    expect(out.status).toBe('ok')
  })

  it('returns fail when the dashboard port refuses connection', async () => {
    // Port 1 is almost always refused/not-listening by an unprivileged process.
    const ctx = makeCtx({ workspacePath: '/tmp', dashboardPort: 1 })
    const out = await processPortCheck.run(ctx)
    expect(out.status).toBe('fail')
    expect(out.hint).toMatch(/shrok logs/)
  })
})
