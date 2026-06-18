// src/channels/voice/stt.ts
import type OpenAI from 'openai'
import { log } from '../../logger.js'
import { parseWavDuration } from './wav.js'

/** Thrown when a WAV clip is rejected by the 500ms duration gate (D-05). */
export class TooShortError extends Error {
  readonly durationSeconds: number
  constructor(durationSeconds: number) {
    super(`WAV clip too short: ${durationSeconds.toFixed(3)}s < 0.5s`)
    this.name = 'TooShortError'
    this.durationSeconds = durationSeconds
  }
}

/** Thrown when the buffer cannot be parsed as a WAV (malformed header, truncated, etc.). */
export class InvalidWavError extends Error {
  constructor() {
    super('WAV buffer is malformed or missing RIFF/WAVE/data chunks')
    this.name = 'InvalidWavError'
  }
}

/** Minimum acceptable WAV duration in seconds. Short clips are rejected without
 *  calling Whisper to avoid hallucinated transcripts on silence/noise (D-05). */
export const MIN_WAV_DURATION_SECONDS = 0.5

/** Map a filename or MIME type to a Whisper-safe { name, mimeType } pair.
 *  Whisper relies on the File extension / type to pick the correct audio decoder.
 *  Supported extensions: mp3 mp4 mpeg mpga m4a wav webm ogg.
 */
function resolveAudioFile(nameOrMediaType: string): { name: string; mimeType: string } {
  // If it looks like a filename with a supported extension, reuse it as-is.
  const supportedExtRe = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm|ogg)$/i
  if (supportedExtRe.test(nameOrMediaType)) {
    // Derive mimeType from extension
    const ext = nameOrMediaType.split('.').pop()?.toLowerCase() ?? ''
    const extToMime: Record<string, string> = {
      mp3: 'audio/mpeg', mp4: 'audio/mp4', mpeg: 'audio/mpeg',
      mpga: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
      webm: 'audio/webm', ogg: 'audio/ogg',
    }
    return { name: nameOrMediaType, mimeType: extToMime[ext] ?? 'audio/octet-stream' }
  }

  // Otherwise treat as a MIME type — strip parameters (e.g. '; codecs=opus')
  const baseMime = (nameOrMediaType.split(';')[0] ?? nameOrMediaType).trim().toLowerCase()
  const mimeToExt: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/mpga': 'mp3',
    'audio/mpegx': 'mp3',
  }
  const ext = mimeToExt[baseMime]
  if (ext) {
    return { name: `audio.${ext}`, mimeType: baseMime }
  }
  // Unrecognized — fall back to generic name + original MIME type; let Whisper try
  return { name: 'audio.bin', mimeType: nameOrMediaType }
}

/**
 * Transcribe any audio buffer using OpenAI Whisper.
 *
 * Unlike transcribeWav, this function:
 *  - accepts any audio format supported by Whisper (ogg, mp3, m4a, wav, webm, …)
 *  - does NOT parse RIFF/WAV headers
 *  - does NOT enforce the 0.5s minimum duration gate (that is live-mic-specific)
 *  - propagates SDK errors unchanged — callers own graceful-degradation try/catch
 *
 * @param buf         Audio bytes to transcribe
 * @param nameOrMediaType  Either a filename with supported extension (e.g. 'voice.m4a')
 *                         or a MIME type (e.g. 'audio/ogg'). Used to derive the File
 *                         name+type so Whisper selects the correct decoder.
 * @param openai      Authenticated OpenAI client
 * @param model       Whisper model to request (defaults to 'whisper-1')
 */
export async function transcribeAudio(
  buf: Buffer,
  nameOrMediaType: string,
  openai: OpenAI,
  model = 'whisper-1',
): Promise<string> {
  const { name, mimeType } = resolveAudioFile(nameOrMediaType)
  const file = new File([buf], name, { type: mimeType })
  const result = await openai.audio.transcriptions.create({
    file,
    model,
  })
  return (result.text ?? '').trim()
}

/**
 * One STT transcription backend. `transcribeWithFallback` is given an ORDERED list
 * of these: `providers[0]` is the primary (e.g. the self-hosted Whisper endpoint) and
 * any later provider is a fallback (e.g. OpenAI) used only when an earlier one fails.
 */
export interface SttProvider {
  client: OpenAI
  /** Human-readable label for logs, e.g. 'self-hosted' or 'openai'. */
  label: string
}

/**
 * Transcribe audio with primary → fallback provider selection.
 *
 * Tries each provider in order. Returns the first successful transcript. On a thrown
 * error from provider i, logs a warn (mirroring the TTS provider wording) and tries
 * the next. If all providers throw, re-throws the last error (caller degrades).
 *
 * STT calls are short (no streaming half-send concern), so a simple try/catch loop
 * is the clean analog to the TTS provider loop.
 */
export async function transcribeWithFallback(
  buf: Buffer,
  nameOrMediaType: string,
  providers: SttProvider[],
): Promise<string> {
  if (providers.length === 0) throw new Error('transcribeWithFallback: no STT providers configured')
  let lastErr: unknown = null
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!
    try {
      return await transcribeAudio(buf, nameOrMediaType, p.client)
    } catch (err) {
      lastErr = err
      const more = i < providers.length - 1
      log.warn(`[voice] STT provider "${p.label}" failed${more ? ', falling back to next' : ''}: ${(err as Error).message}`)
    }
  }
  throw lastErr ?? new Error('STT: all providers failed')
}

/**
 * Transcribe a WAV buffer with primary → fallback provider selection.
 *
 * Runs the 0.5s duration gate (TooShortError / InvalidWavError) BEFORE any provider
 * is tried — gate failures propagate immediately and do NOT trigger fallback (they are
 * local rejects, not network failures). After passing the gate, delegates to
 * `transcribeWithFallback`.
 */
export async function transcribeWavWithFallback(
  buf: Buffer,
  providers: SttProvider[],
): Promise<string> {
  const duration = parseWavDuration(buf)
  if (duration === null) throw new InvalidWavError()
  if (duration < MIN_WAV_DURATION_SECONDS) throw new TooShortError(duration)

  return transcribeWithFallback(buf, 'audio/wav', providers)
}

/**
 * Transcribe a WAV buffer (live-mic turns) using OpenAI Whisper.
 *
 * WAV-specific wrapper around the single transcription implementation
 * (`transcribeAudio`): it adds the phase-19 D-05 duration gate BEFORE the API
 * call (reject silence/noise shorter than 0.5s so Whisper doesn't hallucinate),
 * then delegates the actual Whisper call. `'audio/wav'` resolves to a File named
 * `audio.wav` (type `audio/wav`) — identical to the former inline File-object
 * boundary (D-04, no disk I/O). Callers should catch TooShortError and
 * InvalidWavError separately from upstream SDK errors.
 */
export async function transcribeWav(buf: Buffer, openai: OpenAI): Promise<string> {
  const duration = parseWavDuration(buf)
  if (duration === null) throw new InvalidWavError()
  if (duration < MIN_WAV_DURATION_SECONDS) throw new TooShortError(duration)

  // Single transcription implementation — delegate the Whisper call to transcribeAudio.
  return transcribeAudio(buf, 'audio/wav', openai)
}
