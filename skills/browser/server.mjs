#!/usr/bin/env node
import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const SKILL_DIR = import.meta.dirname
const SESSION_FILE = join(SKILL_DIR, '.browser-session.json')
const IDLE_TIMEOUT = 10 * 60 * 1000
const MAX_LIFETIME = 30 * 60 * 1000
const WATCHDOG_INTERVAL = 30 * 1000
const IS_WINDOWS = process.platform === 'win32'

let lastActivity = Date.now()
const startedAt = Date.now()
let shuttingDown = false

// Surface any uncaught error to the sidecar log before the process dies, so the
// parent can include it in the timeout diagnostic.
process.on('uncaughtException', (err) => {
  console.error(`[sidecar] uncaughtException: ${err.stack || err.message}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error(`[sidecar] unhandledRejection: ${err?.stack || err?.message || err}`)
  process.exit(1)
})

console.error(`[sidecar] pid=${process.pid} platform=${process.platform} starting`)

// 1. Resolve Playwright's Chromium binary
const chromePath = chromium.executablePath()
console.error(`[sidecar] chrome path: ${chromePath}`)

// 2. Launch Chromium with remote debugging on a random port.
// On POSIX, detached:true puts chrome in its own process group so we can
// SIGTERM the whole group on shutdown (kills the crashpad_handler helpers too).
// On Windows, process groups / negative-PID kill signals don't exist — we rely
// on chrome.kill() + taskkill /T for a full tree kill.
const chrome = spawnChild(chromePath, [
  '--headless=new',
  '--no-sandbox',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--remote-allow-origins=*',
  '--disable-background-networking',
  '--disable-sync',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: !IS_WINDOWS })

// Parse the DevTools WebSocket URL from stderr. On Windows/slow disks, the
// first launch of headless chromium can be slow — give it 30s and echo any
// stderr we see into the sidecar log so failures are debuggable.
const cdpWsUrl = await new Promise((resolve, reject) => {
  let stderrBuf = ''
  const timeout = setTimeout(() => {
    const tail = stderrBuf.split('\n').slice(-10).join('\n')
    reject(new Error(`Chromium did not start in time. stderr tail:\n${tail}`))
  }, 30000)

  chrome.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderrBuf += text
    console.error(`[chrome] ${text.trimEnd()}`)
    const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (match) {
      clearTimeout(timeout)
      chrome.stderr.removeAllListeners('data')
      resolve(match[1].trim())
    }
  })

  chrome.on('error', (err) => {
    clearTimeout(timeout)
    reject(err)
  })

  chrome.on('exit', (code, signal) => {
    clearTimeout(timeout)
    reject(new Error(`Chromium exited early with code=${code} signal=${signal}. stderr tail:\n${stderrBuf.split('\n').slice(-10).join('\n')}`))
  })
})

console.error(`[sidecar] chromium ready, CDP: ${cdpWsUrl}`)

// 3. Start HTTP control server
const httpServer = createServer((req, res) => {
  lastActivity = Date.now()

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      alive: true,
      pid: process.pid,
      cdpWsUrl,
      uptimeMs: Date.now() - startedAt,
      idleMs: 0,
    }))
  } else if (req.method === 'POST' && req.url === '/close') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ closed: true }))
    shutdown()
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})

// 4. Write session file inside listen callback (port is known)
httpServer.listen(0, '127.0.0.1', () => {
  const port = httpServer.address().port
  const session = {
    pid: process.pid,
    port,
    chromePid: chrome.pid,
    cdpWsUrl,
    startedAt,
  }
  const tmpFile = SESSION_FILE + '.tmp'
  writeFileSync(tmpFile, JSON.stringify(session, null, 2))
  renameSync(tmpFile, SESSION_FILE)
})

// 5. Watchdog
const watchdog = setInterval(() => {
  const now = Date.now()
  if (now - lastActivity > IDLE_TIMEOUT || now - startedAt > MAX_LIFETIME) {
    shutdown()
    return
  }
  if (chrome.exitCode !== null) {
    shutdown()
  }
}, WATCHDOG_INTERVAL)
watchdog.unref()

// 6. Shutdown — cross-platform chrome tree kill.
function killChromeTree(signal) {
  if (!chrome.pid) return
  if (IS_WINDOWS) {
    // taskkill /T kills the whole process tree (chrome spawns helper processes).
    try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F']) } catch {}
    return
  }
  // POSIX: negative PID == process group. Requires detached:true at spawn time.
  try {
    process.kill(-chrome.pid, signal)
  } catch {
    try { chrome.kill(signal) } catch {}
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(watchdog)
  killChromeTree('SIGTERM')
  setTimeout(() => {
    if (chrome.exitCode === null) killChromeTree('SIGKILL')
    try { httpServer.close() } catch {}
    try { unlinkSync(SESSION_FILE) } catch {}
    process.exit(0)
  }, 500).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// If Chromium exits unexpectedly, shut down
chrome.on('exit', () => {
  if (!shuttingDown) shutdown()
})
