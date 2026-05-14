/**
 * Phase 36 Plan 01 — sender-prefix helper contract tests.
 *
 * Locks in (D-07 normalization rules):
 *   - Strip '[', ']', ':' characters from display names (T-36-01 prefix-forgery defense)
 *   - Collapse Unicode whitespace runs to a single ASCII space + trim (T-36-03)
 *   - Truncate to 40 chars + '…' when strictly longer (T-36-02 length cap)
 *   - Emojis pass through untouched
 *   - Empty / undefined / fully-stripped inputs return '' (D-02 no-prefix path)
 *
 * Locks in (D-01 / D-02 / D-04 prefix construction):
 *   - undefined or normalized-empty senderName → rawText unchanged (no '[]:' placeholder)
 *   - non-empty name + non-empty body → '[Name]: body'
 *   - non-empty name + empty body → '[Name]:' (no trailing space)
 */
import { describe, it, expect } from 'vitest'
import { normalizeSenderName, buildPrefixedText } from './sender-prefix.js'

describe('normalizeSenderName', () => {
  it('Test 1: undefined input returns empty string', () => {
    expect(normalizeSenderName(undefined)).toBe('')
  })

  it('Test 2: empty-string input returns empty string', () => {
    expect(normalizeSenderName('')).toBe('')
  })

  it('Test 3: plain name passes through unchanged', () => {
    expect(normalizeSenderName('Ashley')).toBe('Ashley')
  })

  it("Test 4: strips '[' and ']' brackets", () => {
    expect(normalizeSenderName('[Ashley]')).toBe('Ashley')
  })

  it("Test 5: strips ':' colon", () => {
    expect(normalizeSenderName('Ash:ley')).toBe('Ashley')
  })

  it("Test 6: strips all three forbidden chars in any order", () => {
    expect(normalizeSenderName(']:Ashley[')).toBe('Ashley')
  })

  it('Test 7: trims surrounding whitespace', () => {
    expect(normalizeSenderName('  Ashley  ')).toBe('Ashley')
  })

  it('Test 8: collapses newline+tab to a single space', () => {
    expect(normalizeSenderName('Ash\n\tley')).toBe('Ash ley')
  })

  it('Test 9: collapses multi-space runs to a single space', () => {
    expect(normalizeSenderName('Ash   ley')).toBe('Ash ley')
  })

  it("Test 10: truncates input strictly longer than 40 chars to 40 + '…'", () => {
    const input = 'A'.repeat(45)
    const out = normalizeSenderName(input)
    expect(out.length).toBe(41) // 40 chars + 1 ellipsis char (U+2026 is a single code unit)
    expect(out).toBe('A'.repeat(40) + '…')
    // Last code unit must be U+2026 (single char), NOT three dots
    expect(out[out.length - 1]).toBe('…')
  })

  it('Test 11: exactly-40-char input passes through unchanged (boundary)', () => {
    const input = 'A'.repeat(40)
    const out = normalizeSenderName(input)
    expect(out.length).toBe(40)
    expect(out).toBe(input)
    expect(out.endsWith('…')).toBe(false)
  })

  it('Test 12: emojis pass through untouched', () => {
    expect(normalizeSenderName('Ashley 🎉')).toBe('Ashley 🎉')
  })

  it('Test 13: input that becomes empty after stripping returns empty (D-02 no-prefix path)', () => {
    expect(normalizeSenderName(':::')).toBe('')
  })
})

describe('buildPrefixedText', () => {
  it('Test 14: undefined senderName returns rawText unchanged (D-02)', () => {
    expect(buildPrefixedText('hi', undefined)).toBe('hi')
  })

  it('Test 15: empty senderName returns rawText unchanged (D-02)', () => {
    expect(buildPrefixedText('hi', '')).toBe('hi')
  })

  it('Test 16: non-empty name + non-empty body yields "[Name]: body"', () => {
    expect(buildPrefixedText('hi', 'Ashley')).toBe('[Ashley]: hi')
  })

  it('Test 17: non-empty name + empty body yields "[Name]:" with NO trailing space (D-04)', () => {
    expect(buildPrefixedText('', 'Ashley')).toBe('[Ashley]:')
  })

  it('Test 18: forbidden chars in name are normalized before prefix construction', () => {
    expect(buildPrefixedText('hi', 'Ash[ley]:')).toBe('[Ashley]: hi')
  })

  it('Test 19: name that normalizes to empty falls through to no-prefix path (NOT "[]: hi")', () => {
    expect(buildPrefixedText('hi', ':::')).toBe('hi')
  })

  it('Test 20: body whitespace is preserved (not trimmed) — single space separator + raw body', () => {
    // Locked rule: body appended unchanged after exactly one separating space.
    // Input body '   ' (3 spaces) → output '[Ashley]:    ' (colon + 1 separator space + 3 body spaces = 4 trailing spaces)
    expect(buildPrefixedText('   ', 'Ashley')).toBe('[Ashley]:    ')
  })
})
