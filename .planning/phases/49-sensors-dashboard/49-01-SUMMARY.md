---
phase: 49-sensors-dashboard
plan: "01"
subsystem: dashboard-api
tags: [sensors, crud, filesystem, schedules, tdd]
dependency_graph:
  requires: []
  provides: [/api/sensors CRUD router, kind:'script' schedule support]
  affects: [src/dashboard/server.ts, src/index.ts, src/dashboard/routes/schedules.ts]
tech_stack:
  added: []
  patterns: [filesystem-as-source-of-truth CRUD, requireAuth+slug-guard-first, fire-and-forget sensorRunner.run, TDD RED→GREEN]
key_files:
  created:
    - src/dashboard/routes/sensors.ts
    - src/dashboard/routes/sensors.test.ts
  modified:
    - src/dashboard/routes/schedules.ts
    - src/dashboard/server.ts
    - src/index.ts
decisions:
  - "SLUG_RE validated before any path.join in every :slug handler — T-49-01-TRAVERSAL mitigation"
  - "sensorRunner.run() is fire-and-forget (void, never await) — HTTP response returns before up-to-30s runner timeout"
  - "fs.rmSync({force:true}) on ambient/<slug>.md swallows ENOENT — T-49-01-DELETE-ENOENT mitigation"
  - "kind:'script' POST /api/schedules widening leaves the if(kind==='task') unifiedLoader check block untouched — 'script' slugs skip task-existence validation by gate"
metrics:
  duration: "3min"
  completed_date: "2026-06-17"
  tasks_completed: 3
  files_modified: 5
---

# Phase 49 Plan 01: Sensors Router + Schedules kind:'script' Summary

Delivered the backend half of the Sensors dashboard: filesystem-as-source-of-truth `/api/sensors` CRUD router (`createSensorsRouter`), wired into `DashboardServer` and `src/index.ts`, plus a surgical three-line patch to `POST /api/schedules` so `kind:'script'` is no longer 400-rejected.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Patch POST /api/schedules to accept kind:'script' | 37a4e00 | src/dashboard/routes/schedules.ts |
| 2 (RED) | Add failing sensors route tests | 1c25c5a | src/dashboard/routes/sensors.test.ts |
| 2 (GREEN) | Implement createSensorsRouter | 0b0f5dc | src/dashboard/routes/sensors.ts |
| 3 | Wire sensors router into DashboardServer + index.ts | 14df123 | src/dashboard/server.ts, src/index.ts |

## What Was Built

**`src/dashboard/routes/sensors.ts`** — `createSensorsRouter(opts: { workspacePath, sensorRunner })`:
- `GET /`: `mkdirSync(sensorsDir, {recursive:true})` then `readdirSync` filtered to SLUG_RE directories → `{sensors:[{slug}]}`
- `GET /:slug`: slug guard → 404 if `sensors/<slug>/sensor.mjs` absent → `{slug, content}`
- `PUT /:slug`: slug guard → string `content` required → `mkdirSync` → `writeFileSync` → `void sensorRunner.run(slug)` (fire-and-forget) → `{slug}`
- `DELETE /:slug`: slug guard → `rmSync(scriptDir, {recursive,force})` → `rmSync(ambient/<slug>.md, {force})` → `{ok:true}`
- `requireAuth` on every handler; SLUG_RE tested before any `path.join` on `:slug` routes

**`src/dashboard/routes/schedules.ts`** (Task 1 patch):
- Guard widened: `rawKind` now allows `'script'` alongside `'task'`/`'reminder'`
- Error message: `"kind must be 'task', 'reminder', or 'script'"`
- `kind` local typed `'task' | 'reminder' | 'script'`; `'script'` naturally skips the `if(kind==='task')` unifiedLoader check

**`src/dashboard/server.ts`**:
- Import `createSensorsRouter`
- `sensors?` option on `DashboardServerOptions`
- `if (this.opts.sensors) { app.use('/api/sensors', createSensorsRouter(this.opts.sensors)) }` after the tasks mount

**`src/index.ts`**: `sensors: { workspacePath, sensorRunner }` added to the `DashboardServer` constructor call, reusing the existing `sensorRunner` closure.

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx tsc --noEmit` exits 0
- `npx vitest run src/dashboard/routes/sensors.test.ts` — 14/14 tests pass (TDD RED→GREEN)
- `npx vitest run src/dashboard/routes/schedules.test.ts` — 46/46 tests pass (no regression from kind widening)

## TDD Gate Compliance

- RED commit (test): `1c25c5a` — 14 failing tests for `createSensorsRouter`
- GREEN commit (feat): `0b0f5dc` — all 14 tests passing

## Self-Check: PASSED

- [x] `src/dashboard/routes/sensors.ts` exists
- [x] `src/dashboard/routes/sensors.test.ts` exists
- [x] Commit 37a4e00 exists (schedules patch)
- [x] Commit 1c25c5a exists (RED test)
- [x] Commit 0b0f5dc exists (GREEN impl)
- [x] Commit 14df123 exists (wiring)
