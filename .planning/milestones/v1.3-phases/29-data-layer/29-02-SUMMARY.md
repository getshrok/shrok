---
phase: 29-data-layer
plan: "02"
subsystem: database
tags: [sqlite, head_id, multi-head, queue-store, message-store, isolation]
dependency_graph:
  requires: [head_id-column-queue_events, head_id-column-messages]
  provides: [QueueStore-headId-claim-methods, MessageStore-headId-read-methods, DATA-03-isolation, DATA-04-isolation]
  affects: [src/db/queue.ts, src/db/messages.ts, src/db/db.test.ts]
tech_stack:
  added: []
  patterns: [sqlite-named-parameter-binding, sqlite-positional-parameter-binding, tdd-red-green]
key_files:
  created: []
  modified:
    - src/db/queue.ts
    - src/db/messages.ts
    - src/db/db.test.ts
decisions:
  - D-03: All three QueueStore claim methods accept headId — claimNext(headId), claimAllPendingBackground(headId), claimAllPendingUserMessages(headId)
  - D-04: Inner WHERE clause of atomic UPDATE...RETURNING gains AND head_id = @headId filter; named binding used to match existing stmtEnqueue style
  - D-05: All six head-facing MessageStore read methods accept headId as first parameter
  - D-06: sanitizeOrphans() and count() remain global (unscoped) — stmtGetAll kept unscoped for sanitizeOrphans
  - D-07: No write method signatures changed (append, deleteByIds, replaceWithSummary, updateTextContent, updateAttachments)
metrics:
  duration_seconds: 248
  completed_date: "2026-05-12"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 3
---

# Phase 29 Plan 02: Head-Scoped QueueStore and MessageStore Summary

**One-liner:** Threaded `headId: string` through all three QueueStore claim methods and all six MessageStore read methods via parameterized SQL filters, with stmtGetAll preserved unscoped for sanitizeOrphans and 14 new DATA-03/DATA-04 isolation tests.

## What Was Built

### src/db/queue.ts (modified)

**QueueRow interface:** Added `head_id: string` field.

**Signature changes (old → new):**
| Old | New |
|-----|-----|
| `claimNext(): ClaimedEvent \| null` | `claimNext(headId: string): ClaimedEvent \| null` |
| `claimAllPendingBackground(): ClaimedEvent[]` | `claimAllPendingBackground(headId: string): ClaimedEvent[]` |
| `claimAllPendingUserMessages(): ClaimedEvent[]` | `claimAllPendingUserMessages(headId: string): ClaimedEvent[]` |

**Prepared statement changes:**
- `stmtClaimNext`: inner `SELECT` gained `AND head_id = @headId` — atomic `UPDATE...WHERE id=(SELECT...LIMIT 1) RETURNING *` pattern preserved intact
- `stmtClaimAllBackground`: `WHERE` clause gained `AND head_id = @headId`
- `stmtClaimAllUserMessages`: `WHERE` clause gained `AND head_id = @headId`

All three use named binding (`{ headId }`) to match the existing `stmtEnqueue` style; named and positional bindings are not mixed within any single statement.

**Unchanged:** `enqueue`, `ack`, `fail`, `release`, `requeueStale`, `deleteAll`, `hasPending`.

### src/db/messages.ts (modified)

**MessageRow interface:** Added `head_id: string` field.

**New private field:** `stmtGetAllForHead: StatementSync` — `SELECT * FROM messages WHERE head_id = ? ORDER BY created_at ASC` — used by the new head-scoped `getAll(headId)`.

**Preserved unscoped:** `stmtGetAll` — `SELECT * FROM messages ORDER BY created_at ASC` — used exclusively by `sanitizeOrphans()` for its required global cross-head scan (D-06).

**Signature changes (old → new):**
| Old | New |
|-----|-----|
| `getRecent(tokenBudget: number)` | `getRecent(headId: string, tokenBudget: number)` |
| `getAll()` | `getAll(headId: string)` |
| `getSince(datetime: string)` | `getSince(headId: string, datetime: string)` |
| `getRecentBefore(before: string, tokenBudget: number)` | `getRecentBefore(headId: string, before: string, tokenBudget: number)` |
| `getRecentText(limit: number)` | `getRecentText(headId: string, limit: number)` |
| `getRecentTextByTokens(tokenBudget, fn)` | `getRecentTextByTokens(headId: string, tokenBudget, fn)` |

**Prepared statement changes:**
- `stmtGetRecent`: `WHERE head_id = ? ORDER BY created_at DESC`
- `stmtGetSince`: `WHERE head_id = ? AND created_at >= ? ORDER BY created_at ASC`
- `stmtGetRecentBefore`: `WHERE head_id = ? AND created_at < ? ORDER BY created_at DESC`
- `stmtGetAllForHead` (new): `WHERE head_id = ? ORDER BY created_at ASC`
- `getRecentText` inline prepare: `WHERE head_id = ? AND kind = 'text' AND injected = 0 ORDER BY created_at DESC LIMIT ?`
- `getRecentTextByTokens` inline prepare: `WHERE head_id = ? AND kind = 'text' AND injected = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`

All use positional `?` binding (matching the pre-existing pattern in these methods).

**Preserved global (unchanged signatures):** `sanitizeOrphans(): number`, `count(): number`.

**Preserved unchanged (D-07):** `append`, `deleteByIds`, `replaceWithSummary`, `updateTextContent`, `updateAttachments`, `findTextByAgentId`, `deleteAll`.

### src/db/db.test.ts (modified)

**Legacy test updates (QueueStore):** All `store.claimNext()`, `store.claimAllPendingBackground()`, and `store.claimAllPendingUserMessages()` calls in the existing `describe('QueueStore')` block updated to pass `'default'` — events inserted via `store.enqueue()` receive `head_id='default'` from the column DEFAULT.

**Legacy test updates (MessageStore):** All `store.getRecent(N)`, `store.getSince(dt)`, and `store.getRecentBefore(dt, N)` calls in the existing `describe('MessageStore')` block updated to pass `'default'` as the first argument.

**New DATA-03 tests (5):**
1. `claimNext(headId) never returns an event with a different head_id (DATA-03)` — cross-head isolation + both heads claimable
2. `claimNext(headId) returns null when no events for that head (DATA-03)` — empty-for-head returns null
3. `claimAllPendingBackground(headId) scopes to head (DATA-03)` — two personal + one work background event, each head gets only its own
4. `claimAllPendingUserMessages(headId) scopes to head (DATA-03)` — one personal + one work user_message, each head gets only its own
5. `claimNext(headId) respects priority within the head (DATA-03)` — higher priority claimed first within a head

**New DATA-04 tests (9):**
1. `getRecent(headId) returns only messages for that head (DATA-04)`
2. `getAll(headId) returns only messages for that head (DATA-04)`
3. `getSince(headId, datetime) returns only messages for that head (DATA-04)`
4. `getRecentBefore(headId, before, budget) returns only messages for that head (DATA-04)`
5. `getRecentText(headId, limit) returns only text messages for that head (DATA-04)`
6. `getRecentTextByTokens(headId, budget, fn) returns only text messages for that head (DATA-04)`
7. `sanitizeOrphans() remains global — sees orphans across heads (D-06)` — orphan under 'work' detected and removed even with text under 'personal'
8. `count() remains global across heads (D-06)` — counts messages from both heads
9. `getRecent(headId, budget) still respects token budget within head scope` — budget truncation still works after head filtering

## Requirements Satisfied

- **DATA-03:** QueueStore claim methods filter on `head_id` in SQL; proven by cross-head isolation tests
- **DATA-04:** MessageStore read methods filter on `head_id` in SQL; proven by cross-head isolation tests
- **D-05:** All six head-facing read methods accept `headId` as first parameter
- **D-06:** `sanitizeOrphans()` and `count()` remain global; `stmtGetAll` (unscoped) preserved for `sanitizeOrphans`
- **D-07:** No write method signatures changed

## Verification Results

- `npx vitest run src/db/db.test.ts` — **114 tests passed** (100 pre-existing + 14 new DATA-03/DATA-04)
- All head-scoped queries verified parameterized (no string concatenation): `grep -RnE "AND head_id = @headId|WHERE head_id = \?"` shows 9 parameterized occurrences across both files
- `stmtGetAll.all()` confirmed called only in `sanitizeOrphans()` body (unscoped global scan preserved)

## Known Compile Breakages in Callers (closed by Plan 03)

After this plan, `npx tsc --noEmit` reports errors in files that call the old zero-arg signatures:
- `src/head/activation.ts` — calls `claimNext()`, `claimAllPendingBackground()`, `claimAllPendingUserMessages()`
- `src/head/assembler.ts` — calls `getRecent()`, `getAll()`, `getSince()`, `getRecentBefore()`
- `src/head/index.ts` — calls `getRecentText()`, `getRecentTextByTokens()`
- `src/dashboard/routes/activity.ts` — calls `getRecent()`, `getAll()`
- Various other test files that call these methods

These are expected and documented in the plan. Plan 03 will update all callers to pass the appropriate `headId`.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: QueueStore | `3a2870c` | feat(29-02): update QueueStore claim methods to filter by headId (DATA-03) |
| Task 2: MessageStore | `42c3890` | feat(29-02): update MessageStore read methods to filter by headId (DATA-04) |

## Deviations from Plan

None — plan executed exactly as written.

The `AgentStore.getRecent(5)` call at line 497 of db.test.ts is a different method on a different store; it was correctly left unchanged (the acceptance criterion's zero-arg check applies only to `MessageStore.getRecent`).

## Known Stubs

None — all methods are fully implemented with real SQL filters; no placeholder data or hardcoded empty values.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan's threat model covers. All head_id filters use parameterized statements (T-29-09 mitigated). The atomic UPDATE pattern remains intact for T-29-07.

## Self-Check: PASSED

- `src/db/queue.ts` — FOUND (modified)
- `src/db/messages.ts` — FOUND (modified)
- `src/db/db.test.ts` — FOUND (modified)
- Commit `3a2870c` — verified present
- Commit `42c3890` — verified present
- 114 tests pass
