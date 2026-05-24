---
phase: 44-multi-head-task-delivery
plan: "02"
subsystem: sub-agents/activation
tags: [fan-out, multi-head, scheduling, agent-lifecycle]
dependency_graph:
  requires:
    - AgentState.deliverToHeadIds (Plan 44-01)
    - SpawnOptions.deliverToHeadIds (Plan 44-01)
    - Schedule.deliverToHeadIds (Plan 44-01)
  provides:
    - agent_completed fan-out at completeAgent (top-level branch)
    - agent_completed fan-out at ctx.complete closure (tool-driven early-exit)
    - scheduled trigger gate in suspendAsQuestion (D-06)
    - deliverToHeadIds preserved across suspend/resume in resumeSuspended
    - schedule.deliverToHeadIds threaded through handleScheduleTrigger spawn
  affects:
    - src/sub-agents/local.ts
    - src/head/activation.ts
tech_stack:
  added: []
  patterns:
    - Set-dedup fan-out loop: [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
    - for...of over deliverySet (noUncheckedIndexedAccess compliance)
    - conditional spread for optional deliverToHeadIds on resumeSuspended (mirrors skillName/parentAgentId)
    - conditional spread on activation.ts spawn: ...(schedule?.deliverToHeadIds?.length ? { ... } : {})
    - trigger gate at top of suspendAsQuestion before agentStore.suspend
key_files:
  created: []
  modified:
    - src/sub-agents/local.ts
    - src/head/activation.ts
decisions:
  - D-FAN-OUT-BOTH-SITES: both top-level completion sites (completeAgent + ctx.complete) receive identical fan-out loops — missing the ctx.complete site would silently deliver tool-driven early-exits to the owner only
  - D-DEDUP-OWNER: deliverySet uses new Set([this.headId, ...]) so the owner is never double-enqueued even if listed in deliverToHeadIds
  - D-TRIGGER-GATE: options.trigger === 'scheduled' predicate is narrow (not 'scheduled' | 'ad_hoc') — manual agents keep suspending; sub-agent question routing via parentAgentId branch is unchanged
  - D-RESUME-CONDITIONAL-SPREAD: state.deliverToHeadIds is always present (required string[] on AgentState) so the spread guard is .length (empty array = skip), not nullish
  - D-AGENT-FAILED-UNCHANGED: agent_failed enqueue at line 635 stays this.headId — owner-only (D-05); no fan-out loop added
  - D-ACTIVATION-SINGLE-SITE: only handleScheduleTrigger is touched (D-07: multi-head is scheduled path only); manual spawn_agent and sub-agent spawns are byte-identical to before
metrics:
  duration: 5min
  completed: "2026-05-24"
  tasks_completed: 2
  files_changed: 2
---

# Phase 44 Plan 02: Spawn/Complete Fan-out Summary

One-liner: Fan out `agent_completed` to every delivery head via `[...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]` at both top-level completion sites, gate scheduled agents out of question-suspension, preserve the delivery set across resume, and pass `schedule.deliverToHeadIds` through the scheduled spawn site.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fan out agent_completed at both top-level sites + gate scheduled questions + preserve set on resume | f29e208 | src/sub-agents/local.ts |
| 2 | Pass the schedule's delivery set through the scheduled spawn site (activation.ts) | 134309a | src/head/activation.ts |

## What Was Built

### Task 1 — local.ts (four edits)

**`resumeSuspended` (~line 401)** — added conditional spread `...(state.deliverToHeadIds.length ? { deliverToHeadIds: state.deliverToHeadIds } : {})` immediately after `headId: state.headId`. Mirrors the existing `skillName`/`parentAgentId` spread pattern. `state.deliverToHeadIds` is always present (required `string[]` on `AgentState` from Plan 01's `rowToState`), so the guard is `.length` not nullish.

**`completeAgent` top-level `else` branch (~line 982)** — replaced the single `queueStore.enqueue(..., this.headId)` with:
```typescript
const deliverySet = [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
for (const targetHeadId of deliverySet) {
  this.queueStore.enqueue({ type: 'agent_completed', id: generateId('qe'), agentId, output, createdAt: now() }, PRIORITY.AGENT_COMPLETED, targetHeadId)
}
```
The `Set` deduplicates the owner if also listed in `deliverToHeadIds`. Absent/empty set → `deliverySet === [this.headId]` → exactly one enqueue (byte-equivalent to pre-Phase-44 behavior).

**`buildAgentExecutor` `ctx.complete` closure (~line 1025)** — applied identical fan-out loop. `options` is the enclosing `buildAgentExecutor` parameter, already in scope in the closure. `state.completed = true` remains after the loop.

**`suspendAsQuestion` (~line 998)** — added trigger gate at the very top, before `agentStore.suspend`:
```typescript
if (options.trigger === 'scheduled') {
  this.completeAgent(agentId, question, options, history)
  return
}
```
D-06: a scheduled run has no human attached; the question text becomes the completed output and flows through the fan-out to all delivery heads.

**`agent_failed` enqueue (line 635)** — unchanged. Still `PRIORITY.AGENT_FAILED, this.headId` (owner-only, D-05).

### Task 2 — activation.ts (one edit)

**`handleScheduleTrigger` spawn call (~line 1282)** — added one more conditional spread after `...(scheduledModel ? { model: scheduledModel } : {})`:
```typescript
...(schedule?.deliverToHeadIds?.length ? { deliverToHeadIds: schedule.deliverToHeadIds } : {}),
```
`schedule` is already in scope from the earlier `scheduleStore.get(event.scheduleId)` read at line 1175. The `?.length` guard satisfies `exactOptionalPropertyTypes` — the key is omitted entirely when absent or empty, so non-multi-head tasks spawn byte-identically to today. `headId: this.opts.headId` unchanged.

`grep -c "deliverToHeadIds" src/head/activation.ts` → 1 (only the scheduled spawn site; no leakage into other spawn paths).

## Verification

- `npx tsc --noEmit` GREEN (both commits)
- `npx vitest run src/sub-agents/agents.test.ts` — 92/92 tests pass
- `grep -c "new Set(\[this.headId" src/sub-agents/local.ts` → 2 (both fan-out sites)
- `grep -c "for (const targetHeadId of deliverySet)" src/sub-agents/local.ts` → 2
- `grep -n "options.trigger === 'scheduled'" src/sub-agents/local.ts` → line 1001 (inside suspendAsQuestion)
- `grep -n "deliverToHeadIds.length ? { deliverToHeadIds: state.deliverToHeadIds }" src/sub-agents/local.ts` → line 401 (resumeSuspended)
- `grep -n "PRIORITY.AGENT_FAILED" src/sub-agents/local.ts` → line 635, still `this.headId` (owner-only)
- `grep -c "deliverToHeadIds" src/head/activation.ts` → 1

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all fan-out paths are wired end-to-end within this plan's scope. The integration regression tests (fan-out ×2 sites, dedup, no-set regression, question-suppression, agent_failed owner-only) are specified in Plan 05 by design.

## Threat Flags

None — per plan's threat model T-44-03/T-44-04/T-44-05, all new code paths stay within the validated delivery set (stamped at schedule-write time by Plan 03's route layer) and dedup is applied at fan-out time. No new network endpoints or auth paths introduced.

## Self-Check: PASSED

Files modified:
- src/sub-agents/local.ts: FOUND (f29e208)
- src/head/activation.ts: FOUND (134309a)

Commits exist:
- f29e208 (Task 1): FOUND
- 134309a (Task 2): FOUND
