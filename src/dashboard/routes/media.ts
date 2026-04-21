import { Router, Request, Response } from 'express'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { requireAuth } from '../auth.js'

export function createMediaRouter(mediaDir: string): Router {
  const router = Router()

  // Auth required — workspace media/ contains user files from agent work.
  router.get('/:filename', requireAuth, (req: Request, res: Response): void => {
    const filename = String(req.params['filename'])
    const resolved = path.resolve(mediaDir, filename)

    // Path traversal protection
    const base = path.resolve(mediaDir)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      res.status(400).send('Invalid path')
      return
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).send('Not found')
      return
    }

    res.sendFile(resolved)
  })

  return router
}
