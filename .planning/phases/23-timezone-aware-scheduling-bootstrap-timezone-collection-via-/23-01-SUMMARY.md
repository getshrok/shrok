---
phase: 23-timezone-aware-scheduling
plan: "01"
subsystem: scheduler
tags: [scheduling, validation, cron, cadence]
completed: "2026-04-23T15:23:16Z"

dependency_graph:
  requires: []
  provides:
    - isValidCadence with 8 shapes (weekdays + everyNDays added)
    - CADENCE_ERROR_MESSAGE rewritten for phase 23 cadences
  affects:
    - src/sub-agents/registry.ts (create_schedule, update_schedule gate)
    - src/dashboard/routes/schedules.ts (POST validation gate)

tech_stack:
  added: []
  patterns:
    - ALLOWED_DAY_INTERVALS Set for O(1) N-value gating
    - weekdays branch inserted before weekly to avoid 1-5 rejection by isIntInRange(dow,0,6)
    - everyNDays branch inserted before literal-minute check using min==='0' + dom-regex discriminator

key_files:
  created: []
  modified:
    - src/scheduler/cadence.ts
    - src/scheduler/cadence.test.ts
    - src/sub-agents/agents.test.ts
    - src/dashboard/routes/schedules.test.ts

decisions:
  - weekdays checked before weekly branch because '1-5' fails isIntInRange(dow,0,6)
  - everyNDays checked before literal-minute early-return; min==='0' + dom regex is discriminator
  - ALLOWED_DAY_INTERVALS hardcoded as Set([1..7]) to reject N=0 and N>=8 at gate
  - downstream reject-tests flipped to accept in agents.test.ts and schedules.test.ts (Rule 1)

metrics:
  duration_minutes: 3
  tasks_completed: 2
  files_changed: 4
---

# Phase 23 Plan 01: Weekdays + Every-N-Days Cadence Shapes Summary

Expanded `isValidCadence` in `src/scheduler/cadence.ts` from 6 to 8 accepted cron shapes — weekdays (`M H * * 1-5`) and every-N-days (`0 H */N * *` with N ∈ {1..7}) — and rewrote `CADENCE_ERROR_MESSAGE` to name both new cadences while retaining the `conditions` escape-valve pointer.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add weekdays + everyNDays shapes to isValidCadence | c59d37d | src/scheduler/cadence.ts |
| 2 | Update cadence.test.ts + downstream tests | c59d37d | src/scheduler/cadence.test.ts, src/sub-agents/agents.test.ts, src/dashboard/routes/schedules.test.ts |

## Verification Results

- `npx vitest run src/scheduler/cadence.test.ts` — 72 tests passed
- `npx vitest run src/dashboard/routes/schedules.test.ts` — 14 tests passed
- `npx vitest run src/sub-agents/agents.test.ts` — 40 passed (21 pre-existing SQLite transaction failures, confirmed identical on base branch)
- `npx tsc --noEmit` — exit 0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Flipped downstream weekday-rejection tests to accept**
- **Found during:** Task 2 verification
- **Issue:** `agents.test.ts:1076` and `schedules.test.ts:215` both asserted `0 9 * * 1-5` returns a 400/error. After Task 1, weekdays are accepted, making these tests incorrect.
- **Fix:** Rewrote both tests to assert 200/no-error and verify the schedule is persisted with the correct cron value.
- **Files modified:** src/sub-agents/agents.test.ts, src/dashboard/routes/schedules.test.ts
- **Commit:** c59d37d

**2. [Rule 1 - Bug] Fixed JSDoc comment closing-comment parse error**
- **Found during:** Task 1 initial run
- **Issue:** `*/N * * * *` inside the JSDoc block was parsed by esbuild as a closing `*/` followed by unexpected `*`, causing a transform error.
- **Fix:** Added space in docstring cron examples (`* /N * * * *`) as the original file did.
- **Files modified:** src/scheduler/cadence.ts
- **Commit:** c59d37d

## Known Stubs

None.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The `isValidCadence` validator tightens (expands, not loosens) the trust boundary — T-23-01 and T-23-02 mitigations are implemented as specified: literal string match `'1-5'`, regex `/^\*\/(\d+)$/`, and `ALLOWED_DAY_INTERVALS` Set.

## Self-Check: PASSED

- src/scheduler/cadence.ts — FOUND
- src/scheduler/cadence.test.ts — FOUND
- src/sub-agents/agents.test.ts — FOUND
- src/dashboard/routes/schedules.test.ts — FOUND
- Commit c59d37d — FOUND
