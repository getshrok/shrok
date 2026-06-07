import { describe, it, expect } from 'vitest'
import { modeForValue, valueForMode } from './ToolOverrideControl'

// ─── modeForValue (two-state: inherit | subset) ───────────────────────────────

describe('modeForValue', () => {
  it('returns inherit for undefined', () => {
    expect(modeForValue(undefined)).toBe('inherit')
  })

  it('returns inherit for __inherit__ sentinel', () => {
    expect(modeForValue('__inherit__')).toBe('inherit')
  })

  it('returns inherit for legacy null (maps to inherit, not all)', () => {
    // Legacy null is treated as "inherit global" — the safe non-action — since
    // the two-state model has no "all tools" mode.
    expect(modeForValue(null)).toBe('inherit')
  })

  it('returns subset for a non-empty array', () => {
    expect(modeForValue(['a', 'b'])).toBe('subset')
  })

  it('returns subset for an empty array', () => {
    // An explicitly set empty subset is still subset mode
    expect(modeForValue([])).toBe('subset')
  })
})

// ─── valueForMode (two-state: inherit | subset) ───────────────────────────────

describe('valueForMode', () => {
  it('returns __inherit__ for inherit mode', () => {
    expect(valueForMode('inherit', ['ignored'])).toBe('__inherit__')
  })

  it('returns the subset array for subset mode', () => {
    expect(valueForMode('subset', ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns an empty array for subset mode with empty subset', () => {
    expect(valueForMode('subset', [])).toEqual([])
  })
})
