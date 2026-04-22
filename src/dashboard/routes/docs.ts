import express from 'express'
import type { Request, Response, RequestHandler } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TITLE_HEADING_RE = /^#\s+(.+?)\s*$/m

/** "user-guide" → "User guide", "my_topic" → "My topic". */
function humanizeDirName(dir: string): string {
  const words = dir.replace(/[-_]+/g, ' ').trim()
  if (!words) return dir
  return words[0]!.toUpperCase() + words.slice(1).toLowerCase()
}

/** Discover group subdirectories of docsRoot that contain at least one .md. */
function discoverGroups(docsRoot: string): Array<{ dir: string; name: string }> {
  const entries = fs.readdirSync(docsRoot, { withFileTypes: true })
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .filter(name => {
      try {
        const sub = fs.readdirSync(path.join(docsRoot, name))
        return sub.some(f => f.endsWith('.md') && !f.startsWith('.'))
      } catch { return false }
    })

  return dirs.sort((a, b) => b.localeCompare(a)).map(dir => ({ dir, name: humanizeDirName(dir) }))
}

function extractTitle(filePath: string): string {
  const fallback = path.basename(filePath, '.md')
  try {
    // Read first ~4KB — more than enough for a leading # heading
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const n = fs.readSync(fd, buf, 0, 4096, 0)
      const head = buf.slice(0, n).toString('utf8')
      const m = head.match(TITLE_HEADING_RE)
      if (m?.[1]) return m[1].trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // fall through
  }
  return fallback
}

function listRootMarkdown(docsRoot: string): Array<{ path: string; title: string }> {
  const entries = fs.readdirSync(docsRoot, { withFileTypes: true })
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map(e => e.name)
  files.sort((a, b) => b.localeCompare(a))
  return files.map(name => ({
    path: name,
    title: extractTitle(path.join(docsRoot, name)),
  }))
}

function listGroup(docsRoot: string, dir: string): Array<{ path: string; title: string }> {
  const full = path.join(docsRoot, dir)
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return []
  const entries = fs.readdirSync(full, { withFileTypes: true })
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b))
  return files.map(name => ({
    path: `${dir}/${name}`,
    title: extractTitle(path.join(full, name)),
  }))
}

/**
 * Resolve a user-supplied relative path against docsRoot, rejecting:
 *  - empty / null-byte / absolute inputs
 *  - resolved paths outside docsRoot (including symlink escapes via fs.realpathSync)
 *
 * Returns the absolute filesystem path on success, or null if unsafe.
 * If the target does not yet exist (ENOENT), returns the logical resolved path
 * so the caller can produce a 404. Other errors surface as unsafe (null).
 */
function safeResolve(docsRoot: string, relative: unknown): string | null {
  if (typeof relative !== 'string' || relative === '') return null
  if (relative.includes('\0')) return null
  if (path.isAbsolute(relative)) return null

  const full = path.resolve(docsRoot, relative)
  // Logical boundary check first (catches `..`-style escapes before FS touches)
  if (full !== docsRoot && !full.startsWith(docsRoot + path.sep)) return null

  try {
    const real = fs.realpathSync(full)
    if (real !== docsRoot && !real.startsWith(docsRoot + path.sep)) return null
    return real
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Non-existent target — caller will 404.
      return full
    }
    return null
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

interface DocsHandlers {
  list: RequestHandler
  file: RequestHandler
}

function buildHandlers(docsDir: string): DocsHandlers {
  // Resolve and canonicalize the docs root once, at router construction time,
  // so subsequent symlink-containment checks have a stable base.
  const resolved = path.resolve(docsDir)
  let docsRoot: string
  try {
    docsRoot = fs.realpathSync(resolved)
  } catch {
    docsRoot = resolved
  }

  const list: RequestHandler = (_req: Request, res: Response): void => {
    try {
      const root = listRootMarkdown(docsRoot)
      const groups = discoverGroups(docsRoot).map(({ dir, name }) => ({
        name,
        files: listGroup(docsRoot, dir),
      }))
      res.json({ root, groups })
    } catch (err) {
      res.status(500).json({ error: `Failed to list docs: ${(err as Error).message}` })
    }
  }

  const file: RequestHandler = (req: Request, res: Response): void => {
    const raw = req.query['path']
    if (typeof raw !== 'string' || raw === '') {
      res.status(400).json({ error: 'path required' })
      return
    }
    const full = safeResolve(docsRoot, raw)
    if (full === null) {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'not found' })
      return
    }
    try {
      const content = fs.readFileSync(full, 'utf8')
      res.json({ content })
    } catch (err) {
      res.status(500).json({ error: `Failed to read file: ${(err as Error).message}` })
    }
  }

  return { list, file }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createDocsRouter(docsDir: string) {
  const router = express.Router()
  const handlers = buildHandlers(docsDir)
  router.get('/list', requireAuth, handlers.list)
  router.get('/file', requireAuth, handlers.file)
  return router
}

/**
 * Test-only helper — exposes the raw handlers without the requireAuth gate so
 * unit tests can mount them on a bare express app without faking sessions.
 * Do NOT use from production code.
 */
export function _createDocsHandlersForTest(docsDir: string): DocsHandlers {
  return buildHandlers(docsDir)
}
