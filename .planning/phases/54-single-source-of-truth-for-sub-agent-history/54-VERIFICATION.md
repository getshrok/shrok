---
phase: 54-single-source-of-truth-for-sub-agent-history
verified: 2026-06-22T00:30:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Compaction interaction is preserved and tested: after maybeArchiveHistory fires, the next pass loads summary + newer messages, not the full history"
    status: failed
    reason: "getHistoryWithinBudget(agentId, archivalThreshold) clamps history to <= archivalThreshold tokens by construction. maybeArchiveHistory receives this clamped array and immediately early-returns (estimateTokens(history) <= archivalThreshold is always true). The steward-summarization path is dead for sub-agents post-refactor. The T4 test passes for the wrong reason: with archivalThreshold=10, the task message is exactly 10 tokens, is included in the window (0+10 > 10 is false), and the first LLM call intended for the steward goes to the agent instead — whose response text happens to contain summaryContent, satisfying the test's content.includes() branch without any actual compaction occurring. No kind:'summary' message is ever created. Pre-Phase-54, the long-lived array grew past 120k and maybeArchiveHistory legitimately summarized the oldest 30%; post-Phase-54, old context is silently hard-dropped."
    artifacts:
      - path: "src/sub-agents/local.ts"
        issue: "Line 766: getHistoryWithinBudget(agentId, this.archivalThreshold) clamps history to <=archivalThreshold. Line 820: maybeArchiveHistory receives that already-clamped history; estimateTokens(history) <= archivalThreshold is always true; early-return always fires. The maybeArchiveHistory call at line 820 is dead code."
      - path: "src/sub-agents/agents.test.ts"
        issue: "T4 (compact test, line 2312): passes for wrong reason — the summaryOrNoticeRow found is a kind:'text' assistant response containing summaryContent, not a kind:'summary' message from compaction. The test's content.includes(summaryContent) branch matches incidentally. The strong assertion (summary message is present) is not actually verified."
    missing:
      - "Decouple the windowing budget from the compaction trigger. Either: (A) run maybeArchiveHistory on the FULL unbounded history first, then window the compacted result at a separate context-window-derived budget (analogous to the head's historyBudget from assembler.ts:166); or (B) intentionally remove the now-dead maybeArchiveHistory call and document that sub-agents rely on windowing alone (matching the head's model), deriving the window budget from contextWindowTokens rather than archivalThreshold."
      - "Fix the T4 test to assert kind:'summary' (not content.includes) so it actually verifies that a summary message was created by compactHistory. Currently the test cannot distinguish 'compaction fired' from 'agent response happened to contain the sentinel string'."
---

# Phase 54: Single Source of Truth for Sub-Agent History — Verification Report

**Phase Goal:** Eliminate the long-lived in-memory `history` array as a second source of truth for sub-agents, collapsing them onto the head's model where the DB is canonical. (1) Load history from the DB on each loop entry/wake with `historyBudget` windowing, mirroring the head's `assembler.ts:201` `messages.getRecent(...)`. (2) Collapse the two `update()` resume paths into one DB-sourced path. (3) Retire the `work_start` index in favor of the `injected`-flag filter. `runToolLoop` keeps its transient buffer. The ROADMAP explicitly lists "compaction interaction" as needing thorough tests.
**Verified:** 2026-06-22T00:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DB-sourced loop entry: `loopIteration` rebuilds history from DB on each tool-loop pass via `getHistoryWithinBudget`; idle agents hold zero conversation in memory | VERIFIED | `src/sub-agents/local.ts:766` — `const history = this.agentStore.getHistoryWithinBudget(agentId, this.archivalThreshold)` inside the outer `while(true)` body, after inbox drain, before `runToolLoop`. History not threaded across the park boundary. |
| 2 | Both `update()` resume paths read history from the DB; neither supplies an in-memory array | VERIFIED | `update()` PATH A (`completed` → resumeSuspended) no longer calls `updateWorkStart` and `resumeSuspended` no longer builds `const history = [...(state.history ?? [])]` or threads it into `runLoopFrom`. PATH B (emitter wake) emits inbox signal and the outer `while` reload picks it up. Comment at `:253` documents unification. `grep "state.history ?? \[\]" src/sub-agents/local.ts` → no matches. |
| 3 | `work_start` index retired; completion guard uses `!m.injected` filter | VERIFIED | `src/sub-agents/local.ts:944` — `const hasCalledTool = history.some(m => m.kind === 'tool_call' && !m.injected)`. `grep "updateWorkStart" src/sub-agents/local.ts` → no matches. `grep "slice(workStart)" src/sub-agents/local.ts` → no matches. |
| 4 | Anti-double-injection: after `resumeSuspended`, task message appears exactly once | VERIFIED | T7 passes. `resumeSuspended` no longer re-injects `state.task` as a first turn; the task persisted at spawn (Phase 53) is loaded from DB exactly once. |
| 5 | Compaction interaction preserved and tested: after `maybeArchiveHistory` fires, next pass loads summary + newer messages, not full history | FAILED | See gap below. `maybeArchiveHistory` is dead code in the new loop — windowing at `archivalThreshold` guarantees the history passed to it always has `estimateTokens <= archivalThreshold`, causing immediate early-return. T4 passes for the wrong reason (see detailed finding). |

**Score:** 4/5 truths verified

---

### The BL-01 Compaction Bug — Detailed Finding

**Root cause — one constant, two conflicting roles:**

```typescript
// local.ts:766 — window history to <= archivalThreshold
const history = this.agentStore.getHistoryWithinBudget(agentId, this.archivalThreshold)

// local.ts:820 — compact if estimateTokens(history) > archivalThreshold
await maybeArchiveHistory(agentId, history, {
  archivalThreshold: this.archivalThreshold,
  ...
})
```

`getHistoryWithinBudget` (agents.ts:323-335) iterates messages newest-first and breaks as soon as `used + cost > tokenBudget`. By definition the returned history has `estimateTokens(result) <= tokenBudget` (= `archivalThreshold`).

`maybeArchiveHistory` (archival.ts:29) early-returns when `estimateTokens(history) <= deps.archivalThreshold`.

These two together mean `maybeArchiveHistory` can **never** fire for sub-agents in the post-Phase-54 loop. The call at line 820 is dead code.

**The head model comparison confirms this is a divergence, not convergence:**

The head uses `historyBudget` for windowing (assembler.ts:166 — derived from `contextWindowTokens - baseSystemTokens - outputReserve - memoryBudget`, typically 50k–150k tokens) and has **no compaction at all**. Windowing-as-sole-bound is correct *for the head*. Sub-agents have `maybeArchiveHistory` as a separate compaction mechanism distinct from windowing — the two serve different purposes and should not share the same budget constant.

**Why T4 passes despite the bug:**

The T4 test uses `archivalThreshold: 10`. The task message "Phase54-TaskT4-compaction-trigger-test" is exactly 10 tokens (verified via tiktoken cl100k_base). `getHistoryWithinBudget(agentId, 10)`: `0 + 10 > 10` is false, so the task message IS included in the window (10 tokens, budget 10). `maybeArchiveHistory` receives `[taskMsg]` with `estimateTokens = 10 <= 10` → immediate early-return. No steward LLM call happens.

With no compaction, the first LLM call (intended by the test author as the steward's summary call) instead goes to the **agent's own first turn**, which returns `{ content: summaryContent, stopReason: 'end_turn', toolCalls: [] }`. This assistant text response is persisted to DB with `kind: 'text'`. The test finds it via `content.includes(summaryContent)` and the assertion passes — but no `kind: 'summary'` message was ever created, no `compactHistory()` was called, and no summarization occurred.

This is a false-positive test: the sentinel string appearing as an agent response text satisfies the test's second branch (`content.includes`), masking the complete absence of the compaction behavior the test is meant to guard.

**Behavior regression:**

Pre-Phase-54: A sub-agent with 401,200-token history (example from the REVIEW.md) would have the oldest 30% (~120,360 tokens / ~281 messages) summarized into a steward-generated summary message persisted to the DB. The LLM would see: `[summary] + [recent 281k messages]`.

Post-Phase-54: The same agent gets `getHistoryWithinBudget` returning the newest ~119k-token slice. The 281,200 oldest tokens are hard-dropped with no summary. The LLM abruptly loses context with no bridging summary. Output quality degrades silently for any long-running sub-agent.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/sub-agents/local.ts` | DB-sourced `loopIteration`, unified `update()` path, `work_start` retirement | VERIFIED (partial) | DB reload at line 766, work_start retired (line 944), update() paths unified. Dead `maybeArchiveHistory` call at line 820. |
| `src/db/agents.ts` | `getHistoryWithinBudget` method + `stmtGetMessagesDesc` | VERIFIED | Lines 322-335. Mirrors `MessageStore.getRecent` mechanics correctly. |
| `src/sub-agents/agents.test.ts` | T1–T7 tests in `describe('Phase 54: DB-sourced history')` block | PARTIAL | T1–T3, T5–T7 assert correct behaviors and provide real regression coverage. T4 passes for the wrong reason — does not actually verify compaction interaction. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `local.ts loopIteration` | `AgentStore.getHistoryWithinBudget` | DB load at outer while top | WIRED | line 766 |
| `local.ts completion guard` | `!m.injected` filter | `history.some(m => m.kind === 'tool_call' && !m.injected)` | WIRED | line 944 |
| `local.ts maybeArchiveHistory` | steward LLM summarization | `estimateTokens(history) > archivalThreshold` guard | BROKEN | windowing pre-clamps history so the guard never passes; dead code |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| T1–T7 all pass | `npx vitest run src/sub-agents/agents.test.ts -t "Phase 54"` | 7/7 passed | PASS (T4 false-positive) |
| Phase 53 regression | `npx vitest run src/sub-agents/agents.test.ts -t "Phase 53"` | 4/4 passed | PASS |
| tsc clean | `npx tsc --noEmit` | exit 0 | PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/sub-agents/local.ts` | 820 | Dead `maybeArchiveHistory` call — will never fire because windowing pre-clamps history to ≤ archivalThreshold | BLOCKER | Compaction/summarization silently disabled for all sub-agents; long-running agents hard-drop old context with no summary bridge |
| `src/sub-agents/agents.test.ts` | 2312 | T4 compaction test passes for wrong reason — `content.includes(summaryContent)` matches agent response text, not a summary message | BLOCKER | The test provides no actual coverage of the compaction path; the guard that should catch BL-01 is itself broken |
| `src/db/agents.ts` | 322 | JSDoc says `getHistoryWithinBudget` "Mirrors MessageStore.getRecent" without noting that callers must pass a context-window budget, not the archivalThreshold | INFO | Misleading documentation invites the same budget-conflation error in future callers |

### Human Verification Required

None — the bug is mechanically verifiable from the code.

---

## Gaps Summary

Phase 54 delivered three of its four stated goals cleanly: the DB-sourced loop entry, the `update()` path unification, and the `work_start` retirement are all correctly implemented and tested. The fourth goal — preserving compaction interaction — is not achieved.

**The root cause** is a single-constant collision: `this.archivalThreshold` is used both as the windowing budget (line 766) and the compaction trigger threshold (line 820). Because windowing is defined to return `estimateTokens <= budget`, passing the same value as both the budget and the trigger creates a tautological early-return in `maybeArchiveHistory`. The call at line 820 is permanently dead code.

**The ROADMAP** explicitly said "compaction interaction" needs thorough tests. T4 was written to be that test. It passes, but does not test compaction — the sentinel string reaches the DB as agent response text, not as a summary message, and the test's `content.includes()` branch matches incidentally.

**The fix requires one decision:** either (A) keep `maybeArchiveHistory` by calling it on the full unbounded history before windowing, using a separate context-window-derived budget for windowing; or (B) intentionally retire `maybeArchiveHistory` for sub-agents (matching the head model exactly) and derive the windowing budget from the model's context window rather than the archival threshold. Both options require removing the dead call at line 820 or fixing it, and replacing T4 with a test that asserts `kind: 'summary'` rather than `content.includes()`.

---

_Verified: 2026-06-22T00:30:00Z_
_Verifier: Claude (gsd-verifier)_
