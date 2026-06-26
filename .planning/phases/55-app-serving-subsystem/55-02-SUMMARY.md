---
phase: "55"
plan: "02"
subsystem: app-serving-subsystem
tags: [apps, discovery, adapter, sqlite, tdd, foundation]
dependency_graph:
  requires: [55-01]
  provides: [src/apps/workspace.ts, src/apps/db.ts, src/apps/discovery.ts, src/apps/adapter.ts]
  affects: [55-03, 55-04]
tech_stack:
  added: []
  patterns:
    - "appDb: per-appDir+name Map cache, DatabaseSync+WAL+FK (mirrors src/db/index.ts)"
    - "loadApp: per-app error boundary via try/catch around dynamic import"
    - "ensurePackageSymlink: readlinkSync comparison, never realpathSync"
    - "toWebRequest: D-07 parsed-body contract, SKIP_HEADERS for content-length + host"
key_files:
  created:
    - src/apps/workspace.ts
    - src/apps/workspace.test.ts
    - src/apps/db.ts
    - src/apps/db.test.ts
    - src/apps/discovery.ts
    - src/apps/discovery.test.ts
    - src/apps/adapter.ts
    - src/apps/adapter.test.ts
  modified: []
decisions:
  - "Cache key for appDb is appDir:name (not just name) to prevent cross-test-dir collisions"
  - "Broken fixture test simplified from expect(async fn).not.toThrow() to direct await — vitest does not await the inner async closure before proceeding"
  - "Multi-value Express headers skipped in toWebRequest (deferred — JSON wire is single-value)"
  - "Test fixture writeBrokenFixture uses throw at top level of .mjs (not in function) — ES module rejects at import()"
metrics:
  duration_minutes: 90
  completed_date: "2026-06-26"
  tasks_completed: 4
  tasks_total: 4
  files_created: 8
  files_modified: 0
  tests_added: 43
---

# Phase 55 Plan 02: Foundation Modules (workspace, db, discovery, adapter) Summary

Four TDD-built `src/apps/` foundation modules implementing the D-01..D-11b decisions from 55-CONTEXT.md — idempotent workspace symlink, per-app sqlite helper, filesystem discovery with load-time error boundary, and Express-to-web-Fetch adapter with the D-07 parsed-body fix.

## Tasks

| Task | Description | Commit | Tests |
|------|-------------|--------|-------|
| 1 | workspace.ts — ensurePackageSymlink (D-11) | a78821b | 5 |
| 2 | db.ts — appDb per-app sqlite helper (D-03, D-11a) | 703dc9a | 8 |
| 3 | discovery.ts — SLUG_RE, listApps, loadApp (D-01/D-02/D-04/D-09/D-11b) | f8a81b8 | 18 |
| 4 | adapter.ts — Express<->web-Fetch bridge (D-06/D-07) | 06abc3e | 12 |

**Total: 43 tests, all green. `npx tsc --noEmit` clean.**

## Decisions Made

**Cache key = `appDir:name` (not `name`):** The PoC used a single `DATA_DIR` constant so the name alone uniquely keyed the cache. In tests, each `it()` creates a fresh temp dir via `mkdtempSync`. Using just `name` would cause cache hits across test dirs (e.g., two tests both open `data` returning the first test's handle pointing at a deleted path). Keying by `appDir:name` makes each test isolated.

**Discovery cache keyed by `path.join(appsDir, slug)`:** Same isolation rationale — different temp-dir appsDir paths prevent cross-test cache pollution while delivering hot discovery (a new slug in a known appsDir is a cache miss).

**Broken-fixture test simplified:** The original test used `await expect(async () => { loaded = ... }).not.toThrow()` expecting vitest to await the inner closure. It does not — the inner async function runs but the variable assignment completes after the `expect` matcher evaluates, leaving `loaded` as the initial `undefined`. Rewritten to `const loaded = await loadApp(...)` which throws if the function throws (letting the test fail naturally) and assigns correctly on success.

**Multi-value headers skipped in toWebRequest:** Express may return `string[]` for headers with multiple values. The JSON action wire sends single-value headers; skipping arrays avoids `Headers.set` type errors and defers the multi-value case alongside the deferred multipart adapter work.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Vitest async-closure timing in broken-fixture test**
- **Found during:** Task 3 GREEN verification (17/18 tests passing)
- **Issue:** `await expect(async () => { loaded = await loadApp(...) }).not.toThrow()` does not await the inner closure before the matcher evaluates. `loaded` remained `undefined` because the async body ran after the synchronous matcher check.
- **Fix:** Replaced with `const loaded = await loadApp(appsDir, 'broken')` — direct await so the test is correctly ordered and the assertion has the real return value.
- **Files modified:** src/apps/discovery.test.ts
- **Commit:** f8a81b8

## Known Stubs

None. All four modules are complete functional implementations with no hardcoded stubs, empty return values, or TODO-blocked paths.

## Threat Flags

No new security-relevant surface introduced beyond what is documented in the 55-02-PLAN.md threat register. The four files implement the already-scoped mitigations:
- T-55-02-TRAVERSAL: SLUG_RE + name guard enforce before any path.join
- T-55-02-CRASH: try/catch error boundary in loadApp
- T-55-02-ISO: appDb opens only paths derived from caller-supplied appDir
- T-55-02-LINK: ensurePackageSymlink target fixed from import.meta.url

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/apps/workspace.ts | FOUND |
| src/apps/db.ts | FOUND |
| src/apps/discovery.ts | FOUND |
| src/apps/adapter.ts | FOUND |
| commit a78821b (workspace) | FOUND |
| commit 703dc9a (db) | FOUND |
| commit f8a81b8 (discovery) | FOUND |
| commit 06abc3e (adapter) | FOUND |
