// src/channels/home-assistant/adapter.ts
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'

/** Internal slot that holds the pending HTTP reply promise while the head is processing.
 *  Mirrors VoiceChannelAdapter.activeSocket — store resolve/reject + timer, NOT the
 *  Express Response object, so the contract is testable without a live HTTP server. */
interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HomeAssistantChannelAdapter implements ChannelAdapter {
  readonly id: string
  private readonly headId: string
  private handler: ((msg: InboundMessage) => void) | null = null
  private pendingReply: PendingReply | null = null

  constructor(id: string = 'home-assistant', headId: string = 'default') {
    const inboundKey = process.env['HA_INBOUND_API_KEY']
    if (!inboundKey) {
      throw new Error(
        '[home-assistant] HA_INBOUND_API_KEY is required but missing from .env — ' +
        'set a bearer key that Home Assistant will present on /v1/chat/completions',
      )
    }
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

  /** D-04: replace-on-concurrent — if a slot is already held, clear its timer and
   *  reject the stale awaiter before storing the new slot.  Latest turn wins. */
  setPendingReply(pending: PendingReply): void {
    if (this.pendingReply) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply.reject(new Error('replaced by concurrent turn'))
    }
    this.pendingReply = pending
  }

  /** Clear timer and null the slot.  Called on req.on('close') or deadline timeout.
   *  Does NOT call reject — the caller (router) has already handled the promise. */
  clearPendingReply(): void {
    if (this.pendingReply) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply = null
    }
  }

  /** Upgraded send() — D-01 exactly-once in-turn delivery.
   *
   *  If a pendingReply slot is open: clear the deadline timer, resolve the held
   *  HTTP promise with the reply text, and null the slot.
   *
   *  If no slot is open (pendingReply === null): log a warn and return.  This is
   *  the Phase 42 announce seam — Phase 42 will call HA REST here instead. */
  async send(text: string, _attachments?: Attachment[]): Promise<void> {
    if (this.pendingReply !== null) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply.resolve(text)
      this.pendingReply = null
      return
    }
    // pendingReply === null → log stub; Phase 42 will call HA REST announce here
    log.warn(`[home-assistant] send() — no pendingReply slot open, dropping reply (${text.length} chars) until Phase 42`)
  }

  /** Production inbound path used by the router (Plan 03).
   *  Routes the extracted HA voice turn through the registered message handler. */
  dispatchInbound(text: string, conversationId: string): void {
    this.handler?.({
      channel: this.id,
      text,
      senderName: 'HA Voice',
      rawPayload: { conversationId },
    })
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
