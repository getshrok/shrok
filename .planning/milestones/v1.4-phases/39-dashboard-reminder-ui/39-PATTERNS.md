# Phase 39: Dashboard Reminder UI - Pattern Map

**Mapped:** 2026-05-23
**Files analyzed:** 6 new/modified files
**Analogs found:** 6 / 6 (all files have strong role+data-flow matches in the codebase)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `dashboard/src/types/api.ts` (Schedule interface) | type/model | — | `src/db/schedules.ts` Schedule interface | exact (backend type is the ground truth) |
| `dashboard/src/lib/api.ts` (schedules.create/update) | client/service | request-response | `dashboard/src/lib/api.ts` usageThresholds.update | role-match (same file, same pattern) |
| `dashboard/src/pages/SchedulesPage.tsx` (ReminderRow, AddReminderForm, AddScheduleForm, edit modals) | component | request-response | `dashboard/src/pages/SchedulesPage.tsx` existing components | exact (same file — extend in-place) |
| `src/dashboard/routes/schedules.ts` (POST + PATCH handlers) | route/controller | request-response | `src/dashboard/routes/schedules.ts` existing handlers | exact (same file — extend in-place) |
| `src/db/schedules.ts` (SchedulePatch + update()) | model/store | CRUD | `src/db/schedules.ts` existing SchedulePatch/update() | exact (same file — extend in-place) |
| `src/sub-agents/registry.ts` (floor 5→1 correction) | utility/config | — | `src/sub-agents/registry.ts` nag validation block | exact (same file — targeted line edits) |

---

## Pattern Assignments

### `dashboard/src/types/api.ts` — Schedule interface (type/model)

**Analog:** `src/db/schedules.ts` lines 3–26 (backend Schedule interface — ground truth)

**Problem (F-01):** The frontend Schedule interface at lines 252–266 is missing three fields that the backend type carries and the GET response already returns. Must be added before any component work to avoid TSC errors.

**Backend Schedule interface** (lines 3–26 of `src/db/schedules.ts`):
```typescript
export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder'
  cron: string | null
  runAt: string | null
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  lastSkipped: string | null
  lastSkipReason: string | null
  conditions: string | null
  agentContext: string | null
  cronTimezone: string | null
  requiresAck: boolean           // ← ADD to frontend type
  nagIntervalMinutes: number | null  // ← ADD to frontend type
  ackPending: boolean            // ← ADD to frontend type
  createdAt: string
  updatedAt: string
}
```

**Current frontend Schedule interface** (lines 252–266 of `dashboard/src/types/api.ts`):
```typescript
export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder'
  cron: string | null
  runAt: string | null
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  conditions: string | null
  agentContext: string | null
  createdAt: string
  updatedAt: string
  // MISSING: requiresAck, nagIntervalMinutes, ackPending
}
```

**What to add** — insert after `agentContext`:
```typescript
  requiresAck: boolean
  nagIntervalMinutes: number | null
  ackPending: boolean
```

---

### `dashboard/src/lib/api.ts` — schedules.create / schedules.update (client/service)

**Analog:** `dashboard/src/lib/api.ts` lines 264–281 (same block — extend the two signatures)

**Current signatures** (lines 264–281):
```typescript
schedules: {
  list: () =>
    request<{ schedules: Schedule[] }>('/api/schedules'),
  create: (body: { headId: string; taskName?: string; kind?: 'task' | 'reminder'; cron?: string; runAt?: string; conditions?: string; agentContext?: string }) =>
    request<{ schedule: Schedule }>('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  update: (id: string, patch: { enabled?: boolean; cron?: string; runAt?: string; conditions?: string; agentContext?: string }) =>
    request<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
},
```

**What changes:**
- `create` body type: add `requiresAck?: boolean; nagIntervalMinutes?: number; startAt?: string`
- `update` patch type: add `requiresAck?: boolean; nagIntervalMinutes?: number | null`

**Pattern for optional field extension** (from `api.ts` lines 255–260, usageThresholds.update):
```typescript
update: (id: string, patch: { period?: 'day' | 'week' | 'month'; amountUsd?: number; action?: 'alert' | 'block' }) =>
  request<{ threshold: UsageThreshold }>(`/api/usage/thresholds/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }),
```
The pattern is: add optional typed fields to the inline object literal; the `body: JSON.stringify(patch)` call passes them through without any filtering — undefined fields are dropped by JSON.stringify automatically.

---

### `dashboard/src/pages/SchedulesPage.tsx` — ReminderRow (component, request-response)

**Analog:** `dashboard/src/pages/SchedulesPage.tsx` lines 447–624 (same component — extend in-place)

**Toggle pattern** (lines 527–538) — reuse for `requiresAck` toggle in edit modal:
```tsx
<button
  onClick={() => toggleMutation.mutate(!schedule.enabled)}
  disabled={toggleMutation.isPending}
  title={schedule.enabled ? 'Disable' : 'Enable'}
  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
    schedule.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
  } disabled:opacity-50`}
>
  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
    schedule.enabled ? 'translate-x-[18px]' : 'translate-x-0'
  }`} />
</button>
```
For the `requiresAck` toggle, replace `toggleMutation.mutate(!schedule.enabled)` with `setEditRequiresAck(v => !v)` (local state, no mutation on toggle — only sent on Save).

**Head badge pattern** (lines 514–521) — visual template for the NAGS badge (D-05):
```tsx
<span
  className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-full"
  style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}
  title={`Head: ${schedule.headId}`}
>
  {schedule.headId}
</span>
```
NAGS badge uses the same shape but with fixed amber color and no id-hash:
```tsx
{schedule.requiresAck && (
  <span
    className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold text-zinc-100 shrink-0"
    style={{ backgroundColor: '#92400e', borderLeft: '2px solid #f59e0b' }}
    title={`Nags every ${formatNagInterval(schedule.nagIntervalMinutes)} until acknowledged`}
  >
    NAGS
  </span>
)}
```
Place this badge in the flex row alongside the head badge (around line 514).

**Schedule sub-label pattern** (lines 496–500) — extend for nag cadence suffix (D-05):
```tsx
const scheduleLabel = schedule.cron
  ? formatCron(schedule.cron)
  : schedule.runAt
    ? `Once at ${formatInTz(schedule.runAt, tz, { style: 'full' })}`
    : '—'
```
Extend the sub-label text at line 509 (`{scheduleLabel}`) to include nag cadence when applicable:
```tsx
<div className="text-xs text-zinc-500 mt-0.5">
  {scheduleLabel}
  {schedule.requiresAck && schedule.nagIntervalMinutes
    ? ` · nags every ${formatNagInterval(schedule.nagIntervalMinutes)}`
    : null}
</div>
```

**Edit modal pattern** (lines 555–622) — template for adding requiresAck + nag slots + optional start-date:
```tsx
{editing && createPortal(
  <>
    <div className="fixed inset-0 z-50 bg-black/70" onClick={() => setEditing(false)} />
    <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4"
           onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-100 mb-3">Edit reminder</h3>
        <div className="space-y-3">
          {/* ... existing fields ... */}
          {updateMutation.isError && (
            <div className="text-xs text-red-400">{(updateMutation.error as Error).message}</div>
          )}
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
              Cancel
            </button>
            <button onClick={commitEdit} disabled={updateMutation.isPending}
              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50">
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  </>,
  document.body
)}
```

New state variables to add to ReminderRow for edit modal (D-11):
```tsx
const [editRequiresAck, setEditRequiresAck] = useState(false)
const [editNagMinutes, setEditNagMinutes] = useState(0)
const [editNagHours, setEditNagHours] = useState(0)
const [editNagDays, setEditNagDays] = useState(0)
```

Seed them in `startEdit()`:
```tsx
function startEdit() {
  setEditMessage(schedule.agentContext ?? '')
  setEditValue(schedule.cron ?? schedule.runAt ?? '')
  setEditConditions(schedule.conditions ?? '')
  setEditRequiresAck(schedule.requiresAck)
  // decompose nagIntervalMinutes back into slots for display
  const totalMins = schedule.nagIntervalMinutes ?? 0
  setEditNagDays(Math.floor(totalMins / 1440))
  setEditNagHours(Math.floor((totalMins % 1440) / 60))
  setEditNagMinutes(totalMins % 60)
  setEditing(true)
}
```

The `updateMutation.mutationFn` type must include the new fields (D-11):
```tsx
const updateMutation = useMutation({
  mutationFn: (update: {
    cron?: string; runAt?: string; conditions?: string; agentContext?: string;
    requiresAck?: boolean; nagIntervalMinutes?: number | null
  }) => api.schedules.update(schedule.id, update),
  onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
})
```

---

### `dashboard/src/pages/SchedulesPage.tsx` — AddReminderForm (component, request-response)

**Analog:** `dashboard/src/pages/SchedulesPage.tsx` lines 629–771 (same component — extend in-place)

**Type toggle pattern** (lines 709–722) — reuse shape for requiresAck toggle button (D-02 reveal-when-on):
```tsx
<div className="flex gap-1">
  {(['once', 'repeating'] as const).map(t => (
    <button
      key={t}
      type="button"
      onClick={() => setType(t)}
      className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
        type === t ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {t === 'once' ? 'One-time' : 'Repeating'}
    </button>
  ))}
</div>
```

**Datetime-local pattern** (lines 725–735) — template for start-date field in repeating mode (D-07/D-08):
```tsx
{type === 'once' ? (
  <div>
    <label className="text-xs text-zinc-500 mb-1 block">Remind at</label>
    <input
      type="datetime-local"
      value={runAt}
      onChange={e => setRunAt(e.target.value)}
      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
    />
    <div className="text-[11px] text-zinc-500 mt-0.5">Browser local time (workspace timezone: {tz})</div>
  </div>
) : (
  <CronPicker value={cron} onChange={setCron} />
)}
```
For the start-date field, add below CronPicker when `type === 'repeating'`:
```tsx
{type === 'repeating' && (
  <div>
    <label className="text-xs text-zinc-500 mb-1 block">Start date (optional)</label>
    <input
      type="datetime-local"
      value={startAt}
      onChange={e => setStartAt(e.target.value)}
      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
    />
    <div className="text-[11px] text-zinc-500 mt-0.5">
      First fire at this time, then repeating. Browser local time (workspace timezone: {tz})
    </div>
  </div>
)}
```

**UTC conversion pattern** (line 319 of AddScheduleForm):
```tsx
runAt: new Date(runAt).toISOString()
```
Apply the same for startAt: `startAt: new Date(startAt).toISOString()` before sending.

**Error + disabled-submit pattern** (lines 751–768):
```tsx
{error && <div className="text-xs text-red-400">{error}</div>}

<div className="flex gap-2">
  <button
    type="submit"
    disabled={createMutation.isPending || !headId || !message.trim() || (type === 'once' && !runAt)}
    className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
  >
    {createMutation.isPending ? 'Adding…' : 'Add reminder'}
  </button>
```
Extend the disabled condition with ack/nag validation:
```tsx
disabled={
  createMutation.isPending
  || !headId
  || !message.trim()
  || (type === 'once' && !runAt)
  || (requiresAck && nagSum === 0)
  || (requiresAck && nagSum > 0 && nagSum < 1)
  || nagSum > 43200
  || (startAt !== '' && new Date(startAt) <= new Date())
}
```

**Inline validation error pattern** (lines 751):
```tsx
{error && <div className="text-xs text-red-400">{error}</div>}
```
Extend with inline ack-validation messages above the submit button:
```tsx
{requiresAck && nagSum === 0 && (
  <div className="text-xs text-red-400">Set a nag interval when "Requires acknowledgment" is on.</div>
)}
{requiresAck && nagSum > 0 && nagSum < 1 && (
  <div className="text-xs text-red-400">Nag interval must be at least 1 minute.</div>
)}
{nagSum > 43200 && (
  <div className="text-xs text-red-400">Nag interval must be at most 30 days.</div>
)}
{startAt && new Date(startAt) <= new Date() && (
  <div className="text-xs text-red-400">Start date must be in the future.</div>
)}
```

**createMutation.mutationFn pattern** (lines 658–669):
```tsx
const createMutation = useMutation({
  mutationFn: () => {
    if (!headId) throw new Error('Pick a head')
    if (!message.trim()) throw new Error('Enter a reminder message')
    if (type === 'once' && !runAt) throw new Error('Pick a date and time for the reminder')
    return api.schedules.create({
      headId,
      kind: 'reminder',
      agentContext: message.trim(),
      ...(type === 'repeating' ? { cron } : { runAt: new Date(runAt).toISOString() }),
      ...(conditions ? { conditions } : {}),
    })
  },
  onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); onDone() },
  onError: (err: Error) => setError(err.message),
})
```
Extend the spread to include new fields:
```tsx
...(requiresAck ? { requiresAck, nagIntervalMinutes: nagSum } : {}),
...(type === 'repeating' && startAt ? { startAt: new Date(startAt).toISOString() } : {}),
```

---

### `dashboard/src/pages/SchedulesPage.tsx` — AddScheduleForm (component, request-response)

**Analog:** `dashboard/src/pages/SchedulesPage.tsx` lines 264–443 (same component — extend in-place)

**Repeating/once type toggle + datetime-local** (lines 386–399):
```tsx
{type === 'repeating' ? (
  <CronPicker value={cron} onChange={setCron} />
) : (
  <div>
    <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
    <input
      type="datetime-local"
      value={runAt}
      onChange={e => setRunAt(e.target.value)}
      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
    />
    <div className="text-[11px] text-zinc-500 mt-0.5">Browser local time (workspace timezone: {tz})</div>
  </div>
)}
```
Add the start-date field below this block when `type === 'repeating'` — same element shape as the datetime-local above.

**createMutation spread pattern** (lines 315–323):
```tsx
return api.schedules.create({
  headId,
  taskName: target,
  kind: 'task',
  ...(type === 'repeating' ? { cron } : { runAt: new Date(runAt).toISOString() }),
  ...(conditions ? { conditions } : {}),
  ...(agentContext ? { agentContext } : {}),
})
```
Extend to include startAt when repeating:
```tsx
...(type === 'repeating' && startAt ? { startAt: new Date(startAt).toISOString() } : {}),
```

---

### `src/dashboard/routes/schedules.ts` — POST + PATCH handlers (route/controller, request-response)

**Analog:** `src/dashboard/routes/schedules.ts` lines 25–174 (same file — extend in-place)

**Validation + early-return pattern** (lines 30–91) — the project's validation idiom:
```typescript
const rawHeadId = (req.body as { headId?: unknown }).headId
if (typeof rawHeadId !== 'string' || !rawHeadId.trim()) {
  res.status(400).json({ error: 'headId is required and must be a non-empty string' })
  return
}
```
Apply same pattern for requiresAck/nagIntervalMinutes validation in POST (D-04):
```typescript
const { requiresAck, nagIntervalMinutes } = req.body as { requiresAck?: unknown; nagIntervalMinutes?: unknown }
const ackBool = requiresAck === true
const nagNum = typeof nagIntervalMinutes === 'number' ? nagIntervalMinutes : 0

// Ack↔nag coupling: requiresAck requires a nag interval
if (ackBool && nagNum === 0) {
  res.status(400).json({ error: 'requiresAck requires a nag interval (minimum 1 minute)' })
  return
}
// Nag without ack: reject
if (!ackBool && nagNum > 0) {
  res.status(400).json({ error: 'nagIntervalMinutes only applies when requiresAck is true' })
  return
}
// Floor: 1 minute (D-03)
if (ackBool && nagNum > 0 && nagNum < 1) {
  res.status(400).json({ error: 'nag interval must be at least 1 minute' })
  return
}
// Ceiling: 30 days = 43200 minutes
if (nagNum > 43200) {
  res.status(400).json({ error: 'nag interval must be at most 30 days (43200 minutes)' })
  return
}
```

**nextRun computation pattern** (lines 73–91) — reference for the startAt override (D-10):
```typescript
let nextRun: string | undefined
if (typeof cron === 'string' && cron) {
  if (!isValidCadence(cron)) {
    res.status(400).json({ error: CADENCE_ERROR_MESSAGE })
    return
  }
  try {
    nextRun = nextRunAfter(cron, new Date(), timezone).toISOString()
  } catch {
    res.status(400).json({ error: 'Invalid cron expression' })
    return
  }
}
```
Extend: after computing cron-based nextRun, override with startAt when provided:
```typescript
const startAt = (req.body as { startAt?: unknown }).startAt
if (typeof startAt === 'string' && startAt && typeof cron === 'string' && cron) {
  const d = new Date(startAt)
  if (isNaN(d.getTime())) {
    res.status(400).json({ error: 'Invalid startAt date' })
    return
  }
  if (d <= new Date()) {
    res.status(400).json({ error: 'startAt must be in the future' })
    return
  }
  nextRun = d.toISOString()  // D-10: override cron-computed nextRun with start date
}
```

**createOpts construction pattern** (lines 96–103):
```typescript
const createOpts: import('../../db/schedules.js').CreateScheduleOptions = { id: generateId('sched'), headId, kind }
if (kind === 'task' && typeof taskName === 'string') createOpts.taskName = taskName
if (typeof cron === 'string' && cron) createOpts.cron = cron
if (typeof runAt === 'string' && runAt) createOpts.runAt = runAt
if (nextRun !== undefined) createOpts.nextRun = nextRun
if (typeof conditions === 'string' && conditions) createOpts.conditions = conditions
if (typeof agentContext === 'string' && agentContext) createOpts.agentContext = agentContext
```
Add ack fields using the same conditional guard:
```typescript
if (ackBool) createOpts.requiresAck = true
if (ackBool && nagNum > 0) createOpts.nagIntervalMinutes = nagNum
```

**PATCH handler pattern** (lines 110–165) — field extraction + patch construction:
```typescript
const { enabled, cron, runAt, conditions, agentContext } = req.body as {
  enabled?: unknown; cron?: unknown; runAt?: unknown;
  conditions?: unknown; agentContext?: unknown
}

const patch: Parameters<typeof scheduleStore.update>[1] = {}
if (typeof enabled === 'boolean') patch.enabled = enabled
if (typeof cron === 'string' && cron) patch.cron = cron
// ...
```
Extend for D-11 (requiresAck/nagIntervalMinutes on PATCH):
```typescript
const { requiresAck: patchRequiresAck, nagIntervalMinutes: patchNagInterval } = req.body as {
  requiresAck?: unknown; nagIntervalMinutes?: unknown
}

if (typeof patchRequiresAck === 'boolean') {
  // Validate ack↔nag coupling on PATCH as well (D-04)
  const patchNag = typeof patchNagInterval === 'number' ? patchNagInterval : 0
  if (patchRequiresAck && patchNag === 0) {
    res.status(400).json({ error: 'requiresAck requires a nag interval (minimum 1 minute)' })
    return
  }
  if (patchRequiresAck && patchNag > 0 && patchNag < 1) {
    res.status(400).json({ error: 'nag interval must be at least 1 minute' })
    return
  }
  if (patchNag > 43200) {
    res.status(400).json({ error: 'nag interval must be at most 30 days (43200 minutes)' })
    return
  }
  patch.requiresAck = patchRequiresAck
  if (patchRequiresAck) {
    patch.nagIntervalMinutes = patchNag > 0 ? patchNag : null
  } else {
    // D-12: turning ack off — compute nextRun in route and pass via patch.nextRun
    // (option b from RESEARCH open question 1: keeps update() signature stable)
    patch.nagIntervalMinutes = null
    // D-12: if the existing schedule has ackPending, clear it and recompute nextRun
    const existing = scheduleStore.get(id)
    if (existing?.ackPending) {
      patch.ackPending = false
      if (existing.cron) {
        patch.nextRun = nextRunAfter(existing.cron, new Date(), timezone).toISOString()
      } else {
        patch.nextRun = existing.runAt ?? undefined
      }
    }
  }
}
if (typeof patchNagInterval === 'number' && patch.requiresAck !== false) {
  patch.nagIntervalMinutes = patchNagInterval
}
```

**Import block** (lines 1–8) — no new imports needed; `nextRunAfter` is already imported at line 6:
```typescript
import { nextRunAfter } from '../../scheduler/cron.js'
import { isValidCadence, CADENCE_ERROR_MESSAGE } from '../../scheduler/cadence.js'
```

---

### `src/db/schedules.ts` — SchedulePatch + update() (model/store, CRUD)

**Analog:** `src/db/schedules.ts` lines 44 and 130–147 (same file — extend in-place)

**Current SchedulePatch** (line 44):
```typescript
export type SchedulePatch = Partial<Pick<Schedule, 'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone' | 'ackPending'>>
```
**Replacement** (D-11 — add requiresAck + nagIntervalMinutes):
```typescript
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' |
  'agentContext' | 'cronTimezone' | 'ackPending' | 'requiresAck' | 'nagIntervalMinutes'
>>
```

**Current update() apply-block** (lines 130–147):
```typescript
update(id: string, patch: SchedulePatch): Schedule | null {
  const existing = this.get(id)
  if (!existing) return null

  if (patch.cron !== undefined) existing.cron = patch.cron
  if (patch.runAt !== undefined) existing.runAt = patch.runAt
  if (patch.enabled !== undefined) existing.enabled = patch.enabled
  if (patch.nextRun !== undefined) existing.nextRun = patch.nextRun
  if (patch.lastRun !== undefined) existing.lastRun = patch.lastRun
  if (patch.conditions !== undefined) existing.conditions = patch.conditions
  if (patch.agentContext !== undefined) existing.agentContext = patch.agentContext
  if (patch.cronTimezone !== undefined) existing.cronTimezone = patch.cronTimezone
  if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending

  existing.updatedAt = new Date().toISOString()
  this.store.save(existing)
  return existing
}
```
**Add after the ackPending line** (D-11 + note on D-12: D-12 nag-clear transition is handled in the route, which passes pre-computed patch.nextRun + patch.ackPending + patch.nagIntervalMinutes):
```typescript
if (patch.requiresAck !== undefined) existing.requiresAck = patch.requiresAck
if (patch.nagIntervalMinutes !== undefined) existing.nagIntervalMinutes = patch.nagIntervalMinutes
```

**Note on D-12:** The RESEARCH open question 1 recommends option (b): compute the D-12 nextRun in the PATCH route handler (where `timezone` is available) and pass it via `patch.nextRun`. The update() apply-block does not need a timezone parameter. The route already applies this pattern at line 155 (`patch.nextRun = nextRunAfter(cron, new Date(), timezone).toISOString()`).

---

### `src/sub-agents/registry.ts` — Floor 5→1 correction (D-03)

**Analog:** `src/sub-agents/registry.ts` lines 956, 1017, 1021–1022 (same file — four targeted line edits)

**Current code at each site** (verified from RESEARCH F-05):

| Line | Current content | Change |
|------|----------------|--------|
| 956 | `'...minimum 5 minutes total, maximum 30 days...'` | `minimum 1 minute` |
| 1017 | `'requiresAck requires a nag interval: set nagMinutes, nagHours, or nagDays (minimum 5 minutes total)'` | `minimum 1 minute` |
| 1021 | `if (requiresAckArg === true && nagSum > 0 && nagSum < 5)` | `nagSum < 1` |
| 1022 | `'nag interval must be at least 5 minutes (sum of nagMinutes + nagHours×60 + nagDays×1440)'` | `1 minute` |

**Context block** (lines 1015–1023) showing all four sites together:
```typescript
// T-37-07 D-04: requiresAck:true but no nag interval provided → reject
if (requiresAckArg === true && nagSum === 0) {
  return JSON.stringify({ error: true, message: 'requiresAck requires a nag interval: set nagMinutes, nagHours, or nagDays (minimum 5 minutes total)' })
  //                                                                                                                               ^^ change to "minimum 1 minute"
}

// T-37-04 D-03 floor: nag interval too short to be useful
if (requiresAckArg === true && nagSum > 0 && nagSum < 5) {
  //                                                  ^^ change to < 1
  return JSON.stringify({ error: true, message: 'nag interval must be at least 5 minutes (sum of nagMinutes + nagHours×60 + nagDays×1440)' })
  //                                                                               ^^ change to "1 minute"
}
```

**`{error:true,message}` validation shape** — the canonical tool error idiom used throughout the registry. Any new validation in this block must use the same shape:
```typescript
return JSON.stringify({ error: true, message: '...' })
```

---

## Shared Patterns

### Local Helper: `formatNagInterval`
**Source:** New helper — no existing analog; follows the pattern of `formatRelTime` (SchedulesPage.tsx line 70)
**Apply to:** `ReminderRow` sub-label, NAGS badge tooltip, `AddReminderForm` nag slot display
**Add to SchedulesPage.tsx alongside existing helpers** (after line 82):
```typescript
function formatNagInterval(minutes: number | null): string {
  if (!minutes) return '?'
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  return parts.join(' ') || '?'
}
```

### Validation Error Display
**Source:** `SchedulesPage.tsx` line 751 / line 423 (both forms)
**Apply to:** AddReminderForm, edit modal
```tsx
{error && <div className="text-xs text-red-400">{error}</div>}
```

### Form Input Styling
**Source:** `SchedulesPage.tsx` lines 340–343, 391–395 (form selects/inputs)
**Apply to:** All new nag slot inputs and start-date input
```tsx
className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
// For smaller inline inputs (nag minute/hour/day slots):
className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
```

### Label Styling
**Source:** `SchedulesPage.tsx` line 397 (AddScheduleForm), line 727 (AddReminderForm)
**Apply to:** All new form field labels
```tsx
<label className="text-xs text-zinc-500 mb-1 block">Field name</label>
```

### Reveal-When-On (Conditional Rendering)
**Source:** `SchedulesPage.tsx` lines 386–399 (type toggle gates CronPicker vs datetime-local)
**Apply to:** Nag slot inputs (hidden until requiresAck toggle is on — D-02)
```tsx
{requiresAck && (
  <div className="space-y-1">
    <label className="text-xs text-zinc-500 block">Nag every</label>
    <div className="flex gap-2 items-center">
      <input type="number" min={0} value={nagDays} onChange={e => setNagDays(Number(e.target.value))}
        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center" />
      <span className="text-xs text-zinc-500">d</span>
      <input type="number" min={0} value={nagHours} onChange={e => setNagHours(Number(e.target.value))}
        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center" />
      <span className="text-xs text-zinc-500">h</span>
      <input type="number" min={0} value={nagMinutes} onChange={e => setNagMinutes(Number(e.target.value))}
        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center" />
      <span className="text-xs text-zinc-500">m</span>
    </div>
  </div>
)}
```

### Authentication Middleware
**Source:** `src/dashboard/routes/schedules.ts` line 3, used at lines 21, 25, 110, 167
**Apply to:** All route handlers (already applied — no change needed)
```typescript
import { requireAuth } from '../auth.js'
// usage:
router.get('/', requireAuth, (_req, res) => { ... })
router.post('/', requireAuth, (req, res) => { ... })
router.patch('/:id', requireAuth, (req, res) => { ... })
```

### `nextRunAfter` Import
**Source:** `src/dashboard/routes/schedules.ts` line 6 (already imported)
**Apply to:** D-10 startAt override in POST, D-12 ackPending-clear nextRun recompute in PATCH
```typescript
import { nextRunAfter } from '../../scheduler/cron.js'
// signature: nextRunAfter(expression: string, after: Date, tz: string): Date
// usage: nextRunAfter(cron, new Date(), timezone).toISOString()
```

### React Query Mutation Pattern
**Source:** `SchedulesPage.tsx` lines 93–106 (ScheduleRow), 454–467 (ReminderRow)
**Apply to:** Any new mutations (PATCH with new ack fields)
```tsx
const updateMutation = useMutation({
  mutationFn: (update: { /* typed patch fields */ }) => api.schedules.update(schedule.id, update),
  onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
})
```

---

## Test Patterns

### Integration Test Structure
**Source:** `src/dashboard/routes/schedules.test.ts` lines 1–200

**Test setup pattern** — real express app + real ScheduleStore in tmpdir, auth bypassed via `res.locals['authenticated'] = true`:
```typescript
beforeEach(async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'))
  store = new ScheduleStore(storeDir)

  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
  app.use('/api/schedules', createSchedulesRouter(store, 'UTC', () => [{ id: 'default' }], unified))

  port = await getFreePort()
  await new Promise<void>((resolve, reject) => {
    server = app.listen(port, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })
})

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(storeDir, { recursive: true, force: true })
})
```

**Request helper pattern** (lines 80–88):
```typescript
async function post(body: Record<string, unknown>) {
  const r = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({})) as Record<string, unknown>
  return { status: r.status, data }
}

async function patch(id: string, body: Record<string, unknown>) {
  const r = await fetch(`http://127.0.0.1:${port}/api/schedules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({})) as Record<string, unknown>
  return { status: r.status, data }
}
```

**Assertion pattern** (lines 90–140):
```typescript
it('Test A: requiresAck + no nag → 400', async () => {
  const r = await post({ kind: 'reminder', agentContext: 'hello', cron: '0 9 * * *', headId: 'default', requiresAck: true })
  expect(r.status).toBe(400)
  expect((r.data as { error: string }).error.toLowerCase()).toContain('nag')
})

it('Test B: requiresAck + nagSum=1 → 200 (floor=1, D-03)', async () => {
  const r = await post({ kind: 'reminder', agentContext: 'hello', cron: '0 9 * * *', headId: 'default', requiresAck: true, nagIntervalMinutes: 1 })
  expect(r.status).toBe(200)
  const schedule = (r.data as { schedule: { requiresAck: boolean; nagIntervalMinutes: number } }).schedule
  expect(schedule.requiresAck).toBe(true)
  expect(schedule.nagIntervalMinutes).toBe(1)
})
```

---

## No Analog Found

All files have direct analogs. No new file types or patterns are being introduced — this phase extends existing components, routes, and store exclusively.

---

## Metadata

**Analog search scope:** `dashboard/src/`, `src/dashboard/routes/`, `src/db/`, `src/sub-agents/`
**Files read:** 8 source files (SchedulesPage.tsx, api.ts types/api.ts, routes/schedules.ts, db/schedules.ts, registry.ts lines 940–1099, schedules.test.ts)
**Pattern extraction date:** 2026-05-23

### Key Invariants to Preserve
1. **CronPicker is read-only** — do not change `dashboard/src/components/CronPicker.tsx`
2. **`src/icw/*` is never edited** — vendored compiled output
3. **No new npm packages** — all capabilities use existing dependencies
4. **`nagSum < 1` not `< 5`** — D-03 floor correction is 1 minute, verified as a user override of Phase 37 D-03
5. **D-12 tz decision:** compute `nextRun` in the PATCH route (option b), pass via `patch.nextRun` — do not add a `tz` parameter to `update()`
6. **Badge condition is `requiresAck` not `ackPending`** — static badge persists between nag fires (D-06, Pitfall 2)
7. **Always convert datetime-local to UTC** — `new Date(value).toISOString()` before sending (Pitfall 6)
8. **Always set both `cron` and `nextRun`** when start-date is provided — otherwise the schedule becomes one-time (Pitfall 4)
