---
phase: quick-260607-lwy
plan: 01
subsystem: dashboard/agents
tags: [bug-fix, dashboard, agents, head-scoping]
dependency_graph:
  requires: []
  provides: [head-scoped-agent-pills]
  affects: [src/db/agents.ts, src/dashboard/routes/agents.ts, dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx]
tech_stack:
  added: []
  patterns: [head-scoped-query-string, react-query-keyed-refetch]
key_files:
  created: [src/db/agents.test.ts]
  modified: [src/db/agents.ts, src/dashboard/routes/agents.ts, dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx, CHANGELOG.md]
decisions:
  - "Optional headId param on getRecent keeps xray-history caller unchanged (no headId = all heads)"
  - "useEffect on [selectedHead] resets knownAgents before head-scoped data arrives, ensuring stale pills clear immediately"
metrics:
  duration: "~8 minutes"
  completed: "2026-06-07"
  tasks_completed: 2
  files_changed: 6
---

# Phase quick-260607-lwy Plan 01: Fix Issue #10 — Head-scope the Dashboard Agent Pills Summary

## One-liner

End-to-end head-scoped agent-pills: getRecent(limit, headId?) DB filter → ?head= route param → api.agents.list(headId) → ['agents', selectedHead] query key + accumulator reset on head switch.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Head-scope the backend agent-pills path | 49cf687 | src/db/agents.ts, src/dashboard/routes/agents.ts, src/db/agents.test.ts |
| 2 | Head-scope the frontend agent-pills path | 352b9dd | dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx, CHANGELOG.md |

## What was built

Issue #10 root cause: the convo view already scoped messages to the selected head via `?head=` but the agent-pills path had no such scoping — `getRecent(20)` fetched all heads' agents, the query key was static `['agents']`, and the accumulator never reset on head switch.

Fix applied end-to-end:

1. **`src/db/agents.ts`**: `getRecent(limit, headId?)` — when `headId` is a string, filters with `WHERE head_id = ?`; when omitted, returns all agents (backward-compatible). The xray-history caller passes no headId and stays unfiltered.

2. **`src/dashboard/routes/agents.ts`**: GET `/` handler now reads `req.query['head']` and passes it to `getRecent(20, head)`. The xray-history handler's `getRecent(50)` is unchanged.

3. **`src/db/agents.test.ts`**: Three vitest tests: head-filtered returns only that head's agents; no-headId returns all 3 agents; unknown head returns empty array.

4. **`dashboard/src/lib/api.ts`**: `api.agents.list(headId?)` appends `?head=${encodeURIComponent(headId)}` when provided.

5. **`dashboard/src/pages/ConversationsPage.tsx`**: Query key changed to `['agents', selectedHead]`; queryFn becomes `() => api.agents.list(selectedHead)`. Added a `useEffect` keyed on `[selectedHead]` that resets `knownAgents` to an empty Map on head switch — stale pills from the previous head are cleared before the head-scoped data arrives.

6. **`CHANGELOG.md`**: `[0.3.0] ### Fixed` bullet added for #10.

## Verification

- Root `npx tsc --noEmit`: PASSED
- Dashboard `npx tsc --noEmit`: PASSED
- `npx vitest run src/db/agents.test.ts`: 3/3 PASSED
- `dashboard/dist/` NOT staged; `src/icw/*` untouched; `.planning/` NOT staged

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/db/agents.ts: modified (getRecent signature + conditional SQL)
- src/dashboard/routes/agents.ts: modified (req.query['head'] read, passed to getRecent)
- src/db/agents.test.ts: created (3 tests)
- dashboard/src/lib/api.ts: modified (list(headId?) + conditional URL)
- dashboard/src/pages/ConversationsPage.tsx: modified (query key, queryFn, reset effect)
- CHANGELOG.md: modified (#10 bullet)
- Commits 49cf687 and 352b9dd exist in git log
