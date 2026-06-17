// src/channels/voice/tts.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  streamTts, isAbortError, TTS_VOICE, TTS_MODEL,
  createSelfHostedTtsFetch, TTS_SELF_HOSTED_CONNECT_TIMEOUT_MS, TTS_SELF_HOSTED_RESPONSE_TIMEOUT_MS,
  type TtsProvider,
} from './tts.js'

// Mock undici so we can assert HOW the self-hosted fetch is wired without real sockets.
const { agentCtor, undiciFetchMock } = vi.hoisted(() => ({
  agentCtor: vi.fn(),
  undiciFetchMock: vi.fn(async () => ({ ok: true } as unknown)),
}))
vi.mock('undici', () => ({
  Agent: class { constructor(opts: unknown) { agentCtor(opts) } },
  fetch: (...args: unknown[]) => undiciFetchMock(...(args as [])),
}))

// Wrap a mock OpenAI client into a single-provider list (the common case).
function providersFor(
  client: import('openai').default,
  overrides?: Partial<Omit<TtsProvider, 'client'>>,
): TtsProvider[] {
  return [{
    client,
    model: TTS_MODEL,
    voice: TTS_VOICE,
    responseFormat: 'mp3',
    label: 'openai',
    ...overrides,
  }]
}

// ─── Mock WebSocket ────────────────────────────────────────────────────────────
class MockWS {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState: 0 | 1 | 2 | 3 = 1
  sent: Array<{ kind: 'text' | 'binary'; value: string | Buffer }> = []
  send(data: unknown): void {
    if (typeof data === 'string') this.sent.push({ kind: 'text', value: data })
    else this.sent.push({ kind: 'binary', value: data as Buffer })
  }
}

// ─── Helpers to build a Web ReadableStream from chunk arrays ──────────────────
function makeWebStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(chunks[i++]!)
    },
  })
}

function makeAbortableWebStream(chunks: Uint8Array[], abortSignal: AbortSignal): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (abortSignal.aborted) { controller.error(makeAbortError()); return }
      if (i >= chunks.length) { controller.close(); return }
      // Yield control so the abort can fire between chunks
      await new Promise(r => setTimeout(r, 0))
      if (abortSignal.aborted) { controller.error(makeAbortError()); return }
      controller.enqueue(chunks[i++]!)
    },
  })
}

function makeAbortError(): Error {
  const e = new Error('Request was aborted')
  e.name = 'APIUserAbortError'
  return e
}

function makeMockOpenAI(body: ReadableStream<Uint8Array> | null, opts?: { throwOnCreate?: Error }) {
  const create = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
    if (opts?.throwOnCreate) throw opts.throwOnCreate
    // Mimic openai SDK's APIPromise: has .asResponse()
    const asResponse = async () => ({ body })
    return { asResponse, _capturedSignal: options?.signal }
  })
  const client = {
    audio: { speech: { create } },
  } as unknown as import('openai').default
  return { client, create }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('createSelfHostedTtsFetch', () => {
  it('builds the dispatcher with a SHORT connect timeout and a LONG response timeout', () => {
    agentCtor.mockClear()
    createSelfHostedTtsFetch()
    // The split is the whole point: a healthy box may take >5s to synthesize a long
    // reply (allowed by the response timeout), while a dead box fails the connect fast.
    expect(agentCtor).toHaveBeenCalledWith({
      connect: { timeout: TTS_SELF_HOSTED_CONNECT_TIMEOUT_MS },
      headersTimeout: TTS_SELF_HOSTED_RESPONSE_TIMEOUT_MS,
      bodyTimeout: TTS_SELF_HOSTED_RESPONSE_TIMEOUT_MS,
    })
    expect(TTS_SELF_HOSTED_CONNECT_TIMEOUT_MS).toBeLessThan(TTS_SELF_HOSTED_RESPONSE_TIMEOUT_MS)
  })

  it('routes requests through the dispatcher, preserving the original init', async () => {
    undiciFetchMock.mockClear()
    // Call through a loose signature — the SDK's Fetch param type (node-fetch's
    // RequestInfo) is awkward to satisfy from a test and irrelevant to what we assert.
    const f = createSelfHostedTtsFetch() as unknown as (url: string, init?: Record<string, unknown>) => Promise<unknown>
    await f('http://tts.local/v1/audio/speech', { method: 'POST' })
    expect(undiciFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = undiciFetchMock.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(init).toHaveProperty('dispatcher')
    expect(init['method']).toBe('POST')
  })
})

describe('streamTts', () => {
  it('sends tts_start, forwards binary chunks, then sends tts_done', async () => {
    const chunks = [new Uint8Array([0x01, 0x02]), new Uint8Array([0x03, 0x04]), new Uint8Array([0x05])]
    const body = makeWebStream(chunks)
    const { client } = makeMockOpenAI(body)
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const ac = new AbortController()

    await streamTts('hello', providersFor(client), ws, ac.signal)

    const sent = (ws as unknown as MockWS).sent
    // First frame: tts_start JSON
    expect(sent[0]!.kind).toBe('text')
    expect(JSON.parse(sent[0]!.value as string)).toEqual({ type: 'tts_start' })
    // Middle frames: at least one binary chunk (Readable.fromWeb may coalesce Uint8Array chunks)
    const binaryFrames = sent.slice(1, -1)
    expect(binaryFrames.length).toBeGreaterThanOrEqual(1)
    for (const frame of binaryFrames) {
      expect(frame.kind).toBe('binary')
    }
    // Last frame: tts_done JSON
    const last = sent[sent.length - 1]!
    expect(last.kind).toBe('text')
    expect(JSON.parse(last.value as string)).toEqual({ type: 'tts_done' })
  })

  it('passes the AbortSignal into openai.audio.speech.create request options', async () => {
    const body = makeWebStream([new Uint8Array([0x01])])
    const { client, create } = makeMockOpenAI(body)
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const ac = new AbortController()

    await streamTts('hi', providersFor(client), ws, ac.signal)

    expect(create).toHaveBeenCalledTimes(1)
    const [params, options] = create.mock.calls[0]!
    expect((params as { model: string }).model).toBe(TTS_MODEL)
    expect((params as { voice: string }).voice).toBe(TTS_VOICE)
    expect((params as { response_format: string }).response_format).toBe('mp3')
    expect((options as { signal: AbortSignal }).signal).toBe(ac.signal)
  })

  it('stops iterating when the signal is aborted and does NOT send tts_done', async () => {
    const ac = new AbortController()
    const chunks = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03])]
    const body = makeAbortableWebStream(chunks, ac.signal)
    const { client } = makeMockOpenAI(body)
    const ws = new MockWS() as unknown as import('ws').WebSocket

    // Abort immediately — fires before Readable.fromWeb processes any chunks.
    // The signal is aborted by the time streamTts resumes after await asResponse(),
    // so Node.js destroys the readable instantly and the for-await throws AbortError.
    const p = streamTts('hi', providersFor(client), ws, ac.signal)
    ac.abort()

    await expect(p).rejects.toSatisfy((e: unknown) => isAbortError(e))

    const sent = (ws as unknown as MockWS).sent
    // tts_start was emitted, but tts_done must NOT be present
    const doneFrames = sent.filter(f => f.kind === 'text' && (f.value as string).includes('tts_done'))
    expect(doneFrames).toHaveLength(0)
  })

  it('stops sending when ws.readyState becomes non-OPEN mid-stream (no throw)', async () => {
    const chunks = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03])]
    const body = makeWebStream(chunks)
    const { client } = makeMockOpenAI(body)
    const mockWs = new MockWS()
    const ws = mockWs as unknown as import('ws').WebSocket

    // Override send so the second invocation simulates a disconnect mid-stream
    let callCount = 0
    const origSend = mockWs.send.bind(mockWs)
    mockWs.send = (data: unknown) => {
      origSend(data)
      callCount++
      if (callCount === 2) mockWs.readyState = MockWS.CLOSED
    }

    await expect(streamTts('hi', providersFor(client), ws, new AbortController().signal)).resolves.toBeUndefined()

    // No tts_done because the socket closed during the stream
    const sent = mockWs.sent
    const doneFrames = sent.filter(f => f.kind === 'text' && (f.value as string).includes('tts_done'))
    expect(doneFrames).toHaveLength(0)
  })

  it('does not send tts_start if the SDK throws before the stream begins', async () => {
    const err = new Error('auth failure')
    const { client } = makeMockOpenAI(null, { throwOnCreate: err })
    const ws = new MockWS() as unknown as import('ws').WebSocket

    await expect(streamTts('hi', providersFor(client), ws, new AbortController().signal)).rejects.toBe(err)
    const sent = (ws as unknown as MockWS).sent
    expect(sent).toHaveLength(0)
  })

  it('falls back to the next provider when the primary connection fails, and flags tts_start fallback:true', async () => {
    const primaryErr = Object.assign(new Error('ECONNREFUSED'), { name: 'APIConnectionError' })
    const { client: primary, create: primaryCreate } = makeMockOpenAI(null, { throwOnCreate: primaryErr })
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI(makeWebStream([new Uint8Array([0xaa])]))
    const ws = new MockWS() as unknown as import('ws').WebSocket

    const providers: TtsProvider[] = [
      { client: primary, model: 'chatterbox-turbo', voice: 'Adrian.wav', responseFormat: 'mp3', label: 'self-hosted' },
      { client: fallback, model: TTS_MODEL, voice: TTS_VOICE, responseFormat: 'mp3', label: 'openai' },
    ]

    await streamTts('hi', providers, ws, new AbortController().signal)

    expect(primaryCreate).toHaveBeenCalledTimes(1)
    expect(fallbackCreate).toHaveBeenCalledTimes(1)
    const sent = (ws as unknown as MockWS).sent
    // tts_start carries fallback:true because a non-primary provider served the turn
    expect(sent[0]!.kind).toBe('text')
    expect(JSON.parse(sent[0]!.value as string)).toEqual({ type: 'tts_start', fallback: true })
    // stream still completes with tts_done
    const last = sent[sent.length - 1]!
    expect(JSON.parse(last.value as string)).toEqual({ type: 'tts_done' })
  })

  it('does NOT flag fallback when the primary provider succeeds', async () => {
    const { client: primary } = makeMockOpenAI(makeWebStream([new Uint8Array([0x01])]))
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI(makeWebStream([new Uint8Array([0x02])]))
    const ws = new MockWS() as unknown as import('ws').WebSocket

    const providers: TtsProvider[] = [
      { client: primary, model: 'chatterbox-turbo', voice: 'Adrian.wav', responseFormat: 'mp3', label: 'self-hosted' },
      { client: fallback, model: TTS_MODEL, voice: TTS_VOICE, responseFormat: 'mp3', label: 'openai' },
    ]

    await streamTts('hi', providers, ws, new AbortController().signal)

    // fallback never invoked; tts_start has no fallback flag
    expect(fallbackCreate).not.toHaveBeenCalled()
    const sent = (ws as unknown as MockWS).sent
    expect(JSON.parse(sent[0]!.value as string)).toEqual({ type: 'tts_start' })
  })

  it('sends the per-provider model/voice/format to the SDK (self-hosted primary)', async () => {
    const { client, create } = makeMockOpenAI(makeWebStream([new Uint8Array([0x01])]))
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const providers: TtsProvider[] = [
      { client, model: 'chatterbox-turbo', voice: 'Adrian.wav', responseFormat: 'mp3', label: 'self-hosted' },
    ]

    await streamTts('hi', providers, ws, new AbortController().signal)

    const [params] = create.mock.calls[0]!
    expect((params as { model: string }).model).toBe('chatterbox-turbo')
    expect((params as { voice: string }).voice).toBe('Adrian.wav')
    expect((params as { response_format: string }).response_format).toBe('mp3')
  })

  it('throws when every provider fails and sends nothing', async () => {
    const e1 = new Error('primary down')
    const e2 = new Error('fallback down')
    const { client: c1 } = makeMockOpenAI(null, { throwOnCreate: e1 })
    const { client: c2 } = makeMockOpenAI(null, { throwOnCreate: e2 })
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const providers: TtsProvider[] = [
      { client: c1, model: 'chatterbox-turbo', voice: 'Adrian.wav', responseFormat: 'mp3', label: 'self-hosted' },
      { client: c2, model: TTS_MODEL, voice: TTS_VOICE, responseFormat: 'mp3', label: 'openai' },
    ]

    // The last provider's error is surfaced
    await expect(streamTts('hi', providers, ws, new AbortController().signal)).rejects.toBe(e2)
    expect((ws as unknown as MockWS).sent).toHaveLength(0)
  })

  it('does NOT fall back when the primary failure is an abort', async () => {
    const abortErr = makeAbortError()
    const { client: primary } = makeMockOpenAI(null, { throwOnCreate: abortErr })
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI(makeWebStream([new Uint8Array([0x01])]))
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const providers: TtsProvider[] = [
      { client: primary, model: 'chatterbox-turbo', voice: 'Adrian.wav', responseFormat: 'mp3', label: 'self-hosted' },
      { client: fallback, model: TTS_MODEL, voice: TTS_VOICE, responseFormat: 'mp3', label: 'openai' },
    ]

    // Abort must propagate immediately, NOT trigger a fallback to the paid path
    await expect(streamTts('hi', providers, ws, new AbortController().signal)).rejects.toSatisfy((e: unknown) => isAbortError(e))
    expect(fallbackCreate).not.toHaveBeenCalled()
  })

  it('isAbortError returns true for APIUserAbortError and AbortError', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }))).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError('string')).toBe(false)
  })
})
