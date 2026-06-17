import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'
import type { SensorRunner } from '../../sensors/runner.js'

// Path-traversal mitigation (T-49-01-TRAVERSAL): validate slug BEFORE any path.join.
// Mirrors the guard in src/sensors/runner.ts — lowercase alphanumeric + hyphens only.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export function createSensorsRouter(opts: {
  workspacePath: string
  sensorRunner: SensorRunner
}): Router {
  const { workspacePath, sensorRunner } = opts
  const sensorsDir = path.join(workspacePath, 'sensors')
  const ambientDir = path.join(workspacePath, 'ambient')
  const router = Router()

  // ─── GET / — list all sensor slugs (filesystem-as-source-of-truth) ───────

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    // mkdir-before-readdir so a fresh workspace with no sensors/ dir never crashes.
    fs.mkdirSync(sensorsDir, { recursive: true })
    const entries = fs.readdirSync(sensorsDir, { withFileTypes: true })
    const sensors = entries
      .filter(e => e.isDirectory() && SLUG_RE.test(e.name))
      .map(e => ({ slug: e.name }))
    res.json({ sensors })
  })

  // ─── GET /:slug — read script content ────────────────────────────────────

  router.get('/:slug', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    // Slug guard: validate BEFORE any path.join (T-49-01-TRAVERSAL).
    if (!slug || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid slug' })
      return
    }

    const scriptPath = path.join(sensorsDir, slug, 'sensor.mjs')
    if (!fs.existsSync(scriptPath)) {
      res.status(404).json({ error: `Sensor not found: ${slug}` })
      return
    }
    const content = fs.readFileSync(scriptPath, 'utf8')
    res.json({ slug, content })
  })

  // ─── PUT /:slug — create or overwrite sensor script ──────────────────────

  router.put('/:slug', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    // Slug guard: validate BEFORE any path.join (T-49-01-TRAVERSAL).
    if (!slug || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid slug' })
      return
    }

    const { content } = req.body as { content?: unknown }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' })
      return
    }

    const scriptDir = path.join(sensorsDir, slug)
    const scriptPath = path.join(scriptDir, 'sensor.mjs')
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(scriptPath, content, 'utf8')

    // Fire-and-forget — NEVER await. runSensor always resolves; errors go to
    // ambient/<slug>.md per Phase 48 design. Awaiting would delay the HTTP
    // response by up to SENSOR_TIMEOUT_MS (30s). (T-49-01-CODEEXEC is accepted.)
    void sensorRunner.run(slug)

    res.json({ slug })
  })

  // ─── DELETE /:slug — remove script dir AND ambient md ────────────────────

  router.delete('/:slug', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    // Slug guard: validate BEFORE any path.join (T-49-01-TRAVERSAL).
    if (!slug || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid slug' })
      return
    }

    // Remove the sensor script directory (recursive, force so ENOENT is swallowed).
    fs.rmSync(path.join(sensorsDir, slug), { recursive: true, force: true })
    // Remove the ambient output file (force:true swallows ENOENT — T-49-01-DELETE-ENOENT).
    fs.rmSync(path.join(ambientDir, `${slug}.md`), { force: true })

    res.json({ ok: true })
  })

  return router
}
