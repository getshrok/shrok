---
phase: 38-nag-mechanism-ack-semantics
plan: 02
subsystem: scheduler
tags: [requiresAck, nagInterval, scheduler, tick, advanceNextRun, vitest]

# Dependency graph
requires:
  - phase: 38-01
    provides: ackPending field on Schedule type + SchedulePatch + migrateLegacySchedule + makeSchedule helper in tests
provides:
  - requiresAck nag re-arm branch in ScheduleEvaluatorImpl.tick() (ACK-03)
  - Unit tests: one-time ack re-arm, recurring-while-nagging re-arm, ordinary-cron regression
affects: [38-03, 38-04, scheduler, activation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ACK-03: requiresAck branch comes FIRST in tick() advance block so one-time ack reminders never fall into the cron-disable path"
    - "advanceNextRun (nextRun-only) is the correct helper for nag re-arm — keeps enabled=true throughout the nag loop"

key-files:
  created: []
  modified:
    - src/scheduler/index.ts
    - src/scheduler/scheduler.test.ts

key-decisions:
  - "requiresAck branch placed FIRST in tick() advance block, before cron and one-time branches, so cron===null ack-required reminders never hit the disable path (D-04 + Pitfall 2)"
  - "advanceNextRun used (not update) for nag re-arm — only touches nextRun, leaving enabled=true"
  - "nagIntervalMinutes===null guard falls through to existing paths as defensive fallback (should not occur per Phase 37 validation)"

patterns-established:
  - "Nag re-arm pattern: if (schedule.requiresAck && nagIntervalMinutes !== null) advanceNextRun(id, now + nagIntervalMinutes*60_000)"

requirements-completed: [ACK-03, ACK-06]

# Metrics
duration: 3min
completed: 2026-05-23
---

# Phase 38 Plan 02: Nag Re-arm Branch in tick() Summary

**Scheduler nag re-arm: requiresAck reminders call advanceNextRun(now + nagInterval) instead of cron-advance or one-time-disable, keeping enabled=true throughout the nag loop (ACK-03)**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-23T18:10:50Z
- **Completed:** 2026-05-23T18:13:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added `requiresAck` nag re-arm branch as the FIRST condition in `tick()`'s advance block (D-04, ACK-03)
- One-time ack-required reminders bypass the `update({enabled:false})` disable path entirely
- Three new unit tests: one-time re-arm (ACK-03), recurring-while-nagging re-arm (ACK-06 setup), ordinary-cron regression
- All 25 scheduler tests green; `tsc --noEmit` clean

## Task Commits

1. **Task 1: Add requiresAck nag re-arm branch to tick()** - `7bef72b` (feat)
2. **Task 2: Add nag re-arm unit tests** - `a097a8a` (test)

## Files Created/Modified
- `src/scheduler/index.ts` - Added requiresAck-first branch in advance block calling `advanceNextRun(id, now + nagIntervalMinutes*60_000)`
- `src/scheduler/scheduler.test.ts` - Added 3 nag re-arm tests; `ackPending: false` was already in `makeSchedule` helper from Plan 38-01

## Decisions Made
- Placed requiresAck branch FIRST before `if (schedule.cron)` — this is the critical ordering: a `requiresAck=true, cron=null` one-time reminder would fall into the `else if (enqueued) { update({enabled:false}) }` path if the branch came second (Pitfall 2 from RESEARCH)
- Used `advanceNextRun` not `update` — `advanceNextRun` only touches `nextRun`, leaving `enabled=true` untouched. The one-time-disable path is exactly what must be bypassed for ack-required reminders (D-04 rationale)
- `nagIntervalMinutes !== null` guard in condition: falls through to existing cron/one-time paths when null (defensive fallback; Phase 37 creation validation prevents this in practice)

## Deviations from Plan

None - plan executed exactly as written.

Note: The worktree was initialized against the pre-38-01 commit (017bc5a from Phase 36). The branch check protocol reset it to the correct base `74d545087bb2e81fd34eebb524a263e23afa25b1` (post-wave-1 merge) before execution. This is expected worktree initialization behavior, not a deviation.

## Issues Encountered
- Worktree was branched from Phase 36 HEAD (017bc5a) instead of post-38-01 commit (74d5450). Resolved by executing the `git reset --hard` step from the branch check protocol. After reset, `src/db/schedules.ts` had all required Phase 37 + 38-01 fields (`requiresAck`, `nagIntervalMinutes`, `ackPending`, `SchedulePatch` extension, `migrateLegacySchedule`), and `makeSchedule` in `scheduler.test.ts` already had `ackPending: false`.

## Next Phase Readiness
- Plan 38-02 is complete: `tick()` correctly re-arms `nextRun` for requiresAck reminders before delivery
- Ready for Plan 38-03 (activation layer: steward bypass + ackPending set + enriched systemTrigger)
- Plan 38-04 (head-direct `acknowledge_reminder` tool) depends on SchedulePatch having `ackPending` — confirmed present from 38-01

## Self-Check: PASSED
- src/scheduler/index.ts: FOUND
- src/scheduler/scheduler.test.ts: FOUND
- 38-02-SUMMARY.md: FOUND (worktree path)
- Commit 7bef72b: FOUND
- Commit a097a8a: FOUND
- requiresAck branch in index.ts: FOUND
- ACK-03 test in scheduler.test.ts: FOUND

---
*Phase: 38-nag-mechanism-ack-semantics*
*Completed: 2026-05-23*
