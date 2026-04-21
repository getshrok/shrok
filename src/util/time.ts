/**
 * Time formatting helpers used by every LLM prompt that injects "Current time:".
 *
 * The single source of truth for user-facing time formatting on the SERVER is
 * this module; the dashboard has a parallel browser-side helper in
 * `dashboard/src/lib/formatTime.ts`. Both READ from config.timezone —
 * neither writes.
 *
 * Intentionally untouched:
 *   - src/logger.ts — operator-facing, stays UTC ISO
 *   - src/tracer.ts — machine-parseable, stays UTC ISO
 *   - src/usage-threshold.ts + src/dashboard/routes/usage.ts — already use
 *     config.timezone via src/period.ts for billing-period boundaries
 */

/** Default when the caller passes a falsy or invalid zone — guaranteed to be
 *  a valid IANA name Intl can accept. */
const FALLBACK_ZONE = 'UTC'

/**
 * Format an instant as a human-readable localized string with both the short
 * zone abbreviation (EDT/EST/GMT-4) AND the IANA zone name in parens, e.g.:
 *
 *   `Thursday, April 16, 2026, 1:55 PM EDT (America/New_York)`
 *
 * Used by head + agent + steward + proactive + reminder-decision prompts.
 * The IANA name is included so the agent can shell out `TZ=... date` for bash
 * commands — the abbreviation alone (EDT) is ambiguous.
 *
 * Falls back to UTC on unknown zones (defensive — config.timezone is schema-
 * validated at load but users may hand-edit config.json). Never throws.
 */
export function formatIanaTimeLine(date: Date, tz: string): string {
  const zone = safeZone(tz)
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).formatToParts(date)
    const get = (t: string): string => parts.find(p => p.type === t)?.value ?? ''
    const body = `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}, ` +
      `${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`
    return `${body} (${zone})`
  } catch {
    // Belt-and-suspenders — safeZone() already guarded, but if the host Intl
    // implementation rejects something we didn't anticipate, recurse once
    // with UTC (guaranteed-valid).
    if (zone === FALLBACK_ZONE) return date.toISOString()
    return formatIanaTimeLine(date, FALLBACK_ZONE)
  }
}

/**
 * Format an instant for dashboard/server display (shorter than the LLM line).
 * Returns something like `Jun 15, 1:55 PM EDT` or `13:55 EDT` depending on
 * options. Fallbacks mirror formatIanaTimeLine.
 *
 * Primarily consumed by the server-side dashboard routes and tests; the
 * browser dashboard has its own mirror in `dashboard/src/lib/formatTime.ts`
 * (same name, same shape) to keep bundle size down.
 */
export function formatInTz(
  iso: string | Date,
  tz: string,
  opts: {
    dateStyle?: 'short' | 'medium' | 'long'
    timeStyle?: 'short' | 'medium' | 'long'
    includeZone?: boolean
    style?: 'auto' | 'full'
  } = {},
): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return String(iso)
  const zone = safeZone(tz)
  const includeZone = opts.includeZone ?? true
  try {
    if (opts.style === 'full') {
      const fmt = new Intl.DateTimeFormat([], {
        timeZone: zone,
        dateStyle: opts.dateStyle ?? 'medium',
        timeStyle: opts.timeStyle ?? 'short',
      }).format(d)
      const label = includeZone ? ' ' + getShortZoneLabel(d, zone) : ''
      return fmt + label
    }
    const fmt = new Intl.DateTimeFormat([], {
      timeZone: zone,
      dateStyle: opts.dateStyle ?? 'medium',
      timeStyle: opts.timeStyle ?? 'short',
    }).format(d)
    const label = includeZone ? ' ' + getShortZoneLabel(d, zone) : ''
    return fmt + label
  } catch {
    return d.toISOString()
  }
}

function safeZone(tz: string): string {
  if (!tz) return FALLBACK_ZONE
  try {
    // Throws RangeError on an invalid zone; we catch and downgrade.
    new Intl.DateTimeFormat([], { timeZone: tz })
    return tz
  } catch {
    return FALLBACK_ZONE
  }
}

function getShortZoneLabel(d: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(d)
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}
