# Phase 49: Sensors Dashboard — Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 9 (new/modified)
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/dashboard/routes/sensors.ts` | route (Express router factory) | request-response (filesystem CRUD) | `src/dashboard/routes/memory.ts` | role-match |
| `src/dashboard/server.ts` | config / wiring | — | `src/dashboard/server.ts` (existing) | exact (modify) |
| `src/index.ts` | wiring / startup | — | `src/index.ts` (existing) | exact (modify) |
| `dashboard/src/pages/SensorsPage.tsx` | page component | request-response (API CRUD) | `dashboard/src/components/kind/KindEditorPage.tsx` | role-match (simpler) |
| `dashboard/src/lib/api.ts` | API client | request-response | `api.tasks` block (lines 196–233) | exact (extend) |
| `dashboard/src/components/layout/Sidebar.tsx` | nav component | — | `Sidebar.tsx` NAV_ICONS + nav array (lines 117–192) | exact (modify) |
| `dashboard/src/router.tsx` | router config | — | `router.tsx` AppShell children (lines 56–89) | exact (modify) |
| `dashboard/src/types/api.ts` | type definition | — | `Schedule.kind` union (line 263) | exact (modify) |
| `dashboard/src/pages/SchedulesPage.tsx` | page component | request-response | `SchedulesPage.tsx` `AddScheduleForm` + `ScheduleRow` (lines 316–555, 98–314, 1075–1171) | exact (modify) |

---

## CRITICAL CORRECTION vs RESEARCH.md

The RESEARCH.md states "Backend `db/schedules.ts` already accepts `kind:'script'`" — **this is TRUE** for the data layer but **FALSE** for the HTTP route**. The `POST /api/schedules` handler in `src/dashboard/routes/schedules.ts` lines 80-85 explicitly rejects any `kind` other than `'task'` or `'reminder'`:

```typescript
// src/dashboard/routes/schedules.ts lines 80-85 (CURRENT STATE — blocks 'script')
const rawKind = (req.body as { kind?: unknown }).kind
if (rawKind !== undefined && rawKind !== 'task' && rawKind !== 'reminder') {
  res.status(400).json({ error: "kind must be 'task' or 'reminder'" })
  return
}
const kind: 'task' | 'reminder' = rawKind === 'reminder' ? 'reminder' : 'task'
```

The planner **must** add a Wave 0 task to patch this validation to allow `'script'` before the `AddSensorScheduleForm` can work. The fix is:
1. Change the validation guard to also allow `'script'`.
2. Change the `kind` variable type to `'task' | 'reminder' | 'script'`.
3. Skip `taskName` validation for `kind === 'script'` (sensor slug goes in `taskName`, but the unifiedLoader check must be bypassed for `'script'`).

**`headId` IS REQUIRED** — the route (line 31-34) validates it against the live head list and returns 400 if absent. `headId` is NOT nullable for `kind:'script'` rows because the file-store JSON schema and the existing ScheduleStore.create() both require it (`headId: options.headId` with no default). The `AddSensorScheduleForm` must pass a `headId` — pick the active head from localStorage (same seed as `AddScheduleForm`), but hide the picker from the operator (sensors don't conceptually belong to a head, but the store demands one).

---

## Pattern Assignments

### `src/dashboard/routes/sensors.ts` (route factory, filesystem CRUD)

**Analog:** `src/dashboard/routes/memory.ts` — same pattern: Express Router factory, `requireAuth` on every handler, slug/id validation, filesystem ops, no DB.

**Imports pattern** (`memory.ts` lines 1–6):
```typescript
import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../auth.js'
```

**Auth pattern** (every handler in `kind.ts` + `memory.ts`):
```typescript
router.get('/', requireAuth, (_req: Request, res: Response): void => { ... })
router.put('/:slug', requireAuth, (req: Request, res: Response): void => { ... })
```

**Slug validation pattern** (`memory.ts` lines 10–12, adapted for sensor slug):
```typescript
// memory.ts uses /^[a-z0-9][a-z0-9-]{0,79}$/
// sensors must match the same regex used in runSensor (runner.ts line 52):
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
// Guard pattern from kind.ts line 65:
if (!SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
```

**ENOENT-safe directory read** — Pitfall 4 from RESEARCH.md; use `mkdirSync` before `readdirSync`:
```typescript
// Pattern: create dir before read to avoid ENOENT on fresh workspace
fs.mkdirSync(sensorsDir, { recursive: true })
const slugs = fs.readdirSync(sensorsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .filter(n => SLUG_RE.test(n))
```

**Force-rm pattern** (`fs.rmSync` with `force:true`) — avoids ENOENT on missing ambient file:
```typescript
fs.rmSync(path.join(sensorsDir, slug), { recursive: true, force: true })
fs.rmSync(path.join(ambientDir, `${slug}.md`), { force: true })
```

**Run-on-save: fire-and-forget** — `runSensor` always resolves; never await before responding:
```typescript
// void — do not await; errors go to ambient file (by Phase 48 design)
void sensorRunner.run(slug)
res.json({ slug })
```

**Router factory function signature** (from `createKindRouter` / `createMemoryRouter` pattern):
```typescript
export function createSensorsRouter(opts: {
  workspacePath: string
  sensorRunner: import('../../sensors/runner.js').SensorRunner
}): Router
```

---

### `src/dashboard/server.ts` (wiring — add `sensors?` option + mount)

**Analog:** `src/dashboard/server.ts` itself — the existing `tasks?` option (lines 81-83) is the direct template.

**Option addition** (after `tasks?:` block, lines 81-83):
```typescript
// Existing pattern to follow:
tasks?: {
  loader: SkillLoader
}
// New option — same shape:
sensors?: {
  workspacePath: string
  sensorRunner: import('../sensors/runner.js').SensorRunner
}
```

**Import addition** (top of file, after existing createKindRouter import line 29):
```typescript
import { createSensorsRouter } from './routes/sensors.js'
```

**Mount pattern** (after `if (this.opts.tasks)` block, lines 243-252):
```typescript
// Existing pattern:
if (this.opts.tasks) {
  app.use('/api/tasks', createKindRouter(this.opts.tasks.loader, tasksOpts))
}
// New pattern — same guard:
if (this.opts.sensors) {
  app.use('/api/sensors', createSensorsRouter(this.opts.sensors))
}
```

---

### `src/index.ts` (wiring — pass sensors to DashboardServer)

**Analog:** `src/index.ts` itself — the `sensorRunner` closure already exists (lines 474-480); the `tasks: { loader: taskKindLoader }` pass (line 513) is the template.

**Addition to DashboardServer options** (after `tasks:` line 513):
```typescript
// Existing:
tasks: { loader: taskKindLoader },
// Add:
sensors: { workspacePath, sensorRunner },
```

---

### `dashboard/src/pages/SensorsPage.tsx` (page component, filesystem CRUD)

**Analog:** `dashboard/src/components/kind/KindEditorPage.tsx` — two-panel layout (list + editor), TanStack Query mutations, save/delete pattern. **Do NOT reuse `KindEditorPage`** — it requires YAML frontmatter, SkillLoader contract, and rename cascade. `SensorsPage` is a simpler standalone page.

**Imports pattern** (from `SchedulesPage.tsx` lines 1–9, adapted):
```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
```

**List query pattern** (from `SchedulesPage.tsx` lines 1082-1086):
```typescript
const sensorsQuery = useQuery({
  queryKey: ['sensors'],
  queryFn: api.sensors.list,
})
```

**Detail query pattern** (from KindEditorPage, slug-keyed):
```typescript
const detailQuery = useQuery({
  queryKey: ['sensors', selectedSlug],
  queryFn: () => api.sensors.get(selectedSlug!),
  enabled: !!selectedSlug,
})
```

**Save mutation pattern** (from `SchedulesPage.tsx` `updateMutation` at line 122-125):
```typescript
const saveMutation = useMutation({
  mutationFn: ({ slug, content }: { slug: string; content: string }) =>
    api.sensors.save(slug, content),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ['sensors'] })
    void qc.invalidateQueries({ queryKey: ['sensors', selectedSlug] })
  },
})
```

**Delete mutation pattern** (from `SchedulesPage.tsx` `deleteMutation` at lines 117-119):
```typescript
const deleteMutation = useMutation({
  mutationFn: (slug: string) => api.sensors.delete(slug),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ['sensors'] })
    setSelectedSlug(null)
  },
})
```

**Delete confirm pattern** (from `SchedulesPage.tsx` line 211):
```typescript
onClick={() => {
  if (window.confirm(`Delete sensor "${slug}"?`)) deleteMutation.mutate(slug)
}}
```

**Panel layout structure** (from KindEditorPage two-panel shape):
```tsx
<div className="flex h-full overflow-hidden">
  {/* Left: sensor list */}
  <div className="w-56 shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">
    {/* list items + new sensor form trigger */}
  </div>
  {/* Right: editor */}
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* textarea for script body + save/delete buttons */}
  </div>
</div>
```

**Page-level wrapper** (from `SchedulesPage.tsx` line 1098-1100):
```tsx
export default function SensorsPage() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
```
> Note: For a two-panel layout the outer div should be `flex h-full` not `overflow-y-auto p-6`. Mirror KindEditorPage's layout instead.

**Script body editor** — plain `<textarea>` with monospace font (no external code-editor library):
```tsx
<textarea
  rows={20}
  value={scriptBody}
  onChange={e => setScriptBody(e.target.value)}
  className="w-full flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-600 resize-none"
  placeholder="// Write your sensor script here&#10;process.stdout.write('# My Sensor\n...')"
/>
```

---

### `dashboard/src/lib/api.ts` (add `api.sensors` client)

**Analog:** `api.tasks` block (lines 196–233) — same `encXxxPath` helper + `request<T>` calls.

**Helper and client block to add** (after `api.tasks` block):
```typescript
function encSensorPath(slug: string) {
  return `/api/sensors/${encodeURIComponent(slug)}`
}

// Add inside the `api` object, after tasks:
sensors: {
  list: () =>
    request<{ sensors: Array<{ slug: string }> }>('/api/sensors'),
  get: (slug: string) =>
    request<{ slug: string; content: string }>(encSensorPath(slug)),
  save: (slug: string, content: string) =>
    request<{ slug: string }>(encSensorPath(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  delete: (slug: string) =>
    request<{ ok: true }>(encSensorPath(slug), { method: 'DELETE' }),
},
```

**Import addition** (top of `api.ts` line 1 — add `SensorInfo` and `SensorDetail` once defined in `types/api.ts`, or use inline types if the planner keeps them local):
No additional type imports are strictly needed if the return types are inlined in the `request<T>` generics as shown above.

---

### `dashboard/src/components/layout/Sidebar.tsx` (add nav item + icon)

**Analog:** `Sidebar.tsx` itself — `NAV_ICONS` map (lines 117–130) and inline nav array (lines 182–192).

**NAV_ICONS addition** (line 117 block, add after `Tasks` entry):
```typescript
// Existing imports (line 4-7):
import {
  MessageSquare, BrainCircuit, UserCircle, Zap, BarChart3,
  ScrollText, FlaskConical, ClipboardCheck, Settings, LogOut,
  Clock, PanelLeftClose, PanelLeftOpen, CheckSquare, BookOpen,
} from 'lucide-react'
// Add Activity to import list (Activity is confirmed available in lucide-react ~1.8.0):
import {
  ..., Activity,   // ← add
} from 'lucide-react'

// NAV_ICONS map (lines 117-130) — add after Tasks:
const NAV_ICONS = {
  Conversation: MessageSquare,
  Memory: BrainCircuit,
  Identity: UserCircle,
  Skills: Zap,
  Tasks: CheckSquare,
  Sensors: Activity,     // ← add
  Schedules: Clock,
  Docs: BookOpen,
  ...
} as const
```

**Nav array addition** (lines 182–192, insert between Tasks and Schedules):
```typescript
// Existing array:
{ to: '/', label: 'Conversation', end: true },
{ to: '/identity', label: 'Identity', end: false },
{ to: '/skills', label: 'Skills', end: false },
{ to: '/tasks', label: 'Tasks', end: false },
{ to: '/sensors', label: 'Sensors', end: false },    // ← add here
{ to: '/schedules', label: 'Schedules', end: false },
{ to: '/memory', label: 'Memory', end: false },
{ to: '/docs', label: 'Docs', end: false },
```

---

### `dashboard/src/router.tsx` (add `/sensors` route)

**Analog:** `router.tsx` itself — existing route entries (lines 68–79).

**Import addition** (after `TasksPage` import line 13):
```typescript
import SensorsPage from './pages/SensorsPage.js'
```

**Route entry** (after `/tasks` route, line 75):
```typescript
// Existing:
{ path: '/tasks', element: <TasksPage /> },
// Add:
{ path: '/sensors', element: <SensorsPage /> },
{ path: '/schedules', element: <SchedulesPage /> },
```

---

### `dashboard/src/types/api.ts` (extend `Schedule.kind` union)

**Analog:** `api.ts` itself — `Schedule` interface lines 259–281.

**Current state** (line 263):
```typescript
kind: 'task' | 'reminder'
```

**Target state**:
```typescript
kind: 'task' | 'reminder' | 'script'
```

No other fields on `Schedule` need changing — `taskName` already holds the sensor slug for `kind:'script'` rows, and all other fields (`headId`, `cron`, `runAt`, `enabled`, etc.) apply normally.

**Also update `api.schedules.create` type** (`api.ts` line 293) — change the `kind?` field:
```typescript
// Current:
create: (body: { headId: string; taskName?: string; kind?: 'task' | 'reminder'; ... }) => ...
// Target:
create: (body: { headId: string; taskName?: string; kind?: 'task' | 'reminder' | 'script'; ... }) => ...
```

---

### `dashboard/src/pages/SchedulesPage.tsx` (add sensor schedule section)

**Analog:** `SchedulesPage.tsx` itself — the existing `AddScheduleForm` (lines 316–554), `ScheduleRow` (lines 98–314), the Reminders section header+panel (lines 1139–1166), and the `taskSchedules`/`reminderSchedules` split (lines 1093–1095).

#### Patch 1: Fix `taskSchedules` filter (line 1094)

The RESEARCH.md suggests:
```typescript
// Current (line 1094):
const taskSchedules = allSchedules.filter(s => s.kind !== 'reminder')
// Change to:
const taskSchedules = allSchedules.filter(s => s.kind !== 'reminder' && s.kind !== 'script')
const sensorSchedules = allSchedules.filter(s => s.kind === 'script')
```

#### Patch 2: Add state variable and `sensorsQuery`

Following the `tasksQuery` pattern (lines 1088–1092):
```typescript
// Add after tasksQuery:
const [showSensorForm, setShowSensorForm] = useState(false)
const sensorsQuery = useQuery({
  queryKey: ['sensors'],
  queryFn: api.sensors.list,
})
const sensors = sensorsQuery.data?.sensors ?? []
```

#### Patch 3: `SensorScheduleRow` component

Pattern from `ScheduleRow` (lines 98–314) — identical toggle/delete mutations, same portal edit modal. **Key differences**: no `agentContext`/`relayGuidance`/`deliverToHeadIds` fields in the edit modal; add a `Script` badge in place of the head color chips.

```tsx
// Toggle pattern (copy from ScheduleRow lines 112-115):
const toggleMutation = useMutation({
  mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
  onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
})

// Script badge (instead of head color chips):
<span
  className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold text-zinc-100 shrink-0"
  style={{ backgroundColor: '#3f3f46', borderLeft: '2px solid #71717a' }}
>
  SCRIPT
</span>
```

#### Patch 4: `AddSensorScheduleForm` component

Pattern from `AddScheduleForm` (lines 316–554) with task-specific fields removed.

**Keep**: `cron`, `runAt`, `startAt`, `type` toggle, `conditions`, `headId` (hidden — seed from localStorage, do NOT show picker).

**Remove**: `deliverToHeadIds`, `agentContext`, `relayGuidance`, head picker `<select>` UI element.

**Change**: target `<select>` uses sensor slugs from `api.sensors.list` instead of tasks:
```typescript
// AddScheduleForm seeds headId (lines 353-365):
useEffect(() => {
  if (headId) return
  const heads = headsQuery.data?.heads ?? []
  if (heads.length === 0) return
  const stored = readActiveHeadFromStorage()
  if (stored && heads.some(h => h.id === stored)) {
    setHeadId(stored)
  } else {
    setHeadId(heads[0]!.id)
  }
}, [headsQuery.data, headId])

// Create mutation — pass kind:'script', sensor slug as taskName:
const createMutation = useMutation({
  mutationFn: () => {
    if (!headId) throw new Error('No head available')
    if (!targetSlug) throw new Error('Pick a sensor')
    return api.schedules.create({
      headId,
      taskName: targetSlug,
      kind: 'script',
      ...(type === 'repeating' ? { cron } : { runAt: datetimeLocalToUtc(runAt, tz) }),
      ...(conditions ? { conditions } : {}),
      ...(type === 'repeating' && startAt ? { startAt: datetimeLocalToUtc(startAt, tz) } : {}),
    })
  },
  onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); onDone() },
  onError: (err: Error) => setError(err.message),
})
```

#### Patch 5: Sensor schedules section in page JSX

Pattern from Reminders section (lines 1139–1166):
```tsx
{/* ── Sensor Schedules ── */}
<div className="flex items-center justify-between">
  <div>
    <h2 className="text-base font-semibold text-zinc-100">Sensor Schedules</h2>
    <p className="text-sm text-zinc-500 mt-0.5">Scheduled sensor script runs</p>
  </div>
  <button
    onClick={() => setShowSensorForm(f => !f)}
    className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors"
  >
    {showSensorForm ? 'Cancel' : '+ New sensor schedule'}
  </button>
</div>
<div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
  {schedulesQuery.isLoading && (
    <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</div>
  )}
  {!schedulesQuery.isLoading && !schedulesQuery.isError && sensorSchedules.length === 0 && !showSensorForm && (
    <div className="px-4 py-8 text-center text-sm text-zinc-500">
      No sensor schedules. Create a sensor first, then schedule it here.
    </div>
  )}
  {sensorSchedules.map(s => <SensorScheduleRow key={s.id} schedule={s} tz={tz} />)}
  {showSensorForm && (
    <AddSensorScheduleForm
      sensors={sensors}
      loading={sensorsQuery.isLoading}
      onDone={() => setShowSensorForm(false)}
      tz={tz}
    />
  )}
</div>
```

---

### `src/sensors/routes.test.ts` (new unit test file)

**Analog:** `src/sensors/runner.test.ts` — same setup/teardown pattern with `mkdtempSync` + `rmSync`, same vitest import block.

**Test structure pattern** (`runner.test.ts` lines 1–18):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import request from 'supertest'      // already in devDeps
import express from 'express'
import { createSensorsRouter } from '../../dashboard/routes/sensors.js'

describe('createSensorsRouter', () => {
  let tmpDir: string
  let sensorsDir: string
  let ambientDir: string
  let app: express.Express

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensors-routes-test-'))
    sensorsDir = path.join(tmpDir, 'sensors')
    ambientDir = path.join(tmpDir, 'ambient')
    const sensorRunner = { run: async (_slug: string) => { /* no-op mock */ } }
    app = express()
    app.use(express.json())
    app.use('/api/sensors', createSensorsRouter({ workspacePath: tmpDir, sensorRunner }))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  // ...tests
})
```

> Note: Check whether `supertest` is in devDeps before using it — if not, use `node-fetch` + start/stop the server on a random port, mirroring other route test files.

---

## Shared Patterns

### Auth guard on every route handler
**Source:** `src/dashboard/routes/kind.ts` line 55 / `src/dashboard/routes/memory.ts`
**Apply to:** All handlers in `src/dashboard/routes/sensors.ts`
```typescript
router.get('/', requireAuth, (_req: Request, res: Response): void => { ... })
```

### Slug/name input validation before `path.join`
**Source:** `src/dashboard/routes/kind.ts` lines 64-65 / `src/sensors/runner.ts` line 52
**Apply to:** Every handler in `sensors.ts` that reads `:slug` from params
```typescript
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
```

### TanStack Query invalidation on mutation success
**Source:** `dashboard/src/pages/SchedulesPage.tsx` lines 113-115
**Apply to:** All `useMutation` calls in `SensorsPage.tsx`
```typescript
onSuccess: () => void qc.invalidateQueries({ queryKey: ['sensors'] }),
```

### Conditional router mount guard
**Source:** `src/dashboard/server.ts` lines 243-252 (`if (this.opts.tasks)`)
**Apply to:** New sensors router mount in `server.ts`
```typescript
if (this.opts.sensors) {
  app.use('/api/sensors', createSensorsRouter(this.opts.sensors))
}
```

---

## No Analog Found

All files have close analogs. No gaps.

---

## Additional Confirmed Facts (RESEARCH.md corrections)

| Claim in RESEARCH.md | Verified Status |
|---|---|
| "Backend `db/schedules.ts` already accepts `kind:'script'`" | **TRUE** — `ScheduleStore.create()` accepts it |
| "Frontend `Schedule.kind` is `'task' | 'reminder'`" | **TRUE** — `api.ts` line 263 confirmed |
| `headId` is required for `kind:'script'` rows | **TRUE** — `POST /api/schedules` line 31-34 requires it AND validates against live head list; no nullable path exists |
| `kind:'script'` is accepted by the HTTP route `POST /api/schedules` | **FALSE** — lines 80-85 block it; this is a Wave 0 fix required before `AddSensorScheduleForm` can work |
| Lucide `Activity` icon available | **TRUE** — confirmed in `lucide-react@~1.8.0` installed |
| No `/api/sensors` route exists yet | **TRUE** — no sensors route in `src/dashboard/` |
| `sensorRunner` closure is accessible from `src/index.ts` scope | **TRUE** — constructed at lines 474-480 before `DashboardServer` construction |

---

## Metadata

**Analog search scope:** `src/dashboard/routes/`, `dashboard/src/pages/`, `dashboard/src/lib/`, `dashboard/src/components/layout/`, `dashboard/src/types/`, `src/sensors/`, `src/index.ts`, `sql/`
**Files read:** 17
**Pattern extraction date:** 2026-06-17
