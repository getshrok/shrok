---
phase: 37-schema-tool-params
plan: "01"
subsystem: db/schedules
tags: [schema, migration, ack, storage]
dependency_graph:
  requires: []
  provides: [Schedule.requiresAck, Schedule.nagIntervalMinutes, migrateLegacySchedule]
  affects: [src/db/schedules.ts, src/db/schedules.test.ts]
tech_stack:
  added: []
  patterns: [lazy-json-migration, exactOptionalPropertyTypes-safe-defaults, idempotent-in-obj-guard]
key_files:
  created: []
  modified:
    - src/db/schedules.ts
    - src/db/schedules.test.ts
    - src/scheduler/scheduler.test.ts
decisions:
  - "Renamed migrateLegacyHeadId → migrateLegacySchedule (D-08); switched to let migrated accumulator to stamp all three fields independently"
  - "SchedulePatch and update() left untouched (D-09 creation-only); no edit path for new fields this phase"
  - "scheduler.test.ts makeSchedule fixture updated to include required requiresAck/nagIntervalMinutes fields (Rule 3 auto-fix)"
metrics:
  duration: "~7min"
  completed: "2026-05-23T16:44:45Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase 37 Plan 01: Schedule Schema — requiresAck + nagIntervalMinutes Fields Summary

**One-liner:** Added `requiresAck: boolean` and `nagIntervalMinutes: number | null` to `Schedule` schema with `?? false`/`?? null` create() defaults and an extended idempotent `'field' in obj` lazy migrator renamed `migrateLegacySchedule`, plus round-trip/legacy/mtime-stable tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add ack fields to Schedule schema, create() defaults, and extended lazy migrator | fa8acd1 | src/db/schedules.ts, src/scheduler/scheduler.test.ts |
| 2 | Extend schedules.test.ts — round-trip, inert-for-tasks, legacy migration, mtime-stable | 0dbbbcc | src/db/schedules.test.ts |

## What Was Built

### Task 1 — Schema and Migrator

**`src/db/schedules.ts`** — four changes:

1. **`Schedule` interface:** Added `requiresAck: boolean` and `nagIntervalMinutes: number | null` with JSDoc comments (nagIntervalMinutes is inert when requiresAck is false per D-07).

2. **`CreateScheduleOptions` interface:** Added optional `requiresAck?: boolean` and `nagIntervalMinutes?: number | null` mirroring the `cron?`/`conditions?` pattern.

3. **`create()` method:** Added `requiresAck: options.requiresAck ?? false` and `nagIntervalMinutes: options.nagIntervalMinutes ?? null` in the object literal. The `??` defaults live here, not at call sites (exactOptionalPropertyTypes-safe per Shared Pattern A).

4. **Migrator renamed and extended:** `migrateLegacyHeadId` → `migrateLegacySchedule`; switched from early-return to a `let migrated = false` accumulator; added two independent `if (!('field' in obj))` guards (NOT `??` coalesce) for `requiresAck` and `nagIntervalMinutes`; updated all 3 call sites (get/list/getDue). The `markFired`/`advanceNextRun`/`markSkipped` mutators read via `this.get(id)` and migrate transitively.

### Task 2 — New Tests

**`src/db/schedules.test.ts`** — added 4 new tests (18 total, 14 original preserved):

- **Round-trip (SC1):** reminder with `requiresAck:true` + `nagIntervalMinutes:60` round-trips through `store.create` → `store.get`.
- **Inert-for-tasks (D-07):** `kind:'task'` row without ack fields defaults to `requiresAck:false`, `nagIntervalMinutes:null`.
- **Legacy migration (SC2/ACK-09):** pre-Phase-37 reminder JSON (no ack fields, has headId) gets defaults stamped on first read, remains due via `getDue()`.
- **Fully-populated no-rewrite (D-08):** row already containing all new fields produces `migrated:false` — no file rewrite on first `get()` (mtime + bytes stable across two reads).

## Verification Results

- `npx tsc --noEmit`: CLEAN
- `npx vitest run src/db/schedules.test.ts`: 18/18 PASS
- `npx vitest run src/db/schedules.test.ts -t "round-trip"`: 2/2 PASS
- `npx vitest run src/db/schedules.test.ts -t "legacy"`: 5/5 PASS
- `npx vitest run src/db/schedules.test.ts -t "mtime"`: 2/2 PASS
- `grep -c 'migrateLegacyHeadId' src/db/schedules.ts`: 0 (rename complete)
- `grep -c 'migrateLegacySchedule' src/db/schedules.ts`: 4 (definition + get + list + getDue)
- SchedulePatch unchanged: `requiresAck` absent from SchedulePatch type (D-09 honored)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed scheduler.test.ts makeSchedule fixture**
- **Found during:** Task 1 (tsc --noEmit after schema changes)
- **Issue:** `src/scheduler/scheduler.test.ts` line 67 `makeSchedule()` factory returned a `Schedule` object literal missing the newly-required `requiresAck` and `nagIntervalMinutes` fields, causing a single tsc TS2322 error.
- **Fix:** Added `requiresAck: false` and `nagIntervalMinutes: null` to the `makeSchedule` base literal (the `...overrides` spread preserves test flexibility).
- **Files modified:** `src/scheduler/scheduler.test.ts`
- **Commit:** fa8acd1 (same commit as Task 1)

## Known Stubs

None — all new fields are fully wired through the storage layer. No placeholder values, no mock data flowing to UI (this plan is storage tier only).

## Threat Flags

No new trust boundaries introduced. The migrator correctly preserves the existing `raw === null || typeof raw !== 'object'` null-guard (T-37-01 mitigated). The idempotent `'field' in obj` guards prevent mtime churn (T-37-02 mitigated). T-37-03 accepted (cross-head leakage already handled by Phase 35 headId isolation).

## Self-Check: PASSED

- FOUND: src/db/schedules.ts
- FOUND: src/db/schedules.test.ts
- FOUND: .planning/phases/37-schema-tool-params/37-01-SUMMARY.md
- FOUND: commit fa8acd1 (Task 1)
- FOUND: commit 0dbbbcc (Task 2)
