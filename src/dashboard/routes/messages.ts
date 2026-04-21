import * as fs from 'node:fs'
import * as path from 'node:path'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { MessageStore } from '../../db/messages.js'
import type { DashboardChannelAdapter } from '../../channels/dashboard/adapter.js'
import type { Attachment } from '../../types/core.js'
import { estimateTokens } from '../../db/token.js'

export function createMessagesRouter(messages: MessageStore, channelAdapter?: DashboardChannelAdapter, mediaDir?: string): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const all = messages.getAll()
    const withTokens = all.map(m => ({ ...m, tokens: estimateTokens([m]) }))
    res.json({ messages: withTokens })
  })

  router.post('/send', requireAuth, (req: Request, res: Response): void => {
    const { text, files } = req.body as { text?: string; files?: Array<{ name: string; mediaType: string; data?: string; textContent?: string }> }
    if ((!text || !text.trim()) && (!files || files.length === 0)) {
      res.status(400).json({ error: 'Missing text or files' })
      return
    }
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
        const dest = path.join(mediaDir, `${Date.now()}-${file.name}`)

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

    channelAdapter.injectMessage(messageText, attachments.length > 0 ? attachments : undefined)
    res.json({ ok: true })
  })

  return router
}
