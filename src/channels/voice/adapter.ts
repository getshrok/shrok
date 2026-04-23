// src/channels/voice/adapter.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type OpenAI from 'openai'
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
import { transcribeWav, TooShortError, InvalidWavError } from './stt.js'
import { streamTts, isAbortError } from './tts.js'

/** Hard ceiling on a single binary WAV frame. 10 MB = ~5 min of 16 kHz mono PCM,
 *  far larger than any reasonable voice turn. Oversized frames are dropped. */
export const MAX_WAV_BYTES = 10 * 1024 * 1024

/** Path at which the voice WebSocket is mounted on the dashboard http.Server. */
export const VOICE_WS_PATH = '/api/voice/ws'

/** Close code sent when a second client tries to connect (D-03). */
export const SESSION_BUSY_CLOSE_CODE = 4001
export const SESSION_BUSY_REASON = 'voice session already active'

export class VoiceChannelAdapter implements ChannelAdapter {
  readonly id = 'voice'
  private wss = new WebSocketServer({ noServer: true })
  private handler: ((msg: InboundMessage) => void) | null = null
  private activeSocket: WebSocket | null = null
  private ttsAbortController: AbortController | null = null
  private upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null

  constructor(private httpServer: Server, private openai: OpenAI) {}

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // D-01: attach upgrade listener AFTER dashboard server is listening
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      if (req.url !== VOICE_WS_PATH) return  // leave other URLs alone — do NOT destroy
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    }
    this.upgradeListener = listener
    this.httpServer.on('upgrade', listener)

    this.wss.on('connection', (ws) => this.handleConnection(ws))
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
      await streamTts(text, this.openai, ws, ac.signal)
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

  private handleConnection(ws: WebSocket): void {
    // D-03: reject a second concurrent connection; preserve the existing one
    if (this.activeSocket !== null) {
      ws.close(SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON)
      return
    }
    this.activeSocket = ws
    log.info('[voice] client connected')

    ws.on('message', (data, isBinary) => {
      void this.handleMessage(ws, data as Buffer | Buffer[] | ArrayBuffer, isBinary)
    })
    ws.on('close', () => {
      if (this.activeSocket === ws) this.activeSocket = null
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
      await this.handleAudio(buf)
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

  private async handleAudio(buf: Buffer): Promise<void> {
    if (buf.length > MAX_WAV_BYTES) {
      log.warn(`[voice] dropping oversize WAV frame (${buf.length} bytes > ${MAX_WAV_BYTES})`)
      return
    }
    try {
      const transcript = await transcribeWav(buf, this.openai)
      if (!transcript) {
        log.debug('[voice] whisper returned empty transcript, dropping')
        return
      }
      // VOICE-IN-06: route as a normal user message — same path as typed input
      this.handler?.({ channel: this.id, text: transcript })
    } catch (err) {
      if (err instanceof TooShortError) {
        log.debug(`[voice] clip too short (${err.durationSeconds.toFixed(3)}s) — dropped`)
        return
      }
      if (err instanceof InvalidWavError) {
        log.debug('[voice] malformed WAV frame — dropped')
        return
      }
      log.error('[voice] whisper error:', (err as Error).message)
    }
  }
}
