import { describe, it, expect } from 'vitest'
import { modeForValue, valueForMode } from './ToolOverrideControl'

// ─── modeForValue ─────────────────────────────────────────────────────────────

describe('modeForValue', () => {
  it('returns inherit for undefined', () => {
    expect(modeForValue(undefined)).toBe('inherit')
  })

  it('returns inherit for __inherit__ sentinel', () => {
    expect(modeForValue('__inherit__')).toBe('inherit')
  })

  it('returns all for null', () => {
    expect(modeForValue(null)).toBe('all')
  })

  it('returns subset for a non-empty array', () => {
    expect(modeForValue(['a', 'b'])).toBe('subset')
  })

  it('returns subset for an empty array', () => {
    // An explicitly set empty subset is still subset mode (not "all")
    expect(modeForValue([])).toBe('subset')
  })
})

// ─── valueForMode ─────────────────────────────────────────────────────────────

describe('valueForMode', () => {
  it('returns __inherit__ for inherit mode', () => {
    expect(valueForMode('inherit', ['ignored'])).toBe('__inherit__')
  })

  it('returns null for all mode', () => {
    expect(valueForMode('all', ['ignored'])).toBeNull()
  })

  it('returns the subset array for subset mode', () => {
    expect(valueForMode('subset', ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns an empty array for subset mode with empty subset', () => {
    expect(valueForMode('subset', [])).toEqual([])
  })
})
