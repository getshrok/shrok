import { describe, it, expect } from 'vitest'
import { splitSlackBlocks, batchSlackBlocks, SLACK_BLOCKS_PER_MSG } from './split.js'
import type { SlackBlock } from '../table-formatter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextBlock(text: string, type = 'mrkdwn'): SlackBlock {
  return { type: 'section', text: { type, text } }
}

function makeFieldsBlock(fields: { type: string; text: string }[]): SlackBlock {
  return { type: 'section', fields }
}

function makeField(text: string, type = 'mrkdwn') {
  return { type, text }
}

// ---------------------------------------------------------------------------
// splitSlackBlocks — text section > 3000 chars
// ---------------------------------------------------------------------------

describe('splitSlackBlocks — text section over 3000 chars', () => {
  it('splits a plain text section into multiple blocks each ≤3000 chars', () => {
    // Build a 7500-char string (newline-separated paragraphs so newline-split is exercised)
    const paragraph = 'A'.repeat(500)
    const bigText = Array.from({ length: 15 }, () => paragraph).join('\n')
    expect(bigText.length).toBeGreaterThan(3000)

    const block = makeTextBlock(bigText)
    const result = splitSlackBlocks([block])

    expect(result.length).toBeGreaterThan(1)
    for (const b of result) {
      expect(b.type).toBe('section')
      if ('text' in b && b.text !== undefined) {
        expect(b.text.text.length).toBeLessThanOrEqual(3000)
      }
    }
    // All original text is preserved (joined without separator — we trim boundary newlines)
    const combined = result
      .map(b => ('text' in b && b.text !== undefined ? b.text.text : ''))
      .join('\n')
    // Combined should contain all the original paragraphs
    expect(combined).toContain(paragraph)
  })
})

// ---------------------------------------------------------------------------
// splitSlackBlocks — code-block section > 3000 chars
// ---------------------------------------------------------------------------

describe('splitSlackBlocks — code-block section over 3000 chars', () => {
  it('splits a ```-fenced block so each piece is a valid standalone fence', () => {
    // Each line is ~40 chars; 120 lines = ~4800 chars total, well over 3000
    const codeLines = Array.from({ length: 120 }, (_, i) => `const variableName${i} = ${i * 100};`)
    const bigCode = '```typescript\n' + codeLines.join('\n') + '\n```'
    expect(bigCode.length).toBeGreaterThan(3000)

    const block = makeTextBlock(bigCode)
    const result = splitSlackBlocks([block])

    expect(result.length).toBeGreaterThan(1)
    for (const b of result) {
      expect(b.type).toBe('section')
      if ('text' in b && b.text !== undefined) {
        const text = b.text.text.trim()
        // Each piece must open with ``` (possibly with a lang tag) and close with ```
        expect(text.startsWith('```')).toBe(true)
        expect(text.endsWith('```')).toBe(true)
        expect(text.length).toBeLessThanOrEqual(3000)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// splitSlackBlocks — fields section > 10 fields
// ---------------------------------------------------------------------------

describe('splitSlackBlocks — fields section over 10 fields', () => {
  it('splits into multiple ≤10-field blocks preserving order', () => {
    const fields = Array.from({ length: 25 }, (_, i) => makeField(`field-${i}`))
    const block = makeFieldsBlock(fields)
    const result = splitSlackBlocks([block])

    expect(result.length).toBeGreaterThan(1)
    let collected: string[] = []
    for (const b of result) {
      expect(b.type).toBe('section')
      if ('fields' in b && b.fields !== undefined) {
        expect(b.fields.length).toBeLessThanOrEqual(10)
        collected = collected.concat(b.fields.map(f => f.text))
      }
    }
    // All original fields present in original order
    expect(collected).toEqual(fields.map(f => f.text))
  })
})

// ---------------------------------------------------------------------------
// batchSlackBlocks — > 50 blocks
// ---------------------------------------------------------------------------

describe('batchSlackBlocks — over 50 blocks', () => {
  it('batches into groups each ≤50, total block count preserved', () => {
    const blocks: SlackBlock[] = Array.from({ length: 130 }, (_, i) =>
      makeTextBlock(`short text ${i}`)
    )
    const batches = batchSlackBlocks(blocks)

    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(SLACK_BLOCKS_PER_MSG)
    }
    const totalBlocks = batches.reduce((sum, batch) => sum + batch.length, 0)
    expect(totalBlocks).toBe(blocks.length)
  })

  it('preserves block order across batches', () => {
    const blocks: SlackBlock[] = Array.from({ length: 60 }, (_, i) =>
      makeTextBlock(`msg-${i}`)
    )
    const batches = batchSlackBlocks(blocks)
    const flat = batches.flat()
    for (let i = 0; i < flat.length; i++) {
      const b = flat[i]
      if (b !== undefined && 'text' in b && b.text !== undefined) {
        expect(b.text.text).toBe(`msg-${i}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Normal short blocks — no-op (no splitting, single batch)
// ---------------------------------------------------------------------------

describe('normal short blocks — no-op', () => {
  it('returns unchanged blocks when text is under the limit', () => {
    const block1 = makeTextBlock('Hello, world!')
    const block2 = makeTextBlock('A second short section.')
    const input: SlackBlock[] = [block1, block2]

    const result = splitSlackBlocks(input)
    expect(result).toHaveLength(2)
    // Same object references — nothing was split
    expect(result[0]).toBe(block1)
    expect(result[1]).toBe(block2)
  })

  it('batchSlackBlocks returns a single batch for ≤50 blocks', () => {
    const blocks: SlackBlock[] = Array.from({ length: 10 }, (_, i) =>
      makeTextBlock(`block ${i}`)
    )
    const batches = batchSlackBlocks(blocks)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toBe(blocks) // same array reference for the single-batch case
  })
})
