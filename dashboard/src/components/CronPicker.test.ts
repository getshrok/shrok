/**
 * CronPicker pure-function tests — RED phase (TDD)
 *
 * These tests exercise parseCronToState, buildCron, and formatHuman through
 * the exported test helpers. They are written before the implementation to
 * verify the two new cadences: 'weekdays' and 'everyNDays'.
 *
 * Run: cd dashboard && npx vitest run CronPicker
 */

import { describe, it, expect } from 'vitest'
import { parseCronToState, buildCron, formatHuman, DEFAULT_STATE } from './CronPicker.js'

// ---------------------------------------------------------------------------
// weekdays cadence
// ---------------------------------------------------------------------------

describe('weekdays cadence', () => {
  it('buildCron emits M H * * 1-5 for weekdays', () => {
    const state = { ...DEFAULT_STATE, cadence: 'weekdays' as const, hour: 9, minute: 0 }
    expect(buildCron(state)).toBe('0 9 * * 1-5')
  })

  it('buildCron emits correct minute for weekdays', () => {
    const state = { ...DEFAULT_STATE, cadence: 'weekdays' as const, hour: 14, minute: 30 }
    expect(buildCron(state)).toBe('30 14 * * 1-5')
  })

  it('parseCronToState parses 0 9 * * 1-5 as weekdays cadence', () => {
    const s = parseCronToState('0 9 * * 1-5')
    expect(s.cadence).toBe('weekdays')
    expect(s.hour).toBe(9)
    expect(s.minute).toBe(0)
  })

  it('parseCronToState parses 30 14 * * 1-5 correctly', () => {
    const s = parseCronToState('30 14 * * 1-5')
    expect(s.cadence).toBe('weekdays')
    expect(s.hour).toBe(14)
    expect(s.minute).toBe(30)
  })

  it('round-trips weekdays cron through parseCronToState(buildCron(state))', () => {
    const original = { ...DEFAULT_STATE, cadence: 'weekdays' as const, hour: 14, minute: 30 }
    const rebuilt = parseCronToState(buildCron(original))
    expect(rebuilt.cadence).toBe('weekdays')
    expect(rebuilt.hour).toBe(14)
    expect(rebuilt.minute).toBe(30)
  })

  it('formatHuman returns correct label for weekdays', () => {
    const state = { ...DEFAULT_STATE, cadence: 'weekdays' as const, hour: 9, minute: 0 }
    expect(formatHuman(state)).toBe('Every weekday (Mon–Fri) at 09:00')
  })
})

// ---------------------------------------------------------------------------
// everyNDays cadence
// ---------------------------------------------------------------------------

describe('everyNDays cadence', () => {
  it('buildCron emits 0 H */N * * for everyNDays', () => {
    const state = { ...DEFAULT_STATE, cadence: 'everyNDays' as const, hour: 9, minute: 0, everyNDaysInterval: 3 as const }
    expect(buildCron(state)).toBe('0 9 */3 * *')
  })

  it('buildCron always emits minute=0 for everyNDays regardless of state.minute', () => {
    const state = { ...DEFAULT_STATE, cadence: 'everyNDays' as const, hour: 14, minute: 45, everyNDaysInterval: 5 as const }
    expect(buildCron(state)).toBe('0 14 */5 * *')
  })

  it('parseCronToState parses 0 14 */5 * * as everyNDays with interval=5 and hour=14', () => {
    const s = parseCronToState('0 14 */5 * *')
    expect(s.cadence).toBe('everyNDays')
    expect(s.hour).toBe(14)
    expect(s.everyNDaysInterval).toBe(5)
    expect(s.minute).toBe(0)
  })

  it('parseCronToState parses 0 9 */3 * * correctly', () => {
    const s = parseCronToState('0 9 */3 * *')
    expect(s.cadence).toBe('everyNDays')
    expect(s.hour).toBe(9)
    expect(s.everyNDaysInterval).toBe(3)
  })

  it('round-trips everyNDays cron through parseCronToState(buildCron(state))', () => {
    const original = { ...DEFAULT_STATE, cadence: 'everyNDays' as const, hour: 14, minute: 0, everyNDaysInterval: 5 as const }
    const rebuilt = parseCronToState(buildCron(original))
    expect(rebuilt.cadence).toBe('everyNDays')
    expect(rebuilt.hour).toBe(14)
    expect(rebuilt.everyNDaysInterval).toBe(5)
  })

  it('out-of-range N (8) falls back to DEFAULT_STATE', () => {
    const s = parseCronToState('0 9 */8 * *')
    expect(s.cadence).toBe(DEFAULT_STATE.cadence)
  })

  it('out-of-range N (9) falls back to DEFAULT_STATE', () => {
    const s = parseCronToState('0 9 */9 * *')
    expect(s.cadence).toBe(DEFAULT_STATE.cadence)
  })

  it('formatHuman returns singular "day" for interval=1', () => {
    const state = { ...DEFAULT_STATE, cadence: 'everyNDays' as const, hour: 9, minute: 0, everyNDaysInterval: 1 as const }
    expect(formatHuman(state)).toBe('Every 1 day at 09:00')
  })

  it('formatHuman returns plural "days" for interval>1', () => {
    const state = { ...DEFAULT_STATE, cadence: 'everyNDays' as const, hour: 14, minute: 0, everyNDaysInterval: 3 as const }
    expect(formatHuman(state)).toBe('Every 3 days at 14:00')
  })
})

// ---------------------------------------------------------------------------
// Regression: existing cadences still work
// ---------------------------------------------------------------------------

describe('existing cadences (regression)', () => {
  it('daily still works', () => {
    expect(buildCron({ ...DEFAULT_STATE, cadence: 'daily', minute: 0, hour: 9 })).toBe('0 9 * * *')
    expect(parseCronToState('0 9 * * *').cadence).toBe('daily')
  })

  it('weekly still works', () => {
    expect(buildCron({ ...DEFAULT_STATE, cadence: 'weekly', minute: 0, hour: 9, dayOfWeek: 1 })).toBe('0 9 * * 1')
    expect(parseCronToState('0 9 * * 1').cadence).toBe('weekly')
  })

  it('monthly still works', () => {
    expect(buildCron({ ...DEFAULT_STATE, cadence: 'monthly', minute: 0, hour: 9, dayOfMonth: 1 })).toBe('0 9 1 * *')
    expect(parseCronToState('0 9 1 * *').cadence).toBe('monthly')
  })

  it('weekdays is NOT parsed as weekly', () => {
    // 1-5 is not a single digit, so it must go to weekdays, not weekly
    const s = parseCronToState('0 9 * * 1-5')
    expect(s.cadence).toBe('weekdays')
    expect(s.cadence).not.toBe('weekly')
  })
})

// ---------------------------------------------------------------------------
// Dropdown ordering (verifies CadenceType exhaustiveness)
// ---------------------------------------------------------------------------

describe('CadenceType ordering', () => {
  it('DEFAULT_STATE has everyNDaysInterval field', () => {
    expect(DEFAULT_STATE).toHaveProperty('everyNDaysInterval')
    expect(DEFAULT_STATE.everyNDaysInterval).toBe(1)
  })
})
