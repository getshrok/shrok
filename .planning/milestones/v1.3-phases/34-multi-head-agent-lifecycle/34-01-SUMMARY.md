---
phase: 34-multi-head-agent-lifecycle
plan: 01
subsystem: database
tags: [sqlite, head_id, multi-head, agents-table, migration, agent-store]

requires:
  - phase: 29-multi-head-data-layer
    provides: head_id column on messages/queue_events with NOT NULL DEFAULT 'default' (template for this migration)
  - phase: 33-multi-head-management-ui
    provides: per-head write contract pattern (MessageStore.append required-headId)
provides:
  - "sql/007_agents_head_id.sql — agents.head_id column NOT NULL DEFAULT 'default' + idx_agents_head_status compound index"
  - "AgentRow gains head_id: string field"
  - "rowToState carries headId from row.head_id onto AgentState (always present post-migration)"
  - "stmtCreate INSERT includes head_id column; create() binds @head_id from options.headId with no silent fallback"
affects: [plan-02-spawn-options-headid, plan-03-local-agent-runner-headid, plan-04-system-wiring, plan-05-integration-tests]

tech-stack:
  added: []
  patterns:
    - "ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT 'default' relies on SQLite's constant-DEFAULT semantics to populate pre-existing rows in one atomic step — no explicit UPDATE backfill (mirrors Phase 29)"
    - "Head-scoped compound index (head_id, status) mirrors idx_queue_head_status_priority and idx_messages_head_created — consistent shape across all multi-head tables"
    - "create() binds options.headId without `?? 'default'` fallback — the type-required headId on SpawnOptions (Plan 02) is the safety net; SQL DEFAULT is defense-in-depth, not a callable path"

key-files:
  created:
    - sql/007_agents_head_id.sql
  modified:
    - src/db/agents.ts
    - src/db/db.test.ts

key-decisions:
  - "D-MIGRATION-DEFAULT-ONLY honored: no UPDATE statement in 007 — SQLite's constant-DEFAULT clause populates pre-existing rows atomically (verified by the legacy-row test that inserts without head_id and reads back 'default')"
  - "D-ROW-WRITE-FROM-OPTIONS honored: head_id rides along on the existing SpawnOptions parameter, no new positional arg on AgentStore.create()"
  - "rowToState uses `headId: row.head_id` as a plain (always-present) field, NOT a conditional spread — post-migration every row has a head_id by SQL invariant"
  - "Updated baseOptions in db.test.ts AgentStore suite to include headId: 'default' — single edit unblocks all 22 existing AgentStore tests under the Plan 02 required-headId-at-type-level rule"
  - "tsc --noEmit reports expected RED errors (headId not on SpawnOptions / AgentState) until Plan 02 lands the type fields; Wave 1 parallel land design — vitest passes today, tsc green once Plan 02 commits"

patterns-established:
  - "Phase 29 migration template reused verbatim for the agents table — single ALTER TABLE ADD COLUMN with constant DEFAULT plus a head-scoped compound index, no UPDATE backfill"
  - "TDD-RED-then-GREEN cadence: three new test cases (schema pin, create-round-trip with headId='work', DEFAULT-fallback for legacy rows) committed as a failing test commit before the implementation, then green-on-implementation"

requirements-completed: []

duration: 3min
completed: 2026-05-14
---

# Phase 34 Plan 01: Agents Table head_id Persistence Summary

**One-liner:** Added `head_id` column + head-scoped index to the agents table and threaded it through `AgentStore.create()` / `rowToState()` so per-agent rows record which head spawned them — data-layer foundation for the Phase 34 lifecycle plumbing.

## What Changed

### Migration (`sql/007_agents_head_id.sql`, new)

```sql
ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_agents_head_status
  ON agents (head_id, status);
```

Mirrors the Phase 29 `sql/005_multi_head.sql` pattern verbatim — same comment style, same DEFAULT semantics, same index shape (compound, head-scoped). No `UPDATE agents SET head_id = 'default'` statement: SQLite populates existing rows atomically via the constant DEFAULT clause.

### AgentStore (`src/db/agents.ts`)

1. **`AgentRow` interface** gains `head_id: string` field (after `parent_agent_id`).
2. **`rowToState()`** returns `headId: row.head_id` as a plain field (always present post-migration), placed after `parentAgentId` to match the row-interface ordering.
3. **`stmtCreate` SQL** includes `head_id` in the INSERT column list and binds `@head_id` in the VALUES tuple.
4. **`create()`** passes `head_id: options.headId` into the bound params — no `?? 'default'` fallback; the SQL DEFAULT is the defense-in-depth backstop, not a TypeScript-callable path.

### Tests (`src/db/db.test.ts`)

- **`baseOptions`** in the AgentStore describe-block gained `headId: 'default'` so all 22 existing AgentStore tests keep compiling under Plan 02's required-headId rule.
- **Three new test cases**:
  1. Schema pin: `PRAGMA table_info('agents')` reports `head_id` with `notnull=1` and `dflt_value="'default'"`.
  2. Create-round-trip: `create('a-work', { ..., headId: 'work' })` persists `head_id='work'` on the row (direct SQL read) and `AgentStore.get('a-work').headId === 'work'`.
  3. DEFAULT-fallback: a row inserted via raw SQL without an explicit `head_id` (legacy code path simulation) yields `headId === 'default'` from `AgentStore.get()`.

## Deviations from Plan

None — plan executed exactly as written.

## Authentication Gates

None.

## Verification

- `test -f sql/007_agents_head_id.sql` — exists
- `grep -q "ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'" sql/007_agents_head_id.sql` — exit 0
- `grep -q "idx_agents_head_status" sql/007_agents_head_id.sql` — exit 0
- `grep -q "UPDATE agents SET head_id" sql/007_agents_head_id.sql` — exit 1 (no match, as required)
- `grep -q "head_id: string" src/db/agents.ts` — exit 0
- `grep -q "headId: row.head_id" src/db/agents.ts` — exit 0
- `grep -q "head_id: options.headId" src/db/agents.ts` — exit 0
- `grep -q "@head_id" src/db/agents.ts` — exit 0
- `grep -q "head_id: options.headId ?? 'default'" src/db/agents.ts` — exit 1 (no fallback)
- `npx vitest run src/db/db.test.ts -t "AgentStore"` — 22 passed / 0 failed
- `npx vitest run src/db/db.test.ts -t "head_id column"` — 3 passed (Phase 29 + Phase 34 schema pins)
- `npx vitest run src/db/db.test.ts` — 126 passed / 0 failed (full file regression check)

### Known RED state (resolved by Plan 02)

`npx tsc --noEmit` reports 5 errors, all about `headId` not existing on `SpawnOptions` / `AgentState`:

```
src/db/agents.ts(47,5): error TS2353: ... 'headId' does not exist in type 'AgentState'.
src/db/agents.ts(194,24): error TS2339: Property 'headId' does not exist on type 'SpawnOptions'.
src/db/db.test.ts(403,61): error TS2353: ... 'headId' does not exist in type 'SpawnOptions'.
src/db/db.test.ts(407,19): error TS2339: Property 'headId' does not exist on type 'AgentState'.
src/db/db.test.ts(419,29): error TS2339: Property 'headId' does not exist on type 'AgentState'.
```

This is the **expected** Wave 1 RED state per the plan's `<acceptance_criteria>` note. Plan 02 adds `SpawnOptions.headId` and `AgentState.headId` to `src/types/agent.ts`, at which point tsc goes green. Vitest passes today because esbuild's transpile-only path tolerates the excess-property issue at runtime.

## Commits

| Hash      | Type | Description                                                |
| --------- | ---- | ---------------------------------------------------------- |
| `058f859` | feat | add sql/007_agents_head_id.sql migration                   |
| `6a9bc23` | test | add failing tests for AgentStore head_id round-trip (RED)  |
| `c6f4a44` | feat | persist head_id on agents via AgentStore (GREEN)           |

## Threat Flags

None — this plan only widens an internal data type (AgentRow / AgentState) and a private SQL statement. No new HTTP/IPC surface, no untrusted-input crossing, no auth boundary changes. `head_id` is a server-owned grouping label sourced from `buildSystem(deps.headId)` (Plan 04), never from request input.

## Self-Check: PASSED

- All 4 listed files (sql/007_agents_head_id.sql, src/db/agents.ts, src/db/db.test.ts, SUMMARY.md) exist on disk
- All 3 commits (058f859, 6a9bc23, c6f4a44) present in git log
- All 22 AgentStore tests + 3 new Phase 34 cases green via `npx vitest run src/db/db.test.ts`
