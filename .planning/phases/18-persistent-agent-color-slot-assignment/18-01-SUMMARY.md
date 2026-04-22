---
phase: 18-persistent-agent-color-slot-assignment
plan: "01"
subsystem: database
tags: [sqlite, agents, color-slot, lru, migration]
dependency_graph:
  requires: []
  provides: [color_slot-column, AgentState.colorSlot, AGENT_COLOR_SLOT_COUNT, pickColorSlot]
  affects: [src/db/agents.ts, src/types/agent.ts, sql/002_agent_color_slot.sql]
tech_stack:
  added: []
  patterns: [LRU-slot-assignment, conditional-spread-rowToState, prepared-statement-slot-query]
key_files:
  created:
    - sql/002_agent_color_slot.sql
  modified:
    - src/types/agent.ts
    - src/db/agents.ts
    - src/db/db.test.ts
decisions:
  - "pickColorSlot uses stmtListActiveSlots prepared statement with no parameters — no injection surface (T-18-04 mitigated)"
  - "LRU steal logic keeps newest updated_at per slot to handle theoretical slot-appears-twice races"
  - "color_slot column is nullable with no default — existing rows get NULL, no backfill per D-02"
metrics:
  duration_seconds: 145
  completed_date: "2026-04-22"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 4
requirements: [D-01, D-02, D-03, D-04, D-05]
---

# Phase 18 Plan 01: Persistent Color Slot Storage Summary

**One-liner:** SQLite `color_slot INTEGER` column on `agents` table with LRU slot assignment (lowest unoccupied first, then steal oldest `updated_at`) via `AgentStore.pickColorSlot()`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add color_slot migration and AgentState type | 6732457 | sql/002_agent_color_slot.sql, src/types/agent.ts, src/db/db.test.ts |
| 2 | Implement LRU pickColorSlot and thread color_slot through AgentStore | a984301 | src/db/agents.ts, src/db/db.test.ts |

## What Was Built

- **`sql/002_agent_color_slot.sql`**: `ALTER TABLE agents ADD COLUMN color_slot INTEGER` — nullable, no default, applied by `runMigrations` after `001_init.sql`.
- **`src/types/agent.ts`**: `AgentState.colorSlot?: number` added (0–6 slot index; omitted when DB value is NULL).
- **`src/db/agents.ts`**:
  - `export const AGENT_COLOR_SLOT_COUNT = 7` — consumed by Plans 02 and 03.
  - `AgentRow.color_slot: number | null` — mirrors the new column.
  - `rowToState` spreads `colorSlot` conditionally when `color_slot != null`.
  - `stmtCreate` SQL extended: `color_slot` in column list and `@color_slot` in VALUES.
  - `stmtListActiveSlots` prepared statement: queries running/suspended agents' `color_slot` and `updated_at` — no parameters, no injection surface.
  - `pickColorSlot()` private method: O(7) scan for lowest unoccupied slot; falls back to stealing the slot with the lexicographically smallest `updated_at` string when all 7 are active.
  - `create()` calls `pickColorSlot()` atomically before `stmtCreate.run()`.
- **`src/db/db.test.ts`**: 6 new tests — column presence (PRAGMA table_info), first agent gets slot 0, sequential agents get 0/1/2, completed agent frees its slot, LRU steal when all 7 occupied, `getRecent` includes `colorSlot`.

## Verification

- `npx vitest run src/db/db.test.ts` — 87 tests passed (82 pre-existing + 5 new Phase 18 AgentStore tests + 1 table schema test).
- `npx tsc --noEmit` — clean.

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary changes introduced. `stmtListActiveSlots` has no parameters (T-18-04 mitigated by construction). `color_slot` value is entirely server-computed — never user input.

## Self-Check: PASSED

- `sql/002_agent_color_slot.sql` — FOUND
- `src/types/agent.ts` contains `colorSlot?: number` — FOUND
- `src/db/agents.ts` contains `AGENT_COLOR_SLOT_COUNT`, `color_slot`, `pickColorSlot`, `@color_slot` — FOUND
- Commits 6732457 and a984301 — FOUND
