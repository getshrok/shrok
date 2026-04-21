import { describe, it, expect } from 'vitest'
import { checkThresholds, formatThresholdAlert, formatThresholdBlock, findBlockingThresholds, validateCreateThreshold, validateUpdateThreshold, enrichThresholds, type UsageThreshold, type CheckThresholdsInput, type ThresholdCrossing } from './usage-threshold.js'

// Helpers — every test passes an explicit `now` and an explicit `getCostSince`.
const TZ = 'America/New_York'
const NOW = new Date('2026-04-09T18:00:00Z')   // 2 PM EDT, mid-day, well inside the day

const thresholdDay  = (id: string, amountUsd: number): UsageThreshold => ({ id, period: 'day',   amountUsd, action: 'alert' })
const thresholdWeek = (id: string, amountUsd: number): UsageThreshold => ({ id, period: 'week',  amountUsd, action: 'alert' })
const thresholdMon  = (id: string, amountUsd: number): UsageThreshold => ({ id, period: 'month', amountUsd, action: 'alert' })

const blockDay = (id: string, amountUsd: number): UsageThreshold => ({ id, period: 'day', amountUsd, action: 'block' })

const constSpend = (n: number) => () => n

function input(opts: Partial<CheckThresholdsInput> & Pick<CheckThresholdsInput, 'thresholds'>): CheckThresholdsInput {
  return {
    firedAt: {},
    getCostSince: constSpend(0),
    now: NOW,
    tz: TZ,
    ...opts,
  }
}

describe('checkThresholds', () => {
  it('returns no crossings when there are no thresholds', () => {
    expect(checkThresholds(input({ thresholds: [] }))).toEqual([])
  })

  it('returns no crossings when spend is under every threshold', () => {
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5), thresholdDay('t2', 10)],
      getCostSince: constSpend(3),
    }))
    expect(result).toEqual([])
  })

  it('returns a crossing when spend reaches the threshold (>= semantics)', () => {
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5)],
      getCostSince: constSpend(5),
    }))
    expect(result).toHaveLength(1)
    expect(result[0]?.threshold.id).toBe('t1')
    expect(result[0]?.currentSpend).toBe(5)
  })

  it('returns a crossing when spend exceeds the threshold', () => {
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5)],
      getCostSince: constSpend(7.5),
    }))
    expect(result).toHaveLength(1)
    expect(result[0]?.currentSpend).toBe(7.5)
  })

  it('does not return a crossing for a threshold already fired this period', () => {
    // Crossed at $5; fired at noon today. now = 2 PM today. fired > periodStart → silenced.
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5)],
      firedAt: { t1: new Date('2026-04-09T16:00:00Z') }, // noon EDT today
      getCostSince: constSpend(7),
    }))
    expect(result).toEqual([])
  })

  it('returns a crossing when fired in a prior period (eligible again)', () => {
    // Crossed at $5; last fired yesterday. periodStart for today is after the fire → eligible.
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5)],
      firedAt: { t1: new Date('2026-04-08T18:00:00Z') }, // yesterday afternoon
      getCostSince: constSpend(7),
    }))
    expect(result).toHaveLength(1)
  })

  it("a fired stamp on a different threshold doesn't bleed across ids", () => {
    // firedAt has an entry for 'other', which should be completely ignored when
    // evaluating 't1'. Implicit in the multi-threshold test below, but worth
    // asserting explicitly so a future regression can't silently couple by id.
    const result = checkThresholds(input({
      thresholds: [thresholdDay('t1', 5)],
      firedAt: { other: new Date('2026-04-09T16:00:00Z') },
      getCostSince: constSpend(7),
    }))
    expect(result).toHaveLength(1)
    expect(result[0]?.threshold.id).toBe('t1')
  })

  it('handles multiple thresholds with mixed states in one call', () => {
    const result = checkThresholds(input({
      thresholds: [
        thresholdDay('t_under', 100),  // under budget
        thresholdDay('t_over_eligible', 5),
        thresholdDay('t_over_silenced', 5),
      ],
      firedAt: { t_over_silenced: new Date('2026-04-09T16:00:00Z') }, // fired today
      getCostSince: constSpend(7),
    }))
    expect(result.map(c => c.threshold.id)).toEqual(['t_over_eligible'])
  })

  it('computes period start per threshold (day vs week vs month)', () => {
    // Stub spy: capture which `since` instants getCostSince is called with.
    const seen: Date[] = []
    const result = checkThresholds(input({
      thresholds: [thresholdDay('d', 1), thresholdWeek('w', 1), thresholdMon('m', 1)],
      getCostSince: (since) => { seen.push(since); return 100 },
    }))
    expect(result).toHaveLength(3)
    // For now = 2026-04-09T18:00 in NY (Thursday after April 5 Sunday week-start, April 1 month-start):
    expect(seen[0]?.toISOString()).toBe('2026-04-09T04:00:00.000Z') // day  → April 9 EDT midnight
    expect(seen[1]?.toISOString()).toBe('2026-04-05T04:00:00.000Z') // week → April 5 (Sunday) EDT midnight
    expect(seen[2]?.toISOString()).toBe('2026-04-01T04:00:00.000Z') // month → April 1 EDT midnight
    // The crossing's periodStart matches the queried since
    expect(result[0]?.periodStart.toISOString()).toBe('2026-04-09T04:00:00.000Z')
    expect(result[1]?.periodStart.toISOString()).toBe('2026-04-05T04:00:00.000Z')
    expect(result[2]?.periodStart.toISOString()).toBe('2026-04-01T04:00:00.000Z')
  })

  it('returns the full threshold record on each crossing (amount, period, action)', () => {
    const t = thresholdWeek('t1', 25)
    const result = checkThresholds(input({
      thresholds: [t],
      getCostSince: constSpend(30),
    }))
    expect(result[0]?.threshold).toEqual(t)
  })

  it('explicit `now` controls the period boundary (same data, different now → different result)', () => {
    // Same threshold + spend + fired-state. Two different `now` values straddle a day boundary.
    const t = thresholdDay('t1', 5)
    const fired = new Date('2026-04-09T18:00:00Z') // afternoon April 9 EDT
    const common = {
      thresholds: [t],
      firedAt: { t1: fired },
      getCostSince: constSpend(7),
      tz: TZ,
    }
    // now = afternoon April 9 → fired this period → silenced
    expect(checkThresholds({ ...common, now: new Date('2026-04-09T20:00:00Z') })).toEqual([])
    // now = April 10 morning → new day, fired stamp is "yesterday" → eligible
    expect(checkThresholds({ ...common, now: new Date('2026-04-10T15:00:00Z') })).toHaveLength(1)
  })

  it('skips block-action thresholds (handled by findBlockingThresholds)', () => {
    // A block threshold over budget should NOT come back from checkThresholds —
    // blocks have different eligibility semantics (no fired-state filtering)
    // and live in their own evaluator.
    const result = checkThresholds(input({
      thresholds: [blockDay('t1', 5)],
      getCostSince: constSpend(7),
    }))
    expect(result).toEqual([])
  })
})

describe('findBlockingThresholds', () => {
  it('returns no crossings for an empty list', () => {
    expect(findBlockingThresholds([], () => 100, NOW, TZ)).toEqual([])
  })

  it('skips alert-action thresholds even when over budget', () => {
    const result = findBlockingThresholds([thresholdDay('t1', 5)], () => 7, NOW, TZ)
    expect(result).toEqual([])
  })

  it('skips block thresholds under budget', () => {
    const result = findBlockingThresholds([blockDay('t1', 5)], () => 3, NOW, TZ)
    expect(result).toEqual([])
  })

  it('returns block thresholds at the threshold (>= semantics)', () => {
    const result = findBlockingThresholds([blockDay('t1', 5)], () => 5, NOW, TZ)
    expect(result).toHaveLength(1)
    expect(result[0]?.threshold.id).toBe('t1')
    expect(result[0]?.currentSpend).toBe(5)
  })

  it('returns block thresholds over budget', () => {
    const result = findBlockingThresholds([blockDay('t1', 5)], () => 7.5, NOW, TZ)
    expect(result).toHaveLength(1)
  })

  it('does NOT filter by fired-state — block keeps blocking even after a stamped fire', () => {
    // The fired-state map is irrelevant to findBlockingThresholds; even if the
    // threshold "fired" earlier this period, the block re-triggers as long as
    // spend is still over budget.
    const result = findBlockingThresholds([blockDay('t1', 5)], () => 7, NOW, TZ)
    // Same call signature — no firedAt parameter at all, by design.
    expect(result).toHaveLength(1)
  })

  it('returns only the over-budget blocks from a mixed list', () => {
    const result = findBlockingThresholds(
      [blockDay('over', 5), blockDay('under', 100), thresholdDay('alert_over', 5)],
      () => 10,
      NOW,
      TZ,
    )
    expect(result.map(c => c.threshold.id)).toEqual(['over'])
  })
})

describe('formatThresholdBlock', () => {
  const makeBlockCrossing = (period: 'day' | 'week' | 'month', amountUsd: number, currentSpend: number): ThresholdCrossing => ({
    threshold: { id: 't1', period, amountUsd, action: 'block' },
    currentSpend,
    periodStart: new Date('2026-04-09T04:00:00Z'),
  })

  it('formats a daily block crossing', () => {
    const out = formatThresholdBlock(makeBlockCrossing('day', 5, 7.42))
    expect(out).toContain('Shrok has stopped')
    expect(out).toContain('daily budget of $5.00')
    expect(out).toContain('today: $7.42')
    expect(out).toContain('preserved')
  })

  it('formats a weekly block crossing', () => {
    const out = formatThresholdBlock(makeBlockCrossing('week', 25, 30))
    expect(out).toContain('weekly budget of $25.00')
    expect(out).toContain('this week: $30.00')
  })

  it('formats a monthly block crossing', () => {
    const out = formatThresholdBlock(makeBlockCrossing('month', 100, 103.42))
    expect(out).toContain('monthly budget of $100.00')
    expect(out).toContain('this month: $103.42')
  })
})

describe('formatThresholdAlert', () => {
  const makeCrossing = (period: 'day' | 'week' | 'month', amountUsd: number, currentSpend: number): ThresholdCrossing => ({
    threshold: { id: 't1', period, amountUsd, action: 'alert' },
    currentSpend,
    periodStart: new Date('2026-04-09T04:00:00Z'),
  })

  it('formats a daily crossing', () => {
    expect(formatThresholdAlert(makeCrossing('day', 5, 7.42))).toBe(
      `Heads up — you've hit your daily budget of $5.00. So far today: $7.42.`,
    )
  })

  it('formats a weekly crossing', () => {
    expect(formatThresholdAlert(makeCrossing('week', 25, 30.00))).toBe(
      `Heads up — you've hit your weekly budget of $25.00. So far this week: $30.00.`,
    )
  })

  it('formats a monthly crossing matching the task description example', () => {
    expect(formatThresholdAlert(makeCrossing('month', 100, 103.42))).toBe(
      `Heads up — you've hit your monthly budget of $100.00. So far this month: $103.42.`,
    )
  })

  it('uses two-decimal currency formatting for whole-dollar amounts', () => {
    const out = formatThresholdAlert(makeCrossing('day', 50, 50))
    expect(out).toContain('$50.00')
    expect(out).not.toContain('$50.0.') // sanity: no missing trailing zero
  })
})

describe('validateCreateThreshold', () => {
  const valid = { period: 'day' as const, amountUsd: 5 }

  it('accepts a fully-valid body and defaults missing action to alert', () => {
    const result = validateCreateThreshold(valid)
    expect(result).toEqual({ ok: true, value: { ...valid, action: 'alert' } })
  })

  it('accepts an explicit action="alert"', () => {
    const result = validateCreateThreshold({ ...valid, action: 'alert' })
    expect(result).toEqual({ ok: true, value: { ...valid, action: 'alert' } })
  })

  it('accepts an explicit action="block"', () => {
    const result = validateCreateThreshold({ ...valid, action: 'block' })
    expect(result).toEqual({ ok: true, value: { ...valid, action: 'block' } })
  })

  it('rejects invalid action values', () => {
    expect(validateCreateThreshold({ ...valid, action: 'halt' }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, action: 5 }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, action: null }).ok).toBe(false)
  })

  it('rejects non-object bodies', () => {
    expect(validateCreateThreshold(null).ok).toBe(false)
    expect(validateCreateThreshold('foo').ok).toBe(false)
    expect(validateCreateThreshold(42).ok).toBe(false)
  })

  it('rejects invalid period values', () => {
    expect(validateCreateThreshold({ ...valid, period: 'year' }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, period: 5 }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, period: undefined }).ok).toBe(false)
  })

  it('rejects non-positive or non-finite amountUsd', () => {
    expect(validateCreateThreshold({ ...valid, amountUsd: 0 }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, amountUsd: -5 }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, amountUsd: Infinity }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, amountUsd: NaN }).ok).toBe(false)
    expect(validateCreateThreshold({ ...valid, amountUsd: '5' }).ok).toBe(false)
  })
})

describe('validateUpdateThreshold', () => {
  it('accepts a partial patch with only period', () => {
    expect(validateUpdateThreshold({ period: 'week' })).toEqual({ ok: true, value: { period: 'week' } })
  })

  it('accepts a partial patch with only amountUsd', () => {
    expect(validateUpdateThreshold({ amountUsd: 10 })).toEqual({ ok: true, value: { amountUsd: 10 } })
  })

  it('accepts multi-field patches', () => {
    const result = validateUpdateThreshold({ period: 'month', amountUsd: 100 })
    expect(result).toEqual({ ok: true, value: { period: 'month', amountUsd: 100 } })
  })

  it('rejects empty patches', () => {
    expect(validateUpdateThreshold({}).ok).toBe(false)
  })

  it('rejects invalid field values in a patch', () => {
    expect(validateUpdateThreshold({ period: 'year' }).ok).toBe(false)
    expect(validateUpdateThreshold({ amountUsd: -1 }).ok).toBe(false)
  })

  it('accepts action in a patch', () => {
    expect(validateUpdateThreshold({ action: 'block' })).toEqual({ ok: true, value: { action: 'block' } })
    expect(validateUpdateThreshold({ action: 'alert' })).toEqual({ ok: true, value: { action: 'alert' } })
  })

  it('rejects invalid action in a patch', () => {
    expect(validateUpdateThreshold({ action: 'halt' }).ok).toBe(false)
    expect(validateUpdateThreshold({ action: 5 }).ok).toBe(false)
  })
})

describe('enrichThresholds', () => {
  const TZ_NY = 'America/New_York'
  const NOW_APR_9 = new Date('2026-04-09T18:00:00Z')

  it('returns an empty array for no thresholds', () => {
    expect(enrichThresholds([], () => 0, NOW_APR_9, TZ_NY)).toEqual([])
  })

  it('decorates each threshold with currentSpend and periodStart', () => {
    const thresholds: UsageThreshold[] = [
      { id: 't1', period: 'day', amountUsd: 5, action: 'alert' },
    ]
    const result = enrichThresholds(thresholds, () => 7.42, NOW_APR_9, TZ_NY)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 't1',
      period: 'day',
      amountUsd: 5,
      action: 'alert',
      currentSpend: 7.42,
      periodStart: '2026-04-09T04:00:00.000Z',
    })
  })

  it('uses the right periodStart per threshold (day/week/month)', () => {
    const seen: Date[] = []
    const thresholds: UsageThreshold[] = [
      { id: 'd', period: 'day', amountUsd: 1, action: 'alert' },
      { id: 'w', period: 'week', amountUsd: 1, action: 'alert' },
      { id: 'm', period: 'month', amountUsd: 1, action: 'alert' },
    ]
    const result = enrichThresholds(thresholds, (since) => { seen.push(since); return 100 }, NOW_APR_9, TZ_NY)
    expect(seen[0]?.toISOString()).toBe('2026-04-09T04:00:00.000Z') // day
    expect(seen[1]?.toISOString()).toBe('2026-04-05T04:00:00.000Z') // week (Sunday)
    expect(seen[2]?.toISOString()).toBe('2026-04-01T04:00:00.000Z') // month
    expect(result.map(r => r.periodStart)).toEqual([
      '2026-04-09T04:00:00.000Z',
      '2026-04-05T04:00:00.000Z',
      '2026-04-01T04:00:00.000Z',
    ])
  })

  it('preserves all original threshold fields in each enriched record', () => {
    const t: UsageThreshold = { id: 'abc', period: 'week', amountUsd: 25, action: 'alert' }
    const result = enrichThresholds([t], () => 12.5, NOW_APR_9, TZ_NY)
    expect(result[0]?.id).toBe('abc')
    expect(result[0]?.period).toBe('week')
    expect(result[0]?.amountUsd).toBe(25)
    expect(result[0]?.action).toBe('alert')
  })
})
