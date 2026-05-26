// src/dashboard/ring-media.test.ts
//
// Standalone Express integration test for the /media/ring.mp3 route.
// Mirrors docs.test.ts pattern: getFreePort + app.listen + fetch.
// RING-06: the route is unauthenticated — no auth cookie/header is set.
import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import * as path from 'node:path'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { Server } from 'node:http'

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

/** Build a minimal Express app with the literal /media/ring.mp3 route
 *  pointing at the provided assetPath. */
function buildApp(assetPath: string): express.Express {
  const app = express()
  app.get('/media/ring.mp3', (_req, res) => {
    res.setHeader('Content-Type', 'audio/mpeg')
    res.sendFile(assetPath)
  })
  return app
}

async function startApp(assetPath: string): Promise<{ port: number; server: Server }> {
  const port = await getFreePort()
  const app = buildApp(assetPath)
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve({ port, server }))
    server.once('error', reject)
  })
}

describe('GET /media/ring.mp3', () => {
  let server: Server | null = null
  let tmpDir: string | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>(r => server!.close(() => r()))
      server = null
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it('RING-06: returns 200 + Content-Type audio/mpeg with no auth set', async () => {
    // Use the real bundled asset so the file definitely exists
    const assetPath = path.resolve(import.meta.dirname, '../../assets/ring.mp3')
    const { port, server: s } = await startApp(assetPath)
    server = s

    // No auth cookie or Authorization header set
    const res = await fetch(`http://127.0.0.1:${port}/media/ring.mp3`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/audio\/mpeg/)
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('RING-06: returns non-empty body (the beep bytes)', async () => {
    const assetPath = path.resolve(import.meta.dirname, '../../assets/ring.mp3')
    const { port, server: s } = await startApp(assetPath)
    server = s

    const res = await fetch(`http://127.0.0.1:${port}/media/ring.mp3`)
    const buf = await res.arrayBuffer()
    // ID3 header starts with 'ID3' (bytes 0x49 0x44 0x33) or MPEG sync (0xFF 0xFB/0xFA/0xF3…)
    const bytes = new Uint8Array(buf)
    expect(bytes.length).toBeGreaterThan(10)
  })

  it('RING-06 no-auth: omitting Authorization header still returns 200 (unauthenticated route)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-media-test-'))
    // Write a minimal 3-byte "file" — enough for sendFile to succeed
    const fakeMp3 = path.join(tmpDir, 'ring.mp3')
    // ID3 magic bytes so it's a valid-looking mp3
    fs.writeFileSync(fakeMp3, Buffer.from([0x49, 0x44, 0x33, 0x00]))
    const { port, server: s } = await startApp(fakeMp3)
    server = s

    const res = await fetch(`http://127.0.0.1:${port}/media/ring.mp3`, {
      headers: { /* explicitly no Authorization */ },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/audio\/mpeg/)
  })
})
