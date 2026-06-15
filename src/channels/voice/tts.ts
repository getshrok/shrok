// src/channels/voice/tts.ts
import type OpenAI from 'openai'
import { Readable } from 'node:stream'
import type { WebSocket } from 'ws'
import { log } from '../../logger.js'

/** OpenAI TTS voice used for assistant speech. `alloy` is the SDK default and works
 *  across all `tts-*` models. Used for the OpenAI fallback provider. */
export const TTS_VOICE = 'alloy'

/** OpenAI TTS model. `tts-1` is the low-latency option appropriate for real-time voice;
 *  `tts-1-hd` trades latency for fidelity and is NOT what we want here. Used for the
 *  OpenAI fallback provider. */
export const TTS_MODEL = 'tts-1'

/** Control-frame payloads sent to the browser around the MP3 byte stream. */
export const TTS_START_FRAME = { type: 'tts_start' } as const
export const TTS_DONE_FRAME = { type: 'tts_done' } as const

/** Audio container the synthesis endpoint returns. The browser playback pipeline
 *  (MediaSource Extensions / buffered <audio>) is built for `mp3`. */
export type TtsResponseFormat = 'mp3' | 'wav' | 'opus'

/**
 * One TTS synthesis backend. `streamTts` is given an ORDERED list of these:
 * `providers[0]` is the primary (e.g. the self-hosted Chatterbox endpoint) and any
 * later provider is a fallback (e.g. OpenAI) used only when an earlier one is
 * unreachable. The `label` is for logging; whether a turn is "a fallback" is derived
 * purely from position (index > 0), so the caller doesn't hard-code provider identity.
 *
 * Make the primary client fail FAST (short `timeout`, `maxRetries: 0` at construction)
 * so a powered-off self-hosted box fails over to the fallback quickly instead of hanging.
 */
export interface TtsProvider {
  client: OpenAI
  model: string
  voice: string
  responseFormat: TtsResponseFormat
  /** Human-readable label for logs, e.g. 'self-hosted' or 'openai'. */
  label: string
}

/** True if `err` is the OpenAI SDK's abort error OR a native AbortError. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string }
  return e.name === 'APIUserAbortError' || e.name === 'AbortError'
}

/** Minimal shape of what `openai.audio.speech.create(...).asResponse()` yields:
 *  a Fetch `Response` whose `body` is a web ReadableStream (or a Node Readable). */
interface SpeechResponse {
  body: ReadableStream<Uint8Array> | Readable | null
}

/** Open a speech response from a single provider. Resolves once response headers
 *  arrive (i.e. the connection is established and the server has answered); throws on
 *  connection failure / timeout / HTTP error BEFORE any audio bytes are streamed —
 *  which is exactly what lets the caller fail over to the next provider without
 *  having already sent a partial stream to the browser. */
async function openSpeech(p: TtsProvider, text: string, signal: AbortSignal): Promise<SpeechResponse> {
  return (await p.client.audio.speech
    .create(
      { model: p.model, voice: p.voice, input: text, response_format: p.responseFormat },
      { signal },
    )
    .asResponse()) as SpeechResponse
}

/**
 * Stream TTS audio to a connected WebSocket as MP3 binary frames, with primary →
 * fallback provider selection.
 *
 * Provider selection (availability/fallback): the providers are tried IN ORDER and a
 * provider is committed to BEFORE `tts_start` is sent — so when the self-hosted box is
 * off and the primary connection fails, we transparently fall back to the next provider
 * and the browser never receives a half-streamed turn. When a fallback (index > 0)
 * serves the turn, `tts_start` carries `fallback: true` so the UI can show a visible
 * "via OpenAI fallback" badge (no surprise paid usage). The self-hosted/primary path
 * stays silent (`{ type: 'tts_start' }`).
 *
 * Emits `tts_start` JSON frame before the first chunk, pipes raw MP3 chunks as binary
 * frames (no buffering — MediaSource Extensions on the client needs a live stream), and
 * emits `tts_done` JSON frame after clean completion.
 *
 * Cancellation (D-07, VOICE-OUT-04):
 *   - The `signal` parameter is threaded into the OpenAI request options so
 *     `AbortController.abort()` closes the upstream HTTPS connection.
 *   - On abort, this function re-throws a typed AbortError (caller distinguishes
 *     via `isAbortError`); no `tts_done` is sent because the stream was
 *     interrupted, not completed.
 *
 * Client disconnect (Pitfall 3): every chunk is guarded by `ws.readyState === OPEN`
 * so async-iteration gaps that coincide with disconnect do not throw.
 */
export async function streamTts(
  text: string,
  providers: TtsProvider[],
  ws: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  if (providers.length === 0) throw new Error('streamTts: no TTS providers configured')

  // ── Provider selection BEFORE any tts_start ──────────────────────────────────
  // Try each provider in order; the first to return response headers wins. A
  // connection failure (box off / timeout) on the primary falls through to the next.
  // Doing this before tts_start guarantees we never half-stream then switch.
  let response: SpeechResponse | null = null
  let usedIndex = -1
  let lastErr: unknown = null
  for (let i = 0; i < providers.length; i++) {
    if (signal.aborted) {
      throw Object.assign(new Error('TTS aborted by signal'), { name: 'AbortError' })
    }
    const p = providers[i]!
    try {
      // D-07: thread the AbortSignal into the SDK's request options so abort()
      // cancels the upstream HTTP request rather than just the local stream.
      response = await openSpeech(p, text, signal)
      usedIndex = i
      break
    } catch (err) {
      if (isAbortError(err)) throw err
      lastErr = err
      const more = i < providers.length - 1
      log.warn(`[voice] TTS provider "${p.label}" failed${more ? ', falling back to next' : ''}: ${(err as Error).message}`)
    }
  }
  if (!response || usedIndex < 0) {
    throw lastErr ?? new Error('TTS: all providers failed')
  }

  // A fallback was used iff the provider that answered was not the configured primary.
  const usedFallback = usedIndex > 0
  if (usedFallback) {
    log.info(`[voice] TTS served via fallback provider "${providers[usedIndex]!.label}"`)
  }

  // Open-state check: if the socket closed between SDK call and first chunk,
  // bail without sending tts_start at all.
  if (ws.readyState !== 1 /* OPEN */) return

  // Self-hosted/primary path is silent; fallback path is flagged so the UI badges it.
  ws.send(JSON.stringify(usedFallback ? { type: 'tts_start', fallback: true } : TTS_START_FRAME))

  const body = response.body
  if (!body) {
    // No stream body — treat as immediate completion (highly unusual for TTS).
    ws.send(JSON.stringify(TTS_DONE_FRAME))
    return
  }

  // The OpenAI SDK may return either a WHATWG ReadableStream or a Node.js Readable
  // (PassThrough) depending on the underlying transport. Readable.fromWeb() throws
  // on a Node.js stream, so detect and use it directly in that case.
  // Abort is handled by the signal.aborted checks in the loop below, and the
  // OpenAI HTTP request is already cancelled via the signal passed to .create().
  const readable: AsyncIterable<Buffer | Uint8Array> = body instanceof Readable
    ? body
    : Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>, { signal })
  for await (const chunk of readable) {
    if (signal.aborted) {
      // Caller aborted; stop without tts_done and re-throw a typed
      // AbortError so the caller's isAbortError() branch runs. Some runtime
      // paths deliver abort via signal polling before the SDK stream
      // throws APIUserAbortError — we must not let those paths resolve
      // silently, or the plan's re-throw contract breaks and the adapter's
      // abort-logging branch is unreachable.
      throw Object.assign(new Error('TTS aborted by signal'), { name: 'AbortError' })
    }
    if (ws.readyState !== 1 /* OPEN */) return
    // chunk is Buffer under node:stream when consumed via for-await
    ws.send(chunk as Buffer)
  }
  // Errors (including abort errors from the SDK) propagate to caller naturally.
  // Caller uses isAbortError() to distinguish abort from real upstream failures.

  // Post-loop abort check: if the signal was aborted while the last chunk was
  // being consumed (abort fires concurrently with the final pull cycle), the
  // polling guard inside the loop never observes it. Re-check here so we never
  // emit tts_done or resolve cleanly after an abort.
  if (signal.aborted) {
    throw Object.assign(new Error('TTS aborted by signal'), { name: 'AbortError' })
  }

  // Only emit tts_done on clean completion and only if the socket is still open.
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(TTS_DONE_FRAME))
  }
}
