// src/channels/voice/stt.ts
import type OpenAI from 'openai'
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

/**
 * Transcribe a WAV buffer using OpenAI Whisper.
 *
 * Implements phase 19 D-04 (File-object boundary, no disk I/O) and D-05
 * (duration gate BEFORE the API call). Callers should catch TooShortError
 * and InvalidWavError separately from upstream SDK errors.
 */
export async function transcribeWav(buf: Buffer, openai: OpenAI): Promise<string> {
  const duration = parseWavDuration(buf)
  if (duration === null) throw new InvalidWavError()
  if (duration < MIN_WAV_DURATION_SECONDS) throw new TooShortError(duration)

  // D-04: wrap Buffer in a Web API File object. Node 22's global File satisfies
  // openai's FileLike type. No temp file, no FormData construction.
  const file = new File([buf], 'audio.wav', { type: 'audio/wav' })
  const result = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  })
  // Whisper's default response_format is 'json' which returns { text: string }.
  // Trim to strip Whisper's trailing newline/space on short utterances.
  return (result.text ?? '').trim()
}
