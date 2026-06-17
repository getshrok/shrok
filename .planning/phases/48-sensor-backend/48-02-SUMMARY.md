---
phase: 48-sensor-backend
plan: "02"
subsystem: scheduler
tags: [sensors, scheduler, kind-script, tdd, dispatch]
dependency_graph:
  requires:
    - src/sensors/runner.ts (Plan 01 — SensorRunner interface)
  provides:
    - src/db/schedules.ts (kind:'script' in Schedule.kind + CreateScheduleOptions.kind)
    - src/scheduler/index.ts (kind:'script' dispatch branch, SensorRunner injection)
    - src/index.ts (concrete SensorRunner wired into ScheduleEvaluatorImpl)
  affects:
    - src/head/assembler.ts (Plan 03 — schedule block filter for kind:'script')
    - src/head/activation.ts (Plan 03 — ambient scan)
    - src/sub-agents/tool-surface.ts (Plan 03 — ambient scan)
tech_stack:
  added: []
  patterns:
    - optional 5th constructor param for backward compat
    - fire-and-forget runner call with .catch (mirrors directHandler pattern)
    - enqueued=true set even when no queue event produced (one-time disable guard)
    - else-chain so task/reminder path is mutually exclusive with script path
key_files:
  created: []
  modified:
    - src/db/schedules.ts
    - src/scheduler/index.ts
    - src/scheduler/scheduler.test.ts
    - src/index.ts
decisions:
  - "SensorRunner imported as type-only from runner.ts (avoids circular dep)"
  - "sensorRunner stored as SensorRunner | undefined (exactOptionalPropertyTypes compliance)"
  - "Script branch placed at TOP of try block, before directHandler lookup"
  - "enqueued=true mandatory in script branch — prevents one-time re-fire every tick"
  - "else-chain (not if/continue) keeps advance block shared across all kinds"
  - "4th ctor arg passes undefined to keep intervalMs default; sensorRunner is 5th"
metrics:
  duration: "8min"
  completed: "2026-06-17"
  tasks_completed: 2
  files_created: 0
  files_modified: 4
---

# Phase 48 Plan 02: kind:'script' Schedule Dispatch Summary

**One-liner:** `kind:'script'` schedule type wired into the scheduler's tick loop with inline SensorRunner dispatch — bypasses the activation loop, queue, and model entirely (SENSOR-06), while keeping all legacy task/reminder scheduling unchanged.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1: Add 'script' to Schedule.kind unions | 0980ca1 | src/db/schedules.ts |
| 2 RED: Failing tests for kind:'script' dispatch | 26aa2ce | src/scheduler/scheduler.test.ts |
| 2 GREEN: Implement dispatch branch + SensorRunner wiring | 5e328fa | src/scheduler/index.ts, src/index.ts |

## What Was Built

### Task 1 — `src/db/schedules.ts`

Two surgical union widenings:
- `Schedule.kind`: `'task' | 'reminder'` → `'task' | 'reminder' | 'script'`
- `CreateScheduleOptions.kind`: same widening on the optional field

No new migration guard added — `taskName` already exists in all legacy schedule rows (it was in the original interface, not a later addition). The wider union is backward-compatible because existing JSON values `'task'`/`'reminder'` still satisfy it. `deleteAllForHead` bucket counting unchanged — `kind:'script'` rows fall into the `schedules` bucket by default.

### Task 2 — `src/scheduler/index.ts` + `src/index.ts` (TDD)

**RED:** 7 new test cases in `src/scheduler/scheduler.test.ts` (describe `ScheduleEvaluatorImpl — kind:script dispatch`) covering every behavior bullet:
1. `sensorRunner.run(slug)` called; `queueStore.enqueue` NOT called (SENSOR-06)
2. Cron `kind:'script'` → `advanceNextRun` called
3. One-time `kind:'script'` → `update(enabled:false)` called (proves `enqueued=true` in branch)
4. `taskName:null` → runner not called, warn logged, no throw, advance still runs
5. `kind:'task'` regression → still enqueues
6. `kind:'reminder'` regression → still enqueues
7. 4-arg construction + `kind:'script'` → no throw, advance still runs

**GREEN:** Implementation in `src/scheduler/index.ts`:
- `SensorRunner` imported as type-only (avoids circular dep on runner.ts implementation)
- Re-exported for callers that want the type
- `private sensorRunner: SensorRunner | undefined` field (`exactOptionalPropertyTypes` compliance — `SensorRunner | undefined` not `?:`)
- Optional 5th ctor param `sensorRunner?: SensorRunner` keeps existing 4-arg test construction working
- `if (schedule.kind === 'script')` branch at TOP of the try block, BEFORE the `directHandler` lookup — script path is entirely separate
  - Reads `slug = schedule.taskName`
  - If no slug: `log.warn(...)`, continue
  - If `this.sensorRunner`: fire-and-forget `.catch()` (mirrors `directHandler` pattern — errors logged, never disrupts other schedules)
  - Sets `enqueued = true` (CRITICAL — Pitfall 1 prevention: without this, one-time sensors re-fire every tick)
  - Does NOT call `queueStore.enqueue` (SENSOR-06 hard boundary)
- `else` block wraps the existing directHandler/enqueue path so it's mutually exclusive with `kind:'script'`
- The shared advance block at the bottom runs for ALL kinds (cron → advanceNextRun, one-time → update disabled)

**`src/index.ts` wiring:** Concrete `SensorRunner` object built before `ScheduleEvaluatorImpl` construction:
```typescript
const sensorRunner = {
  run(slug: string): Promise<void> {
    const scriptPath = path.join(workspacePath, 'sensors', slug, 'sensor.mjs')
    const ambientDir = path.join(workspacePath, 'ambient')
    return runSensor(slug, scriptPath, ambientDir)
  },
}
const scheduler = new ScheduleEvaluatorImpl(queue, schedules, config.timezone, undefined, sensorRunner)
```
`undefined` is passed for `intervalMs` to keep the default; `sensorRunner` is the 5th arg.

## Verification Results

```
npx vitest run src/db src/scheduler  →  341/341 tests passed
npx tsc --noEmit                     →  clean
```

No files outside the 4 modified files touched by this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] exactOptionalPropertyTypes: private field typed as `SensorRunner | undefined`**
- **Found during:** Task 2 GREEN
- **Issue:** tsc rejected `private sensorRunner?: SensorRunner` with `exactOptionalPropertyTypes: true` because the assignment `this.sensorRunner = sensorRunner` on the `undefined` path violated the constraint. The private class field has `?:` optional syntax but tsc requires the property be typed `T | undefined` when assigned from a possibly-undefined source.
- **Fix:** Changed to `private sensorRunner: SensorRunner | undefined` (not `?:`). The constructor param remains `sensorRunner?: SensorRunner` (correct optional syntax there).
- **Files modified:** src/scheduler/index.ts

**2. [Rule 1 - Bug] tsc error from Schedule.kind widening in enqueue call**
- **Found during:** Task 1 verification
- **Issue:** After widening `Schedule.kind` to include `'script'`, the existing `this.queueStore.enqueue(... kind: schedule.kind ...)` produced a tsc error because the QueueEvent.kind only accepts `'skill' | 'task' | 'reminder'`. This was expected and resolved naturally by Task 2's `else`-chain — the `kind:'script'` branch runs before the enqueue, and the TypeScript narrowing inside the `else` block means `schedule.kind` is `'task' | 'reminder'` there.
- **Fix:** Implemented as part of Task 2 GREEN (the `if (schedule.kind === 'script') { ... } else { enqueue... }` structure).
- **Files modified:** src/scheduler/index.ts

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes. T-48-05 (elevation of privilege via script dispatch) and T-48-07 (one-time re-fire DoS) are both mitigated as specified — the `kind:'script'` branch never calls `queueStore.enqueue` (pinned by test), and `enqueued=true` prevents re-fire (pinned by one-time-disable test).

## Self-Check: PASSED

- [x] src/db/schedules.ts modified — FOUND
- [x] src/scheduler/index.ts modified — FOUND
- [x] src/scheduler/scheduler.test.ts modified — FOUND
- [x] src/index.ts modified — FOUND
- [x] Commit 0980ca1 exists — FOUND
- [x] Commit 26aa2ce exists — FOUND
- [x] Commit 5e328fa exists — FOUND
- [x] `grep -c "'task' | 'reminder' | 'script'" src/db/schedules.ts` returns 2 — VERIFIED
- [x] `npx vitest run src/db src/scheduler` — 341/341 PASSED
- [x] `npx tsc --noEmit` — CLEAN
