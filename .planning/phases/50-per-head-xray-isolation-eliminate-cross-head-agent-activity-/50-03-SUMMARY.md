---
phase: 50
plan: 03
subsystem: dashboard/routes
tags: [head-isolation, backfill, rest-routes, react-query]
dependency_graph:
  requires: [50-01 (StewardRunStore.getRecent), 50-02 (StewardRun.headId client type)]
  provides: [xray-history ?head= scoping, steward-runs ?head= scoping, activity ?head= scoping, api.xrayHistory(headId?), api.stewardRuns.list(headId?)]
  affects: [Plan 04 streamFilter.ts client-side drop filter]
tech_stack:
  added: []
  patterns: [typeof req.query head guard (mirrors messages.ts:18 / agents.ts:11), ternary URL pattern (mirrors api.agents.list), head-keyed React Query cache (mirrors agents/messages queries)]
key_files:
  created: []
  modified:
    - src/dashboard/routes/agents.ts
    - src/dashboard/routes/steward_runs.ts
    - src/dashboard/routes/activity.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/ConversationsPage.tsx
decisions:
  - "xray window stays 50 per head (D-02 — no new limit constant); steward backfill uses 60 (mirrors existing activity.ts constant)"
  - "ConversationsPage.tsx queryFn call sites updated to arrow functions: bare function refs break when adding optional params (TypeScript QueryFunctionContext incompatibility with string)"
  - "xray-backfill and stewardRuns queries head-keyed in React Query cache: [xray-backfill, selectedHead] and [stewardRuns, selectedHead] — same convention as [agents, selectedHead] and [messages, selectedHead]"
  - "activity.ts head guard uses (head ?? 'default') for messages.getRecentText to preserve single-head behavior"
metrics:
  duration: 5min
  completed_date: "2026-06-18"
  tasks_completed: 2
  files_modified: 5
---

# Phase 50 Plan 03: Head-scope the REST backfill routes Summary

All three backend backfill routes (`/api/agents/xray-history`, `/api/steward-runs`, `/api/activity`) now accept `?head=` and pass it to head-filtered store reads. The client api wrappers (`api.agents.xrayHistory`, `api.stewardRuns.list`) gain optional `headId?` params and append `?head=` only when supplied. React Query call sites updated to arrow functions passing `selectedHead`, with head-scoped cache keys.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Head-scope the three backend backfill routes | 9fe1575 | src/dashboard/routes/agents.ts, steward_runs.ts, activity.ts |
| 2 | Add headId params to client api wrappers + update call sites | 5402a98 | dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx |

## Verification

- `grep -c "getRecent(50, head)" src/dashboard/routes/agents.ts` → 1
- `grep -c "getRecent(60, head)" src/dashboard/routes/steward_runs.ts` → 1
- `grep -c "getAll()" src/dashboard/routes/steward_runs.ts` → 0 (replaced)
- `grep -c "head" src/dashboard/routes/activity.ts` → 4 (guard + three scoped calls)
- `grep -c "xrayHistory: (headId" dashboard/src/lib/api.ts` → 1
- `grep -c "encodeURIComponent" dashboard/src/lib/api.ts` → 37 (two new: xrayHistory + stewardRuns.list)
- `npx tsc --noEmit` — zero errors (full repo clean)
- `cd dashboard && npx tsc --noEmit` — zero errors
- `npx vitest run src/dashboard` — 259 tests passed (13 files)

## Deviations from Plan

**1. [Rule 1 - Bug] React Query QueryFunctionContext incompatible with optional string param**
- **Found during:** Task 2 dashboard tsc run
- **Issue:** Changing `xrayHistory: () => ...` and `stewardRuns.list: () => ...` to accept `headId?: string` broke the call sites in `ConversationsPage.tsx` that passed them as bare `queryFn` references. React Query calls `queryFn` with a `QueryFunctionContext` object as the first argument; TypeScript correctly rejects `QueryFunctionContext` being assigned to `string | undefined`.
- **Fix:** Updated both `useQuery` call sites to arrow functions — `() => api.agents.xrayHistory(selectedHead)` and `() => api.stewardRuns.list(selectedHead)`. Also updated the query keys to include `selectedHead` (`['xray-backfill', selectedHead]` and `['stewardRuns', selectedHead]`) so React Query scopes the cache per head on switch (D-03 compliance).
- **Files modified:** `dashboard/src/pages/ConversationsPage.tsx`
- **Commit:** 5402a98

## Known Stubs

None. All route reads are wired to real head-filtered store methods. The `selectedHead` value flows end-to-end from the React Query key through the api wrapper to the query param to the store's WHERE clause.

## Threat Flags

None. T-50-05 (backfill route ignoring head param) is mitigated: acceptance greps confirm `getRecent(50, head)` and `getRecent(60, head)` at both backend sites. T-50-06 (untrusted ?head= value) is mitigated: the `typeof req.query['head'] === 'string'` guard at all three sites rejects array/object injection; the value is used only as a SQL bind parameter.

## Self-Check: PASSED

- src/dashboard/routes/agents.ts: FOUND (modified)
- src/dashboard/routes/steward_runs.ts: FOUND (modified)
- src/dashboard/routes/activity.ts: FOUND (modified)
- dashboard/src/lib/api.ts: FOUND (modified)
- dashboard/src/pages/ConversationsPage.tsx: FOUND (modified)
- Commit 9fe1575: FOUND (feat(50-03): head-scope xray-history, steward-runs, and activity backfill routes)
- Commit 5402a98: FOUND (feat(50-03): add headId params to api.xrayHistory and api.stewardRuns.list)
