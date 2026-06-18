import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'
import { safeFilename, MAX_VIEW_BYTES } from '../../skills/loader.js'
import type { SkillFile, ReadFileResult } from '../../types/skill.js'

// Path-traversal mitigation (T-49-01-TRAVERSAL): validate slug BEFORE any path.join.
// Mirrors the guard in src/sensors/runner.ts — lowercase alphanumeric + hyphens only.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// The per-sensor marker file. Like SKILL.md/TASK.md for skills/tasks, it is protected:
// it cannot be deleted or renamed via the file routes (delete the sensor instead).
const MARKER = 'sensor.mjs'

export function createSensorsRouter(opts: {
  workspacePath: string
}): Router {
  const { workspacePath } = opts
  const sensorsDir = path.join(workspacePath, 'sensors')
  const ambientDir = path.join(workspacePath, 'ambient')
  const router = Router()

  // ─── File-op helpers (scoped to sensors/<slug>/) ─────────────────────────
  // Resolve a sensor's directory, confining the result under sensorsDir.
  // Mirrors FileSystemKindLoader.resolveSkillDir (src/skills/loader.ts).
  function resolveSensorDir(slug: string): string {
    const dir = path.resolve(path.join(sensorsDir, slug))
    const base = path.resolve(sensorsDir)
    if (dir !== base && !dir.startsWith(base + path.sep)) {
      throw new Error('Sensor path escapes sensors directory')
    }
    return dir
  }

  // Resolve a file within a sensor dir, confining the result under that dir.
  // Caller must have already validated `filename` with safeFilename.
  function resolveSensorFile(sensorDir: string, filename: string): string {
    const filePath = path.resolve(path.join(sensorDir, filename))
    const resolvedDir = path.resolve(sensorDir)
    if (!filePath.startsWith(resolvedDir + path.sep)) {
      throw new Error('File path escapes sensor directory')
    }
    return filePath
  }

  // List files in a sensor dir as SkillFile[] — marker first, then alphabetical.
  // Mirrors FileSystemKindLoader.listFiles.
  function listSensorFiles(sensorDir: string): SkillFile[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(sensorDir, { withFileTypes: true })
    } catch {
      return []
    }
    const files: SkillFile[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(path.join(sensorDir, entry.name))
        files.push({ name: entry.name, size: stat.size, isProtected: entry.name === MARKER })
      } catch { /* skip files we can't stat */ }
    }
    files.sort((a, b) => {
      if (a.name === MARKER) return -1
      if (b.name === MARKER) return 1
      return a.name.localeCompare(b.name)
    })
    return files
  }

  // Read a file with binary/too-large gating. Mirrors FileSystemKindLoader.readFile.
  function readSensorFile(filePath: string): ReadFileResult {
    const size = fs.statSync(filePath).size
    if (size > MAX_VIEW_BYTES) return { tooLarge: true, size }
    const fd = fs.openSync(filePath, 'r')
    const sniffBuf = Buffer.allocUnsafe(8192)
    const bytesRead = fs.readSync(fd, sniffBuf, 0, sniffBuf.length, 0)
    fs.closeSync(fd)
    if (sniffBuf.subarray(0, bytesRead).includes(0)) return { binary: true, size }
    return { content: fs.readFileSync(filePath, 'utf8'), binary: false, tooLarge: false, size }
  }

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

    const sensorDir = path.join(sensorsDir, slug)
    const scriptPath = path.join(sensorDir, MARKER)
    if (!fs.existsSync(scriptPath)) {
      res.status(404).json({ error: `Sensor not found: ${slug}` })
      return
    }
    const content = fs.readFileSync(scriptPath, 'utf8')
    // `content` (the marker) stays for back-compat; `files` lets the editor show all siblings.
    res.json({ slug, content, files: listSensorFiles(sensorDir) })
  })

  // ─── File-level routes (registered BEFORE the /:slug catch-alls) ─────────
  // A sensor dir is structurally identical to a skill/task dir: a marker file
  // (sensor.mjs) plus arbitrary siblings. These mirror the task file routes in
  // src/dashboard/routes/kind.ts so the dashboard can edit every file, not just
  // the marker.

  // GET /:slug/files — list all files in the sensor dir.
  router.get('/:slug/files', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    const sensorDir = resolveSensorDir(slug)
    if (!fs.existsSync(path.join(sensorDir, MARKER))) {
      res.status(404).json({ error: `Sensor not found: ${slug}` })
      return
    }
    res.json({ files: listSensorFiles(sensorDir) })
  })

  // GET /:slug/files/:filename — read a single file (gated for binary/too-large).
  router.get('/:slug/files/:filename', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    const filename = req.params['filename'] as string
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    if (!filename || !safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const sensorDir = resolveSensorDir(slug)
    const filePath = resolveSensorFile(sensorDir, filename)
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: `File not found: ${filename}` }); return }
    res.json(readSensorFile(filePath))
  })

  // PUT /:slug/files/:filename — create or overwrite a file (atomic).
  router.put('/:slug/files/:filename', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    const filename = req.params['filename'] as string
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    if (!filename || !safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const { content } = req.body as { content?: unknown }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return }
    const sensorDir = resolveSensorDir(slug)
    if (!fs.existsSync(path.join(sensorDir, MARKER))) {
      res.status(404).json({ error: `Sensor not found: ${slug}` })
      return
    }
    const filePath = resolveSensorFile(sensorDir, filename)
    const tempPath = path.join(os.tmpdir(), `sensorfile_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    fs.writeFileSync(tempPath, content, 'utf8')
    fs.renameSync(tempPath, filePath)
    res.json({ ok: true })
  })

  // DELETE /:slug/files/:filename — delete a sibling file. The marker is protected.
  router.delete('/:slug/files/:filename', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    const filename = req.params['filename'] as string
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    if (!filename || !safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    if (filename === MARKER) { res.status(400).json({ error: `Cannot delete ${MARKER} — delete the sensor instead` }); return }
    const sensorDir = resolveSensorDir(slug)
    const filePath = resolveSensorFile(sensorDir, filename)
    try {
      fs.unlinkSync(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `File not found: ${filename}` })
        return
      }
      throw err
    }
    res.json({ ok: true })
  })

  // POST /:slug/files/:filename/rename — rename a sibling file. The marker is protected.
  router.post('/:slug/files/:filename/rename', requireAuth, (req: Request, res: Response): void => {
    const slug = req.params['slug'] as string
    const filename = req.params['filename'] as string
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    if (!filename || !safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    if (filename === MARKER) { res.status(400).json({ error: `Cannot rename ${MARKER}` }); return }
    const { newName } = req.body as { newName?: unknown }
    if (typeof newName !== 'string' || !safeFilename(newName)) { res.status(400).json({ error: 'Invalid new filename' }); return }
    if (newName === MARKER) { res.status(400).json({ error: `Cannot overwrite ${MARKER}` }); return }
    const sensorDir = resolveSensorDir(slug)
    const oldPath = resolveSensorFile(sensorDir, filename)
    const newPath = resolveSensorFile(sensorDir, newName)
    if (!fs.existsSync(oldPath)) { res.status(404).json({ error: `File not found: ${filename}` }); return }
    fs.renameSync(oldPath, newPath)
    res.json({ ok: true })
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
    const scriptPath = path.join(scriptDir, MARKER)
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(scriptPath, content, 'utf8')

    // Creating (or overwriting) a sensor never runs it — a sensor runs ONLY when a
    // schedule fires it. Scheduling a cron sensor sets nextRun=now (see the schedule
    // route + create_schedule tool), so it produces ambient output right after it's
    // scheduled. To preview a script before scheduling, run it directly with `node`.
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
    // Remove the per-head ambient output file across all head subdirectories.
    // The route has no headId in scope and a slug is globally unique on disk (one sensors/<slug>/
    // dir), so sweep ambient/<head>/<slug>.md across every head subdir.
    // force:true on each rmSync swallows ENOENT (T-51-04-DELALL).
    // SLUG_RE was already validated above — no attacker-controlled path segment below this line.
    // Head subdir names come from readdirSync (existing on-disk dirs the runner created),
    // not from the request — no attacker-controlled traversal (T-51-04-PT).
    try {
      const headEntries = fs.readdirSync(ambientDir, { withFileTypes: true })
      for (const entry of headEntries) {
        if (entry.isDirectory()) {
          fs.rmSync(path.join(ambientDir, entry.name, `${slug}.md`), { force: true })
        }
      }
    } catch {
      // ambient/ dir absent — nothing to remove (swallow ENOENT).
    }

    res.json({ ok: true })
  })

  return router
}
