---
phase: 54-single-source-of-truth-for-sub-agent-history
plan: "03"
subsystem: sub-agents/local
tags: [sub-agents, history, db-sourced, loop-refactor, work_start, injected-filter]
dependency_graph:
  requires:
    - phase: Phase 53 (inbound persistence layer — agent_messages table, injected flag at write time)
    - phase: Phase 54 Plan 01 (T1-T7 regression gate)
    - phase: Phase 54 Plan 02 (AgentStore.getHistoryWithinBudget primitive)
  provides:
    - DB-sourced loopIteration — transient per-pass history buffer rebuilt from agent_messages each tool-loop entry
    - Unified update() resume paths — both PATH B (emitter wake) and PATH C (resumeSuspended) converge on the DB reload
    - work_start retirement — completion guard replaced with !m.injected filter
    - Anti-double-injection — resumeSuspended no longer threads state.history; task persisted at spawn loads exactly once
    - Idle agents hold zero conversation history in memory
  affects:
    - src/sub-agents/local.ts
tech_stack:
  added: []
  patterns:
    - "DB-reload-at-loop-entry: getHistoryWithinBudget called at outer while top after inbox drain, before runToolLoop — scoped to one pass, dropped on park (mirrors head's assembler.assemble() per-turn pattern)"
    - "injected-filter completion guard: history.some(m => m.kind === 'tool_call' && !m.injected) replaces history.slice(workStart)"
    - "persist-then-reload: inbound messages call persistInbound (DB write) then rely on the DB reload to include them — no separate in-memory push"
    - "toolNudge persistence: the 'must use tools' nudge persisted with injected:true so it survives the next pass's DB reload (unlike the two intentionally transient non-persisted nudges)"
key_files:
  created: []
  modified:
    - src/sub-agents/local.ts
key_decisions:
  - "history param dropped from both runLoopFrom and loopIteration signatures entirely (cleaner than passing [] — no callers outside runLoop + resumeSuspended, so the param is structurally dead)"
  - "Budget anchor is this.archivalThreshold (default 120,000 tokens) — reuses an existing knob, consistent with maybeArchiveHistory, no new config field"
  - "toolNudgeSent nudge persisted (injected:true, persistInbound) — NOT in the plan's original non-persisted list; required for correctness because the nudge must survive the next outer while pass's DB reload (Rule 2 auto-fix)"
  - "Both non-persisted framing nudges ([Status check requested...], [Continue with your current task.]) pushed AFTER the DB reload every pass (P5 compliance)"
  - "DB reload at outer while top only — NOT inside runToolLoop rounds (P2 compliance: onRoundComplete injections don't appear twice)"
  - "No collateral tests fixed in Task 2 — full suite was already green; 2287 passed, 1 skipped, 0 failed"
patterns-established:
  - "Sub-agent loop entry pattern: inbox drain (persistInbound each) → DB reload (getHistoryWithinBudget) → non-persisted nudges → maybeArchiveHistory → runToolLoop — mirrors head's per-turn assemble→inject→run shape"
  - "Completion guard pattern: history.some(m => m.kind === 'tool_call' && !m.injected) — relies on Phase 53 injected flag discipline; all synthetic system messages carry injected:true"
  - "Nudge persistence policy: persisted (injected:true) if must survive across loop pass boundaries; transient (history.push only) if per-pass framing only"
requirements-completed: []

# Metrics
duration: ~40m (Task 1 implementation + verification); Task 2 full-suite run
completed: "2026-06-22"
---

# Phase 54 Plan 03: DB-Sourced loopIteration, Unified update() Path, work_start Retirement — Summary

**Eliminated the long-lived in-memory `history` parameter from `loopIteration`/`runLoopFrom`; `loopIteration` now rebuilds a transient buffer from `AgentStore.getHistoryWithinBudget(agentId, archivalThreshold)` on each tool-loop pass, drops it when the loop parks, and unifies both `update()` resume paths onto the DB as the single source of truth.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-06-22T03:36Z (estimated from context window)
- **Completed:** 2026-06-22
- **Tasks:** 2
- **Files modified:** 1 (src/sub-agents/local.ts only)

## Accomplishments

- `loopIteration` is now DB-sourced: each pass begins with `const history = this.agentStore.getHistoryWithinBudget(agentId, this.archivalThreshold)` after inbox drain — one transient buffer per pass, dropped on park
- Both `update()` resume paths converge on the DB reload: PATH B (emitter wake) emits `inbox` and the parked `loopIteration` picks up on the next outer `while` pass; PATH C (`resumeSuspended`) no longer builds `const history = [...(state.history ?? [])]` or threads it into `runLoopFrom` — the task message persisted at spawn (Phase 53) loads exactly once from the DB
- `work_start` callers removed from `runLoop` (~:502) and `update()` PATH A (~:255); the `work_start` DB column and `AgentStore.updateWorkStart` method remain inert (schema-compat per RESEARCH)
- Completion guard replaced: `history.some(m => m.kind === 'tool_call' && !m.injected)` at line 944 — relies on Phase 53's `injected` flag discipline; no `slice(workStart)` anywhere
- Full 7-test Phase 54 regression gate (T1–T7) GREEN; Phase 53 A–D GREEN; full suite 2287 passed, 0 failed, 1 skipped; `npx tsc --noEmit` clean

## Task Commits

1. **Task 1: DB-reload restructure + nudge ordering + work_start retirement + update() unification** - `c0f1d2d` (feat)
2. **Task 2: Full-suite regression + tsc gate** — verification only, no additional commit

## Files Created/Modified

- `/home/thenasty/shrok/src/sub-agents/local.ts` — Full loop refactor: `history` param dropped from `runLoopFrom`/`loopIteration`; DB reload inserted at outer `while` top; `updateWorkStart` callers removed; completion guard replaced with `!m.injected` filter; `toolNudgeSent` nudge persisted; non-persisted nudges repositioned after DB reload; inbox push sites converted to persist-then-reload pattern

## Decisions Made

**history param dropped entirely from runLoopFrom and loopIteration signatures:**
The plan offered two options: drop the param or pass `[]`. Dropping was cleaner — no callers existed outside `runLoop` and `resumeSuspended`, making the parameter structurally dead. Both callers now call `runLoopFrom(agentId, options, toolEntries, systemPrompt, emitter, isSuspended)` without a history argument.

**Budget anchor: `this.archivalThreshold` (default 120,000 tokens):**
Reuses an existing `LocalAgentRunner` field that already bounds long sub-agent histories via `maybeArchiveHistory`. Consistent, no new config key added.

**DB reload at the outer `while` top only (P2 compliance):**
The `getHistoryWithinBudget` call is strictly after the inbox-poll block and before `runToolLoop`. It does NOT occur between `runToolLoop` rounds — `onRoundComplete` injects mid-loop messages into the current transient buffer AND persists them; the next outer pass's DB reload picks them up naturally without duplication.

**toolNudgeSent nudge persisted (deviation from plan):**
See Deviations section.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] toolNudgeSent nudge persisted with injected:true**
- **Found during:** Task 1 (loopIteration restructure)
- **Issue:** The plan's nudge-handling section listed `[Status check requested...]` and `[Continue with your current task.]` as non-persisted, and `[You responded without calling any tools...]` (toolNudge) was implicitly in neither category. In the old architecture the toolNudge was pushed to the in-memory `history` then the loop `continue`d — so on the next iteration the nudge was already in `history`. In the new architecture, the next outer `while` pass begins with a fresh `getHistoryWithinBudget` DB reload — a non-persisted toolNudge would vanish, leaving the LLM with no signal that it must call a tool.
- **Fix:** Changed the toolNudge site to call `this.persistInbound(agentId, toolNudgeMsg, options)` (with `injected: true`) instead of `history.push(...)`. The nudge is in the DB before `continue`, so the next pass's DB reload includes it exactly once.
- **Files modified:** src/sub-agents/local.ts
- **Verification:** T1–T7 pass, tsc clean, full suite green
- **Committed in:** `c0f1d2d` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 — required for correctness; the nudge is a behavioral signal that must survive pass boundaries)
**Impact on plan:** Correctness fix, no scope creep, no structural change. The toolNudge now follows the same pattern as every other system message that must survive across loop iteration boundaries.

## Issues Encountered

None. The refactor was mechanically clean — tsc caught no type errors, all 7 Phase 54 tests were GREEN immediately after the implementation, and the full suite ran without collateral regression.

## User Setup Required

None — no external service configuration required. Internal loop refactor only.

## Next Phase Readiness

Phase 54 is complete (all 3 plans executed). The single-source-of-truth for sub-agent history is established:
- The `agent_messages` table is the canonical record (Phase 53 additive)
- The dashboard agent-stream view renders the full inbound+outbound back-and-forth (Phase 53 side-effect)
- `loopIteration` rebuilds from DB each pass; idle agents hold zero conversation in memory (Phase 54 Plan 03)
- The resume divergence between in-memory and DB resume paths is eliminated (Phase 54 Plan 03)

Ready for any next milestone phase. No blockers.

---

## Self-Check: PASSED

Files modified:
- `src/sub-agents/local.ts` — FOUND (via git log, Task 1 commit `c0f1d2d`)

Commits:
- `c0f1d2d` — feat(54-03): DB-sourced loopIteration, unified update() path, work_start retirement — FOUND

Source assertions confirmed:
- `grep -n "kind === 'tool_call' && !m\.injected" src/sub-agents/local.ts` → line 944 (completion guard) ✓
- `grep -n "slice(workStart)" src/sub-agents/local.ts` → no matches ✓
- `grep -n "updateWorkStart" src/sub-agents/local.ts` → no matches ✓
- `grep -n "getHistoryWithinBudget" src/sub-agents/local.ts` → line 766 (inside loopIteration) ✓
- `grep -n "state.history ?? \[\]" src/sub-agents/local.ts` → no matches ✓
- `git diff --name-only` (wave scope) → only `src/sub-agents/local.ts` ✓

*Phase: 54-single-source-of-truth-for-sub-agent-history*
*Completed: 2026-06-22*
