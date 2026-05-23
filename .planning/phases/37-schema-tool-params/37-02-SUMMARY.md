---
phase: 37-schema-tool-params
plan: "02"
subsystem: sub-agents/registry
tags: [tool-surface, validation, ack, nag, create_reminder, sched-04]
dependency_graph:
  requires: [Schedule.requiresAck, Schedule.nagIntervalMinutes, CreateScheduleOptions.requiresAck, CreateScheduleOptions.nagIntervalMinutes]
  provides: [create_reminder.requiresAck, create_reminder.nagMinutes, create_reminder.nagHours, create_reminder.nagDays, nag-slot-sum, D-03-D-04-D-05-D-06-validation, SCHED-04-reword]
  affects: [src/sub-agents/registry.ts, src/sub-agents/agents.test.ts]
tech_stack:
  added: []
  patterns: [tool-boundary-validation, exactOptionalPropertyTypes-safe-conditional-assign, error-true-never-throw, cast-and-validate, nag-slot-sum]
key_files:
  created: []
  modified:
    - src/sub-agents/registry.ts
    - src/sub-agents/agents.test.ts
decisions:
  - "Appended requiresAck/nagMinutes/nagHours/nagDays after conditions in inputSchema property order — deliberate insertion to minimize future churn; property-order test updated accordingly (Pitfall 3)"
  - "nagSum computed before ack/nag coupling checks so the D-03 ceiling check (nagSum>43200) fires even when requiresAck is absent — this ensures the ceiling is always enforced regardless of coupling state"
  - "list_reminders projection extended with requiresAck/nagIntervalMinutes (lean-include, Phase 38 preparation) per PATTERNS §5 Claude's discretion"
  - "D-03 floor/ceiling, D-04, D-05 all return distinct error messages — RESEARCH Open Question 3 honored for actionable LLM feedback"
metrics:
  duration: "~4min"
  completed: "2026-05-23T16:53:00Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase 37 Plan 02: create_reminder Tool Params — ACK/NAG Surface Summary

**One-liner:** Wired `requiresAck` + `nagMinutes`/`nagHours`/`nagDays` input params into `create_reminder`, validated with strict ack↔nag coupling (D-03/04/05/06), slot-summed into stored `nagIntervalMinutes`, and reworded description for start-then-repeat (SCHED-04), with full reject and round-trip test coverage.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add ack/nag params, boundary validation, slot-sum, createOpts assignment, and reword the description | 4cfffef | src/sub-agents/registry.ts |
| 2 | Extend agents.test.ts — ack/nag rejects, slot-sum round-trip, description + param assertions, and UPDATE the property-order test | 071f6c6 | src/sub-agents/agents.test.ts |

## What Was Built

### Task 1 — registry.ts Changes

**`src/sub-agents/registry.ts`** — seven changes inside `buildReminderTools`:

1. **`list_reminders` projection (line ~918):** Extended the `.map()` to include `requiresAck: s.requiresAck` and `nagIntervalMinutes: s.nagIntervalMinutes` (lean include for Phase 38 ack flow).

2. **`create_reminder` description (SCHED-04 / D-10a/b):** Reworded to document: `triggerAt` alone = one-time; `cron` alone = recurring (first fire from cron); `triggerAt` + `cron` together = start-then-repeat. Added sentence documenting the new ack params. Removed the "Use triggerAt ... for a one-time reminder, or cron for a recurring one" framing that implied mutual exclusivity.

3. **`triggerAt` param doc:** Removed "for one-time reminders only" — now describes it as "first/start fire time; combine with cron for start-then-repeat".

4. **`inputSchema.properties` (new params, appended after `conditions`):** Added `requiresAck` (type `'boolean'`), `nagMinutes`/`nagHours`/`nagDays` (each type `'integer'`), with descriptions documenting the nag cadence, slot-sum semantics, and the 5-min floor / 30-day ceiling.

5. **Input-bag reads:** Added `requiresAckArg`, `nagMinutesArg`, `nagHoursArg`, `nagDaysArg` reads using the cast-and-validate pattern (`as boolean/number | undefined`).

6. **Validation block (T-37-04/05/06/07, D-03/04/05/06):** In order:
   - Per-slot integer guard: each present slot rejected unless `Number.isInteger(x) && x >= 0`
   - Compute `nagSum = nagMinutesArg?? 0 + nagHoursArg?? 0 × 60 + nagDaysArg?? 0 × 1440`
   - D-05: `nagSum > 0 && requiresAckArg !== true` → reject (mentioning "requiresAck")
   - D-04: `requiresAckArg === true && nagSum === 0` → reject (mentioning "nag interval")
   - D-03 floor: `requiresAckArg === true && nagSum > 0 && nagSum < 5` → reject ("at least 5 minutes")
   - D-03 ceiling: `nagSum > 43200` → reject ("30 days (43200 minutes)")
   - All return `JSON.stringify({ error: true, message })` — never throw (Shared Pattern B).

7. **createOpts assembly (exactOptionalPropertyTypes-safe):** Added:
   - `if (requiresAckArg !== undefined) createOpts.requiresAck = requiresAckArg`
   - `if (nagSum > 0) createOpts.nagIntervalMinutes = nagSum`
   The combine logic at lines 992-1003 and the scheduler are untouched (SCHED-04 is text-only per D-10).

### Task 2 — agents.test.ts New Tests (13 new `it` blocks + 1 updated)

Added to `describe('buildReminderTools')`:

- **list_reminders projection:** asserts ack-required reminder has `requiresAck:true` and `nagIntervalMinutes:60` in listed results.
- **D-04 reject:** `requiresAck:true` + no nag → `error:true`, message matches `/nag interval/i`.
- **D-05 reject:** `nagMinutes:30` without `requiresAck` → `error:true`, message matches `/requiresAck/i`.
- **D-03 floor reject:** `requiresAck:true` + `nagMinutes:3` → `error:true`, message matches `/at least 5/i`.
- **D-03 ceiling reject:** `requiresAck:true` + `nagDays:31` → `error:true`, message matches `/30 days|43200/i`.
- **V5 non-integer reject:** `nagMinutes:1.5` → `error:true`, message matches `/integer|non-negative/i`.
- **V5 negative reject:** `nagMinutes:-5` → `error:true`, message matches `/integer|non-negative/i`.
- **D-01/D-02 slot-sum round-trip:** `nagHours:1 + nagMinutes:30` → `ok:true`, stored `nagIntervalMinutes===90`, `requiresAck===true`.
- **Default path:** no ack params → stored `requiresAck:false`, `nagIntervalMinutes:null`.
- **SC3/SCHED-04 description:** `not.toMatch(/for one-time reminders only/i)` + `toMatch(/start.?then.?repeat/)`.
- **inputSchema declares new params:** all four new properties defined with correct types.

Updated in `describe('phase 23: cronTimezone field')`:

- **Property-order test (`@1453`):** Updated expected key array from `['message','cronTimezone','triggerAt','cron','conditions']` to `['message','cronTimezone','triggerAt','cron','conditions','requiresAck','nagMinutes','nagHours','nagDays']` (expected churn, RESEARCH Pitfall 3).

## Verification Results

- `npx tsc --noEmit`: CLEAN
- `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"`: 20/20 PASS (all new reject + round-trip tests green)
- `npx vitest run src/sub-agents/agents.test.ts -t "property order"`: 2/2 PASS (updated key array)
- `npx vitest run src/sub-agents/agents.test.ts -t "description"`: 2/2 PASS (SC3/SCHED-04 assertion)
- `grep -c 'nagMinutes\|nagHours\|nagDays\|requiresAck' src/sub-agents/registry.ts`: 31 (≥ 8 threshold met)
- `grep -c '1440' src/sub-agents/registry.ts`: 3 (multiplier present)
- `grep -c 'createOpts.nagIntervalMinutes = nagSum' src/sub-agents/registry.ts`: 1
- `grep -c 'createOpts.requiresAck = requiresAckArg' src/sub-agents/registry.ts`: 1
- `grep -c 'for one-time reminders only' src/sub-agents/registry.ts`: 0 (SCHED-04 reword complete)
- `grep -c 'cronExpression = cronArg' src/sub-agents/registry.ts`: 1 (combine logic untouched)
- `npx vitest run` (full suite): **1505/1505 PASS** (no regressions vs 1490 pre-phase-37 baseline — increase due to Plan 01 tests + Plan 02 tests)

## Deviations from Plan

None — plan executed exactly as written. The `nagSum > 43200` ceiling check fires regardless of `requiresAckArg` value (not conditioned on `requiresAckArg === true`) — this matches the plan's intent (a 31-day nag is unreasonable regardless of coupling state) and is consistent with the plan text "D-03 ceiling: `nagSum > 43200` → reject" which has no ack-coupling condition.

## Known Stubs

None — all new params are fully declared, validated, summed, and stored. No placeholder values or mock data.

## Threat Flags

No new trust boundaries introduced. T-37-04/T-37-05/T-37-06/T-37-07 all mitigated at the tool boundary with `{ error:true, message }` early-return validations pinned by the new reject tests.

## Self-Check: PASSED

- FOUND: src/sub-agents/registry.ts
- FOUND: src/sub-agents/agents.test.ts
- FOUND: .planning/phases/37-schema-tool-params/37-02-SUMMARY.md
- FOUND commit 4cfffef (Task 1)
- FOUND commit 071f6c6 (Task 2)
