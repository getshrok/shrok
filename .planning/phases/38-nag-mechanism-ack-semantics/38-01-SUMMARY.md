---
phase: 38-nag-mechanism-ack-semantics
plan: "01"
subsystem: db/schedules
tags: [schema, migration, ack-semantics, ackPending, tsc-fix]
dependency_graph:
  requires: []
  provides: [ackPending-on-Schedule, SchedulePatch-ackPending, migrateLegacySchedule-ackPending]
  affects: [src/db/schedules.ts, src/db/schedules.test.ts, src/scheduler/scheduler.test.ts]
tech_stack:
  added: []
  patterns: [lazy-JSON-migration-idempotent-guard, SchedulePatch-Pick-union-extension]
key_files:
  created: []
  modified:
    - src/db/schedules.ts
    - src/db/schedules.test.ts
    - src/scheduler/scheduler.test.ts
decisions:
  - "ackPending added to SchedulePatch Pick union — this is the tsc-blocker fix required for Waves 2/3 to compile"
  - "migrateLegacySchedule uses 'ackPending' in obj guard (NOT ?? coalesce) for mtime-stable idempotency per D-03"
metrics:
  duration: 5min
  completed: "2026-05-23"
  tasks: 2
  files: 3
---

# Phase 38 Plan 01: ackPending Schema Foundation Summary

ackPending boolean added end-to-end on the Schedule type (type, options, patch, create, update, migration) with 4 new test cases covering migration default, mtime-stable idempotency, create default, and update round-trip.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add ackPending to Schedule schema and store | 4160376 | src/db/schedules.ts, src/scheduler/scheduler.test.ts |
| 2 | Extend schedules.test.ts with ackPending coverage | 51f3129 | src/db/schedules.test.ts |

## Verification

- `npx tsc --noEmit` exits 0 (SchedulePatch + apply-block extension is the gating tsc fix for the whole phase)
- `npx vitest run src/db/schedules.test.ts` exits 0, 22 tests passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] scheduler.test.ts makeSchedule fixture missing ackPending**
- **Found during:** Task 1 (tsc verification)
- **Issue:** `makeSchedule()` in `src/scheduler/scheduler.test.ts` constructs a `Schedule` object literal without `ackPending`. Adding `ackPending: boolean` as a required field to the `Schedule` interface caused `tsc --noEmit` to fail with a TS2322 error at line 68.
- **Fix:** Added `ackPending: false` to the return object in `makeSchedule()`.
- **Files modified:** `src/scheduler/scheduler.test.ts`
- **Commit:** 4160376 (bundled with Task 1 commit)

**2. [Rule 1 - Bug] Existing "fully-populated" mtime-stable test fixture missing ackPending**
- **Found during:** Task 2 (test verification)
- **Issue:** The existing test "first read of a fully-populated row ... does NOT rewrite" at line 352 had a fixture with `requiresAck: true` and `nagIntervalMinutes: 30` but no `ackPending`. After adding the `ackPending` migration guard, the first read of that fixture stamped `ackPending: false`, changing the file's mtime and failing the assertion.
- **Fix:** Added `ackPending: false` to the fully-populated fixture object in that test.
- **Files modified:** `src/db/schedules.test.ts`
- **Commit:** 51f3129 (bundled with Task 2 commit)

## Known Stubs

None — ackPending is a real field with correct defaults. No placeholder values introduced.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what the plan's threat model covers. T-38-01 mitigation (idempotent `'ackPending' in obj` guard) is implemented and pinned by the mtime-stable test. T-38-02 (cross-head information disclosure) accepted per plan — no new surface introduced.

## Self-Check: PASSED

- `src/db/schedules.ts` exists and contains `ackPending` (6 occurrences)
- `src/db/schedules.test.ts` exists and contains `ackPending` (26 occurrences)
- `src/scheduler/scheduler.test.ts` exists and contains `ackPending: false` in makeSchedule
- Commit 4160376 exists in git log
- Commit 51f3129 exists in git log
- `npx tsc --noEmit` clean
- `npx vitest run src/db/schedules.test.ts` 22/22 passing
