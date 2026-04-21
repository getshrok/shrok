---
phase: 14
plan: 01
subsystem: scheduler
tags: [conditions, steward, proactive, reminders, create_reminder]
dependency_graph:
  requires: []
  provides:
    - ProactiveContext.conditions field
    - ReminderDecisionContext.conditions field
    - SCHEDULE_CONDITIONS interpolation in both steward prompts
    - create_reminder conditions parameter
  affects:
    - src/scheduler/proactive.ts
    - src/scheduler/prompts/tasks.md
    - src/scheduler/prompts/reminder.md
    - src/head/activation.ts
    - src/sub-agents/registry.ts
tech_stack:
  added: []
  patterns:
    - exactOptionalPropertyTypes-safe spread pattern for optional field threading
    - Conditional block string interpolation via SCHEDULE_CONDITIONS placeholder
key_files:
  created: []
  modified:
    - src/scheduler/proactive.ts
    - src/scheduler/prompts/tasks.md
    - src/scheduler/prompts/reminder.md
    - src/head/activation.ts
    - src/scheduler/proactive.test.ts
    - src/head/activation.test.ts
    - src/sub-agents/registry.ts
    - src/sub-agents/agents.test.ts
decisions:
  - "exactOptionalPropertyTypes-safe spread pattern: use `...(x ? { conditions: x } : {})` instead of `conditions: x ?? undefined` at activation.ts call sites to avoid assigning literal undefined to optional property"
  - "Conditional block string built in interpolate vars (not in template): empty string when conditions blank/undefined, `\\n\\nRun conditions:\\n<text>\\n` when set — keeps templates clean"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-21"
  tasks_completed: 3
  files_modified: 8
---

# Phase 14 Plan 01: Conditions Backend Wiring Summary

Wire the `conditions` field end-to-end through the backend steward pipeline: both steward context interfaces carry `conditions?: string`, both prompt files expose a `{SCHEDULE_CONDITIONS}` placeholder with conditional injection, `activation.ts` threads the schedule row's conditions into both call sites using the exactOptionalPropertyTypes-safe spread pattern, and `create_reminder` accepts and persists an optional `conditions` argument.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add conditions to steward contexts and prompt files | 21bac37 | proactive.ts, tasks.md, reminder.md, proactive.test.ts |
| 2 | Thread conditions into activation.ts call sites | 9eef472 | activation.ts, activation.test.ts |
| 3 | Add conditions to create_reminder tool | 5ee33ee | registry.ts, agents.test.ts |

## What Was Built

**ProactiveContext and ReminderDecisionContext** each gained `conditions?: string`. Both `runProactiveDecision` and `runReminderDecision` compute a conditional block: when `ctx.conditions` is non-blank, `SCHEDULE_CONDITIONS` resolves to `\n\nRun conditions:\n<text>\n`; when blank or absent, it resolves to an empty string so no stray header appears in the rendered prompt.

**tasks.md and reminder.md** both received the `{SCHEDULE_CONDITIONS}` placeholder (appended to the last metadata line, before the horizontal rule) and a new Skip bullet instructing the steward to skip when run conditions are clearly not satisfied, with concrete examples.

**activation.ts** uses the spread pattern `...(schedule.conditions ? { conditions: schedule.conditions } : {})` at both call sites — the reminder branch (where `schedule` is narrowed non-null) and the task branch (where `schedule` can be undefined, using optional chaining).

**create_reminder** now declares `conditions` in its `inputSchema` and reads `conditionsArg` from input, conditionally assigning it to `CreateScheduleOptions.conditions` via the same guard pattern used by `create_schedule`.

## Tests Added

- `proactive.test.ts`: 5 new tests — conditions block present (task), absent when not set (task), absent when empty string (task), conditions block present (reminder), absent when not set (reminder)
- `activation.test.ts`: 4 new tests — task conditions threaded, null conditions → undefined (task), reminder conditions threaded, null conditions → undefined (reminder)
- `agents.test.ts`: 3 new tests — conditions stored on row, omitted conditions leaves null, inputSchema declares conditions

**Total: 80 tests pass, 0 failures.**

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] exactOptionalPropertyTypes violation in test code**
- **Found during:** Task 1 (tsc check)
- **Issue:** Tests passed `conditions: undefined` explicitly in `makeContext({ conditions: undefined })` and `makeReminderContext({ conditions: undefined })`, which violates `exactOptionalPropertyTypes` (cannot assign literal `undefined` to optional property).
- **Fix:** Changed tests to call `makeContext()` and `makeReminderContext()` with no override — the default context has no `conditions` key, achieving the same "undefined" coverage without the type error.
- **Files modified:** src/scheduler/proactive.test.ts
- **Commit:** 21bac37

## Known Stubs

None. All conditions wiring is functional end-to-end.

## Threat Flags

None. The conditions field follows the same trust boundary as `agentContext` (already present). Prompt-injection risk is accepted per T-14-01 in the plan's threat model.

## Self-Check: PASSED

- `src/scheduler/proactive.ts` — FOUND
- `src/scheduler/prompts/tasks.md` — FOUND
- `src/scheduler/prompts/reminder.md` — FOUND
- `src/head/activation.ts` — FOUND
- `src/sub-agents/registry.ts` — FOUND
- Commits 21bac37, 9eef472, 5ee33ee — all present in git log
- `npx tsc --noEmit` — exits 0
- 80 tests pass across 3 test files
