import { describe, it, expect } from 'vitest'
import { splitMessageForTelegram } from './split.js'
import { markdownToTelegramHtml } from './html.js'
import { formatTablesForChat } from '../table-formatter.js'

const render = (s: string): string => markdownToTelegramHtml(formatTablesForChat(s))

const LIMIT = 4096

describe('splitMessageForTelegram', () => {
  it('returns [text] for a short message — regression guard (render identical)', () => {
    const text = 'Hello, this is a **short** message.'
    const chunks = splitMessageForTelegram(text, render)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
    expect(render(chunks[0]!)).toBe(render(text))
  })

  it('returns [text] for an empty string', () => {
    const chunks = splitMessageForTelegram('', render)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('')
  })

  it('splits a plain long message into 2+ chunks each under the limit', () => {
    // Build a message that is clearly over 4096 rendered chars — plain text
    // so render(s) == s, making it easy to reason about.
    const line = 'A'.repeat(200)
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${line}`)
    const text = lines.join('\n')
    expect(render(text).length).toBeGreaterThan(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(render(chunk).length).toBeLessThanOrEqual(LIMIT)
    }

    // All original content is preserved
    const combined = chunks.join('\n')
    for (const line of lines) {
      expect(combined).toContain(line)
    }
  })

  it('never splits a fenced code block that fits in a chunk', () => {
    const code = '```python\nx = 1\ny = 2\nprint(x + y)\n```'
    const before = 'Some text before.\n'
    const after = '\nSome text after.'
    const text = before + code + after

    // Short enough to fit in one chunk
    expect(render(text).length).toBeLessThanOrEqual(LIMIT)
    const chunks = splitMessageForTelegram(text, render)
    // All in one chunk and code block is intact
    const combined = chunks.join('\n')
    expect(combined).toContain('```python\nx = 1\ny = 2\nprint(x + y)\n```')
  })

  it('hard-splits an over-cap fenced code block into valid standalone fences', () => {
    // Create a code block that alone exceeds 4096 rendered chars
    const innerLines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`)
    const inner = innerLines.join('\n')
    const text = '```python\n' + inner + '\n```'
    expect(render(text).length).toBeGreaterThan(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    for (const chunk of chunks) {
      const r = render(chunk)
      expect(r.length).toBeLessThanOrEqual(LIMIT)
      // Each chunk must be a valid standalone fenced block
      const trimmed = chunk.trim()
      expect(trimmed.startsWith('```')).toBe(true)
      expect(trimmed.endsWith('```')).toBe(true)
    }
  })

  it('hard-split fenced code block preserves language tag on every chunk', () => {
    const innerLines = Array.from({ length: 80 }, (_, i) => `const x${i} = ${'a'.repeat(60)};`)
    const inner = innerLines.join('\n')
    const text = '```typescript\n' + inner + '\n```'
    expect(render(text).length).toBeGreaterThan(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    for (const chunk of chunks) {
      expect(chunk.trimStart().startsWith('```typescript')).toBe(true)
    }
  })

  it('never splits a markdown pipe table mid-row', () => {
    // Build a table that expands via formatTablesForChat to over 4096 chars
    const header = '| Column A | Column B | Column C |'
    const sep = '| --- | --- | --- |'
    const rows = Array.from({ length: 80 }, (_, i) => `| Row${i} Cell1 | Row${i} Cell2 | Row${i} Cell3 |`)
    const table = [header, sep, ...rows].join('\n')
    const text = table
    expect(render(text).length).toBeGreaterThan(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    for (const chunk of chunks) {
      expect(render(chunk).length).toBeLessThanOrEqual(LIMIT)
    }

    // Each chunk should be either the full box-drawn table or a sub-table
    // Verify no chunk contains a partial (broken) pipe-table row
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // If this looks like a partial pipe row without matching end, that's a split
        // Simpler: every pipe-table row in the chunk must have matching | at start and end
        if (line.trim().startsWith('|')) {
          expect(line.trim().endsWith('|')).toBe(true)
        }
      }
    }
  })

  it('a table that fits is never split', () => {
    const header = '| Name | Value |'
    const sep = '| --- | --- |'
    const rows = ['| Alice | 1 |', '| Bob | 2 |']
    const text = [header, sep, ...rows].join('\n')
    expect(render(text).length).toBeLessThanOrEqual(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    expect(chunks).toHaveLength(1)
    // The full table is intact
    expect(chunks[0]).toBe(text)
  })

  it('chunks do not exceed limit when mixing code and plain text', () => {
    const code = '```\n' + 'x'.repeat(2200) + '\n```'
    const prose = '\n' + 'y'.repeat(2200)
    const text = code + prose
    expect(render(text).length).toBeGreaterThan(LIMIT)

    const chunks = splitMessageForTelegram(text, render)
    for (const chunk of chunks) {
      expect(render(chunk).length).toBeLessThanOrEqual(LIMIT)
    }
  })

  it('handles a message at exactly limit — single chunk', () => {
    // Construct a plain text whose render is exactly at limit
    // render of plain ASCII text == text itself (no HTML entities needed for plain letters)
    const text = 'a'.repeat(LIMIT)
    const chunks = splitMessageForTelegram(text, render)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('handles a message one char over limit — splits', () => {
    const text = 'a'.repeat(LIMIT + 1)
    const chunks = splitMessageForTelegram(text, render)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(render(chunk).length).toBeLessThanOrEqual(LIMIT)
    }
  })
})
