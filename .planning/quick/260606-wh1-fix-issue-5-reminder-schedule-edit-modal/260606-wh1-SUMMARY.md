---
phase: quick-260606-wh1
plan: 01
subsystem: dashboard
tags: [bug-fix, datetime, timezone, ux]
dependency_graph:
  requires: []
  provides: [toDatetimeLocalInTz, datetimeLocalToUtc]
  affects: [dashboard/src/pages/SchedulesPage.tsx]
tech_stack:
  added: []
  patterns: [Intl.DateTimeFormat.formatToParts, offset-delta UTC conversion]
key_files:
  created:
    - dashboard/src/lib/formatTime.test.ts
  modified:
    - dashboard/src/lib/formatTime.ts
    - dashboard/src/pages/SchedulesPage.tsx
    - CHANGELOG.md
decisions:
  - "datetimeLocalToUtc uses the offset-delta technique (toLocaleString diff) rather than a full tz-offset library — matches the project's no-external-dep preference for this kind of utility"
  - "toDatetimeLocalInTz returns '' on invalid input (not String(iso)) because datetime-local inputs require a valid YYYY-MM-DDTHH:MM value or an empty string"
  - "DST-boundary caveat (~1hr/year) documented in JSDoc and accepted as a UI tradeoff"
metrics:
  duration: 6min
  completed: "2026-06-07T03:27:54Z"
  tasks_completed: 2
  files_changed: 4
---

# Phase quick-260606-wh1 Plan 01: Fix Issue #5 — Reminder/Schedule Edit Modal Blank Datetime

**One-liner:** Tz-aware `toDatetimeLocalInTz` + `datetimeLocalToUtc` helpers wired into every datetime-local field in SchedulesPage so edits pre-fill correctly and all datetimes interpret as workspace timezone.

## What Was Built

Two exported helper functions added to `dashboard/src/lib/formatTime.ts`:

- `toDatetimeLocalInTz(iso, tz)` — converts a UTC instant to `YYYY-MM-DDTHH:MM` wall-clock in an IANA timezone, suitable for `<input type="datetime-local">`. Uses `Intl.DateTimeFormat.formatToParts` with `hour12:false`; guards the hour `'24'` edge (midnight in some engines); returns `''` on invalid input.
- `datetimeLocalToUtc(local, tz)` — converts a `YYYY-MM-DDTHH:MM` wall-clock string back to a UTC ISO string via the offset-delta technique (`toLocaleString` diff). Validates format with a regex; returns `''` on empty/invalid input.

Both functions are covered by `dashboard/src/lib/formatTime.test.ts` (10 tests: fixed EST/EDT mappings, empty/invalid guards, round-trip identity for both EST and EDT instants).

`dashboard/src/pages/SchedulesPage.tsx` was updated in 6 places:
- `ScheduleRow.startEdit()` — cron-vs-once branching using `toDatetimeLocalInTz`
- `ScheduleRow.commitEdit()` — one-time path uses `datetimeLocalToUtc` instead of `new Date()`
- `ReminderRow.startEdit()` — same cron-vs-once branching
- `ReminderRow.commitEdit()` — same `datetimeLocalToUtc` replacement
- `AddScheduleForm` create mutation — both `runAt` and `startAt`
- `AddReminderForm` create mutation — both `runAt` and `startAt`

All 4 hint strings changed from "Browser local time (workspace timezone: {tz})" to "Times are in the workspace timezone ({tz})".

CHANGELOG.md: added a `### Fixed` bullet under `## [0.3.0]` closing #5.

## Verification

- `cd dashboard && npx vitest run src/lib/formatTime.test.ts` — 10/10 pass
- `cd dashboard && npm test` — 83/83 pass (5 test files)
- `npx tsc --noEmit` (root) — clean
- `cd dashboard && npx tsc --noEmit` — clean
- `dashboard/dist/` not staged

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED

- `dashboard/src/lib/formatTime.test.ts` — FOUND
- `dashboard/src/lib/formatTime.ts` — FOUND (toDatetimeLocalInTz + datetimeLocalToUtc exported)
- `dashboard/src/pages/SchedulesPage.tsx` — FOUND (import updated, 6 call sites wired)
- Commit ea84fe6 (Task 1) — FOUND
- Commit f04ed5d (Task 2) — FOUND
