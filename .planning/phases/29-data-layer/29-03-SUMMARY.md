---
phase: 29-data-layer
plan: "03"
subsystem: head
tags: [call-site-update, head_id, multi-head, compatibility, mechanical]
dependency_graph:
  requires: [QueueStore-headId-claim-methods, MessageStore-headId-read-methods]
  provides: [DATA-03-callers-updated, DATA-04-callers-updated, phase-30-unblocked]
  affects:
    - src/head/activation.ts
    - src/head/assembler.ts
    - src/head/index.ts
    - src/dashboard/routes/activity.ts
    - src/dashboard/routes/messages.ts
    - src/head/head.test.ts
    - src/sub-agents/agents.test.ts
    - tests/unit/queue.test.ts
    - tests/unit/activation.test.ts
    - tests/integration/head.test.ts
    - tests/scenarios/multi-message-batching.test.ts
    - tests/scenarios/archival-boundaries.test.ts
    - tests/scenarios/tool-heavy-archival.test.ts
    - scripts/eval/harness.ts
    - scripts/eval/scenarios/proactive-decision-realistic.ts
    - scripts/eval/scenarios/proactive-reminder.ts
    - scripts/eval/scenarios/agent-relay.ts
    - scripts/eval/scenarios/system-marker-hallucination.ts
    - scripts/eval/scenarios/combined-stress.ts
tech_stack:
  added: []
  patterns: [mechanical-call-site-update, interim-literal-headid]
key_files:
  created: []
  modified:
    - src/head/activation.ts
    - src/head/assembler.ts
    - src/head/index.ts
    - src/dashboard/routes/activity.ts
    - src/dashboard/routes/messages.ts
    - src/head/head.test.ts
    - src/sub-agents/agents.test.ts
    - tests/unit/queue.test.ts
    - tests/unit/activation.test.ts
    - tests/integration/head.test.ts
    - tests/scenarios/multi-message-batching.test.ts
    - tests/scenarios/archival-boundaries.test.ts
    - tests/scenarios/tool-heavy-archival.test.ts
    - scripts/eval/harness.ts
    - scripts/eval/scenarios/proactive-decision-realistic.ts
    - scripts/eval/scenarios/proactive-reminder.ts
    - scripts/eval/scenarios/agent-relay.ts
    - scripts/eval/scenarios/system-marker-hallucination.ts
    - scripts/eval/scenarios/combined-stress.ts
decisions:
  - D-11: Pass literal 'default' as headId at all call sites — smallest possible change that keeps tsc and tests green while Phase 30 builds real per-head plumbing
  - D-12: head.test.ts assertion updated from (expect.any(Number)) to ('default', expect.any(Number)) — and mock.calls[0]![0] → mock.calls[0]![1] for budget index
  - D-13: activation.test.ts, webhook.test.ts, scheduler.test.ts mock literals left unchanged — vi.fn() is structurally compatible with new signatures, no real call sites found in those files
metrics:
  duration_seconds: 540
  completed_date: "2026-05-12"
  tasks_completed: 3
  tasks_total: 3
  files_created: 0
  files_modified: 19
---

# Phase 29 Plan 03: Call-Site Update to 'default' headId Summary

**One-liner:** Mechanical insertion of `'default'` as first argument at all 47 call sites across 19 files to satisfy the new Plan 02 signatures, making `npx tsc --noEmit` exit 0 and all 1306 tests pass.

## What Was Built

### Task 1: Production src/ files (5 files, 24 call sites)

**src/head/activation.ts** — 17 edits:
- `claimNext()` → `claimNext('default')` (L227)
- `getRecent(Infinity)` → `getRecent('default', Infinity)` (L411, L1276)
- `getAll()` → `getAll('default')` (L449, L972, L1303)
- `getRecent(2000)` → `getRecent('default', 2000)` (L567)
- `claimAllPendingBackground()` → `claimAllPendingBackground('default')` (L618)
- `getSince(activationStart)` → `getSince('default', activationStart)` (L779, L814, L964)
- `getRecentBefore(activationStart, priorBudget)` → `getRecentBefore('default', activationStart, priorBudget)` (L782)
- `getRecent(config.headRelayStewardContextTokens)` → `getRecent('default', ...)` (L845)
- `claimAllPendingUserMessages()` → `claimAllPendingUserMessages('default')` (L918, L945)
- `getRecentTextByTokens(budget, fn)` → `getRecentTextByTokens('default', budget, fn)` (L1078, L1132)
- Added `// Phase 29 interim: pass 'default' headId until Phase 30 parameterizes ActivationLoop by head.` comment at L227

**src/head/assembler.ts** — 2 edits:
- `getRecent(historyBudget)` → `getRecent('default', historyBudget)`
- `getRecentTextByTokens(budget, fn)` → `getRecentTextByTokens('default', budget, fn)`

**src/head/index.ts** — 3 edits:
- `getRecentText(4)` → `getRecentText('default', 4)` (2 occurrences)
- `getRecent(tokens ?? 4000)` → `getRecent('default', tokens ?? 4000)` (1 occurrence)

**src/dashboard/routes/activity.ts** — 1 edit:
- `getRecentText(60)` → `getRecentText('default', 60)`

**src/dashboard/routes/messages.ts** — 1 edit:
- `getAll()` → `getAll('default')`

### Task 2: src/ test files (2 files modified)

**src/head/head.test.ts** — 2 edits:
- `toHaveBeenCalledWith(expect.any(Number))` → `toHaveBeenCalledWith('default', expect.any(Number))`
- `mock.calls[0]![0]` → `mock.calls[0]![1]` (budget is now at index 1, not 0)

**src/sub-agents/agents.test.ts** — 2 edits:
- Both `queueStore.claimNext()` real invocations → `queueStore.claimNext('default')`

Files with no real call sites (mock literals only — left unchanged):
- `src/head/activation.test.ts`, `src/webhook/webhook.test.ts`, `src/scheduler/scheduler.test.ts`

### Task 3: tests/ and scripts/ files (12 files, ~21 call sites)

**tests/unit/queue.test.ts** — 13 edits:
- `queue.claimNext()` → `queue.claimNext('default')` (7 occurrences)
- `queue.claimAllPendingBackground()` → `queue.claimAllPendingBackground('default')` (6 occurrences)

**tests/unit/activation.test.ts** — 1 edit:
- `messages.getAll()` → `messages.getAll('default')`

**tests/integration/head.test.ts** — 3 edits:
- `messages.getRecent(Infinity)` → `messages.getRecent('default', Infinity)` (3 occurrences)

**tests/scenarios/multi-message-batching.test.ts** — 3 edits:
- `queue.claimNext()`, `queue.claimAllPendingUserMessages()`, `messages.getAll()`

**tests/scenarios/archival-boundaries.test.ts** — 9 edits:
- `messages.getAll()` → `messages.getAll('default')` (9 occurrences)

**tests/scenarios/tool-heavy-archival.test.ts** — 1 edit:
- `messages.getAll()` → `messages.getAll('default')`

**scripts/eval/harness.ts** — 3 edits:
- `bundle.messages.getAll()` → `bundle.messages.getAll('default')` (3 occurrences)

**scripts/eval/scenarios/proactive-decision-realistic.ts** — 1 edit
**scripts/eval/scenarios/proactive-reminder.ts** — 3 edits
**scripts/eval/scenarios/agent-relay.ts** — 1 edit
**scripts/eval/scenarios/system-marker-hallucination.ts** — 2 edits
**scripts/eval/scenarios/combined-stress.ts** — 1 edit

## Phase 29 Interim Breadcrumb

Location: `src/head/activation.ts` line 227 (just above `claimNext('default')`):

```typescript
// Phase 29 interim: pass 'default' headId until Phase 30 parameterizes ActivationLoop by head.
const claimed = this.opts.queueStore.claimNext('default')
```

Phase 30 can `grep -rn "Phase 29 interim"` to find all locations that need to be replaced with real per-head IDs.

## Requirements Satisfied

- **DATA-03:** Every `claimNext`, `claimAllPendingBackground`, `claimAllPendingUserMessages` call site now passes a headId string — verified by grep returning 0 zero-arg matches.
- **DATA-04:** Every `getRecent`, `getAll`, `getSince`, `getRecentBefore`, `getRecentText`, `getRecentTextByTokens` call site now passes a headId string — verified by grep returning 0 zero-arg matches.

## Verification Results

- `npx tsc --noEmit` — **0 errors** (entire repo clean)
- `npx vitest run` — **1306 tests passed**, 0 failures (77 test files passed, 3 skipped)
- All acceptance criteria grep counts match expected values:
  - `claimNext('default')` in activation.ts: 1
  - `claimAllPendingBackground('default')` in activation.ts: 1
  - `claimAllPendingUserMessages('default')` in activation.ts: 2
  - `messages.getRecent('default',` in activation.ts: 4
  - `messages.getAll('default')` in activation.ts: 3
  - `messages.getSince('default',` in activation.ts: 3
  - `messages.getRecentBefore('default',` in activation.ts: 1
  - `messages.getRecentTextByTokens('default',` in activation.ts: 2
  - `messages.getRecent('default', Infinity)` in head.test.ts (integration): 3
  - `messages.getAll('default')` in archival-boundaries.test.ts: 9

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: Production callers | `a0b39c4` | feat(29-03): update production callers to pass 'default' headId (Task 1) |
| Task 2: src/ test files | `48739b8` | feat(29-03): update src/ test call sites to pass 'default' headId (Task 2) |
| Task 3: tests/ and scripts/ | `039406a` | feat(29-03): update tests/ and scripts/ call sites to pass 'default' headId (Task 3) |

## Deviations from Plan

**1. [Rule 1 - Bug] head.test.ts assertion index fix**

- **Found during:** Task 2
- **Issue:** Line 369 accessed `vi.mocked(messages.getRecent).mock.calls[0]![0]` to get the budget argument. After Plan 02 changed the signature to `getRecent(headId, tokenBudget)`, index `[0]` is now `'default'` and `[1]` is the budget. The test assertion at line 368 also needed updating from `toHaveBeenCalledWith(expect.any(Number))` to `toHaveBeenCalledWith('default', expect.any(Number))`.
- **Fix:** Updated both lines — assertion now expects `('default', expect.any(Number))` and budget extraction uses `mock.calls[0]![1]`.
- **Files modified:** `src/head/head.test.ts`
- **Commit:** `48739b8`

All other changes were exactly as planned.

## Known Stubs

All call sites pass `'default'` as the headId literal — this is intentional and documented. Phase 30 will replace every `'default'` literal with a real per-head ID derived from the head configuration. The "Phase 29 interim" breadcrumb comment in `activation.ts` serves as the grep entry point for Phase 30.

No placeholder data, hardcoded empty values, or unconnected component stubs exist.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes. All changes are mechanical argument insertions at existing call sites. The `'default'` literal matches the column DEFAULT value (`head_id TEXT NOT NULL DEFAULT 'default'`), so behavior is semantically unchanged for single-head deployments (T-29-10 mitigated as planned).

## Self-Check: PASSED

- `src/head/activation.ts` — FOUND (modified, Phase 29 interim comment present)
- `src/head/assembler.ts` — FOUND (modified)
- `src/head/index.ts` — FOUND (modified)
- `src/dashboard/routes/activity.ts` — FOUND (modified)
- `src/dashboard/routes/messages.ts` — FOUND (modified)
- `src/head/head.test.ts` — FOUND (modified)
- `src/sub-agents/agents.test.ts` — FOUND (modified)
- `tests/unit/queue.test.ts` — FOUND (modified)
- `tests/unit/activation.test.ts` — FOUND (modified)
- `tests/integration/head.test.ts` — FOUND (modified)
- All scenario/harness files — FOUND (modified)
- Commit `a0b39c4` — verified present
- Commit `48739b8` — verified present
- Commit `039406a` — verified present
- `npx tsc --noEmit` exits 0 — CONFIRMED
- `npx vitest run` 1306 tests pass — CONFIRMED
