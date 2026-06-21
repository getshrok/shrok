---
phase: quick
plan: 260620-wl2
subsystem: scheduler
tags: [schedules, endDate, cron, dashboard, tdd]
dependency_graph:
  requires: []
  provides: [schedule-end-date]
  affects: [src/db/schedules.ts, src/scheduler/index.ts, src/sub-agents/registry.ts, src/dashboard/routes/schedules.ts, dashboard/src/pages/SchedulesPage.tsx]
tech_stack:
  added: []
  patterns: [lazy-migration, exactOptionalPropertyTypes, vi-useFakeTimers]
key_files:
  created: []
  modified:
    - src/db/schedules.ts
    - src/scheduler/index.ts
    - src/sub-agents/registry.ts
    - src/db/schedules.test.ts
    - src/scheduler/scheduler.test.ts
    - src/head/assembler.test.ts
    - src/head/head-tools.test.ts
    - src/scheduler/describe-schedule.test.ts
    - src/sub-agents/registry.test.ts
    - src/dashboard/routes/schedules.ts
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx
    - CHANGELOG.md
decisions:
  - endDate cutoff applied in scheduler tick() after computing nextRunAfter, not in getDue() — keeps one-time schedules unchanged and avoids an extra DB read per tick
  - endDate stored as ISO UTC; dashboard round-trips through workspace-local datetime-local using existing toDatetimeLocalInTz/datetimeLocalToUtc helpers
  - Agent tool uses parseModelTime/formatModelTime with 30-second past-time guard, matching existing create_schedule/create_reminder pattern
  - Lazy migration adds endDate:null to any JSON file missing the field on first read
metrics:
  duration: ~45m
  completed: 2026-06-20
  tasks_completed: 2
  files_modified: 14
---

# Quick Task 260620-wl2 Summary

Optional `endDate` cutoff on recurring schedules — auto-disable on/after a set datetime.

## What Was Built

**Task 1 — Data model + scheduler + agent tools (TDD)**

- `Schedule` interface gains `endDate: string | null` (ISO UTC)
- `migrateLegacySchedule()` lazy-migrates existing JSON files (adds `endDate: null` on first read if absent)
- `CreateScheduleOptions` and `SchedulePatch` accept `endDate`
- Scheduler `tick()`: when advancing a cron schedule, if `nextRunAfter()` result >= `endDate`, calls `scheduleStore.update(id, { enabled: false, nextRun: null })` instead of advancing — schedule silently auto-disables
- `create_schedule` and `update_schedule` agent tools accept `endDate` as `YYYY-MM-DD HH:MM` workspace-local, validated through `parseModelTime` with the standard 30-second past-time guard
- All test helper `makeSchedule()`/`makeReminder()` functions and literal `Schedule` fixture objects updated to include `endDate: null`

**Tests (RED then GREEN):**
- `src/db/schedules.test.ts`: 3 new tests — round-trip, default null, lazy migration
- `src/scheduler/scheduler.test.ts`: 2 new tests using `vi.useFakeTimers()` + `vi.setSystemTime()` — WL2-enddate-disable (disables when nextRun >= endDate) and WL2-enddate-keep (advances when nextRun < endDate)
- 68/68 tests passing

**Task 2 — Dashboard layer**

- `src/dashboard/routes/schedules.ts`: POST accepts `endDate`, validates as ISO date, stores as UTC; PATCH accepts `endDate` (null clears, string sets)
- `dashboard/src/types/api.ts`: `Schedule` interface gains `endDate: string | null`
- `dashboard/src/lib/api.ts`: `create` body type adds `endDate?: string`; `update` patch type adds `endDate?: string | null`
- `dashboard/src/pages/SchedulesPage.tsx`:
  - `AddScheduleForm`: end-date `datetime-local` picker shown when `type === 'repeating'`, wired into the create mutation
  - `ScheduleRow` edit modal: end-date picker shown when editing cron (`schedule.cron !== null`) schedules, pre-populated from existing `endDate` via `toDatetimeLocalInTz`
- `CHANGELOG.md`: entry under `## [next] → ### Added`

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 (TDD RED+GREEN) | `dfa7ebc` | feat(260620-wl2): add optional endDate to schedules — data model + scheduler cutoff |
| 2 (Dashboard) | `6ba5fed` | feat(260620-wl2): dashboard layer + CHANGELOG for schedule endDate |

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Added `endDate: null` to 4 additional test files**

- **Found during:** Task 1 GREEN (typecheck after implementing)
- **Issue:** `exactOptionalPropertyTypes` requires all `Schedule` interface fields be present in literal objects and `makeSchedule()`/`makeReminder()` helper return types. Adding `endDate` as a required field caused TS2375/TS2741 errors in `src/head/assembler.test.ts`, `src/head/head-tools.test.ts`, `src/scheduler/describe-schedule.test.ts`, and `src/sub-agents/registry.test.ts`
- **Fix:** Added `endDate: null` to the default return object in each helper and to the two literal `Schedule` objects in `registry.test.ts`
- **Files modified:** 4 test files listed above
- **Commit:** `dfa7ebc` (included in Task 1 commit)

**2. [Rule 1 - Bug] Switched from Date spy to vi.useFakeTimers() for scheduler time control**

- **Found during:** Task 1 RED (first test implementation)
- **Issue:** `vi.spyOn(globalThis, 'Date').mockImplementation(...)` did not intercept `new Date()` calls inside `tick()` in vitest — the mock produced 0 calls on `scheduleStore.update`
- **Fix:** Replaced with `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`, and `vi.setSystemTime(new Date(...))` per test — the correct vitest pattern for controlling `Date`
- **Files modified:** `src/scheduler/scheduler.test.ts`
- **Commit:** `dfa7ebc`

## Known Stubs

None.

## Threat Flags

None — `endDate` is a non-sensitive metadata field on an admin-only authenticated route. No new network endpoints or auth paths introduced.

## Self-Check

### Commits exist
- `dfa7ebc` — verified via `git log --oneline -2`
- `6ba5fed` — verified via `git log --oneline -1`

### Files modified exist
- `/home/thenasty/shrok/src/db/schedules.ts` — contains `endDate: string | null`
- `/home/thenasty/shrok/src/scheduler/index.ts` — contains `WL2-ENDDATE` comment block
- `/home/thenasty/shrok/src/sub-agents/registry.ts` — contains endDate tool parameter
- `/home/thenasty/shrok/dashboard/src/types/api.ts` — contains `endDate: string | null` in Schedule
- `/home/thenasty/shrok/dashboard/src/pages/SchedulesPage.tsx` — contains End date picker
- `/home/thenasty/shrok/CHANGELOG.md` — contains endDate changelog entry

## Self-Check: PASSED
