/**
 * Model-facing time helpers — the single chokepoint for all LLM↔time boundaries.
 *
 * Invariant: no model-facing surface in shrok ever shows or accepts a UTC instant.
 * All model-facing times are workspace-local in `YYYY-MM-DD HH:MM` format (24-hour,
 * no `Z`, no offset, no IANA suffix in the value).
 *
 * Internal storage stays ISO UTC.  Rendering and parsing happen at every tool boundary.
 *
 * Closes GitHub issue #18.
 */

/** Default when the caller passes a falsy or invalid zone. */
const FALLBACK_ZONE = 'UTC'

/** Mirror of the private safeZone in src/util/time.ts — defensive try/catch around
 *  Intl validation, fallback to 'UTC'. Not exported (internal to this module). */
function safeZone(tz: string): string {
  if (!tz) return FALLBACK_ZONE
  try {
    // Throws RangeError on an invalid zone.
    new Intl.DateTimeFormat([], { timeZone: tz })
    return tz
  } catch {
    return FALLBACK_ZONE
  }
}

/**
 * Format a Date as the canonical workspace-local string `YYYY-MM-DD HH:MM` (24-hour).
 *
 * - Falsy or invalid `tz` falls back to `UTC`. Never throws.
 * - The `hour12:false` host bug where some environments emit `"24"` for midnight
 *   is handled by normalising `"24"` → `"00"`.
 */
export function formatModelTime(date: Date, tz: string): string {
  const zone = safeZone(tz)
  try {
    const parts = new Intl.DateTimeFormat([], {
      timeZone: zone,
      year:    'numeric',
      month:   '2-digit',
      day:     '2-digit',
      hour:    '2-digit',
      minute:  '2-digit',
      hour12:  false,
    }).formatToParts(date)

    const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '00'
    const y   = get('year')
    const mo  = get('month')
    const d   = get('day')
    let h     = get('hour')
    const min = get('minute')

    // Some Node/Intl implementations emit "24" for midnight with hour12:false.
    if (h === '24') h = '00'

    return `${y}-${mo}-${d} ${h}:${min}`
  } catch {
    // Belt-and-suspenders: safeZone guards first, but if the Intl call somehow
    // still fails with the validated zone, recurse once with UTC.
    if (zone === FALLBACK_ZONE) {
      return date.toISOString().slice(0, 16).replace('T', ' ')
    }
    return formatModelTime(date, FALLBACK_ZONE)
  }
}

/**
 * Parse a workspace-local datetime string in canonical `YYYY-MM-DD HH:MM` format
 * (also accepts `YYYY-MM-DD HH:MM:SS` and `YYYY-MM-DDTHH:MM[:SS]`) and return a Date.
 *
 * **DST handling:**
 * - Spring-forward gap (e.g. `America/New_York` `2026-03-08 02:30`): the local clock
 *   skips 02:00→03:00, so 02:30 does not exist. Throws with a message naming the gap.
 * - Fall-back ambiguous (e.g. `America/New_York` `2026-11-01 01:30`): the local clock
 *   repeats 01:00→02:00 twice. This function returns the **FIRST occurrence** (i.e. the
 *   earlier UTC instant, before the offset shift — the EDT/summer offset applies).
 *
 * **Rejects** (throws Error) any input that:
 * - Does not match `^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$`
 * - Contains `Z` (case-insensitive)
 * - Contains a UTC offset token (`+HH:MM` or `-HH:MM` at the end)
 * - Contains a trailing alphabetic token (e.g. ` EDT`, ` America/New_York`)
 */
export function parseModelTime(s: string, tz: string): Date {
  // ── Step 1: pre-flight rejections ──────────────────────────────────────────

  // Reject Z-suffix
  if (/Z/i.test(s)) {
    throw new Error(
      `Expected format YYYY-MM-DD HH:MM (workspace-local), but got "${s}". ` +
      `Do not include a Z suffix — supply the time in the workspace timezone.`,
    )
  }

  // Reject UTC offset (+HH:MM or -HH:MM at end of string)
  if (/[+\-]\d{2}:?\d{2}$/.test(s)) {
    throw new Error(
      `Expected format YYYY-MM-DD HH:MM (workspace-local), but got "${s}". ` +
      `Do not include a UTC offset — supply the time in the workspace timezone.`,
    )
  }

  // Reject trailing alphabetic tokens (e.g. " EDT", " America/New_York")
  if (/\s+[A-Za-z]/.test(s)) {
    throw new Error(
      `Expected format YYYY-MM-DD HH:MM (workspace-local), but got "${s}". ` +
      `Do not include a timezone abbreviation or name — supply the time in the workspace timezone.`,
    )
  }

  // Match the canonical format
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!match) {
    throw new Error(
      `Expected format YYYY-MM-DD HH:MM (workspace-local, 24-hour), but got "${s}".`,
    )
  }

  const yearStr  = match[1]
  const moStr    = match[2]
  const dayStr   = match[3]
  const hourStr  = match[4]
  const minStr   = match[5]
  const secStr   = match[6]

  if (!yearStr || !moStr || !dayStr || !hourStr || !minStr) {
    throw new Error(`Expected format YYYY-MM-DD HH:MM (workspace-local, 24-hour), but got "${s}".`)
  }

  const year = parseInt(yearStr, 10)
  const mo   = parseInt(moStr, 10)
  const day  = parseInt(dayStr, 10)
  const hour = parseInt(hourStr, 10)
  const min  = parseInt(minStr, 10)
  const sec  = secStr !== undefined ? parseInt(secStr, 10) : 0

  // ── Step 2: resolve local → UTC ────────────────────────────────────────────
  //
  // Algorithm:
  //   1. Construct a candidate UTC instant as if the input *were* a UTC time.
  //   2. Determine what offset `tz` applies at that UTC instant.
  //   3. Subtract that offset to get the true UTC instant for "this local time in tz".
  //
  // This naturally selects the FIRST occurrence on fall-back ambiguous times because
  // step 2 computes the offset that was in effect BEFORE the clock fell back (the
  // earlier/summer offset), and subtracting it gives the earlier UTC instant.

  const zone = safeZone(tz)

  // Candidate: treat the input as UTC (i.e. assume offset = 0 initially)
  const candidate = new Date(Date.UTC(year, mo - 1, day, hour, min, sec))

  // Determine offset at the candidate UTC instant
  const offsetMinutes = getOffsetMinutes(candidate, zone)

  // Shift: subtract the offset to get the true UTC instant
  const utcMs = candidate.getTime() - offsetMinutes * 60_000
  const result = new Date(utcMs)

  // ── Step 3: round-trip verification (spring-forward gap detection) ─────────
  //
  // If the result re-formats to a different YYYY-MM-DD HH:MM in the same zone,
  // the input named a non-existent local time (it fell in the spring-forward gap).

  const formatted = formatModelTime(result, zone)
  const inputSlice = s.slice(0, 16).replace('T', ' ')
  if (formatted !== inputSlice) {
    throw new Error(
      `"${inputSlice}" does not exist in ${zone}: the clock skips this time during the ` +
      `spring-forward DST gap. Pick the next valid time (e.g. "${formatted}") or a time ` +
      `before the gap.`,
    )
  }

  return result
}

/**
 * Returns the UTC offset in minutes that `zone` applies at `utcInstant`.
 *
 * For UTC+5:30, returns +330.
 * For UTC-5, returns -300.
 *
 * Implementation: we extract the wall-clock time in `zone` for `utcInstant`,
 * then compare it to the UTC time of the same instant.
 */
function getOffsetMinutes(utcInstant: Date, zone: string): number {
  // Get the local year/month/day/hour/min/sec in `zone` for this UTC instant
  const parts = new Intl.DateTimeFormat([], {
    timeZone: zone,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  }).formatToParts(utcInstant)

  const get = (type: string): number => {
    const raw = parts.find(p => p.type === type)?.value ?? '0'
    const n = parseInt(raw, 10)
    return isNaN(n) ? 0 : n
  }

  const ly = get('year')
  const lm = get('month')
  const ld = get('day')
  let lh = get('hour')
  const lmin = get('minute')
  const ls = get('second')

  // Some Node/Intl implementations emit "24" for midnight with hour12:false.
  // Normalise ONLY the hour — applying this to minute/second would clobber a
  // legitimate value of 24 (e.g. minute=24) to 0 and skew the computed offset.
  if (lh === 24) lh = 0

  // Build the "local time treated as UTC"
  const localAsUtcMs = Date.UTC(ly, lm - 1, ld, lh, lmin, ls)

  // offset = localAsUtc − actualUtc (in minutes)
  return Math.round((localAsUtcMs - utcInstant.getTime()) / 60_000)
}

/**
 * Format a past-time guard error message for model consumption.
 *
 * Returns a single line containing:
 * - The parsed time in canonical format (in `tz`)
 * - The workspace now in canonical format (in `tz`)
 * - The IANA zone name
 * - The literal phrase "pick a time in the future"
 */
export function formatPastTimeError(parsed: Date, now: Date, tz: string): string {
  const parsedFmt = formatModelTime(parsed, tz)
  const nowFmt    = formatModelTime(now, tz)
  return (
    `Parsed time "${parsedFmt}" is in the past ` +
    `(workspace now is "${nowFmt}" in ${tz}). ` +
    `Pick a time in the future and retry.`
  )
}
