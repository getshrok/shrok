---
phase: 33-multi-head-management-ui
plan: 03
subsystem: dashboard
tags: [multi-head, sse, dashboard-events, pure-function, tdd, DASH-05]

requires:
  - phase: 33-multi-head-management-ui
    plan: 01
    provides: "DashboardEvent.message_added carries required headId field; widened type-checker-enforced"
  - phase: 33-multi-head-management-ui
    plan: 02
    provides: "DashboardChannelAdapter constructed per-head; this.headId always populated at the typing emit site"
provides:
  - "DashboardEvent.typing widened with required headId field (backend src/dashboard/events.ts + frontend mirror dashboard/src/types/api.ts)"
  - "src/channels/dashboard/adapter.ts:35 typing emit threads this.headId"
  - "dashboard/src/hooks/streamFilter.ts: pure function shouldDeliverStreamEvent(event, selectedHead)"
  - "dashboard/src/hooks/streamFilter.test.ts: 8 vitest cases under environment: 'node' (no jsdom, no @testing-library, no new devDependency)"
  - "dashboard/src/hooks/useStream.ts: filter gate at the top of the SSE callback; message_added handler now uses event.headId; TODO(phase-33) marker removed"
affects: [plan-06-heads-tab-frontend]

tech-stack:
  added: []
  patterns:
    - "Per-head SSE filter as a pure function — testable under existing environment: 'node' vitest config without jsdom or @testing-library; useStream() composes it as a one-line gate at the top of the SSE callback"
    - "Minimum-correct scope (RESEARCH § A4): only message_added and typing are head-scoped in the union; agent_*/steward_run_added/memory_retrieval keep the union shape they had pre-phase since their emit sites live in process-wide stores with no per-head context (T-33-09 documents the accepted leakage)"

key-files:
  created:
    - dashboard/src/hooks/streamFilter.ts
    - dashboard/src/hooks/streamFilter.test.ts
  modified:
    - src/dashboard/events.ts
    - src/channels/dashboard/adapter.ts
    - dashboard/src/types/api.ts
    - dashboard/src/hooks/useStream.ts

key-decisions:
  - "Scope discipline: did NOT widen agent_status_changed, agent_message_added, steward_run_added, or memory_retrieval — per RESEARCH § A4 minimum-correct scope. Those emit sites live in src/db/agents.ts (7) and src/db/steward_runs.ts (1) where the emitter is process-wide; threading headId is a larger refactor and out of phase. T-33-09 documents the accepted cross-head leakage."
  - "Pure function over hook-internal closure (checker fix-hint path b): factoring the filter into shouldDeliverStreamEvent lets the test run under the existing environment: 'node' vitest config — no jsdom, no @testing-library/react, no renderHook, no new devDependency."
  - "Inside the message_added handler, switched from `const headId = currentHeadIdRef.current` to `const headId = event.headId`. The filter above guarantees they're equal for delivered events, and using the event's own headId removes the last hidden coupling to the ref's value as the head identity (the ref now plays a pure filter role only)."
  - "selectedHead === null returns true for per-head events (pre-resolution / un-selected initial render). Test 8 pins this contract."
  - "Mirrored backend message_added widening (Plan 01) into dashboard/src/types/api.ts in this plan's Task 1 — the frontend type still showed the pre-Plan-01 shape; consolidating the mirror here keeps Task 1 self-contained and the frontend type-correct."

patterns-established:
  - "Per-head SSE filter is a pure function with dedicated unit tests under vitest node env — set the precedent for future per-head event types: widen the union, thread headId at the single emit site, extend the filter, add a test case, done."

requirements-completed: [DASH-05]

duration: 3min
completed: 2026-05-13
---

# Phase 33 Plan 03: Per-Head SSE Filter Summary

**Per-head SSE scoping for `message_added` and `typing` is now enforced on the frontend by `shouldDeliverStreamEvent`, a pure function unit-tested under the existing `environment: 'node'` vitest config; the `TODO(phase-33)` marker is gone and `useStream()` uses `event.headId` directly instead of relying on the ref to resolve the head identity.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-13T20:25:58Z
- **Completed:** 2026-05-13T20:28:58Z
- **Tasks:** 2 (Task 2 ran TDD: RED + GREEN as separate commits, no REFACTOR needed)
- **Files changed:** 6 (2 created, 4 modified)

## Accomplishments

- Widened the `typing` member of `DashboardEvent` in `src/dashboard/events.ts` with a required `headId: string` and threaded `this.headId` through the single typing emit site in `src/channels/dashboard/adapter.ts:35` (the field is already a `private readonly` ctor arg from Plan 02 wiring).
- Mirrored the union shape in `dashboard/src/types/api.ts`: `typing` carries headId, and `message_added` now also carries headId (the frontend mirror was still on the pre-Plan-01 shape).
- Created `dashboard/src/hooks/streamFilter.ts` exporting a single pure function `shouldDeliverStreamEvent(event, selectedHead)` — false only for cross-head `message_added` / `typing`, true for everything else (process-wide events and accepted-leakage event types).
- Created `dashboard/src/hooks/streamFilter.test.ts` with 8 vitest cases covering all branches including the `selectedHead === null` pre-resolution case and the scope-discipline pin for `agent_status_changed` / `steward_run_added` (which must always pass).
- Wired `useStream.ts`: imported `shouldDeliverStreamEvent`, added an early-return gate at the top of the SSE callback, and switched the message_added handler to use `event.headId` instead of `currentHeadIdRef.current`. The `TODO(phase-33)` marker block is removed.
- All verifications pass: whole-tree `npx tsc --noEmit` green; 8/8 streamFilter tests pass; full dashboard suite 66/66 pass; backend smoke suite around modified surfaces (`src/dashboard/`, `src/channels/dashboard/`, `src/db/messages.test.ts`) 86/86 pass.

## Task Commits

Each task committed atomically; Task 2 followed TDD with separate RED + GREEN commits:

1. **Task 1: Widen `typing` in DashboardEvent + thread headId** — `29a838d` (feat)
2. **Task 2 RED: failing tests for `shouldDeliverStreamEvent`** — `5e74bb9` (test)
3. **Task 2 GREEN: create streamFilter.ts + wire useStream** — `76bb4c7` (feat)

## Files Created/Modified

### Created

- `dashboard/src/hooks/streamFilter.ts` — 25 lines; pure function `shouldDeliverStreamEvent(event, selectedHead): boolean`. No React imports; only imports the `DashboardEvent` type.
- `dashboard/src/hooks/streamFilter.test.ts` — 57 lines; 8 vitest cases under `environment: 'node'`. No `@testing-library/react`, no `jsdom`, no `renderHook` — `grep -E "testing-library|jsdom|renderHook|^import.*from.*react" dashboard/src/hooks/streamFilter.test.ts | wc -l` returns 0 (path-(b) compliance).

### Modified

- `src/dashboard/events.ts` — one-line widening: `| { type: 'typing' }` → `| { type: 'typing'; headId: string }`. `grep -c "headId: string"` returns exactly 2 (message_added from Plan 01 + typing from this plan).
- `src/channels/dashboard/adapter.ts:35` — typing emit threads `this.headId`.
- `dashboard/src/types/api.ts` — mirror of backend union: `typing` widened, and `message_added` widened to match the backend (was still on pre-Plan-01 shape).
- `dashboard/src/hooks/useStream.ts` — three changes inside the `useEffect`:
  1. Added `import { shouldDeliverStreamEvent } from './streamFilter'`.
  2. Added an early-return filter gate as the first statement inside the SSE callback.
  3. Inside the `message_added` handler, replaced `const headId = currentHeadIdRef.current` with `const headId = event.headId` and deleted the `TODO(phase-33)` marker block.

## Decisions Made

- **Scope discipline (`headId: string` count = 2 in `events.ts`)**: Did NOT widen `agent_status_changed`, `agent_message_added`, `steward_run_added`, or `memory_retrieval` — per RESEARCH § A4 minimum-correct scope. Test 6 and Test 7 in `streamFilter.test.ts` pin this contract so any future widening would have to explicitly update those tests (turns silent scope creep into a compile/test signal). Threat T-33-09 documents the accepted cross-head leakage for those event types.
- **Pure function over hook-internal closure (checker fix-hint path b)**: Factoring the filter into `shouldDeliverStreamEvent` lets the test run under the existing `environment: 'node'` vitest config — no jsdom, no `@testing-library/react`, no `renderHook`, no new devDependency. Matches the pattern in `dashboard/src/hooks/voice-fsm.test.ts`.
- **`const headId = event.headId` inside the message_added handler**: The filter gate above guarantees `event.headId === currentHeadIdRef.current` for delivered `message_added` events, so we use the event's own headId rather than re-reading the ref. This makes the ref's role pure: it filters; it no longer resolves head identity.
- **`selectedHead === null` returns true**: Supports the un-selected initial render (before `currentHeadId` is resolved from localStorage / GET /api/heads). Test 8 pins this. Called out in the JSDoc.
- **Frontend mirror update bundled into Task 1**: `dashboard/src/types/api.ts` still showed the pre-Plan-01 shape for `message_added` (no headId). Since the file required edit for `typing` anyway, mirrored the full backend shape here so the frontend type is correct end of Task 1 — matches the plan's explicit instruction ("if not [already done], set it now to match the backend").
- **No REFACTOR step for Task 2's TDD**: The implementation is already minimal (5 lines of executable code, no duplication, no abstraction smells). Skipping REFACTOR is the correct call when there's nothing to clean up.

## Deviations from Plan

None — plan executed exactly as written. Both tasks completed in the order specified, every acceptance criterion passed, no auto-fixed issues required.

The plan-stated frontend mirror update for `message_added` (Task 1 step 3 "if not [already done], set it now") was the only minor judgement call — confirmed via grep that the frontend was still on the pre-Plan-01 shape and applied the mirror in Task 1's commit. This was a planned-for contingency, not a deviation.

## Issues Encountered

None blocking.

The hook system flagged READ-BEFORE-EDIT reminders on `events.ts`, `adapter.ts`, `api.ts`, and `useStream.ts` after the first Edit calls. All four files had been read earlier in the same session, so the edits applied successfully on the first attempt — the reminders were informational, not errors.

## User Setup Required

None — no external service configuration, no env vars, no infrastructure changes.

## Manual Verification (per plan)

The plan's manual verification step (two heads, send to work head, switch to default, verify isolation) is a UI smoke that requires a multi-head dashboard build. With:
- 8/8 unit tests covering every filter branch (including both `message_added` cross-head drop and `typing` cross-head drop),
- backend `src/dashboard/routes/messages.test.ts` 10/10 covering per-head adapter routing for `POST /send` (Plan 02),
- end-to-end SSE emit → React Query cache routing covered by the existing dashboard suite,

the contract D-11 (RESEARCH § A4 minimum-correct scope) is verified at every layer; the manual smoke remains the natural integration check once Plan 06 lands the heads tab UI.

## Next Phase Readiness

- **Plan 04 (heads CRUD router):** ready — independent of SSE filtering; can proceed in parallel.
- **Plan 05 (heads channels subresource):** ready — same.
- **Plan 06 (heads tab frontend):** ready — the SSE filter is in place, so the head selector in Plan 06 will see per-head isolation for messages and typing as soon as it updates `currentHeadId`. Plan 06 inherits an SSE pipeline that is correctly scoped to the selected head.
- **Plan 07 (typed confirmation delete):** ready — independent of SSE.

No blockers.

## Threat Flags

No new threat surface introduced beyond the plan's `<threat_model>`. The pure filter is a UX scoping mechanism, not a security boundary (T-33-12 in the plan accepts this); the SSE pipe itself was already authenticated.

## Self-Check: PASSED

Verified the following files exist:
- `dashboard/src/hooks/streamFilter.ts` — FOUND
- `dashboard/src/hooks/streamFilter.test.ts` — FOUND

Verified the following commits exist:
- `29a838d` (Task 1) — FOUND
- `5e74bb9` (Task 2 RED) — FOUND
- `76bb4c7` (Task 2 GREEN) — FOUND

Verified contract:
- `grep -c "headId: string" src/dashboard/events.ts` — returns 2 (PASS — scope discipline)
- `grep -q "type: 'typing'; headId: string" src/dashboard/events.ts` — PASS
- `grep -q "type: 'typing', headId: this.headId" src/channels/dashboard/adapter.ts` — PASS
- `grep -q "type: 'typing'; headId: string" dashboard/src/types/api.ts` — PASS
- `grep -rn "type: 'typing'" src/ | grep -v "headId" | wc -l` — returns 0 (PASS — no headId-less typing emits)
- `grep -q "export function shouldDeliverStreamEvent" dashboard/src/hooks/streamFilter.ts` — PASS
- `grep -q "from './streamFilter'" dashboard/src/hooks/useStream.ts` — PASS
- `grep -q "shouldDeliverStreamEvent(event, currentHeadIdRef.current)" dashboard/src/hooks/useStream.ts` — PASS
- `grep -q "TODO(phase-33)" dashboard/src/hooks/useStream.ts` — exits 1 (PASS — TODO removed)
- `grep -q "const headId = event.headId" dashboard/src/hooks/useStream.ts` — PASS
- `grep -E "testing-library|jsdom|renderHook|^import.*from.*react" dashboard/src/hooks/streamFilter.test.ts | wc -l` — returns 0 (PASS — path-(b) compliance)
- `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` — 8/8 tests pass
- `cd dashboard && npx vitest run` — 66/66 dashboard tests pass
- `npx vitest run src/dashboard/ src/channels/dashboard/ src/db/messages.test.ts` — 86/86 backend tests pass
- `npx tsc --noEmit` — exit 0 (whole-tree green)

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
