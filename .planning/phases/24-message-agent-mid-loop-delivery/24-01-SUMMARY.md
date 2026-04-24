---
phase: 24
plan: 01
subsystem: tool-loop
tags: [tool-loop, callback, mid-loop, abort, tdd]
dependency_graph:
  requires: []
  provides: [onRoundComplete-callback]
  affects: [src/llm/tool-loop.ts, src/llm/tool-loop.test.ts, src/db/migrate.ts]
tech_stack:
  added: []
  patterns: [optional-callback-guard-pattern, tdd-red-green]
key_files:
  created: []
  modified:
    - src/llm/tool-loop.ts
    - src/llm/tool-loop.test.ts
    - src/db/migrate.ts
decisions:
  - onRoundComplete placed after loop-detection block and before terminal-tools check (line 440 in resulting file)
  - Uses if (options.onRoundComplete) guard (not optional-chaining) per exactOptionalPropertyTypes constraint
  - Throws AgentAbortedError (existing class) when callback returns true — no new error type
metrics:
  duration_minutes: 15
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_modified: 3
---

# Phase 24 Plan 01: onRoundComplete Callback Summary

**One-liner:** Additive `onRoundComplete?: () => Promise<boolean>` callback on `ToolLoopOptions` with 5-test TDD suite locking in fires-per-round, abort-on-true, continue-on-false, undefined-byte-equivalent, and ordering guarantees.

## What Was Built

Added `onRoundComplete?: () => Promise<boolean>` to `ToolLoopOptions` and wired its invocation into `runToolLoop`'s while-loop body. The callback fires after tool results are appended and after loop detection runs, before the terminal-tools check and before `refreshHistory`. Returning `true` throws `AgentAbortedError` (same class as the abortSignal path). Returning `false` continues the loop. Omitting the callback is byte-equivalent to the previous behavior.

## Insertion Points in src/llm/tool-loop.ts

- **Interface field:** Line 135 — `onRoundComplete?: () => Promise<boolean>` with JSDoc, placed after `abortSignal?: AbortSignal` inside `ToolLoopOptions`
- **Invocation block:** Lines 438–445 — `if (options.onRoundComplete)` guard with `await options.onRoundComplete()` and `throw new AgentAbortedError()`, inserted after the loop-detection closing comment (line 433) and before Step 7b terminal-tools check (line 446)

## Test Names Added to src/llm/tool-loop.test.ts

`describe('runToolLoop onRoundComplete callback')` containing:

1. `fires once per non-final round (after each tool_result append, before next LLM call)`
2. `returning true throws AgentAbortedError and skips the next LLM call`
3. `returning false continues the loop normally`
4. `undefined callback is byte-equivalent to existing behavior (no callback fires)`
5. `callback fires after tool_result append and before next LLM call`

## Verification

- `npx tsc --noEmit` exits 0
- `npx vitest run src/llm/tool-loop.test.ts src/llm/llm.test.ts` exits 0: 73 tests pass (27 in tool-loop.test.ts + 46 in llm.test.ts)
- The existing `runToolLoop` describe in `src/llm/llm.test.ts` (5 it-blocks) passes unchanged — proving the undefined-callback path is byte-equivalent

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (GREEN) | `1afc047` | feat(24-01): add onRoundComplete callback to ToolLoopOptions and runToolLoop |
| Task 2 (GREEN) | `ccfd698` | test(24-01): add describe('runToolLoop onRoundComplete callback') with 5 tests |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed nested-transaction crash in runMigrations**
- **Found during:** Task 1 — running tests revealed `cannot start a transaction within a transaction`
- **Issue:** `sql/003_usage_steward_memory.sql` contains standalone `BEGIN;`/`COMMIT;` statements. `runMigrations` wraps each SQL file in `transaction()` which issues its own `BEGIN` — causing SQLite to throw on the nested `BEGIN;` inside the file content.
- **Fix:** Strip standalone `BEGIN;`/`COMMIT;` lines (case-insensitive, multiline regex) from SQL content before executing inside `transaction()` in `src/db/migrate.ts`
- **Files modified:** `src/db/migrate.ts`
- **Commit:** `1afc047` (bundled with Task 1 implementation)
- **Impact:** This was a pre-existing bug that caused all 5 `runToolLoop` tests in `src/llm/llm.test.ts` to fail before this plan — confirmed by stash test. Now all 46 tests in that file pass.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary changes introduced.

## Self-Check: PASSED

- `src/llm/tool-loop.ts` exists and contains `onRoundComplete?: () => Promise<boolean>` at line 135
- `src/llm/tool-loop.test.ts` exists and contains `describe('runToolLoop onRoundComplete callback')`
- `src/db/migrate.ts` exists and contains BEGIN/COMMIT strip logic
- Commits `1afc047` and `ccfd698` confirmed present in git log
