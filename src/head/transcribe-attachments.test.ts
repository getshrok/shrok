// src/head/transcribe-attachments.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transcribeInboundAudio } from './transcribe-attachments.js'
import type { SttProvider } from '../channels/voice/stt.js'
import type { InboundMessage } from '../types/channel.js'
import type { Attachment } from '../types/core.js'

// ─── Mock OpenAI helper ────────────────────────────────────────────────────────

function makeMockOpenAI(text: string) {
  const create = vi.fn(async (_params: unknown) => ({ text }))
  return {
    create,
    client: { audio: { transcriptions: { create } } } as unknown as import('openai').default,
  }
}

function makeMockOpenAIThrows(err: Error) {
  const create = vi.fn(async () => { throw err })
  return {
    create,
    client: { audio: { transcriptions: { create } } } as unknown as import('openai').default,
  }
}

/** Convenience wrapper: single-provider list (mirrors old single-client usage). */
function singleProvider(client: import('openai').default, label = 'openai'): SttProvider[] {
  return [{ client, label }]
}

// ─── Temp file helpers ─────────────────────────────────────────────────────────

let tmpFiles: string[] = []

function writeTmpAudio(content: Buffer | string): string {
  const filePath = path.join(os.tmpdir(), `shrok-test-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`)
  fs.writeFileSync(filePath, content)
  tmpFiles.push(filePath)
  return filePath
}

beforeEach(() => { tmpFiles = [] })
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
})

// ─── Test cases ────────────────────────────────────────────────────────────────

describe('transcribeInboundAudio', () => {
  it('(1) empty providers → returned message identical (text + attachments unchanged)', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-audio'))
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = {
      channel: 'telegram',
      text: 'existing text',
      attachments: [att],
    }
    const result = await transcribeInboundAudio(msg, [])
    expect(result.text).toBe('existing text')
    expect(result.attachments).toEqual([att])
  })

  it('(2) audio attachment with path → transcript injected as [voice transcript] AND attachment still present', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-ogg-data'))
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = { channel: 'discord', text: '', attachments: [att] }
    const { client } = makeMockOpenAI('hello from voice')
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    expect(result.text).toContain('[voice transcript] hello from voice')
    // Attachment must be kept
    expect(result.attachments).toEqual([att])
  })

  it('(3) existing typed text preserved alongside transcript (transcripts first)', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-ogg-data'))
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = { channel: 'discord', text: 'check this out', attachments: [att] }
    const { client } = makeMockOpenAI('audio transcript here')
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    // Transcript line first, then blank line, then original typed text
    expect(result.text).toContain('[voice transcript] audio transcript here')
    expect(result.text).toContain('check this out')
    // Transcripts come before the typed text
    const transcriptIdx = result.text.indexOf('[voice transcript]')
    const textIdx = result.text.indexOf('check this out')
    expect(transcriptIdx).toBeLessThan(textIdx)
  })

  it('(4) transcription failure (SDK throws) → message attachment kept, no transcript line, does not throw', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-ogg-data'))
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = { channel: 'discord', text: 'user typed', attachments: [att] }
    const { client } = makeMockOpenAIThrows(new Error('sdk-failure'))
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    // Must not throw
    expect(result.attachments).toEqual([att])
    // No transcript injected
    expect(result.text).not.toContain('[voice transcript]')
    // Original typed text preserved
    expect(result.text).toBe('user typed')
  })

  it('(5) empty transcript → no line injected, attachment kept', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-ogg-data'))
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = { channel: 'discord', text: '', attachments: [att] }
    const { client } = makeMockOpenAI('   ')  // whitespace-only → trim → empty
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    expect(result.text).not.toContain('[voice transcript]')
    expect(result.attachments).toEqual([att])
  })

  it('(6) two audio attachments → two [voice transcript] lines in order', async () => {
    const path1 = writeTmpAudio(Buffer.from('ogg1'))
    const path2 = writeTmpAudio(Buffer.from('ogg2'))
    const att1: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: path1 }
    const att2: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: path2 }
    const msg: InboundMessage = { channel: 'discord', text: '', attachments: [att1, att2] }
    let callCount = 0
    const create = vi.fn(async () => {
      callCount++
      return { text: `transcript-${callCount}` }
    })
    const client = { audio: { transcriptions: { create } } } as unknown as import('openai').default
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    expect(result.text).toContain('[voice transcript] transcript-1')
    expect(result.text).toContain('[voice transcript] transcript-2')
    // Order: transcript-1 before transcript-2
    expect(result.text.indexOf('transcript-1')).toBeLessThan(result.text.indexOf('transcript-2'))
    // Both attachments kept
    expect(result.attachments).toEqual([att1, att2])
  })

  it('(7) non-audio attachment present → left untouched and kept', async () => {
    const audioPath = writeTmpAudio(Buffer.from('fake-ogg-data'))
    const imgAtt: Attachment = { type: 'image', mediaType: 'image/jpeg', filename: 'photo.jpg' }
    const audioAtt: Attachment = { type: 'audio', mediaType: 'audio/ogg', path: audioPath }
    const msg: InboundMessage = { channel: 'discord', text: '', attachments: [imgAtt, audioAtt] }
    const { client } = makeMockOpenAI('voice content')
    const result = await transcribeInboundAudio(msg, singleProvider(client))
    expect(result.text).toContain('[voice transcript] voice content')
    // Both attachments kept (image AND audio)
    expect(result.attachments).toEqual([imgAtt, audioAtt])
  })
})
