import * as fs from 'node:fs'
import * as path from 'node:path'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { MessageStore } from '../../db/messages.js'
import type { DashboardChannelAdapter } from '../../channels/dashboard/adapter.js'
import type { Attachment } from '../../types/core.js'
import { estimateTokens } from '../../db/token.js'

export function createMessagesRouter(messages: MessageStore, dashboardAdapters: Map<string, DashboardChannelAdapter>, mediaDir?: string): Router {
  const router = Router()

  router.get('/', requireAuth, (req: Request, res: Response): void => {
    // Phase 32 (DASH-02 / D-05): scope to ?head=<id>; default to 'default' for
    // backward compatibility. typeof guard rejects array-parsed values from
    // repeated ?head=a&head=b queries (Pitfall: prepared-statement type error).
    const headId = typeof req.query['head'] === 'string' ? req.query['head'] : 'default'
    const all = messages.getAll(headId)
    const withTokens = all.map(m => ({ ...m, tokens: estimateTokens([m]) }))
    res.json({ messages: withTokens })
  })

  router.post('/send', requireAuth, (req: Request, res: Response): void => {
    const { text, headId, files } = req.body as {
      text?: string
      headId?: string
      files?: Array<{ name: string; mediaType: string; data?: string; textContent?: string }>
    }
    if ((!text || !text.trim()) && (!files || files.length === 0)) {
      res.status(400).json({ error: 'Missing text or files' })
      return
    }
    // Phase 33 D-10: route by body.headId; fall back to the first
    // adapter when headId is missing or unknown (preserves
    // single-head deployment behavior — the only entry's headId is
    // 'default'). exactOptionalPropertyTypes-safe: explicit string check.
    const requested = typeof headId === 'string' ? dashboardAdapters.get(headId) : undefined
    const channelAdapter = requested ?? dashboardAdapters.values().next().value
    if (!channelAdapter) {
      res.status(503).json({ error: 'Dashboard channel not available' })
      return
    }

    let messageText = text?.trim() ?? ''
    const attachments: Attachment[] = []

    if (files && files.length > 0 && mediaDir) {
      fs.mkdirSync(mediaDir, { recursive: true })
      for (const file of files) {
        const mediaType = file.mediaType || 'application/octet-stream'
        // Security: strip path components — only the final filename segment is safe.
        // Replace any character that is not alphanumeric, dot, dash, or underscore with '_'.
        const safeName = path.basename(file.name).replace(/[^\w.\-]/g, '_') || 'upload'
        const dest = path.join(mediaDir, `${Date.now()}-${safeName}`)
        // Defense-in-depth: verify the resolved path stays inside mediaDir.
        const resolved = path.resolve(dest)
        if (!resolved.startsWith(path.resolve(mediaDir) + path.sep)) {
          res.status(400).json({ error: 'Invalid filename' })
          return
        }

        if (file.textContent !== undefined) {
          fs.writeFileSync(dest, file.textContent, 'utf8')
        } else if (file.data) {
          fs.writeFileSync(dest, Buffer.from(file.data, 'base64'))
        } else {
          continue
        }

        const type: Attachment['type'] =
          mediaType.startsWith('image/') ? 'image'
          : mediaType.startsWith('audio/') ? 'audio'
          : mediaType.startsWith('video/') ? 'video'
          : 'document'

        attachments.push({ type, mediaType, filename: file.name, path: dest })
      }
    } else if (files && files.length > 0) {
      for (const file of files) {
        messageText += `\n\n[Attached: ${file.name} (${file.mediaType}) — file storage not configured]`
      }
    }

    const senderName = typeof res.locals['user'] === 'string' ? (res.locals['user'] as string) : undefined
    channelAdapter.injectMessage(messageText, attachments.length > 0 ? attachments : undefined, senderName)
    res.json({ ok: true })
  })

  return router
}
