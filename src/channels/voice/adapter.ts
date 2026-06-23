// src/channels/voice/adapter.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type OpenAI from 'openai'
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
import { transcribeWavWithFallback, TooShortError, InvalidWavError, MIN_WAV_DURATION_SECONDS, type SttProvider } from './stt.js'
import { streamTts, isAbortError, TTS_MODEL, TTS_VOICE, type TtsProvider } from './tts.js'

/** Hard ceiling on a single binary WAV frame. 48 MB ≈ 25 min of 16 kHz mono PCM —
 *  far beyond any real voice turn, so this only rejects runaway/garbage frames, never
 *  a legitimate recording. Raised from 10 MB (#42): a continuous ~7 min turn encodes
 *  to ~13 MB and was being silently dropped before transcription.
 *
 *  Why not lower "to be safe": a self-hosted faster-whisper box has no length limit
 *  and transcribes several× realtime (measured ~10× idle on the reference 4090), so
 *  the real ceiling on a long turn is transcription wall-time vs the STT client
 *  timeout (set to 15 min in buildSttProviders), not bytes. NOTE: if an OpenAI STT
 *  *fallback* is enabled, OpenAI hard-limits requests to 25 MB — a turn between 25 MB
 *  and this cap will transcribe on the self-hosted primary but fail on OpenAI fallback.
 *  That's an acceptable degradation (the primary handles it); the cap is sized for the
 *  self-hosted primary, which is the configured default. Frames over the cap are
 *  dropped AND the client is told (see handleAudio), never silently. */
export const MAX_WAV_BYTES = 48 * 1024 * 1024

/** Path at which the voice WebSocket is mounted on the dashboard http.Server. */
export const VOICE_WS_PATH = '/api/voice/ws'

/** Pure helper: extract ?head= from a req.url and validate against knownHeadIds.
 *  Falls back to defaultHeadId when absent, empty, unknown, or malformed. */
export function resolveHeadFromUrl(
  url: string | undefined,
  knownHeadIds: ReadonlySet<string>,
  defaultHeadId: string,
): string {
  try {
    const parsed = new URL(url ?? '', 'http://x')
    const head = parsed.searchParams.get('head')
    if (head && knownHeadIds.has(head)) return head
  } catch {
    // malformed url → fall back
  }
  return defaultHeadId
}

/** Close code sent when a second client tries to connect (D-03). */
export const SESSION_BUSY_CLOSE_CODE = 4001
export const SESSION_BUSY_REASON = 'voice session already active'

export interface VoiceChannelAdapterOpts {
  id?: string
  defaultHeadId?: string
  knownHeadIds?: ReadonlySet<string>
  routeFor?: (headId: string) => (msg: InboundMessage) => void
  /** Ordered TTS providers: [0] is primary (e.g. self-hosted), later ones are
   *  fallbacks (e.g. OpenAI). When omitted, defaults to OpenAI-only using the
   *  `openai` client (legacy behavior). */
  ttsProviders?: TtsProvider[]
  /** Ordered STT providers: [0] is primary (e.g. self-hosted Whisper), later ones are
   *  fallbacks (e.g. OpenAI). When omitted, defaults to OpenAI-only using the
   *  `openai` constructor arg (legacy behavior). Splitting this from ttsProviders lets
   *  you repoint STT without disturbing TTS. */
  sttProviders?: SttProvider[]
  /** Resolve the logged-in dashboard user's display name from the WS upgrade request
   *  (it carries the same session cookie as the rest of the dashboard). Used to prefix
   *  spoken messages with `[Name]:` so the head can tell who's talking — matching the
   *  typed dashboard path. Returns undefined when no name is bound to the session. */
  resolveSenderName?: (req: IncomingMessage) => string | undefined
}

export class VoiceChannelAdapter implements ChannelAdapter {
  readonly id: string
  private readonly defaultHeadId: string
  private readonly knownHeadIds: ReadonlySet<string>
  private readonly routeFor: ((headId: string) => (msg: InboundMessage) => void) | null
  private wss = new WebSocketServer({ noServer: true })
  private handler: ((msg: InboundMessage) => void) | null = null
  private activeSocket: WebSocket | null = null
  private connectionRoute: ((msg: InboundMessage) => void) | null = null
  /** Display name for the current connection's logged-in user, resolved once at
   *  connect from the session cookie. Prefixed to each transcript as `[Name]:`. */
  private connectionSenderName: string | undefined = undefined
  private ttsAbortController: AbortController | null = null
  private upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null
  private readonly ttsProviders: TtsProvider[]
  private readonly sttProviders: SttProvider[]
  private readonly resolveSenderName: ((req: IncomingMessage) => string | undefined) | null

  constructor(private httpServer: Server, private openai: OpenAI, opts?: VoiceChannelAdapterOpts) {
    this.id = opts?.id ?? 'voice'
    this.defaultHeadId = opts?.defaultHeadId ?? 'default'
    this.knownHeadIds = opts?.knownHeadIds ?? new Set()
    this.routeFor = opts?.routeFor ?? null
    // Default: OpenAI-only (legacy). The shared `openai` client doubles as both the
    // STT (Whisper) client and — when no self-hosted endpoint is configured — the
    // sole TTS provider.
    this.ttsProviders = opts?.ttsProviders ?? [
      { client: openai, model: TTS_MODEL, voice: TTS_VOICE, responseFormat: 'mp3', label: 'openai' },
    ]
    // STT is split from TTS so repointing STT does not disturb TTS.
    // When sttProviders is omitted, fall back to the legacy single-client behavior
    // using the `openai` constructor arg.
    this.sttProviders = opts?.sttProviders ?? [{ client: openai, label: 'openai' }]
    this.resolveSenderName = opts?.resolveSenderName ?? null
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // D-01: attach upgrade listener AFTER dashboard server is listening
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      // Accept /api/voice/ws and /api/voice/ws?head=… (match on pathname, ignore query string)
      // Still reject unrelated paths so the guard does not over-match.
      const reqPath = (() => {
        try { return new URL(req.url ?? '', 'http://x').pathname } catch { return req.url }
      })()
      if (reqPath !== VOICE_WS_PATH) return  // leave other URLs alone — do NOT destroy
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    }
    this.upgradeListener = listener
    this.httpServer.on('upgrade', listener)

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req as IncomingMessage))
    log.info(`[voice] WebSocket adapter listening at ${VOICE_WS_PATH}`)
  }

  async stop(): Promise<void> {
    if (this.upgradeListener) {
      this.httpServer.off('upgrade', this.upgradeListener)
      this.upgradeListener = null
    }
    this.ttsAbortController?.abort()
    this.ttsAbortController = null
    if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
      this.activeSocket.close(1001, 'server shutdown')
    }
    this.activeSocket = null
    this.wss.close()
  }

  /** Invoked by channelRouter.send('voice', text) after the activation loop finishes. */
  async send(text: string, _attachments?: Attachment[]): Promise<void> {
    const ws = this.activeSocket
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // Cancel any prior in-flight TTS first (defensive — normally send is serialized)
    this.ttsAbortController?.abort()
    const ac = new AbortController()
    this.ttsAbortController = ac
    try {
      await streamTts(text, this.ttsProviders, ws, ac.signal)
    } catch (err) {
      if (isAbortError(err)) {
        log.debug('[voice] TTS aborted (barge-in or shutdown)')
      } else {
        log.error('[voice] TTS error:', (err as Error).message)
      }
    } finally {
      if (this.ttsAbortController === ac) this.ttsAbortController = null
    }
  }

  /** Debug/xray visibility streams (agent work, head tools, system events, steward
   *  runs) must NEVER be spoken — voice has no collapsible surface and would read
   *  them aloud via TTS. This no-op makes the router drop them here instead of
   *  falling back to send(). (#38) */
  async sendDebug(_text: string): Promise<void> {}

  private handleConnection(ws: WebSocket, req?: IncomingMessage): void {
    // D-03: reject a second concurrent connection; preserve the existing one
    if (this.activeSocket !== null) {
      ws.close(SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON)
      return
    }
    this.activeSocket = ws

    // Resolve the head for this connection from ?head= and set the per-connection route
    const headId = resolveHeadFromUrl(req?.url, this.knownHeadIds, this.defaultHeadId)
    this.connectionRoute = this.routeFor ? this.routeFor(headId) : this.handler
    // Attribute spoken messages to the logged-in user (same session cookie as typed
    // messages), so transcripts get the `[Name]:` prefix like every other channel.
    this.connectionSenderName = req && this.resolveSenderName ? this.resolveSenderName(req) : undefined
    log.info(`[voice] client connected (head: ${headId}${this.connectionSenderName ? `, user: ${this.connectionSenderName}` : ''})`)

    ws.on('message', (data, isBinary) => {
      void this.handleMessage(ws, data as Buffer | Buffer[] | ArrayBuffer, isBinary)
    })
    ws.on('close', () => {
      if (this.activeSocket === ws) this.activeSocket = null
      this.connectionRoute = null
      this.connectionSenderName = undefined
      // T-19-13: client vanished mid-TTS — cancel the upstream HTTP request
      this.ttsAbortController?.abort()
      log.info('[voice] client disconnected')
    })
    ws.on('error', (err) => {
      log.warn('[voice] socket error:', err.message)
    })
  }

  private async handleMessage(
    ws: WebSocket,
    data: Buffer | Buffer[] | ArrayBuffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.from(data as ArrayBuffer)
      await this.handleAudio(ws, buf)
      return
    }
    // Text frame: JSON control message
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    try {
      const msg = JSON.parse(text) as { type?: string }
      if (msg.type === 'cancel_tts') {
        // D-07 + VOICE-OUT-03
        this.ttsAbortController?.abort()
      } else {
        log.debug('[voice] unknown control frame:', msg.type)
      }
    } catch {
      log.debug('[voice] malformed JSON control frame, ignored')
    }
  }

  /** Send a user-facing error control frame to the client so a dropped turn is
   *  visible instead of vanishing silently (#42). No-op if the socket is gone. */
  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'error', message }))
    } catch (err) {
      log.warn('[voice] failed to send error frame to client:', (err as Error).message)
    }
  }

  private async handleAudio(ws: WebSocket, buf: Buffer): Promise<void> {
    if (buf.length > MAX_WAV_BYTES) {
      log.warn(`[voice] dropping oversize WAV frame (${buf.length} bytes > ${MAX_WAV_BYTES})`)
      this.sendError(ws, 'Message too long — please speak in shorter turns')
      return
    }
    // Observability (#42): log every received audio frame at info level. A turn that
    // never produces this line means the audio never reached the server (client-side
    // capture/send failure) — the single most useful signal for diagnosing a "message
    // silently disappeared" report. The drop reasons below are also info-level so every
    // outcome is visible at the default log level; message TEXT is never logged (only
    // its length), so transcripts don't leak into system logs.
    log.info(`[voice] audio frame received: ${buf.length} bytes`)
    try {
      const transcript = await transcribeWavWithFallback(buf, this.sttProviders)
      if (!transcript) {
        log.info('[voice] transcript empty — turn dropped (STT returned no text)')
        return
      }
      log.info(`[voice] transcribed ${transcript.length} chars — routing turn`)
      // VOICE-IN-06: route as a normal user message — same path as typed input
      // Use the per-connection route (head-specific when routeFor is set), falling back to handler.
      // Carry the resolved sender name so the ingestion path prefixes `[Name]:` like other channels.
      ;(this.connectionRoute ?? this.handler)?.({
        channel: this.id,
        text: transcript,
        ...(this.connectionSenderName ? { senderName: this.connectionSenderName } : {}),
      })
    } catch (err) {
      if (err instanceof TooShortError) {
        log.info(`[voice] clip too short (${err.durationSeconds.toFixed(3)}s < ${MIN_WAV_DURATION_SECONDS}s) — turn dropped`)
        return
      }
      if (err instanceof InvalidWavError) {
        log.info('[voice] malformed WAV frame — turn dropped')
        return
      }
      log.error('[voice] whisper error:', (err as Error).message)
      this.sendError(ws, 'Voice error — please try again')
    }
  }
}
