// src/channels/voice/tts.ts
import type OpenAI from 'openai'
import { Readable } from 'node:stream'
import type { WebSocket } from 'ws'

/** OpenAI TTS voice used for assistant speech. `alloy` is the SDK default and works
 *  across all `tts-*` models. Change here if the phase 21 UI exposes a picker. */
export const TTS_VOICE = 'alloy'

/** OpenAI TTS model. `tts-1` is the low-latency option appropriate for real-time voice;
 *  `tts-1-hd` trades latency for fidelity and is NOT what we want here. */
export const TTS_MODEL = 'tts-1'

/** Control-frame payloads sent to the browser around the MP3 byte stream. */
export const TTS_START_FRAME = { type: 'tts_start' } as const
export const TTS_DONE_FRAME = { type: 'tts_done' } as const

/** True if `err` is the OpenAI SDK's abort error OR a native AbortError. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string }
  return e.name === 'APIUserAbortError' || e.name === 'AbortError'
}

/**
 * Stream OpenAI TTS audio to a connected WebSocket as MP3 binary frames.
 *
 * Emits `tts_start` JSON frame before the first chunk, pipes raw MP3 chunks
 * as binary frames (no buffering — MediaSource Extensions on the client needs
 * a live stream), and emits `tts_done` JSON frame after clean completion.
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
  openai: OpenAI,
  ws: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  // D-07: thread the AbortSignal into the SDK's request options so abort()
  // cancels the upstream HTTP request rather than just the local stream.
  const response = await openai.audio.speech
    .create(
      { model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3' },
      { signal },
    )
    .asResponse()

  // Open-state check: if the socket closed between SDK call and first chunk,
  // bail without sending tts_start at all.
  if (ws.readyState !== 1 /* OPEN */) return

  ws.send(JSON.stringify(TTS_START_FRAME))

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
