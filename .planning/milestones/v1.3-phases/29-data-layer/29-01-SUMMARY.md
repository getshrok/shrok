---
phase: 29-data-layer
plan: "01"
subsystem: database
tags: [migration, sqlite, head_id, multi-head, schema]
dependency_graph:
  requires: []
  provides: [head_id-column-queue_events, head_id-column-messages, idx_queue_head_status_priority, idx_messages_head_created]
  affects: [src/db/queue.ts, src/db/messages.ts, src/db/db.test.ts]
tech_stack:
  added: []
  patterns: [sqlite-alter-table-add-column-with-default, migration-runner-transaction-wrapping]
key_files:
  created:
    - sql/005_multi_head.sql
  modified:
    - src/db/db.test.ts
decisions:
  - D-01: Single migration file for both tables — atomic per migrate.ts transaction wrapper
  - D-02: head_id TEXT NOT NULL DEFAULT 'default' — SQLite constant default populates existing rows without UPDATE backfill
  - D-08: idx_queue_status_priority dropped, replaced by idx_queue_head_status_priority on (head_id, status, priority DESC, created_at ASC)
  - D-09: idx_messages_head_created added on (head_id, created_at)
  - D-10: idx_messages_created_at retained for sanitizeOrphans() global scan
metrics:
  duration_seconds: 147
  completed_date: "2026-05-12"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 29 Plan 01: Multi-Head DB Migration Summary

**One-liner:** SQLite migration adding `head_id TEXT NOT NULL DEFAULT 'default'` to `queue_events` and `messages` with compound index replacement, verified by 7 new db.test.ts cases.

## What Was Built

### sql/005_multi_head.sql (created)

Single atomic migration file that:
1. Adds `head_id TEXT NOT NULL DEFAULT 'default'` to `queue_events` — SQLite applies the constant default to all existing rows without a backfill UPDATE
2. Adds `head_id TEXT NOT NULL DEFAULT 'default'` to `messages` — same mechanism
3. Drops `idx_queue_status_priority` (single-dimension) and replaces it with `idx_queue_head_status_priority` on `(head_id, status, priority DESC, created_at ASC)` — matching the inner SELECT pattern used by `claimNext`
4. Adds `idx_messages_head_created` on `(head_id, created_at)` for head-filtered message reads
5. Retains `idx_messages_created_at` for `sanitizeOrphans()` global cross-head scans

No `BEGIN`/`COMMIT` keywords (migrate.ts strips them and already wraps in a transaction). No explicit backfill UPDATE (SQLite's constant-DEFAULT mechanism handles existing rows).

### src/db/db.test.ts (modified — 7 new tests)

**Inside `describe('initDb + runMigrations')`:**
1. `queue_events table has head_id column with NOT NULL DEFAULT 'default' (Phase 29 DATA-01)` — PRAGMA table_info check
2. `messages table has head_id column with NOT NULL DEFAULT 'default' (Phase 29 DATA-02)` — PRAGMA table_info check
3. `idx_queue_status_priority replaced by idx_queue_head_status_priority (D-08)` — sqlite_master query
4. `idx_messages_head_created exists (D-09)` — sqlite_master query
5. `idx_messages_created_at retained (D-10)` — sqlite_master query

**Inside `describe('QueueStore')`:**
6. `enqueue without explicit head_id stamps row with head_id='default' (DATA-01)` — direct SELECT on fresh db

**Inside `describe('MessageStore')`:**
7. `append without explicit head_id stamps row with head_id='default' (DATA-02)` — direct SELECT on fresh db

## Requirements Satisfied

- **DATA-01:** `queue_events.head_id` column exists with `NOT NULL DEFAULT 'default'`; existing rows and new inserts without explicit `head_id` read back as `'default'`. Proven by test 1 and test 6.
- **DATA-02:** `messages.head_id` column exists with `NOT NULL DEFAULT 'default'`; existing rows and new inserts without explicit `head_id` read back as `'default'`. Proven by test 2 and test 7.

## Verification Results

- `npx vitest run src/db/db.test.ts` — **100 tests passed** (93 pre-existing + 7 new)
- All acceptance criteria grep checks pass

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: Migration file | `a1183ab` | feat(29-01): add head_id migration for queue_events and messages |
| Task 2: Tests | `6962a77` | test(29-01): add head_id migration tests for DATA-01 and DATA-02 |

## Deviations from Plan

None — plan executed exactly as written.

The only minor adjustment: test description strings used double-quoted JS string literals instead of single-quoted with escaped apostrophes, so the plan's acceptance-criteria grep patterns (`head_id='default'`) match the file content without backslash escaping. This is a cosmetic equivalence, not a behavioral deviation.

## Next Step

**Plan 02** — Update `QueueStore` and `MessageStore` method signatures to accept and propagate `head_id`, adding per-head filtering to `claimNext`, `getRecent`, `getSince`, etc.

## Known Stubs

None — the migration and tests are complete; no placeholder data or hardcoded empty values.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what the plan's threat model covers.

## Self-Check: PASSED

- `sql/005_multi_head.sql` — FOUND
- `src/db/db.test.ts` — FOUND (modified)
- Commit `a1183ab` — verified present
- Commit `6962a77` — verified present
- 100 tests pass
