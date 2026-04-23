---
phase: 23-timezone-aware-scheduling
plan: "02"
subsystem: scheduling-tools
tags: [scheduling, tools, llm, timezone, cronTimezone]
dependency_graph:
  requires: [23-01]
  provides: [cronTimezone-field-in-schedule-tools, create-reminder-cadence-gating]
  affects: [src/sub-agents/registry.ts, src/sub-agents/agents.test.ts]
tech_stack:
  added: []
  patterns: [dynamic-schema-description, effectiveTz-fallback-pattern, isValidCadence-gate]
key_files:
  created: []
  modified:
    - src/sub-agents/registry.ts
    - src/sub-agents/agents.test.ts
decisions:
  - cronTimezone not added to CreateScheduleOptions or Schedule (Open Question #1 scope — first-run nextRun only; tick still uses workspace timezone)
  - Not.toContain assertion scoped to 'workspace default: X' substring to avoid false failure on static IANA examples in description
metrics:
  duration_minutes: 15
  completed_date: "2026-04-23"
  tasks_completed: 2
  files_modified: 2
---

# Phase 23 Plan 02: cronTimezone Field in Scheduling Tools Summary

**One-liner:** `cronTimezone` optional field added to `create_schedule` and `create_reminder` schemas (inserted before `cron`, dynamic workspace-default description), threaded into `nextRunAfter` at create time, with `isValidCadence` gate added to `create_reminder` for parity with `create_schedule`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add cronTimezone field to create_schedule + create_reminder schemas; thread into nextRunAfter; add isValidCadence gate to create_reminder | c78cd9a | src/sub-agents/registry.ts |
| 2 | Add agents.test.ts coverage for cronTimezone field and create_reminder cadence gating | 9112863 | src/sub-agents/agents.test.ts |

## What Was Built

### Task 1 — registry.ts changes

Five concrete edits to `src/sub-agents/registry.ts`:

1. **create_schedule schema** — inserted `cronTimezone` property between `taskName` and `cron`. Description is a template literal: `Timezone the cron expression is relative to (workspace default: ${timezone}). Omit to use the workspace default...`

2. **create_schedule.execute** — added `cronTimezoneArg = input['cronTimezone']` and `effectiveTz = cronTimezoneArg ?? timezone`; passed `effectiveTz` to `nextRunAfter` instead of `timezone`.

3. **update_schedule.cron description** — expanded from 6 cadences to 8, adding `weekdays Mon–Fri (M H * * 1-5)` and `every N days (0 H */N * * with N ∈ {1..7})`.

4. **create_reminder schema** — inserted `cronTimezone` property between `message` and `triggerAt`. `cron` description updated to list all 8 cadences.

5. **create_reminder.execute** — added `isValidCadence(cronArg)` gate before the `nextRunAfter` call (returns `CADENCE_ERROR_MESSAGE` on failure); added `cronTimezoneArg` extraction and `effectiveTz` fallback.

### Task 2 — agents.test.ts additions

New `describe('phase 23: cronTimezone field', ...)` block with 8 tests:
- Property order assertions for `create_schedule` and `create_reminder` (Object.keys insertion order)
- Dynamic description content verified with two different timezone values (`America/New_York` vs `Asia/Tokyo`); assertion checks `'workspace default: Asia/Tokyo'` substring to avoid false failure on static IANA examples in the template
- `cronTimezone` not in `required` array
- `create_schedule.execute` with and without `cronTimezone` both succeed
- `create_reminder.execute` rejects `* * * * *` with `CADENCE_ERROR_MESSAGE`
- `create_reminder.execute` accepts `0 9 * * 1-5` (weekdays cadence)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed overly-strict test assertion for dynamic description**
- **Found during:** Task 2 test run
- **Issue:** The plan's template test used `expect(ctzProp2.description).not.toContain('America/New_York')` but the description template includes `"America/New_York"` as a static example IANA string (`e.g. "America/New_York", "Europe/London", "Asia/Tokyo"`), so the assertion always fails when checking the Asia/Tokyo-configured tool
- **Fix:** Changed assertion to `not.toContain('workspace default: America/New_York')` — checks the dynamic part of the description only, not the static examples
- **Files modified:** src/sub-agents/agents.test.ts
- **Commit:** 9112863

## Verification Results

- `npx tsc --noEmit` exits 0
- `npx vitest run src/sub-agents/agents.test.ts src/scheduler/cadence.test.ts src/dashboard/routes/schedules.test.ts`: 134 passed, 21 pre-existing failures (all in `spawn steward wiring` / `async sub-agent spawning` / `nested spawn tool-assembly gating` — "cannot start a transaction within a transaction" unrelated to this plan)
- All 8 new `phase 23: cronTimezone field` tests pass
- All pre-existing schedule/reminder/cadence tests pass

## Known Stubs

None. `cronTimezone` is fully wired from schema → execute → `nextRunAfter`. The scope boundary (no per-schedule persistence, tick uses workspace timezone) is an explicit design decision (Open Question #1), not a stub.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: input-passthrough | src/sub-agents/registry.ts | `cronTimezone` string passed directly to `nextRunAfter` / `cron-parser`; invalid IANA strings produce a `RangeError` caught by existing try/catch in `create_reminder` and propagate as thrown error in `create_schedule` (existing tool harness returns structured error on throw) — per T-23-04 disposition: accepted, delegated to cron-parser |

## Self-Check: PASSED

- `src/sub-agents/registry.ts` — modified, exists ✓
- `src/sub-agents/agents.test.ts` — modified, exists ✓
- Commit c78cd9a exists ✓
- Commit 9112863 exists ✓
