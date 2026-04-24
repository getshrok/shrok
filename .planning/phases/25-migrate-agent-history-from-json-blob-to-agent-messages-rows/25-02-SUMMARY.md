---
phase: 25
plan: 02
subsystem: sub-agents
tags: [migration, archival, compaction, append-only, row-per-message]
requires: [agent_messages-table, AgentStore-compactHistory]
provides: [archival-compactHistory-callsites]
affects: [src/sub-agents/archival.ts]
tech_stack_added: []
tech_stack_patterns: [tdd-red-green, atomic-compaction, typed-TextMessage]
key_files_created:
  - src/sub-agents/archival.test.ts
key_files_modified:
  - src/sub-agents/archival.ts
decisions:
  - noticeMsg declared as typed `const noticeMsg: TextMessage` instead of `{...} as TextMessage` cast — satisfies exactOptionalPropertyTypes cleanly, no implicit undefined on optional fields
  - DB-vs-memory ordering asymmetry for summary and notice is deliberate — in-memory history has summary/notice at index 0 (via splice/unshift), but DB rowid order places it after re-inserted tail rows since it is INSERTed last by compactHistory; this matches head MessageStore.replaceWithSummary semantics and the append-only invariant
  - Empty-text trim path testable only with cutoff=1 (4-message history) and archivalThreshold=0 — `[''].join('\n')` is '' (falsy) but `['',''].join('\n')` is '\n' (truthy)
metrics:
  duration_seconds: 420
  completed_date: "2026-04-24"
  tasks_completed: 1
  files_created: 1
  files_modified: 1
---

# Phase 25 Plan 02: Archival compactHistory Call-Site Migration Summary

**One-liner:** Replaced all three `updateHistory` calls in `archival.ts` with atomic `compactHistory` calls, passing `null`/`summaryMsg`/`noticeMsg` per path, with in-memory splice/unshift behavior preserved exactly.

## What Was Built

Single-file edit to `src/sub-agents/archival.ts` replacing the three `agentStore.updateHistory()` calls (lines 46, 85, 98 in original) with `agentStore.compactHistory()` calls. The in-memory `history` array mutations via `splice` and `unshift` are unchanged — only the DB write path changed.

### Call-site changes (final line numbers in edited file)

| Path | Line | Call | Third arg |
|------|------|------|-----------|
| Empty-text trim | 47 | `compactHistory(deps.agentId, lastCompactedId, null)` | `null` — delete-only |
| Success | 87 | `compactHistory(deps.agentId, lastCompactedId, summaryMsg)` | `summaryMsg` — summary INSERT |
| Fallback | 102 | `compactHistory(deps.agentId, lastCompactedId, noticeMsg)` | `noticeMsg` — notice INSERT |

In all three paths, `lastCompactedId = toCompact[cutoff - 1]!.id` is captured before the splice (since splice mutates `history` in-place, making index access unreliable afterward).

### DB-vs-memory ordering asymmetry (deliberate)

`history.splice(0, cutoff, summaryMsg)` places `summaryMsg` at index 0 in the in-memory array. But `compactHistory` INSERTs the summary after re-inserting the tail rows, so it gets the highest rowid. On next `agentStore.get()`, `ORDER BY rowid ASC` returns: `[tail_messages..., summary]`.

This asymmetry is **deliberate and intentional**:
- The in-memory order is correct for the current run (LLM sees summary first for the remainder of the turn)
- The DB order matches the append-only invariant — rows are never backdated; summary is a new message at creation time
- This matches how head's `MessageStore.replaceWithSummary` works
- `summarySpan` records the original time window regardless of rowid position

The same asymmetry applies to the fallback `noticeMsg`. Since the fallback path is already a degraded-experience case (LLM summary failed), the ordering difference is inconsequential for user experience.

## Acceptance Criteria Verification

```
grep -c "updateHistory" src/sub-agents/archival.ts  → 0  ✓
grep -c "compactHistory" src/sub-agents/archival.ts → 3  ✓
grep -c "compactHistory(deps.agentId, lastCompactedId, null)" src/sub-agents/archival.ts → 1  ✓
grep -c "compactHistory(deps.agentId, lastCompactedId, summaryMsg)" src/sub-agents/archival.ts → 1  ✓
grep -c "compactHistory(deps.agentId, lastCompactedId, noticeMsg)" src/sub-agents/archival.ts → 1  ✓
grep -c "const lastCompactedId = toCompact\[cutoff - 1\]!.id" src/sub-agents/archival.ts → 3  ✓
grep -c "const noticeMsg: TextMessage" src/sub-agents/archival.ts → 1  ✓
grep -c " as TextMessage" src/sub-agents/archival.ts → 0  ✓
grep -c "history.splice(0, cutoff" src/sub-agents/archival.ts → 3  ✓
grep -c "history.unshift(noticeMsg)" src/sub-agents/archival.ts → 1  ✓
npx tsc --noEmit (archival.ts and archival.test.ts) → 0 errors  ✓
npx vitest run src/sub-agents/archival.test.ts → 11/11 pass  ✓
npx vitest run src/db/db.test.ts → pass  ✓
```

Pre-existing failures in `agents.test.ts` (7 failures) and `cancel.test.ts` (4 failures) were present before this plan's changes (verified via git stash) — not introduced by this plan.

## TDD Commits

- `test(25-02): 28521ce` — RED: 11 failing tests (all fail with `updateHistory is not a function`)
- `feat(25-02): 8680bb7` — GREEN: 3 edits to archival.ts, all 11 tests pass

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ToolResult shape in test fixtures**
- **Found during:** GREEN phase — tsc errors on archival.test.ts
- **Issue:** Test fixtures used `{ id: string; name: string; content: string }` for `ToolResult` but the type requires `{ toolCallId: string; name: string; content: string }` (no `id` field)
- **Fix:** Changed `id: \`tc${i}\`` to `toolCallId: \`tc${i}\`` in all tool_result test fixtures
- **Files modified:** `src/sub-agents/archival.test.ts`

**2. [Rule 1 - Bug] Fixed empty-text trim path test strategy**
- **Found during:** GREEN phase — `compactHistory` called 0 times in empty-text trim tests
- **Issue 1:** `tool_result` messages with empty content produce `[Tool results:\n  bash → ]` (non-empty), not `''` — so summaryText is never falsy with tool_result messages
- **Issue 2:** Empty text messages with `content: ''` joined by `\n` produce `'\n\n\n...'` (truthy) when count > 1; only `[''].join('\n') === ''` (cutoff=1 required)
- **Issue 3:** 4 empty-content messages have ~1 token which equals the threshold of 1, failing the `> threshold` check — needed `archivalThreshold: 0`
- **Fix:** Changed empty-text trim tests to use 4 text messages with `content: ''` and `archivalThreshold: 0` — gives cutoff=1, single empty message in toCompact, guaranteed to exceed threshold
- **Files modified:** `src/sub-agents/archival.test.ts`

**3. [Rule 1 - Bug] Removed broken `updateHistory` spy**
- **Found during:** GREEN phase — `vi.spyOn` throws when property doesn't exist on object
- **Issue:** `updateHistory` was deleted in Plan 01 — `vi.spyOn(agentStore, 'updateHistory')` throws `"updateHistory does not exist"`
- **Fix:** Removed the spy; absence of `updateHistory` is enforced at the type level (tsc would fail if archival.ts still referenced it)
- **Files modified:** `src/sub-agents/archival.test.ts`

## Known Stubs

None — all three call sites are fully wired to the real `compactHistory` implementation.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. The three compactHistory calls are internal, trust-bounded by `deps.agentId` (set by local.ts, same trust posture as before).

## Self-Check: PASSED

- src/sub-agents/archival.ts — FOUND
- src/sub-agents/archival.test.ts — FOUND
- 25-02-SUMMARY.md — FOUND
- feat commit 8680bb7 — FOUND
- test commit 28521ce — FOUND
