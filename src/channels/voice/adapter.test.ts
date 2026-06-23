// src/channels/voice/adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type OpenAI from 'openai'
import { VoiceChannelAdapter, MAX_WAV_BYTES, VOICE_WS_PATH, SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON, resolveHeadFromUrl } from './adapter.js'
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

function triggerUpgradeWithHead(httpServer: MockHttpServer, headId: string): void {
  httpServer.emit('upgrade',
    { url: `${VOICE_WS_PATH}?head=${encodeURIComponent(headId)}` } as unknown as import('node:http').IncomingMessage,
    {} as unknown as import('node:stream').Duplex,
    Buffer.alloc(0),
  )
}

// Extended setupAdapter that accepts opts for head routing tests
async function setupAdapterWithHeads(
  opts: {
    knownHeadIds: ReadonlySet<string>
    defaultHeadId: string
    transcriptText?: string
  }
) {
  const httpServer = new MockHttpServer() as unknown as import('node:http').Server
  const { client, transcribe, speechCreate } = makeMockOpenAI(opts.transcriptText ?? 'hello world')
  const routesByHead: Record<string, InboundMessage[]> = {}
  const adapter = new VoiceChannelAdapter(httpServer, client, {
    knownHeadIds: opts.knownHeadIds,
    defaultHeadId: opts.defaultHeadId,
    routeFor: (headId) => {
      if (!routesByHead[headId]) routesByHead[headId] = []
      return (msg) => { routesByHead[headId]!.push(msg) }
    },
  })
  await adapter.start()
  return { adapter, httpServer, routesByHead, transcribe, speechCreate, client }
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

  it('prefixes the routed message with the resolved sender name (parity with typed channels)', async () => {
    const httpServer = new MockHttpServer() as unknown as import('node:http').Server
    const { client } = makeMockOpenAI('hello world')
    const seen: Array<import('node:http').IncomingMessage> = []
    const messages: InboundMessage[] = []
    const adapter = new VoiceChannelAdapter(httpServer, client, {
      resolveSenderName: (req) => { seen.push(req); return 'Ashley' },
    })
    adapter.onMessage(m => messages.push(m))
    await adapter.start()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    // The transcript carries senderName so the ingestion path adds the `[Name]:` prefix.
    expect(messages).toEqual([{ channel: 'voice', text: 'hello world', senderName: 'Ashley' }])
    // The resolver is given the upgrade request (which carries the session cookie).
    expect(seen).toHaveLength(1)
  })

  it('omits senderName when none is resolved (no empty-prefix placeholder)', async () => {
    const { adapter, httpServer, messages } = await setupAdapter('hello world')
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    expect(messages).toEqual([{ channel: 'voice', text: 'hello world' }])
    expect(messages[0]).not.toHaveProperty('senderName')
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

  it('drops oversize binary frames without parsing, and tells the client (#42)', async () => {
    const { adapter, httpServer, messages, transcribe } = await setupAdapter()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const huge = Buffer.alloc(MAX_WAV_BYTES + 1)  // just over the limit

    ws.emit('message', huge, true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).not.toHaveBeenCalled()
    expect(messages).toHaveLength(0)
    // The turn is dropped, but the client must now learn about it (no silent vanish).
    const errorFrames = ws.sent
      .filter((f: { kind: string; value: string | Buffer }) => f.kind === 'text')
      .map((f: { value: string }) => JSON.parse(f.value as string))
      .filter((m: { type?: string }) => m.type === 'error')
    expect(errorFrames).toEqual([{ type: 'error', message: 'Message too long — please speak in shorter turns' }])
  })

  it('accepts a long-but-under-cap frame that the old 10 MB limit would have dropped (#42)', async () => {
    const { adapter, httpServer, messages, transcribe } = await setupAdapter('a long turn')
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    // ~13 MB: a continuous ~7 min voice turn — over the OLD 10 MB cap, well under the new one.
    const big = buildWav(32000, 13 * 1024 * 1024)

    ws.emit('message', big, true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([{ channel: 'voice', text: 'a long turn' }])
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

// ─── sttProviders routing ─────────────────────────────────────────────────────

describe('VoiceChannelAdapter — sttProviders routing', () => {
  it('uses the provided sttProviders primary when set (not the constructor openai arg)', async () => {
    const httpServer = new MockHttpServer() as unknown as import('node:http').Server
    // Constructor openai client — should NOT be called for STT when sttProviders is passed
    const constructorTranscribe = vi.fn(async () => ({ text: 'from constructor' }))
    const constructorClient = {
      audio: { transcriptions: { create: constructorTranscribe } },
    } as unknown as import('openai').default

    // sttProviders primary client
    const primaryTranscribe = vi.fn(async () => ({ text: 'from stt primary' }))
    const primaryClient = {
      audio: { transcriptions: { create: primaryTranscribe } },
    } as unknown as import('openai').default

    const messages: import('../../types/channel.js').InboundMessage[] = []
    const adapter = new VoiceChannelAdapter(httpServer, constructorClient, {
      sttProviders: [{ client: primaryClient, label: 'self-hosted' }],
    })
    adapter.onMessage(m => messages.push(m))
    await adapter.start()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    const wav = buildWav(32000, 16000)  // 0.5s — above gate

    ws.emit('message', wav, true)
    await new Promise(r => setImmediate(r))

    // sttProviders primary must be called
    expect(primaryTranscribe).toHaveBeenCalledTimes(1)
    // Constructor openai arg must NOT be called for STT
    expect(constructorTranscribe).not.toHaveBeenCalled()
    expect(messages).toEqual([{ channel: 'voice', text: 'from stt primary' }])
  })

  it('falls back to second sttProvider when primary throws', async () => {
    const httpServer = new MockHttpServer() as unknown as import('node:http').Server
    const constructorClient = {
      audio: { transcriptions: { create: vi.fn(async () => ({ text: 'constructor' })) } },
    } as unknown as import('openai').default

    const primaryTranscribe = vi.fn(async () => { throw new Error('dead box') })
    const primaryClient = { audio: { transcriptions: { create: primaryTranscribe } } } as unknown as import('openai').default

    const fallbackTranscribe = vi.fn(async () => ({ text: 'from fallback' }))
    const fallbackClient = { audio: { transcriptions: { create: fallbackTranscribe } } } as unknown as import('openai').default

    const messages: import('../../types/channel.js').InboundMessage[] = []
    const adapter = new VoiceChannelAdapter(httpServer, constructorClient, {
      sttProviders: [
        { client: primaryClient, label: 'self-hosted' },
        { client: fallbackClient, label: 'openai' },
      ],
    })
    adapter.onMessage(m => messages.push(m))
    await adapter.start()
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    expect(primaryTranscribe).toHaveBeenCalledTimes(1)
    expect(fallbackTranscribe).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([{ channel: 'voice', text: 'from fallback' }])
  })

  it('defaults to legacy single-openai-client behavior when sttProviders is omitted', async () => {
    // No sttProviders option — adapter should use the constructor openai arg
    const { adapter, httpServer, messages, transcribe } = await setupAdapter('legacy behavior')
    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([{ channel: 'voice', text: 'legacy behavior' }])
  })
})

// ─── resolveHeadFromUrl — pure unit tests ─────────────────────────────────────

describe('resolveHeadFromUrl', () => {
  const known = new Set(['default', 'work', 'assistant'])

  it('returns the ?head= param when it is a known head id', () => {
    expect(resolveHeadFromUrl('/api/voice/ws?head=work', known, 'default')).toBe('work')
  })

  it('decodes URL-encoded head ids via URLSearchParams', () => {
    expect(resolveHeadFromUrl('/api/voice/ws?head=my%20head', new Set(['my head']), 'default')).toBe('my head')
  })

  it('falls back to defaultHeadId when ?head= is absent', () => {
    expect(resolveHeadFromUrl('/api/voice/ws', known, 'default')).toBe('default')
  })

  it('falls back to defaultHeadId when ?head= is empty string', () => {
    expect(resolveHeadFromUrl('/api/voice/ws?head=', known, 'default')).toBe('default')
  })

  it('falls back to defaultHeadId when ?head= is unknown', () => {
    expect(resolveHeadFromUrl('/api/voice/ws?head=unknown-head', known, 'default')).toBe('default')
  })

  it('falls back to defaultHeadId for malformed url (undefined)', () => {
    expect(resolveHeadFromUrl(undefined, known, 'default')).toBe('default')
  })

  it('falls back to defaultHeadId for malformed url (gibberish)', () => {
    // new URL with no base would throw; our impl wraps in try/catch
    expect(resolveHeadFromUrl(':::not-a-url:::', known, 'default')).toBe('default')
  })
})

// ─── Upgrade guard + head routing E2E ────────────────────────────────────────

describe('VoiceChannelAdapter — query-tolerant upgrade guard + head routing (D4/D5)', () => {
  it('UPGRADES a ?head=-carrying URL (guard blocker fix): socket connects AND activeSocket is set', async () => {
    const knownHeadIds = new Set(['default', 'work'])
    const { adapter, httpServer } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
    })

    triggerUpgradeWithHead(httpServer as unknown as MockHttpServer, 'work')

    // Assert (a): the socket actually UPGRADED/CONNECTED — activeSocket is non-null
    // This is the assertion that catches the strict-equality guard regression
    expect(getActiveSocket(adapter)).not.toBeNull()
  })

  it('routes transcript to the HEAD-SPECIFIC route for ?head=<known> (D4 inbound)', async () => {
    const knownHeadIds = new Set(['default', 'work'])
    const { adapter, httpServer, routesByHead, transcribe } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
      transcriptText: 'test transcript',
    })

    triggerUpgradeWithHead(httpServer as unknown as MockHttpServer, 'work')
    const ws = getActiveSocket(adapter)
    const wav = buildWav(32000, 16000)  // 0.5s — above 500ms gate

    ws.emit('message', wav, true)
    await new Promise(r => setImmediate(r))

    expect(transcribe).toHaveBeenCalledTimes(1)
    // Assert (b): transcript routed to the 'work' head route, NOT the default
    expect(routesByHead['work']).toEqual([{ channel: 'voice', text: 'test transcript' }])
    expect(routesByHead['default']).toBeUndefined()
  })

  it('routes to defaultHeadId when ?head= is absent (back-compat)', async () => {
    const knownHeadIds = new Set(['default', 'work'])
    const { adapter, httpServer, routesByHead } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
      transcriptText: 'fallback message',
    })

    triggerUpgrade(httpServer as unknown as MockHttpServer)
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    expect(routesByHead['default']).toEqual([{ channel: 'voice', text: 'fallback message' }])
    expect(routesByHead['work']).toBeUndefined()
  })

  it('routes to defaultHeadId when ?head= is unknown (back-compat)', async () => {
    const knownHeadIds = new Set(['default', 'work'])
    const { adapter, httpServer, routesByHead } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
      transcriptText: 'unknown head fallback',
    })

    triggerUpgradeWithHead(httpServer as unknown as MockHttpServer, 'nonexistent')
    const ws = getActiveSocket(adapter)
    ws.emit('message', buildWav(32000, 16000), true)
    await new Promise(r => setImmediate(r))

    expect(routesByHead['default']).toEqual([{ channel: 'voice', text: 'unknown head fallback' }])
  })

  it('UNRELATED-PATH STILL REJECTED: /api/other upgrade does not connect (guard does not over-match)', async () => {
    const knownHeadIds = new Set(['default'])
    const { adapter, httpServer } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
    })

    triggerUpgradeNonVoice(httpServer as unknown as MockHttpServer)

    // No connection established — activeSocket stays null
    expect(getActiveSocket(adapter)).toBeNull()
  })

  it('UNRELATED-PATH STILL REJECTED: /api/voice/wsX is not matched (exact pathname guard)', async () => {
    const knownHeadIds = new Set(['default'])
    const { adapter, httpServer } = await setupAdapterWithHeads({
      knownHeadIds,
      defaultHeadId: 'default',
    })

    httpServer.emit('upgrade',
      { url: '/api/voice/wsX?head=default' } as unknown as import('node:http').IncomingMessage,
      {} as unknown as import('node:stream').Duplex,
      Buffer.alloc(0),
    )

    expect(getActiveSocket(adapter)).toBeNull()
  })
})
