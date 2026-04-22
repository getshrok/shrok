/**
 * Validates whether a cron expression matches one of the six supported cadence
 * shapes (D-03). The UI picker only produces these shapes, and both the REST
 * API (`src/dashboard/routes/schedules.ts`) and agent tools
 * (`src/sub-agents/registry.ts`) gate on this function so the system never
 * accepts complex cron expressions. Agents are pointed to the `conditions`
 * argument for nuance (D-05).
 *
 * Supported shapes (all others rejected):
 *   1. every N minutes:  * /N * * * *     N ∈ {5, 10, 15, 30, 45, 60}
 *   2. hourly:           M * * * *        M ∈ 0..59
 *   3. daily:            M H * * *        M ∈ 0..59, H ∈ 0..23
 *   4. weekly:           M H * * D        D ∈ 0..6
 *   5. monthly:          M H D * *        D ∈ 1..28
 *   6. yearly:           M H D Mo *       Mo ∈ 1..12, D ∈ 1..28
 */

const ALLOWED_MINUTE_INTERVALS = new Set([5, 10, 15, 30, 45, 60])

function isIntInRange(token: string, min: number, max: number): boolean {
  // Reject empty, negative, leading-plus, decimals, and non-digit tokens.
  if (!/^\d+$/.test(token)) return false
  const n = parseInt(token, 10)
  return Number.isFinite(n) && n >= min && n <= max
}

export function isValidCadence(cron: string): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]

  // Shape 1: every N minutes — */N * * * *
  const minutesMatch = /^\*\/(\d+)$/.exec(min)
  if (minutesMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(minutesMatch[1]!, 10)
    return ALLOWED_MINUTE_INTERVALS.has(n)
  }

  // All remaining shapes require a literal numeric minute in 0..59
  if (!isIntInRange(min, 0, 59)) return false

  // Shape 2: hourly — M * * * *
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') return true

  // Shapes 3–6 require a literal numeric hour in 0..23
  if (!isIntInRange(hour, 0, 23)) return false

  // Shape 3: daily — M H * * *
  if (dom === '*' && mon === '*' && dow === '*') return true

  // Shape 4: weekly — M H * * D  (D ∈ 0..6)
  if (dom === '*' && mon === '*' && dow !== '*') {
    return isIntInRange(dow, 0, 6)
  }

  // Shapes 5 & 6 require dow === '*' and dom ∈ 1..28
  if (dow !== '*') return false
  if (!isIntInRange(dom, 1, 28)) return false

  // Shape 5: monthly — M H D * *
  if (mon === '*') return true

  // Shape 6: yearly — M H D Mo *
  return isIntInRange(mon, 1, 12)
}

export const CADENCE_ERROR_MESSAGE =
  'Invalid cron frequency. Supported cadences: every N minutes (*/N * * * *), hourly, daily, weekly, monthly, yearly. For custom timing logic (e.g. weekdays only, skip holidays), use the conditions argument instead of a custom cron expression.'
