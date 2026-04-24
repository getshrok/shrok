---
phase: 25
plan: "03"
subsystem: sub-agents
tags: [agent-history, append-only, sqlite, local-agent-runner]
dependency_graph:
  requires: [25-01]
  provides: [agent-history-row-storage-wired]
  affects: [src/sub-agents/local.ts, scripts/eval/scenarios]
tech_stack:
  added: []
  patterns: [append-only row insert per message, 2-arg suspend/complete API]
key_files:
  created: []
  modified:
    - src/sub-agents/local.ts
    - scripts/eval/scenarios/agent-cancellation.ts
    - scripts/eval/scenarios/agent-pause-resume.ts
    - scripts/eval/scenarios/agent-progress-update.ts
    - scripts/eval/scenarios/relay-judge.ts
decisions:
  - eval scenario scripts updated to 2-arg API alongside local.ts (same API surface change)
metrics:
  duration_minutes: 12
  completed_date: "2026-04-24"
  tasks_completed: 1
  files_modified: 5
---

# Phase 25 Plan 03: Wire local.ts to Append-Only AgentStore API Summary

`LocalAgentRunner` wired to the Plan-01 AgentStore API: each Message produced by an agent is now a single-row INSERT into `agent_messages` via `appendMessages(agentId, [msg])`, replacing the per-round full-blob `updateHistory` rewrite that caused B-tree corruption.

## What Was Built

Four targeted edits to `src/sub-agents/local.ts`:

| Edit | Line | Change |
|------|------|--------|
| 1 | 837 | `updateHistory(agentId, history)` → `appendMessages(agentId, [msg])` in `appendMessage` callback |
| 2 | 961 | `complete(agentId, output, history)` → `complete(agentId, output)` in `completeAgent()` |
| 3 | 980 | `suspend(agentId, history, question)` → `suspend(agentId, question)` in `suspendAsQuestion()` |
| 4 | 1010 | `complete(agentId, output, history)` → `complete(agentId, output)` in inline `AgentContext.complete` closure |

The `history: Message[]` parameter is preserved in `completeAgent`, `suspendAsQuestion`, and `buildAgentExecutor` signatures — it is still consumed by other code paths (steward calls, spawn/message tool handlers). Only the `agentStore.*` call arguments were narrowed.

## Verification

- `grep -c "updateHistory" src/sub-agents/local.ts` = **0**
- `grep -c "updateHistory" src/` = **0** (project-wide; Plan 02 archival.ts also clean)
- `grep -c "appendMessages(agentId, \[msg\])" src/sub-agents/local.ts` = **1** (line 837)
- `grep -c "this.agentStore.suspend(agentId, question)" src/sub-agents/local.ts` = **1** (line 980)
- `grep -c "this.agentStore.complete(agentId, output)" src/sub-agents/local.ts` = **2** (lines 961, 1010)
- `npx tsc --noEmit` exits **0** — clean
- `npx vitest run` — **1252 passed, 1 skipped**, 73 test files, all green

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed eval scenario scripts calling 3-arg suspend/complete**
- **Found during:** tsc verification after editing local.ts
- **Issue:** Five call sites in `scripts/eval/scenarios/` used the old 3-arg `suspend(id, [], question)` and `complete(id, output, [])` signatures. These caused `TS2554: Expected 2 arguments, but got 3` errors.
- **Fix:** Updated all 5 call sites across 4 files to use the 2-arg API: `suspend(agentId, question)` and `complete(agentId, output)`.
- **Files modified:** `scripts/eval/scenarios/agent-cancellation.ts`, `agent-pause-resume.ts`, `agent-progress-update.ts`, `relay-judge.ts`
- **Commit:** 55d9673

## Known Stubs

None — all code paths are fully wired.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. The `appendMessages` path uses the prepared `stmtInsertMessage` with positional `?` binds (T-25-03a from the plan's threat register is satisfied).

## Self-Check

Commit 55d9673 exists: FOUND
`src/sub-agents/local.ts` modified: FOUND (in commit)
`npx tsc --noEmit` exits 0: CONFIRMED
`npx vitest run` 1252 passed: CONFIRMED

## Self-Check: PASSED

Post-plan manual verification (not required for plan completion — run against a live DB after a real agent run):
```bash
sqlite3 ~/.shrok/workspace/shrok.db "SELECT id, agent_id, substr(data, 1, 80) FROM agent_messages LIMIT 20"
```
After a real agent run, multiple rows per agent_id with distinct `id` values and valid JSON in `data` will confirm the append-only storage is working end-to-end.
