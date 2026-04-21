import express from 'express'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAuth, requireSameOrigin } from '../auth.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const SUITES: Record<string, { script: string; label: string }> = {
  unit:        { script: 'test',             label: 'Unit' },
  integration: { script: 'test:integration', label: 'Integration' },
}

export function createTestsRouter() {
  const router = express.Router()

  // GET /api/tests/run?suite=unit|integration
  // Streams test output as SSE events
  router.get('/run', requireAuth, requireSameOrigin, (req, res) => {
    const suite = req.query['suite'] as string
    if (!suite || !SUITES[suite]) {
      res.status(400).json({ error: 'Invalid suite. Use: unit, integration' })
      return
    }

    const { script } = SUITES[suite]!

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    function send(type: string, data: unknown) {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send('start', { suite, time: Date.now() })

    const child = spawn('npm', ['run', script, '--', '--reporter=verbose'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        send('line', { text: line })
      }
    })

    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        send('line', { text: line })
      }
    })

    child.on('close', (code) => {
      send('done', { code, passed: code === 0 })
      res.end()
    })

    req.on('close', () => {
      child.kill()
    })
  })

  return router
}
