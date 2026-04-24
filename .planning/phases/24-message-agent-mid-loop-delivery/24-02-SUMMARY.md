---
phase: 24
plan: 02
subsystem: sub-agents
tags: [sub-agents, tool-loop, mid-loop, inbox, tdd, MSG-01]
dependency_graph:
  requires: [onRoundComplete-callback]
  provides: [mid-loop-inbox-delivery]
  affects: [src/sub-agents/local.ts, src/sub-agents/agents.test.ts, src/sub-agents/cancel.test.ts]
tech_stack:
  added: []
  patterns: [closure-over-history, poll-inject-pattern, not-marking-retract-processed]
key_files:
  created: []
  modified:
    - src/sub-agents/local.ts
    - src/sub-agents/agents.test.ts
    - src/sub-agents/cancel.test.ts
decisions:
  - Search all LLM call snapshots for injected message (not just last) because completion steward makes a separate llmRouter.complete call with 1-message history
  - onRoundComplete callback is inline closure keeping agentId, history, and this.inboxStore captures obvious
  - Retract branch returns true WITHOUT markProcessed so runLoopFrom error handler at lines 602-608 can find unprocessed retract
metrics:
  duration_minutes: 20
  completed_date: "2026-04-24"
  tasks_completed: 3
  files_modified: 3
---

# Phase 24 Plan 02: Mid-Loop Inbox Delivery Summary

**One-liner:** `onRoundComplete` callback wired into `loopIteration`'s `runToolLoop` call, injecting `update` messages into history mid-loop and returning true on `retract` without marking processed, with two integration tests locking in end-to-end behavior.

## What Was Built

Added an `onRoundComplete: async () => { ... }` closure to the `runToolLoop(this.llmRouter, { ... })` call inside `loopIteration` in `src/sub-agents/local.ts`. The callback is inserted immediately after `refreshHistory: () => history,` (line 844) at line 845 and before `...(agentVerbose ? { onVerbose: agentVerbose } : {})`.

**Callback behavior:**
- Polls `this.inboxStore.poll(agentId)` between LLM rounds
- For `update` messages: calls `markProcessed` and pushes a `TextMessage` with `role='user'`, `injected: true`, and instruction text `[Message received: ...]\nContinue your current task, addressing this update if relevant.` (omits `respond_to_message` — that tool is not in this `runToolLoop`'s tool list)
- For `retract` messages: returns `true` WITHOUT calling `markProcessed` — the unprocessed retract must remain in the inbox so `runLoopFrom`'s error handler (lines 602–608) can find it and classify the run as `'retracted'` instead of `'failed'`
- For other inbox types (signal, check_status, sub_agent_*): skips — the outer `loopIteration`'s top-of-loop poll handles them after `runToolLoop` returns
- Returns `false` when no abort-triggering messages found

## Insertion Point in src/sub-agents/local.ts

- **`onRoundComplete` callback:** Line 845 — immediately after `refreshHistory: () => history,` (line 844) and before `...(agentVerbose ? { onVerbose: agentVerbose } : {})` (line 884)

## Test Names Added

### src/sub-agents/agents.test.ts

`describe('mid-loop update delivery (Phase 24 MSG-01)')` containing:

1. `message_agent update arrives in agent history before end_turn` — agent runs 3 unique bash calls (80ms LLM mock sleep per round); update written to inbox at t=200ms is found in the messages array of a subsequent LLM call. Searches ALL captured call snapshots because the completion steward makes a separate `llmRouter.complete` call with a 1-message history (the last captured snapshot would miss the injection).

### src/sub-agents/cancel.test.ts

`describe('mid-loop retract via onRoundComplete callback')` containing:

1. `retract written to inbox during a long tool-call sequence yields status=retracted (not failed)` — agent runs unique bash calls (60ms LLM mock sleep); `runner.retract()` fires at t=200ms; asserts `agentStore.get(agentId)?.status === 'retracted'` and that `inboxStore.poll(agentId)` is empty (deleteForAgent cleanup guarantee).

## Timing Observations

From debug runs on this EC2 instance:
- LLM mock sleep of 80ms per call (agents.test.ts): update written at 200ms lands between round 2 and round 3 (actual call timings: ~278ms, ~443ms, ~538ms). Injection appears in call 3 (6 messages) and call 4 (8 messages). Call 5 is the steward call (1 message).
- LLM mock sleep of 60ms per call (cancel.test.ts): retract at 200ms is observed by `onRoundComplete` between rounds 3 and 4.

Both timing windows are generous (200ms budget with 60–80ms per round). No flakiness observed across multiple runs.

## Verification

- `npx tsc --noEmit` exits 0
- `npx vitest run src/llm/tool-loop.test.ts src/sub-agents/agents.test.ts src/sub-agents/cancel.test.ts` exits 0: 102 tests pass
- `npx vitest run` exits 0: 1235 tests pass, 1 skipped (integration), no regressions

Existing test blocks confirmed passing unchanged:
- `agents.test.ts` "Inbox processing" describe (69 tests before new block)
- `cancel.test.ts` four existing describe blocks (Tests 1–4)

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `9f0de01` | feat(24-02): wire onRoundComplete callback into runToolLoop call in loopIteration |
| Task 2 | `2806f6d` | test(24-02): add mid-loop update delivery integration test in agents.test.ts |
| Task 3 | `bd4f0f6` | test(24-02): add mid-loop retract integration test in cancel.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test searched only last LLM call snapshot but completion steward uses a separate call**

- **Found during:** Task 2 test execution (RED phase revealed failure)
- **Issue:** The plan's test code used `capturedMessagesPerCall[capturedMessagesPerCall.length - 1]` to find the injected message. The completion steward (run after the agent loop returns `end_turn`) calls `llmRouter.complete` with a 1-message steward prompt. This steward call becomes the last captured snapshot and does not contain the injected history message.
- **Fix:** Changed the test to iterate ALL captured message snapshots and find the first one containing the injected message. This correctly finds the injection in the tool-loop rounds while being unaffected by the steward's separate call.
- **Files modified:** `src/sub-agents/agents.test.ts`
- **Commit:** `2806f6d`

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check: PASSED

- `src/sub-agents/local.ts` exists and contains `onRoundComplete: async () =>` at line 845 (immediately after `refreshHistory: () => history,` at line 844)
- `src/sub-agents/agents.test.ts` exists and contains `describe('mid-loop update delivery (Phase 24 MSG-01)')`
- `src/sub-agents/cancel.test.ts` exists and contains `describe('mid-loop retract via onRoundComplete callback')`
- Commits `9f0de01`, `2806f6d`, `bd4f0f6` confirmed present in git log
- `npx tsc --noEmit` exits 0
- `npx vitest run` exits 0: 1235 tests pass
