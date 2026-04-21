import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { attachmentStub, detectImageMediaType, toAnthropicAttachments, toOpenAIAttachments, toGeminiAttachments } from './attachment.js'
import type { Attachment } from '../types/core.js'

// ─── attachmentStub ────────────────────────────────────────────────────────────

describe('attachmentStub', () => {
  it('uses filename when present', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/jpeg', filename: 'photo.jpg' }
    expect(attachmentStub(att)).toBe('[Attached: photo.jpg (image/jpeg)]')
  })

  it('falls back to type when no filename', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg' }
    expect(attachmentStub(att)).toBe('[Attached: audio (audio/ogg)]')
  })

  it('appends rounded duration for audio', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'voice.ogg', durationSeconds: 12.7 }
    expect(attachmentStub(att)).toContain('13s')
    expect(attachmentStub(att)).toBe('[Attached: voice.ogg (audio/ogg 13s)]')
  })

  it('includes file path when present', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'voice.ogg', path: '/media/voice.ogg' }
    expect(attachmentStub(att)).toBe('[Attached: voice.ogg (audio/ogg) — saved at /media/voice.ogg]')
  })

  it('no duration suffix when durationSeconds absent', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'clip.ogg' }
    expect(attachmentStub(att)).not.toContain('s)')
  })
})

// ─── detectImageMediaType ─────────────────────────────────────────────────────

describe('detectImageMediaType', () => {
  it('detects PNG from magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(detectImageMediaType(buf, 'image/jpeg')).toBe('image/png')
  })

  it('detects JPEG from magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    expect(detectImageMediaType(buf, 'image/png')).toBe('image/jpeg')
  })

  it('detects GIF from magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(detectImageMediaType(buf, 'image/jpeg')).toBe('image/gif')
  })

  it('detects WebP from magic bytes', () => {
    const buf = Buffer.alloc(12)
    buf.write('RIFF', 0)
    buf.write('WEBP', 8)
    expect(detectImageMediaType(buf, 'image/jpeg')).toBe('image/webp')
  })

  it('returns fallback for unknown bytes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(detectImageMediaType(buf, 'image/jpeg')).toBe('image/jpeg')
  })

  it('returns fallback for too-short buffer', () => {
    const buf = Buffer.from([0x89, 0x50])
    expect(detectImageMediaType(buf, 'application/octet-stream')).toBe('application/octet-stream')
  })

  it('detects from file path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'))
    const filePath = path.join(dir, 'test.bin')
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    expect(detectImageMediaType(filePath, 'image/jpeg')).toBe('image/png')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns fallback for missing file', () => {
    expect(detectImageMediaType('/nonexistent/file.bin', 'image/jpeg')).toBe('image/jpeg')
  })
})

// ─── File fixtures ─────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-test-'))
  fs.writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from('fake-png-data'))
  fs.writeFileSync(path.join(tmpDir, 'doc.pdf'), Buffer.from('fake-pdf-data'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── toAnthropicAttachments ────────────────────────────────────────────────────

describe('toAnthropicAttachments', () => {
  it('URL image → url source block, no stubs', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/photo.jpg' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).type).toBe('image')
    expect((blocks[0] as any).source.type).toBe('url')
    expect((blocks[0] as any).source.url).toBe('https://example.com/photo.jpg')
    expect(stubs).toBe('')
  })

  it('path image (file exists) → base64 block with correct media_type', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: path.join(tmpDir, 'image.png'), filename: 'image.png' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(1)
    const block = blocks[0] as any
    expect(block.type).toBe('image')
    expect(block.source.type).toBe('base64')
    expect(block.source.media_type).toBe('image/png')
    expect(typeof block.source.data).toBe('string')
    expect(block.source.data.length).toBeGreaterThan(0)
    expect(stubs).toBe('')
  })

  it('path image with wrong mediaType → base64 block uses detected type from bytes', () => {
    // Write a real PNG header but label it as JPEG (simulates Discord bug)
    const pngPath = path.join(tmpDir, 'mislabeled.png')
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    fs.writeFileSync(pngPath, pngHeader)
    const att: Attachment = { type: 'image', mediaType: 'image/jpeg', path: pngPath, filename: 'mislabeled.png' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(1)
    const block = blocks[0] as any
    expect(block.source.media_type).toBe('image/png')  // detected, not declared
    expect(stubs).toBe('')
  })

  it('path image (file missing) → no blocks, file-not-found stub', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: '/nonexistent/file.png', filename: 'file.png' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(0)
    expect(stubs).toContain('file not found')
  })

  it('audio → no blocks, unsupported stub (not in Anthropic caps)', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'voice.ogg' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(0)
    expect(stubs).toContain('voice.ogg')
    expect(stubs).toContain('audio/ogg')
  })

  it('document URL → url source block', () => {
    const att: Attachment = { type: 'document', mediaType: 'application/pdf', url: 'https://example.com/file.pdf' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).type).toBe('document')
    expect((blocks[0] as any).source.type).toBe('url')
    expect(stubs).toBe('')
  })

  it('document path (file exists) → base64 block', () => {
    const att: Attachment = { type: 'document', mediaType: 'application/pdf', path: path.join(tmpDir, 'doc.pdf'), filename: 'doc.pdf' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).type).toBe('document')
    expect((blocks[0] as any).source.type).toBe('base64')
    expect(stubs).toBe('')
  })

  it('non-PDF document → stub (not sent as document block)', () => {
    const att: Attachment = { type: 'document', mediaType: 'application/json', filename: 'data.json', url: 'https://example.com/data.json' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(0)
    expect(stubs).toContain('data.json')
    expect(stubs).toContain('application/json')
  })

  it('non-PDF document with charset → stub', () => {
    const att: Attachment = { type: 'document', mediaType: 'application/json; charset=UTF-16', filename: 'data.json', url: 'https://example.com/data.json' }
    const { blocks, stubs } = toAnthropicAttachments([att])
    expect(blocks).toHaveLength(0)
    expect(stubs).toContain('data.json')
  })

  it('mixed image + audio → one block, one stub', () => {
    const img: Attachment = { type: 'image', mediaType: 'image/png', url: 'https://example.com/img.png' }
    const audio: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'note.ogg' }
    const { blocks, stubs } = toAnthropicAttachments([img, audio])
    expect(blocks).toHaveLength(1)
    expect(stubs).toContain('note.ogg')
  })

  it('empty array → empty result', () => {
    const { blocks, stubs } = toAnthropicAttachments([])
    expect(blocks).toHaveLength(0)
    expect(stubs).toBe('')
  })
})

// ─── toOpenAIAttachments ───────────────────────────────────────────────────────

describe('toOpenAIAttachments', () => {
  it('URL image → image_url part', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/photo.jpg' }
    const { parts, stubs } = toOpenAIAttachments([att])
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe('image_url')
    expect(parts[0]!.image_url.url).toBe('https://example.com/photo.jpg')
    expect(stubs).toBe('')
  })

  it('path image → data URL with base64', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: path.join(tmpDir, 'image.png') }
    const { parts, stubs } = toOpenAIAttachments([att])
    expect(parts).toHaveLength(1)
    expect(parts[0]!.image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(stubs).toBe('')
  })

  it('audio → stub (not in OpenAI caps)', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', filename: 'clip.ogg' }
    const { parts, stubs } = toOpenAIAttachments([att])
    expect(parts).toHaveLength(0)
    expect(stubs).toContain('clip.ogg')
    expect(stubs).toContain('audio/ogg')
  })

  it('document → stub (not in OpenAI caps)', () => {
    const att: Attachment = { type: 'document', mediaType: 'application/pdf', filename: 'doc.pdf' }
    const { parts, stubs } = toOpenAIAttachments([att])
    expect(parts).toHaveLength(0)
    expect(stubs).toContain('doc.pdf')
  })

  it('path image missing → no parts, file-not-found stub', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: '/gone.png', filename: 'gone.png' }
    const { parts, stubs } = toOpenAIAttachments([att])
    expect(parts).toHaveLength(0)
    expect(stubs).toContain('file not found')
  })
})

// ─── toGeminiAttachments ───────────────────────────────────────────────────────

describe('toGeminiAttachments', () => {
  it('URL → fileData part', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/photo.jpg' }
    const { parts, stubs } = toGeminiAttachments([att])
    expect(parts).toHaveLength(1)
    expect((parts[0] as any).fileData.mimeType).toBe('image/jpeg')
    expect((parts[0] as any).fileData.fileUri).toBe('https://example.com/photo.jpg')
    expect(stubs).toBe('')
  })

  it('path (file exists) → inlineData part with base64', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: path.join(tmpDir, 'image.png') }
    const { parts, stubs } = toGeminiAttachments([att])
    expect(parts).toHaveLength(1)
    expect((parts[0] as any).inlineData.mimeType).toBe('image/png')
    expect(typeof (parts[0] as any).inlineData.data).toBe('string')
    expect(stubs).toBe('')
  })

  it('path (file missing) → no parts, stub', () => {
    const att: Attachment = { type: 'image', mediaType: 'image/png', path: '/missing.png', filename: 'missing.png' }
    const { parts, stubs } = toGeminiAttachments([att])
    expect(parts).toHaveLength(0)
    expect(stubs).toContain('file not found')
  })

  it('audio URL → fileData part (Gemini supports audio)', () => {
    const att: Attachment = { type: 'audio', mediaType: 'audio/ogg', url: 'https://example.com/voice.ogg' }
    const { parts, stubs } = toGeminiAttachments([att])
    expect(parts).toHaveLength(1)
    expect(stubs).toBe('')
  })

  it('video path (file exists) → inlineData part (Gemini supports video)', () => {
    fs.writeFileSync(path.join(tmpDir, 'clip.mp4'), Buffer.from('fake-video'))
    const att: Attachment = { type: 'video', mediaType: 'video/mp4', path: path.join(tmpDir, 'clip.mp4') }
    const { parts, stubs } = toGeminiAttachments([att])
    expect(parts).toHaveLength(1)
    expect(stubs).toBe('')
  })

  it('multiple attachments → multiple parts, no stubs', () => {
    const img: Attachment = { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/a.jpg' }
    const doc: Attachment = { type: 'document', mediaType: 'application/pdf', url: 'https://example.com/b.pdf' }
    const { parts, stubs } = toGeminiAttachments([img, doc])
    expect(parts).toHaveLength(2)
    expect(stubs).toBe('')
  })
})
