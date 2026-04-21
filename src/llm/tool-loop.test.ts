/**
 * Phase 3: descriptionForChannel sanitization contract tests.
 *
 * Locks in:
 *   1. typeof check: non-string returns null
 *   2. Empty / whitespace-only after trim returns null
 *   3. Backtick replacement: ` → ' (protects the outer markdown code fence)
 *   4. 200-char truncation: slice(0, 197) + '…'
 *   5. Sanitization order: trim THEN backtick-strip THEN empty-check THEN truncate
 */
import { describe, it, expect } from 'vitest'
import { descriptionForChannel } from './tool-loop.js'

describe('descriptionForChannel — valid input', () => {
  it('returns the string unchanged for a plain description', () => {
    expect(descriptionForChannel({ description: 'running tests' })).toBe('running tests')
  })

  it('trims surrounding whitespace', () => {
    expect(descriptionForChannel({ description: '  running tests  ' })).toBe('running tests')
  })

  it('returns a single character description unchanged', () => {
    expect(descriptionForChannel({ description: 'a' })).toBe('a')
  })
})

describe('descriptionForChannel — null cases', () => {
  it('returns null for empty string', () => {
    expect(descriptionForChannel({ description: '' })).toBeNull()
  })

  it('returns null for whitespace-only spaces', () => {
    expect(descriptionForChannel({ description: '   ' })).toBeNull()
  })

  it('returns null for mixed whitespace (tab/newline/cr)', () => {
    expect(descriptionForChannel({ description: '\t\n  \r' })).toBeNull()
  })

  it('returns null for a non-string (number)', () => {
    expect(descriptionForChannel({ description: 42 })).toBeNull()
  })

  it('returns null when the description key is absent', () => {
    expect(descriptionForChannel({})).toBeNull()
  })
})

describe('descriptionForChannel — whitespace collapse (WR-02)', () => {
  it('collapses an interior newline to a single space', () => {
    expect(descriptionForChannel({ description: 'a\nb' })).toBe('a b')
  })

  it('collapses an interior tab to a single space', () => {
    expect(descriptionForChannel({ description: 'a\tb' })).toBe('a b')
  })

  it('collapses an interior carriage return to a single space', () => {
    expect(descriptionForChannel({ description: 'a\rb' })).toBe('a b')
  })

  it('collapses mixed runs of whitespace to a single space and trims edges', () => {
    expect(descriptionForChannel({ description: '  a  \n  b  ' })).toBe('a b')
  })

  it('collapses a multi-line description with many blank lines', () => {
    expect(descriptionForChannel({ description: 'install deps\n\nthen run tests' })).toBe(
      'install deps then run tests',
    )
  })

  it('collapses runs of spaces between words', () => {
    expect(descriptionForChannel({ description: 'a    b' })).toBe('a b')
  })
})

describe('descriptionForChannel — backtick replacement', () => {
  it('replaces backticks in "use `npm test`" with single quotes', () => {
    expect(descriptionForChannel({ description: 'use `npm test`' })).toBe("use 'npm test'")
  })

  it('replaces three backticks with three single quotes (non-empty, non-null)', () => {
    expect(descriptionForChannel({ description: '```' })).toBe("'''")
  })

  it('leaves a description with no backticks unchanged', () => {
    expect(descriptionForChannel({ description: 'no backticks here' })).toBe('no backticks here')
  })
})

describe('descriptionForChannel — 200-char truncation', () => {
  it('returns a 199-char string unchanged', () => {
    const s = 'a'.repeat(199)
    const out = descriptionForChannel({ description: s })
    expect(out).toBe(s)
    expect(out!.length).toBe(199)
  })

  it('returns a 200-char string unchanged (exact boundary)', () => {
    const s = 'a'.repeat(200)
    const out = descriptionForChannel({ description: s })
    expect(out).toBe(s)
    expect(out!.length).toBe(200)
  })

  it('truncates a 201-char string to 197 chars + ellipsis', () => {
    const s = 'a'.repeat(201)
    const out = descriptionForChannel({ description: s })
    expect(out!.length).toBe(198)
    expect(out!.endsWith('…')).toBe(true)
    expect(out!.slice(0, 197)).toBe('a'.repeat(197))
  })

  it('truncates a 1000-char string to 197 chars + ellipsis', () => {
    const s = 'a'.repeat(1000)
    const out = descriptionForChannel({ description: s })
    expect(out!.length).toBe(198)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('uses a single ellipsis char (U+2026), not three dots', () => {
    const s = 'a'.repeat(300)
    const out = descriptionForChannel({ description: s })
    expect(out!.slice(-1)).toBe('…')
    expect(out!.slice(-3)).not.toBe('...')
  })
})
