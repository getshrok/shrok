---
phase: 16
plan: "01"
subsystem: scheduler/validation
tags: [backend, validation, cron, scheduler]
dependency_graph:
  requires: []
  provides: [isValidCadence, CADENCE_ERROR_MESSAGE]
  affects: [src/dashboard/routes/schedules.ts, src/sub-agents/registry.ts]
tech_stack:
  added: []
  patterns: [field-parse validation, TDD red-green, Set-based whitelist]
key_files:
  created:
    - src/scheduler/cadence.ts
    - src/scheduler/cadence.test.ts
  modified: []
decisions:
  - Field-parse approach chosen over regex: N ∈ {5,10,15,30,45,60} and 28-day dom cap cannot be enforced cleanly in a single regex; parsing 5 tokens with bounded integer checks is auditable and O(1)
  - JSDoc comment `*/N` pattern caused esbuild parse error (looks like block-comment terminator); fixed by spacing to `* /N` in the comment only
metrics:
  duration: 94s
  completed: "2026-04-22"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
requirements: [D-03, D-04, D-05, D-06]
---

# Phase 16 Plan 01: cadence validation utility Summary

Pure backend utility providing `isValidCadence(cron: string): boolean` and `CADENCE_ERROR_MESSAGE` constant for the six supported cadence shapes (D-03), implemented via field-parse with bounded integer validation and covered by 51 unit tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wave 0 — write failing unit tests for isValidCadence | 20d75c6 | src/scheduler/cadence.test.ts |
| 2 | Implement src/scheduler/cadence.ts to turn tests green | 2473eef | src/scheduler/cadence.ts |

## Verification Results

- `npx vitest run src/scheduler/cadence.test.ts`: 51 tests passing
- `npx tsc --noEmit`: clean (no type errors)
- All 6 cadence shapes accepted
- All rejection cases (unsupported N, out-of-bounds fields, malformed input) rejected

## Implementation Approach

Used field-parse-with-bounded-validation (RESEARCH.md Assumption A1 resolution):

1. Trim and split on whitespace — reject if not exactly 5 fields
2. Check Shape 1: `/^\*\/(\d+)$/` on `min`, all others `*`, N in `Set{5,10,15,30,45,60}`
3. Shapes 2-6: cascade through field checks (`isIntInRange` with `/^\d+$/` pre-check + `parseInt` range validation)
4. Day-of-month capped at 28 (D-03 mandate, avoids Feb/30-day month edge cases)

The function is O(1), no backtracking, no external deps.

## CADENCE_ERROR_MESSAGE

Byte-equivalent to D-05 locked string:
```
Invalid cron frequency. Supported cadences: every N minutes (*/N * * * *), hourly, daily, weekly, monthly, yearly. For custom timing logic (e.g. weekdays only, skip holidays), use the conditions argument instead of a custom cron expression.
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] JSDoc comment caused esbuild parse error**
- **Found during:** Task 2 (first test run of GREEN phase)
- **Issue:** The JSDoc block comment contained `*/N * * * *` which esbuild interpreted as a block-comment terminator (`*/`), causing a parse error
- **Fix:** Changed `*/N * * * *` to `* /N * * * *` in the comment text only; the implementation code and test strings are unaffected
- **Files modified:** src/scheduler/cadence.ts
- **Commit:** 2473eef (included in implementation commit)

## Known Stubs

None.

## Threat Flags

None — pure utility, no network endpoints, no file I/O, no schema changes.

## Self-Check: PASSED

- src/scheduler/cadence.ts: FOUND
- src/scheduler/cadence.test.ts: FOUND
- Commit 20d75c6 (test RED): FOUND
- Commit 2473eef (feat GREEN): FOUND
