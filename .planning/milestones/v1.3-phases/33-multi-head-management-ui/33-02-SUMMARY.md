---
phase: 33-multi-head-management-ui
plan: 02
subsystem: dashboard
tags: [multi-head, dashboard, channel-adapter, routing, DASH-05]

requires:
  - phase: 33-multi-head-management-ui
    plan: 01
    provides: "MessageStore.append(msg, headId) is required at the type level; DashboardChannelAdapter constructor already takes (id, headId)"
  - phase: 31-adapter-registry-config-startup
    provides: "src/index.ts startup loop instantiates one ChannelRouter per head; resolvedHeads list available"
  - phase: 32-dashboard-head-selector
    provides: "createMessagesRouter mounted under /api/messages; res.locals['authenticated'] bypass test pattern in heads.test.ts"
provides:
  - "src/index.ts startup builds Map<headId, DashboardChannelAdapter> by registering one DashboardChannelAdapter per resolvedHead's ChannelRouter (no more resolvedHeads[0] guard)"
  - "DashboardServerOptions.dashboardAdapters: Map<string, DashboardChannelAdapter> (required, not optional)"
  - "createMessagesRouter(messages, dashboardAdapters: Map, mediaDir?): non-optional Map signature"
  - "POST /api/messages/send body { text, headId?, files? } — looks up adapter by headId with first-entry fallback when headId is missing or unknown"
  - "5 new tests in src/dashboard/routes/messages.test.ts proving DASH-05 routing contract"
affects: [plan-03-per-head-sse-filter, plan-04-heads-crud-router, plan-06-heads-tab-frontend]

tech-stack:
  added: []
  patterns:
    - "Map<headId, adapter> built at startup, passed by reference to DashboardServer — the messages router does runtime lookup, no per-request mutation"
    - "Server-trusted adapter set: client-supplied body.headId is a Map key only (not SQL, not eval); unknown keys silently fall back to the first entry — preserves single-head behavior and never leaks the head list via 404"
    - "Test isolation pattern: SpyAdapter extends DashboardChannelAdapter and overrides injectMessage to record calls without invoking the activation loop"

key-files:
  created: []
  modified:
    - src/index.ts
    - src/dashboard/server.ts
    - src/dashboard/routes/messages.ts
    - src/dashboard/routes/messages.test.ts

key-decisions:
  - "Required (not optional) Map field on DashboardServerOptions — the startup loop ALWAYS populates the map; an empty map would be a startup bug, not a valid state. Defensive 503 in the route is kept for tests / future-proofing per T-33-08 threat disposition"
  - "Tasks 1 and 2 split into separate commits per the plan structure, even though Task 1 alone leaves the project compile-broken (the type signature update in Task 2 is what closes the type hole). Acceptable intermediate state — both commits land before any verifier runs"
  - "[Rule 3 deviation] Updated the existing GET messages.test.ts call site from createMessagesRouter(store) to createMessagesRouter(store, new Map()) inside Task 2's commit — the new signature change made the prior single-arg call a tsc error"
  - "Added Task 3's POST /send tests to the EXISTING src/dashboard/routes/messages.test.ts file in a second describe block rather than creating a new file. The plan said 'create' but the file already exists (left over from Plan 32); honoring the constraint 'don't create separate test files when one already covers the route' from CLAUDE.md / project conventions"
  - "SpyAdapter uses `override injectMessage` (not just shadowing) — tsc with noImplicitOverride flag would complain otherwise; this matches DashboardChannelAdapter.injectMessage being non-private"

patterns-established:
  - "Per-head dashboard adapter is created INSIDE the head startup loop body (no more conditional gating). Future code that needs a per-head dashboard channel can grab it via the same Map<headId, adapter> wired into DashboardServerOptions"

requirements-completed: [DASH-05]

duration: 5min
completed: 2026-05-13
---

# Phase 33 Plan 02: Per-Head Dashboard Adapter Summary

**Each head now owns its own `DashboardChannelAdapter`, all collected into a `Map<headId, adapter>` that the messages router uses to dispatch `POST /api/messages/send` by `body.headId` — DASH-05 is now functional end-to-end at the adapter layer.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-13T20:17:32Z
- **Completed:** 2026-05-13T20:22:49Z
- **Tasks:** 3
- **Files modified:** 4 (no new files)

## Accomplishments

- Removed the `if (head === resolvedHeads[0])` guard at `src/index.ts:336` so every head's startup iteration creates and registers its own `DashboardChannelAdapter` on its router.
- Replaced `let dashboardAdapter: DashboardChannelAdapter | null = null` (single global) with `const dashboardAdapters = new Map<string, DashboardChannelAdapter>()` built up during the head loop.
- Updated `DashboardServerOptions` to take `dashboardAdapters: Map<string, DashboardChannelAdapter>` (required, replaces optional `channelAdapter`).
- `createMessagesRouter` now accepts the Map; `POST /send` parses `body.headId` and looks up the matching adapter via `dashboardAdapters.get(headId)` with `dashboardAdapters.values().next().value` as the first-entry fallback for missing/unknown head IDs.
- Added 5 new tests in `src/dashboard/routes/messages.test.ts` covering:
  - explicit per-head routing (body.headId='work' → work adapter, NOT default)
  - missing headId → first-adapter fallback
  - unknown headId → first-adapter fallback
  - empty Map → 503 'Dashboard channel not available'
  - empty body → 400 (existing behavior preserved)
- All 10 tests in messages.test.ts pass (5 prior GET + 5 new POST). Whole-tree `npx tsc --noEmit` is GREEN.

## Task Commits

Each task committed atomically:

1. **Task 1: Lift per-head DashboardChannelAdapter creation out of resolvedHeads[0] guard** — `f0f764a` (feat)
2. **Task 2: Route POST /api/messages/send by body.headId with first-entry fallback** — `1612ef9` (feat)
3. **Task 3: POST /api/messages/send per-head adapter routing tests (DASH-05)** — `acd9fa3` (test)

## Files Created/Modified

### Modified
- `src/index.ts` — lines ~231 + ~336 + ~426: `dashboardAdapter` (let, nullable) → `dashboardAdapters` (const Map); guard removed; DashboardServer construction passes the Map directly
- `src/dashboard/server.ts` — `DashboardServerOptions.channelAdapter?` → `dashboardAdapters: Map<string, DashboardChannelAdapter>` (required); mount-line update
- `src/dashboard/routes/messages.ts` — signature change; POST /send body now `{ text, headId, files }`; Map lookup with fallback replaces the old `if (!channelAdapter)` 503-only branch
- `src/dashboard/routes/messages.test.ts` — call site updated to pass `new Map()` (Rule 3 fix in Task 2); new `describe('POST /api/messages/send — per-head adapter routing (DASH-05)')` block with 5 tests + `SpyAdapter` helper class

## Decisions Made

- **Required (not optional) Map field on `DashboardServerOptions`**: The startup loop ALWAYS populates `dashboardAdapters` for every resolved head, and `resolveHeads()` always returns at least one head (D-08). An empty map is only reachable as a startup bug — making the field required surfaces that bug at the type level. The defensive 503 in the route is kept for tests and future-proofing per T-33-08.
- **Separate commits for Tasks 1 and 2 despite type-level interdependency**: Task 1's `src/index.ts` change references a `DashboardServerOptions.dashboardAdapters` field that doesn't exist until Task 2. Honoring the plan's per-task atomicity over keeping every commit independently compile-green — the intermediate state is short-lived and the verifier sees the final state.
- **Added Task 3 tests to the existing `messages.test.ts` (not a new file)**: The plan said "create `src/dashboard/routes/messages.test.ts`" but the file already exists from Plan 32 with the GET /api/messages tests. Adding the POST /send tests as a second `describe` block in the same file keeps the test surface coherent with the production file structure (one test file per route module).
- **`override injectMessage` on `SpyAdapter`**: Used the `override` keyword to make the parent-class shadowing explicit — matches TypeScript's `noImplicitOverride` discipline applied elsewhere in the codebase.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated existing `messages.test.ts` GET-test call site to new signature**

- **Found during:** Task 2 (after `createMessagesRouter` signature changed)
- **Issue:** The GET messages tests from Plan 32 called `createMessagesRouter(store)` with a single argument; the new required-Map signature made that a tsc error (TS2554: Expected 2-3 arguments, but got 1).
- **Fix:** Updated the call site to `createMessagesRouter(store, new Map())` — an empty Map is the natural fixture for tests that don't exercise POST /send routing.
- **Files modified:** `src/dashboard/routes/messages.test.ts` (1 line)
- **Verification:** Both `npx tsc --noEmit` and `npx vitest run src/dashboard/routes/messages.test.ts` exit 0; all 5 GET tests still pass.
- **Committed in:** `1612ef9` (Task 2 commit) — bundled with the signature change since they form one atomic API update

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking compilation in a call site outside the plan's enumerated files-modified).
**Impact on plan:** None — the deviation is a 1-line mechanical fix that follows directly from the planned signature change. The fix is co-located with the signature change in Task 2's commit, preserving atomicity per file.

## Issues Encountered

None blocking. The `tsc --noEmit src/index.ts` verify step in Task 1 was misspecified in the plan (the file-arg form ignores tsconfig and emits unrelated false errors); used the whole-tree `npx tsc --noEmit` for the real verification signal, which is what the plan's overall `<verification>` section also calls for.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 03 (per-head SSE filter):** ready — the per-head adapter foundation is now in place; Plan 03 can rely on each `DashboardChannelAdapter` being aware of its own head identity (`headId` is captured by `headRouteMessage` at startup) and emit per-head SSE events accordingly.
- **Plan 04 (heads CRUD router):** ready — when a head is deleted, the `dashboardAdapters` Map will need a matching `.delete(headId)` call inside the router lifecycle (a follow-on concern handled in Plan 04's adapter teardown).
- **Plan 06 (heads tab frontend):** ready — the dashboard can now POST messages with `body.headId` and trust that they route to the currently selected head; the frontend needs to thread `currentHeadId` through the send payload (Plan 06 work).

No blockers.

## Self-Check: PASSED

Verified the following commits exist:
- `f0f764a` (Task 1) — FOUND
- `1612ef9` (Task 2) — FOUND
- `acd9fa3` (Task 3) — FOUND

Verified contract:
- `grep -q "const dashboardAdapters = new Map<string, DashboardChannelAdapter>()" src/index.ts` — PASS
- `grep -q "dashboardAdapters.set(head.id, dash)" src/index.ts` — PASS
- `grep -q "if (head === resolvedHeads\[0\])" src/index.ts` — REMOVED (PASS)
- `grep -q "let dashboardAdapter:" src/index.ts` — REMOVED (PASS)
- `grep -c "headRouter.register(dash)" src/index.ts` — returns 1 (PASS — single literal site, runs once per head)
- `grep -q "dashboardAdapters: Map<string, DashboardChannelAdapter>" src/dashboard/server.ts` — PASS
- `grep -q "channelAdapter?: DashboardChannelAdapter" src/dashboard/server.ts` — REMOVED (PASS)
- `grep -q "dashboardAdapters.get(headId)" src/dashboard/routes/messages.ts` — PASS
- `grep -q "dashboardAdapters.values().next().value" src/dashboard/routes/messages.ts` — PASS
- `grep -q "headId?: string" src/dashboard/routes/messages.ts` — PASS
- `npx tsc --noEmit` — exit 0 (whole-tree green)
- `npx vitest run src/dashboard/routes/messages.test.ts` — 10/10 tests pass (5 GET + 5 new POST)

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
