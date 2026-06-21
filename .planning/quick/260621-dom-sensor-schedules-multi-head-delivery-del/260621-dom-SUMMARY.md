---
phase: quick-260621-dom
plan: 01
subsystem: sensors
tags: [sensors, multi-head, fan-out, scheduler, dashboard]
decisions:
  - "Sub-agent trigger carries raw deliverToHeadIds (not deduped from owner) so Phase-44 completeAgent fan-out includes all requested extras without needing to exclude the owner"
  - "Failure-marker writes stay owner-head-only (not fanned out) — failure paths run before the success fan-out branch"
  - "SensorRunner interface updated to optional deliverToHeadIds so all existing callers compile unchanged"
  - "deliverToHeadIds route error message changed from 'task schedules' to 'reminder schedules' — accepts task + script, rejects only reminder"
tech-stack:
  modified: [TypeScript, React, Express, Vitest]
key-files:
  modified:
    - src/sensors/runner.ts
    - src/index.ts
    - src/scheduler/index.ts
    - src/types/core.ts
    - src/head/activation.ts
    - src/dashboard/routes/schedules.ts
    - src/db/schedules.ts
    - src/sensors/runner.test.ts
    - src/dashboard/routes/schedules.test.ts
    - dashboard/src/pages/SchedulesPage.tsx
metrics:
  duration: ~12min
  completed: 2026-06-21
---

# Quick Task 260621-dom: Sensor schedule multi-head fan-out SUMMARY

**One-liner:** Run-once fan-out for `kind:'script'` sensor schedules — identical output delivered to `dedupe([owner, ...deliverToHeadIds])` heads via ambient write + per-head `sensor_event` + single `sensor_sub_agent_trigger` carrying Phase-44 delivery set.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Backend run-once fan-out | 38c87bf | 7 source files |
| 2 | Tests + dashboard head-picker | ec574a8 | 3 files |

## What Changed

### Task 1 — Backend

**`src/sensors/runner.ts`**
- Added `deliverToHeadIds: string[] = []` as last optional param to `runSensor`
- Charset guard applied to each extra head before any I/O (same `/^[a-z0-9][a-z0-9-]*$/` test)
- `deliverySet = [...new Set([headId, ...deliverToHeadIds])]` computed after guards
- Ambient sink: loops `deliverySet`, writes identical body to `ambient/<hid>/<slug>.md` per head
- Head event sink: loops `deliverySet`, enqueues one `sensor_event` per head with that head's id as 3rd enqueue arg
- Sub-agent sink: ONE trigger to owner head; `deliverToHeadIds` carried on the event (absent when empty)
- `SensorRunner` interface: `run()` now accepts optional `deliverToHeadIds?: string[]`

**`src/index.ts`** — concrete `sensorRunner.run` accepts + forwards `deliverToHeadIds` via `undefined` for `timeoutMs`

**`src/scheduler/index.ts`** — call site passes `schedule.deliverToHeadIds ?? []`

**`src/types/core.ts`** — `sensor_sub_agent_trigger` variant gains `deliverToHeadIds?: string[]`

**`src/head/activation.ts`** — `handleSensorSubAgentTrigger` threads `event.deliverToHeadIds` into spawn options

**`src/dashboard/routes/schedules.ts`**
- POST guard: `kind === 'task' || kind === 'script'` (was `task`-only)
- PATCH guard: `existing.kind === 'reminder'` (was `!== 'task'`)
- Error message updated: "not valid for reminder schedules"

**`src/db/schedules.ts`** — doc comment updated to cover task + script kinds

### Task 2 — Tests + Dashboard

**`src/sensors/runner.test.ts`** — new `describe('runSensor — multi-head fan-out')` with 6 cases:
- owner + [bob, carol]: ESM counter file proves script ran exactly once; 3 ambient files identical; 3 sensor_events with correct headIds; 1 sub-agent trigger to owner with deliverToHeadIds=['bob','carol']
- dedupe: owner in extras → only 2 ambient dirs; 2 sensor_events; trigger carries raw extra list
- empty extras: owner-only, no deliverToHeadIds key on trigger
- omitted param default: same as empty
- invalid extra head id (contains /): throws before I/O
- invalid extra head id (empty): throws

**`src/dashboard/routes/schedules.test.ts`** — 5 new sensor cases in existing `deliverToHeadIds` describe:
- POST script with `[b]` persists deduped set
- POST script dedup [b,b] → [b]
- POST reminder → 400 with 'reminder' in error
- POST script unknown head → 404
- PATCH script add then clear → correct behavior
- Existing reminder test updated: checks `'reminder'` in error (not old `'task schedules'`)

**`dashboard/src/pages/SchedulesPage.tsx`**
- `SensorScheduleRow`: `editDeliverToHeadIds` state, `headsQuery`, seed from `schedule.deliverToHeadIds` in `startEdit()`, `deliverUnchanged` guard in `commitEdit()`, `deliverToHeadIds` in both `mutate()` calls, "Also deliver to" multi-select in edit modal, head chip display widened to show full delivery set (matching task row)
- `AddSensorScheduleForm`: `deliverToHeadIds` state, "Also deliver to" multi-select (filtered, conditional on >0 other heads), included in `createMutation` call

## Deviations from Plan

None — plan executed exactly as written.

## Verification Gates

- `npx tsc --noEmit` (root): PASSED
- `cd dashboard && npx tsc --noEmit`: PASSED
- `npx vitest run src/sensors/runner.test.ts src/dashboard/routes/schedules.test.ts`: PASSED (95/95)
- `git status` — `dashboard/dist/` not staged: VERIFIED

## Self-Check

- src/sensors/runner.ts: exists, modified
- src/types/core.ts: exists, deliverToHeadIds field added
- src/head/activation.ts: exists, threading confirmed
- src/dashboard/routes/schedules.ts: exists, guards updated
- Commits 38c87bf and ec574a8: both present on main
