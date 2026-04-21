/**
 * Helpers for converting Attachment objects into provider-specific content blocks.
 * Each provider's message translation function calls the appropriate helper here.
 * File-backed attachments are read and base64-encoded at call time.
 */

import * as fs from 'node:fs'
import type { Attachment } from '../types/core.js'
import { PROVIDER_INPUT_CAPABILITIES } from './capabilities.js'

/**
 * Detect actual image media type from file magic bytes.
 * Returns the detected MIME type, or the original mediaType if unrecognised.
 * Works on both Buffer and file path.
 */
export function detectImageMediaType(input: Buffer | string, fallback: string): string {
  const buf = typeof input === 'string'
    ? (() => {
        let fd: number | undefined
        try {
          fd = fs.openSync(input, 'r')
          const b = Buffer.alloc(12)
          fs.readSync(fd, b, 0, 12, 0)
          return b
        } catch { return null }
        finally { if (fd !== undefined) fs.closeSync(fd) }
      })()
    : input
  if (!buf || buf.length < 4) return fallback

  // PNG: \x89PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  // JPEG: \xFF\xD8
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'

  return fallback
}

/** Human-readable stub for attachments the provider doesn't support natively. */
export function attachmentStub(att: Attachment): string {
  const name = att.filename ?? att.type
  const extra = att.durationSeconds ? ` ${Math.round(att.durationSeconds)}s` : ''
  const location = att.path ? ` — saved at ${att.path}` : ''
  return `[Attached: ${name} (${att.mediaType}${extra})${location}]`
}

/** Read a file attachment to base64. Returns null if the file is missing. */
function readBase64(path: string): string | null {
  try {
    return fs.readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk'

/**
 * Convert attachments to Anthropic content blocks.
 * Returns [nativeBlocks, stubText] — native blocks go before the text content,
 * stubText (if non-empty) is appended to the message text.
 */
export function toAnthropicAttachments(
  attachments: Attachment[],
): { blocks: Anthropic.ContentBlockParam[]; stubs: string; hints: string } {
  const blocks: Anthropic.ContentBlockParam[] = []
  const stubLines: string[] = []
  const hintLines: string[] = []
  const caps = PROVIDER_INPUT_CAPABILITIES['anthropic']!

  for (const att of attachments) {
    if (!caps.has(att.type)) {
      stubLines.push(attachmentStub(att))
      continue
    }

    if (att.type === 'image') {
      if (att.url) {
        blocks.push({ type: 'image', source: { type: 'url', url: att.url } as Anthropic.URLImageSource })
        if (att.path) hintLines.push(`[Image also saved at: ${att.path}]`)
      } else if (att.path) {
        const data = readBase64(att.path)
        if (data) {
          const actualType = detectImageMediaType(att.path, att.mediaType)
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: actualType as Anthropic.Base64ImageSource['media_type'], data },
          })
          hintLines.push(`[Image also saved at: ${att.path}]`)
        } else {
          stubLines.push(`[Attached: ${att.filename ?? 'image'} — file not found]`)
        }
      }
    } else if (att.type === 'document') {
      // Anthropic only supports PDF for document blocks — reject everything else
      const baseMime = att.mediaType.split(';')[0]!.trim().toLowerCase()
      if (baseMime !== 'application/pdf') {
        stubLines.push(attachmentStub(att))
        continue
      }
      if (att.url) {
        blocks.push({ type: 'document', source: { type: 'url', url: att.url } as Anthropic.URLPDFSource })
        hintLines.push(`[Document URL: ${att.url}]`)
      } else if (att.path) {
        const data = readBase64(att.path)
        if (data) {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: att.mediaType as Anthropic.Base64PDFSource['media_type'], data },
          })
          hintLines.push(`[Document file: ${att.path}]`)
        } else {
          stubLines.push(`[Attached: ${att.filename ?? 'document'} — file not found]`)
        }
      }
    }
  }

  return { blocks, stubs: stubLines.join('\n'), hints: hintLines.join('\n') }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

import type OpenAI from 'openai'

/**
 * Convert attachments to OpenAI content parts.
 * Returns [nativeParts, stubText].
 */
export function toOpenAIAttachments(
  attachments: Attachment[],
): { parts: OpenAI.ChatCompletionContentPartImage[]; stubs: string; hints: string } {
  const parts: OpenAI.ChatCompletionContentPartImage[] = []
  const stubLines: string[] = []
  const hintLines: string[] = []
  const caps = PROVIDER_INPUT_CAPABILITIES['openai']!

  for (const att of attachments) {
    if (!caps.has(att.type)) {
      stubLines.push(attachmentStub(att))
      continue
    }

    if (att.type === 'image') {
      if (att.url) {
        parts.push({ type: 'image_url', image_url: { url: att.url } })
        if (att.path) hintLines.push(`[Image also saved at: ${att.path}]`)
      } else if (att.path) {
        const data = readBase64(att.path)
        if (data) {
          const actualType = att.path ? detectImageMediaType(att.path, att.mediaType) : att.mediaType
          parts.push({ type: 'image_url', image_url: { url: `data:${actualType};base64,${data}` } })
          hintLines.push(`[Image also saved at: ${att.path}]`)
        } else {
          stubLines.push(`[Attached: ${att.filename ?? 'image'} — file not found]`)
        }
      }
    }
  }

  return { parts, stubs: stubLines.join('\n'), hints: hintLines.join('\n') }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

import type { Part } from '@google/generative-ai'

/**
 * Convert attachments to Gemini parts.
 * Returns [nativeParts, stubText].
 */
export function toGeminiAttachments(
  attachments: Attachment[],
): { parts: Part[]; stubs: string; hints: string } {
  const parts: Part[] = []
  const stubLines: string[] = []
  const hintLines: string[] = []
  const caps = PROVIDER_INPUT_CAPABILITIES['gemini']!

  for (const att of attachments) {
    if (!caps.has(att.type)) {
      stubLines.push(attachmentStub(att))
      continue
    }

    if (att.url) {
      parts.push({ fileData: { mimeType: att.mediaType, fileUri: att.url } })
      if (att.path) hintLines.push(`[File also saved at: ${att.path}]`)
    } else if (att.path) {
      const data = readBase64(att.path)
      if (data) {
        const actualType = att.type === 'image' && att.path ? detectImageMediaType(att.path, att.mediaType) : att.mediaType
        parts.push({ inlineData: { mimeType: actualType, data } })
        hintLines.push(`[File also saved at: ${att.path}]`)
      } else {
        stubLines.push(`[Attached: ${att.filename ?? att.type} — file not found]`)
      }
    }
  }

  return { parts, stubs: stubLines.join('\n'), hints: hintLines.join('\n') }
}
