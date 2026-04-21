import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { Attachment } from '../../types/core.js'
import { splitMessage } from '../chunker.js'
import { log } from '../../logger.js'
import { ZohoCliqStateStore } from '../../db/zoho_cliq_state.js'

/** Strip to lowercase alphanumeric for fuzzy content matching. */
function normalizeForMatch(text: string): string {
  return text.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

// ─── OAuth token cache ──────────────────────────────────────────────────────

function readCachedToken(cachePath: string): string | null {
  try {
    const { token, expiresAt } = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (Date.now() < expiresAt - 5 * 60 * 1000) return token as string
  } catch { /* no cache */ }
  return null
}

function writeCachedToken(cachePath: string, token: string, expiresIn: number): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ token, expiresAt: Date.now() + expiresIn * 1000 }), { encoding: 'utf8', mode: 0o600 })
  } catch { /* best effort */ }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface CliqMessage {
  id: string           // e.g. "1640068263893_257089928776"
  time: string         // Unix timestamp ms
  type: string         // "text", "file", etc.
  sender: { id: string; name: string; email?: string }
  content: {
    text?: string
    comment?: string   // user's comment on a file attachment
    file?: {
      id?: string
      name?: string
      type?: string    // MIME type
      dimensions?: { size?: number; width?: number; height?: number }
    }
  }
}

interface CliqMessagesResponse {
  data: CliqMessage[]
  next_token?: string
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class ZohoCliqAdapter implements ChannelAdapter {
  readonly id = 'zoho-cliq'
  private handler: ((msg: InboundMessage) => void) | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private accessToken: string | null = null
  private tokenExpiresAt = 0
  private stopped = false
  // Loopback defense: content match only (normalized to alphanumeric).
  // Cliq has no separate bot user — the bot sends as the human's own account,
  // so all messages share the same sender ID. Content matching is the only filter.
  // We normalize to alphanumeric to survive Cliq's markdown/whitespace transformations.
  private recentSentNormalized = new Set<string>()
  private pollCount = 0

  private tokenCachePath: string

  constructor(
    private clientId: string,
    private clientSecret: string,
    private refreshToken: string,
    private chatId: string,
    private mediaDir: string | undefined,
    private pollIntervalMs: number,
    private assistantName: string,
    private stateStore: ZohoCliqStateStore,
    workspacePath?: string,
  ) {
    this.tokenCachePath = path.join(workspacePath ?? os.tmpdir(), 'zoho-cliq-token.json')
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.stopped = false

    // Get initial token
    await this.ensureAccessToken()

    // Cold start vs warm start
    const processed = this.stateStore.countProcessed(this.chatId)
    if (processed === 0) {
      // First ever run — baseline current messages so we don't deliver history
      try {
        const resp = await this.fetchMessages()
        if (resp.data?.length > 0) {
          this.stateStore.markProcessed(this.chatId, resp.data.map(m => m.id))
          log.info(`[zoho-cliq] Cold start: baselined ${resp.data.length} existing messages`)
        }
      } catch (err) {
        log.warn(`[zoho-cliq] Could not fetch baseline: ${(err as Error).message}`)
      }
    } else {
      // Warm start — run one poll immediately to catch up on any messages missed during downtime
      try { await this.poll() } catch (err) {
        log.warn(`[zoho-cliq] Initial poll error: ${(err as Error).message}`)
      }
    }

    // Start polling
    this.schedulePoll()
    log.info(`[zoho-cliq] Polling chat ${this.chatId} every ${this.pollIntervalMs / 1000}s`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // Clear cached token so a fresh adapter gets a new one (e.g. after credential hot-reload)
    this.accessToken = null
    this.tokenExpiresAt = 0
    try { fs.unlinkSync(this.tokenCachePath) } catch { /* ignore */ }
  }

  async sendTyping(): Promise<void> {
    // Zoho Cliq has no typing indicator API
  }

  /** Explicit debug path — currently routes through send() but keeps the
   *  seam open for Cliq-specific differentiation (e.g. threaded replies) in
   *  the future. Having this method means ChannelRouter calls it directly
   *  instead of silently falling through to send(), so intent is explicit. */
  async sendDebug(text: string): Promise<void> {
    await this.send(text)
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    await this.ensureAccessToken()
    const prefixed = `**${this.assistantName}:** ${text}`
    const chunks = splitMessage(prefixed)
    for (const chunk of chunks) {
      this.recentSentNormalized.add(normalizeForMatch(chunk))
      await this.cliqPost(`/api/v2/chats/${this.chatId}/message`, { text: chunk })
      // Prevent unbounded growth — keep only the last 50
      if (this.recentSentNormalized.size > 50) {
        const first = this.recentSentNormalized.values().next().value
        if (first) this.recentSentNormalized.delete(first)
      }
    }
    // File attachments — send as separate messages with file paths noted
    if (attachments?.length) {
      for (const att of attachments) {
        if (att.path) {
          const label = att.filename ?? path.basename(att.path)
          await this.cliqPost(`/api/v2/chats/${this.chatId}/message`, {
            text: `📎 ${label}`,
          })
        }
      }
    }
  }

  // ─── OAuth ──────────────────────────────────────────────────────────────────

  private async ensureAccessToken(): Promise<string> {
    // Check in-memory cache first
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken
    }

    // Check disk cache
    const cached = readCachedToken(this.tokenCachePath)
    if (cached) {
      this.accessToken = cached
      this.tokenExpiresAt = Date.now() + 30 * 60 * 1000  // approximate
      return cached
    }

    // Refresh
    const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Zoho token refresh failed (${res.status}): ${text}`)
    }

    const data = await res.json() as { access_token?: string; expires_in?: number }
    if (!data.access_token) {
      throw new Error('Zoho token refresh response missing access_token')
    }

    const expiresIn = data.expires_in ?? 3600
    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + expiresIn * 1000
    writeCachedToken(this.tokenCachePath, data.access_token, expiresIn)
    return data.access_token
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private async cliqGet(urlPath: string): Promise<Record<string, unknown>> {
    const token = await this.ensureAccessToken()
    const res = await fetch(`https://cliq.zoho.com${urlPath}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    })
    if (res.status === 401 || res.status === 403) {
      // Token expired — clear cache and retry once
      this.accessToken = null
      this.tokenExpiresAt = 0
      const freshToken = await this.ensureAccessToken()
      const retry = await fetch(`https://cliq.zoho.com${urlPath}`, {
        headers: { Authorization: `Zoho-oauthtoken ${freshToken}` },
      })
      if (!retry.ok) throw new Error(`Zoho Cliq GET ${urlPath} failed: ${retry.status}`)
      return await retry.json() as Record<string, unknown>
    }
    if (!res.ok) throw new Error(`Zoho Cliq GET ${urlPath} failed: ${res.status}`)
    return await res.json() as Record<string, unknown>
  }

  private async cliqPost(urlPath: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.ensureAccessToken()
    const res = await fetch(`https://cliq.zoho.com${urlPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Zoho Cliq POST ${urlPath} failed (${res.status}): ${text}`)
    }
    // Cliq send endpoints return empty body on success
    const text = await res.text()
    if (!text) return {}
    try { return JSON.parse(text) as Record<string, unknown> }
    catch { return {} }
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (this.stopped) return
    this.pollTimer = setTimeout(async () => {
      const start = Date.now()
      try {
        await this.poll()
      } catch (err) {
        log.warn(`[zoho-cliq] Poll error: ${(err as Error).message}`)
      }
      const elapsed = Date.now() - start
      // Log if the poll took unusually long (more than 2 seconds)
      if (elapsed > 2000) {
        log.warn(`[zoho-cliq] Slow poll: ${(elapsed / 1000).toFixed(1)}s`)
      }
      this.schedulePoll()
    }, this.pollIntervalMs)
  }

  private async fetchMessages(): Promise<CliqMessagesResponse> {
    const resp = await this.cliqGet(`/api/v2/chats/${this.chatId}/messages?limit=20`) as unknown as CliqMessagesResponse
    if (resp.next_token) {
      log.warn('[zoho-cliq] More than 20 messages in one poll — some may be missed. Consider reducing poll interval.')
    }
    return resp
  }

  private async poll(): Promise<void> {
    if (!this.handler) return

    await this.ensureAccessToken()
    const resp = await this.fetchMessages()
    if (!resp.data?.length) return

    // Filter to unprocessed messages only (set-based dedup, replaces watermark comparison)
    const allIds = resp.data.map(m => m.id)
    const unprocessedIds = this.stateStore.filterUnprocessed(this.chatId, allIds)
    const newMessages = resp.data.filter(m => unprocessedIds.has(m.id))

    log.debug(`[zoho-cliq] poll: fetched ${resp.data.length} messages, ${unprocessedIds.size} new, ${newMessages.length} to process`)
    if (newMessages.length > 0) {
      for (const m of newMessages) {
        const text = m.content?.text ?? m.content?.comment ?? ''
        log.debug(`[zoho-cliq]   new: ${m.id} sender=${m.sender?.id} text="${text.substring(0, 50)}"`)
      }
    }

    // Mark ALL fetched IDs as processed BEFORE delivery (including bot messages,
    // already-seen, etc.) — ensures they won't be re-delivered on next poll
    this.stateStore.markProcessed(this.chatId, allIds)

    // Prune every 20 polls to prevent unbounded table growth (T-sr9-02 mitigation)
    this.pollCount += 1
    if (this.pollCount % 20 === 0) {
      this.stateStore.pruneProcessed(this.chatId, 500)
    }

    if (newMessages.length === 0) return

    for (const msg of newMessages) {
      // Text messages: content.text. File messages: content.comment + content.file
      const text = msg.content?.text ?? msg.content?.comment ?? ''

      // Loopback filter: normalized content match only.
      // Cliq has no separate bot user — the bot sends as the human's own account,
      // so ALL messages share the same sender ID. We normalize to alphanumeric
      // to survive Cliq's markdown/whitespace transformations.
      if (text) {
        const normalized = normalizeForMatch(text)
        if (this.recentSentNormalized.has(normalized)) {
          this.recentSentNormalized.delete(normalized)
          continue
        }
      }

      // Skip empty non-file messages
      if (!text && msg.type !== 'file') continue

      // File messages: fire off the download in the background and deliver the
      // message as soon as it's ready. Blocking the poll loop on a multi-MB
      // download would stall all subsequent polls and delay message delivery.
      if (msg.type === 'file' && msg.content?.file) {
        const file = msg.content.file
        const sizeMb = ((file.dimensions?.size ?? 0) / (1024 * 1024)).toFixed(1)
        log.info(`[zoho-cliq] Downloading attachment ${file.name ?? file.id} (${sizeMb} MB) in background`)
        const handler = this.handler
        const channel = this.id
        void (async () => {
          const start = Date.now()
          let attachments: Attachment[] = []
          try {
            const att = await this.downloadAttachment(file)
            if (att) attachments = [att]
            log.info(`[zoho-cliq] Attachment download finished in ${((Date.now() - start) / 1000).toFixed(1)}s: ${file.name ?? file.id}`)
          } catch (err) {
            log.warn(`[zoho-cliq] Failed to download attachment ${file.name ?? file.id}: ${(err as Error).message}`)
          }
          if (this.stopped) return
          try {
            handler({
              channel,
              text,
              ...(attachments.length ? { attachments } : {}),
              rawPayload: msg,
            })
          } catch (err) {
            log.warn(`[zoho-cliq] Handler threw for attachment ${file.name ?? file.id}: ${(err as Error).message}`)
          }
        })()
        continue
      }

      // Text-only message — deliver immediately
      this.handler({
        channel: this.id,
        text,
        rawPayload: msg,
      })
    }
  }

  private async downloadAttachment(file: NonNullable<CliqMessage['content']['file']>): Promise<Attachment | null> {
    if (!file.id || !this.mediaDir) return null

    const token = await this.ensureAccessToken()
    const res = await fetch(`https://cliq.zoho.com/api/v2/attachments/${file.id}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    })
    if (!res.ok) {
      log.warn(`[zoho-cliq] attachment download failed (${res.status}) for ${file.id}`)
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())
    const filename = file.name ?? `${Date.now()}.bin`
    const dest = path.join(this.mediaDir, `${Date.now()}-${filename}`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf)

    const mediaType = file.type ?? 'application/octet-stream'
    const type: Attachment['type'] =
      mediaType.startsWith('image/') ? 'image'
      : mediaType.startsWith('audio/') ? 'audio'
      : mediaType.startsWith('video/') ? 'video'
      : 'document'

    return { type, mediaType, filename, path: dest, ...(file.dimensions?.size !== undefined ? { size: file.dimensions.size } : {}) }
  }
}
