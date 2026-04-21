// Process-layer checks: PID file presence + TCP connect to the dashboard port.
//
// The daemon uses port-based locking (see src/index.ts:114-133) so the PID file
// is best-effort — missing is a warn, not a fail.

import * as net from 'node:net'
import * as path from 'node:path'
import type { Check, CheckOutcome, Ctx } from '../types.js'

function pidFilePath(ctx: Ctx): string | null {
  if (!ctx.config) return null
  return path.join(ctx.config.workspacePath, 'data', 'shrok.pid')
}

export const processPidCheck: Check = {
  id: 'process.pid',
  title: 'pid file present',
  layer: 'process',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
    const p = pidFilePath(ctx)!
    try {
      const raw = ctx.fs.readFileSync(p, 'utf8').trim()
      const pid = Number.parseInt(raw, 10)
      if (!Number.isFinite(pid) || pid <= 0) {
        return { status: 'warn', detail: `pid file at ${p} has non-numeric content: ${raw.slice(0, 40)}` }
      }
      return { status: 'ok', detail: `pid ${pid} (from ${p})` }
    } catch {
      return {
        status: 'warn',
        detail: `no PID file at ${p}`,
        hint: 'daemon may not be running — try `shrok start`',
      }
    }
  },
}

/** Opens a TCP connection to 127.0.0.1:<port> and resolves with ok/fail/warn. */
async function tryConnect(port: number, timeoutMs = 1000): Promise<'ok' | 'refused' | 'timeout' | 'error'> {
  return await new Promise(resolve => {
    let settled = false
    const socket = net.connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve('timeout')
    }, timeoutMs)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      resolve('ok')
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err.code === 'ECONNREFUSED') resolve('refused')
      else resolve('error')
    })
  })
}

export const processPortCheck: Check = {
  id: 'process.port',
  title: 'dashboard port listening',
  layer: 'process',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
    const port = ctx.config.dashboardPort
    const result = await tryConnect(port)
    if (result === 'ok') return { status: 'ok', detail: `connected to 127.0.0.1:${port}` }
    if (result === 'refused') {
      return {
        status: 'fail',
        detail: `nothing listening on 127.0.0.1:${port}`,
        hint: 'daemon is not accepting connections — check `shrok logs`',
      }
    }
    if (result === 'timeout') {
      return {
        status: 'warn',
        detail: `timeout connecting to 127.0.0.1:${port}`,
        hint: 'dashboard port did not respond within 1s — check `shrok logs`',
      }
    }
    return {
      status: 'warn',
      detail: `unexpected error connecting to 127.0.0.1:${port}`,
      hint: 'check network stack / firewall',
    }
  },
}
