// src/channels/home-assistant/adapter.ts
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'

/** Timeout for the HA announce REST call.  Known HA bug: satellites can get stuck
 *  in RESPONDING forever — never wait more than this for a playback confirmation. */
const ANNOUNCE_TIMEOUT_MS = 30_000

/** Minimal config shape the adapter needs for outbound REST calls.
 *  Matches the home-assistant union member of ChannelConfigSchema. */
interface HAConfig {
  haBaseUrl: string
  haVoiceSatelliteEntityId: string
}

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
  readonly headId: string
  private readonly config: HAConfig
  private handler: ((msg: InboundMessage) => void) | null = null
  private pendingReply: PendingReply | null = null
  private deviceReachableBaseUrl: string | null = null

  constructor(id: string = 'home-assistant', headId: string = 'default', config: HAConfig = { haBaseUrl: '', haVoiceSatelliteEntityId: '' }) {
    const inboundKey = process.env['HA_INBOUND_API_KEY']
    if (!inboundKey) {
      throw new Error(
        '[home-assistant] HA_INBOUND_API_KEY is required but missing from .env — ' +
        'set a bearer key that Home Assistant will present on /v1/chat/completions',
      )
    }
    this.id = id
    this.headId = headId
    this.config = config
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

  /** Phase 45: cache the device-reachable base URL learned from an inbound turn's Host header.
   *  Persisted in-memory only; Plan 03 populates this from the inbound HA router. */
  cacheBaseUrl(url: string): void {
    this.deviceReachableBaseUrl = url
  }

  /** Phase 45: return the cached device-reachable base URL, or null if never set.
   *  Used by the ring runner to build the media_content_id for play_media. */
  getDeviceReachableBaseUrl(): string | null {
    return this.deviceReachableBaseUrl
  }

  /** Phase 45: expose the adapter config (haBaseUrl, haVoiceSatelliteEntityId) for the ring runner.
   *  D-05: this method does NOT read, log, or embed HA_ACCESS_TOKEN. */
  getConfig(): HAConfig {
    return this.config
  }

  /** Upgraded send() — D-01 exactly-once in-turn delivery.
   *
   *  If a pendingReply slot is open: clear the deadline timer, resolve the held
   *  HTTP promise with the reply text, and null the slot.
   *
   *  If no slot is open (pendingReply === null): call HA REST announce. */
  async send(text: string, _attachments?: Attachment[]): Promise<void> {
    if (this.pendingReply !== null) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply.resolve(text)
      this.pendingReply = null
      return
    }
    // pendingReply === null → fire announce via HA REST (D-01 / HAAN-01)
    await this.announceOrStartConversation(text)
  }

  /** Call HA REST assist_satellite service (announce or start_conversation).
   *
   *  D-03 failure semantics:
   *  - Fast errors (network, 4xx/5xx) → throw so the router retries + cross-channel falls back.
   *  - 30s AbortController timeout → log.warn and return (do NOT throw — HA already accepted;
   *    throwing risks double-delivery on retry + pins the activation loop).
   *
   *  D-05: the raw HA_ACCESS_TOKEN value is NEVER passed to log.* and NEVER embedded
   *  in a thrown Error message.
   */
  private async announceOrStartConversation(text: string, wantsReply = false): Promise<void> {
    const token = process.env['HA_ACCESS_TOKEN']
    if (!token) {
      throw new Error('[home-assistant] HA_ACCESS_TOKEN is required for outbound announce — set it in .env')
    }
    const service = wantsReply ? 'start_conversation' : 'announce'
    const url = `${this.config.haBaseUrl}/api/services/assist_satellite/${service}`
    const body = JSON.stringify({ entity_id: this.config.haVoiceSatelliteEntityId, message: text })

    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), ANNOUNCE_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: ac.signal,
      })
      if (!res.ok) {
        throw new Error(`[home-assistant] announce failed: HTTP ${res.status}`)
      }
      log.info(`[home-assistant] announce delivered via ${service} (${text.length} chars)`)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 30s timeout — satellite accepted call but playback confirmation never arrived (P5)
        // Do NOT throw — HA already accepted; throwing risks double-delivery + loop pinning
        log.warn('[home-assistant] announce timed out after 30s (satellite stuck in RESPONDING?) — continuing')
        return
      }
      // Fast error (network, 4xx/5xx) — throw so router triggers cross-channel fallback (D-03)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Debug/xray visibility streams (agent work, head tools, system events, steward
   *  runs) must NEVER reach a voice device — it has no collapsible surface and would
   *  read them aloud. This no-op makes the router drop them here instead of falling
   *  back to send() and announcing them. (#38) */
  async sendDebug(_text: string): Promise<void> {}

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
