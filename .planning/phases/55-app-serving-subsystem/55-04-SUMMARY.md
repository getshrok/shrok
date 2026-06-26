---
phase: "55"
plan: "04"
subsystem: app-serving-subsystem
tags: [apps, server, integration, csrf, sqlite, hot-discovery]
dependency_graph:
  requires: [55-01, 55-02, 55-03]
  provides: [server.ts /apps mount, src/apps/integration.test.ts]
  affects: [56-01, 57-01]
tech_stack:
  added: []
  patterns:
    - "CSRF carve-out: if (req.path.startsWith('/apps/')) return next() — mirrors /v1/ pattern"
    - "Mount order: app.use('/apps', ...) BEFORE express.static(distPath) and SPA GET '*' catch-all"
    - "Integration tests: express + auth bypass + CSRF replica + createAppsRouter on getFreePort"
    - "Fixture apps: .mjs (D-11b) with real @ashley-shrok/viewmodel-shell/server via workspace symlink"
    - "D-08 proof: POST sec-fetch-site:cross-site to /apps/* → 200; to /sentinel → 403"
    - "APPSRV-05 proof: direct DatabaseSync read on co-located sqlite after POST action"
key_files:
  created:
    - src/apps/integration.test.ts
  modified:
    - src/dashboard/server.ts
decisions:
  - "CSRF carve-out placed immediately after /v1/ line to match the established server.ts pattern (D-08)"
  - "apps mount placed after HA /v1 block and before distPath block to preserve SPA catch-all order (D-05)"
  - "Integration test uses beforeEach/afterEach (not beforeAll/afterAll) for per-test tmpDir isolation"
  - "CSRF negative test uses a /sentinel non-apps POST endpoint to prove the carve-out is /apps/-specific"
  - "notes2 app uses 'notes' table (not 'kv') to demonstrate per-app sqlite isolation via direct DB read"
  - "writeLateApp called mid-test (not in beforeEach) to prove hot discovery works with no restart"
metrics:
  duration_minutes: 20
  completed_date: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
  tests_added: 13
---

# Phase 55 Plan 04: Dashboard Server Integration + End-to-End Tests Summary

Wire the app-serving subsystem into shrok's Express dashboard server and prove all five Phase-55 success criteria with an end-to-end integration test that replicates the full server middleware stack.

## Tasks

| Task | Description | Commit | Tests |
|------|-------------|--------|-------|
| 1 | server.ts: add createAppsRouter import, CSRF /apps/ carve-out, mount /apps before SPA catch-all | 5f774a0 | — |
| 2 | integration.test.ts: full-stack E2E test (13 tests) | 9895b74 | 13 |

**Total: 13 new tests. 92 tests across all apps suite, all green. `npx tsc --noEmit` clean.**

## Decisions Made

**CSRF carve-out placement:** Added `if (req.path.startsWith('/apps/')) return next()` immediately after the existing `/v1/` carve-out (server.ts line 178). This mirrors the established pattern. The VMS browser adapter sends same-origin `fetch` POSTs without shrok's CSRF token; with a browser sending `sec-fetch-site: cross-site`, `requireSameOrigin` would return 403 — so the carve-out is mandatory for correct operation.

**Mount order (D-05):** `app.use('/apps', createAppsRouter({ workspacePath }))` is placed after the HA `/v1` block and before the `const distPath = ...` / `express.static(distPath)` / SPA `GET '*'` catch-all. Without this ordering, any request to `/apps/...` would be served as the SPA `index.html`.

**beforeEach/afterEach pattern:** Each test in the integration suite gets a fresh `tmpDir` and a fresh Express server. This ensures per-test database isolation (unique module import URLs → unique DatabaseSync singletons per test) and prevents cache collisions in the discovery module's Map (keyed by absolute app-folder path, which is unique per tmpDir).

**CSRF proof design:** `requireSameOrigin` only fires when `sec-fetch-site` is present AND not `'same-origin'`/`'none'`. Node.js `fetch()` calls don't set this header by default. To prove the carve-out, the test explicitly sets `'sec-fetch-site': 'cross-site'` and confirms: (1) `/apps/*` → 200 (carve-out passes it through), (2) `/sentinel` → 403 (CSRF blocks it). The sentinel is a non-apps POST endpoint mounted before `/apps` in the test Express app.

**notes2 fixture for isolation test (APPSRV-05b):** The notes2 app uses a `notes` table (not `kv`) so a direct `DatabaseSync` read can confirm each app writes to its own co-located sqlite and the tables don't bleed across app boundaries.

## Deviations from Plan

None — plan executed exactly as written. Both tasks passed type-check and tests on the first run.

## Known Stubs

None. The server.ts mount is unconditional (no feature flag). The integration test is complete with all five success criteria verified against the live running subsystem.

## Threat Flags

No new security-relevant surface beyond what is already documented in the Plan-03 threat register. The CSRF carve-out is the specific mitigant for T-55-04-CSRF (D-08) and is covered by the D-08 negative test confirming non-/apps/ routes are still guarded.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/apps/integration.test.ts | FOUND |
| src/dashboard/server.ts (createAppsRouter import) | FOUND |
| src/dashboard/server.ts (/apps/ CSRF carve-out) | FOUND |
| src/dashboard/server.ts (app.use('/apps', ...) mount) | FOUND |
| commit 5f774a0 (server.ts) | FOUND |
| commit 9895b74 (integration.test.ts) | FOUND |
| npx vitest run src/apps (92 tests) | PASSED |
| npx tsc --noEmit | CLEAN |
