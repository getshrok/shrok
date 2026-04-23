// src/channels/voice/wav.ts
/**
 * Parse the duration (in seconds) of a PCM WAV buffer by reading its RIFF header.
 *
 * Scans chunks after the `fmt ` chunk to locate `data`, handling non-standard
 * chunk orderings (LIST/INFO before data). Returns `null` for any malformed,
 * truncated, or non-WAVE input — NEVER throws, NEVER reads out of bounds.
 *
 * Per Phase 19 D-05: callers reject clips where duration < 0.5 seconds without
 * calling Whisper. Do not substitute a byte-length heuristic.
 */
export function parseWavDuration(buf: Buffer): number | null {
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null

  // byte_rate lives inside the fmt chunk at absolute offset 28 (uint32 LE)
  if (buf.length < 32) return null
  const byteRate = buf.readUInt32LE(28)
  if (byteRate === 0) return null

  // fmt chunk: 'fmt ' at offset 12, size at offset 16, data starts at 20
  if (buf.length < 20) return null
  const fmtChunkSize = buf.readUInt32LE(16)
  // Scan for 'data' chunk starting immediately after the fmt chunk.
  let offset = 20 + fmtChunkSize
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    if (chunkId === 'data') {
      // Guard: reported data_size must not exceed remaining buffer
      if (chunkSize > buf.length) return null
      return chunkSize / byteRate
    }
    offset += 8 + chunkSize
  }
  return null
}
