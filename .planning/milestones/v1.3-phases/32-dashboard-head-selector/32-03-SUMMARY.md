---
phase: 32-dashboard-head-selector
plan: "03"
subsystem: ui
tags: [react, react-query, sse, typescript, head-selector, localStorage, dashboard]

# Dependency graph
requires:
  - phase: 32-dashboard-head-selector/32-02
    provides: GET /api/heads and GET /api/messages?head=<id> backend endpoints
  - phase: 32-dashboard-head-selector/32-01
    provides: head_id column on messages table and queue_events; resolveHeads() helper
provides:
  - Head selector pill row in ConversationsPage (conditional on >1 head, D-01 + D-03)
  - api.heads.list() and api.messages.list(headId?) in dashboard/src/lib/api.ts
  - useStream(currentHeadId) with ref-based SSE routing to head-scoped cache key (D-06)
  - selectedHead state with localStorage 'active-head' persistence and stale-id fallback (D-04)
  - messagesQuery rekeyed to ['messages', selectedHead] scoped to selected head (D-05)
affects: [phase-33, future-head-management-ui, dashboard-conversation-features]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "useRef pattern for stable SSE EventSource across React Query state changes"
    - "localStorage init in useState initializer + validated via useEffect after data fetch"
    - "React Query cache key scoping: ['messages', headId] for per-head isolation"

key-files:
  created: []
  modified:
    - dashboard/src/lib/api.ts
    - dashboard/src/hooks/useStream.ts
    - dashboard/src/pages/ConversationsPage.tsx

key-decisions:
  - "useRef for currentHeadId in useStream keeps SSE dep array as [qc] only — head switching does NOT reconnect the EventSource"
  - "localStorage 'active-head' validated against headsQuery.data after fetch; falls back to first head if stored id is stale"
  - "Head pill row conditionally rendered only when headsQuery.data.heads.length > 1 — zero visual change for single-head deployments"
  - "Send button continues targeting the 'default' head (D-07 read-only switching accepted)"

patterns-established:
  - "SSE stable ref pattern: capture changing prop in useRef, update ref in tracking useEffect, read ref inside SSE callback — dep array stays [qc]"
  - "localStorage persistence pattern: synchronous read in useState initializer, write-on-set in useCallback wrapper, validate against server data in useEffect"

requirements-completed: [DASH-01, DASH-02]

# Metrics
duration: 15min
completed: 2026-05-12
---

# Phase 32 Plan 03: Dashboard Head Selector UI Summary

**React Query head-scoped cache + conditional head pill row + ref-based SSE routing — closes DASH-01 and DASH-02 end-to-end**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-12T15:48:00Z
- **Completed:** 2026-05-12T15:52:00Z
- **Tasks:** 3 (2 auto + 1 human-verify)
- **Files modified:** 3

## Accomplishments

- `api.heads.list()` and `api.messages.list(headId?)` wired in dashboard/src/lib/api.ts; backward-compatible (no arg = `/api/messages` unchanged)
- `useStream(currentHeadId)` refactored with a `useRef` so head switching never tears down the SSE EventSource; `message_added` routes to `['messages', headId]`
- `ConversationsPage` gains `selectedHead` state (localStorage `'active-head'` persistence + stale-id fallback), `headsQuery`, and a head pill row that hides itself in single-head deployments
- Manual browser verification approved by user: Verification A (single-head, 0 visual change) and Verification B (multi-head, pill row, head switching, localStorage persistence, stale-id fallback) both passed

## Task Commits

1. **Task 1: Extend api.ts with api.heads + headId param on api.messages.list, update useStream to take currentHeadId via ref** — `e34a1b7` (feat)
2. **Task 2: Add selectedHead state, headsQuery, head pill row to ConversationsPage; rekey messagesQuery; update useStream call** — `4adbfbb` (feat)
3. **Task 3: Manual browser verification of head selector UI** — human-verify checkpoint, no code commit (user approved)

## Files Created/Modified

### `dashboard/src/lib/api.ts` (+10 / -4, lines 30–44 delta)

- Added `heads: { list: () => request<{ heads: Array<{ id: string }> }>('/api/heads') }` namespace between `auth` and `messages`
- Changed `messages.list` signature from `()` to `(headId?: string)` with conditional URL: `headId ? /api/messages?head=${encodeURIComponent(headId)} : /api/messages`

### `dashboard/src/hooks/useStream.ts` (+22 / -2, lines 7–15 and 28–39 delta)

- Signature changed from `useStream()` to `useStream(currentHeadId: string)`
- Added `currentHeadIdRef = useRef<string>(currentHeadId)` declaration
- Added tracking `useEffect(() => { currentHeadIdRef.current = currentHeadId }, [currentHeadId])` to keep ref current
- `message_added` handler: reads `currentHeadIdRef.current` as `headId`; writes to `['messages', headId]` instead of legacy `['messages']`
- SSE `useEffect` dep array remains `[qc]` — EventSource is NOT reconnected on head switches

### `dashboard/src/pages/ConversationsPage.tsx` (+63 / -3, lines 482–502, 535–553, 586–598, 784–810 delta)

- Lines 482–501: `selectedHead` state init from `localStorage.getItem('active-head') ?? 'default'`; `setSelectedHead` useCallback writes `localStorage.setItem('active-head', headId)`; `useStream(selectedHead)` call
- Lines 535–553: `messagesQuery` rekeyed to `['messages', selectedHead]`; `queryFn: () => api.messages.list(selectedHead)`; new `headsQuery` with `queryKey: ['heads']` and `staleTime: Infinity`
- Lines 586–598: stale-id validation `useEffect` — checks `headsQuery.data.heads`, falls back to `heads[0]?.id ?? 'default'` if stored head is missing
- Lines 784–810: head pill row JSX — guarded by `headsQuery.data?.heads && headsQuery.data.heads.length > 1`; pills use identical class strings to agent pill row (D-02 styling parity)

## Decisions Made

- **useRef for SSE routing (D-06):** Adding `currentHeadId` to the SSE `useEffect` dep array would reconnect the EventSource on every head switch (per RESEARCH §Open Question 2). The ref pattern lets the callback always read the current head without triggering reconnect.
- **localStorage init order (D-04):** `useState` initializer runs synchronously before `headsQuery` resolves, so the stored value is available immediately for the first render. The validation `useEffect` runs once `headsQuery.data` arrives and corrects stale values.
- **`dashboard/dist/` not committed locally:** Per AGENTS.md, CI rebuilds and commits `dashboard/dist/` on every passing run. A local Vite build was run to confirm the build exits 0, but the dist artifacts were not staged.

## Deviations from Plan

None — plan executed exactly as written. All five edits in Task 2 were applied in the specified order (selectedHead before messagesQuery, headsQuery before both). No unexpected TypeScript errors after Task 2 resolved the intermediate tsc error introduced by Task 1.

## Manual Verification Outcome

**Verification A — Single-head deployment (D-03 regression check): APPROVED**
- No head pill row visible in header
- Network request is `/api/messages` (no `?head=` param)
- `localStorage 'active-head'` unset or `'default'`

**Verification B — Multi-head deployment (DASH-01 + DASH-02 acceptance): APPROVED**
- Head pill row (`default` + `work`) appears above agent pill row
- Active pill: `bg-zinc-700 text-zinc-100`; inactive pill: `bg-zinc-800/50 text-zinc-500`
- Clicking `work` pill triggers GET `/api/messages?head=work`; empty list shown
- Reload preserves `work` selection; localStorage `active-head = work`
- Switching back to `default` shows only default-head messages
- Removing `work` from config: pill row disappears, localStorage falls back to `default` (stale-id validation effect ran)
- Send button targets `default` head per D-07 (read-only switching accepted)

## DASH-01 and DASH-02 Must-Haves: All Satisfied

| Must-Have | Truth | Status |
|-----------|-------|--------|
| `api.heads.list()` typed correctly | Returns `Promise<{ heads: Array<{ id: string }> }>` | DONE |
| `api.messages.list(headId?)` backward-compat | No-arg = `/api/messages`; with id = `?head=<encoded>` | DONE |
| `useStream(currentHeadId)` routes to `['messages', currentHeadId]` | Confirmed by D-06 ref pattern | DONE |
| SSE EventSource NOT torn down on head switch | dep array stays `[qc]` only | DONE |
| `selectedHead` from localStorage + stale-id fallback | Validated against `headsQuery.data` after fetch | DONE |
| `messagesQuery` uses `['messages', selectedHead]` | queryKey and queryFn both scoped | DONE |
| Head pill row only when `heads.length > 1` | D-03 guard confirmed in Verification A | DONE |
| Head pill row uses identical pill styling | `bg-zinc-700 text-zinc-100` copied verbatim from agent row | DONE |
| Send button unchanged (D-07) | No modification to handleSend or input | DONE |

## Issues Encountered

None.

## Known Stubs

None — all data sources are wired. `headsQuery` fetches from `/api/heads`; `messagesQuery` fetches from `/api/messages?head=<selectedHead>`. No hardcoded empty values flow to UI rendering.

## Threat Flags

None — all surfaces introduced (localStorage 'active-head' validation, XSS via `{h.id}` React rendering, SSE cache routing) were covered in the plan's threat model (T-32-08, T-32-09, T-32-11) and mitigated as specified.

## Next Phase Readiness

Phase 32 is fully complete. DASH-01 (head selector UI) and DASH-02 (head-scoped conversation view) are satisfied end-to-end across the full stack:
- Phase 32-01: `head_id` schema on `messages` and `queue_events`; resolveHeads() helper
- Phase 32-02: GET `/api/heads` and GET `/api/messages?head=<id>` backend endpoints
- Phase 32-03: head selector pill row, React Query cache scoping, SSE routing (this plan)

Per-head Send (DASH-F-03) is deferred to a future phase. The current Send-always-targets-default behavior is documented as D-07.

---
*Phase: 32-dashboard-head-selector*
*Completed: 2026-05-12*
