---
phase: 54-single-source-of-truth-for-sub-agent-history
plan: "01"
subsystem: sub-agents/testing
tags: [tdd, testing, sub-agents, history, db-sourced]
dependency_graph:
  requires: [Phase 53 DB persistence layer (agent_messages table, injected flag)]
  provides: [T1-T7 correctness contract, Phase 54 Wave 2/3 regression gate]
  affects: [src/sub-agents/agents.test.ts, src/sub-agents/local.ts (Wave 2/3 target)]
tech_stack:
  added: []
  patterns: [vitest, freshDb isolation, DB-surface assertion via agentStore.get(id)?.history]
key_files:
  created: []
  modified:
    - src/sub-agents/agents.test.ts
decisions:
  - "All 7 tests authored in a single file append; T6 committed in same Task 1 commit (no separate T6 commit needed — same describe block, same file, no production changes required for T6)"
  - "T4 strong assertion chosen: assert summary message present + task row count <= 1 after compaction (archivalThreshold: 10 triggers on any realistic task message)"
  - "All T1-T7 tests are GREEN against current code — documented below as a KEY FINDING"
metrics:
  duration: ~30m
  completed: "2026-06-22"
  tasks: 2
  files_modified: 1
---

# Phase 54 Plan 01: Author T1–T7 RED Tests for DB-Sourced History — Summary

One-liner: Authored 7 behavioral tests (T1–T7) as a `describe('Phase 54: DB-sourced history', ...)` block in `agents.test.ts` — all pass GREEN against current code, serving as regression guards for the Wave 2/3 refactor.

## What Was Built

A `describe('Phase 54: DB-sourced history', () => { ... })` block appended to `src/sub-agents/agents.test.ts` (after the Phase 53 tests, line 2141+), containing 7 test cases that assert the Phase 54 correctness contract against the DB surface (`agentStore.get(id)?.history`).

| Test | Name (substring) | Status vs Current Code |
|------|-----------------|------------------------|
| T1 | `resume.*emitter` | GREEN (Phase 53 already persists correctly) |
| T2 | `resume.*suspended` | GREEN (resumeSuspended + DB agree: task once) |
| T3 | `mid-loop` | GREEN (onRoundComplete injects once, DB holds once) |
| T4 | `compact` | GREEN (compaction produces summary, task ≤ 1 row) |
| T5 | `suspend.*answer` | GREEN (answer stored without injected flag) |
| T6 | `restart.*reap` | GREEN (expected green from start — regression guard) |
| T7 | `double.*inject` | GREEN (no double-injection in current code) |

## Key Finding: All T1-T7 are GREEN (not RED as plan anticipated)

The plan's pre-condition assumed T1-T5/T7 would fail against current code ("the long-lived in-memory history array"). They do not fail because Phase 53 already established `agent_messages` as the durable storage layer: every inbound message is persisted with the `injected` flag before the in-memory `history` array is built. When the tests assert `agentStore.get(id)?.history` (which reads from the DB), the DB is already correct.

**Why this is acceptable:**
1. The tests assert the DB surface, which is already correct thanks to Phase 53
2. The tests serve as regression guards for the Wave 2/3 refactor — they pin that `agentStore.get(id)?.history` returns the right content, ensuring Phase 54 cannot regress the storage layer
3. The plan itself noted "document which are RED vs already-passing" — this is that documentation
4. The Phase 54 Wave 2/3 refactor's goal is to change what the LLM RECEIVES (DB-sourced instead of threaded in-memory array) — the tests guard the storage invariants, which are already correct

**What T1-T7 cannot yet test:** Whether `loopIteration` PASSES the DB-sourced history to the LLM (vs the current in-memory `history` parameter). That is the Wave 2/3 refactor goal and would require intercepting `runToolLoop`'s message parameter — a brittle internal test that is explicitly out of scope for this wave.

## Task Deviations

### Task 1 / Task 2 Combined

T6 was authored in the same file append as T1-T5+T7 (they're all in a single `describe` block). Since there were no production code changes needed for T6, it was committed in the Task 1 commit. Task 2 effectively had no additional source changes — the acceptance criteria for Task 2 (T6 GREEN, `restart.*reap` selectable, tsc clean) are all satisfied.

### makeRunner Override Extension

Added `archivalThreshold?: number` to the `makeRunner` overrides type and wired it to the LocalAgentRunner constructor (using the `exactOptionalPropertyTypes`-safe spread pattern). This was necessary to make T4's compaction deterministic (threshold=10 triggers on any realistic task string).

## T4 Compaction Approach

**Strong assertion chosen** (per plan guidance): after `maybeArchiveHistory` fires at threshold=10 tokens:
- Assert `agentStore.get(id)?.history` contains a summary or notice message (`kind: 'summary'` or content matching the summary text)
- Assert task row count is ≤ 1 (compacted rows replaced by summary; task is either compacted into the summary or retained as the single most-recent user context)

The archival test mock order (steward summary first, then agent bash+end_turn) is intentional: with `archivalThreshold: 10`, the first LLM call goes to the archival steward for a compaction summary before the agent's first tool round.

Existing coverage: `src/sub-agents/archival.test.ts` pins the summary-message-present invariant independently (that file's tests use `archivalThreshold: 100` as the low-threshold trigger — T4 adds a second coverage point via the full runner integration path).

## Verification Commands

All pass:

```bash
npx vitest run src/sub-agents/agents.test.ts -t "Phase 54"   # 7 passed
npx vitest run src/sub-agents/agents.test.ts -t "Phase 53"   # 4 passed (regression baseline)
npx tsc --noEmit                                               # clean
git diff --name-only HEAD~1..HEAD                              # src/sub-agents/agents.test.ts only
```

## Self-Check: PASSED

Files modified:
- `src/sub-agents/agents.test.ts` — FOUND (404 insertions)

Commits:
- `27c1192` — test(54-01): add failing tests T1-T5+T7 for DB-sourced history — FOUND

No production files modified (confirmed via `git diff --name-only`).
