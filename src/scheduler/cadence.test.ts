import { describe, it, expect } from 'vitest'
import { isValidCadence, CADENCE_ERROR_MESSAGE } from './cadence.js'

describe('isValidCadence', () => {
  describe('accepts: every N minutes', () => {
    it.each([5, 10, 15, 30, 45, 60])('%i minutes: */%i * * * *', (n) => {
      expect(isValidCadence(`*/${n} * * * *`)).toBe(true)
    })
  })

  describe('accepts: hourly', () => {
    it('minute 0',  () => expect(isValidCadence('0 * * * *')).toBe(true))
    it('minute 30', () => expect(isValidCadence('30 * * * *')).toBe(true))
    it('minute 59', () => expect(isValidCadence('59 * * * *')).toBe(true))
  })

  describe('accepts: daily', () => {
    it('09:00', () => expect(isValidCadence('0 9 * * *')).toBe(true))
    it('23:45', () => expect(isValidCadence('45 23 * * *')).toBe(true))
    it('00:00', () => expect(isValidCadence('0 0 * * *')).toBe(true))
  })

  describe('accepts: weekly', () => {
    it.each([0, 1, 2, 3, 4, 5, 6])('day-of-week %i', (d) => {
      expect(isValidCadence(`0 9 * * ${d}`)).toBe(true)
    })
  })

  describe('accepts: monthly', () => {
    it('day 1',  () => expect(isValidCadence('0 9 1 * *')).toBe(true))
    it('day 15', () => expect(isValidCadence('0 9 15 * *')).toBe(true))
    it('day 28', () => expect(isValidCadence('0 9 28 * *')).toBe(true))
  })

  describe('accepts: yearly', () => {
    it('Jan 1',  () => expect(isValidCadence('0 9 1 1 *')).toBe(true))
    it('Jun 15', () => expect(isValidCadence('0 9 15 6 *')).toBe(true))
    it('Dec 28', () => expect(isValidCadence('0 9 28 12 *')).toBe(true))
  })

  describe('whitespace tolerance', () => {
    it('trims leading/trailing whitespace', () => {
      expect(isValidCadence('  0 9 * * *  ')).toBe(true)
    })
  })

  describe('rejects: */N with unsupported N', () => {
    it.each(['*/1', '*/2', '*/3', '*/7', '*/20', '*/120'])('%s * * * *', (head) => {
      expect(isValidCadence(`${head} * * * *`)).toBe(false)
    })
  })

  describe('rejects: complex expressions', () => {
    it('weekday range 1-5',       () => expect(isValidCadence('0 9 * * 1-5')).toBe(false))
    it('comma list hours',        () => expect(isValidCadence('0 9,17 * * *')).toBe(false))
    it('every minute * * * * *',  () => expect(isValidCadence('* * * * *')).toBe(false))
    it('all-numeric yearly-shape', () => expect(isValidCadence('0 0 1 1 0')).toBe(false))
  })

  describe('rejects: out-of-bounds fields', () => {
    it('minute 60',       () => expect(isValidCadence('60 * * * *')).toBe(false))
    it('hour 24',         () => expect(isValidCadence('0 24 * * *')).toBe(false))
    it('dow 7',           () => expect(isValidCadence('0 9 * * 7')).toBe(false))
    it('dom 29 monthly',  () => expect(isValidCadence('0 9 29 * *')).toBe(false))
    it('dom 31 monthly',  () => expect(isValidCadence('0 9 31 * *')).toBe(false))
    it('dom 0 monthly',   () => expect(isValidCadence('0 9 0 * *')).toBe(false))
    it('month 13 yearly', () => expect(isValidCadence('0 9 15 13 *')).toBe(false))
    it('month 0 yearly',  () => expect(isValidCadence('0 9 15 0 *')).toBe(false))
    it('dom 29 yearly',   () => expect(isValidCadence('0 9 29 6 *')).toBe(false))
  })

  describe('rejects: malformed input', () => {
    it('empty string',    () => expect(isValidCadence('')).toBe(false))
    it('garbage text',    () => expect(isValidCadence('not-a-cron')).toBe(false))
    it('3 fields only',   () => expect(isValidCadence('0 9 *')).toBe(false))
    it('6 fields',        () => expect(isValidCadence('0 0 9 * * *')).toBe(false))
  })
})

describe('CADENCE_ERROR_MESSAGE', () => {
  it('is the exact locked D-05 string', () => {
    expect(CADENCE_ERROR_MESSAGE).toBe(
      'Invalid cron frequency. Supported cadences: every N minutes (*/N * * * *), hourly, daily, weekly, monthly, yearly. For custom timing logic (e.g. weekdays only, skip holidays), use the conditions argument instead of a custom cron expression.'
    )
  })

  it('mentions the conditions argument (agent guidance)', () => {
    expect(CADENCE_ERROR_MESSAGE).toContain('conditions')
  })
})
