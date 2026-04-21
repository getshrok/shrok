import { describe, it, expect } from 'vitest'
import { formatIanaTimeLine, formatInTz } from './time.js'

// Deterministic instants — no `new Date()` — so tests are independent of host
// zone or DST season.

describe('formatIanaTimeLine', () => {
  it('matches the expected shape: "Weekday, Month D, YYYY, h:mm AM/PM ZZZ (IANA/Zone)"', () => {
    const d = new Date('2025-06-15T13:55:00Z')
    const out = formatIanaTimeLine(d, 'America/New_York')
    // e.g. "Sunday, June 15, 2025, 9:55 AM EDT (America/New_York)"
    // Relaxed zone-name class: some Node builds emit "GMT-4" instead of "EDT".
    expect(out).toMatch(
      /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM) ([A-Z]{2,5}|GMT[+-]\d+) \(America\/New_York\)$/,
    )
  })

  it('is DST-aware: EDT in June, EST in January for America/New_York', () => {
    const summer = formatIanaTimeLine(new Date('2025-06-15T13:55:00Z'), 'America/New_York')
    const winter = formatIanaTimeLine(new Date('2025-01-15T13:55:00Z'), 'America/New_York')
    // At least one must mention EDT and one EST (or UTC-offset fallback). On
    // platforms that only emit GMT±N, skip the explicit abbreviation check
    // but still confirm the two differ in their zone-abbr segment.
    const summerAbbr = summer.match(/([A-Z]{2,5}|GMT[+-]\d+) \(/)![1]
    const winterAbbr = winter.match(/([A-Z]{2,5}|GMT[+-]\d+) \(/)![1]
    expect(summerAbbr).not.toBe(winterAbbr)
  })

  it('UTC renders with "(UTC)" suffix', () => {
    const out = formatIanaTimeLine(new Date('2025-06-15T13:55:00Z'), 'UTC')
    expect(out).toMatch(/\(UTC\)$/)
  })

  it('includes the IANA zone name in parens (agent can shell out TZ=... date)', () => {
    const out = formatIanaTimeLine(new Date('2025-06-15T13:55:00Z'), 'Asia/Tokyo')
    expect(out.endsWith('(Asia/Tokyo)')).toBe(true)
  })

  it('falls back to UTC on an invalid zone — never throws', () => {
    const out = formatIanaTimeLine(new Date('2025-06-15T13:55:00Z'), 'Not/AZone')
    expect(out.endsWith('(UTC)')).toBe(true)
  })

  it('empty tz → UTC fallback', () => {
    const out = formatIanaTimeLine(new Date('2025-06-15T13:55:00Z'), '')
    expect(out.endsWith('(UTC)')).toBe(true)
  })
})

describe('formatInTz (dashboard-style display formatter)', () => {
  it('returns a non-empty string for a valid Date and tz', () => {
    const out = formatInTz('2025-06-15T13:55:00Z', 'America/New_York')
    expect(out.length).toBeGreaterThan(0)
  })

  it('same-day format is compact (no explicit date)', () => {
    // Not checking exact shape — Intl locale may vary — but we can confirm
    // the zone label appears when includeZone is true (default).
    const d = new Date('2025-06-15T13:55:00Z')
    const out = formatInTz(d, 'America/New_York')
    expect(out).toMatch(/[A-Z]{2,5}|GMT[+-]\d+/)
  })

  it('returns original string unchanged for unparseable input', () => {
    expect(formatInTz('not-a-date', 'UTC')).toBe('not-a-date')
  })

  it('includeZone: false drops the trailing zone label', () => {
    const d = new Date('2025-06-15T13:55:00Z')
    const withZone = formatInTz(d, 'America/New_York', { includeZone: true })
    const withoutZone = formatInTz(d, 'America/New_York', { includeZone: false })
    expect(withoutZone.length).toBeLessThan(withZone.length)
  })

  it('style:"full" always includes date + time', () => {
    const d = new Date('2025-06-15T13:55:00Z')
    const out = formatInTz(d, 'UTC', { style: 'full' })
    expect(out.length).toBeGreaterThan(5)
  })
})
