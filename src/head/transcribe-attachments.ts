// src/head/transcribe-attachments.ts
//
// Pure ingestion helper: transcribes a message's audio attachments using OpenAI
// Whisper and returns a new InboundMessage with transcript text injected.
//
// Design rules (Phase me4):
//  - Never mutates the input message
//  - Never throws — all errors degrade to today's path (attachment kept, no transcript)
//  - When sttProviders is empty (no key and no sttBaseUrl), returns the message unchanged
//  - ALL original attachments are always kept on the returned message
//  - Transcript lines are prepended to existing typed text so the model sees them first

import * as fs from 'node:fs'
import { transcribeWithFallback, type SttProvider } from '../channels/voice/stt.js'
import { log } from '../logger.js'
import type { InboundMessage } from '../types/channel.js'
import type { Attachment } from '../types/core.js'

/** Defensive size ceiling — reject files larger than Whisper's 25 MB hard limit */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * Load the audio bytes for an attachment.
 * Returns null if the attachment has neither path nor url, or if the load fails.
 */
async function loadAudioBuffer(att: Attachment): Promise<Buffer | null> {
  if (att.path) {
    return fs.readFileSync(att.path)
  }
  if (att.url) {
    const response = await fetch(att.url)
    return Buffer.from(await response.arrayBuffer())
  }
  return null
}

/**
 * Transcribe all audio attachments on an inbound message and inject the
 * transcripts into the message text as `[voice transcript] ...` lines.
 *
 * @param msg          The inbound message (never mutated)
 * @param sttProviders Ordered STT provider list (primary first). Empty = no transcription
 *                     (fast-path: message returned unchanged, same as the old openai=null path)
 * @returns            A new InboundMessage — original if no transcription occurred, or
 *                     a clone with `text` updated and `attachments` preserved exactly
 */
export async function transcribeInboundAudio(
  msg: InboundMessage,
  sttProviders: SttProvider[],
): Promise<InboundMessage> {
  // Fast path: no providers or no audio attachments — return the message unchanged
  if (sttProviders.length === 0) return msg

  const hasAudio = msg.attachments?.some(a => a.type === 'audio') ?? false
  if (!hasAudio) return msg

  const transcriptLines: string[] = []

  for (const att of (msg.attachments ?? [])) {
    if (att.type !== 'audio') continue

    let buf: Buffer | null = null
    try {
      buf = await loadAudioBuffer(att)
    } catch (err) {
      log.warn(
        `[transcribeInboundAudio] failed to load audio attachment` +
        ` (${att.filename ?? att.mediaType}): ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    if (buf === null) {
      log.debug(`[transcribeInboundAudio] audio attachment has no path or url — skipping`)
      continue
    }

    if (buf.length >= MAX_AUDIO_BYTES) {
      log.warn(
        `[transcribeInboundAudio] audio attachment too large (${buf.length} bytes >= ${MAX_AUDIO_BYTES}) — skipping transcription`,
      )
      continue
    }

    let transcript: string
    try {
      transcript = await transcribeWithFallback(buf, att.filename ?? att.mediaType, sttProviders)
    } catch (err) {
      log.warn(
        `[transcribeInboundAudio] Whisper transcription failed` +
        ` (${att.filename ?? att.mediaType}): ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    if (!transcript) continue
    transcriptLines.push(`[voice transcript] ${transcript}`)
  }

  // If no transcripts were produced, return the original message unchanged
  if (transcriptLines.length === 0) return msg

  // Merge: transcript lines first (model sees them prominently), then existing typed text
  const transcriptBlock = transcriptLines.join('\n')
  const mergedText = msg.text
    ? `${transcriptBlock}\n\n${msg.text}`
    : transcriptBlock

  // Build a new message — honor exactOptionalPropertyTypes (never set optional keys to undefined)
  const updated: InboundMessage = {
    channel: msg.channel,
    text: mergedText,
    ...(msg.senderName !== undefined ? { senderName: msg.senderName } : {}),
    ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
    ...(msg.rawPayload !== undefined ? { rawPayload: msg.rawPayload } : {}),
  }

  return updated
}
