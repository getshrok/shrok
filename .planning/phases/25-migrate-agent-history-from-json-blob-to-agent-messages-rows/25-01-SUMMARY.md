---
phase: 25
plan: 01
subsystem: db
tags: [migration, sqlite, agent-history, append-only, row-per-message]
requires: []
provides: [agent_messages-table, AgentStore-appendMessages, AgentStore-compactHistory]
affects: [src/sub-agents/archival.ts, src/sub-agents/local.ts]
tech_stack_added: []
tech_stack_patterns: [transaction-atomic-compaction, rowid-ordering, back-compat-shim]
key_files_created:
  - sql/004_agent_messages.sql
key_files_modified:
  - src/db/agents.ts
  - src/db/db.test.ts
decisions:
  - idx_agent_messages_agent_rowid uses (agent_id) not (agent_id, rowid) — SQLite 3.51.2 rejects rowid in CREATE INDEX for composite-PK tables
  - compactHistory re-inserts tail messages after summary to preserve ORDER BY rowid chronological invariant
  - compactHistory null summaryMsg performs delete-only (no INSERT) for archival empty-text trim path
metrics:
  duration_seconds: 375
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_created: 1
  files_modified: 2
---

# Phase 25 Plan 01: Agent Messages Migration — Foundation Summary

**One-liner:** Replaced `agents.history TEXT` JSON blob with append-only `agent_messages` table, adding `AgentStore.appendMessages` and `AgentStore.compactHistory` with atomic transaction wrapping, and simplified `suspend`/`complete` to 2-arg signatures.

## What Was Built

### sql/004_agent_messages.sql
New migration file creating the `agent_messages` table and dropping `agents.history`:

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id         TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, id)
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_rowid ON agent_messages (agent_id);
ALTER TABLE agents DROP COLUMN history;
```

Final column order confirmed via `PRAGMA table_info('agent_messages')`: `['id', 'agent_id', 'data', 'created_at']`

### src/db/agents.ts — Key Changes (Edits 1–17)

| Edit | Location | Change |
|------|----------|--------|
| 1 | Line 1 | Add `transaction` to imports from `./index.js` |
| 2 | AgentRow interface | Remove `history: string | null` field |
| 3 | `rowToState()` | Signature changed to `(row: AgentRow, history: Message[])` — history passed in, not derived from row |
| 4 | Class fields | Add `stmtInsertMessage`, `stmtGetMessages`, `stmtDeleteMessages`, `stmtGetRowidForMessage`; remove `stmtAppendToHistory` |
| 5a | Constructor `stmtCreate` | Remove `history` column and `@history` bind param from INSERT |
| 5b | Constructor `stmtSuspend` | Drop `history = ?` — 2-param statement |
| 5c | Constructor `stmtComplete` | Drop `history = ?` — 2-param statement |
| 5d | Constructor | Replace `stmtAppendToHistory` with 4 new statements; `stmtInsertMessage`, `stmtGetMessages`, `stmtDeleteMessages`, `stmtGetRowidForMessage` |
| 6 | `create()` | Remove `history: null` from bind params |
| 7 | `get()` | Add secondary `stmtGetMessages.all(id)` query; pass `history` to `rowToState` |
| 8 | `suspend()` | Signature: `(id: string, question: string): void` |
| 9 | `complete()` | Signature: `(id: string, output: string): void` |
| 10 | `getActive()` | N+1 pattern: load messages per row, pass to `rowToState` |
| 11 | `getByStatus()` | N+1 pattern: same as `getActive()` |
| 12 | `getRecent()` | N+1 pattern: same as `getActive()` |
| 13 | `deleteAll()` | `DELETE FROM agent_messages` first (FK-safe ordering) |
| 14 | `updateHistory()` | Removed entirely |
| 15 | `appendToHistory()` | Replaced with 1-line shim: `this.appendMessages(id, [message])` |
| 16 | `appendMessages()` | New method: INSERT one row per message |
| 17 | `compactHistory()` | New method: atomic DELETE+INSERT in `transaction()`, re-inserts tail for rowid ordering |

### src/db/db.test.ts — Changes

**Updated existing tests (5 edits):**
- `suspends and resumes`: `appendMessages('t-2', [msg])` + `suspend('t-2', 'should I continue?')` (2-arg)
- `completes with output`: `complete('t-3', 'done!')` (2-arg, no `[]`)
- `getActive returns running and suspended`: `suspend('t-8', 'question?')` + `complete('t-9', 'done')` (both 2-arg)
- `appendToHistory adds a message` → replaced with `appendMessages inserts rows and get() retrieves them in rowid order`
- Color cycle test: `complete('c-b', 'done')` (2-arg)

**6 new tests added:**

| Test Name | Status |
|-----------|--------|
| `appendMessages inserts rows and get() retrieves them in rowid order` | PASS |
| `compactHistory atomically deletes old rows and inserts the summary` | PASS |
| `compactHistory with null summaryMsg performs delete-only (no insert)` | PASS |
| `compactHistory is a no-op when deleteBeforeId does not exist` | PASS |
| `deleteAll removes agent_messages rows before agents rows (FK-safe)` | PASS |
| `get returns history=[] for a freshly created agent (no agent_messages rows)` | PASS |
| `agent_messages table exists after migration with expected columns` | PASS |

**Final test result:** `npx vitest run src/db/db.test.ts` — 93 passed (93)

## Verification

- `npx tsc --noEmit` on `src/db/`: 0 errors
- `npx vitest run src/db/db.test.ts`: 93 passed (93)
- Full suite `npx vitest run`: RED — `archival.ts` and `local.ts` still call removed `updateHistory()` and old 3-arg `suspend`/`complete`. Plans 02 and 03 restore full-suite green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SQLite 3.51.2 rejects `rowid` in CREATE INDEX for composite-PK tables**
- **Found during:** Task 1 (migration test run)
- **Issue:** The plan specified `CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_rowid ON agent_messages (agent_id, rowid)` — SQLite 3.51.2 raises `no such column: rowid` when `rowid` is referenced as an explicit column in a CREATE INDEX for a table with a composite TEXT primary key (the table implicitly uses the PK as storage key and `rowid` is accessible via SELECT but not INDEX).
- **Fix:** Changed to `ON agent_messages (agent_id)` — still covers the `WHERE agent_id = ?` filter in all queries; `ORDER BY rowid ASC` in SELECT statements works because SQLite can use `rowid` in ORDER BY even without it being in a covering index.
- **Files modified:** `sql/004_agent_messages.sql`
- **Commit:** a9b3fa3

**2. [Rule 1 - Bug] compactHistory with plain DELETE+INSERT breaks ORDER BY rowid chronological invariant**
- **Found during:** Task 2 (TDD green run — 1 test failing)
- **Issue:** After `DELETE WHERE rowid <= cutoff` + `INSERT summary`, the summary gets a rowid HIGHER than m3 (which was already in the table), so `ORDER BY rowid ASC` returns `[m3, summary]` instead of the expected `[summary, m3]`.
- **Fix:** `compactHistory` now loads the "tail" messages (rowid > cutoff), then deletes ALL messages for the agent, then re-inserts: summary first, then tail. This gives summary a lower rowid than tail messages, preserving chronological ORDER BY rowid. The operation is O(tail) not O(full history) — in the archival use case, compaction only retains a small tail.
- **Files modified:** `src/db/agents.ts`
- **Commit:** 94e73b7

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| a9b3fa3 | test | TDD red: SQL migration + db.test.ts updated to new API signatures + 6 new test stubs |
| 94e73b7 | feat | TDD green: AgentStore refactored with row-per-message writes, new APIs, simplified signatures |

## Known Stubs

None — all new APIs are fully implemented and tested. The callers in `archival.ts` and `local.ts` still use the old `updateHistory` API (Plans 02 and 03 respectively), but this plan's surface is complete.

## Threat Flags

No new security-relevant surface introduced beyond what was in the plan's threat model. All SQL uses positional `?` bind parameters. `compactHistory` transaction atomicity confirmed working via test.

## Self-Check: PASSED

- FOUND: sql/004_agent_messages.sql
- FOUND: src/db/agents.ts
- FOUND: src/db/db.test.ts
- FOUND: 25-01-SUMMARY.md
- FOUND: commit a9b3fa3 (TDD red)
- FOUND: commit 94e73b7 (TDD green)
