/**
 * formatTime helper tests — toDatetimeLocalInTz + datetimeLocalToUtc
 *
 * Run: cd dashboard && npx vitest run src/lib/formatTime.test.ts
 */

import { describe, it, expect } from 'vitest'
import { toDatetimeLocalInTz, datetimeLocalToUtc } from './formatTime.js'

// ---------------------------------------------------------------------------
// toDatetimeLocalInTz
// ---------------------------------------------------------------------------

describe('toDatetimeLocalInTz', () => {
  it('converts a winter (EST, UTC-5) instant to YYYY-MM-DDTHH:MM', () => {
    // 2026-01-15T07:30:00Z → 02:30 EST
    expect(toDatetimeLocalInTz('2026-01-15T07:30:00.000Z', 'America/New_York')).toBe('2026-01-15T02:30')
  })

  it('converts a summer (EDT, UTC-4) instant to YYYY-MM-DDTHH:MM', () => {
    // 2026-06-15T06:30:00Z → 02:30 EDT
    expect(toDatetimeLocalInTz('2026-06-15T06:30:00.000Z', 'America/New_York')).toBe('2026-06-15T02:30')
  })

  it('returns empty string for an invalid date string', () => {
    expect(toDatetimeLocalInTz('not-a-date', 'America/New_York')).toBe('')
  })

  it('accepts a Date object', () => {
    const d = new Date('2026-01-15T07:30:00.000Z')
    expect(toDatetimeLocalInTz(d, 'America/New_York')).toBe('2026-01-15T02:30')
  })
})

// ---------------------------------------------------------------------------
// datetimeLocalToUtc
// ---------------------------------------------------------------------------

describe('datetimeLocalToUtc', () => {
  it('converts a winter wall-clock (EST, UTC-5) to UTC ISO', () => {
    // 02:30 EST → 07:30:00Z
    expect(datetimeLocalToUtc('2026-01-15T02:30', 'America/New_York')).toBe('2026-01-15T07:30:00.000Z')
  })

  it('converts a summer wall-clock (EDT, UTC-4) to UTC ISO', () => {
    // 02:30 EDT → 06:30:00Z
    expect(datetimeLocalToUtc('2026-06-15T02:30', 'America/New_York')).toBe('2026-06-15T06:30:00.000Z')
  })

  it('returns empty string for empty input', () => {
    expect(datetimeLocalToUtc('', 'America/New_York')).toBe('')
  })

  it('returns empty string for an input that does not match YYYY-MM-DDTHH:MM', () => {
    expect(datetimeLocalToUtc('2026-01-15T07:30:00.000Z', 'America/New_York')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Round-trip identity at minute granularity
// ---------------------------------------------------------------------------

describe('round-trip identity', () => {
  it('round-trips an EST instant to minute granularity', () => {
    const iso = '2026-01-15T07:30:00.000Z'
    // truncate original to minute
    const truncated = '2026-01-15T07:30:00.000Z'
    const result = datetimeLocalToUtc(toDatetimeLocalInTz(iso, 'America/New_York'), 'America/New_York')
    expect(result).toBe(truncated)
  })

  it('round-trips an EDT instant to minute granularity', () => {
    const iso = '2026-06-15T06:30:00.000Z'
    const truncated = '2026-06-15T06:30:00.000Z'
    const result = datetimeLocalToUtc(toDatetimeLocalInTz(iso, 'America/New_York'), 'America/New_York')
    expect(result).toBe(truncated)
  })
})
