import { describe, it, expect } from 'vitest'
import { formatModelTime, parseModelTime, formatPastTimeError } from './model-time.js'

// ─── formatModelTime ──────────────────────────────────────────────────────────

describe('formatModelTime', () => {
  it('formats a UTC instant in America/New_York (EST, UTC-5)', () => {
    // 2026-01-15 14:00 UTC  =  2026-01-15 09:00 EST
    const d = new Date(Date.UTC(2026, 0, 15, 14, 0, 0))
    expect(formatModelTime(d, 'America/New_York')).toBe('2026-01-15 09:00')
  })

  it('formats a UTC instant in Asia/Tokyo (JST, UTC+9)', () => {
    // 2026-01-15 00:00 UTC  =  2026-01-15 09:00 JST
    const d = new Date(Date.UTC(2026, 0, 15, 0, 0, 0))
    expect(formatModelTime(d, 'Asia/Tokyo')).toBe('2026-01-15 09:00')
  })

  it('formats a UTC instant in Europe/London (GMT, UTC+0)', () => {
    const d = new Date(Date.UTC(2026, 1, 1, 15, 30, 0))
    expect(formatModelTime(d, 'Europe/London')).toBe('2026-02-01 15:30')
  })

  it('formats midnight as 00:00 (not 24:00)', () => {
    // 2026-03-01 05:00 UTC  =  2026-03-01 00:00 EST
    const d = new Date(Date.UTC(2026, 2, 1, 5, 0, 0))
    expect(formatModelTime(d, 'America/New_York')).toBe('2026-03-01 00:00')
  })

  it('falls back to UTC when tz is empty string', () => {
    const d = new Date(Date.UTC(2026, 0, 15, 9, 30, 0))
    expect(formatModelTime(d, '')).toBe('2026-01-15 09:30')
  })

  it('falls back to UTC when tz is invalid', () => {
    const d = new Date(Date.UTC(2026, 0, 15, 9, 30, 0))
    expect(formatModelTime(d, 'Not/AZone')).toBe('2026-01-15 09:30')
  })

  it('returns YYYY-MM-DD HH:MM format', () => {
    const d = new Date(Date.UTC(2026, 5, 7, 3, 5, 0)) // UTC 03:05
    const result = formatModelTime(d, 'UTC')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

// ─── parseModelTime ───────────────────────────────────────────────────────────

describe('parseModelTime', () => {
  // Happy path: round-trips
  it('round-trips in UTC', () => {
    const s = '2026-06-15 10:30'
    const d = parseModelTime(s, 'UTC')
    expect(formatModelTime(d, 'UTC')).toBe(s)
  })

  it('round-trips in America/New_York', () => {
    // Winter (EST, UTC-5): 2026-01-15 09:00 EST  =  14:00 UTC
    const s = '2026-01-15 09:00'
    const d = parseModelTime(s, 'America/New_York')
    expect(formatModelTime(d, 'America/New_York')).toBe(s)
    expect(d.getTime()).toBe(Date.UTC(2026, 0, 15, 14, 0, 0))
  })

  it('round-trips in Asia/Tokyo', () => {
    const s = '2026-03-01 09:00'
    const d = parseModelTime(s, 'Asia/Tokyo')
    expect(formatModelTime(d, 'Asia/Tokyo')).toBe(s)
  })

  it('round-trips in Europe/London (GMT)', () => {
    const s = '2026-02-01 15:30'
    const d = parseModelTime(s, 'Europe/London')
    expect(formatModelTime(d, 'Europe/London')).toBe(s)
  })

  it('accepts T separator (space or T both valid)', () => {
    const d1 = parseModelTime('2026-06-01 14:00', 'UTC')
    const d2 = parseModelTime('2026-06-01T14:00', 'UTC')
    expect(d1.getTime()).toBe(d2.getTime())
  })

  it('accepts HH:MM:SS format', () => {
    const d = parseModelTime('2026-06-01 14:00:30', 'UTC')
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 1, 14, 0, 30))
  })

  // Rejection tests
  it('rejects Z-suffixed ISO string', () => {
    expect(() => parseModelTime('2026-04-01T09:00:00Z', 'America/New_York'))
      .toThrow()
  })

  it('rejects positive UTC offset', () => {
    expect(() => parseModelTime('2026-04-01T09:00:00+05:00', 'America/New_York'))
      .toThrow()
  })

  it('rejects negative UTC offset', () => {
    expect(() => parseModelTime('2026-04-01T09:00:00-05:00', 'America/New_York'))
      .toThrow()
  })

  it('rejects trailing IANA suffix token (e.g. EDT)', () => {
    expect(() => parseModelTime('2026-04-01 09:00 EDT', 'America/New_York'))
      .toThrow()
  })

  it('rejects trailing IANA zone name', () => {
    expect(() => parseModelTime('2026-04-01 09:00 America/New_York', 'America/New_York'))
      .toThrow()
  })

  it('rejects short strings', () => {
    expect(() => parseModelTime('2026-04', 'UTC')).toThrow()
  })

  it('rejects missing time part', () => {
    expect(() => parseModelTime('2026-04-01', 'UTC')).toThrow()
  })

  it('rejects non-numeric content', () => {
    expect(() => parseModelTime('foo-bar-baz 00:00', 'UTC')).toThrow()
  })

  it('error message references expected format', () => {
    try {
      parseModelTime('2026-04-01T09:00:00Z', 'UTC')
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as Error).message).toMatch(/YYYY-MM-DD/i)
    }
  })

  // DST: spring-forward gap — America/New_York 2026-03-08 02:00→03:00
  it('throws on spring-forward gap (America/New_York 2026-03-08 02:30 does not exist)', () => {
    expect(() => parseModelTime('2026-03-08 02:30', 'America/New_York'))
      .toThrow()
  })

  it('spring-forward error message names the gap', () => {
    try {
      parseModelTime('2026-03-08 02:30', 'America/New_York')
      expect.fail('should have thrown')
    } catch (e) {
      // Must mention the gap / non-existent / clocks spring
      expect((e as Error).message.toLowerCase()).toMatch(/gap|non-existent|does not exist|skipped|spring/)
    }
  })

  // DST: fall-back ambiguous — America/New_York 2026-11-01 01:30 occurs twice
  // First occurrence = before offset shift = EDT (UTC-4); second = after = EST (UTC-5)
  // parseModelTime must return the FIRST occurrence (earlier UTC = UTC-4)
  it('picks FIRST occurrence for fall-back ambiguous time (2026-11-01 01:30 America/New_York = UTC-4 first)', () => {
    // First occurrence: 2026-11-01 01:30 EDT = 2026-11-01 05:30 UTC
    const expected = Date.UTC(2026, 10, 1, 5, 30, 0)
    // Second occurrence: 2026-11-01 01:30 EST = 2026-11-01 06:30 UTC
    const d = parseModelTime('2026-11-01 01:30', 'America/New_York')
    expect(d.getTime()).toBe(expected)
  })
})

// ─── formatPastTimeError ──────────────────────────────────────────────────────

describe('formatPastTimeError', () => {
  it('contains both timestamps in canonical format', () => {
    const parsed = new Date(Date.UTC(2026, 0, 1, 12, 0, 0))
    const now    = new Date(Date.UTC(2026, 0, 1, 13, 0, 0))
    const msg = formatPastTimeError(parsed, now, 'UTC')
    expect(msg).toMatch(/2026-01-01 12:00/)
    expect(msg).toMatch(/2026-01-01 13:00/)
  })

  it('contains the literal phrase "pick a time in the future"', () => {
    const parsed = new Date(Date.UTC(2026, 0, 1, 12, 0, 0))
    const now    = new Date(Date.UTC(2026, 0, 1, 13, 0, 0))
    const msg = formatPastTimeError(parsed, now, 'UTC')
    expect(msg.toLowerCase()).toContain('pick a time in the future')
  })

  it('contains the timezone name', () => {
    const parsed = new Date(Date.UTC(2026, 0, 1, 14, 0, 0)) // 09:00 EST
    const now    = new Date(Date.UTC(2026, 0, 1, 15, 0, 0)) // 10:00 EST
    const msg = formatPastTimeError(parsed, now, 'America/New_York')
    expect(msg).toContain('America/New_York')
  })

  it('formats times in the supplied timezone', () => {
    // parsed = 2026-01-01 09:00 EST, now = 2026-01-01 10:00 EST
    const parsed = new Date(Date.UTC(2026, 0, 1, 14, 0, 0))
    const now    = new Date(Date.UTC(2026, 0, 1, 15, 0, 0))
    const msg = formatPastTimeError(parsed, now, 'America/New_York')
    expect(msg).toMatch(/2026-01-01 09:00/)
    expect(msg).toMatch(/2026-01-01 10:00/)
  })
})
