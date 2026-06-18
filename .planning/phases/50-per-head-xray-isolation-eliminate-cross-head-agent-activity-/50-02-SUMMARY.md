---
phase: 50
plan: 02
subsystem: dashboard/events
tags: [head-isolation, sse-events, type-lockstep, wave-2]
dependency_graph:
  requires: [50-01 (StewardRun.headId)]
  provides: [agent_status_changed.headId, agent_message_added.headId, memory_retrieval.headId, steward_run_added.payload.headId]
  affects: [Plan 04 streamFilter.ts client-side drop filter]
tech_stack:
  added: []
  patterns: [conditional spread with as-cast for exactOptionalPropertyTypes, lockstep DashboardEvent union update]
key_files:
  created: []
  modified:
    - src/db/agents.ts
    - src/head/activation.ts
    - src/sub-agents/local.ts
    - src/index.ts
    - src/dashboard/events.ts
    - dashboard/src/types/api.ts
decisions:
  - "Conditional spread pattern requires 'as DashboardEvent' cast: exactOptionalPropertyTypes makes the spread produce headId? (optional) which is incompatible with the union's required headId: string. The cast is safe because the spread is controlled — headId is either present (string) or absent, never undefined."
  - "steward_run_added stays payload-only (no top-level headId on the union member) — head context rides StewardRun.headId added by Plan 01."
  - "DashboardEvent import added to agents.ts to enable the as-cast."
metrics:
  duration: 3min
  completed_date: "2026-06-18"
  tasks_completed: 2
  files_modified: 6
---

# Phase 50 Plan 02: Wire headId onto SSE emit sites and DashboardEvent unions Summary

Three formerly-leaky SSE events (`agent_status_changed`, `agent_message_added`, `memory_retrieval`) now carry a top-level `headId: string` at emit; `steward_run_added` carries head context via `StewardRun.headId` on the payload. Server and client `DashboardEvent` unions updated in lockstep. Full repo tsc-clean.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Thread optional headId onto all six AgentStore emit methods | 665bc32 | src/db/agents.ts |
| 2 | Wire headId at call sites and update both DashboardEvent unions in lockstep | ff4b59a | src/sub-agents/local.ts, src/head/activation.ts, src/index.ts, src/dashboard/events.ts, dashboard/src/types/api.ts, src/db/agents.ts |

## Verification

- `npx vitest run src/db/agents.test.ts` — 3 tests passed
- `npx tsc --noEmit` — zero errors (whole repo clean; Wave 1 activation.ts:1057 compile error resolved)
- `grep -c "headId" src/db/agents.ts` → 19 (all six methods reference headId)
- `grep -c "headId: a.headId" src/db/agents.ts` → 1 (cancelAllActive emits per-agent head)
- `grep -c "headId: string" src/dashboard/events.ts` → 5 (message_added, typing pre-existing + agent_status_changed, agent_message_added, memory_retrieval newly added)
- `grep "steward_run_added" src/dashboard/events.ts` → payload-only, no top-level headId
- `grep -c "headId: this.opts.headId" src/head/activation.ts` → 5 (includes memory_retrieval emit + steward append)

## Deviations from Plan

**1. [Rule 1 - Bug] exactOptionalPropertyTypes incompatibility with conditional spread**
- **Found during:** Task 2 tsc run
- **Issue:** `...(headId !== undefined ? { headId } : {})` produces `{ headId?: string }` in TypeScript's type system, which is incompatible with the union member's required `headId: string` under `exactOptionalPropertyTypes`.
- **Fix:** Added `as DashboardEvent` cast to each emit call in `agents.ts`. Also added `DashboardEvent` to the import from `../dashboard/events.js`. The cast is safe — the spread semantics are correct (headId is either a string or absent), and the union discriminant `type` ensures the right member is selected at runtime.
- **Files modified:** src/db/agents.ts
- **Commit:** ff4b59a (included in Task 2 commit)

## Known Stubs

None. The three emit-updated events carry a real headId from their owning runtime object (`this.headId` / `this.opts.headId` / `a.headId`). No hardcoded or placeholder values.

## Threat Flags

None. T-50-03 (missing headId fail-open) is mitigated: all four emit sites now have headId stamped at emit (three top-level, one payload-carried). T-50-04 (headId sourced from wrong context) is mitigated: headId sourced from runtime objects (`this.headId`, `this.opts.headId`, `a.headId`), never from request input.

## Self-Check: PASSED

- src/db/agents.ts: FOUND (modified)
- src/head/activation.ts: FOUND (modified)
- src/sub-agents/local.ts: FOUND (modified)
- src/index.ts: FOUND (modified)
- src/dashboard/events.ts: FOUND (modified)
- dashboard/src/types/api.ts: FOUND (modified)
- Commit 665bc32: FOUND (feat(50-02): thread optional headId onto all six AgentStore emit methods)
- Commit ff4b59a: FOUND (feat(50-02): wire headId at call sites and update both DashboardEvent unions in lockstep)
