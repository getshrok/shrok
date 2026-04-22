---
phase: 16
plan: "03"
subsystem: scheduler/validation
tags: [backend, api, agent-tools, validation, cron]
dependency_graph:
  requires: [isValidCadence, CADENCE_ERROR_MESSAGE]
  provides: [cadence-gate-rest, cadence-gate-tools]
  affects:
    - src/dashboard/routes/schedules.ts
    - src/sub-agents/registry.ts
    - src/dashboard/routes/schedules.test.ts
    - src/sub-agents/agents.test.ts
tech_stack:
  added: []
  patterns: [guard-before-computation, defense-in-depth, import-shared-utility]
key_files:
  created: []
  modified:
    - src/dashboard/routes/schedules.ts
    - src/sub-agents/registry.ts
    - src/dashboard/routes/schedules.test.ts
    - src/sub-agents/agents.test.ts
decisions:
  - cadence gate placed BEFORE nextRunAfter in all four sites (Pitfall 4 — avoids computing nextRun for rejected cadences)
  - Inner try/catch around nextRunAfter retained in REST handlers for defense-in-depth (isValidCadence guarantees shape but not timezone behavior)
  - update_schedule uses local cronArg variable to avoid double-cast of input['cron']
  - Tool cron descriptions updated to advertise supported shapes — prevents blind agent retry loops
  - Existing DISPATCH-03 tests did not use cron values; no migration required there
  - schedules.test.ts happy-path tests migrated from '* * * * *' to '*/30 * * * *'
metrics:
  duration: 200s
  completed: "2026-04-22"
  tasks_completed: 2
  files_created: 0
  files_modified: 4
requirements: [D-04, D-05, D-06]
---

# Phase 16 Plan 03: isValidCadence gate wired to all four server-side cron paths Summary

`isValidCadence` + `CADENCE_ERROR_MESSAGE` from Plan 01 wired into POST/PATCH REST handlers and create_schedule/update_schedule agent tools; 13 new tests (7 integration + 6 unit) pin rejection and happy-path behavior across all four sites.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Gate POST/PATCH /api/schedules with isValidCadence + integration tests | 571192c | src/dashboard/routes/schedules.ts, src/dashboard/routes/schedules.test.ts |
| 2 | Gate create_schedule/update_schedule agent tools with isValidCadence + unit tests | e127fa9 | src/sub-agents/registry.ts, src/sub-agents/agents.test.ts |

## Verification Results

- `npx vitest run src/dashboard/routes/schedules.test.ts`: 14 tests passing (7 pre-existing + 7 new)
- `npx vitest run src/sub-agents/agents.test.ts`: 61 tests passing (55 pre-existing + 6 new)
- `npx vitest run` (full suite): 1149 tests passing, 1 skipped, 0 failures
- `npx tsc --noEmit`: clean

## Final Call-Site Line Numbers for the Four Guards

| Site | File | Guard line | nextRunAfter line |
|------|------|-----------|-------------------|
| POST /api/schedules | schedules.ts:50 | `if (!isValidCadence(cron))` | line 56 (try block) |
| PATCH /api/schedules/:id | schedules.ts:106 | `if (!isValidCadence(cron))` | line 112 (try block) |
| create_schedule execute | registry.ts:753 | `if (!isValidCadence(cronArg))` | line 756 (dynamic import) |
| update_schedule execute | registry.ts:793 | `if (!isValidCadence(cronArg))` | line 796 (dynamic import) |

In every case the guard line number is less than the nextRunAfter line number — Pitfall 4 satisfied.

## Cron Description Updates

Both `create_schedule.cron` and `update_schedule.cron` property descriptions updated to:
> "Cron expression for recurring schedules. Must be one of: every N minutes (*/N * * * * with N ∈ {5,10,15,30,45,60}), hourly (M * * * *), daily (M H * * *), weekly (M H * * D), monthly (M H D * *), yearly (M H D Mo *). For custom timing logic, use the conditions argument."

## Existing Test Migrations

`schedules.test.ts` kind-validation describe block: 5 tests used `'* * * * *'` in cron position.
- Tests B, D (happy-path, expected 200): changed to `'*/30 * * * *'`
- Tests C, E, F (error-path, expected 400 for other reasons): changed to `'*/30 * * * *'` for correctness (kind/task check runs before cron check so behavior unchanged, but cron value is now accurate)

`agents.test.ts` DISPATCH-03 describe block: no tests used a cron value — all tested task-name-only invocations. No migration needed.

## Full-Suite Test Count

- Total test files: 71 (68 passed, 3 skipped)
- Total tests: 1150 (1149 passed, 1 skipped)
- New tests added this plan: 13 (7 integration in schedules.test.ts, 6 unit in agents.test.ts)

## Deviations from Plan

None — plan executed exactly as written. The DISPATCH-03 test migration was expected by the plan; confirming those tests used no cron values eliminated that step, which is a narrowing of scope (not a deviation).

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. Plan tightens the existing cron surface as designed.

## Self-Check: PASSED

- src/dashboard/routes/schedules.ts: FOUND (modified)
- src/sub-agents/registry.ts: FOUND (modified)
- src/dashboard/routes/schedules.test.ts: FOUND (modified)
- src/sub-agents/agents.test.ts: FOUND (modified)
- Commit 571192c (Task 1): FOUND
- Commit e127fa9 (Task 2): FOUND
