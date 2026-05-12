---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Multi-Head Support
status: executing
stopped_at: Completed 31-03-PLAN.md
last_updated: "2026-05-12T09:02:40.284Z"
last_activity: 2026-05-12
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 9
  completed_plans: 9
  percent: 100
---

# Project State

## Current Position

Phase: 31 (adapter-registry-config-startup) — EXECUTING
Plan: 2 of 3
Status: Ready to execute
Last activity: 2026-05-12
Stopped at: Completed 31-03-PLAN.md

Progress: [██████████] 100% (6/6 plans complete)

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-12)

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Phase 31 — adapter-registry-config-startup

## Accumulated Context

### Roadmap Evolution

- Phase 19–27 added during v1.2 milestone (voice pipeline, scheduling, agent history migration, frontmatter validation, env var rename)
- Phase 28 added: Add optional prompt parameter to memory functions
- Phase 29–32 added: v1.3 Multi-Head Support (data layer, core activation, adapter registry + config + startup, dashboard)

### Key Architecture Decisions (v1.3)

- Head isolation via `head_id` column on `queue_events` and `messages` — not separate DBs
- All heads run in one Node process; SQLite WAL handles concurrency
- Default head = `'default'` for zero-config backward compatibility
- Memory, identity, and skills are shared across all heads by design
- Channel adapters extended to support multiple instances per vendor (keyed by distinct string IDs)
- `AppStateStore` keys namespaced as `{headId}:keyName` for per-head state isolation
- Phase 30 D-04: `'default'` literal at all remaining call sites (system.ts, index.ts, eval scripts)
- Phase 30 D-06: one `ChannelRouterImpl` per process via DI; CORE-04 regression test guards this contract
