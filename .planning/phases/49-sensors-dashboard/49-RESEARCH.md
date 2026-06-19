# Phase 49: Sensors Dashboard — Research

**Researched:** 2026-06-17
**Domain:** React dashboard CRUD UI + Express route layer, extending SchedulesPage for a new schedule kind
**Confidence:** HIGH — all findings are from direct codebase inspection

---

<user_constraints>
## User Constraints (from CLAUDE.md / AGENTS.md)

### Locked Decisions (from project rules)
- **Trunk-based git**: commit straight to `main`; NO feature branches, NO PRs unless explicitly requested.
- **`dashboard/dist/` is CI-only**: never `git add dashboard/dist/` — CI rebuilds and commits it.
- **No custom CSS in VMS apps**: not applicable (shrok uses Tailwind + React, not VMS shell). Shrok dashboard has its own styling conventions — use Tailwind classes consistent with existing components.
- **`moduleResolution: bundler`**: all TypeScript imports use `.js` extensions that resolve to `.ts` files.
- **`noUncheckedIndexedAccess`**: array index access always yields `T | undefined`; null-check before use.
- **`exactOptionalPropertyTypes`**: omit optional keys rather than setting them to `undefined`.
- **SSE not WebSocket**: server-to-client updates use `EventSource` at `/api/stream`.
- **Model-facing time invariant**: `YYYY-MM-DD HH:MM` only at model boundaries; internal storage stays ISO UTC.
- **Config vs env**: secrets in `.env`, behavioral settings in `config.json`.
- **Changelog**: update `CHANGELOG.md` for user-facing changes; never reference internal planning artifacts.

### Claude's Discretion
- Component naming and internal structure of the new `SensorsPage.tsx`.
- Whether `AddSensorScheduleForm` is a separate component or a mode on the existing `AddScheduleForm`.
- Icon choice for the Sensors nav item (must be from Lucide, consistent with sidebar).
- Test file placement and naming, consistent with `src/**/*.test.ts` glob.

### Deferred Ideas (OUT OF SCOPE)
- SENSOR-F-01: Per-head ambient scoping.
- SENSOR-F-02: Inline run-now / last-status / last-error per sensor row in the dashboard.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SENSOR-01 | Operator can create a sensor (name + script body) in a dedicated dashboard "Sensors" section, parallel to Tasks. | New `SensorsPage.tsx` + backend `POST /api/sensors/:slug` + sidebar nav entry. Run-on-save wired at create. |
| SENSOR-02 | Operator can edit an existing sensor's name and script body from the Sensors section. | Same page — inline editor for script body; rename via `PUT /api/sensors/:slug` (replaces file). |
| SENSOR-03 | Operator can delete a sensor from the Sensors section, removing its script and its `ambient/<slug>.md` output. | `DELETE /api/sensors/:slug` must `fs.rm` both `sensors/<slug>/sensor.mjs` AND `ambient/<slug>.md`. |
| SENSOR-04 | Operator can hand-edit a sensor's script directly on disk and the Sensors section reflects it (filesystem is source of truth). | No DB — backend reads `fs.readdirSync` on every `GET /api/sensors`. No cache, no SQLite for sensor content. |
| SENSOR-05 | Operator can schedule a sensor via existing Schedules UI (`kind:'script'`), the third schedule kind. | Backend db/schedules.ts already accepts `kind:'script'`; frontend `Schedule` type needs `'script'` added to union; `SchedulesPage` needs a `SensorScheduleRow` + a sensor-schedule create path. |
</phase_requirements>

---

## Summary

Phase 49 adds the operator-facing management surface for sensors: a new "Sensors" dashboard page for CRUD, and a new schedule-kind row in the existing Schedules page. The backend runtime (runner, scanner, ambient injection) is complete from Phase 48 — this phase is purely UI + thin API layer.

The key architectural finding is that sensors CANNOT reuse the existing `KindEditorPage` / `createKindRouter` / `SkillLoader` chain. That chain is purpose-built for YAML-frontmatter Markdown files (skills/tasks). Sensors are raw `.mjs` scripts. A dedicated `SensorsPage.tsx` (frontend) and `src/dashboard/routes/sensors.ts` (backend) are required — both are simpler than their skill/task counterparts because there is no frontmatter, no multi-file tabs, no model selector, and no skill-dep resolution.

The Schedules page is a second, smaller touch point. The backend `db/schedules.ts` already models `kind:'script'`, but the frontend `Schedule` type still has `kind: 'task' | 'reminder'` (missing `'script'`), the `AddScheduleForm` hardcodes `kind: 'task'`, and no `SensorScheduleRow` component exists. Adding sensor schedule support requires: extending the `Schedule` type union, adding a sensor-schedule create path (simplest: a new `AddSensorScheduleForm` component that omits task-only fields like `agentContext`, `relayGuidance`, `deliverToHeadIds`, and `conditions`), and adding a `SensorScheduleRow` display component.

**Primary recommendation:** build thin, purpose-specific components rather than generalizing existing ones. The sensors domain is simpler than tasks/skills — resist the temptation to share code that assumes YAML frontmatter.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Sensor CRUD (list/get/save/delete) | API/Backend | — | Filesystem-as-truth; backend owns reads/writes to `sensors/` |
| Run-on-save after create/update | API/Backend | — | `runSensor()` called server-side immediately after file write |
| Delete ambient output on sensor delete | API/Backend | — | Backend deletes `ambient/<slug>.md`; frontend never touches the filesystem |
| Sensors list display | Frontend (React) | — | `SensorsPage.tsx` fetches and renders |
| Script body editor | Frontend (React) | — | `<textarea>` or code editor in the page; sends raw `.mjs` text via `PUT` |
| Sensor schedule rows in Schedules UI | Frontend (React) | — | `SensorScheduleRow` + `AddSensorScheduleForm` in `SchedulesPage.tsx` |
| Schedule kind validation (`kind:'script'`) | API/Backend + DB | Frontend type | Backend already accepts `'script'`; frontend `Schedule` type needs update |
| Sidebar nav item | Frontend (React) | — | `Sidebar.tsx` NAV_LINKS array + NAV_ICONS map |

---

## Standard Stack

No new packages are introduced. This phase uses only what is already present.

### Core (existing — no installs)

| Library | Already In Use | Purpose |
|---------|---------------|---------|
| React + TypeScript | yes | UI components |
| Tailwind CSS (via PostCSS) | yes | Styling — match existing zinc palette |
| TanStack Query (`@tanstack/react-query`) | yes | Server-state fetching, mutations, cache invalidation |
| `lucide-react` | yes | Sidebar icon for Sensors (pick from existing set) |
| `node:fs` (Node built-in) | yes | Backend sensor directory reads/writes |
| `node:path` | yes | Path construction in route handler |
| Express | yes | `createSensorsRouter` mounts at `/api/sensors` |
| `vitest` | yes | Tests for the backend route logic |

### Package Legitimacy Audit

No new packages — section not applicable.

---

## Architecture Patterns

### Backend: `src/dashboard/routes/sensors.ts`

A new Express router, analogous to `createKindRouter` but not using `SkillLoader`. It reads raw `.mjs` files from `{workspace}/sensors/<slug>/sensor.mjs`.

```
GET    /api/sensors          → list all slugs (scan sensors/ dir)
GET    /api/sensors/:slug    → read sensor.mjs content + slug
PUT    /api/sensors/:slug    → write sensor.mjs content, then call runSensor()
DELETE /api/sensors/:slug    → delete sensors/<slug>/ dir + ambient/<slug>.md
```

**Key contract verified from Phase 48 research:**
- Slug regex: `/^[a-z0-9][a-z0-9-]*$/` — enforced in `runSensor`, must also be enforced in the new router on PUT
- Script path: `path.join(workspacePath, 'sensors', slug, 'sensor.mjs')`
- Ambient path: `path.join(workspacePath, 'ambient', slug + '.md')`
- `runSensor` always resolves (never rejects) — safe to `await` without try/catch for error propagation purposes; errors go to the ambient file

**Router factory signature (recommended):**
```typescript
// Source: inferred from src/dashboard/routes/kind.ts pattern + src/sensors/runner.ts
export function createSensorsRouter(opts: {
  workspacePath: string
  sensorRunner: { run(slug: string): Promise<void> }
}): Router
```

**Wiring in `src/dashboard/server.ts`:**

`DashboardServerOptions` currently has `tasks?: { loader: SkillLoader }`. Add:
```typescript
sensors?: {
  workspacePath: string
  sensorRunner: { run(slug: string): Promise<void> }
}
```
Then: `app.use('/api/sensors', createSensorsRouter(options.sensors))`

**Wiring in `src/index.ts`:**
The `sensorRunner` closure is already constructed (lines 470-481). Pass it along:
```typescript
// Already constructed:
const sensorRunner = { run(slug) { ... } }
// Add to DashboardServer options:
sensors: { workspacePath, sensorRunner }
```

### Frontend: `dashboard/src/pages/SensorsPage.tsx`

A new page component. Much simpler than `KindEditorPage` — no frontmatter, no multi-file tabs, no skill deps panel, no model selector.

**Recommended structure:**
```
SensorsPage
├── SensorList (left panel or top) — list of sensor slugs with edit/delete buttons
├── SensorEditor (inline or right panel) — textarea for script body + save/rename
└── NewSensorForm (inline form) — name input, initial script template, submit
```

**Pattern to borrow from `KindEditorPage`:** the two-panel layout (list sidebar + editor), the save/delete mutation patterns, and the slug-as-identifier convention. Do NOT import from `KindEditorPage` directly.

**`api.sensors` client in `dashboard/src/lib/api.ts`:**
```typescript
// Source: inferred from api.tasks pattern in api.ts
sensors: {
  list:   () => get<{ sensors: Array<{ slug: string }> }>('/api/sensors'),
  get:    (slug: string) => get<{ slug: string; content: string }>(`/api/sensors/${encodeURIComponent(slug)}`),
  save:   (slug: string, content: string) => put(`/api/sensors/${encodeURIComponent(slug)}`, { content }),
  delete: (slug: string) => del(`/api/sensors/${encodeURIComponent(slug)}`),
}
```

**React Query keys:**
- `['sensors']` — list
- `['sensors', slug]` — detail
- Invalidate `['sensors']` on save/delete mutations
- Invalidate `['sensors', slug]` on save mutation

### Frontend: Sidebar nav entry

`dashboard/src/components/layout/Sidebar.tsx` — two changes:

1. **NAV_LINKS array** (around line 182): insert `{ to: '/sensors', label: 'Sensors', end: false }` after Tasks.
2. **NAV_ICONS map** (around line 117): `Sensors: <LucideIcon>` — recommended: `Activity` or `Radio` from lucide-react (both convey "live readings"). Verify the icon exists in the installed lucide-react version before choosing.

### Frontend: Router registration

`dashboard/src/router.tsx` — add a route inside the AppShell children:
```tsx
{ path: '/sensors', element: <SensorsPage /> }
```
Import `SensorsPage` from `../pages/SensorsPage.js`.

### Frontend: Schedules UI — sensor schedule kind

Three changes to `dashboard/src/pages/SchedulesPage.tsx`:

1. **`Schedule` type** (`dashboard/src/types/api.ts` line 263): extend `kind` union:
   ```typescript
   kind: 'task' | 'reminder' | 'script'
   ```

2. **New `SensorScheduleRow` component**: similar to `ScheduleRow` but:
   - Shows sensor slug as the "target" (from `schedule.taskName` — reuse the existing field)
   - Shows a `Script` badge (small zinc chip) to distinguish from task rows
   - Omits `agentContext`, `relayGuidance`, `deliverToHeadIds` fields (those are task-only)
   - Toggle (enable/disable) and delete work the same way as `ScheduleRow`
   - Edit: only cron/runAt, no task-specific fields

3. **Sensor schedule section in `SchedulesPage`**: add a third section parallel to "Tasks" and "Reminders":
   ```tsx
   const sensorSchedules = allSchedules.filter(s => s.kind === 'script')
   ```
   With a `+ New sensor schedule` button and a new `AddSensorScheduleForm` component.

4. **`AddSensorScheduleForm`**: like `AddScheduleForm` but:
   - Fetches sensors list (`api.sensors.list`) instead of tasks list
   - Target dropdown shows sensor slugs
   - `kind: 'script'` in the `api.schedules.create(...)` call
   - Omits `headId`, `deliverToHeadIds`, `agentContext`, `relayGuidance`, `conditions` — sensor scripts are pure code, no model/head needed
   - Keeps `cron` / `runAt` / `startAt` — timing is the whole point

   Wait — check `schedules.create` backend to confirm whether `headId` is required for `kind:'script'`:

```typescript
// From src/db/schedules.ts line 96:
// kind: options.kind ?? 'task',
// The headId column is NOT NULL in the schema — verify before omitting from create call
```

   **Action for planner**: task 0 must verify the DB schema's `headId` nullability for `kind:'script'` rows. If `headId` is `NOT NULL`, the form must still pass one even for sensor schedules (default to the first available head, but don't show the picker). If it can be null for `kind:'script'`, omit it.

### System Architecture Diagram

```
Operator browser
      │
      ├─ GET /api/sensors ──────────────────────────► Express sensors router
      │                                                 └─ fs.readdirSync(sensors/)
      │
      ├─ PUT /api/sensors/:slug ────────────────────► sensors router
      │   (content: string)                             ├─ validate slug regex
      │                                                 ├─ fs.mkdirSync(sensors/slug/)
      │                                                 ├─ fs.writeFileSync(sensor.mjs)
      │                                                 └─ sensorRunner.run(slug)  ──► runSensor()
      │                                                                                 └─ writes ambient/slug.md
      │
      ├─ DELETE /api/sensors/:slug ─────────────────► sensors router
      │                                                 ├─ fs.rmSync(sensors/slug/)
      │                                                 └─ fs.rmSync(ambient/slug.md, force:true)
      │
      └─ POST /api/schedules (kind:'script') ───────► existing schedules router (unchanged)
                                                        └─ db/schedules.ts (already accepts 'script')

Next scheduler tick
      └─ ScheduleEvaluator sees kind:'script' row
          └─ sensorRunner.run(taskName) ──► runSensor()
```

### Recommended Project Structure (new files only)

```
src/
└── dashboard/
    └── routes/
        └── sensors.ts       # new — createSensorsRouter()
dashboard/src/
├── pages/
│   └── SensorsPage.tsx      # new
├── lib/
│   └── api.ts               # modified — add api.sensors
├── components/layout/
│   └── Sidebar.tsx          # modified — add nav item + icon
└── router.tsx               # modified — add /sensors route
dashboard/src/types/
└── api.ts                   # modified — Schedule.kind union
src/dashboard/
└── server.ts                # modified — add sensors?: {...} option + router mount
src/index.ts                 # modified — pass sensors: { workspacePath, sensorRunner }
src/sensors/
└── routes.test.ts           # new — unit tests for createSensorsRouter
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Slug validation | custom regex inline in route handler | Import and share the same `/^[a-z0-9][a-z0-9-]*$/` test already in `runSensor` — or duplicate it explicitly, but use the same pattern |
| Async file deletion that ignores ENOENT | try/catch around `fs.rmSync` | `fs.rmSync(path, { force: true })` — the `force` option swallows ENOENT |
| Schedule kind dispatch in SchedulesPage | a single mega-component | Three separate row components (`ScheduleRow`, `ReminderRow`, `SensorScheduleRow`) — already the established pattern |
| Script content encoding in API URL | manual `encodeURIComponent` inline | Use a helper consistent with existing `encTaskPath` in `api.ts` |

---

## Common Pitfalls

### Pitfall 1: `headId` required for `kind:'script'` schedule rows
**What goes wrong:** `api.schedules.create` is called without `headId`, the backend rejects with a DB constraint or null-check error, and the form silently fails.
**Why it happens:** The DB schema was designed for task schedules that always have a head. `kind:'script'` rows don't logically need one.
**How to avoid:** Check the `headId` column nullability in the schedules DB migration SQL before writing the form. If `NOT NULL`, pass the first available head (invisible to the user). If nullable, omit.
**Warning signs:** 500 errors on sensor schedule create.

### Pitfall 2: `Schedule.kind` union not updated in frontend type
**What goes wrong:** TypeScript type-checks pass with the old `'task' | 'reminder'` union, but `s.kind === 'script'` always returns false at runtime — sensor schedule rows appear in the task section.
**Why it happens:** `dashboard/src/types/api.ts` line 263 defines `kind: 'task' | 'reminder'`. The backend already returns `'script'` — TypeScript doesn't catch this mismatch because the fetch is untyped `any` before the cast.
**How to avoid:** Update `api.ts` type FIRST (Wave 0), verify with `tsc --noEmit` before writing the filtering logic.
**Warning signs:** `sensorSchedules.length` is always 0 even after creating a sensor schedule.

### Pitfall 3: `runSensor()` error swallowed on run-on-save
**What goes wrong:** The `PUT /api/sensors/:slug` handler awaits `sensorRunner.run(slug)` after writing the file. `runSensor` always resolves — so even if the script errors, the API returns 200 and the operator sees no immediate feedback.
**Why it happens:** `runSensor` is designed to never reject (per Phase 48 spec). The error goes to `ambient/<slug>.md` instead.
**How to avoid:** This is correct behavior by design — document it in the UI ("Script saved and run — check sensor output for errors"). Do NOT wrap `sensorRunner.run` in error-propagating logic that changes its return behavior.
**Warning signs:** Confusion when a "successfully saved" sensor produces no ambient output.

### Pitfall 4: `fs.readdirSync` on `sensors/` when the directory doesn't exist yet
**What goes wrong:** On a fresh workspace, `{workspace}/sensors/` does not exist. `fs.readdirSync` throws `ENOENT`, crashing the list endpoint.
**Why it happens:** The directory is created lazily on first sensor save, not at startup.
**How to avoid:** Either `fs.mkdirSync(sensorsDir, { recursive: true })` before the `readdirSync`, or catch `ENOENT` and return an empty array. The `recursive: true` approach is simpler.
**Warning signs:** `GET /api/sensors` returns 500 on fresh install.

### Pitfall 5: Sensor slugs and task slugs use the same `taskName` column for schedules
**What goes wrong:** The Schedules list shows sensor schedules with the same visual style as task schedules — no differentiation.
**Why it happens:** Both `kind:'task'` and `kind:'script'` rows use `taskName` to store their target identifier.
**How to avoid:** Filter and dispatch by `kind` in `SchedulesPage`, render `SensorScheduleRow` for `kind:'script'`, with a visible "Script" badge.
**Warning signs:** All scheduled items look identical regardless of kind.

### Pitfall 6: Renaming a sensor without also renaming its ambient output
**What goes wrong:** Operator renames sensor `weather` → `weather-v2`. Old `ambient/weather.md` remains and continues being injected. New `ambient/weather-v2.md` appears after next run. The old file is orphaned.
**Why it happens:** Rename = delete old slug + create new slug. The `DELETE` handler removes `ambient/<slug>.md` — this behavior must be explicitly called during a rename.
**How to avoid:** Implement rename as: (1) read old content, (2) PUT new slug with old content (triggers run), (3) DELETE old slug (removes old ambient). OR: in the PUT handler for a new slug where the source slug differs, delete the old ambient file. This is the "two-step rename" pattern from `createKindRouter`.
**Warning signs:** Multiple stale `ambient/*.md` files accumulating when sensors are renamed.

---

## Code Examples

### Backend: `createSensorsRouter` skeleton

```typescript
// Source: inferred from src/dashboard/routes/kind.ts + src/sensors/runner.ts patterns
import { Router } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export function createSensorsRouter(opts: {
  workspacePath: string
  sensorRunner: { run(slug: string): Promise<void> }
}): Router {
  const { workspacePath, sensorRunner } = opts
  const sensorsDir = path.join(workspacePath, 'sensors')
  const ambientDir = path.join(workspacePath, 'ambient')
  const router = Router()

  // GET /api/sensors — list
  router.get('/', (_req, res) => {
    fs.mkdirSync(sensorsDir, { recursive: true })
    const slugs = fs.readdirSync(sensorsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(n => SLUG_RE.test(n))
    res.json({ sensors: slugs.map(slug => ({ slug })) })
  })

  // GET /api/sensors/:slug — detail
  router.get('/:slug', (req, res) => {
    const { slug } = req.params
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    const scriptPath = path.join(sensorsDir, slug, 'sensor.mjs')
    if (!fs.existsSync(scriptPath)) { res.status(404).json({ error: 'Not found' }); return }
    const content = fs.readFileSync(scriptPath, 'utf8')
    res.json({ slug, content })
  })

  // PUT /api/sensors/:slug — create or update
  router.put('/:slug', (req, res) => {
    const { slug } = req.params
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    const { content } = req.body as { content?: string }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content required' }); return }
    const scriptDir = path.join(sensorsDir, slug)
    const scriptPath = path.join(scriptDir, 'sensor.mjs')
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(scriptPath, content, 'utf8')
    // run-on-save — always resolves, errors go to ambient file
    void sensorRunner.run(slug)
    res.json({ slug })
  })

  // DELETE /api/sensors/:slug — remove script + ambient output
  router.delete('/:slug', (req, res) => {
    const { slug } = req.params
    if (!slug || !SLUG_RE.test(slug)) { res.status(400).json({ error: 'Invalid slug' }); return }
    fs.rmSync(path.join(sensorsDir, slug), { recursive: true, force: true })
    fs.rmSync(path.join(ambientDir, `${slug}.md`), { force: true })
    res.json({ ok: true })
  })

  return router
}
```

### Frontend: `api.sensors` client addition

```typescript
// Source: inferred from existing api.tasks pattern in dashboard/src/lib/api.ts
const encSensor = (slug: string) => `/api/sensors/${encodeURIComponent(slug)}`

sensors: {
  list:   () => get<{ sensors: Array<{ slug: string }> }>('/api/sensors'),
  get:    (slug: string) => get<{ slug: string; content: string }>(encSensor(slug)),
  save:   (slug: string, content: string) =>
            put<{ slug: string }>(encSensor(slug), { content }),
  delete: (slug: string) => del<{ ok: true }>(encSensor(slug)),
},
```

### Frontend: `SensorScheduleRow` filter in SchedulesPage

```typescript
// Source: existing pattern in SchedulesPage.tsx lines 1094-1095
const taskSchedules    = allSchedules.filter(s => s.kind !== 'reminder' && s.kind !== 'script')
const sensorSchedules  = allSchedules.filter(s => s.kind === 'script')
const reminderSchedules = allSchedules.filter(s => s.kind === 'reminder')
```

### Frontend: Sidebar nav insertion

```typescript
// Source: Sidebar.tsx lines 117-130 (NAV_ICONS) and 182-192 (NAV_LINKS)
// Add to NAV_ICONS:
Sensors: Activity,  // or Radio — verify icon name in installed lucide-react

// Add to nav array after Tasks entry:
{ to: '/sensors', label: 'Sensors', end: false },
```

---

## State of the Art

| Area | Current State | Phase 49 Change |
|------|--------------|-----------------|
| Schedule kinds | `'task' \| 'reminder'` in frontend type | Add `'script'` to union |
| Sensor management | Backend runner + scanner only (no UI) | Full CRUD UI + API routes |
| Sidebar nav | Conversation, Identity, Skills, Tasks, Schedules, Memory, Docs | Add Sensors between Tasks and Schedules |
| `DashboardServerOptions` | `tasks?: { loader }` | Add `sensors?: { workspacePath, sensorRunner }` |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` |
| Quick run | `npx vitest run src/sensors/` |
| Full suite | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | File | Notes |
|--------|----------|-----------|------|-------|
| SENSOR-01 | `PUT /api/sensors/:slug` creates script dir + file | unit | `src/sensors/routes.test.ts` | Use tmp dir, verify file written |
| SENSOR-01 | `PUT` calls `sensorRunner.run(slug)` | unit | `src/sensors/routes.test.ts` | Mock sensorRunner, assert called |
| SENSOR-02 | `PUT` overwrites existing script content | unit | `src/sensors/routes.test.ts` | Pre-write file, PUT new content, verify |
| SENSOR-03 | `DELETE` removes script dir AND ambient file | unit | `src/sensors/routes.test.ts` | Pre-create both, DELETE, assert both gone |
| SENSOR-04 | `GET /api/sensors` reads live filesystem | unit | `src/sensors/routes.test.ts` | Write file directly to disk, assert GET returns it |
| SENSOR-05 | `kind:'script'` schedules appear in DB list | unit | existing `src/scheduler/scheduler.test.ts` — verify no NEW test needed (backend already tested in Phase 48) | Frontend type change is type-only, no runtime test needed |

### Wave 0 Gaps

- [ ] `src/sensors/routes.test.ts` — covers SENSOR-01..04 backend route behavior
- [ ] Verify `headId` nullability in `sql/` migrations before writing `AddSensorScheduleForm`

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Slug regex `/^[a-z0-9][a-z0-9-]*$/` validated server-side on every request — client-side validation is UX only |
| V4 Access Control | yes (existing) | Dashboard auth gates the entire `/api/` prefix via existing middleware — sensors routes inherit it |
| V6 Cryptography | no | No new crypto surface |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via slug | Tampering | Reject slugs not matching `/^[a-z0-9][a-z0-9-]*$/` BEFORE any `path.join` |
| Arbitrary script execution via sensor body | Elevation of Privilege | Intentional by design — same trust as task write-along scripts (documented in REQUIREMENTS.md "Out of Scope") |
| `ambient/<slug>.md` orphaned on partial failure | Tampering | `force: true` on `fs.rmSync` ensures ENOENT is swallowed; no partial state |

---

## Open Questions

1. **Is `headId` required for `kind:'script'` schedule rows in the DB schema?**
   - What we know: `db/schedules.ts` line 96 shows `kind: options.kind ?? 'task'`. The column definition in SQL migrations is unclear from current reading.
   - What's unclear: whether `headId` has `NOT NULL` constraint for `kind:'script'` rows.
   - Recommendation: Wave 0 task — grep `sql/` migrations for the `headId` column definition. If `NOT NULL`, the sensor schedule form must pass a default head silently. If nullable, omit it.

2. **Should the `SensorsPage` list be a sidebar list (like KindEditorPage) or a flat card grid?**
   - What we know: `KindEditorPage` uses a left-panel list with right-panel editor. This works for many items.
   - What's unclear: expected sensor count — likely small (5-20), so either works.
   - Recommendation: Use the two-panel sidebar+editor pattern for consistency with Skills/Tasks, but this is Claude's Discretion.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `sensorRunner` is accessible from `DashboardServer` options without additional refactoring | Architecture | If `sensorRunner` is not easily extracted from `src/index.ts` scope, the route wiring needs adjustment — low risk, it's already a named closure |
| A2 | lucide-react's installed version includes `Activity` or `Radio` icons | Standard Stack | Planner must verify icon availability; fallback: use `Cpu` or `BarChart2` |
| A3 | `headId` is `NOT NULL` in the schedules schema (common assumption for existing kinds) | Open Questions | If wrong, `AddSensorScheduleForm` must still accept a headId silently or the API call fails |

---

## Environment Availability

Step 2.6 SKIPPED — this phase is a code-only change. No external services or CLI tools beyond the project's existing runtime are required.

---

## Sources

### Primary (HIGH confidence — direct codebase inspection)
- `src/sensors/runner.ts` — slug regex, `runSensor` signature, always-resolves behavior
- `src/sensors/runner.test.ts` — test patterns to follow
- `src/dashboard/routes/kind.ts` — `createKindRouter` pattern (NOT reused, but referenced)
- `src/dashboard/server.ts` — `DashboardServerOptions` shape
- `src/index.ts` lines 470-481 — `sensorRunner` closure construction
- `dashboard/src/pages/SchedulesPage.tsx` — `AddScheduleForm` (kind:'task' hardcode), `ScheduleRow`, `ReminderRow`
- `dashboard/src/types/api.ts` line 263 — `Schedule.kind: 'task' | 'reminder'` (missing 'script')
- `dashboard/src/lib/api.ts` — `api.tasks` pattern to mirror
- `dashboard/src/components/layout/Sidebar.tsx` lines 117-192 — `NAV_ICONS` + `NAV_LINKS`
- `dashboard/src/pages/TasksPage.tsx` — thin wrapper pattern (sensors CANNOT follow this)
- `src/db/schedules.ts` — `kind: 'task' | 'reminder' | 'script'` already in backend type
- `.planning/REQUIREMENTS.md` — SENSOR-01..05 scope
- `.planning/phases/48-sensor-backend/48-RESEARCH.md` — Phase 48 architecture baseline

### Secondary (MEDIUM confidence)
- Inferred `createSensorsRouter` signature from composing `createKindRouter` structure with `runSensor` API

---

## Metadata

**Confidence breakdown:**
- Backend route design: HIGH — direct inspection of all relevant source files
- Frontend component strategy: HIGH — confirmed KindEditorPage is incompatible, determined simplest viable design
- Schedules UI changes: HIGH — line-level reading of SchedulesPage.tsx confirmed exact change points
- headId nullability for script schedules: LOW — requires reading SQL migration files (flagged as Open Question)

**Research date:** 2026-06-17
**Valid until:** 30 days (codebase is the source of truth; check if Phase 49 work has started before using)
