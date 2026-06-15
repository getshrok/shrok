/** A dashboard login identity: a display name plus an optional head it scopes to. */
export interface DashboardUser {
  name: string
  headId?: string
}

/** Coerce a raw config.json `dashboardUsers` value into clean DashboardUser objects.
 *  Tolerates legacy bare-string entries, trims names, and drops malformed/blank ones.
 *  Read-time only — does NOT dedupe (the settings PUT owns write-time normalization). */
export function normalizeDashboardUsers(raw: unknown): DashboardUser[] {
  if (!Array.isArray(raw)) return []
  const out: DashboardUser[] = []
  for (const u of raw) {
    if (typeof u === 'string') {
      const name = u.trim()
      if (name) out.push({ name })
    } else if (u && typeof u === 'object' && typeof (u as { name?: unknown }).name === 'string') {
      const o = u as { name: string; headId?: unknown }
      const name = o.name.trim()
      if (!name) continue
      const headId = typeof o.headId === 'string' ? o.headId.trim() : ''
      out.push(headId ? { name, headId } : { name })
    }
  }
  return out
}
