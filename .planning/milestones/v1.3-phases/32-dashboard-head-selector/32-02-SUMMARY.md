---
phase: 32-dashboard-head-selector
plan: "02"
subsystem: dashboard-backend
tags: [backend, dashboard, head-selector, api-route, server-wiring]
dependency_graph:
  requires: [32-01-heads-test-red, 32-01-messages-filter-test-red]
  provides: [heads-route-green, messages-filter-green, dashboard-server-resolvedHeads-wired]
  affects: [32-03-react-ui]
tech_stack:
  added: []
  patterns: [express-router-factory, typeof-query-guard, optional-options-field, backward-compat-fallback]
key_files:
  created:
    - src/dashboard/routes/heads.ts
  modified:
    - src/dashboard/routes/messages.ts
    - src/dashboard/server.ts
    - src/index.ts
decisions:
  - "Backward-compat fallback in DashboardServer.start() synthesizes [{ id: 'default', channels: [] }] when resolvedHeads is omitted — legacy callers and tests without resolvedHeads still get a valid /api/heads response"
  - "typeof req.query['head'] === 'string' guard chosen over other validation approaches — correctly rejects Express's array-parsed ?head=a&head=b while accepting normal string values; prepared statement handles the SQL safety layer"
  - "resolvedHeads passed via DashboardServerOptions rather than computed inside DashboardServer — follows existing config-at-construction pattern and reuses the Phase 31 variable without duplication"
metrics:
  duration: ~3.5 minutes
  completed_date: "2026-05-12"
  tasks_completed: 2
  files_created: 1
  files_modified: 3
---

# Phase 32 Plan 02: Dashboard Head Selector Backend Implementation Summary

Wave 1 backend: turned the Plan 01 RED tests GREEN by creating the `/api/heads` route module and wiring `?head=` scoping into the messages endpoint, then plumbing `resolvedHeads` through `DashboardServerOptions` into `src/index.ts`.

## What Was Built

### `src/dashboard/routes/heads.ts` (new — 19 lines)

- `createHeadsRouter(resolvedHeads: ResolvedHead[]): Router`
- GET / requires `requireAuth` middleware; returns `{ heads: resolvedHeads.map(h => ({ id: h.id })) }`
- Only `id` projected — channel credentials never appear in the response (D-08, T-32-05)

### `src/dashboard/routes/messages.ts` (lines 14-22 modified)

Delta: 3 concrete changes in the GET / handler
1. First arg renamed from `_req` to `req` (we now read `req.query`)
2. Added `headId` const via `typeof req.query['head'] === 'string'` guard (D-05, T-32-04)
3. `messages.getAll('default')` → `messages.getAll(headId)` — head-scoped query

### `src/dashboard/server.ts` (4 sub-changes)

| Line | Change |
|------|--------|
| 9 | `import type { Config }` → `import type { Config, ResolvedHead }` |
| 18 | New: `import { createHeadsRouter } from './routes/heads.js'` |
| 88–92 | New `resolvedHeads?: ResolvedHead[]` field in `DashboardServerOptions` with JSDoc |
| 146 | New: `app.use('/api/heads', createHeadsRouter(this.opts.resolvedHeads ?? [{ id: 'default', channels: [] }]))` |

### `src/index.ts` (line 431 modified)

- Added `resolvedHeads,` to the `DashboardServer` constructor options object
- References the existing `const resolvedHeads: ResolvedHead[] = resolveHeads(config)` at line 203 (Phase 31) — no recomputation

## RED → GREEN Transition

| Test File | Plan 01 State | Plan 02 State |
|-----------|---------------|---------------|
| heads.test.ts (3 tests) | FAIL — module not found | PASS — 3/3 |
| messages.test.ts (5 tests) | FAIL — 2/5 failing | PASS — 5/5 |
| **Total Wave 0** | **2/8 passing** | **8/8 passing** |

## Full Suite Regression

- `npx tsc --noEmit`: 0 errors (clean)
- `npx vitest run`: 81 test files passed, 1346 tests passed, 0 failures
- Phase 31 multi-head startup test (`tests/integration/multi-head-startup.test.ts`) still passes
- Phase 29/30 integration tests all green

## Threat Model Coverage

| Threat | Mitigation Applied |
|--------|-------------------|
| T-32-04: ?head= SQL injection | `typeof` guard + prepared statement in MessageStore |
| T-32-05: /api/heads credential leak | Only `{ id }` projected; `channels` stripped at response boundary |
| T-32-06: /api/heads unauthenticated enumeration | `requireAuth` applied to GET handler |
| Backward-compat: legacy callers without resolvedHeads | `?? [{ id: 'default', channels: [] }]` fallback in server.ts |

## Deviations from Plan

None — plan executed exactly as written. All prescribed code shapes matched verbatim.

## Known Stubs

None. All routes return real data from `MessageStore`/`resolvedHeads` — no placeholder values flow to the UI.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| Task 1 — heads.ts + messages.ts | 52ffdc6 | src/dashboard/routes/heads.ts, src/dashboard/routes/messages.ts |
| Task 2 — server.ts + index.ts | b55a3c3 | src/dashboard/server.ts, src/index.ts |

## Self-Check: PASSED
