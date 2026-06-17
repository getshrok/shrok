---
phase: 48-sensor-backend
plan: "01"
subsystem: sensors
tags: [sensors, ambient, file-io, child-process, tdd]
dependency_graph:
  requires: []
  provides:
    - src/sensors/scan.ts (scanAmbient, slugToTitle)
    - src/sensors/runner.ts (runSensor, SENSOR_OUTPUT_CAP, SENSOR_TIMEOUT_MS, SensorRunner)
  affects:
    - src/scheduler/index.ts (Plan 02 imports SensorRunner)
    - src/head/assembler.ts (Plan 03 imports scanAmbient)
    - src/head/activation.ts (Plan 03 imports scanAmbient)
    - src/sub-agents/tool-surface.ts (Plan 03 imports scanAmbient)
tech_stack:
  added: []
  patterns:
    - child_process.execFile with timeout + resolve-both-branches (mirrors executeBash)
    - write-file-atomic sync for workspace file writes
    - for...of over readdirSync (noUncheckedIndexedAccess compliance)
    - slug guard before path.join (T-48-01 path-traversal mitigation)
key_files:
  created:
    - src/sensors/scan.ts
    - src/sensors/scan.test.ts
    - src/sensors/runner.ts
    - src/sensors/runner.test.ts
  modified: []
decisions: []
metrics:
  duration: "2min"
  completed: "2026-06-17"
  tasks_completed: 2
  files_created: 4
---

# Phase 48 Plan 01: Sensor Core (scan + runner) Summary

**One-liner:** Slug-guarded child-process sensor runner writing capped stdout to `ambient/<slug>.md`, plus ambient folder scanner deriving `## SlugTitle` headings — the shared foundation every Phase 48 plan imports.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1: scanAmbient + slugToTitle | 3e0f9d3 | src/sensors/scan.ts, src/sensors/scan.test.ts |
| 2: runSensor child-process runner | 4987d3c | src/sensors/runner.ts, src/sensors/runner.test.ts |

## What Was Built

### Task 1 — `src/sensors/scan.ts`

Exports two functions:

- `slugToTitle(slug)` — splits on `-`, Title-Cases each word, joins with ` `. `'home-status'` → `'Home Status'`.
- `scanAmbient(workspaceDir)` — reads `{workspaceDir}/ambient/*.md` (sorted alphabetically), derives `## <Heading>\n<body>` for each non-empty file, joins blocks with `\n\n`. Returns `''` if the `ambient/` directory does not exist (not an error). Uses `for...of` (never index access) to comply with `noUncheckedIndexedAccess`. No `~` expansion — callers pass already-resolved paths.

The scanner ignores any `AMBIENT.md` at the workspace root — it only reads inside the `ambient/` subdirectory.

### Task 2 — `src/sensors/runner.ts`

Exports:

- `SENSOR_OUTPUT_CAP = 2_000` — max bytes of sensor stdout written per run.
- `SENSOR_TIMEOUT_MS = 30_000` — child-process kill timeout.
- `SensorRunner` interface — `{ run(slug: string): Promise<void> }` — used by the scheduler to avoid a circular dependency.
- `runSensor(slug, scriptPath, ambientDir, timeoutMs?)` — validates the slug with `/^[a-z0-9][a-z0-9-]*$/` (throws synchronously on invalid slug — the path-traversal mitigation, T-48-01), creates `ambientDir` if absent, then spawns `process.execPath [scriptPath]` via `child_process.execFile`. Both branches (success and error/timeout) call `resolve()` — the promise never rejects from inside the callback. Success writes `stdout.slice(0, SENSOR_OUTPUT_CAP)`, failure writes `⚠ Sensor failed on last run: <trimmed stderr/message>`. All writes use `write-file-atomic` sync at mode `0o644`.

## Verification Results

```
npx vitest run src/sensors  →  18/18 tests passed
npx tsc --noEmit            →  clean
```

No files outside `src/sensors/` modified.

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. The slug guard (T-48-01) is the only security-relevant change, and it is implemented as specified.

## Self-Check: PASSED

- [x] `src/sensors/scan.ts` exists — FOUND
- [x] `src/sensors/scan.test.ts` exists — FOUND
- [x] `src/sensors/runner.ts` exists — FOUND
- [x] `src/sensors/runner.test.ts` exists — FOUND
- [x] Commit 3e0f9d3 exists — FOUND
- [x] Commit 4987d3c exists — FOUND
