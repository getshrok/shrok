---
phase: 23-timezone-aware-scheduling
plan: "03"
subsystem: dashboard-ui
tags: [dashboard, ui, cron, react, tdd]
requirements: [TZ-05, TZ-06, TZ-07]

dependency_graph:
  requires:
    - 23-01 (cadence.ts validator with weekdays + everyNDays shapes)
  provides:
    - CronPicker with full 8-cadence coverage matching backend standard set
  affects:
    - dashboard/src/components/CronPicker.tsx (sole output)
    - Any page using <CronPicker> (SchedulesPage, RemindersPage if present)

tech_stack:
  added: []
  patterns:
    - TDD (RED → GREEN): test file committed before implementation
    - Pure function export pattern for node-environment testability
    - Exhaustive switch on CadenceType (TypeScript enforces all 8 arms)

key_files:
  created:
    - dashboard/src/components/CronPicker.test.ts
  modified:
    - dashboard/src/components/CronPicker.tsx

decisions:
  - "Export parseCronToState, buildCron, formatHuman, DEFAULT_STATE for node-env testability (no DOM needed)"
  - "weekdays branch placed BEFORE weekly in parseCronToState — 1-5 is a range literal, not matched by the \\d+ weekly regex"
  - "everyNDays branch placed BEFORE monthly — 0 H */N * * shares dom-position */N which monthly's \\d+ cannot match, but ordering still explicit for clarity"
  - "handleTimeChange forces effectiveMinute=0 when cadence=everyNDays — keeps displayed HH:MM consistent with emitted cron shape"
  - "ALLOWED_DAY_INTERVALS as const array (not Set) to mirror ALLOWED_MINUTE_INTERVALS pattern and enable JSX .map()"

metrics:
  duration_minutes: 3
  completed_date: "2026-04-23"
  tasks_completed: 1
  files_changed: 2
---

# Phase 23 Plan 03: CronPicker weekdays + everyNDays Cadences Summary

**One-liner:** CronPicker extended with weekdays (M H * * 1-5) and everyNDays (0 H */N * *) cadences via TDD, closing the UI–backend grammar gap so all 8 standard-set cron shapes are picker-selectable.

## What Was Built

`dashboard/src/components/CronPicker.tsx` extended with two new cadence types matching the backend validator (`src/scheduler/cadence.ts`) shapes added in plan 23-01:

- **weekdays** — produces `M H * * 1-5`; sits between Daily and Weekly in the dropdown; preserves hour+minute on cadence switch
- **everyNDays** — produces `0 H */N * *` with N ∈ {1..7}; sits between Weekly and Monthly; exposes an "Every N days" selector (1 day / N days labels); always emits minute=0 (enforced in both `buildCron` and `handleTimeChange`)

All pure functions (`parseCronToState`, `buildCron`, `formatHuman`, `DEFAULT_STATE`) are now exported for direct testing in the node vitest environment.

## Task Summary

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | Add failing tests for weekdays + everyNDays | 7e0a5fc | CronPicker.test.ts (created) |
| GREEN | Implement weekdays + everyNDays in CronPicker | 3fdf92a | CronPicker.tsx (modified) |

## Verification

- `cd dashboard && npx tsc --noEmit` — exits 0
- `cd dashboard && npx vitest run` — 58 tests pass (20 new + 38 existing)
- `grep -c "'weekdays'" dashboard/src/components/CronPicker.tsx` → 6
- `grep -c "'everyNDays'" dashboard/src/components/CronPicker.tsx` → 9
- `grep -c "everyNDaysInterval" dashboard/src/components/CronPicker.tsx` → 8
- `grep -c "ALLOWED_DAY_INTERVALS" dashboard/src/components/CronPicker.tsx` → 4
- `grep "* * 1-5" dashboard/src/components/CronPicker.tsx` → 2 lines (buildCron + parseCronToState)
- `grep '0 ${s.hour} */${s.everyNDaysInterval}' dashboard/src/components/CronPicker.tsx` → 1 line

## Deviations from Plan

**1. [Rule 2 - Missing functionality] Export pure functions for testability**

- **Found during:** RED phase test writing
- **Issue:** `parseCronToState`, `buildCron`, `formatHuman` were all private (no exports). The vitest environment is `node` (no DOM/jsdom), so the React component cannot be mounted and tested via render. Without exports, tests cannot exercise the pure logic at all.
- **Fix:** Added `export` to `parseCronToState`, `buildCron`, `formatHuman`, and `DEFAULT_STATE`. The component default export is unchanged. No behavioral change — these were already pure functions.
- **Files modified:** `dashboard/src/components/CronPicker.tsx`
- **Commit:** 3fdf92a

## Known Stubs

None. All cadences are fully wired. The picker produces valid cron strings that pass `isValidCadence`.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes. CronPicker is a pure UI component; its outputs are validated server-side by `isValidCadence` (defense in depth, T-23-08 per plan threat register).

## Self-Check: PASSED
