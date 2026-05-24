---
phase: 44-multi-head-task-delivery
plan: "01"
subsystem: db/persistence
tags: [migration, types, schedules, agents, multi-head]
dependency_graph:
  requires: []
  provides:
    - agents.deliver_to_head_ids column (sql/008)
    - AgentState.deliverToHeadIds (required string[])
    - SpawnOptions.deliverToHeadIds (optional string[])
    - Schedule.deliverToHeadIds (optional string[])
    - SchedulePatch.deliverToHeadIds (editable)
  affects:
    - src/types/agent.ts
    - src/db/agents.ts
    - src/db/schedules.ts
tech_stack:
  added: []
  patterns:
    - SQLite ALTER TABLE ADD COLUMN with DEFAULT '[]' (mirrors sql/007 pattern)
    - JSON column serialize/deserialize on agents row (mirrors tools/capabilities pattern)
    - conditional-spread for optional fields in create() (exactOptionalPropertyTypes compliance)
    - delete-on-empty in update() (exactOptionalPropertyTypes compliance)
key_files:
  created:
    - sql/008_agents_deliver_to_head_ids.sql
  modified:
    - src/types/agent.ts
    - src/db/agents.ts
    - src/db/schedules.ts
    - src/db/schedules.test.ts
decisions:
  - D-02-ABSENT-NOT-EMPTY: deliverToHeadIds absent on legacy/reminder rows is intentional (NOT migrated to []); absent = owner-only behavior preserved
  - D-CONDITIONAL-SPREAD: create() uses ...(options.deliverToHeadIds?.length ? { ... } : {}) not ?? [] to avoid writing empty-array key noise onto every row
  - D-DELETE-ON-EMPTY: update() deletes the key when patch.deliverToHeadIds === [] rather than setting to [] (exactOptionalPropertyTypes compliance + clean JSON)
  - D-13-PRESERVED: headId stays excluded from SchedulePatch Pick<> union (Phase 35 D-13 ban intact); deliverToHeadIds IS in the union (editable per D-08)
  - NO-INDEX: sql/008 has no CREATE INDEX — column is read only at completion fan-out, never a query predicate
metrics:
  duration: 3min
  completed: "2026-05-24"
  tasks_completed: 2
  files_changed: 5
---

# Phase 44 Plan 01: Data-Model Foundation Summary

One-liner: SQLite `deliver_to_head_ids TEXT NOT NULL DEFAULT '[]'` column on agents + JSON round-trip, with optional `deliverToHeadIds` field threaded through `AgentState`/`SpawnOptions`/`Schedule`/`SchedulePatch`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add deliver_to_head_ids migration + agents-table persistence | 55cf6a8 | sql/008_agents_deliver_to_head_ids.sql, src/types/agent.ts, src/db/agents.ts |
| 2 | Add deliverToHeadIds to Schedule data model + unit tests | 8998ff2 | src/db/schedules.ts, src/db/schedules.test.ts |

## What Was Built

### Task 1 — Migration + agent persistence

**`sql/008_agents_deliver_to_head_ids.sql`** — single `ALTER TABLE agents ADD COLUMN deliver_to_head_ids TEXT NOT NULL DEFAULT '[]'` statement. The DEFAULT `'[]'` covers all existing rows in one shot (SQLite constant-DEFAULT semantics). No index: the column is read-only at completion fan-out, never a query predicate. Mirrors `sql/007_agents_head_id.sql` pattern exactly.

**`src/types/agent.ts`** — two new fields:
- `AgentState.deliverToHeadIds: string[]` (required, always present from `rowToState`'s JSON.parse of the DEFAULT-backed column)
- `SpawnOptions.deliverToHeadIds?: string[]` (optional, preserving the ~82 existing call sites that were not updated — same precedent as Phase 34's `headId`)

**`src/db/agents.ts`** — four additions:
- `AgentRow.deliver_to_head_ids: string` (JSON TEXT column)
- `rowToState`: `deliverToHeadIds: JSON.parse(row.deliver_to_head_ids) as string[]` (no conditional spread — always present from DEFAULT)
- `stmtCreate` INSERT: `deliver_to_head_ids` in column list + `@deliver_to_head_ids` bind
- `create()`: `deliver_to_head_ids: JSON.stringify(options.deliverToHeadIds ?? [])` (mirrors tools/capabilities pattern)

### Task 2 — Schedule data model + tests

**`src/db/schedules.ts`** — four additions:
- `Schedule.deliverToHeadIds?: string[]` (optional, absent on reminders and legacy rows is intentional — D-02)
- `CreateScheduleOptions.deliverToHeadIds?: string[]`
- `SchedulePatch` Pick<> union extended with `'deliverToHeadIds'` (editable via PATCH per D-08; headId D-13 ban preserved)
- `create()`: conditional-spread `...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {})` (NOT `?? []`)
- `update()`: `delete existing.deliverToHeadIds` when patch value is empty array (not `= []`)
- **NO `migrateLegacySchedule` guard** — absent on legacy rows is the intended owner-only behavior; adding a guard would mark files migrated and update mtime with no semantic gain

**`src/db/schedules.test.ts`** — 3 new tests:
1. Task created with `deliverToHeadIds: ['b','c']` persists to disk and round-trips through `get()` intact
2. Legacy task row and reminder row have NO `deliverToHeadIds` key after read (absent, not `[]`)
3. PATCH `{ deliverToHeadIds: ['b'] }` adds set; PATCH `{ deliverToHeadIds: [] }` clears it — key is absent from persisted JSON

## Verification

- `npx tsc --noEmit` GREEN (all existing ~82 `SpawnOptions` call sites unaffected — optional field)
- `npx vitest run src/db/schedules.test.ts src/db/db.test.ts` — 153/153 tests pass (27 schedule + 126 db)
- `grep "ADD COLUMN deliver_to_head_ids TEXT NOT NULL DEFAULT '\\[\\]'" sql/008_agents_deliver_to_head_ids.sql` — confirmed
- `grep -c "CREATE INDEX" sql/008_agents_deliver_to_head_ids.sql` → 0 (no index as specified)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all fields are wired end-to-end within this plan's scope. Fan-out usage in `src/sub-agents/local.ts` and the `activation.ts` pass-through are deferred to Plan 02 by design (this plan is the data-model foundation only).

## Threat Flags

None — per plan's threat model T-44-01/T-44-02, all write paths go through `JSON.stringify` (T-44-01 mitigated: malformed JSON cannot enter), and the delivery set stores only head IDs with no secrets (T-44-02 accepted). No new network endpoints or auth paths introduced.

## Self-Check: PASSED

Files created/exist:
- sql/008_agents_deliver_to_head_ids.sql: FOUND
- src/types/agent.ts (modified): FOUND
- src/db/agents.ts (modified): FOUND
- src/db/schedules.ts (modified): FOUND
- src/db/schedules.test.ts (modified): FOUND

Commits exist:
- 55cf6a8 (Task 1): FOUND
- 8998ff2 (Task 2): FOUND
