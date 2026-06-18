---
phase: 49-sensors-dashboard
plan: "03"
subsystem: dashboard-ui
tags: [sensors, schedules, react, tanstack-query, type-widening, changelog]
dependency_graph:
  requires:
    - phase: 49-01
      provides: POST /api/schedules accepts kind:'script'
    - phase: 49-02
      provides: api.sensors.list client method + SensorsPage
  provides:
    - Schedule.kind union widened to include 'script'
    - api.schedules.create body kind? widened to include 'script'
    - SensorScheduleRow (SCRIPT badge, timing-only edit)
    - AddSensorScheduleForm (sensor slug dropdown, silent headId seed, kind:'script' create)
    - Sensor Schedules third section on SchedulesPage
    - CHANGELOG entry for Sensors dashboard (closes #25)
  affects:
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx
    - CHANGELOG.md
tech_stack:
  added: []
  patterns:
    - schedule-row toggle/delete/edit-modal pattern (analog of ScheduleRow/ReminderRow)
    - add-form sensor-dropdown + hidden-headId-seed (analog of AddScheduleForm)
    - third schedule section parallel to Tasks/Reminders
    - conditional spread for exactOptionalPropertyTypes compliance
key_files:
  created: []
  modified:
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx
    - CHANGELOG.md
decisions:
  - "headId seeded silently from 'active-head' localStorage (falls back to heads[0]) — server requires headId even for kind:'script'; operator never sees the picker (T-49-03-HEADID mitigated by server-side 404 on unknown headId)"
  - "SensorScheduleRow edit modal exposes ONLY cron/runAt/conditions — agentContext, relayGuidance, deliverToHeadIds, head-picker omitted as task-only fields"
  - "taskSchedules filter widened to exclude s.kind==='script' so script rows don't render in the Tasks section"
  - "CHANGELOG bullet in user language, no internal planning identifiers, references GitHub issue #25"
metrics:
  duration: "~15min"
  completed_date: "2026-06-18"
  tasks_completed: 3
  files_modified: 4
requirements-completed: [SENSOR-05]
---

# Phase 49 Plan 03: Sensor Schedule UI Summary

**Schedule.kind widened to 'script', SensorScheduleRow + AddSensorScheduleForm added to the Schedules page, CHANGELOG updated — SENSOR-05 delivered.**

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Widen Schedule.kind union + api.schedules.create signature | 839bf96 | dashboard/src/types/api.ts, dashboard/src/lib/api.ts |
| 2 | Add SensorScheduleRow, AddSensorScheduleForm, Sensor Schedules section | 4d7545c | dashboard/src/pages/SchedulesPage.tsx |
| 3 | CHANGELOG entry for the Sensors dashboard | c995234 | CHANGELOG.md |

## What Was Built

**`dashboard/src/types/api.ts`** — `Schedule.kind` widened from `'task' | 'reminder'` to `'task' | 'reminder' | 'script'`. No other field changes.

**`dashboard/src/lib/api.ts`** — `api.schedules.create` body `kind?` widened to match. This was done before the filtering logic so `s.kind === 'script'` type-checks correctly and is no longer an always-false guard.

**`dashboard/src/pages/SchedulesPage.tsx`** — four surgical additions:

1. **Kind split** — `taskSchedules` filter updated to `s.kind !== 'reminder' && s.kind !== 'script'`; new `sensorSchedules = allSchedules.filter(s => s.kind === 'script')` added.

2. **Page state + query** — `showSensorForm` state and `sensorsQuery` (`useQuery` with `api.sensors.list`) added to `SchedulesPage`; `sensors = sensorsQuery.data?.sensors ?? []`.

3. **`SensorScheduleRow`** — mirrors `ScheduleRow` with:
   - Same toggle mutation (`api.schedules.update(id, { enabled })` → invalidate `['schedules']`)
   - Same delete mutation + `window.confirm` guard
   - `schedule.taskName` displayed as the target (sensor slug)
   - SCRIPT badge: zinc chip (`bg:#3f3f46`, `border-left:2px solid #71717a`) with text "SCRIPT"
   - Edit modal exposes cron/runAt + conditions ONLY — `agentContext`, `relayGuidance`, `deliverToHeadIds`, and head picker deliberately omitted

4. **`AddSensorScheduleForm`** — mirrors `AddScheduleForm` with:
   - Sensor slug `<select>` from the `sensors` prop (not tasks)
   - `headId` seeded via the same `readActiveHeadFromStorage()` effect (prefer stored active-head if valid, else `heads[0]!.id`) but NO head picker rendered — headId is hidden plumbing
   - `cron` / `runAt` / `startAt` / type toggle / `conditions` fields kept; `agentContext` / `relayGuidance` / `deliverToHeadIds` omitted
   - Create call: `api.schedules.create({ headId, taskName: targetSlug, kind: 'script', ...(type==='repeating' ? { cron } : { runAt: datetimeLocalToUtc(runAt, tz) }), ...(conditions ? { conditions } : {}), ...(type==='repeating' && startAt ? { startAt: datetimeLocalToUtc(startAt, tz) } : {}) })`
   - `noUncheckedIndexedAccess` honored (`heads[0]!.id`, `sensors[0]!.slug`)
   - `exactOptionalPropertyTypes` honored (conditional spread for all optional fields)

5. **Sensor Schedules section** — third section parallel to Tasks/Reminders: header with `+ New sensor schedule` / `Cancel` toggle, loading/error/empty states, `sensorSchedules.map(s => <SensorScheduleRow key={s.id} schedule={s} tz={tz} />)`, conditional `<AddSensorScheduleForm>`.

**`CHANGELOG.md`** — sensor bullet added as the first item under `## [0.3.0]` `### Added`:
> **Sensor scripts — run code on a schedule and feed the output straight to the assistant's context** — create and edit lightweight sensor scripts (JavaScript/Node) in a new dedicated "Sensors" section of the dashboard. Save a script and it runs immediately; schedule it on a cron interval through the Schedules page and shrok re-runs it automatically, making the latest output available in the model's ambient context every turn — no tool call required. Sensors appear alongside tasks and reminders in the Schedules UI with a distinct SCRIPT badge. (closes #25)

## Verification

- `cd dashboard && npx tsc --noEmit` exits 0 (clean after Task 1 and Task 2)
- `npm run build` succeeds: 2142 modules transformed, 1161 kB JS bundle, no errors
- `dashboard/dist/` left unstaged — CI is the sole writer of dist on main

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. All trust-boundary mitigations from the plan's threat model are addressed:
- T-49-03-HEADID: headId seeded from localStorage, validated server-side (existing 404-on-unknown-head behavior unchanged)
- T-49-03-AUTHZ: inherited `requireAuth` on `/api/schedules` and `/api/sensors` unchanged
- T-49-03-KINDBYPASS: `kind:'script'` skips task-existence validation by gate (Plan 01 design, unchanged)
- T-49-03-SC: no new packages installed

## Self-Check: PASSED

- [x] `dashboard/src/types/api.ts` contains `'task' | 'reminder' | 'script'` — verified via grep
- [x] `dashboard/src/lib/api.ts` contains `'task' | 'reminder' | 'script'` in create signature — verified via grep
- [x] `dashboard/src/pages/SchedulesPage.tsx` contains `SensorScheduleRow`, `AddSensorScheduleForm`, `kind: 'script'`, `sensorSchedules` — verified via grep
- [x] `CHANGELOG.md` contains sensor bullet with `#25` reference and no internal planning identifiers
- [x] Commit 839bf96 exists (Task 1)
- [x] Commit 4d7545c exists (Task 2)
- [x] Commit c995234 exists (Task 3)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm run build` succeeds
- [x] `dashboard/dist/` not staged
