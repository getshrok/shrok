---
phase: 54-single-source-of-truth-for-sub-agent-history
plan: 04
subsystem: testing
tags: [sub-agents, compaction, archival, history, budget]

# Dependency graph
requires:
  - phase: 54-single-source-of-truth-for-sub-agent-history
    provides: DB-sourced loopIteration (plan 03) and gap analysis (54-VERIFICATION.md BL-01)
provides:
  - Re-enabled sub-agent compaction/steward-summarization via historyBudget > archivalThreshold
  - Constructor invariant guard for LocalAgentRunner (throws on misconfiguration)
  - Genuine T4 regression guard asserting kind:'summary' from compactHistory
affects:
  - sub-agents
  - local-agent-runner
  - archival

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "historyBudget/archivalThreshold split: context-window-class budget for windowing (historyBudget) strictly greater than compaction trigger (archivalThreshold), mirroring the head assembler pattern"
    - "Constructor invariant guard: throw on historyBudget <= archivalThreshold to catch misconfiguration early"
    - "Test mock dispatch by message-content: detect archival steward by 'Summarize this conversation history' prefix; detect completion steward by tier='dumb' and absence of summary prefix"

key-files:
  created: []
  modified:
    - src/sub-agents/local.ts
    - src/system.ts
    - src/sub-agents/agents.test.ts

key-decisions:
  - "Option A1 honored: fix budget, keep compaction — historyBudget derived as contextWindowTokens (full window), archivalThreshold stays at contextWindowTokens * 0.80 fraction"
  - "historyBudget default: max(archivalThreshold * 2, 200_000) guarantees invariant even when only archivalThreshold is passed"
  - "system.ts wires historyBudget: config.contextWindowTokens (strictly > archivalThreshold for default 0.80 fraction)"
  - "T4 archival steward detection by message content ('Summarize this conversation history') rather than call-order, making the mock robust to timing-dependent call sequences"
  - "WR-01/WR-02/WR-03 explicitly out of scope per plan; not touched"

patterns-established:
  - "historyBudget-vs-archivalThreshold split: two distinct constants for windowing and compaction triggers, never the same value"

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-06-22
---

# Phase 54 Plan 04: Gap Closure — Sub-agent Compaction Re-enabled Summary

**Re-enabled sub-agent compaction by splitting windowing budget (historyBudget) from compaction trigger (archivalThreshold), mirroring the head assembler pattern; T4 now asserts a real kind:'summary' DB row.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-22T14:20:00Z
- **Completed:** 2026-06-22T14:33:01Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Re-enabled sub-agent compaction (BL-01): `getHistoryWithinBudget` at loop entry now uses `this.historyBudget` (context-window-class) instead of `this.archivalThreshold`, so windowed history can exceed the compaction trigger
- Added constructor invariant guard: throws `Error` if `historyBudget <= archivalThreshold` to catch misconfiguration at startup
- system.ts wires `historyBudget: config.contextWindowTokens` (full window, strictly > archivalThreshold at 0.80 fraction)
- T4 rewritten as genuine regression guard: asserts `history.some(m => m.kind === 'summary')` via compactHistory — fails if compaction is dead code
- All 111 tests green; tsc clean; no other T1–T7 or Phase 53 tests weakened

## Task Commits

Each task was committed atomically:

1. **Task 1: Decouple windowing budget from compaction trigger** - `c1b4f63` (fix)
2. **Task 2: Fix T4 to assert real kind:'summary' compaction** - `4a66403` (test)

## Files Created/Modified

- `src/sub-agents/local.ts` — Added `historyBudget?: number` option + `private historyBudget` field; constructor default `max(archivalThreshold*2, 200_000)` + invariant guard throw; windowing call changed from `this.archivalThreshold` to `this.historyBudget`
- `src/system.ts` — Added `historyBudget: config.contextWindowTokens` to LocalAgentRunner construction
- `src/sub-agents/agents.test.ts` — Extended `makeRunner` overrides type + spread to thread `historyBudget`; rewrote T4 with content-dispatch mock and `m.kind === 'summary'` assertion

## Decisions Made

- Used `max(archivalThreshold * 2, 200_000)` as the default historyBudget to guarantee the invariant even when only archivalThreshold is passed (test path uses archivalThreshold=30, gets historyBudget=200_000)
- Detected archival steward in T4 mock by message-content prefix ("Summarize this conversation history") rather than call-order — more robust to timing-dependent call sequences
- Kept T4's seeded-messages approach (appendMessages after spawn) with documented explanation of microtask sequencing: seeded messages land after the first DB reload but before the second, so archival fires on pass 2 (after the tool-nudge iteration)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] T4 mock call-order was incorrect due to microtask sequencing**

- **Found during:** Task 2 (Fix T4)
- **Issue:** The plan assumed seeded messages would be visible on the first loop pass (first DB reload), so call #1 would be the archival steward. In reality, the first DB reload occurs before `spawn()` returns (the loop runs synchronously to its first `await`), so seeded messages land after the first reload. Archival fires on pass 2, making call #2 the steward call (not call #1).
- **Fix:** Replaced call-counter dispatch with message-content-based dispatch: the archival steward call is detected by the "Summarize this conversation history" prefix (from archival.ts line 56). Pass 1 agent call returns `makeEndTurnResponse()` (triggering the tool nudge → pass 2). Pass 2 agent call makes the bash tool call.
- **Files modified:** src/sub-agents/agents.test.ts
- **Verification:** Test runs `Archived 1 messages into 1 summary.` and asserts `kind:'summary'` content = sentinel
- **Committed in:** 4a66403 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in plan's assumed call ordering)  
**Impact on plan:** Mock design adjusted to match actual JS microtask scheduling; all acceptance criteria met.

## Issues Encountered

- JavaScript microtask scheduling means `appendMessages` after `await runner.spawn()` does NOT land before the first DB reload (the loop runs synchronously to its first `await maybeArchiveHistory()`). Documented this clearly in the test comments. The practical effect: archival fires on pass 2 (not pass 1), and the mock was redesigned accordingly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- BL-01 fully closed: compaction is live code again for sub-agents
- WR-01/WR-02/WR-03 remain tracked as follow-ups in 54-REVIEW.md (out of scope for this plan)
- Phase 54 all plans complete; ready for any follow-up work on the warning items

---
*Phase: 54-single-source-of-truth-for-sub-agent-history*
*Completed: 2026-06-22*
