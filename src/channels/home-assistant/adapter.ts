// src/channels/home-assistant/adapter.ts
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'

export class HomeAssistantChannelAdapter implements ChannelAdapter {
  readonly id: string
  private readonly headId: string
  private handler: ((msg: InboundMessage) => void) | null = null

  constructor(id: string = 'home-assistant', headId: string = 'default') {
    this.id = id
    this.headId = headId
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    log.info(`[home-assistant] adapter registered (id=${this.id}, head=${this.headId}) — HTTP listener wired in Phase 41`)
  }

  async stop(): Promise<void> {
    // Nothing to tear down until Phase 41 wires the HTTP listener.
  }

  async send(text: string, _attachments?: Attachment[]): Promise<void> {
    log.warn(`[home-assistant] send() not wired until Phase 42 — dropping reply (${text.length} chars)`)
  }

  /** Test helper: simulate an inbound message as if it arrived from HA.
   *  Routes through the same handler as a real inbound event would.
   *  Do NOT call from production code paths. */
  injectMessage(text: string, senderName?: string): void {
    this.handler?.({
      channel: this.id,
      text,
      ...(senderName !== undefined ? { senderName } : {}),
    })
  }
}
