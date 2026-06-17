/**
 * Concise, deterministic natural-language rendering of a schedule's timing, for
 * the head's system-prompt awareness block (see ContextAssemblerImpl). NO LLM is
 * involved — a model paraphrasing a cron could silently get it wrong and the head
 * reading the block would have no way to know, so every conversion here is pure code.
 *
 * Two independent pieces:
 *   1. The "next fire" anchor comes straight from the schedule's stored `nextRun`
 *      (an exact instant the scheduler itself computed) — just relabeled relative
 *      to `now` (today / tomorrow / `Mon D`).
 *   2. The cadence phrase ("daily 09:00", "Mondays 08:00") is classified from the
 *      cron's SHAPE. The `create_*` tools gate every cron through `isValidCadence`
 *      (src/scheduler/cadence.ts), so a stored cron is always one of exactly 8
 *      shapes — this is a closed lookup, not a general cron parser. The clock shown
 *      is read from `nextRun` (rendered in the schedule's tz), never invented from
 *      the cron fields. Anything that does NOT match the 8 shapes (e.g. a
 *      hand-edited JSON file that bypassed validation) falls back to `describeCron`.
 *
 * Times are readable-relative and tz-aware — no UTC ever leaks. This is a
 * deliberate, isolated softening of shrok's canonical `YYYY-MM-DD HH:MM`
 * model-time format, acceptable because this is a system-prompt awareness surface,
 * not a tool I/O boundary (where the invariant stays strict).
 */
import type { Schedule } from '../db/schedules.js'
import { describeCron } from './cron.js'

const FALLBACK_ZONE = 'UTC'
const REMINDER_TEXT_MAX = 160

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function safeZone(tz: string): string {
  if (!tz) return FALLBACK_ZONE
  try {
    new Intl.DateTimeFormat([], { timeZone: tz })
    return tz
  } catch {
    return FALLBACK_ZONE
  }
}

interface LocalParts {
  year: number
  month: number // 1–12
  day: number // 1–31
  hour: number // 0–23
  minute: number // 0–59
}

/** Decompose an instant into its wall-clock parts in the given IANA zone. */
function localParts(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string): number => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10)
  let hour = get('hour')
  if (hour === 24) hour = 0 // some Intl impls emit "24" for midnight under hour12:false
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') }
}

/** `HH:MM` wall-clock (24h) of an instant in the given zone. */
function clockStr(date: Date, tz: string): string {
  const { hour, minute } = localParts(date, tz)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Difference in LOCAL calendar days (in `tz`) between `date` and `now`. */
function calendarDayDelta(date: Date, now: Date, tz: string): number {
  const a = localParts(date, tz)
  const b = localParts(now, tz)
  const dayA = Date.UTC(a.year, a.month - 1, a.day)
  const dayB = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((dayA - dayB) / 86_400_000)
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/**
 * Relative day anchor for a future instant: `today` / `tomorrow` / `Mon D`.
 * `withClock` appends ` HH:MM` (used for one-time + sub-daily cadences whose
 * cadence phrase carries no clock of its own).
 */
export function describeAnchor(date: Date, now: Date, tz: string, withClock: boolean): string {
  const delta = calendarDayDelta(date, now, tz)
  let base: string
  if (delta === 0) base = 'today'
  else if (delta === 1) base = 'tomorrow'
  else {
    const p = localParts(date, tz)
    base = `${MONTHS[p.month - 1]} ${p.day}`
  }
  return withClock ? `${base} ${clockStr(date, tz)}` : base
}

interface Cadence {
  phrase: string
  /** True when `phrase` already contains the clock (daily-and-slower) → the anchor
   *  is rendered day-only; false (sub-daily) → the anchor carries the clock. */
  clockInPhrase: boolean
}

/**
 * Classify a cron into a concise cadence phrase. Mirrors the 8 shapes enforced by
 * `isValidCadence`. Returns null for anything outside that closed set so the caller
 * can fall back to `describeCron`. `clock` is the `HH:MM` already derived from
 * `nextRun` in the target zone.
 */
function classifyCadence(cron: string, clock: string): Cadence | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
  const isNum = (s: string): boolean => /^\d+$/.test(s)

  // Shape 1: every N minutes — */N * * * *
  const minutesMatch = /^\*\/(\d+)$/.exec(min)
  if (minutesMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { phrase: `every ${minutesMatch[1]} min`, clockInPhrase: false }
  }

  // Shape 6: every N days — 0 H */N * *
  const everyNDaysMatch = /^\*\/(\d+)$/.exec(dom)
  if (min === '0' && everyNDaysMatch && mon === '*' && dow === '*') {
    return { phrase: `every ${everyNDaysMatch[1]} days ${clock}`, clockInPhrase: true }
  }

  // Shape 2: hourly — M * * * *
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { phrase: `hourly at :${min.padStart(2, '0')}`, clockInPhrase: false }
  }

  // Shape 3: daily — M H * * *
  if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '*') {
    return { phrase: `daily ${clock}`, clockInPhrase: true }
  }

  // Shape 4: weekdays Mon–Fri — M H * * 1-5
  if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    return { phrase: `weekdays ${clock}`, clockInPhrase: true }
  }

  // Shape 5: weekly — M H * * D  (D 0=Sun…6=Sat)
  if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && isNum(dow)) {
    const d = parseInt(dow, 10)
    if (d >= 0 && d <= 6) return { phrase: `${WEEKDAYS[d]}s ${clock}`, clockInPhrase: true }
  }

  // Shape 7: monthly — M H D * *
  if (isNum(min) && isNum(hour) && isNum(dom) && mon === '*' && dow === '*') {
    return { phrase: `monthly on the ${ordinal(parseInt(dom, 10))} ${clock}`, clockInPhrase: true }
  }

  // Shape 8: yearly — M H D Mo *
  if (isNum(min) && isNum(hour) && isNum(dom) && isNum(mon) && dow === '*') {
    return { phrase: `yearly ${clock}`, clockInPhrase: true }
  }

  return null
}

/** The full "when" string for a recurring schedule: `{cadence}, next {anchor}`. */
export function describeRecurringWhen(cron: string, nextRun: Date, now: Date, tz: string): string {
  const clock = clockStr(nextRun, tz)
  const cadence = classifyCadence(cron, clock)
  if (!cadence) {
    // Non-canonical cron (e.g. hand-edited file) — degrade gracefully via cronstrue.
    return `${describeCron(cron)}, next ${describeAnchor(nextRun, now, tz, true)}`
  }
  return `${cadence.phrase}, next ${describeAnchor(nextRun, now, tz, cadence.clockInPhrase === false)}`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

/**
 * Render one schedule as a single awareness-block line:
 *   `- {Reminder|Task} · {when} — {label}{ (needs ack)}`
 *
 * Callers pass the schedule's EFFECTIVE zone (`cronTimezone ?? workspace tz`) so the
 * rendered clock matches the zone the scheduler used to compute `nextRun`.
 */
export function describeScheduleLine(schedule: Schedule, now: Date, tz: string): string {
  const kind = schedule.kind === 'reminder' ? 'Reminder' : 'Task'

  const nextRun = schedule.nextRun ? new Date(schedule.nextRun) : null
  const validNext = nextRun && !Number.isNaN(nextRun.getTime()) ? nextRun : null

  let when: string
  if (validNext && schedule.cron) {
    when = describeRecurringWhen(schedule.cron, validNext, now, tz)
  } else if (validNext) {
    // One-time (or a cron-less row) — just the anchor, with clock.
    when = describeAnchor(validNext, now, tz, true)
  } else {
    when = 'pending' // defensive; the assembler filters out nextRun == null
  }

  const label = schedule.kind === 'reminder'
    ? truncate(((schedule.agentContext ?? '').trim() || '(reminder)'), REMINDER_TEXT_MAX)
    : (schedule.taskName ?? '(task)').trim()

  const flag = schedule.kind === 'reminder' && schedule.requiresAck ? '  (needs ack)' : ''

  return `- ${kind} · ${when} — ${label}${flag}`
}
