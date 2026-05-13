---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Multi-Head Support
status: executing
stopped_at: Completed 33-02-per-head-dashboard-adapter-PLAN.md
last_updated: "2026-05-13T20:24:01.586Z"
last_activity: 2026-05-13
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 19
  completed_plans: 14
  percent: 74
---

# Project State

## Current Position

Phase: 33 (multi-head-management-ui) — EXECUTING
Plan: 3 of 7
Status: Ready to execute
Last activity: 2026-05-13
Stopped at: Completed 33-02-per-head-dashboard-adapter-PLAN.md

Progress: [███████░░░] 74% (14/19 plans complete; phase 33 in flight, plan 2/7 done)

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

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 33    | 01   | 14min    | 3     | 26    |
| 33    | 02   | 5min     | 3     | 4     |
