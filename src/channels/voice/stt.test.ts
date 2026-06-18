// src/channels/voice/stt.test.ts
import { describe, it, expect, vi } from 'vitest'
import { transcribeWav, transcribeAudio, transcribeWithFallback, transcribeWavWithFallback, TooShortError, InvalidWavError, MIN_WAV_DURATION_SECONDS } from './stt.js'

// Same WAV helper as wav.test.ts, inlined (duplicate-by-design until a shared helper is needed)
function buildWav(byteRate: number, dataBytes: number): Buffer {
  const fmtChunkSize = 16
  const totalLen = 12 + 8 + fmtChunkSize + 8 + dataBytes
  const buf = Buffer.alloc(totalLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(totalLen - 8, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(fmtChunkSize, 16)
  buf.writeUInt32LE(byteRate, 28)
  buf.write('data', 20 + fmtChunkSize, 'ascii')
  buf.writeUInt32LE(dataBytes, 20 + fmtChunkSize + 4)
  return buf
}

function makeMockOpenAI(text: string) {
  const create = vi.fn(async (_params: unknown) => ({ text }))
  return {
    create,
    client: { audio: { transcriptions: { create } } } as unknown as import('openai').default,
  }
}

describe('transcribeWav', () => {
  it('returns the trimmed transcript text for a valid >=500ms WAV', async () => {
    const wav = buildWav(32000, 16000)  // 0.5s exactly
    const { client, create } = makeMockOpenAI('  hello world\n')
    const result = await transcribeWav(wav, client)
    expect(result).toBe('hello world')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('passes a File with name audio.wav and type audio/wav to the SDK', async () => {
    const wav = buildWav(32000, 16000)
    const { client, create } = makeMockOpenAI('ok')
    await transcribeWav(wav, client)
    expect(create).toHaveBeenCalledTimes(1)
    const params = create.mock.calls[0]![0] as { file: File; model: string }
    expect(params.file).toBeInstanceOf(File)
    expect(params.file.name).toBe('audio.wav')
    expect(params.file.type).toBe('audio/wav')
    expect(params.model).toBe('whisper-1')
  })

  it('throws TooShortError for sub-500ms clips WITHOUT calling the SDK', async () => {
    const wav = buildWav(32000, 8000)  // 0.25s
    const { client, create } = makeMockOpenAI('should not be called')
    await expect(transcribeWav(wav, client)).rejects.toBeInstanceOf(TooShortError)
    expect(create).not.toHaveBeenCalled()
    try {
      await transcribeWav(wav, client)
    } catch (err) {
      expect((err as TooShortError).durationSeconds).toBeCloseTo(0.25, 3)
    }
  })

  it('accepts duration exactly equal to the 500ms boundary', async () => {
    const wav = buildWav(32000, 16000)  // exactly 0.5s
    const { client, create } = makeMockOpenAI('boundary')
    await expect(transcribeWav(wav, client)).resolves.toBe('boundary')
    expect(create).toHaveBeenCalled()
    expect(MIN_WAV_DURATION_SECONDS).toBe(0.5)
  })

  it('throws InvalidWavError for malformed buffers WITHOUT calling the SDK', async () => {
    const notWav = Buffer.from('XXXX'.repeat(20))
    const { client, create } = makeMockOpenAI('should not be called')
    await expect(transcribeWav(notWav, client)).rejects.toBeInstanceOf(InvalidWavError)
    expect(create).not.toHaveBeenCalled()
  })

  it('propagates SDK errors unchanged (does not swallow)', async () => {
    const wav = buildWav(32000, 16000)
    const err = new Error('auth failure')
    const client = {
      audio: {
        transcriptions: {
          create: vi.fn(async () => { throw err }),
        },
      },
    } as unknown as import('openai').default
    await expect(transcribeWav(wav, client)).rejects.toBe(err)
  })
})

describe('transcribeAudio', () => {
  it('(a) trims and returns the transcript text', async () => {
    const buf = Buffer.from('fake-ogg-bytes')
    const { client, create } = makeMockOpenAI('  hello world\n')
    const result = await transcribeAudio(buf, 'audio/ogg', client)
    expect(result).toBe('hello world')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('(b) derives File name+type from mediaType audio/ogg', async () => {
    const buf = Buffer.from('fake-ogg-bytes')
    const { client, create } = makeMockOpenAI('ok')
    await transcribeAudio(buf, 'audio/ogg', client)
    const params = create.mock.calls[0]![0] as { file: File; model: string }
    expect(params.file).toBeInstanceOf(File)
    expect(params.file.name).toMatch(/\.ogg$/)
    expect(params.file.type).toBe('audio/ogg')
  })

  it('(c) derives File name+type from an .m4a filename', async () => {
    const buf = Buffer.from('fake-m4a-bytes')
    const { client, create } = makeMockOpenAI('ok')
    await transcribeAudio(buf, 'voice.m4a', client)
    const params = create.mock.calls[0]![0] as { file: File; model: string }
    expect(params.file).toBeInstanceOf(File)
    expect(params.file.name).toMatch(/\.m4a$/)
  })

  it('(d) always calls with model whisper-1', async () => {
    const buf = Buffer.from('fake-mp3-bytes')
    const { client, create } = makeMockOpenAI('test')
    await transcribeAudio(buf, 'audio/mpeg', client)
    const params = create.mock.calls[0]![0] as { file: File; model: string }
    expect(params.model).toBe('whisper-1')
  })

  it('(e) propagates SDK errors unchanged', async () => {
    const buf = Buffer.from('fake-bytes')
    const err = new Error('sdk-error')
    const client = {
      audio: {
        transcriptions: {
          create: vi.fn(async () => { throw err }),
        },
      },
    } as unknown as import('openai').default
    await expect(transcribeAudio(buf, 'audio/ogg', client)).rejects.toBe(err)
  })

  it('(f) does NOT throw TooShortError or InvalidWavError for a tiny non-WAV buffer', async () => {
    // A 10-byte fake-ogg buffer: no RIFF/WAV headers, no duration gate
    const buf = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00])
    const { client, create } = makeMockOpenAI('transcribed')
    // Must NOT throw TooShortError or InvalidWavError — those are transcribeWav-only
    await expect(transcribeAudio(buf, 'audio/ogg', client)).resolves.toBe('transcribed')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('(g) passes a custom model string to the SDK when provided', async () => {
    const buf = Buffer.from('fake-ogg-bytes')
    const { client, create } = makeMockOpenAI('ok')
    await transcribeAudio(buf, 'audio/ogg', client, 'large-v3')
    const params = create.mock.calls[0]![0] as { file: File; model: string }
    expect(params.model).toBe('large-v3')
  })
})

// ─── Helper: make a mock that rejects ────────────────────────────────────────
function makeMockOpenAIThrows(err: Error) {
  const create = vi.fn(async () => { throw err })
  return {
    create,
    client: { audio: { transcriptions: { create } } } as unknown as import('openai').default,
  }
}

describe('transcribeWithFallback', () => {
  it('returns transcript from primary without calling fallback when primary succeeds', async () => {
    const buf = Buffer.from('fake-bytes')
    const { client: primary, create: primaryCreate } = makeMockOpenAI('from primary')
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI('from fallback')
    const result = await transcribeWithFallback(buf, 'audio/ogg', [
      { client: primary, label: 'primary' },
      { client: fallback, label: 'fallback' },
    ])
    expect(result).toBe('from primary')
    expect(primaryCreate).toHaveBeenCalledTimes(1)
    expect(fallbackCreate).not.toHaveBeenCalled()
  })

  it('calls fallback when primary throws and returns fallback transcript', async () => {
    const buf = Buffer.from('fake-bytes')
    const { client: primary } = makeMockOpenAIThrows(new Error('connection refused'))
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI('from fallback')
    const result = await transcribeWithFallback(buf, 'audio/ogg', [
      { client: primary, label: 'primary' },
      { client: fallback, label: 'fallback' },
    ])
    expect(result).toBe('from fallback')
    expect(fallbackCreate).toHaveBeenCalledTimes(1)
  })

  it('re-throws last error when primary throws and no fallback is provided', async () => {
    const buf = Buffer.from('fake-bytes')
    const err = new Error('box is off')
    const { client: primary } = makeMockOpenAIThrows(err)
    await expect(transcribeWithFallback(buf, 'audio/ogg', [
      { client: primary, label: 'primary' },
    ])).rejects.toBe(err)
  })

  it('throws when providers list is empty', async () => {
    const buf = Buffer.from('fake-bytes')
    await expect(transcribeWithFallback(buf, 'audio/ogg', [])).rejects.toThrow('no STT providers configured')
  })
})

describe('transcribeWavWithFallback', () => {
  it('runs duration gate BEFORE any provider: throws TooShortError for sub-500ms WAV without calling any provider', async () => {
    const wav = buildWav(32000, 8000)  // 0.25s
    const { client, create } = makeMockOpenAI('should not be called')
    await expect(transcribeWavWithFallback(wav, [{ client, label: 'openai' }])).rejects.toBeInstanceOf(TooShortError)
    expect(create).not.toHaveBeenCalled()
  })

  it('runs duration gate BEFORE any provider: throws InvalidWavError for malformed WAV without calling any provider', async () => {
    const notWav = Buffer.from('XXXX'.repeat(20))
    const { client, create } = makeMockOpenAI('should not be called')
    await expect(transcribeWavWithFallback(notWav, [{ client, label: 'openai' }])).rejects.toBeInstanceOf(InvalidWavError)
    expect(create).not.toHaveBeenCalled()
  })

  it('succeeds with primary when WAV passes the gate', async () => {
    const wav = buildWav(32000, 16000)  // 0.5s — passes the gate
    const { client, create } = makeMockOpenAI('hello from wav')
    const result = await transcribeWavWithFallback(wav, [{ client, label: 'openai' }])
    expect(result).toBe('hello from wav')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('uses fallback when primary throws (after gate passes)', async () => {
    const wav = buildWav(32000, 16000)  // 0.5s — passes the gate
    const { client: primary } = makeMockOpenAIThrows(new Error('dead box'))
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI('from fallback')
    const result = await transcribeWavWithFallback(wav, [
      { client: primary, label: 'self-hosted' },
      { client: fallback, label: 'openai' },
    ])
    expect(result).toBe('from fallback')
    expect(fallbackCreate).toHaveBeenCalledTimes(1)
  })

  it('TooShortError does NOT trigger fallback (gate runs before any provider)', async () => {
    const wav = buildWav(32000, 8000)  // 0.25s — too short
    const { client: fallback, create: fallbackCreate } = makeMockOpenAI('from fallback')
    await expect(transcribeWavWithFallback(wav, [
      { client: { audio: { transcriptions: { create: vi.fn(async () => { throw new Error('primary fail') }) } } } as unknown as import('openai').default, label: 'primary' },
      { client: fallback, label: 'fallback' },
    ])).rejects.toBeInstanceOf(TooShortError)
    // Fallback must NOT be called — gate threw before any provider
    expect(fallbackCreate).not.toHaveBeenCalled()
  })
})
