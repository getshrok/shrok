---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Multi-Head Support
status: executing
stopped_at: Completed 33-03-per-head-sse-filter-PLAN.md
last_updated: "2026-05-13T20:30:35.888Z"
last_activity: 2026-05-13
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 19
  completed_plans: 15
  percent: 79
---

# Project State

## Current Position

Phase: 33 (multi-head-management-ui) — EXECUTING
Plan: 4 of 7
Status: Ready to execute
Last activity: 2026-05-13
Stopped at: Completed 33-03-per-head-sse-filter-PLAN.md

Progress: [████████░░] 79% (15/19 plans complete; phase 33 in flight, plan 3/7 done)

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-12)

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Phase 33 — multi-head-management-ui

## Accumulated Context

### Roadmap Evolution

- Phase 19–27 added during v1.2 milestone (voice pipeline, scheduling, agent history migration, frontmatter validation, env var rename)
- Phase 28 added: Add optional prompt parameter to memory functions
- Phase 29–32 added: v1.3 Multi-Head Support (data layer, core activation, adapter registry + config + startup, dashboard)
- Phase 33 added: Multi-head management UI — promoted DASH-F-01/F-03 from Future Requirements into active scope as DASH-03/04/05 (create/rename/delete heads from UI, manage channels per head incl. multiple-of-same-vendor, per-head Send routing)

### Key Architecture Decisions (v1.3)

- Head isolation via `head_id` column on `queue_events` and `messages` — not separate DBs
- All heads run in one Node process; SQLite WAL handles concurrency
- Default head = `'default'` for zero-config backward compatibility
- Memory, identity, and skills are shared across all heads by design
- Channel adapters extended to support multiple instances per vendor (keyed by distinct string IDs)
- `AppStateStore` keys namespaced as `{headId}:keyName` for per-head state isolation
- Phase 30 D-04: `'default'` literal at all remaining call sites (system.ts, index.ts, eval scripts)
- Phase 30 D-06: one `ChannelRouterImpl` per process via DI; CORE-04 regression test guards this contract
- Phase 33 D-WIDEN: `DashboardEvent.message_added` widened with required `headId` field in Plan 33-01 so Plan 03 only needs to widen the remaining per-head event types
- Phase 33 D-INJECTOR-HEADID: `InjectorImpl.headId` is a `private readonly` 2nd positional ctor arg — encodes the lifetime contract that head identity is fixed at construction
- Phase 33 D-TEST-RENAME: Renamed db.test.ts DATA-02 test to reflect that explicit headId is now required at the type level; the SQL DEFAULT path is unreachable from TypeScript callers

## Decisions (Phase 33)

- D-WIDEN: `DashboardEvent.message_added` widened with required headId in Plan 33-01
- D-INJECTOR-HEADID: `InjectorImpl.headId` is `private readonly` 2nd ctor arg
- D-TEST-RENAME: db.test.ts DATA-02 test renamed (explicit headId now required at type level)
- D-MAP-REQUIRED (Plan 33-02): `DashboardServerOptions.dashboardAdapters` is required (not optional) — empty map is a startup bug, not a valid state; defensive 503 kept for tests
- D-FALLBACK-FIRST (Plan 33-02): POST /send falls back to `dashboardAdapters.values().next().value` when body.headId is missing or unknown — preserves single-head behavior and avoids leaking the head list via 404
- D-FILTER-PURE-FN (Plan 33-03): `shouldDeliverStreamEvent` extracted as a pure function in `dashboard/src/hooks/streamFilter.ts` — testable under existing `environment: 'node'` vitest config (no jsdom, no @testing-library, no new devDependency); `useStream()` composes it as a one-line early-return gate at the top of the SSE callback
- D-SCOPE-MIN-CORRECT (Plan 33-03): per RESEARCH § A4 minimum-correct scope, only `message_added` and `typing` carry `headId` in `DashboardEvent` (grep -c "headId: string" src/dashboard/events.ts returns 2); `agent_*`/`steward_run_added`/`memory_retrieval` are explicitly NOT widened — their emit sites live in process-wide stores with no per-head context, and T-33-09 accepts the cross-head leakage
- D-HEADID-FROM-EVENT (Plan 33-03): inside `useStream`'s `message_added` handler, switched from `currentHeadIdRef.current` to `event.headId` for the cache key — the filter gate above guarantees they're equal for delivered events, making the ref a pure filter input rather than a head-identity resolver

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 33    | 01   | 14min    | 3     | 26    |
| 33    | 02   | 5min     | 3     | 4     |
| 33    | 03   | 3min     | 2     | 6     |
