import { describe, it, expect } from 'vitest'
import { dayStartUtc, periodStart, daysAgoStart } from './period.js'

// All `now` values are explicit so the tests are deterministic regardless of
// host timezone or DST season. Expected values are pre-computed UTC instants.

describe('dayStartUtc', () => {
  describe('UTC', () => {
    it('returns the same calendar day at 00:00Z', () => {
      const now = new Date('2025-06-15T13:00:00Z')
      expect(dayStartUtc('UTC', now).toISOString()).toBe('2025-06-15T00:00:00.000Z')
    })

    it('handles instants right at midnight', () => {
      const now = new Date('2025-06-15T00:00:00Z')
      expect(dayStartUtc('UTC', now).toISOString()).toBe('2025-06-15T00:00:00.000Z')
    })
  })

  describe('America/New_York — DST regression cases (the bug task 1 left in)', () => {
    it('spring-forward Sunday: midnight is EST, not EDT', () => {
      // 13:00 UTC March 9 = 09:00 EDT (DST jumped at 07:00 UTC = 02:00 EST → 03:00 EDT)
      // Midnight on March 9 NY happened at 05:00 UTC, still in EST.
      // Buggy v1 helper returned 04:00 UTC (off by 1h, landing in March 8).
      const now = new Date('2025-03-09T13:00:00Z')
      expect(dayStartUtc('America/New_York', now).toISOString()).toBe('2025-03-09T05:00:00.000Z')
    })

    it('fall-back Sunday: midnight is EDT, not EST', () => {
      // 13:00 UTC Nov 2 = 08:00 EST (fall-back at 06:00 UTC = 02:00 EDT → 01:00 EST)
      // Midnight Nov 2 NY happened at 04:00 UTC, still in EDT (before fall-back).
      const now = new Date('2025-11-02T13:00:00Z')
      expect(dayStartUtc('America/New_York', now).toISOString()).toBe('2025-11-02T04:00:00.000Z')
    })
  })

  describe('America/New_York — normal days', () => {
    it('summer day (EDT, UTC-4)', () => {
      const now = new Date('2025-06-15T13:00:00Z')
      expect(dayStartUtc('America/New_York', now).toISOString()).toBe('2025-06-15T04:00:00.000Z')
    })

    it('winter day (EST, UTC-5)', () => {
      const now = new Date('2025-01-15T13:00:00Z')
      expect(dayStartUtc('America/New_York', now).toISOString()).toBe('2025-01-15T05:00:00.000Z')
    })
  })

  describe('positive offsets', () => {
    it('Asia/Tokyo (UTC+9)', () => {
      // 13:00 UTC June 15 = 22:00 JST June 15. Midnight JST June 15 = 15:00 UTC June 14.
      const now = new Date('2025-06-15T13:00:00Z')
      expect(dayStartUtc('Asia/Tokyo', now).toISOString()).toBe('2025-06-14T15:00:00.000Z')
    })

    it('Pacific/Kiritimati (UTC+14, > 12h positive offset)', () => {
      // 13:00 UTC June 15 = 03:00 June 16 LINT. Midnight June 16 LINT = 10:00 UTC June 15.
      const now = new Date('2025-06-15T13:00:00Z')
      expect(dayStartUtc('Pacific/Kiritimati', now).toISOString()).toBe('2025-06-15T10:00:00.000Z')
    })
  })
})

describe('periodStart', () => {
  describe('day', () => {
    it('delegates to dayStartUtc', () => {
      const now = new Date('2025-06-15T13:00:00Z')
      expect(periodStart('America/New_York', 'day', now).toISOString())
        .toBe(dayStartUtc('America/New_York', now).toISOString())
    })
  })

  describe('week — Sunday-start (US)', () => {
    it('Sunday now → today (stepsBack 0 fast path)', () => {
      // June 15 2025 is a Sunday in NY
      const now = new Date('2025-06-15T13:00:00Z')
      expect(periodStart('America/New_York', 'week', now).toISOString()).toBe('2025-06-15T04:00:00.000Z')
    })

    it('Wednesday now → previous Sunday (stepsBack 3)', () => {
      // June 18 2025 = Wednesday → previous Sunday is June 15
      const now = new Date('2025-06-18T13:00:00Z')
      expect(periodStart('America/New_York', 'week', now).toISOString()).toBe('2025-06-15T04:00:00.000Z')
    })

    it('Saturday now → previous Sunday (stepsBack 6)', () => {
      // June 21 2025 = Saturday → previous Sunday is June 15
      const now = new Date('2025-06-21T13:00:00Z')
      expect(periodStart('America/New_York', 'week', now).toISOString()).toBe('2025-06-15T04:00:00.000Z')
    })

    it('DST spring-forward week: week start retains EST offset', () => {
      // March 12 2025 = Wednesday after spring-forward (March 9).
      // The week started Sunday March 9 at midnight EST = 05:00 UTC.
      const now = new Date('2025-03-12T13:00:00Z')
      expect(periodStart('America/New_York', 'week', now).toISOString()).toBe('2025-03-09T05:00:00.000Z')
    })

    it('DST fall-back week: week start retains EDT offset', () => {
      // November 5 2025 = Wednesday after fall-back (Nov 2).
      // The week started Sunday Nov 2 at midnight EDT = 04:00 UTC.
      const now = new Date('2025-11-05T13:00:00Z')
      expect(periodStart('America/New_York', 'week', now).toISOString()).toBe('2025-11-02T04:00:00.000Z')
    })
  })

  describe('month', () => {
    it('1st of month → today (fast path)', () => {
      const now = new Date('2025-06-01T13:00:00Z')
      expect(periodStart('America/New_York', 'month', now).toISOString()).toBe('2025-06-01T04:00:00.000Z')
    })

    it('mid-month → 1st at local midnight', () => {
      const now = new Date('2025-06-15T13:00:00Z')
      expect(periodStart('America/New_York', 'month', now).toISOString()).toBe('2025-06-01T04:00:00.000Z')
    })

    it('last day of 31-day month', () => {
      const now = new Date('2025-05-31T13:00:00Z')
      expect(periodStart('America/New_York', 'month', now).toISOString()).toBe('2025-05-01T04:00:00.000Z')
    })

    it('last day of February (non-leap)', () => {
      const now = new Date('2025-02-28T13:00:00Z')
      expect(periodStart('America/New_York', 'month', now).toISOString()).toBe('2025-02-01T05:00:00.000Z')
    })

    it('month containing a DST transition: returns EST midnight on the 1st', () => {
      // March 2025 contains the spring-forward (March 9). Computing month start
      // from any day after the transition must still return midnight EST on March 1.
      const now = new Date('2025-03-15T13:00:00Z')
      expect(periodStart('America/New_York', 'month', now).toISOString()).toBe('2025-03-01T05:00:00.000Z')
    })
  })
})

describe('daysAgoStart', () => {
  it('n=0 → today (delegates to dayStartUtc)', () => {
    const now = new Date('2025-06-15T13:00:00Z')
    expect(daysAgoStart('UTC', 0, now).toISOString()).toBe('2025-06-15T00:00:00.000Z')
  })

  it('UTC: n=7 → 7 days back at UTC midnight', () => {
    const now = new Date('2025-06-15T13:00:00Z')
    expect(daysAgoStart('UTC', 7, now).toISOString()).toBe('2025-06-08T00:00:00.000Z')
  })

  it('NY: n=6 from Wed-after-spring-forward lands on prior EST midnight', () => {
    // March 12 2025 is Wed. 6 days back = March 6 (Thursday), still pre-DST → EST midnight.
    const now = new Date('2025-03-12T13:00:00Z')
    expect(daysAgoStart('America/New_York', 6, now).toISOString()).toBe('2025-03-06T05:00:00.000Z')
  })

  it('NY: n=29 looking back across the DST boundary lands on the correct EDT midnight', () => {
    // April 8 2025 is post-DST. 29 days back = March 10, also post-DST → EDT midnight.
    const now = new Date('2025-04-08T13:00:00Z')
    expect(daysAgoStart('America/New_York', 29, now).toISOString()).toBe('2025-03-10T04:00:00.000Z')
  })

  it('Asia/Tokyo: n=6', () => {
    // June 15 in Tokyo. 6 days back = June 9 JST midnight = June 8 15:00 UTC.
    const now = new Date('2025-06-15T13:00:00Z')
    expect(daysAgoStart('Asia/Tokyo', 6, now).toISOString()).toBe('2025-06-08T15:00:00.000Z')
  })
})
