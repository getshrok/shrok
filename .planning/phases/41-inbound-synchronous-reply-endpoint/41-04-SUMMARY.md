---
phase: 41-inbound-synchronous-reply-endpoint
plan: "04"
subsystem: dashboard-server, startup-wiring, docs
tags: [home-assistant, express, csrf, middleware, wiring]
dependency_graph:
  requires: ["41-03"]
  provides: [HACV-01, HACV-06, HADOC-01]
  affects: [src/dashboard/server.ts, src/index.ts, docs/internals/channel-integrations.md]
tech_stack:
  added: []
  patterns: [express-router-mount-before-spa, csrf-path-exclusion, array-before-loop-collection]
key_files:
  created: []
  modified:
    - src/dashboard/server.ts
    - src/index.ts
    - docs/internals/channel-integrations.md
decisions:
  - "Read HA_INBOUND_API_KEY from process.env at start() time (not module-eval time) — Pitfall 4"
  - "/v1/* CSRF exclusion placed as second early-return, before requireSameOrigin"
  - "homeAssistantAdapters? is typed as array to match the DashboardServerOptions shape even though D-04 means only one HA channel is configured in practice"
  - "Apache /v1 auth-bypass snippet captured in docs for HADOC-01, explicitly NOT applied in Phase 41"
metrics:
  duration: 6min
  completed_date: "2026-05-24"
  tasks: 2
  files: 3
---

# Phase 41 Plan 04: Express Wiring + Apache Snippet Summary

**One-liner:** Wired the Phase-03 HA router into the live Express server via CSRF exclusion + /v1 mount + index.ts adapter collection; captured Apache /v1 auth-bypass block for HADOC-01 (recorded, not applied).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | server.ts CSRF exclusion + homeAssistantAdapters option + /v1 router mount | dcbf505 | src/dashboard/server.ts |
| 2 | index.ts wiring + Apache /v1 auth-bypass snippet for HADOC-01 | 37b26f2 | src/index.ts, docs/internals/channel-integrations.md |

## What Was Built

### Task 1 — `src/dashboard/server.ts`

Three edits applied:

**Edit 1 — CSRF exclusion (HACV-06):** Added `if (req.path.startsWith('/v1/')) return next()` as the second early-return in the CSRF middleware, placed before `requireSameOrigin`. The method-based guard (GET/HEAD/OPTIONS) remains first; the `/v1/` path guard is second; `requireSameOrigin` last. HA presents a bearer token; the `/v1` router validates auth itself, so excluding CSRF does not create an unauthenticated mutation path (T-41-13).

**Edit 2 — options field:** Added `homeAssistantAdapters?: HomeAssistantChannelAdapter[]` to `DashboardServerOptions` with a JSDoc note explaining the bearer-auth intent. Added `import type { HomeAssistantChannelAdapter }` and `import { createHomeAssistantRouter }` from `../channels/home-assistant/`.

**Edit 3 — router mount:** Added a guarded mount block at the end of `start()`, after all `/api/*` routes and before `express.static(distPath)` / `app.get('*', ...)`. Reads `HA_INBOUND_API_KEY` from `process.env` at `start()` call time (Pitfall 4), iterates the adapters array, mounts `createHomeAssistantRouter(haAdapter, haInboundApiKey)` at `/v1` for each.

### Task 2 — `src/index.ts`

**Edit 1:** Declared `const haAdapters: HomeAssistantChannelAdapter[] = []` immediately after `dashboardAdapters` (before the head build loop).

**Edit 2:** In the `else if (ch.vendor === 'home-assistant')` branch, added `haAdapters.push(ha)` after `adapter = ha`.

**Edit 3:** Added `homeAssistantAdapters: haAdapters,` to the `DashboardServer` constructor options object, adjacent to `dashboardAdapters`.

### Task 2 — `docs/internals/channel-integrations.md`

Added a new `## Home Assistant` section covering: vendor config fields, inbound endpoint description, bearer auth (HA_INBOUND_API_KEY distinct from HA_ACCESS_TOKEN), message extraction (last user turn only), synchronous reply with 3s deadline lapse to Phase-42 announce, CSRF exclusion rationale, and single-instance design.

Included a `### Apache /v1 auth-bypass configuration` subsection with the exact `<Location "/v1/">` block, clearly marked as "RECORDED, NOT APPLIED — Phase 43" with a prominent note explaining the Apache Basic-401 confusion problem (T-41-14 mitigation documentation).

## Acceptance Criteria Verification

- `grep -c "req.path.startsWith('/v1/')" src/dashboard/server.ts` → 1 ✓
- `/v1/` guard is line 154, `requireSameOrigin` is line 155 (guard before) ✓
- `grep -c "homeAssistantAdapters" src/dashboard/server.ts` → 3 ✓
- `grep -c "createHomeAssistantRouter" src/dashboard/server.ts` → 2 ✓
- `app.use('/v1', ...)` at line 284, before `express.static` at line 291 ✓
- `grep -c "haAdapters" src/index.ts` → 3 ✓
- `grep -c "homeAssistantAdapters: haAdapters" src/index.ts` → 1 ✓
- `grep -c "AuthType None" docs/internals/channel-integrations.md` → 2 (comment + directive) ✓
- `grep -c "Require all granted" docs/internals/channel-integrations.md` → 2 (comment + directive) ✓
- `grep -ci "not applied\|Phase 43" docs/internals/channel-integrations.md` → 3 ✓
- `grep -c "HA_INBOUND_API_KEY" docs/internals/channel-integrations.md` → 3 ✓
- `npx tsc --noEmit` → 0 errors ✓
- `npx vitest run` → 1614/1614 tests pass ✓

## Deviations from Plan

None — plan executed exactly as written. The `exactOptionalPropertyTypes` constraint was honored by using `homeAssistantAdapters: haAdapters` (a real array, never `undefined`).

## Known Stubs

None. The wiring is complete: `index.ts` collects adapters → `DashboardServer` receives them → mounts the Phase-03 router. The Phase-42 announce path is a planned stub in `adapter.send()` (documented in Phase-40 / Plan-02 SUMMARY).

## Threat Flags

None. All threat-model entries from the plan were addressed:

- T-41-13 (CSRF scope): CSRF exclusion scoped to exact `/v1/` prefix; all other routes still run `requireSameOrigin`
- T-41-14 (Apache Basic-401): Apache snippet documented with `AuthType None / Require all granted` before the catch-all block; applied + verified in Phase 43
- T-41-15 (key disclosure): `HA_INBOUND_API_KEY` read from `process.env` at `start()`, passed to router factory, never logged, never written to docs as a value

## Self-Check: PASSED

| Item | Result |
|------|--------|
| src/dashboard/server.ts exists | FOUND |
| src/index.ts exists | FOUND |
| docs/internals/channel-integrations.md exists | FOUND |
| 41-04-SUMMARY.md exists | FOUND |
| dcbf505 (Task 1 commit) exists | FOUND |
| 37b26f2 (Task 2 commit) exists | FOUND |
