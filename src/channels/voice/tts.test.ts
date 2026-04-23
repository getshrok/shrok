// src/channels/voice/tts.test.ts
import { describe, it, expect, vi } from 'vitest'
import { streamTts, isAbortError, TTS_VOICE, TTS_MODEL } from './tts.js'

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

describe('streamTts', () => {
  it('sends tts_start, forwards binary chunks, then sends tts_done', async () => {
    const chunks = [new Uint8Array([0x01, 0x02]), new Uint8Array([0x03, 0x04]), new Uint8Array([0x05])]
    const body = makeWebStream(chunks)
    const { client } = makeMockOpenAI(body)
    const ws = new MockWS() as unknown as import('ws').WebSocket
    const ac = new AbortController()

    await streamTts('hello', client, ws, ac.signal)

    const sent = (ws as unknown as MockWS).sent
    // First frame: tts_start JSON
    expect(sent[0]!.kind).toBe('text')
    expect(JSON.parse(sent[0]!.value as string)).toEqual({ type: 'tts_start' })
    // Middle frames: binary chunks in order
    expect(sent[1]!.kind).toBe('binary')
    expect(sent[2]!.kind).toBe('binary')
    expect(sent[3]!.kind).toBe('binary')
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

    await streamTts('hi', client, ws, ac.signal)

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

    // Abort after the first chunk is consumed
    const p = streamTts('hi', client, ws, ac.signal)
    setTimeout(() => ac.abort(), 5)

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

    await expect(streamTts('hi', client, ws, new AbortController().signal)).resolves.toBeUndefined()

    // No tts_done because the socket closed during the stream
    const sent = mockWs.sent
    const doneFrames = sent.filter(f => f.kind === 'text' && (f.value as string).includes('tts_done'))
    expect(doneFrames).toHaveLength(0)
  })

  it('does not send tts_start if the SDK throws before the stream begins', async () => {
    const err = new Error('auth failure')
    const { client } = makeMockOpenAI(null, { throwOnCreate: err })
    const ws = new MockWS() as unknown as import('ws').WebSocket

    await expect(streamTts('hi', client, ws, new AbortController().signal)).rejects.toBe(err)
    const sent = (ws as unknown as MockWS).sent
    expect(sent).toHaveLength(0)
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
