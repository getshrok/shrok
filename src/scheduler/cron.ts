import { CronExpressionParser } from 'cron-parser'
import cronstrue from 'cronstrue'

/**
 * Returns the next Date that the cron expression will fire after `after`,
 * interpreted in the supplied IANA timezone (`tz`). A cron like `0 9 * * *`
 * in `'America/New_York'` fires at 09:00 local (EDT/EST depending on date),
 * NOT 09:00 UTC.
 *
 * Passing `tz: 'UTC'` produces results byte-equivalent to the pre-plan
 * behavior (cron-parser treats a missing `tz` as UTC).
 *
 * `tz` is a required string. Falsy values fall back to 'UTC' defensively —
 * the caller should always pass a validated zone (see src/config.ts where
 * `timezone` is schema-coerced to a non-empty string).
 *
 * Throws if the expression is invalid or the tz is not a valid IANA zone.
 */
export function nextRunAfter(expression: string, after: Date, tz: string): Date {
  const parsed = CronExpressionParser.parse(expression, {
    currentDate: after,
    tz: tz || 'UTC',
  })
  return parsed.next().toDate()
}

/**
 * Convert a cron expression to human-readable English.
 * Uses cronstrue for robust parsing of all cron syntax.
 */
export function describeCron(expression: string): string {
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: false })
  } catch {
    return `cron: ${expression}`
  }
}
