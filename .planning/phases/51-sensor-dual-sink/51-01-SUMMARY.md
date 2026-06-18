---
phase: 51-sensor-dual-sink
plan: "01"
subsystem: types + sensors
tags: [sensor, queue-event, types, tdd]
dependency_graph:
  requires: []
  provides:
    - sensor_event QueueEvent member with {type, id, slug, text, createdAt}
    - PRIORITY.SENSOR_EVENT: 15
    - scanAmbient(workspaceDir, headId) head-scoped ambient scanner
  affects:
    - src/types/core.ts (new union member + priority constant)
    - src/sensors/scan.ts (signature change)
    - src/sensors/scan.test.ts (tests updated to per-head layout)
tech_stack:
  added: []
  patterns:
    - TDD RED/GREEN on scan.ts
    - discriminated-union extension on QueueEvent
key_files:
  created: []
  modified:
    - src/types/core.ts
    - src/sensors/scan.ts
    - src/sensors/scan.test.ts
decisions:
  - "PRIORITY.SENSOR_EVENT: 15 placed between WEBHOOK (20) and SCHEDULE_TRIGGER (10) — operator-cadenced environmental push, active sibling of passive ambient sink"
  - "sensor_event fields: {type, id, slug, text, createdAt} — minimal D-02 schema, no severity/title/priority/headId"
  - "scanAmbient read path: path.join(workspaceDir, 'ambient', headId) — per T-51-01-PT no traversal guard on read side (headIds at call sites come from operator config; write-side guard is Plan 02's responsibility)"
  - "for...of loop retained in scanAmbient (noUncheckedIndexedAccess safe)"
metrics:
  duration: "~8 min"
  completed: "2026-06-18T17:37:20Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase 51 Plan 01: Sensor Dual-Sink Contract Layer Summary

**One-liner:** `sensor_event` QueueEvent union member at priority 15 + head-scoped `scanAmbient(workspaceDir, headId)` reading `ambient/<headId>/*.md`, both tested in isolation.

## What Was Built

### Task 1 — sensor_event QueueEvent type + PRIORITY.SENSOR_EVENT
Added `sensor_event` as a new discriminated-union member on `QueueEvent` in `src/types/core.ts`:
```ts
| {
    type: 'sensor_event'
    id: string
    slug: string   // which sensor — the schedule's taskName/slug
    text: string   // observation body
    createdAt: string
  }
```
Added `PRIORITY.SENSOR_EVENT: 15` between `WEBHOOK: 20` and `SCHEDULE_TRIGGER: 10`, with a doc comment justifying the placement. `QueueEventType` derives automatically (no separate edit).

### Task 2 — Head-scoped scanAmbient
Changed `scanAmbient(workspaceDir: string)` to `scanAmbient(workspaceDir: string, headId: string)` in `src/sensors/scan.ts`. The only body change: `path.join(workspaceDir, 'ambient', headId)` instead of `path.join(workspaceDir, 'ambient')`. All other behavior — `for...of` loop, `slugToTitle`, empty-body skip, `try/catch` absent-dir guard — preserved byte-identical.

Updated `src/sensors/scan.test.ts` to the per-head layout:
- All fixtures now write to `ambient/<headId>/<slug>.md` and call `scanAmbient(dir, headId)`
- Added **isolation test**: head A ('ashley') scans only its content; head B ('zoey') scans only its content; neither sees the other
- Added **absent-dir test**: `scanAmbient(dir, 'newhead')` where `ambient/newhead/` does not exist returns `''`
- 12 tests, all green

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 63044c8 | feat(51-01): add sensor_event QueueEvent type + PRIORITY.SENSOR_EVENT |
| Task 2 | 1455dd7 | feat(51-01): make scanAmbient head-scoped (workspaceDir, headId) |

## Expected Wave-1 tsc RED at Call Sites

Per the plan, `npx tsc --noEmit` shows errors at scanAmbient call sites that Plans 02/03 fix:

```
src/head/activation.ts(1140,15): error TS2554: Expected 2 arguments, but got 1.
src/head/activation.ts(1217,13): error TS2554: Expected 2 arguments, but got 1.
src/head/assembler.ts(146,28): error TS2554: Expected 2 arguments, but got 1.
src/sub-agents/tool-surface.ts(82,26): error TS2554: Expected 2 arguments, but got 1.
```

There is also one pre-existing error in `assembler.ts(41,4)` (return-type coverage unrelated to this plan). These are Wave-1 → Wave-2 contract/implementation cadence, exactly as designed. No errors originate inside `src/types/core.ts` or `src/sensors/scan.ts` themselves.

## Deviations from Plan

None — plan executed exactly as written. TDD RED/GREEN cadence followed for Task 2 (scan.test.ts updated first, tests confirmed RED, then scan.ts updated, tests confirmed GREEN).

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what the threat model already covers (T-51-01-PT accepted, T-51-01-TYPE mitigated via primitive-only fields).

## Known Stubs

None — this plan establishes type and scan contracts only. No consumer wiring in this plan (Plans 02/03 wire the consumers).

## Self-Check: PASSED
