import * as fs from 'node:fs'
import * as path from 'node:path'
import { Client, Events, GatewayIntentBits, Partials, type TextChannel } from 'discord.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { Attachment } from '../../types/core.js'
import { splitMessage } from '../chunker.js'
import { log } from '../../logger.js'
import { formatTablesForChat } from '../table-formatter.js'
import {
  parseVerboseMessage,
  collapseToolCall,
  collapseToolResult,
  expandVerboseMessage,
  tryParseInput,
} from '../collapse.js'

export { splitMessage }

// Cap collapse map at 500 entries (FIFO eviction) to prevent memory leaks
const COLLAPSE_MAP_MAX = 500

async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord'
  private client: Client
  private handler: ((msg: InboundMessage) => void) | null = null
  private channelId: string
  private token: string
  private mediaDir: string | undefined

  // Collapse/expand state keyed by Discord message ID
  private collapseMap = new Map<string, { collapsed: string; expanded: string }>()
  // Maps toolName -> FIFO queue of message IDs for edit-on-result pairing
  private pendingCalls = new Map<string, string[]>()
  // External reaction handler
  private reactionHandler: ((messageId: string, emoji: string, userId: string) => void) | null = null

  constructor(token: string, channelId: string, mediaDir?: string) {
    this.token = token
    this.channelId = channelId
    this.mediaDir = mediaDir
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
      ],
    })
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  onReaction(handler: (messageId: string, emoji: string, userId: string) => void): void {
    this.reactionHandler = handler
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, message => {
      if (message.author.bot) return
      if (message.channelId !== this.channelId) return
      if (!this.handler) return

      // Process attachments asynchronously (download + classify)
      void this.processMessage(message)
    })

    // Reaction-based expand/collapse: any reaction added → expand, any removed → collapse.
    // No special emoji needed — user clicks any emoji to see the full tool call, clicks again to hide.
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return
      if (reaction.partial) { try { await reaction.fetch() } catch { return } }
      if (reaction.message.partial) { try { await reaction.message.fetch() } catch { return } }
      if (reaction.message.author?.id !== this.client.user?.id) return

      const messageId = reaction.message.id
      const entry = this.collapseMap.get(messageId)
      if (!entry) return

      try {
        await reaction.message.edit(entry.expanded)
      } catch (err) {
        log.debug(`[discord] reaction expand failed for ${messageId}:`, (err as Error).message)
      }

      if (this.reactionHandler) {
        this.reactionHandler(messageId, reaction.emoji.name ?? '', user.id)
      }
    })

    this.client.on(Events.MessageReactionRemove, async (reaction, user) => {
      if (user.bot) return
      if (reaction.partial) { try { await reaction.fetch() } catch { return } }
      if (reaction.message.partial) { try { await reaction.message.fetch() } catch { return } }
      if (reaction.message.author?.id !== this.client.user?.id) return

      const messageId = reaction.message.id
      const entry = this.collapseMap.get(messageId)
      if (!entry) return

      // Only collapse back if no user reactions remain
      const userReactions = reaction.message.reactions.cache.some(
        r => r.count > (r.me ? 1 : 0)
      )
      if (userReactions) return

      try {
        await reaction.message.edit(entry.collapsed)
      } catch (err) {
        log.debug(`[discord] reaction collapse failed for ${messageId}:`, (err as Error).message)
      }
    })

    // Catch client-level errors so they don't crash the process as unhandled events.
    this.client.on('error', err => {
      log.error('[discord] Client error:', err.message)
    })

    await this.client.login(this.token)
    await new Promise<void>(resolve => {
      this.client.once(Events.ClientReady, () => resolve())
    })
  }

  private async processMessage(message: import('discord.js').Message): Promise<void> {
    if (!this.handler) return

    const attachments: Attachment[] = []
    const inlinedTexts: string[] = []

    for (const [, att] of message.attachments) {
      const mediaType = att.contentType ?? 'application/octet-stream'

      try {
        const type: Attachment['type'] =
          mediaType.startsWith('image/') ? 'image'
          : mediaType.startsWith('audio/') ? 'audio'
          : mediaType.startsWith('video/') ? 'video'
          : 'document'

        if (this.mediaDir) {
          const filename = att.name ?? `${Date.now()}.bin`
          const dest = path.join(this.mediaDir, `${Date.now()}-${filename}`)
          const buf = await fetchToBuffer(att.url)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, buf)

          // Images/audio/video: proper attachments for native provider handling
          // Everything else: give the model a path to read
          if (type === 'image' || type === 'audio' || type === 'video') {
            attachments.push({ type, mediaType, filename: att.name ?? undefined, path: dest, size: att.size })
          } else {
            inlinedTexts.push(`[File: ${filename} saved to ${dest}]`)
          }
        } else {
          // No mediaDir: store URL (will expire, but best we can do)
          attachments.push({ type, mediaType, filename: att.name ?? undefined, url: att.url, size: att.size })
        }
      } catch (err) {
        log.warn(`[discord] Failed to process attachment ${att.name}: ${(err as Error).message}`)
        inlinedTexts.push(`[Attached: ${att.name ?? 'file'} (${mediaType}) — failed to download]`)
      }
    }

    // Build final message text with any inlined file contents
    let text = message.content
    if (inlinedTexts.length > 0) {
      text = text ? `${text}\n\n${inlinedTexts.join('\n\n')}` : inlinedTexts.join('\n\n')
    }

    this.handler({
      channel: this.id,
      text,
      ...(attachments.length ? { attachments } : {}),
      rawPayload: message,
    })
  }

  async stop(): Promise<void> {
    this.client.destroy()
  }

  async sendTyping(): Promise<void> {
    const channel = await this.client.channels.fetch(this.channelId)
    if (channel?.isTextBased()) {
      await (channel as TextChannel).sendTyping()
    }
  }

  async send(text: string, attachments?: Attachment[]): Promise<string | void> {
    const formatted = formatTablesForChat(text)
    const channel = await this.client.channels.fetch(this.channelId)
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${this.channelId} is not a text channel`)
    }
    const textChannel = channel as TextChannel
    const files = attachments?.filter(a => a.path).map(a => ({
      attachment: a.path!,
      name: a.filename ?? path.basename(a.path!),
    })) ?? []
    const chunks = splitMessage(formatted)
    let lastMessageId: string | undefined
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      let sent: import('discord.js').Message
      if (isLast && files.length) {
        sent = await textChannel.send({ content: chunks[i]!, files })
      } else {
        sent = await textChannel.send(chunks[i]!)
      }
      lastMessageId = sent.id
    }
    return lastMessageId
  }

  async sendDebug(text: string): Promise<string | void> {
    const parsed = parseVerboseMessage(text)

    // Not a tool message — pass through to regular send
    if (!parsed) {
      return this.send(text)
    }

    const channel = await this.client.channels.fetch(this.channelId)
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${this.channelId} is not a text channel`)
    }
    const textChannel = channel as TextChannel

    if (parsed.direction === 'call') {
      const inputObj = tryParseInput(parsed.detail)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const collapsed = `${prefix}${collapseToolCall(parsed.toolName, inputObj)}`
      const expanded = expandVerboseMessage(text)

      // Send the collapsed version (no bot reaction — user adds any emoji to expand)
      const sentMsg = await textChannel.send(collapsed)

      // Store in collapse map (FIFO eviction at cap)
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldestKey = this.collapseMap.keys().next().value
        if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
      }
      this.collapseMap.set(sentMsg.id, { collapsed, expanded })

      // Track pending call for edit-on-result
      const _pq = this.pendingCalls.get(parsed.toolName) ?? []
      _pq.push(sentMsg.id)
      this.pendingCalls.set(parsed.toolName, _pq)

      return sentMsg.id
    }

    if (parsed.direction === 'result') {
      const _rq = this.pendingCalls.get(parsed.toolName)
      const callMsgId = _rq?.shift()
      if (!_rq?.length) this.pendingCalls.delete(parsed.toolName)
      const prefix = parsed.agentPrefix ? `${parsed.agentPrefix} ` : ''
      const finalCollapsed = `${prefix}${collapseToolResult(parsed.toolName, parsed.detail)}`

      if (callMsgId) {
        // Edit the original call message to show the final status
        try {
          const msg = await textChannel.messages.fetch(callMsgId)
          await msg.edit(finalCollapsed)
          // Update the collapse map entry with the result-aware collapsed text
          const existing = this.collapseMap.get(callMsgId)
          if (existing) {
            this.collapseMap.set(callMsgId, { ...existing, collapsed: finalCollapsed })
          }
        } catch (err) {
          log.debug(`[discord] sendDebug result edit failed for ${callMsgId}:`, (err as Error).message)
          // Fall through — send a new message
          const sentMsg = await textChannel.send(finalCollapsed)
          if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
            const oldestKey = this.collapseMap.keys().next().value
            if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
          }
          this.collapseMap.set(sentMsg.id, { collapsed: finalCollapsed, expanded: expandVerboseMessage(text) })
          return sentMsg.id
        }
        return callMsgId
      }

      // No pending call found — send as collapsed result
      const sentMsg = await textChannel.send(finalCollapsed)
      if (this.collapseMap.size >= COLLAPSE_MAP_MAX) {
        const oldestKey = this.collapseMap.keys().next().value
        if (oldestKey !== undefined) this.collapseMap.delete(oldestKey)
      }
      this.collapseMap.set(sentMsg.id, { collapsed: finalCollapsed, expanded: expandVerboseMessage(text) })
      return sentMsg.id
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(this.channelId) as TextChannel
    if (!channel) return
    try {
      const msg = await channel.messages.fetch(messageId)
      await msg.edit(text)
    } catch (err) {
      log.debug(`[discord] editMessage failed for ${messageId}:`, (err as Error).message)
    }
  }
}
