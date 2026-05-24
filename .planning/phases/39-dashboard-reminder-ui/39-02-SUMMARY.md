---
phase: 39-dashboard-reminder-ui
plan: "02"
subsystem: ui
tags: [react, typescript, dashboard, reminders, schedules]

# Dependency graph
requires:
  - phase: 39-dashboard-reminder-ui plan 01
    provides: "Schedule type extended with requiresAck/nagIntervalMinutes/ackPending fields; PATCH route ack-off transition"
provides:
  - "NAGS badge on ack-required reminder rows (static amber, gated on requiresAck)"
  - "Nag-cadence sub-label suffix ('· nags every Xh') on ack-required reminder rows"
  - "Reminder edit modal Requires-acknowledgment toggle with reveal-when-on nag slot inputs and client validation"
  - "formatNagInterval(minutes) helper in SchedulesPage.tsx"
  - "api.ts create/update payload types extended with requiresAck, nagIntervalMinutes, startAt"
affects: [39-dashboard-reminder-ui plan 03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reveal-when-on nag slot inputs (minutes/hours/days) seeded from stored nagIntervalMinutes on modal open"
    - "Badge gating on requiresAck (never ackPending — ackPending not projected to SchedulesPage)"
    - "Null-send pattern: nagIntervalMinutes sent as null when requiresAck is toggled off (Pitfall 3)"

key-files:
  created: []
  modified:
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx

key-decisions:
  - "Badge condition is schedule.requiresAck, never ackPending (D-06 / Pitfall 2)"
  - "nagIntervalMinutes sent as null when ack toggled off so backend clears ackPending + recomputes nextRun (D-12)"
  - "formatNagInterval defined as local helper in SchedulesPage.tsx (mirrors existing formatRelTime pattern)"

patterns-established:
  - "Reveal-when-on multi-slot nag inputs: same UI shape used in edit modal (this plan) and create form (Plan 03)"

requirements-completed: [SCHED-01, SCHED-02]

# Metrics
duration: checkpoint-gated
completed: 2026-05-24
---

# Phase 39 Plan 02: Dashboard Reminder Read+Edit UI Summary

**Amber NAGS badge, nag-cadence sub-label, and reveal-when-on nag slot edit modal wired to api.ts PATCH for ack-required reminders in the dashboard Schedules page**

## Performance

- **Duration:** checkpoint-gated (Tasks 1-2 automated; Task 3 human-verify approved)
- **Started:** 2026-05-24
- **Completed:** 2026-05-24
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint)
- **Files modified:** 2

## Accomplishments

- Extended `api.ts` create/update payload types with `requiresAck`, `nagIntervalMinutes`, and `startAt`; added `formatNagInterval(minutes)` local helper to SchedulesPage.tsx
- Added static amber NAGS badge on ack-required reminder rows gated on `schedule.requiresAck` (never `ackPending`; badge-gating correctness asserted by grep in Task 2 automated verify)
- Added `· nags every Xh` sub-label suffix and reminder edit modal with Requires-acknowledgment toggle, reveal-when-on minutes/hours/days nag slot inputs, inline validation (floor 1, ceiling 43200), and correct null-send on ack-off
- Task 3 human-verify checkpoint approved by user: NAGS badge renders only on requiresAck reminders, sub-label shows cadence, edit-modal reveal-when-on and validation works, ack-off removes badge

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend api.ts payloads + formatNagInterval helper** - `85d60a9` (feat)
2. **Task 2: NAGS badge + nag sub-label + edit-modal ack fields in ReminderRow** - `de8b7c4` (feat)
3. **Task 3: Verify NAGS badge, sub-label, and edit-modal ack editing** - checkpoint:human-verify — approved by user (no commit; verification only)

**Plan metadata:** (this commit)

## Files Created/Modified

- `dashboard/src/lib/api.ts` — create/update payload types extended with `requiresAck?: boolean`, `nagIntervalMinutes?: number | null`, `startAt?: string`
- `dashboard/src/pages/SchedulesPage.tsx` — `formatNagInterval` helper; NAGS badge in ReminderRow; nag sub-label suffix; edit modal `editRequiresAck`/`editNagMinutes`/`editNagHours`/`editNagDays` state; reveal-when-on nag slot inputs; client validation; updateMutation extended with `requiresAck` + `nagIntervalMinutes`

## Decisions Made

- Badge condition is `schedule.requiresAck` (not `ackPending`) — ackPending is not projected to the Schedules page per D-06; static badge approach per D-05
- `nagIntervalMinutes` sent as `null` when ack is toggled off so the Plan-01 PATCH route can clear ackPending and recompute nextRun (D-12 / Pitfall 3)
- `formatNagInterval` defined as a local helper in SchedulesPage.tsx after existing helpers, mirroring the `formatRelTime` pattern (Plan 03 will independently define or import the same logic for the create form)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- api.ts payload types carry `requiresAck`, `nagIntervalMinutes`, `startAt` — Plan 03 create-form can consume them directly
- `formatNagInterval` helper is defined; Plan 03 may define its own copy or factor a shared import
- Reminder read + edit UI complete; Plan 03 delivers the create-reminder form with ack fields

---

## Self-Check: PASSED

- `85d60a9` present in git log: confirmed
- `de8b7c4` present in git log: confirmed
- `dashboard/src/lib/api.ts` modified: confirmed (in commit 85d60a9)
- `dashboard/src/pages/SchedulesPage.tsx` modified: confirmed (in commits 85d60a9 + de8b7c4)
- Task 3 human-verify checkpoint: approved by user

---
*Phase: 39-dashboard-reminder-ui*
*Completed: 2026-05-24*
