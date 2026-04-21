import * as fs from 'node:fs'
import * as path from 'node:path'
import { App, LogLevel } from '@slack/bolt'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { Attachment } from '../../types/core.js'
import { log } from '../../logger.js'
import {
  parseVerboseMessage,
  collapseToolCall,
  collapseToolResult,
  expandVerboseMessage,
  tryParseInput,
} from '../collapse.js'
import { markdownToMrkdwn } from './mrkdwn.js'
import { formatTablesForSlack } from '../table-formatter.js'

// Cap collapse map at 500 entries (FIFO eviction) to prevent memory leaks
const COLLAPSE_MAP_MAX = 500

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack'
  private app: App
  private botToken: string
  private channelId: string
  private mediaDir: string | undefined
  private handler: ((msg: InboundMessage) => void) | null = null

  // Collapse/expand state keyed by Slack message ts
  private collapseMap = new Map<string, { collapsed: string; expanded: string }>()
  // Maps toolName -> FIFO queue of message ts for edit-on-result pairing
  private pendingCalls = new Map<string, string[]>()
  // External reaction handler
  private reactionHandler: ((messageId: string, emoji: string, userId: string) => void) | null = null
  // Bot user ID for reaction self-filtering
  private botUserId: string | null = null

  constructor(botToken: string, appToken: string, channelId: string, mediaDir?: string) {
    this.botToken = botToken
    this.channelId = channelId
    this.mediaDir = mediaDir
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    })

    this.app.message(async ({ message }) => {
      if (!('channel' in message) || message.channel !== this.channelId) return
      // Allow file_share subtype (file/image uploads); drop everything else (joins, topic changes, etc.)
      if ('subtype' in message && message.subtype && message.subtype !== 'file_share') return
      if ('bot_id' in message && message.bot_id) return
      if (!this.handler) return

      const text = ('text' in message && message.text) ? message.text : ''
      const attachments: Attachment[] = []

      const rawMsg = message as unknown as Record<string, unknown>
      if (this.mediaDir && 'files' in message && Array.isArray(rawMsg['files'])) {
        const files = rawMsg['files'] as Array<{
          url_private?: string
          mimetype?: string
          name?: string
          size?: number
        }>
        log.info(`[slack] Received ${files.length} file(s) in message`)
        for (const file of files) {
          if (!file.url_private || !file.mimetype) {
            log.warn(`[slack] Skipping file — missing url_private or mimetype: ${JSON.stringify(file)}`)
            continue
          }
          const att = await this.downloadSlackFile(file.url_private, file.name ?? 'file', file.mimetype, file.size)
          if (att) {
            attachments.push(att)
            log.info(`[slack] Downloaded attachment: ${att.filename} → ${att.path}`)
          } else {
            log.warn(`[slack] Failed to download file: ${file.name} (${file.mimetype})`)
          }
        }
      } else if ('subtype' in message && message.subtype === 'file_share') {
        log.warn(`[slack] file_share message has no files array: ${JSON.stringify(rawMsg).slice(0, 300)}`)
      }

      this.handler({
        channel: this.id,
        text,
        ...(attachments.length ? { attachments } : {}),
        rawPayload: message,
      })
    })

    // Reaction-based expand/collapse: any reaction added → expand, any removed → collapse.
    // No special emoji needed — user adds any emoji to see the full tool call, removes to hide.
    this.app.event('reaction_added', async ({ event }) => {
      if (event.user === this.botUserId) return
      if (event.item.channel !== this.channelId) return
      if (event.item.type !== 'message') return

      const messageTs = event.item.ts
      const entry = this.collapseMap.get(messageTs)
      if (!entry) {
        if (this.reactionHandler) this.reactionHandler(messageTs, event.reaction, event.user)
        return
      }

      try {
        await this.app.client.chat.update({ channel: this.channelId, ts: messageTs, text: entry.expanded })
      } catch (err) {
        log.warn(`[slack] reaction expand failed for ${messageTs}:`, (err as Error).message)
      }

      if (this.reactionHandler) this.reactionHandler(messageTs, event.reaction, event.user)
    })

    this.app.event('reaction_removed', async ({ event }) => {
      if (event.user === this.botUserId) return
      if (event.item.channel !== this.channelId) return
      if (event.item.type !== 'message') return

      const messageTs = event.item.ts
      const entry = this.collapseMap.get(messageTs)
      if (!entry) return

      try {
        await this.app.client.chat.update({ channel: this.channelId, ts: messageTs, text: entry.collapsed })
      } catch (err) {
        log.warn(`[slack] reaction collapse failed for ${messageTs}:`, (err as Error).message)
      }
    })
  }

  private async downloadSlackFile(
    url: string,
    filename: string,
    mediaType: string,
    size?: number,
  ): Promise<Attachment | null> {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      })
      if (!res.ok) {
        log.warn(`[slack] File download failed: ${res.status} ${res.statusText} for ${url}`)
        return null
      }
      const contentType = res.headers.get('content-type') ?? 'unknown'
      const buffer = Buffer.from(await res.arrayBuffer())
      // Check for HTML error page instead of actual file (happens when bot lacks files:read scope)
      const first16 = buffer.subarray(0, 16).toString('hex')
      log.info(`[slack] Downloaded ${buffer.length} bytes, content-type: ${contentType}, first16: ${first16}`)
      if (contentType.includes('html') || buffer.subarray(0, 15).toString('ascii').toLowerCase().includes('<!doctype') || buffer.subarray(0, 5).toString('ascii').toLowerCase() === '<html') {
        log.warn(`[slack] Downloaded file is HTML, not the actual file — bot likely lacks files:read scope or the token is wrong`)
        return null
      }
      const dest = path.join(this.mediaDir!, `${Date.now()}-${filename}`)
      fs.writeFileSync(dest, buffer)
      const type: Attachment['type'] =
        mediaType.startsWith('image/') ? 'image'
        : mediaType.startsWith('audio/') ? 'audio'
        : mediaType.startsWith('video/') ? 'video'
        : 'document'
      return { type, mediaType, filename, path: dest, size: size ?? buffer.length }
    } catch (err) {
      log.warn(`[slack] File download threw: ${(err as Error).message}`)
      return null
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  onReaction(handler: (messageId: string, emoji: string, userId: string) => void): void {
    this.reactionHandler = handler
  }

  async start(): Promise<void> {
    await this.app.start()
    // Resolve bot user ID for reaction self-filtering
    try {
      const auth = await this.app.client.auth.test()
      this.botUserId = auth.user_id as string
    } catch (err) {
      log.warn('[slack] Failed to resolve bot user ID — reaction self-filtering disabled:', (err as Error).message)
    }
  }

  async stop(): Promise<void> {
    await this.app.stop()
  }

  async send(text: string, attachments?: Attachment[]): Promise<string | void> {
    const tableResult = formatTablesForSlack(text)
    const mrkdwnFallback = markdownToMrkdwn(tableResult.text)
    const result = tableResult.blocks
      ? await this.app.client.chat.postMessage({
          channel: this.channelId,
          text: mrkdwnFallback,
          blocks: tableResult.blocks,
        })
      : await this.app.client.chat.postMessage({
          channel: this.channelId,
          text: mrkdwnFallback,
        })
    if (attachments?.length) {
      for (const att of attachments) {
        if (!att.path) continue
        await this.app.client.files.uploadV2({
          channel_id: this.channelId,
          file: fs.createReadStream(att.path),
          filename: att.filename ?? path.basename(att.path),
        })
      }
    }
    return result.ts
  }

  async sendDebug(text: string): Promise<string | void> {
    const parsed = parseVerboseMessage(text)
    if (!parsed) return this.send(text)

    if (parsed.direction === 'call') {
      const inputObj = tryParseInput(parsed.detail)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const collapsed = `${prefix}${collapseToolCall(parsed.toolName, inputObj)}`
      const expanded = expandVerboseMessage(text)

      const result = await this.app.client.chat.postMessage({ channel: this.channelId, text: collapsed })
      const msgTs = result.ts as string


      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldestKey = this.collapseMap.keys().next().value
        if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
      }
      this.collapseMap.set(msgTs, { collapsed, expanded })
      const _pq = this.pendingCalls.get(parsed.toolName) ?? []
      _pq.push(msgTs)
      this.pendingCalls.set(parsed.toolName, _pq)
      return msgTs
    }

    if (parsed.direction === 'result') {
      const _rq = this.pendingCalls.get(parsed.toolName)
      const callMsgTs = _rq?.shift()
      if (!_rq?.length) this.pendingCalls.delete(parsed.toolName)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const finalCollapsed = `${prefix}${collapseToolResult(parsed.toolName, parsed.detail)}`

      if (callMsgTs) {
        try {
          await this.app.client.chat.update({ channel: this.channelId, ts: callMsgTs, text: finalCollapsed })
          const existing = this.collapseMap.get(callMsgTs)
          if (existing) {
            this.collapseMap.set(callMsgTs, { ...existing, collapsed: finalCollapsed })
          }
        } catch (err) {
          log.debug(`[slack] sendDebug result edit failed for ${callMsgTs}:`, (err as Error).message)
          const result = await this.app.client.chat.postMessage({ channel: this.channelId, text: finalCollapsed })
          const msgTs = result.ts as string
              if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
            const oldestKey = this.collapseMap.keys().next().value
            if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
          }
          this.collapseMap.set(msgTs, { collapsed: finalCollapsed, expanded: expandVerboseMessage(text) })
          return msgTs
        }
        return callMsgTs
      }

      // No pending call found — send as collapsed result with reaction
      const result = await this.app.client.chat.postMessage({ channel: this.channelId, text: finalCollapsed })
      const msgTs = result.ts as string
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldestKey = this.collapseMap.keys().next().value
        if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
      }
      this.collapseMap.set(msgTs, { collapsed: finalCollapsed, expanded: expandVerboseMessage(text) })
      return msgTs
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.app.client.chat.update({ channel: this.channelId, ts: messageId, text })
    } catch (err) {
      log.debug(`[slack] editMessage failed for ${messageId}:`, (err as Error).message)
    }
  }
}
