import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'

export interface TraceFile {
  filename: string
  sourceType: string
  sizeBytes: number
  modifiedAt: string
  isLatest: boolean
}

function safeFilename(name: string): boolean {
  // Must be alphanumeric + hyphens + dots, end in .log, no path separators
  return /^[a-zA-Z0-9._-]+\.log$/.test(name) && !name.includes('..')
}

export function createTracesRouter(traceDir: string): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    let files: TraceFile[] = []
    try {
      const entries = fs.readdirSync(traceDir)
      files = entries
        .filter(f => f.endsWith('.log') && safeFilename(f))
        .map(f => {
          const stat = fs.statSync(path.join(traceDir, f))
          const isLatest = f.endsWith('-latest.log')
          // Source type is the first segment before the first hyphen (or "latest")
          const sourceType = isLatest ? f.replace('-latest.log', '') : f.split('-')[0] ?? 'unknown'
          return {
            filename: f,
            sourceType,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            isLatest,
          }
        })
        // Symlinks (latest) float to top, then real files newest first
        .sort((a, b) => {
          if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1
          return b.modifiedAt.localeCompare(a.modifiedAt)
        })
    } catch {
      // trace dir doesn't exist yet — return empty list
    }
    res.json({ files, traceDir })
  })

  router.get('/:filename', requireAuth, (req: Request, res: Response): void => {
    const filename = req.params['filename'] as string
    if (!filename || !safeFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' })
      return
    }
    const filePath = path.join(traceDir, filename as string)
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      res.json({ filename: filename as string, content })
    } catch {
      res.status(404).json({ error: 'File not found' })
    }
  })

  return router
}
