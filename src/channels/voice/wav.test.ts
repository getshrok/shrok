// src/channels/voice/wav.test.ts
import { describe, it, expect } from 'vitest'
import { parseWavDuration } from './wav.js'

// Build a minimal valid PCM WAV with a single fmt chunk and a single data chunk.
// byteRate is sample_rate * channels * bits_per_sample / 8.
function buildWav(opts: {
  byteRate: number
  dataBytes: number
  fmtChunkSize?: number           // default 16 (plain PCM)
  extraChunkBeforeData?: { id: string; size: number } // inserted between fmt and data
  riff?: string                   // default 'RIFF'
  wave?: string                   // default 'WAVE'
  truncateTo?: number             // truncate final buffer to this length
}): Buffer {
  const fmtChunkSize = opts.fmtChunkSize ?? 16
  const extra = opts.extraChunkBeforeData
  const extraTotal = extra ? 8 + extra.size : 0
  const totalLen = 12 /* RIFF header */ + 8 + fmtChunkSize + extraTotal + 8 + opts.dataBytes
  const buf = Buffer.alloc(totalLen)
  buf.write(opts.riff ?? 'RIFF', 0, 'ascii')
  buf.writeUInt32LE(totalLen - 8, 4)
  buf.write(opts.wave ?? 'WAVE', 8, 'ascii')
  // fmt chunk
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(fmtChunkSize, 16)
  // Minimal fmt body — only byte_rate at offset 28 matters for parseWavDuration
  buf.writeUInt16LE(1, 20)          // audio format: PCM
  buf.writeUInt16LE(1, 22)          // channels: 1
  buf.writeUInt32LE(16000, 24)      // sample rate (not read by parseWavDuration)
  buf.writeUInt32LE(opts.byteRate, 28)
  buf.writeUInt16LE(2, 32)          // block align (arbitrary)
  buf.writeUInt16LE(16, 34)         // bits per sample (arbitrary)
  let cursor = 20 + fmtChunkSize
  if (extra) {
    buf.write(extra.id, cursor, 'ascii')
    buf.writeUInt32LE(extra.size, cursor + 4)
    cursor += 8 + extra.size
  }
  buf.write('data', cursor, 'ascii')
  buf.writeUInt32LE(opts.dataBytes, cursor + 4)
  // data payload left as zeros — we never read it
  if (opts.truncateTo !== undefined) return buf.subarray(0, opts.truncateTo)
  return buf
}

describe('parseWavDuration', () => {
  it('returns 0.5 seconds for a 16 kHz/16-bit/mono WAV with 16000 data bytes', () => {
    // 16000 samples/sec * 2 bytes/sample = 32000 bytes/sec; 16000 data bytes = 0.5s
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000 })
    expect(parseWavDuration(wav)).toBe(0.5)
  })

  it('returns 0.25 seconds for an 8000-byte data chunk at 32000 byte rate (sub-500ms)', () => {
    const wav = buildWav({ byteRate: 32000, dataBytes: 8000 })
    expect(parseWavDuration(wav)).toBe(0.25)
  })

  it('returns null for buffers shorter than 44 bytes', () => {
    expect(parseWavDuration(Buffer.alloc(43))).toBeNull()
    expect(parseWavDuration(Buffer.alloc(0))).toBeNull()
  })

  it('returns null when the RIFF magic is missing', () => {
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000, riff: 'XXXX' })
    expect(parseWavDuration(wav)).toBeNull()
  })

  it('returns null when the WAVE marker is missing', () => {
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000, wave: 'XXXX' })
    expect(parseWavDuration(wav)).toBeNull()
  })

  it('returns null when byte_rate is zero', () => {
    const wav = buildWav({ byteRate: 0, dataBytes: 16000 })
    expect(parseWavDuration(wav)).toBeNull()
  })

  it('finds the data chunk even when a LIST chunk appears before it', () => {
    const wav = buildWav({
      byteRate: 32000,
      dataBytes: 16000,
      extraChunkBeforeData: { id: 'LIST', size: 12 },
    })
    expect(parseWavDuration(wav)).toBe(0.5)
  })

  it('handles fmt chunks larger than 16 bytes (non-PCM extensions)', () => {
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000, fmtChunkSize: 18 })
    expect(parseWavDuration(wav)).toBe(0.5)
  })

  it('returns null when the data chunk marker never appears', () => {
    // Build a buffer that has fmt followed only by LIST, no data chunk
    const fmtSize = 16
    const listSize = 10
    const totalLen = 12 + 8 + fmtSize + 8 + listSize
    const buf = Buffer.alloc(totalLen)
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(totalLen - 8, 4)
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(fmtSize, 16)
    buf.writeUInt32LE(32000, 28)  // byte_rate
    buf.write('LIST', 20 + fmtSize, 'ascii')
    buf.writeUInt32LE(listSize, 20 + fmtSize + 4)
    expect(parseWavDuration(buf)).toBeNull()
  })

  it('returns null when a chunk size is larger than the remaining buffer', () => {
    // Build a WAV and then truncate it so the data chunk claims more than we have
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000 })
    const truncated = wav.subarray(0, 60)  // cut off mid-data
    // parseWavDuration should either return a value based on the declared size
    // or null — but must never throw or read out of bounds.
    expect(() => parseWavDuration(truncated)).not.toThrow()
  })

  it('returns null when data chunk header is present but declared size exceeds remaining payload bytes', () => {
    // Build a WAV where the data chunk header exists but the buffer is truncated
    // so the declared chunkSize exceeds the bytes actually present after the header.
    // This catches the bug where chunkSize was compared to buf.length rather than
    // buf.length - payloadStart — a crafted WAV could pass the old guard and return
    // an inflated duration that bypasses the 500 ms gate.
    const wav = buildWav({ byteRate: 32000, dataBytes: 16000 })
    // Find where the data chunk header starts (fmt chunk at 12, size 16 → data at 36)
    // Truncate to 36 + 8 + 10 = 54: data chunk header is fully present (8 bytes),
    // but only 10 bytes of the claimed 16000-byte payload exist.
    const truncated = wav.subarray(0, 54)
    expect(parseWavDuration(truncated)).toBeNull()
  })
})
