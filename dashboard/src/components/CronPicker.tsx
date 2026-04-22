import { useState } from 'react'

// Locked shape grammar (D-03). This MUST stay in lockstep with
// src/scheduler/cadence.ts — every string buildCron returns is accepted
// there. No need to import from there (different workspace, different TS
// project); the grammar is the contract.

const ALLOWED_MINUTE_INTERVALS = [5, 10, 15, 30, 45, 60] as const

type MinuteInterval = typeof ALLOWED_MINUTE_INTERVALS[number]

type CadenceType = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTHS   = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'] as const

interface PickerState {
  cadence: CadenceType
  interval: MinuteInterval   // used when cadence === 'minutes'
  minute: number             // 0..59 — used in all non-'minutes' cadences
  hour: number               // 0..23 — used in daily/weekly/monthly/yearly
  dayOfWeek: number          // 0..6 — used in 'weekly'
  dayOfMonth: number         // 1..28 — used in 'monthly' and 'yearly'
  month: number              // 1..12 — used in 'yearly' (1-indexed per cron spec — Pitfall 5)
}

const DEFAULT_STATE: PickerState = {
  cadence: 'daily',
  interval: 30,
  minute: 0,
  hour: 9,
  dayOfWeek: 1,     // Monday
  dayOfMonth: 1,
  month: 1,
}

function parseCronToState(value: string): PickerState {
  const trimmed = value.trim()

  // Shape 1: */N * * * * with N ∈ {5,10,15,30,45,60}
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed)
  if (minutes) {
    const raw = minutes[1]
    const n = raw === undefined ? NaN : parseInt(raw, 10)
    if ((ALLOWED_MINUTE_INTERVALS as readonly number[]).includes(n)) {
      return { ...DEFAULT_STATE, cadence: 'minutes', interval: n as MinuteInterval }
    }
    return DEFAULT_STATE
  }

  // Shape 2: M * * * * (hourly)
  const hourly = /^(\d+) \* \* \* \*$/.exec(trimmed)
  if (hourly) {
    const m = parseInt(hourly[1] ?? '0', 10)
    if (m >= 0 && m <= 59) return { ...DEFAULT_STATE, cadence: 'hourly', minute: m }
    return DEFAULT_STATE
  }

  // Shape 3: M H * * * (daily)
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(trimmed)
  if (daily) {
    const m = parseInt(daily[1] ?? '0', 10)
    const h = parseInt(daily[2] ?? '9', 10)
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23) {
      return { ...DEFAULT_STATE, cadence: 'daily', minute: m, hour: h }
    }
    return DEFAULT_STATE
  }

  // Shape 4: M H * * D (weekly)
  const weekly = /^(\d+) (\d+) \* \* (\d+)$/.exec(trimmed)
  if (weekly) {
    const m = parseInt(weekly[1] ?? '0', 10)
    const h = parseInt(weekly[2] ?? '9', 10)
    const d = parseInt(weekly[3] ?? '1', 10)
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23 && d >= 0 && d <= 6) {
      return { ...DEFAULT_STATE, cadence: 'weekly', minute: m, hour: h, dayOfWeek: d }
    }
    return DEFAULT_STATE
  }

  // Shape 5: M H D * * (monthly)
  const monthly = /^(\d+) (\d+) (\d+) \* \*$/.exec(trimmed)
  if (monthly) {
    const m = parseInt(monthly[1] ?? '0', 10)
    const h = parseInt(monthly[2] ?? '9', 10)
    const dom = parseInt(monthly[3] ?? '1', 10)
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23 && dom >= 1 && dom <= 28) {
      return { ...DEFAULT_STATE, cadence: 'monthly', minute: m, hour: h, dayOfMonth: dom }
    }
    return DEFAULT_STATE
  }

  // Shape 6: M H D Mo * (yearly)
  const yearly = /^(\d+) (\d+) (\d+) (\d+) \*$/.exec(trimmed)
  if (yearly) {
    const m   = parseInt(yearly[1] ?? '0', 10)
    const h   = parseInt(yearly[2] ?? '9', 10)
    const dom = parseInt(yearly[3] ?? '1', 10)
    const mon = parseInt(yearly[4] ?? '1', 10)
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23 && dom >= 1 && dom <= 28 && mon >= 1 && mon <= 12) {
      return { ...DEFAULT_STATE, cadence: 'yearly', minute: m, hour: h, dayOfMonth: dom, month: mon }
    }
    return DEFAULT_STATE
  }

  // Unparseable → silent Daily 09:00 default (D-08)
  return DEFAULT_STATE
}

function buildCron(s: PickerState): string {
  switch (s.cadence) {
    case 'minutes': return `*/${s.interval} * * * *`
    case 'hourly':  return `${s.minute} * * * *`
    case 'daily':   return `${s.minute} ${s.hour} * * *`
    case 'weekly':  return `${s.minute} ${s.hour} * * ${s.dayOfWeek}`
    case 'monthly': return `${s.minute} ${s.hour} ${s.dayOfMonth} * *`
    case 'yearly':  return `${s.minute} ${s.hour} ${s.dayOfMonth} ${s.month} *`
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatHuman(s: PickerState): string {
  switch (s.cadence) {
    case 'minutes': return `Every ${s.interval} minutes`
    case 'hourly':  return `Every hour at minute ${s.minute}`
    case 'daily':   return `Every day at ${pad(s.hour)}:${pad(s.minute)}`
    case 'weekly':  return `Every ${WEEKDAYS[s.dayOfWeek] ?? 'Monday'} at ${pad(s.hour)}:${pad(s.minute)}`
    case 'monthly': return `Every month on day ${s.dayOfMonth} at ${pad(s.hour)}:${pad(s.minute)}`
    case 'yearly':  return `Every year in ${MONTHS[s.month - 1] ?? 'January'} on day ${s.dayOfMonth} at ${pad(s.hour)}:${pad(s.minute)}`
  }
}

// Reusable Tailwind tokens — mirrors the existing SchedulesPage.tsx form control pattern.
const SELECT_CLASS = 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-600 outline-none'
const LABEL_CLASS  = 'text-xs text-zinc-500 mb-1 block'

export interface CronPickerProps {
  value: string
  onChange: (cron: string) => void
}

export default function CronPicker({ value, onChange }: CronPickerProps) {
  // D-09 / Pitfall 1: parse once via useState initializer; NEVER call onChange on mount.
  const [state, setState] = useState<PickerState>(() => parseCronToState(value))

  function update(patch: Partial<PickerState>) {
    const next = { ...state, ...patch }
    setState(next)
    onChange(buildCron(next))
  }

  function handleCadenceChange(cadence: CadenceType) {
    // When switching cadence, keep hour/minute/etc but normalize defaults
    // so the emitted cron is always valid (e.g. switching to 'minutes'
    // picks a safe interval instead of keeping a stale garbage value).
    if (cadence === 'minutes') {
      update({ cadence, interval: 30 })
    } else if (cadence === 'weekly') {
      update({ cadence, hour: state.hour, minute: state.minute, dayOfWeek: state.dayOfWeek })
    } else {
      update({ cadence })
    }
  }

  // Pitfall 6: <input type="time"> returns "HH:MM"; both parts must be null-checked.
  function handleTimeChange(timeStr: string) {
    const [hh, mm] = timeStr.split(':')
    const h = parseInt(hh ?? '9', 10)
    const m = parseInt(mm ?? '0', 10)
    if (Number.isFinite(h) && h >= 0 && h <= 23 && Number.isFinite(m) && m >= 0 && m <= 59) {
      update({ hour: h, minute: m })
    }
  }

  return (
    <div className="w-full max-w-sm">
      <label className={LABEL_CLASS}>Frequency</label>
      <select
        aria-label="Frequency"
        value={state.cadence}
        onChange={e => handleCadenceChange(e.target.value as CadenceType)}
        className={SELECT_CLASS}
      >
        <option value="minutes">Every N minutes</option>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>

      <div className="space-y-2 mt-2">
        {state.cadence === 'minutes' && (
          <div>
            <label className={LABEL_CLASS}>Every</label>
            <select
              aria-label="Minute interval"
              value={state.interval}
              onChange={e => update({ interval: parseInt(e.target.value, 10) as MinuteInterval })}
              className={SELECT_CLASS}
            >
              {ALLOWED_MINUTE_INTERVALS.map(n => (
                <option key={n} value={n}>{n} minutes</option>
              ))}
            </select>
          </div>
        )}

        {state.cadence === 'hourly' && (
          <div>
            <label className={LABEL_CLASS}>At minute</label>
            <select
              aria-label="Minute of hour"
              value={state.minute}
              onChange={e => update({ minute: parseInt(e.target.value, 10) })}
              className={SELECT_CLASS}
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>{pad(m)}</option>
              ))}
            </select>
          </div>
        )}

        {(state.cadence === 'daily' || state.cadence === 'weekly'
          || state.cadence === 'monthly' || state.cadence === 'yearly') && (
          <div>
            <label className={LABEL_CLASS}>At</label>
            <input
              type="time"
              aria-label="Time of day"
              value={`${pad(state.hour)}:${pad(state.minute)}`}
              onChange={e => handleTimeChange(e.target.value)}
              className={SELECT_CLASS}
            />
          </div>
        )}

        {state.cadence === 'weekly' && (
          <div>
            <label className={LABEL_CLASS}>On</label>
            <select
              aria-label="Day of week"
              value={state.dayOfWeek}
              onChange={e => update({ dayOfWeek: parseInt(e.target.value, 10) })}
              className={SELECT_CLASS}
            >
              {WEEKDAYS.map((name, idx) => (
                <option key={idx} value={idx}>{name}</option>
              ))}
            </select>
          </div>
        )}

        {(state.cadence === 'monthly' || state.cadence === 'yearly') && (
          <div>
            <label className={LABEL_CLASS}>On day</label>
            <select
              aria-label="Day of month"
              value={state.dayOfMonth}
              onChange={e => update({ dayOfMonth: parseInt(e.target.value, 10) })}
              className={SELECT_CLASS}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        )}

        {state.cadence === 'yearly' && (
          <div>
            <label className={LABEL_CLASS}>In</label>
            <select
              aria-label="Month"
              value={state.month}
              onChange={e => update({ month: parseInt(e.target.value, 10) })}
              className={SELECT_CLASS}
            >
              {MONTHS.map((name, idx) => (
                <option key={idx + 1} value={idx + 1}>{name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="text-xs text-zinc-500 mt-0.5">{formatHuman(state)}</div>
    </div>
  )
}
