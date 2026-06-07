import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { SettingsData } from '../types/api'

/**
 * Hook returning the user-configured IANA timezone.
 *
 * Reuses the `['settings']` queryKey that every page already subscribes to,
 * so this is free — no extra network fetch. During first paint (before
 * /api/settings resolves) we fall back to 'UTC' so the render doesn't fail;
 * the timestamps "jump" once settings load, which is acceptable per the
 * project's UX conventions (one-user-per-install).
 */
export function useConfigTimezone(): string {
  const { data } = useQuery<SettingsData>({ queryKey: ['settings'], queryFn: api.settings.get })
  return data?.timezone || 'UTC'
}

/** Short-zone abbreviation (EDT / EST / GMT-4) for `date` in `tz`. */
function getShortZoneLabel(d: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d)
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}

/**
 * Format a timestamp for dashboard display in the configured tz.
 *
 * Styles:
 *   - `style: 'auto'` (default) — "HH:MM TZ" for same-day; "MMM D HH:MM TZ" otherwise.
 *   - `style: 'full'`  — "MMM D, YYYY, HH:MM TZ" always (used in headers).
 *
 * Options:
 *   - `includeSeconds` — show seconds component (auto-style only).
 *   - `includeZone`    — append the short zone label (default true).
 */
export function formatInTz(
  iso: string | Date,
  tz: string,
  opts: { includeSeconds?: boolean; includeZone?: boolean; style?: 'auto' | 'full' } = {},
): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return String(iso)
  const now = new Date()
  const includeZone = opts.includeZone ?? true
  const label = includeZone ? ' ' + getShortZoneLabel(d, tz) : ''
  try {
    if (opts.style === 'full') {
      return new Intl.DateTimeFormat([], { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d) + label
    }
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    const sameDay = dayFmt.format(d) === dayFmt.format(now)
    if (sameDay) {
      const fmt = new Intl.DateTimeFormat([], {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        ...(opts.includeSeconds ? { second: '2-digit' } : {}),
      }).format(d)
      return fmt + label
    }
    const dateFmt = new Intl.DateTimeFormat([], { timeZone: tz, month: 'short', day: 'numeric' }).format(d)
    const timeFmt = new Intl.DateTimeFormat([], { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d)
    return `${dateFmt} ${timeFmt}${label}`
  } catch {
    return d.toISOString()
  }
}

/**
 * Convert a UTC instant to a `YYYY-MM-DDTHH:MM` wall-clock string in the given
 * IANA timezone, suitable for binding to `<input type="datetime-local">`.
 *
 * Returns `''` when the input is not a valid date, or when `tz` is not a valid
 * IANA timezone.  (This differs from `formatInTz`, which returns `String(iso)`
 * on invalid input — `datetime-local` inputs require a syntactically valid
 * value or an empty string; an arbitrary error message would cause a visible
 * glitch.)
 */
export function toDatetimeLocalInTz(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    const h = get('hour') === '24' ? '00' : get('hour')
    return `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}`
  } catch {
    return ''
  }
}

/**
 * Convert a `YYYY-MM-DDTHH:MM` wall-clock string in the given IANA timezone
 * back to a UTC ISO string (as produced by `Date.prototype.toISOString()`).
 *
 * Returns `''` when `local` is empty, does not match the expected format, or
 * produces an invalid result.
 *
 * **DST caveat:** a wall-clock that lands inside the spring-forward gap or the
 * fall-back overlap can be off by up to one hour.  This is acceptable for this
 * UI — the error window is ~1 hr/year and always in the correct direction.
 */
export function datetimeLocalToUtc(local: string, tz: string): string {
  if (!local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return ''
  try {
    // Interpret the wall-clock as if it were UTC to get a reference instant.
    const asUTC = new Date(local + ':00Z')
    // Determine how far the tz is offset from UTC at that instant via locale strings.
    const tzMs = new Date(asUTC.toLocaleString('en-US', { timeZone: tz })).getTime()
    const utcMs = new Date(asUTC.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
    const offset = tzMs - utcMs
    const result = new Date(asUTC.getTime() - offset)
    if (Number.isNaN(result.getTime())) return ''
    return result.toISOString()
  } catch {
    return ''
  }
}

/** Relative time — tz-independent; kept here so pages import one module. */
export function formatRelTime(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  const past = diff < 0
  if (abs < 60_000) return past ? 'just now' : 'in <1 min'
  const mins = Math.round(abs / 60_000)
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return past ? `${days}d ago` : `in ${days}d`
}
