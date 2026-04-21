import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { Attachment } from '../../types/core.js'
import { log } from '../../logger.js'
import { formatTablesForWhatsApp } from '../table-formatter.js'
import {
  parseVerboseMessage,
  collapseToolCall,
  collapseToolResult,
  expandVerboseMessage,
  tryParseInput,
} from '../collapse.js'

// Cap collapse map at 500 entries (FIFO eviction) to prevent memory leaks
const COLLAPSE_MAP_MAX = 500

// Baileys is an optional dependency — dynamically imported to avoid requiring
// GPL-licensed transitive deps (libsignal-node) in the core package.
// Users who want WhatsApp must: npm install @whiskeysockets/baileys

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let baileys: any = null

async function loadBaileys() {
  if (baileys) return baileys
  try {
    // @ts-expect-error — optional dependency, only installed when WhatsApp is configured
    baileys = await import('@whiskeysockets/baileys')
    return baileys
  } catch {
    throw new Error(
      'WhatsApp requires @whiskeysockets/baileys which is not installed.\n' +
      'Install it with: npm install @whiskeysockets/baileys\n' +
      'Then restart to connect.',
    )
  }
}

function makeSilentLogger() {
  const noop = (..._args: unknown[]) => {}
  const logger: Record<string, unknown> = {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
  logger['child'] = () => logger
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return logger as any
}

const MEDIA_MESSAGE_TYPES: Record<string, { type: Attachment['type']; mediaType: string; ext: string }> = {
  imageMessage:    { type: 'image',    mediaType: 'image/jpeg',       ext: 'jpg'  },
  audioMessage:    { type: 'audio',    mediaType: 'audio/ogg',        ext: 'ogg'  },
  videoMessage:    { type: 'video',    mediaType: 'video/mp4',        ext: 'mp4'  },
  documentMessage: { type: 'document', mediaType: 'application/octet-stream', ext: 'bin' },
  stickerMessage:  { type: 'image',    mediaType: 'image/webp',       ext: 'webp' },
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp'
  private authDir: string
  private allowedJid: string
  private qrPath: string
  private mediaDir: string | undefined
  private handler: ((msg: InboundMessage) => void) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sock: any = null
  private stopped = false
  private reconnectAttempts = 0
  private qrAttempts = 0
  private static readonly MAX_QR_ATTEMPTS = 3

  // Collapse/expand state keyed by WhatsApp message ID
  private collapseMap = new Map<string, { collapsed: string; expanded: string }>()
  // Maps toolName -> FIFO queue of message IDs for edit-on-result pairing
  private pendingCalls = new Map<string, string[]>()
  // External reaction handler
  private reactionHandler: ((messageId: string, emoji: string, userId: string) => void) | null = null
  // Store WAMessageKey by message ID for editing (typed as unknown since Baileys is optional)
  private messageKeys = new Map<string, unknown>()

  constructor(authDir: string, allowedJid: string, qrPath: string, mediaDir?: string) {
    this.authDir = authDir
    this.allowedJid = allowedJid
    this.qrPath = qrPath
    this.mediaDir = mediaDir
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    try { this.sock?.end(undefined) } catch { /* ignore */ }
    this.sock = null
  }

  async sendTyping(): Promise<void> {
    if (!this.sock) return
    await this.sock.sendPresenceUpdate('composing', this.allowedJid)
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected')
    const formatted = formatTablesForWhatsApp(text)
    await this.sock.sendMessage(this.allowedJid, { text: formatted })
    if (attachments?.length) {
      for (const att of attachments) {
        if (!att.path) continue
        const buffer = fs.readFileSync(att.path)
        if (att.type === 'image') await this.sock.sendMessage(this.allowedJid, { image: buffer })
        else if (att.type === 'audio') await this.sock.sendMessage(this.allowedJid, { audio: buffer })
        else if (att.type === 'video') await this.sock.sendMessage(this.allowedJid, { video: buffer })
        else await this.sock.sendMessage(this.allowedJid, { document: buffer, fileName: att.filename ?? path.basename(att.path), mimetype: att.mediaType })
      }
    }
  }

  onReaction(handler: (messageId: string, emoji: string, userId: string) => void): void {
    this.reactionHandler = handler
  }

  async sendDebug(text: string): Promise<string | void> {
    if (!this.sock) return this.send(text)

    const parsed = parseVerboseMessage(text)

    // Not a tool message — pass through to regular send
    if (!parsed) {
      return this.send(text)
    }

    if (parsed.direction === 'call') {
      const inputObj = tryParseInput(parsed.detail)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const collapsed = `${prefix}${collapseToolCall(parsed.toolName, inputObj)}`
      const expanded = expandVerboseMessage(text)

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const sent = await this.sock.sendMessage(this.allowedJid, { text: collapsed })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msgId: string = sent?.key?.id ?? String(Date.now())
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msgKey: unknown = sent?.key

      // Store message key for editing
      this.messageKeys.set(msgId, msgKey)

      // Store in collapse map (FIFO eviction at cap) — also evict from messageKeys
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldest = this.collapseMap.keys().next().value
        if (oldest !== undefined) {
          this.collapseMap.delete(oldest)
          this.messageKeys.delete(oldest)
        }
      }
      this.collapseMap.set(msgId, { collapsed, expanded })
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
      const finalCollapsed = `${prefix}${collapseToolResult(parsed.toolName, parsed.detail)}`

      if (callMsgId) {
        const storedKey = this.messageKeys.get(callMsgId)
        if (storedKey) {
          try {
            await this.sock.sendMessage(this.allowedJid, { text: finalCollapsed, edit: storedKey })
            // Update collapse map entry with new collapsed text
            const existing = this.collapseMap.get(callMsgId)
            if (existing) {
              this.collapseMap.set(callMsgId, { ...existing, collapsed: finalCollapsed })
            }
            return callMsgId
          } catch (err) {
            log.debug(`[whatsapp] sendDebug result edit failed for ${callMsgId}:`, (err as Error).message)
            // Fall through — send new message
          }
        }
      }

      // No pending call or edit failed — send as new collapsed message
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const sent = await this.sock.sendMessage(this.allowedJid, { text: finalCollapsed })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msgId: string = sent?.key?.id ?? String(Date.now())
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msgKey: unknown = sent?.key
      this.messageKeys.set(msgId, msgKey)
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldest = this.collapseMap.keys().next().value
        if (oldest !== undefined) {
          this.collapseMap.delete(oldest)
          this.messageKeys.delete(oldest)
        }
      }
      this.collapseMap.set(msgId, { collapsed: finalCollapsed, expanded: expandVerboseMessage(text) })
      return msgId
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    const storedKey = this.messageKeys.get(messageId)
    if (!storedKey) {
      log.debug(`[whatsapp] editMessage: no stored key for ${messageId}`)
      return
    }
    try {
      await this.sock.sendMessage(this.allowedJid, { text, edit: storedKey })
    } catch (err) {
      log.debug(`[whatsapp] editMessage failed for ${messageId}:`, (err as Error).message)
    }
  }

  private async connect(): Promise<void> {
    const b = await loadBaileys()
    const { createAuthState } = await import('./auth-state.js')
    const { state, saveCreds } = await createAuthState(this.authDir)
    const { version } = await b.fetchLatestBaileysVersion()

    const sock = b.default({
      version,
      auth: {
        creds: state.creds,
        keys: state.keys,
      },
      printQRInTerminal: false,
      logger: makeSilentLogger(),
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update: { connection?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } }; qr?: string }) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.qrAttempts++
        if (this.qrAttempts > WhatsAppAdapter.MAX_QR_ATTEMPTS) {
          log.warn(`[whatsapp] QR code not scanned after ${WhatsAppAdapter.MAX_QR_ATTEMPTS} attempts — giving up. Remove WHATSAPP_ALLOWED_JID from .env or scan the QR code on next restart.`)
          this.stopped = true
          sock.end(undefined)
          return
        }
        log.info(`[whatsapp] QR code ready (attempt ${this.qrAttempts}/${WhatsAppAdapter.MAX_QR_ATTEMPTS}) — open WhatsApp → Linked Devices → Link a Device and scan`)
        // Save QR as a PNG image in the media dir so agents/users can view it directly
        if (this.mediaDir) {
          try {
            const { default: qrcode } = await import('qrcode')
            const qrPngPath = path.join(this.mediaDir, 'whatsapp-qr.png')
            fs.mkdirSync(path.dirname(qrPngPath), { recursive: true })
            await qrcode.toFile(qrPngPath, qr, { width: 400, margin: 2 })
            log.info(`[whatsapp] QR image saved to: ${qrPngPath}`)
          } catch (err) {
            log.warn(`[whatsapp] Failed to save QR image: ${(err as Error).message}`)
          }
        }
        // Also write raw QR data to the text path for backward compatibility
        fs.writeFileSync(
          this.qrPath,
          `Scan with WhatsApp → Linked Devices → Link a Device\nGenerated: ${new Date().toISOString()}\n\n${qr}\n`,
          'utf8',
        )
        try {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error — qrcode-terminal is a transient Baileys dep with no type declarations
          const { default: qrcodeTerm } = await import('qrcode-terminal') as { default: { generate(data: string, opts: { small: boolean }, cb: (code: string) => void): void } }
          qrcodeTerm.generate(qr, { small: true }, (ascii: string) => {
            log.info('[whatsapp] QR code (scan with your phone):\n' + ascii)
          })
        } catch {
          // qrcode-terminal unavailable
        }
      }

      if (connection === 'open') {
        log.info('[whatsapp] Connected')
        this.qrAttempts = 0
        this.reconnectAttempts = 0
        try { fs.unlinkSync(this.qrPath) } catch { /* already gone */ }
        if (this.mediaDir) {
          try { fs.unlinkSync(path.join(this.mediaDir, 'whatsapp-qr.png')) } catch { /* already gone */ }
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
        if (statusCode === b.DisconnectReason.loggedOut) {
          log.warn('[whatsapp] Logged out — re-link the device by touching .reload-whatsapp or restarting')
          return
        }
        if (!this.stopped) {
          this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60_000)
          log.info(`[whatsapp] Connection closed, reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})…`)
          setTimeout(() => { void this.connect() }, delay)
        }
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (msg.key.fromMe) continue
        if (msg.key.remoteJid !== this.allowedJid) continue

        const text = msg.message?.conversation
          ?? msg.message?.extendedTextMessage?.text
          ?? ''

        const attachments: Attachment[] = []

        if (this.mediaDir && msg.message) {
          for (const [msgType, meta] of Object.entries(MEDIA_MESSAGE_TYPES)) {
            const mediaMsg = (msg.message as Record<string, unknown>)[msgType]
            if (!mediaMsg) continue
            try {
              const buffer = await b.downloadMediaMessage(msg, msgType.replace('Message', ''), {})
              if (buffer instanceof Buffer && buffer.length > 0) {
                const filename = (mediaMsg as Record<string, unknown>)['fileName'] as string | undefined ?? `${msgType}-${Date.now()}.${meta.ext}`
                const dest = path.join(this.mediaDir, `${Date.now()}-${filename}`)
                fs.writeFileSync(dest, buffer)
                const duration = (mediaMsg as Record<string, unknown>)['seconds'] as number | undefined
                attachments.push({
                  type: meta.type,
                  mediaType: (mediaMsg as Record<string, unknown>)['mimetype'] as string ?? meta.mediaType,
                  filename,
                  path: dest,
                  size: buffer.length,
                  ...(duration ? { durationSeconds: duration } : {}),
                })
              }
            } catch {
              // Skip if download fails
            }
            break
          }
        }

        if (!text && !attachments.length) continue
        if (!this.handler) continue

        this.handler({
          channel: this.id,
          text,
          ...(attachments.length ? { attachments } : {}),
          rawPayload: msg,
        })
      }
    })

    // Reaction-based expand/collapse: any reaction added → expand, removed → collapse.
    sock.ev.on('messages.reaction', (reactions: Array<{ key: { id?: string; remoteJid?: string; fromMe?: boolean }; reaction: { text: string } }>) => {
      for (const { key, reaction } of reactions) {
        // Only react to reactions on our own messages
        if (key.fromMe !== true) continue
        const msgId = key.id
        if (!msgId) continue

        const entry = this.collapseMap.get(msgId)
        if (!entry) continue

        const isAdd = !!reaction.text
        const newText = isAdd ? entry.expanded : entry.collapsed

        const storedKey = this.messageKeys.get(msgId)
        if (!storedKey) continue

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.sock.sendMessage(this.allowedJid, { text: newText, edit: storedKey }).catch((err: Error) => {
          log.debug(`[whatsapp] reaction edit failed for ${msgId}:`, err.message)
        })

        if (this.reactionHandler) {
          this.reactionHandler(msgId, reaction.text ?? '', '')
        }
      }
    })
  }
}
