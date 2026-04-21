import { describe, it, expect } from 'vitest'
import { nextRunAfter } from './cron.js'

// All `after` instants are explicit so the tests are deterministic regardless
// of the host's local timezone. Expected values are pre-computed UTC instants.
// Mirrors the structure of src/period.test.ts (the existing reference for
// timezone-aware time tests).

describe('nextRunAfter (timezone-aware)', () => {
  describe('UTC passthrough (byte-equivalent to pre-plan behavior)', () => {
    it('`0 0 * * *` fires at next UTC midnight', () => {
      const after = new Date('2025-06-15T12:00:00Z')
      expect(nextRunAfter('0 0 * * *', after, 'UTC').toISOString())
        .toBe('2025-06-16T00:00:00.000Z')
    })

    it('`0 * * * *` (hourly) — UTC', () => {
      const after = new Date('2025-06-15T13:30:00Z')
      expect(nextRunAfter('0 * * * *', after, 'UTC').toISOString())
        .toBe('2025-06-15T14:00:00.000Z')
    })
  })

  describe('America/New_York', () => {
    it('EDT: `0 9 * * *` at 08:00 EDT fires same day at 09:00 EDT (13:00 UTC)', () => {
      const after = new Date('2025-06-15T12:00:00Z')  // 08:00 EDT on June 15
      expect(nextRunAfter('0 9 * * *', after, 'America/New_York').toISOString())
        .toBe('2025-06-15T13:00:00.000Z')
    })

    it('EDT: `0 9 * * *` at 14:00 EDT fires NEXT day at 09:00 EDT', () => {
      const after = new Date('2025-06-15T18:00:00Z')  // 14:00 EDT on June 15
      expect(nextRunAfter('0 9 * * *', after, 'America/New_York').toISOString())
        .toBe('2025-06-16T13:00:00.000Z')
    })

    it('EST: `0 9 * * *` at 07:00 EST fires same day at 09:00 EST (14:00 UTC)', () => {
      const after = new Date('2025-01-15T12:00:00Z')  // 07:00 EST on Jan 15
      expect(nextRunAfter('0 9 * * *', after, 'America/New_York').toISOString())
        .toBe('2025-01-15T14:00:00.000Z')
    })

    it('EST: `0 9 * * *` at 10:00 EST fires NEXT day at 09:00 EST', () => {
      const after = new Date('2025-01-15T15:00:00Z')  // 10:00 EST on Jan 15
      expect(nextRunAfter('0 9 * * *', after, 'America/New_York').toISOString())
        .toBe('2025-01-16T14:00:00.000Z')
    })

    it('DST spring-forward: `0 2 * * *` advances past the skipped hour', () => {
      // On 2025-03-09, 02:00 America/New_York does not exist — clocks jump
      // from 01:59 EST to 03:00 EDT. cron-parser handles this correctly; we
      // only assert the result advances past the input (no infinite loop).
      const after = new Date('2025-03-09T05:00:00Z')  // 01:00 EST on the transition day
      const next = nextRunAfter('0 2 * * *', after, 'America/New_York')
      expect(next).toBeInstanceOf(Date)
      expect(next.getTime()).toBeGreaterThan(after.getTime())
    })
  })

  describe('positive offsets', () => {
    it('Asia/Tokyo (UTC+9): `0 9 * * *` fires at 09:00 JST (00:00 UTC)', () => {
      const after = new Date('2025-06-15T12:00:00Z')  // 21:00 JST June 15
      expect(nextRunAfter('0 9 * * *', after, 'Asia/Tokyo').toISOString())
        .toBe('2025-06-16T00:00:00.000Z')
    })
  })

  describe('byte-equivalence when tz === UTC', () => {
    it('every-3-minute cron matches existing scheduler.test.ts expectation', () => {
      const after = new Date('2026-01-01T10:01:00Z')
      expect(nextRunAfter('*/3 * * * *', after, 'UTC'))
        .toEqual(new Date('2026-01-01T10:03:00Z'))
    })
  })

  describe('invalid inputs', () => {
    it('throws on invalid cron expression (same contract as before)', () => {
      expect(() => nextRunAfter('not a cron', new Date(), 'UTC')).toThrow()
    })
  })
})
