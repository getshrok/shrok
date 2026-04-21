import * as fs from 'node:fs'
import * as path from 'node:path'
import { Bot } from 'grammy'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { Attachment } from '../../types/core.js'
import { log } from '../../logger.js'
import { formatTablesForChat } from '../table-formatter.js'
import { markdownToTelegramHtml } from './html.js'
import {
  parseVerboseMessage,
  collapseToolCall,
  collapseToolResult,
  expandVerboseMessage,
  tryParseInput,
  escapeHtml,
} from '../collapse.js'

// Cap collapse map at 500 entries (FIFO eviction) to prevent memory leaks
const COLLAPSE_MAP_MAX = 500

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram'
  private bot: Bot
  private chatId: string
  private mediaDir: string | undefined
  private handler: ((msg: InboundMessage) => void) | null = null

  // Collapse/expand state keyed by Telegram message ID
  private collapseMap = new Map<string, { collapsed: string; expanded: string }>()
  // Maps toolName -> FIFO queue of message IDs for edit-on-result pairing
  private pendingCalls = new Map<string, string[]>()

  constructor(token: string, chatId: string, mediaDir?: string) {
    this.chatId = chatId
    this.mediaDir = mediaDir
    this.bot = new Bot(token)

    this.bot.on('message', async ctx => {
      if (String(ctx.chat.id) !== this.chatId) return
      if (!this.handler) return

      const text = ctx.message.text ?? ctx.message.caption ?? ''
      const attachments: Attachment[] = []

      if (this.mediaDir) {
        // Photo — take the largest size
        if (ctx.message.photo?.length) {
          const photo = ctx.message.photo.at(-1)!
          const att = await this.downloadTelegramFile(photo.file_id, `photo-${photo.file_unique_id}.jpg`, 'image/jpeg')
          if (att) attachments.push({ ...att, type: 'image' })
        }
        // Voice note
        if (ctx.message.voice) {
          const v = ctx.message.voice
          const ext = v.mime_type?.split('/')[1] ?? 'ogg'
          const att = await this.downloadTelegramFile(v.file_id, `voice-${v.file_unique_id}.${ext}`, v.mime_type ?? 'audio/ogg')
          if (att) attachments.push({ ...att, type: 'audio', durationSeconds: v.duration })
        }
        // Audio file
        if (ctx.message.audio) {
          const a = ctx.message.audio
          const filename = a.file_name ?? `audio-${a.file_unique_id}`
          const att = await this.downloadTelegramFile(a.file_id, filename, a.mime_type ?? 'audio/mpeg')
          if (att) attachments.push({ ...att, type: 'audio', durationSeconds: a.duration })
        }
        // Document
        if (ctx.message.document) {
          const d = ctx.message.document
          const filename = d.file_name ?? `document-${d.file_unique_id}`
          const att = await this.downloadTelegramFile(d.file_id, filename, d.mime_type ?? 'application/octet-stream')
          if (att) {
            const type = (d.mime_type?.startsWith('image/') ? 'image' : 'document') as Attachment['type']
            attachments.push({ ...att, type })
          }
        }
      }

      this.handler({
        channel: this.id,
        text,
        ...(attachments.length ? { attachments } : {}),
        rawPayload: ctx.message,
      })
    })
  }

  private async downloadTelegramFile(
    fileId: string,
    filename: string,
    mediaType: string,
  ): Promise<Omit<Attachment, 'type'> | null> {
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) return null
      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) return null
      const buffer = Buffer.from(await res.arrayBuffer())
      const dest = path.join(this.mediaDir!, `${Date.now()}-${filename}`)
      fs.writeFileSync(dest, buffer)
      return { mediaType, filename, path: dest, size: buffer.length }
    } catch {
      return null
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // bot.start() runs long-polling and resolves when stopped — don't await it
    this.bot.start({ drop_pending_updates: true }).catch(err => {
      log.error('[telegram] Bot polling crashed:', (err as Error).message)
    })
    await this.bot.api.getMe()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async sendTyping(): Promise<void> {
    await this.bot.api.sendChatAction(this.chatId, 'typing')
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    const withTables = formatTablesForChat(text)
    const html = markdownToTelegramHtml(withTables)
    await this.bot.api.sendMessage(this.chatId, html, { parse_mode: 'HTML' })
    if (attachments?.length) {
      const { InputFile } = await import('grammy')
      for (const att of attachments) {
        if (!att.path) continue
        const file = new InputFile(att.path)
        if (att.type === 'image') await this.bot.api.sendPhoto(this.chatId, file)
        else if (att.type === 'audio') await this.bot.api.sendAudio(this.chatId, file)
        else if (att.type === 'video') await this.bot.api.sendVideo(this.chatId, file)
        else await this.bot.api.sendDocument(this.chatId, file)
      }
    }
  }

  async sendDebug(text: string): Promise<string | void> {
    const parsed = parseVerboseMessage(text)

    // Not a tool message — pass through to regular send
    if (!parsed) {
      return this.send(text)
    }

    if (parsed.direction === 'call') {
      const inputObj = tryParseInput(parsed.detail)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const headerLine = `${prefix}${collapseToolCall(parsed.toolName, inputObj)}`
      const expandedBody = expandVerboseMessage(text, 3900)

      const htmlText = `${escapeHtml(headerLine)}\n<blockquote expandable>${escapeHtml(expandedBody)}</blockquote>`
      const msg = await this.bot.api.sendMessage(this.chatId, htmlText, { parse_mode: 'HTML' })
      const msgId = String(msg.message_id)

      // Store in collapse map (FIFO eviction at cap)
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldest = this.collapseMap.keys().next().value
        if (oldest !== undefined) this.collapseMap.delete(oldest)
      }
      this.collapseMap.set(msgId, { collapsed: headerLine, expanded: expandedBody })
      const _pq = this.pendingCalls.get(parsed.toolName) ?? []
      _pq.push(msgId)
      this.pendingCalls.set(parsed.toolName, _pq)
      return msgId
    }

    if (parsed.direction === 'result') {
      const _rq = this.pendingCalls.get(parsed.toolName)
      const callMsgId = _rq?.shift()
      if (!_rq?.length) this.pendingCalls.delete(parsed.toolName)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const finalHeader = `${prefix}${collapseToolResult(parsed.toolName, parsed.detail)}`

      if (callMsgId) {
        const existing = this.collapseMap.get(callMsgId)
        const body = existing?.expanded ?? expandVerboseMessage(text, 3900)
        const htmlText = `${escapeHtml(finalHeader)}\n<blockquote expandable>${escapeHtml(body)}</blockquote>`
        try {
          await this.bot.api.editMessageText(this.chatId, Number(callMsgId), htmlText, { parse_mode: 'HTML' })
          if (existing) {
            this.collapseMap.set(callMsgId, { ...existing, collapsed: finalHeader })
          }
        } catch (err) {
          log.debug(`[telegram] sendDebug result edit failed:`, (err as Error).message)
          // Fall through — send a new standalone message
          const newMsg = await this.bot.api.sendMessage(this.chatId, htmlText, { parse_mode: 'HTML' })
          const newId = String(newMsg.message_id)
          if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
            const oldest = this.collapseMap.keys().next().value
            if (oldest !== undefined) this.collapseMap.delete(oldest)
          }
          this.collapseMap.set(newId, { collapsed: finalHeader, expanded: body })
          return newId
        }
        return callMsgId
      }

      // No pending call found — send standalone collapsed + blockquote
      const expandedBody = expandVerboseMessage(text, 3900)
      const htmlText = `${escapeHtml(finalHeader)}\n<blockquote expandable>${escapeHtml(expandedBody)}</blockquote>`
      const msg = await this.bot.api.sendMessage(this.chatId, htmlText, { parse_mode: 'HTML' })
      const msgId = String(msg.message_id)
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldest = this.collapseMap.keys().next().value
        if (oldest !== undefined) this.collapseMap.delete(oldest)
      }
      this.collapseMap.set(msgId, { collapsed: finalHeader, expanded: expandedBody })
      return msgId
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(this.chatId, Number(messageId), text)
    } catch (err) {
      log.debug(`[telegram] editMessage failed for ${messageId}:`, (err as Error).message)
    }
  }
}
