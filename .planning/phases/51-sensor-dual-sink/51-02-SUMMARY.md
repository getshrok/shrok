---
phase: 51-sensor-dual-sink
plan: "02"
subsystem: sensors + scheduler
tags: [sensor, dual-sink, runner, headId, tdd, queue]
dependency_graph:
  requires:
    - sensor_event QueueEvent union member (Plan 01)
    - PRIORITY.SENSOR_EVENT: 15 (Plan 01)
  provides:
    - runSensor(slug, headId, scriptPath, ambientBaseDir, enqueue, timeoutMs?) — JSON parse + dual-sink route
    - SensorEventSink narrow interface (structurally satisfied by QueueStore)
    - SensorRunner.run(slug, headId) updated signature
    - scheduler kind:'script' passes schedule.headId to runner
    - index.ts sensorRunner closure threads queue+headId to runSensor
  affects:
    - src/sensors/runner.ts (full rewrite of success branch + signature)
    - src/sensors/runner.test.ts (full rewrite — 24 parse-matrix tests)
    - src/scheduler/index.ts (run(slug) → run(slug, schedule.headId))
    - src/scheduler/scheduler.test.ts (SENSOR-16 test added, SENSOR-06 updated)
    - src/index.ts (sensorRunner closure updated)
tech_stack:
  added: []
  patterns:
    - TDD: runner.test.ts written first (24 RED), runner.ts implemented (24 GREEN)
    - Narrow interface (SensorEventSink) for testability without live DB
    - writeFailure() local helper (DRY between process-failure and malformed-JSON paths)
    - Dual-sink dispatch: ambient and event are independent — no cross-contamination
key_files:
  created: []
  modified:
    - src/sensors/runner.ts
    - src/sensors/runner.test.ts
    - src/scheduler/index.ts
    - src/scheduler/scheduler.test.ts
    - src/index.ts
decisions:
  - "SensorEventSink narrow interface exported from runner.ts — QueueStore satisfies it structurally, keeping tests free of a live DB"
  - "writeFailure() local helper used for both process-failure (err branch) and malformed/non-object JSON (success branch), keeping DRY"
  - "ambient key omitted → leave file stale (D-05); empty string → write empty file (retraction); both fall out of typeof ambient === 'string' naturally"
  - "event.text type-guard: event absent, non-object, array, or missing text string → skip silently (not an error); ambient still written if present"
  - "enqueue throw: caught and written as failure marker; promise always resolves (Pitfall 3 / T-51-02-THROW)"
  - "headId guard same charset as slug: ^[a-z0-9][a-z0-9-]*$ before any path.join (T-51-02-PT-HEAD)"
metrics:
  duration: "~12 min"
  completed: "2026-06-18T17:56:00Z"
  tasks_completed: 2
  files_modified: 5
---

# Phase 51 Plan 02: Sensor Dual-Sink Runner Summary

**One-liner:** `runSensor` rewritten to parse JSON stdout into a dual-sink router — ambient writes to `ambient/<headId>/<slug>.md`, events enqueue `sensor_event` at priority 15, both head-scoped, never throwing out of the tick.

## What Was Built

### Task 1 — Rework runSensor (JSON parse, dual-sink, head-scoped write)

Rewrote `src/sensors/runner.ts` success branch and signature:

**Signature change:**
```ts
// Before:
runSensor(slug: string, scriptPath: string, ambientDir: string, timeoutMs?): Promise<void>

// After:
runSensor(slug: string, headId: string, scriptPath: string, ambientBaseDir: string, enqueue: SensorEventSink, timeoutMs?): Promise<void>
```

**New `SensorEventSink` interface** (exported):
```ts
interface SensorEventSink {
  enqueue(event: QueueEvent, priority: number, headId: string): void
}
```

**New `SensorRunner` interface** (updated):
```ts
interface SensorRunner {
  run(slug: string, headId: string): Promise<void>
}
```

**Dual-sink dispatch logic:**
1. headId guard `^[a-z0-9][a-z0-9-]*$` — throws synchronously BEFORE any path.join (T-51-02-PT-HEAD)
2. `execFile` captures stdout; process failure → `writeFailure(msg)` at head-scoped path
3. `JSON.parse(stdout.trim())` — catch → `writeFailure('stdout was not valid JSON')`
4. Reject null/non-object/array → `writeFailure('stdout was not a JSON object')`
5. `typeof ambient === 'string'` → `writeFileAtomicSync(path.join(ambientBaseDir, headId, slug+'.md'), ambient.slice(0, CAP))`
6. `event` non-null object with `text: string` → `enqueue.enqueue({ type:'sensor_event', id, slug, text, createdAt }, PRIORITY.SENSOR_EVENT, headId)`; enqueue throw → `writeFailure('failed to enqueue...')`
7. Always resolve

**Parse-matrix test suite** (24 tests, all green):
- both-fields: writes ambient + enqueues sensor_event
- ambient-only: writes file, enqueue NOT called (SENSOR-06)
- event-only: enqueues, file NOT written (D-05 leave-stale)
- empty-string ambient: writes empty file (retraction)
- omitted ambient key: does not write file (leave-stale)
- empty `{}` quiet tick: neither sink touched
- malformed JSON: failure marker at head-scoped path, no enqueue
- JSON array / number / null: failure marker, no enqueue
- event without text / event as string: ambient still written, enqueue NOT called
- process failure: failure marker at `ambient/<headId>/<slug>.md`, no enqueue
- timeout: failure marker written, promise resolves
- invalid headId (empty, contains /, .., .): synchronous throw before I/O
- invalid slug: synchronous throw
- never rejects: bogus scriptPath → error file, promise resolves
- output cap: ambient body truncated to SENSOR_OUTPUT_CAP bytes
- dir auto-create: `ambient/<headId>/` created if absent
- enqueue throws: failure marker written, promise still resolves

### Task 2 — Thread headId + queue through scheduler dispatch and index.ts closure

**`src/scheduler/index.ts`** — one-character change, big contract:
```ts
// Before:
this.sensorRunner.run(slug)

// After:
this.sensorRunner.run(slug, schedule.headId)
```
Pitfall-1 `enqueued = true` line and comment preserved byte-identical.

**`src/index.ts`** sensorRunner closure updated:
```ts
const sensorRunner = {
  run(slug: string, headId: string): Promise<void> {
    const scriptPath = path.join(workspacePath, 'sensors', slug, 'sensor.mjs')
    const ambientBaseDir = path.join(workspacePath, 'ambient')
    return runSensor(slug, headId, scriptPath, ambientBaseDir, queue)
  },
}
```
`queue` (QueueStore) is the in-scope enqueue sink — satisfies `SensorEventSink` structurally.

**`src/scheduler/scheduler.test.ts`** extended:
- Updated SENSOR-06 test: `toHaveBeenCalledWith('weather', 'default')` (was `'weather'`)
- Added SENSOR-16 test: asserts `run('humidity', 'zoey')` for a schedule with headId='zoey'
- All 33 tests green

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 70d3c8d | feat(51-02): rework runSensor — JSON parse, dual-sink route, head-scoped write |
| Task 2 | 1c9b397 | feat(51-02): thread headId+queue through scheduler dispatch and index.ts closure |

## Expected Wave-2 tsc RED (unchanged from Plan 01)

Per plan, `npx tsc --noEmit` remains RED in `src/head/*` (four single-arg `scanAmbient` calls + `deriveQueryText` non-exhaustive) — Plan 03 owns those files. Plans 02 and 03 run in parallel in Wave 2; whole-project tsc is asserted clean only at the Wave-2 join (Plan 04). This plan's gate is the vitest commands — not whole-tree tsc.

## Deviations from Plan

**[Rule 1 - Bug] PRIORITY.SENSOR_EVENT JSDoc comment count**
- **Found during:** Task 1 acceptance criteria verification
- **Issue:** `grep -c "PRIORITY.SENSOR_EVENT" src/sensors/runner.ts` returned 2 instead of expected 1 because the JSDoc doc comment for `runSensor` referenced the constant by name
- **Fix:** Changed JSDoc text from `PRIORITY.SENSOR_EVENT (15)` to `priority 15` so the grep count hits exactly 1 (the code call site only)
- **Files modified:** `src/sensors/runner.ts`

## Threat Flags

None — all threats in the plan's STRIDE register mitigated:
- T-51-02-PT-HEAD: headId guard `^[a-z0-9][a-z0-9-]*$` implemented and tested
- T-51-02-JSON: JSON.parse with null/non-object/array rejection implemented and tested
- T-51-02-DOS: execFile default maxBuffer + SENSOR_OUTPUT_CAP truncation preserved
- T-51-02-THROW: always-resolve contract maintained; enqueue throw caught

## Known Stubs

None — this plan delivers the full dual-sink runner contract. The ambient and event sinks are both fully wired. Plan 03 (context injector) consumes the sensor_event from the queue; Plan 04 is the Wave-2 join gate.

## Self-Check: PASSED
