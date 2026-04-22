---
phase: 18-persistent-agent-color-slot-assignment
plan: "02"
subsystem: dashboard
tags: [api, dashboard, color-slot, react, typescript]
dependency_graph:
  requires: [color_slot-column, AgentState.colorSlot, AGENT_COLOR_SLOT_COUNT, pickColorSlot]
  provides: [colorSlot-on-agents-api, agentColorMap-from-slot]
  affects: [src/dashboard/routes/agents.ts, dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx]
tech_stack:
  added: []
  patterns: [slot-index-lookup, agents-query-memo-dep]
key_files:
  created: []
  modified:
    - src/dashboard/routes/agents.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/ConversationsPage.tsx
decisions:
  - "agentColorMap useMemo depends on [agentsQuery.data] not [timeline] — eliminates color shifts during streaming"
  - "buildAgentColorMap deleted in full — LRU timeline walk no longer needed with server-persisted slots"
  - "AGENT_COLORS[a.colorSlot] guarded by if (color) check — satisfies noUncheckedIndexedAccess and T-18-07 mitigation"
metrics:
  duration_seconds: 180
  completed_date: "2026-04-22"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 3
requirements: [D-06, D-07]
---

# Phase 18 Plan 02: Expose colorSlot Through API and Dashboard Summary

**One-liner:** `/api/agents` now returns `colorSlot: number | null` per agent; `ConversationsPage` builds `agentColorMap` from `agentsQuery.data` via `AGENT_COLORS[slot]`, replacing the deleted LRU timeline walk.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add colorSlot to agents API response and client type | e391a02 | src/dashboard/routes/agents.ts, dashboard/src/lib/api.ts |
| 2 | Replace buildAgentColorMap with agents-query lookup in ConversationsPage | fd1c97a | dashboard/src/pages/ConversationsPage.tsx, dashboard/dist/* |

## What Was Built

- **`src/dashboard/routes/agents.ts`**: `colorSlot: a.colorSlot ?? null` added to the `GET /api/agents` response mapper. All other fields unchanged.
- **`dashboard/src/lib/api.ts`**: `colorSlot: number | null` added to the `api.agents.list` inline return type (the `Array<{...}>` generic argument on line 65).
- **`dashboard/src/pages/ConversationsPage.tsx`**:
  - `buildAgentColorMap` function (32 lines, LRU timeline walk) fully deleted.
  - `agentColorMap` useMemo replaced: iterates `agentsQuery.data?.agents ?? []`, checks `a.colorSlot != null`, looks up `AGENT_COLORS[a.colorSlot]`, guards with `if (color)` for `noUncheckedIndexedAccess` compliance (T-18-07 mitigated).
  - Dependency array changed from `[timeline]` to `[agentsQuery.data]`.
  - `AGENT_COLORS` Okabe-Ito 7-color palette preserved verbatim (D-07).

## Verification

- `npx tsc --noEmit` — clean (repo root)
- `npx tsc -p dashboard/tsconfig.json --noEmit` — clean
- `npm run -w dashboard build` — clean (658 kB bundle, 8.64 s)

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints or auth paths introduced. `colorSlot` field on `/api/agents` is non-sensitive (display integer 0–6); `requireAuth` gate unchanged. T-18-07 bounds-check implemented via `if (color) map.set(...)`.

## Known Stubs

None — `agentColorMap` is fully wired to live `agentsQuery.data`; no placeholders remain.

## Self-Check: PASSED

- `src/dashboard/routes/agents.ts` contains `colorSlot: a.colorSlot` — FOUND (line 26)
- `dashboard/src/lib/api.ts` contains `colorSlot: number | null` — FOUND (line 65)
- `dashboard/src/pages/ConversationsPage.tsx` contains `AGENT_COLORS[a.colorSlot]` — FOUND (line 675)
- `buildAgentColorMap` absent from ConversationsPage.tsx — CONFIRMED
- Commits e391a02 and fd1c97a — FOUND
