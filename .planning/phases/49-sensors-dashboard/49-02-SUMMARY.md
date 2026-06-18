---
phase: 49-sensors-dashboard
plan: "02"
subsystem: dashboard-ui
tags: [sensors, crud, react, tanstack-query, sidebar, filesystem]
dependency_graph:
  requires:
    - phase: 49-01
      provides: /api/sensors CRUD router with run-on-save (PUT fires sensorRunner.run fire-and-forget)
  provides:
    - SensorsPage two-panel CRUD (list + script editor + new-sensor form)
    - api.sensors client (list/get/save/delete) + encSensorPath helper
    - /sensors route in React router
    - "Sensors" sidebar nav item (Activity icon, between Tasks and Schedules)
  affects: [dashboard/src/lib/api.ts, dashboard/src/pages/SensorsPage.tsx, dashboard/src/router.tsx, dashboard/src/components/layout/Sidebar.tsx]
tech_stack:
  added: []
  patterns:
    - two-panel layout (w-56 list left, flex-1 editor right) mirroring KindEditorPage
    - TanStack Query useQuery/useMutation/invalidate pattern mirroring SchedulesPage
    - window.confirm-guarded delete
    - run-on-save fire-and-forget with in-UI hint (errors land in ambient file, not API response)
    - client-side slug derivation for UX only — server SLUG_RE is the authority
key_files:
  created:
    - dashboard/src/pages/SensorsPage.tsx
  modified:
    - dashboard/src/lib/api.ts
    - dashboard/src/router.tsx
    - dashboard/src/components/layout/Sidebar.tsx
key_decisions:
  - "api.sensors block placed after api.tasks block — structural analog, same request<T> call shape"
  - "run-on-save feedback is a static UI hint ('Saved and run — check sensor output for errors'), not a success/error response — plan Pitfall 3 design: runner errors land in ambient/<slug>.md"
  - "Client slug derivation (lowercase+trim+replace non-[a-z0-9] with -) is UX convenience only — server SLUG_RE is the authority per T-49-02-CLIENTSLUG"
  - "daemon restart required for Wave 1 backend to be picked up (DashboardServer is wired at index.ts startup) — operational note, not a code issue"
requirements-completed: [SENSOR-01, SENSOR-02, SENSOR-03, SENSOR-04]
duration: "continuation (Tasks 1-2 pre-executed, Task 3 human-verify approved)"
completed: "2026-06-18"
---

# Phase 49 Plan 02: Sensors Dashboard CRUD Summary

**Two-panel Sensors section with full create/edit/delete CRUD wired to /api/sensors, run-on-save confirmation hint, Activity icon in sidebar between Tasks and Schedules**

## Performance

- **Duration:** Tasks 1-2 executed prior session; Task 3 human-verify approved by operator
- **Completed:** 2026-06-18
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint, APPROVED)
- **Files modified:** 4

## Accomplishments

- `api.sensors` client added to `dashboard/src/lib/api.ts` (list/get/save/delete + `encSensorPath` helper), structural analog to the existing `api.tasks` block
- `SensorsPage.tsx` built as a two-panel CRUD page: left `w-56` list with delete affordances, right `flex-1` script editor (`<textarea font-mono>`) with Save + static run-on-save hint, new-sensor form with client-side slug derivation
- `/sensors` route registered in `dashboard/src/router.tsx`; `Activity` icon + "Sensors" nav entry inserted between Tasks and Schedules in `Sidebar.tsx`
- Human-verify checkpoint APPROVED: operator confirmed sidebar nav, create-on-disk (Weather sensor), run-on-save ambient output (`ambient/weather.md` with stdout), edit/save reflection, hand-edit reload (SENSOR-04 filesystem-as-truth), and delete removes both `sensors/weather/` and `ambient/weather.md`

## Task Commits

Each task was committed atomically:

1. **Task 1: Add api.sensors client** - `d8a3868` (feat)
2. **Task 2: Build SensorsPage, register route + sidebar nav** - `5db3edb` (feat)
3. **Task 3: Human-verify CRUD + run-on-save** - checkpoint APPROVED (no code commit — verification only)

## Files Created/Modified

- `dashboard/src/pages/SensorsPage.tsx` — Two-panel Sensors CRUD page; `export default function SensorsPage`; `useQuery`/`useMutation` via `api.sensors.*`; list + editor + new-sensor form + window.confirm delete
- `dashboard/src/lib/api.ts` — Added `encSensorPath(slug)` helper and `sensors: { list, get, save, delete }` block (after `tasks:` block, same `request<T>` call shape)
- `dashboard/src/router.tsx` — Added `import SensorsPage` + `{ path: '/sensors', element: <SensorsPage /> }` before `/schedules`
- `dashboard/src/components/layout/Sidebar.tsx` — Added `Activity` lucide import, `Sensors: Activity` in `NAV_ICONS`, `{ to: '/sensors', label: 'Sensors' }` between Tasks and Schedules

## Decisions Made

- `run-on-save` feedback is a static in-UI hint ("Saved and run — check sensor output for errors") rather than an API-derived status. The backend PUT fires `sensorRunner.run()` fire-and-forget (plan Pitfall 3); errors land in `ambient/<slug>.md`. No error-propagation path was added — by design.
- Client-side slug derivation (lowercase + replace non-`[a-z0-9]` with `-`) is UX convenience only; the server's `SLUG_RE` is the authority and re-validates on every PUT/DELETE.
- `dashboard/dist/` was not staged — CI is the sole writer of dist on `origin/main`.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

**Daemon restart required after Plan 01 wiring:** The running shrok daemon needed a `systemctl --user restart shrok` to pick up the `DashboardServer` wiring added in Plan 01 (`sensors:` option in `src/index.ts`). This is an expected operational step — the server reads route registration at startup. Confirmed working after restart during the human-verify checkpoint.

## Human-Verify Checkpoint: APPROVED

**Task 3** was a `checkpoint:human-verify` gate requiring operator confirmation of the full CRUD + run-on-save flow.

| Step | Verified |
|------|---------|
| Sidebar shows "Sensors" between Tasks and Schedules (Activity icon) | PASS |
| Create "Weather" sensor → `sensors/weather/sensor.mjs` on disk | PASS |
| Run-on-save → `ambient/weather.md` contains stdout output | PASS |
| Edit body + Save → `sensor.mjs` on disk reflects new content | PASS |
| Hand-edit `sensor.mjs` on disk → editor shows updated content on reload (SENSOR-04) | PASS |
| Delete → both `sensors/weather/` and `ambient/weather.md` removed | PASS |

Requirements SENSOR-01..04 confirmed end-to-end through the live dashboard UI.

## Next Phase Readiness

- SENSOR-01..04 complete and operator-verified
- Plan 49-03 (Schedules UI `kind:'script'` support — `SensorScheduleRow`, `AddSensorScheduleForm`, type widening, CHANGELOG) is unblocked

## Self-Check: PASSED

- [x] `dashboard/src/pages/SensorsPage.tsx` exists with `export default function SensorsPage`
- [x] `dashboard/src/lib/api.ts` contains `sensors:` block and `encSensorPath`
- [x] `dashboard/src/router.tsx` has `/sensors` route
- [x] `dashboard/src/components/layout/Sidebar.tsx` has `Sensors` nav entry
- [x] Commit `d8a3868` exists (Task 1 — api.sensors client)
- [x] Commit `5db3edb` exists (Task 2 — SensorsPage + route + nav)

---
*Phase: 49-sensors-dashboard*
*Completed: 2026-06-18*
