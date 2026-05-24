---
phase: 30-core-activation
plan: "01"
subsystem: db/app_state
tags: [multi-head, app-state, migration, sqlite]
dependency_graph:
  requires: [29-data-layer/29-01]
  provides: [AppStateStore per-head key isolation]
  affects: [src/head/activation.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [headId key-prefix, headId validation guard, NOT EXISTS idempotent migration]
key_files:
  created:
    - sql/006_rename_app_state_keys.sql
  modified:
    - src/db/app_state.ts
    - src/db/db.test.ts
decisions:
  - "D-02: headId as first parameter on four head-scoped methods; key prefix is ${headId}:keyname"
  - "D-03: Threshold methods remain global with no headId parameter"
  - "D-05: Migration 006 uses UPDATE with NOT EXISTS guard; no DELETE+INSERT to preserve timestamps"
  - "T-30-01/T-30-04: headId validation guard (non-empty, no colon) added via private assertValidHeadId helper"
metrics:
  duration_minutes: 5
  completed_date: "2026-05-12"
  tasks_completed: 3
  files_modified: 3
---

# Phase 30 Plan 01: AppStateStore Per-Head Namespacing Summary

Per-head namespacing of AppStateStore's four head-scoped methods using `${headId}:keyname` DB key prefix, plus a migration renaming legacy flat keys to `default:`-prefixed equivalents, with isolation tests and migration idempotence coverage.

## Final Method Signatures

```typescript
// Head-scoped methods (namespaced by headId):
getLastActiveChannel(headId: string): string
setLastActiveChannel(headId: string, id: string): void
tryAcquireArchivalLock(headId: string): boolean
releaseArchivalLock(headId: string): void

// Threshold methods (unchanged — global, no headId):
getThresholds(): UsageThreshold[]
addThreshold(input: Omit<UsageThreshold, 'id'>): UsageThreshold
updateThreshold(id: string, patch: Partial<Omit<UsageThreshold, 'id'>>): UsageThreshold | null
deleteThreshold(id: string): boolean
getThresholdFiredAt(thresholdId: string): Date | null
getAllThresholdFiredAt(): Record<string, Date>
setThresholdFiredAt(thresholdId: string, when?: Date): void
clearThresholdFiredAt(thresholdId: string): void
seedDefaultThreshold(): boolean
```

## Key Strings for Namespaced Rows

| Method | DB key |
|--------|--------|
| getLastActiveChannel('default') | `default:last_active_channel` |
| setLastActiveChannel('personal', 'discord') | `personal:last_active_channel` |
| tryAcquireArchivalLock('work') | `work:archival_lock` |
| releaseArchivalLock('work') | `work:archival_lock` |

## HeadId Validation Guard

A private `assertValidHeadId(headId: string)` helper is called at the top of all four methods. It throws `AppStateStore: invalid headId "${headId}"` if headId is empty or contains a colon character. This prevents key-collision injection (T-30-01, T-30-04).

## Migration File: sql/006_rename_app_state_keys.sql

- 20 lines total
- Two idempotent `UPDATE app_state SET key = 'default:...' WHERE key = '...' AND NOT EXISTS (...)` statements
- Renames `last_active_channel` → `default:last_active_channel`
- Renames `archival_lock` → `default:archival_lock`
- No BEGIN/COMMIT (stripped by migrate.ts anyway)
- Threshold keys (`usage_thresholds`, `usage_thresholds_fired`, `usage_threshold_migrated_v1`) untouched per D-03

## Test Count

| Category | Count |
|----------|-------|
| Existing AppStateStore tests updated (headId='default' added) | 5 |
| New per-head isolation tests (Phase 30 describe block) | 7 |
| New migration 006 tests (rename + idempotence) | 2 |
| **Total new/modified tests** | **14** |

All 42 AppStateStore tests pass under `npx vitest run src/db/db.test.ts -t "AppStateStore"`.

## Commits

| Hash | Description |
|------|-------------|
| 531d152 | feat(30-01): add headId parameter to AppStateStore head-scoped methods |
| 3486fc6 | chore(30-01): add migration sql/006_rename_app_state_keys.sql |
| 84c00e3 | test(30-01): extend db.test.ts with per-head AppStateStore tests and migration 006 coverage |

## Deviations from Plan

None — plan executed exactly as written. All D-02, D-03, D-05 decisions honored. Security mitigations T-30-01 through T-30-06 implemented as specified.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan's threat model covers.

## Self-Check: PASSED
