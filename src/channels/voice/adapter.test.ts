// src/channels/voice/adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type OpenAI from 'openai'
import { VoiceChannelAdapter, MAX_WAV_BYTES, VOICE_WS_PATH, SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON } from './adapter.js'
import type { InboundMessage } from '../../types/channel.js'

// ─── Mock http.Server ──────────────────────────────────────────────────────────
class MockHttpServer extends EventEmitter {}

// ─── Shared mock state ────────────────────────────────────────────────────────
// vi.mock factories are hoisted before imports. To share class references
// between the factory and the test body, we use a mutable container set by
// vi.hoisted (synchronous) and populated by the factory itself.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wsMocks = vi.hoisted(() => ({ MockWS: null as any, MockWSS: null as any }))

vi.mock('ws', () => {
  // vi.mock factories are hoisted before imports, so we must use require() to
  // get EventEmitter synchronously inside the factory (top-level imports are
  // not yet initialized when the factory runs).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as { EventEmitter: typeof import('node:events').EventEmitter }

  // Define mock classes inside the factory (runs at hoist time).
  class MockWS extends EventEmitter {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    readyState: 0 | 1 | 2 | 3 = 1
    sent: Array<{ kind: 'text' | 'binary'; value: string | Buffer }> = []
    closedWith: { code?: number; reason?: string } | null = null
    send(data: unknown): void {
      if (typeof data === 'string') this.sent.push({ kind: 'text', value: data as string })
      else this.sent.push({ kind: 'binary', value: data as Buffer })
    }
    close(code?: number, reason?: string): void {
      // exactOptionalPropertyTypes: must not set optional props to undefined explicitly
      const closed: { code?: number; reason?: string } = {}
      if (code !== undefined) closed.code = code
      if (reason !== undefined) closed.reason = reason
      this.closedWith = closed
      this.readyState = MockWS.CLOSED
      this.emit('close', code ?? 1000, Buffer.from(reason ?? ''))
    }
  }

  class MockWSS extends EventEmitter {
    handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, cb: (ws: MockWS) => void): void {
      const ws = new MockWS()
      cb(ws)
    }
    close(): void { /* noop */ }
  }

  // Expose to the test body via the shared container.
  wsMocks.MockWS = MockWS
  wsMocks.MockWSS = MockWSS

  return { WebSocket: MockWS, WebSocketServer: MockWSS }
})

// ─── WAV builder (duplicated from wav.test.ts — intentional, keeps tests hermetic) ─
function buildWav(byteRate: number, dataBytes: number): Buffer {
  const fmtChunkSize = 16
  const totalLen = 12 + 8 + fmtChunkSize + 8 + dataBytes
  const buf = Buffer.alloc(totalLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(totalLen - 8, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(fmtChunkSize, 16)
  buf.writeUInt32LE(byteRate, 28)
  buf.write('data', 20 + fmtChunkSize, 'ascii')
  buf.writeUInt32LE(dataBytes, 20 + fmtChunkSize + 4)
  return buf
}

// ─── OpenAI mock ───────────────────────────────────────────────────────────────
function makeMockOpenAI(transcriptText: string) {
  const transcribe = vi.fn(async () => ({ text: transcriptText }))
  const speechCreate = vi.fn((_params: unknown, opts?: { signal?: AbortSignal }) => ({
    asResponse: async () => ({ body: null }),
    _signal: opts?.signal,
  }))
  const client = {
    audio: {
      transcriptions: { create: transcribe },
      speech: { create: speechCreate },
    },
  } as unknown as OpenAI
  return { client, transcribe, speechCreate }
}

// ─── Setup ─────────────────────────────────────────────────────────────────────
async function setupAdapter(transcriptText = 'hello world') {
  const httpServer = new MockHttpServer() as unknown as import('node:http').Server
  const { client, transcribe, speechCreate } = makeMockOpenAI(transcriptText)
  const adapter = new VoiceChannelAdapter(httpServer, client)
  const messages: InboundMessage[] = []
  adapter.onMessage(m => messages.push(m))
  await adapter.start()
  return { adapter, httpServer, messages, transcribe, speechCreate, client }
}

// Access private state via a test-only type assertion (no plan-level API exposure).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getActiveSocket(adapter: VoiceChannelAdapter): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (adapter as any).activeSocket
}

function getTtsAbortController(adapter: VoiceChannelAdapter): AbortController | null {
  return (adapter as unknown as { ttsAbortController: AbortController | null }).ttsAbortController
}

function triggerUpgrade(httpServer: MockHttpServer): void {
  httpServer.emit('upgrade',
    { url: VOICE_WS_PATH } as unknown as import('node:http').IncomingMessage,
    {} as unknown as import('node:stream').Duplex,
    Buffer.alloc(0),
  )
}

function triggerUpgradeNonVoice(httpServer: MockHttpServer): void {
  httpServer.emit('upgrade',
    { url: '/api/other' } as unknown as import('node:http').IncomingMessage,
    {} as unknown as import('node:stream').Duplex,
    Buffer.alloc(0),
  )
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('VoiceChannelAdapter', () => {
  it('has id "voice"', async () => {
    const { adapter } = await setupAdapter()
    expect(adapter.id).toBe('voice')
  })

  it('upgrades a WS connection at /api/voice/ws and tracks it as activeSocket', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    expect(ws).not.toBeNull()
    expect(ws.readyState).toBe(wsMocks.MockWS.OPEN)
  })

  it('ignores upgrade events whose URL is not /api/voice/ws', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgradeNonVoice(httpServer as unknown as MockHttpServer)
    expect(getActiveSocket(adapter)).toBeNull()
  })

  it('rejects a second connection with close code 4001 and preserves the existing socket (D-03)', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const first = getActiveSocket(adapter)

    // Capture the second WS by temporarily overriding handleUpgrade on the prototype
    let secondWs: InstanceType<typeof wsMocks.MockWS> | null = null
    const origHandle = wsMocks.MockWSS.prototype.handleUpgrade
    wsMocks.MockWSS.prototype.handleUpgrade = function (_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) {
      const ws = new wsMocks.MockWS()
      secondWs = ws
      cb(ws)
    }
    try {
      triggerUpgrade(httpServer as unknown as MockHttpServer)
    } finally {
      wsMocks.MockWSS.prototype.handleUpgrade = origHandle
    }

    expect(first.closedWith).toBeNull()            // existing session NOT dropped
    expect(secondWs).not.toBeNull()
    expect(secondWs!.closedWith).toEqual({
      code: SESSION_BUSY_CLOSE_CODE,
      reason: SESSION_BUSY_REASON,
    })
    // activeSocket is still the first one
    expect(getActiveSocket(adapter)).toBe(first)
  })

  it('routes a valid binary WAV frame as { channel: "voice", text } via the onMessage handler (VOICE-IN-06)', async () => {
    const { adapter, httpServer, messages, transcribe } = await setupAdapter('  hello world  ')
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const wav = buildWav(32000, 16000)  // 0.5s — above 500ms gate

    ws.emit('message', wav, true)
    // allow the async handleAudio to resolve
    await new Promise(r => setImmediate(r))

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([{ channel: 'voice', text: 'hello world' }])
  })

  it('silently drops sub-500ms WAV frames without calling Whisper (VOICE-IN-05)', async () => {
    const { adapter, httpServer, messages, transcribe } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const wav = buildWav(32000, 8000)  // 0.25s

    ws.emit('message', wav, true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).not.toHaveBeenCalled()
    expect(messages).toHaveLength(0)
  })

  it('silently drops oversize (>10 MB) binary frames without parsing', async () => {
    const { adapter, httpServer, messages, transcribe } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const huge = Buffer.alloc(MAX_WAV_BYTES + 1)  // just over the limit

    ws.emit('message', huge, true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).not.toHaveBeenCalled()
    expect(messages).toHaveLength(0)
  })

  it('silently drops empty-transcript results (whitespace-only)', async () => {
    const { adapter, httpServer, messages } = await setupAdapter('   \n  ')
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))
    expect(messages).toHaveLength(0)
  })

  it('aborts in-flight TTS when a cancel_tts JSON frame arrives (VOICE-OUT-03, D-07)', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    // Simulate an in-flight TTS by injecting an AbortController
    const ac = new AbortController()
    ;(adapter as unknown as { ttsAbortController: AbortController }).ttsAbortController = ac

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cancel_tts' })), false)

    expect(ac.signal.aborted).toBe(true)
  })

  it('ignores malformed JSON control frames without closing the socket', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', Buffer.from('not valid json {{{'), false)
    expect(ws.readyState).toBe(wsMocks.MockWS.OPEN)
    expect(ws.closedWith).toBeNull()
  })

  it('on ws close: clears activeSocket AND aborts ttsAbortController (T-19-13)', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const ac = new AbortController()
    ;(adapter as unknown as { ttsAbortController: AbortController }).ttsAbortController = ac

    ws.close(1000, 'bye')

    expect(getActiveSocket(adapter)).toBeNull()
    expect(ac.signal.aborted).toBe(true)
  })

  it('send() is a no-op when there is no active socket', async () => {
    const { adapter, speechCreate } = await setupAdapter()
    await expect(adapter.send('hello')).resolves.toBeUndefined()
    expect(speechCreate).not.toHaveBeenCalled()
  })

  it('send() calls streamTts against the active socket and threads a fresh AbortController', async () => {
    const { adapter, httpServer, speechCreate } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    await adapter.send('hello')
    expect(speechCreate).toHaveBeenCalledTimes(1)
    const [, opts] = speechCreate.mock.calls[0]!
    expect((opts as { signal: AbortSignal }).signal).toBeDefined()
    expect(getTtsAbortController(adapter)).toBeNull()  // cleared after completion
  })

  it('stop() aborts TTS, closes the socket with 1001, and removes the upgrade listener', async () => {
    const { adapter, httpServer } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const ac = new AbortController()
    ;(adapter as unknown as { ttsAbortController: AbortController }).ttsAbortController = ac

    const listenerCountBefore = (httpServer as unknown as MockHttpServer).listenerCount('upgrade')
    expect(listenerCountBefore).toBe(1)

    await adapter.stop()

    expect(ac.signal.aborted).toBe(true)
    expect(ws.closedWith?.code).toBe(1001)
    expect((httpServer as unknown as MockHttpServer).listenerCount('upgrade')).toBe(0)
  })
})
