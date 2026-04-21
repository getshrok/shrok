// ─── Inbound message ─────────────────────────────────────────────────────────

import type { Attachment } from './core.js'

export interface InboundMessage {
  channel: string          // unique channel ID (e.g. 'discord', 'telegram', 'voice')
  text: string
  attachments?: Attachment[]
  rawPayload?: unknown
}

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface ChannelAdapter {
  id: string               // e.g. 'discord'
  start(): Promise<void>
  stop(): Promise<void>
  send(text: string, attachments?: Attachment[]): Promise<string | void>
  onMessage(handler: (msg: InboundMessage) => void): void
  sendTyping?(): Promise<void>
  /** Optional: send a debug/xray message via a separate path. If absent, falls back to send(). */
  sendDebug?(text: string): Promise<string | void>
  /** Optional: register a handler for message reactions. */
  onReaction?(handler: (messageId: string, emoji: string, userId: string) => void): void
  /** Optional: edit a previously sent message by its ID. */
  editMessage?(messageId: string, text: string): Promise<void>
}

// ─── Router interface ─────────────────────────────────────────────────────────

export interface ChannelRouter {
  register(adapter: ChannelAdapter): void
  send(channelId: string, text: string, attachments?: Attachment[]): Promise<string | void>
  /** Send a debug/xray message. Uses adapter.sendDebug if available, else falls back to send(). */
  sendDebug(channelId: string, text: string): Promise<void>
  sendTyping(channelId: string): Promise<void>
  getLastActiveChannel(): string | null
  /** Returns the first registered channel ID, regardless of provider. */
  getFirstChannel(): string | null
  /** Optional: edit a previously sent message by its ID on a specific channel. */
  editMessage?(channelId: string, messageId: string, text: string): Promise<void>
}
