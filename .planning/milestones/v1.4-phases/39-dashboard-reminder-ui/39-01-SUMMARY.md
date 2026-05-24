---
phase: 39-dashboard-reminder-ui
plan: "01"
subsystem: backend
tags: [schedules, reminders, ack, nag, validation, types]
dependency_graph:
  requires: []
  provides:
    - frontend Schedule type with requiresAck/nagIntervalMinutes/ackPending
    - POST/PATCH route validation for ack/nag coupling (D-04)
    - startAt->nextRun mapping (D-10)
    - D-12 ack-off-while-nagging transition
    - create_reminder nag floor=1 (D-03)
  affects:
    - dashboard/src/types/api.ts
    - src/db/schedules.ts
    - src/dashboard/routes/schedules.ts
    - src/sub-agents/registry.ts
tech_stack:
  added: []
  patterns:
    - Validation early-return pattern (res.status(400).json + return)
    - SchedulePatch field extension (Pick union)
    - update() apply-block conditional assignment
key_files:
  created: []
  modified:
    - dashboard/src/types/api.ts
    - src/db/schedules.ts
    - src/dashboard/routes/schedules.ts
    - src/sub-agents/registry.ts
    - src/dashboard/routes/schedules.test.ts
    - src/db/schedules.test.ts
    - src/sub-agents/agents.test.ts
decisions:
  - "D-03: nag floor corrected 5→1 in registry.ts and schedules.ts route handler"
  - "D-10: startAt override implemented in POST route; nextRun=startAt with cron retained"
  - "D-12: ack-off transition computed in PATCH route (patch.nextRun via nextRunAfter) — no tz param added to update()"
  - "D-04 standalone-nag: PATCH bare {nagIntervalMinutes} reads existing row's requiresAck before applying"
metrics:
  duration: "6 min"
  completed: "2026-05-24"
  tasks: 3
  files_modified: 7
---

# Phase 39 Plan 01: Backend Type Contract + Route Validation Summary

**One-liner:** Backend validation (ack/nag coupling, 1-min floor, 30-day ceiling, startAt->nextRun, D-12 transition), frontend Schedule type extension, and D-03 floor correction — all wave-0 backend tests green.

## What Was Built

### Task 1 — Wave-0 backend tests (TDD RED)

Extended three test files with 19 new tests covering all Phase 39 backend behaviors:

- `src/dashboard/routes/schedules.test.ts`: 15 new integration tests for POST ack/nag coupling (happy + all 400 rejections), startAt->nextRun (happy + past-date rejection), PATCH D-11 round-trip, PATCH standalone-nag D-04 coupling guard
- `src/db/schedules.test.ts`: 2 new store unit tests — `update()` applies requiresAck/nagIntervalMinutes, full D-12 four-field transition
- `src/sub-agents/agents.test.ts`: Rewrote D-03 floor test — nagMinutes:1 now succeeds (old `/at least 5/i` assertion fully removed)

### Task 2 — Frontend type + store + registry (TDD GREEN for agents)

- `dashboard/src/types/api.ts`: Added `requiresAck: boolean`, `nagIntervalMinutes: number | null`, `ackPending: boolean` to frontend Schedule interface (F-01 — unblocks Plans 02/03)
- `src/db/schedules.ts`: Extended `SchedulePatch` Pick with `'requiresAck' | 'nagIntervalMinutes'`; added two apply-lines to `update()` (D-11)
- `src/sub-agents/registry.ts`: Floor corrected 5→1 (D-03): `nagSum < 1`, error strings updated to "1 minute", param description updated

### Task 3 — POST/PATCH route validation (all route + store tests GREEN)

- POST ack/nag coupling guards: requiresAck requires nag (400), nag without ack (400), fractional floor (400), ceiling >43200 (400)
- POST startAt override (D-10): cron + future startAt → `nextRun=startAt` with cron retained; past startAt → 400
- PATCH D-11: requiresAck/nagIntervalMinutes editable with full coupling/floor/ceiling re-validation
- PATCH D-12: turning requiresAck off clears `nagIntervalMinutes=null`; if `ackPending===true`, clears it and recomputes `nextRun` via `nextRunAfter`
- PATCH D-04 standalone-nag coupling guard: bare `{ nagIntervalMinutes: 0 }` on a stored `requiresAck:true` reminder reads existing row and rejects with 400

## Test Results

- `npm test -- src/dashboard/routes/schedules.test.ts src/db/schedules.test.ts src/sub-agents/agents.test.ts`: **150 tests, 150 passed**
- `npx tsc --noEmit`: **clean (0 errors)**
- `grep -c "at least 5" agents.test.ts`: **0**
- `grep -c "nagSum < 5" registry.ts`: **0**

## Commits

| Task | Hash | Message |
|------|------|---------|
| Task 1 (RED) | 8aba0fe | test(39-01): add RED wave-0 tests for ack/nag, startAt, D-12, and D-03 floor |
| Task 2 (GREEN types) | 9f5b86b | feat(39-01): frontend Schedule type, SchedulePatch/update(), and registry floor=1 |
| Task 3 (GREEN routes) | ddb5566 | feat(39-01): POST/PATCH route validation, startAt->nextRun mapping, and D-12 transition |

## Deviations from Plan

**1. [Rule 1 - Bug] TypeScript exactOptionalPropertyTypes fix in PATCH D-12 path**
- **Found during:** Task 3 verification (`npx tsc --noEmit`)
- **Issue:** `patch.nextRun = existing.runAt ?? undefined` — `SchedulePatch.nextRun` is `string | null` (not `string | null | undefined`); assigning `undefined` was a type error under `exactOptionalPropertyTypes`
- **Fix:** Changed to `else if (existing.runAt !== null) { patch.nextRun = existing.runAt }` — only assigns when non-null, omits the field otherwise
- **Files modified:** `src/dashboard/routes/schedules.ts`
- **Commit:** ddb5566 (same task commit, fixed inline before commit)

## Known Stubs

None — all behavior is fully wired. The frontend Schedule type change enables Plans 02/03 to compile; no stub data paths.

## Threat Flags

No new network endpoints or auth paths introduced. POST/PATCH validation is additive (new fields within existing handlers). T-39-01 through T-39-04 and T-39-09 mitigations are fully implemented as specified in the threat model.

## Self-Check: PASSED
