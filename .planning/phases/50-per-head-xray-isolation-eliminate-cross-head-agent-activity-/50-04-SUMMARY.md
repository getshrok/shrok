---
phase: 50
plan: 04
subsystem: dashboard/stream-filter+hooks+page
tags: [head-isolation, sse-filter, react-query, per-head-cache, wave-4]
dependency_graph:
  requires: [50-02 (DashboardEvent headId fields), 50-03 (api.xrayHistory/stewardRuns.list head params)]
  provides: [D-01 client half (SSE drop for all 6 per-head types), D-03 clear-and-re-backfill on switch]
  affects: []
tech_stack:
  added: []
  patterns: [perHeadTypes Set with per-type headId resolution, head-keyed React Query cache, useEffect reset on [selectedHead,qc]]
key_files:
  created: []
  modified:
    - dashboard/src/hooks/streamFilter.ts
    - dashboard/src/hooks/streamFilter.test.ts
    - dashboard/src/hooks/useStream.ts
    - dashboard/src/pages/ConversationsPage.tsx
decisions:
  - "perHeadTypes Set approach with per-type narrowing chosen over blanket cast: steward_run_added has no top-level headId — a blanket (event as { headId: string }).headId cast would silently read undefined and drop all steward runs for every head"
  - "TypeScript union narrowing: Set.has() alone does not narrow union members, so explicit event.type checks (message_added || typing || agent_message_added || agent_status_changed || memory_retrieval) are used for the top-level-headId branch"
  - "useQueryClient added to ConversationsPage.tsx (const qc) for the three reset useEffects; placed immediately after useStream(selectedHead)"
  - "stewardRuns reset shape { stewardRuns: [] } matches the api.stewardRuns.list response shape"
  - "Three dead ['activity'] invalidations removed from useStream.ts (message_added, agent_status_changed, steward_run_added handlers)"
metrics:
  duration: 8min
  completed_date: "2026-06-18"
  tasks_completed: 3
  files_modified: 4
---

# Phase 50 Plan 04: Expand SSE filter, head-key live accumulators, add reset effects Summary

Per-head SSE filter expanded from 2 to 6 event types using per-type headId resolution (fail-closed); live accumulators and backfill queries fully head-keyed in React Query; reset effects clear stale items on head switch. D-01 client half closed; D-03 clear-and-re-backfill behavior implemented.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Expand SSE filter drop set (per-type headId) and flip test cases | e98992d | dashboard/src/hooks/streamFilter.ts, streamFilter.test.ts |
| 2 | Head-key live accumulators in useStream.ts; remove dead ['activity'] invalidations | 0a5e545 | dashboard/src/hooks/useStream.ts, streamFilter.ts (tsc fix) |
| 3 | Head-key backfill/accumulator queries + add reset effects in ConversationsPage.tsx | 18d9af0 | dashboard/src/pages/ConversationsPage.tsx |

## Verification

- `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` — 14 tests passed (all 4 newly-scoped event types have drop-for-wrong-head + deliver-for-matching cases; steward built with payload.headId; others with top-level headId)
- `cd dashboard && npx tsc --noEmit` — zero errors (full dashboard clean)
- `cd dashboard && npx vitest run` — 97 tests passed (6 test files)
- `grep -c "perHeadTypes" dashboard/src/hooks/streamFilter.ts` → 2
- `grep -c "event.payload as StewardRun" dashboard/src/hooks/streamFilter.ts` → 1
- `grep -ci "T-33-09" dashboard/src/hooks/streamFilter.ts` → 0
- `grep -ci "out of phase" dashboard/src/hooks/streamFilter.test.ts` → 0
- `grep -c "['xray-messages', event.headId]" dashboard/src/hooks/useStream.ts` → 1
- `grep -c "['stewardRuns', event.payload.headId]" dashboard/src/hooks/useStream.ts` → 1
- `grep -c "['memory-retrievals', event.headId]" dashboard/src/hooks/useStream.ts` → 1
- `grep -c "['agents', event.headId]" dashboard/src/hooks/useStream.ts` → 1
- `grep -c "['activity']" dashboard/src/hooks/useStream.ts` → 0
- `grep -c "['xray-messages', selectedHead]" dashboard/src/pages/ConversationsPage.tsx` → 2 (query key + reset)
- `grep -c "['memory-retrievals', selectedHead]" dashboard/src/pages/ConversationsPage.tsx` → 2
- `grep -c "['stewardRuns', selectedHead]" dashboard/src/pages/ConversationsPage.tsx` → 2

## Deviations from Plan

**1. [Rule 1 - Bug] TypeScript cannot narrow union headId from Set.has() check alone**
- **Found during:** Task 1 — Task 2 tsc run
- **Issue:** `streamFilter.ts` used a single `if (event.type === 'steward_run_added')` early-return, then fell through to `event.headId` for the remaining types. TypeScript correctly rejected this: after the Set.has() guard + the steward early-return, the remaining union members include `usage_updated` (no headId), making `event.headId` a type error.
- **Fix:** Added explicit `event.type === 'message_added' || typing || agent_message_added || agent_status_changed || memory_retrieval` check before `event.headId` access, with an unreachable `return false` fallback. This narrows the union to only the top-level-headId members. The blanket cast from PATTERNS.md was explicitly rejected because it would silently read `undefined.headId` for steward events.
- **Files modified:** dashboard/src/hooks/streamFilter.ts
- **Commit:** Folded into e98992d + 0a5e545

**2. [Rule 2 - Auto-add] useQueryClient was absent from ConversationsPage.tsx**
- **Found during:** Task 3
- **Issue:** The reset effects require `qc.setQueryData(...)` but `useQueryClient` was not imported and `const qc` was not declared in ConversationsPage.tsx.
- **Fix:** Added `useQueryClient` to the `@tanstack/react-query` import and declared `const qc = useQueryClient()` immediately after `useStream(selectedHead)`.
- **Files modified:** dashboard/src/pages/ConversationsPage.tsx
- **Commit:** 18d9af0

## Wave 3 Reconciliation

Plan 50-03 already landed `['xray-backfill', selectedHead]`, `['stewardRuns', selectedHead]`, and the arrow-function queryFn wrappers for both in ConversationsPage.tsx. Plan 50-04 completed the remaining flat keys (`['xray-messages']` and `['memory-retrievals']`) and added the three reset effects. No duplication occurred.

## Known Stubs

None. All per-head cache writes and reads use real `selectedHead` / `event.headId` / `event.payload.headId` values from runtime. No hardcoded heads or mock data.

## Threat Flags

None. T-50-07 (fail-open filter), T-50-08 (stale items after switch), and T-50-09 (flat accumulator interleaving heads) are all mitigated:
- T-50-07: Filter is fail-closed; per-type headId access prevents the blanket-cast undefined read; test cases pin both the drop path and the payload access path.
- T-50-08: Three reset effects clear live accumulators on [selectedHead]; head-keyed backfill keys force fresh fetch (cache miss).
- T-50-09: Each accumulator keyed on event.headId (or event.payload.headId for steward); ConversationsPage reads on selectedHead; filter guarantees equality for delivered events.

## Self-Check: PASSED

- dashboard/src/hooks/streamFilter.ts: FOUND (modified)
- dashboard/src/hooks/streamFilter.test.ts: FOUND (modified)
- dashboard/src/hooks/useStream.ts: FOUND (modified)
- dashboard/src/pages/ConversationsPage.tsx: FOUND (modified)
- Commit e98992d: FOUND (feat(50-04): expand SSE filter to all 6 per-head types with per-type headId access)
- Commit 0a5e545: FOUND (feat(50-04): head-key live accumulators in useStream.ts; remove dead activity invalidations)
- Commit 18d9af0: FOUND (feat(50-04): head-key xray/memory/steward queries + reset effects in ConversationsPage)
