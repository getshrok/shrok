---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Multi-Head Support
status: executing
last_updated: "2026-05-12T07:03:44.584Z"
last_activity: 2026-05-12
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 6
  completed_plans: 4
  percent: 67
---

# Project State

## Current Position

Phase: 30 (core-activation) — EXECUTING
Plan: 2 of 3
Status: Ready to execute
Last activity: 2026-05-12
Resume: .planning/phases/29-data-layer/29-CONTEXT.md

Progress: [----------] 0% (0/4 phases complete)

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-12)

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Phase 30 — core-activation

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
