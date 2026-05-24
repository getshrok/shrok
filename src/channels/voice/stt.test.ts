// src/channels/voice/stt.test.ts
import { describe, it, expect, vi } from 'vitest'
import { transcribeWav, transcribeAudio, TooShortError, InvalidWavError, MIN_WAV_DURATION_SECONDS } from './stt.js'

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
})
