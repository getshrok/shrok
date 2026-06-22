---
phase: "53"
plan: "01"
subsystem: sub-agents
tags: [persistence, agent-messages, inbound, dashboard]
dependency_graph:
  requires: []
  provides: [inbound-message-persistence]
  affects: [agent_messages-table, dashboard-history-view, resume-correctness]
tech_stack:
  added: []
  patterns:
    - persistInbound private helper (appendMessages + emitMessageAdded in one call)
    - injected:true flag on system-injected messages (mirrors head/injector.ts convention)
key_files:
  created: []
  modified:
    - src/sub-agents/local.ts
    - src/sub-agents/agents.test.ts
    - CHANGELOG.md
decisions:
  - "Framing nudges ([Continue with your current task.] and [Status check requested...]) left in-memory only — they are loop-control scaffolding, not back-and-forth conversation"
  - "work_start index untouched — deferred to Phase 54 per LOCKED decision"
  - "resumeSuspended unchanged — loads from state.history (DB) and never re-injects the task, so no duplicate first turn"
  - "Two message_agent inject sites unified through persistInbound; idempotency guard is the markProcessed-before-poll invariant"
metrics:
  duration_minutes: ~45
  completed: "2026-06-21"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 3
---

# Phase 53 Plan 01: Persist Sub-Agent Inbound Messages Summary

**One-liner:** Additive inbound persistence for all sub-agent inject points — initial task, message_agent updates, resume answers, sub-agent notices, and synthetic skill reads now stored in agent_messages alongside LLM output.

## What Was Built

Every message a sub-agent receives is now stored in `agent_messages` at the moment it enters the conversation, mirroring how the head already handles both sides of its conversation (`activation.ts:555` for inbound, `:915` for outbound).

### Task 1 — `persistInbound` helper + 4 inject points

Added a private `persistInbound(agentId, msg, options)` helper that calls `appendMessages` and `emitMessageAdded` in one step. Wired it at:
- MCP-unavailable warning (with `injected: true`)
- Synthetic skill reads — both `tool_call` and `tool_result` (with `injected: true`)
- Resume/signal answer (genuine user input — no `injected` flag)
- Sub-agent completion/question/failure notices (with `injected: true`)

Commit: `6064c6b`

### Task 2 — Initial task + message_agent unification

Removed the in-place mutation branch that concatenated the initial task onto the MCP warning message. The task is now always a separate named `taskMsg` const, pushed and persisted unconditionally. This prevents the persist-then-mutate problem.

Unified both `message_agent` inject sites through `persistInbound`:
- Top-of-loop site: added `injected: true` and `persistInbound` call (was in-memory only)
- `onRoundComplete` site: switched from bare `appendMessages` to `persistInbound` so `emitMessageAdded` fires for live SSE

The idempotency guard remains the `markProcessed`-before-`poll` invariant — each inbox row gets `processed_at` set before the other site polls, so a single row is claimed by exactly one site.

Commit: `6af1034`

### Task 3 — Tests + CHANGELOG

Added `describe('Phase 53: inbound persistence', ...)` to `src/sub-agents/agents.test.ts` with four tests:
- **Test A:** Initial task stored as `role:user` row in DB without `injected` flag
- **Test B:** `message_agent` update stored exactly once across both inject paths (idempotency guard)
- **Test C:** `resumeSuspended` does not add a second task row after signal (no duplicate first turn)
- **Test D:** Skill-agent stores `injected: true` `tool_call` + `tool_result` rows for synthetic SKILL.md read

CHANGELOG updated under `## [next]` with a user-language Fixed entry about the dashboard now showing the full back-and-forth.

Commit: `f532e21`

## Decisions Made

1. **Framing nudges left in-memory only.** `[Continue with your current task.]` (~line 807) and `[Status check requested...]` (~line 772) are loop-control scaffolding — they're neither user input nor real back-and-forth. Leaving them in-memory matches the CONTEXT.md "Claude's Discretion" recommendation.

2. **`work_start` index untouched.** The CONTEXT.md LOCKED decision defers `work_start` changes to Phase 54. Phase 53 is purely additive — no index alignment problems arise because `work_start` is only read, not modified, by the changes here.

3. **`resumeSuspended` unchanged.** It builds history from `state.history` (the `agent_messages` DB) and has no separate task re-injection path. Once the task is persisted at spawn, it appears in `state.history` on any DB-path resume — no duplicate can form.

4. **Two `message_agent` sites, one idempotency guard.** Rather than merging the two sites structurally (a Phase 54 change), idempotency is guaranteed by the existing `markProcessed`-before-`poll` contract: whichever site claims the inbox row first marks it processed; the other site's poll returns empty. Verified by Test B.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. This change is purely additive persistence to an existing private DB table (`agent_messages`). No new network endpoints, no new trust boundaries, no new auth paths.

## Self-Check: PASSED

Files verified:
- `src/sub-agents/local.ts` — modified (confirmed)
- `src/sub-agents/agents.test.ts` — modified (confirmed)
- `CHANGELOG.md` — modified (confirmed)

Commits verified:
- `6064c6b` (Task 1) — exists
- `6af1034` (Task 2) — exists
- `f532e21` (Task 3) — exists

All 104 tests pass: `npx vitest run src/sub-agents/agents.test.ts` → 104 passed.
