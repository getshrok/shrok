---
phase: 44-multi-head-task-delivery
plan: 04
subsystem: ui
tags: [react, dashboard, typescript, vite]

# Dependency graph
requires:
  - phase: 44-03
    provides: API accepts and validates deliverToHeadIds on POST/PATCH /api/schedules

provides:
  - Schedule.deliverToHeadIds?: string[] on dashboard Schedule type
  - deliverToHeadIds on api.schedules.create and api.schedules.update request bodies
  - N deduped colored head chips on task rows (owner + delivery heads via HEAD_COLORS)
  - "Deliver to" multi-select on AddScheduleForm (excludes owner)
  - "Deliver to" multi-select on ScheduleRow edit modal (seeds from schedule, clears to owner-only on empty)
  - Reminder form and ReminderRow byte-unchanged (D-01/D-09)

affects: [44-05, ci-build]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional spread on create body: ...(deliverToHeadIds.length ? { deliverToHeadIds } : {}) — sends field only when non-empty"
    - "Multi-select harvest via Array.from(e.target.selectedOptions, o => o.value) — noUncheckedIndexedAccess-safe"
    - "N-chip dedup: [schedule.headId, ...(schedule.deliverToHeadIds ?? [])].filter((v,i,a)=>a.indexOf(v)===i).map(hid => ...)"

key-files:
  created: []
  modified:
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx

key-decisions:
  - "D-01/D-09 honored: AddReminderForm and ReminderRow are byte-unchanged; no deliverToHeadIds reference in reminder code paths"
  - "Owner excluded from multi-select options: filter(h => h.id !== headId) so owner is never double-selectable"
  - "Clearing the multi-select (zero selections) sends deliverToHeadIds: [] to PATCH, which store.update delete-on-empty reverts to owner-only (Plan 44-03 semantics)"
  - "Edit modal seeds editDeliverToHeadIds from schedule.deliverToHeadIds ?? [] when editing opens"
  - "headsQuery reused in ScheduleRow for the edit modal multi-select options (same useQuery(['heads']) pattern as AddScheduleForm)"

patterns-established:
  - "N-chip flex-wrap render: dedup([owner, ...deliverToHeadIds]).map(hid => <span> reusing existing headColor/headColorBorder helpers"
  - "Conditional-spread on create avoids sending empty-array key noise for owner-only tasks"

requirements-completed: []

# Metrics
duration: ~20min (including human-verify checkpoint)
completed: 2026-05-24
---

# Phase 44 Plan 04: Dashboard Delivery UI Summary

**"Deliver to" multi-select on task add/edit forms + N deduped HEAD_COLORS chips on task rows, wired to create/PATCH — reminder form unchanged**

## Performance

- **Duration:** ~20 min (including human-verify checkpoint)
- **Started:** 2026-05-24
- **Completed:** 2026-05-24
- **Tasks:** 3 (2 auto + 1 checkpoint)
- **Files modified:** 3

## Accomplishments

- Added `deliverToHeadIds?: string[]` to the dashboard `Schedule` type and both `api.schedules.create`/`api.schedules.update` request body types, so the dashboard can send the delivery set on create and PATCH.
- Replaced the single-chip render in `ScheduleRow` with a flex-wrap map over `dedupe([schedule.headId, ...(schedule.deliverToHeadIds ?? [])])`, rendering one colored chip per head using the existing `headColor`/`headColorBorder` palette helpers.
- Added a "Deliver to" `<select multiple>` to both `AddScheduleForm` and the `ScheduleRow` edit modal, excluding the owner head from options, harvesting via `Array.from(selectedOptions, o => o.value)`, and wiring to create/PATCH with correct empty-array semantics.
- Human-verify checkpoint passed (user approved): task form multi-select excludes owner, task rows show N chips, reminder form is unchanged.

## Task Commits

1. **Task 1: Type + API-client plumbing and task-row N-chip render** - `02d4dfa` (feat)
2. **Task 2: "Deliver to" multi-select on task add form + edit modal** - `e19fccc` (feat)
3. **Task 3: checkpoint:human-verify** — approved by user (no code commit)

## Files Created/Modified

- `dashboard/src/types/api.ts` — Added `deliverToHeadIds?: string[]` to `Schedule` interface
- `dashboard/src/lib/api.ts` — Added `deliverToHeadIds?: string[]` to `schedules.create` body type and `schedules.update` patch type
- `dashboard/src/pages/SchedulesPage.tsx` — N-chip dedup render in `ScheduleRow`, "Deliver to" multi-select in `AddScheduleForm` and edit modal; `ReminderRow`/`AddReminderForm` byte-unchanged

## Decisions Made

- D-01/D-09 enforced: `AddReminderForm` and `ReminderRow` have zero `deliverToHeadIds` references. The plan's mandate to leave the reminder form untouched was verified by grep.
- Owner excluded from multi-select options via `filter(h => h.id !== headId)` — owner is always implicitly included (dedup in chip render); offering them as a "deliver to" option would be confusing and redundant.
- Clearing the multi-select sends `deliverToHeadIds: []` on PATCH. The Plan 44-03 `store.update` delete-on-empty semantics reverts the schedule to owner-only.
- The edit modal fetches the heads list via its own `useQuery(['heads'])` rather than prop-drilling from a parent — matches the `AddScheduleForm` pattern and keeps the component self-contained.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Human-Verify Checkpoint

- **Checkpoint type:** `checkpoint:human-verify` (gate="blocking")
- **Status:** APPROVED by user
- **What was verified:** Task form "deliver to" multi-select excludes owner; task rows show N colored chips; reminder form single-head-only; create/PATCH wired
- **Signal received:** "approved"

## User Setup Required

None - no external service configuration required. `dashboard/dist` is intentionally NOT committed; CI owns the rebuild on next push.

## Next Phase Readiness

Plan 44-04 is complete. The full Phase 44 delivery pipeline is now implemented:
- Data model (44-01), fan-out + question-suppression (44-02), API validation (44-03), dashboard UI (44-04), integration regression tests (44-05, already committed).
- Phase 44 is ready for `/gsd:verify-work`.

---
*Phase: 44-multi-head-task-delivery*
*Completed: 2026-05-24*

## Self-Check: PASSED

- FOUND: 44-04-SUMMARY.md
- FOUND: commit 02d4dfa (Task 1 — type plumbing + N-chip render)
- FOUND: commit e19fccc (Task 2 — multi-select on add form + edit modal)
- FOUND: dashboard/src/types/api.ts
- FOUND: dashboard/src/lib/api.ts
- FOUND: dashboard/src/pages/SchedulesPage.tsx
- tsc --noEmit: GREEN (0 errors)
