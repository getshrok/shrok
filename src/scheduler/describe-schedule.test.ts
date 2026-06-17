import { describe, it, expect } from 'vitest'
import {
  describeScheduleLine,
  describeRecurringWhen,
  describeAnchor,
} from './describe-schedule.js'
import { describeCron } from './cron.js'
import type { Schedule } from '../db/schedules.js'

const NOW = new Date('2026-06-17T12:00:00Z') // Wed Jun 17 2026, 12:00 UTC

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched_1',
    headId: 'default',
    taskName: 'email',
    kind: 'task',
    cron: null,
    runAt: null,
    enabled: true,
    lastRun: null,
    nextRun: null,
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: null,
    cronTimezone: null,
    requiresAck: false,
    nagIntervalMinutes: null,
    ackPending: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

describe('describeRecurringWhen — the 8 canonical cadence shapes (UTC)', () => {
  const cases: Array<[string, string, string, string]> = [
    // [label, cron, nextRun ISO, expected]
    ['every N minutes', '*/30 * * * *', '2026-06-17T12:30:00Z', 'every 30 min, next today 12:30'],
    ['hourly', '15 * * * *', '2026-06-17T13:15:00Z', 'hourly at :15, next today 13:15'],
    ['daily', '0 9 * * *', '2026-06-18T09:00:00Z', 'daily 09:00, next tomorrow'],
    ['weekdays', '30 8 * * 1-5', '2026-06-18T08:30:00Z', 'weekdays 08:30, next tomorrow'],
    ['weekly (Monday)', '0 8 * * 1', '2026-06-22T08:00:00Z', 'Mondays 08:00, next Jun 22'],
    ['weekly (Sunday)', '0 8 * * 0', '2026-06-21T08:00:00Z', 'Sundays 08:00, next Jun 21'],
    ['every N days', '0 7 */3 * *', '2026-06-20T07:00:00Z', 'every 3 days 07:00, next Jun 20'],
    ['monthly', '0 9 15 * *', '2026-07-15T09:00:00Z', 'monthly on the 15th 09:00, next Jul 15'],
    ['yearly', '0 0 1 1 *', '2027-01-01T00:00:00Z', 'yearly 00:00, next Jan 1'],
  ]
  for (const [label, cron, next, expected] of cases) {
    it(label, () => {
      expect(describeRecurringWhen(cron, new Date(next), NOW, 'UTC')).toBe(expected)
    })
  }

  it('monthly ordinals — 1st/2nd/3rd/21st', () => {
    const at = (d: number) => describeRecurringWhen(`0 9 ${d} * *`, new Date(`2026-07-${String(d).padStart(2, '0')}T09:00:00Z`), NOW, 'UTC')
    expect(at(1)).toContain('on the 1st')
    expect(at(2)).toContain('on the 2nd')
    expect(at(3)).toContain('on the 3rd')
    expect(at(21)).toContain('on the 21st')
  })
})

describe('describeRecurringWhen — non-canonical cron falls back to cronstrue', () => {
  it('multi-day-of-week list degrades gracefully (does not throw, no shape match)', () => {
    const cron = '0 0 * * 1,3,5' // not one of the 8 shapes
    const out = describeRecurringWhen(cron, new Date('2026-06-18T00:00:00Z'), NOW, 'UTC')
    expect(out).toBe(`${describeCron(cron)}, next tomorrow 00:00`)
    expect(out).toContain('next tomorrow 00:00')
  })
})

describe('describeAnchor — today / tomorrow / Mon D thresholds', () => {
  it('same local day → today', () => {
    expect(describeAnchor(new Date('2026-06-17T20:00:00Z'), NOW, 'UTC', false)).toBe('today')
  })
  it('next local day → tomorrow', () => {
    expect(describeAnchor(new Date('2026-06-18T01:00:00Z'), NOW, 'UTC', false)).toBe('tomorrow')
  })
  it('beyond tomorrow → calendar date', () => {
    expect(describeAnchor(new Date('2026-06-22T08:00:00Z'), NOW, 'UTC', false)).toBe('Jun 22')
  })
  it('withClock appends HH:MM', () => {
    expect(describeAnchor(new Date('2026-06-17T17:30:00Z'), NOW, 'UTC', true)).toBe('today 17:30')
  })
})

describe('timezone awareness — clock + day delta are tz-local, never UTC', () => {
  // 2026-06-18T13:30Z == 09:30 EDT (UTC-4) on Jun 18; now 13:00Z == 09:00 EDT Jun 17.
  const next = new Date('2026-06-18T13:30:00Z')
  const nowNy = new Date('2026-06-17T13:00:00Z')
  it('America/New_York renders the local 09:30 clock and "tomorrow"', () => {
    expect(describeRecurringWhen('30 9 * * *', next, nowNy, 'America/New_York'))
      .toBe('daily 09:30, next tomorrow')
  })
  it('same instant under UTC shows the UTC 13:30 clock — proving the zone matters', () => {
    expect(describeRecurringWhen('30 9 * * *', next, nowNy, 'UTC'))
      .toBe('daily 13:30, next tomorrow')
  })
})

describe('describeScheduleLine — full line assembly', () => {
  it('one-time reminder → "Reminder · today HH:MM — <message>"', () => {
    const s = makeSchedule({
      kind: 'reminder',
      cron: null,
      runAt: '2026-06-17T17:30:00Z',
      nextRun: '2026-06-17T17:30:00Z',
      agentContext: 'call the bank',
    })
    expect(describeScheduleLine(s, NOW, 'UTC')).toBe('- Reminder · today 17:30 — call the bank')
  })

  it('recurring task → "Task · daily HH:MM, next ... — <taskName>"', () => {
    const s = makeSchedule({
      kind: 'task',
      taskName: 'backup-photos',
      cron: '0 2 * * *',
      nextRun: '2026-06-18T02:00:00Z',
    })
    expect(describeScheduleLine(s, NOW, 'UTC')).toBe('- Task · daily 02:00, next tomorrow — backup-photos')
  })

  it('ack-required reminder appends the (needs ack) flag', () => {
    const s = makeSchedule({
      kind: 'reminder',
      cron: '0 9 * * *',
      nextRun: '2026-06-18T09:00:00Z',
      agentContext: 'take meds',
      requiresAck: true,
    })
    expect(describeScheduleLine(s, NOW, 'UTC')).toBe('- Reminder · daily 09:00, next tomorrow — take meds  (needs ack)')
  })

  it('non-ack reminder has no flag', () => {
    const s = makeSchedule({ kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: 'x' })
    expect(describeScheduleLine(s, NOW, 'UTC')).not.toContain('(needs ack)')
  })

  it('truncates reminder text to 160 chars with an ellipsis', () => {
    const long = 'A'.repeat(200)
    const s = makeSchedule({ kind: 'reminder', runAt: '2026-06-17T17:30:00Z', nextRun: '2026-06-17T17:30:00Z', agentContext: long })
    const line = describeScheduleLine(s, NOW, 'UTC')
    const label = line.split(' — ')[1]!
    expect(label.length).toBe(160)
    expect(label.endsWith('…')).toBe(true)
  })

  it('renders a schedule in its own cronTimezone (passed by the caller)', () => {
    const s = makeSchedule({
      kind: 'task',
      taskName: 'nightly',
      cron: '30 9 * * *',
      nextRun: '2026-06-18T13:30:00Z',
      cronTimezone: 'America/New_York',
    })
    // Caller resolves cronTimezone ?? workspace tz; here we pass the schedule's own zone.
    expect(describeScheduleLine(s, NOW, s.cronTimezone ?? 'UTC')).toBe('- Task · daily 09:30, next tomorrow — nightly')
  })
})
