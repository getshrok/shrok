/** Period helpers for usage windows. All functions accept an IANA timezone
 *  identifier (e.g. 'America/New_York') and return UTC `Date` instants
 *  corresponding to local-time boundaries in that zone.
 *
 *  "Week" starts on Sunday (US convention). "Month" starts on the 1st.
 *  DST and zone offsets are handled correctly via offset lookup at the
 *  *target* instant — exact across spring-forward and fall-back days.
 */

export type Period = 'day' | 'week' | 'month'

/** Local calendar date in `tz` as 'YYYY-MM-DD' for the given instant.
 *  'en-CA' is the locale that formats as ISO YYYY-MM-DD.
 *  Builds a fresh Intl.DateTimeFormat each call — fine for one-shot use
 *  (e.g. inside `dayStartUtc`, called once per query). For batch formatting
 *  inside loops, use `makeLocalYmdFormatter(tz)` instead. */
export function localYmd(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Returns a closure that formats UTC instants as 'YYYY-MM-DD' in `tz`.
 *  Use this when formatting many dates with the same timezone — Intl.DateTimeFormat
 *  construction is expensive (10–100µs each), so build the formatter once and reuse.
 *  For one-off formatting, prefer `localYmd(tz, now)`. */
export function makeLocalYmdFormatter(tz: string): (d: Date) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return (d: Date) => fmt.format(d)
}

/** Format a UTC `Date` as 'YYYY-MM-DD' using its UTC components. */
function dateToYmd(d: Date): string {
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`
}

/** UTC instant of local midnight on the given calendar date in `tz`.
 *  Strategy: guess UTC midnight on that date, read what wall time the guess
 *  produces in `tz`, then apply the difference as a single correction. The
 *  offset at the guess equals the offset at the target (midnight) because
 *  midnight is always far from DST cliffs in real zones — one iteration
 *  suffices. */
function ymdToUtc(tz: string, ymd: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess)
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const guessLocalMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  const desiredMs = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)))
  return new Date(guess.getTime() + (desiredMs - guessLocalMs))
}

/** UTC instant of local midnight on the calendar day containing `now` in `tz`. */
export function dayStartUtc(tz: string, now: Date = new Date()): Date {
  return ymdToUtc(tz, localYmd(tz, now))
}

/** UTC instant of the start of the current period in `tz`.
 *  - 'day'   → today's local midnight
 *  - 'week'  → most recent Sunday's local midnight (US convention)
 *  - 'month' → the 1st of this month at local midnight */
export function periodStart(tz: string, period: Period, now: Date = new Date()): Date {
  if (period === 'day') return dayStartUtc(tz, now)

  const ymd = localYmd(tz, now)
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  const d = Number(ymd.slice(8, 10))

  if (period === 'month') {
    return ymdToUtc(tz, `${ymd.slice(0, 8)}01`)
  }

  // period === 'week' — find local weekday and walk back to Sunday
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short',
  }).format(now)
  const SUN: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const stepsBack = SUN[weekday]!
  if (stepsBack === 0) return dayStartUtc(tz, now)

  // Calendar arithmetic on (Y, M, D) — Date.UTC handles month/year rollovers.
  const target = new Date(Date.UTC(y, m - 1, d - stepsBack))
  return ymdToUtc(tz, dateToYmd(target))
}

/** UTC instant of local midnight `n` days before today in `tz`.
 *  `daysAgoStart(tz, 0)` = today's local midnight (same as `dayStartUtc`).
 *  `daysAgoStart(tz, 6)` = start of the local day 6 days ago — useful for
 *  rolling-7-day windows (today + 6 prior days).
 *  Calendar arithmetic on (Y, M, D); exact across DST. */
export function daysAgoStart(tz: string, n: number, now: Date = new Date()): Date {
  if (n === 0) return dayStartUtc(tz, now)
  const ymd = localYmd(tz, now)
  const target = new Date(Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)) - n,
  ))
  return ymdToUtc(tz, dateToYmd(target))
}
