---
phase: 44-multi-head-task-delivery
plan: "03"
subsystem: dashboard/routes
tags: [routes, validation, schedules, multi-head, deliverToHeadIds]
dependency_graph:
  requires:
    - 44-01 (Schedule.deliverToHeadIds optional field, CreateScheduleOptions.deliverToHeadIds, SchedulePatch.deliverToHeadIds)
  provides:
    - POST /api/schedules: deliverToHeadIds validated + persisted (task-only, array shape, known-head, deduped, empty-as-absent)
    - PATCH /api/schedules/:id: delivery set editable/clearable (kind+head validation, D-13 ban intact)
  affects:
    - src/dashboard/routes/schedules.ts
    - src/dashboard/routes/schedules.test.ts
tech_stack:
  added: []
  patterns:
    - admin-404 stance for unknown head ids (D-11, mirrors POST headId pattern)
    - !== undefined guard (not key-presence) for PATCH body checks (mirrors D-13 headId guard rationale)
    - Set dedup + empty-as-absent (empty array not assigned to createOpts)
    - task-only guard returning 400 on reminders (D-08 / T-44-07)
key_files:
  created: []
  modified:
    - src/dashboard/routes/schedules.ts
    - src/dashboard/routes/schedules.test.ts
decisions:
  - D-44-03-POST-BLOCK-PLACEMENT: deliverToHeadIds validation block placed after kind determination (line 85) and before task-name validation — kind is the gate for task-only enforcement
  - D-44-03-PATCH-BLOCK-PLACEMENT: deliverToHeadIds PATCH block placed after ack/nag block and before scheduleStore.update — consistent with the plan spec; uses existing bodyObj variable (already constructed for D-13 guard)
  - D-44-03-EMPTY-ARRAY-PATCH: empty array on PATCH is passed through to patch.deliverToHeadIds = [] (store.update handles delete-on-empty per Plan 01 D-DELETE-ON-EMPTY); key is then absent on the returned schedule body
  - D-44-03-D13-INTACT: existing bodyObj['headId'] !== undefined guard is completely unchanged; deliverToHeadIds is a distinct key that never touches the headId reassignment path
metrics:
  duration: 2min
  completed: "2026-05-24"
  tasks_completed: 2
  files_changed: 2
---

# Phase 44 Plan 03: Schedules API deliverToHeadIds Validation Summary

One-liner: POST + PATCH /api/schedules validate `deliverToHeadIds` as task-only, array-shaped, every id in `resolveCurrentHeads()` (admin-404), deduped, empty-as-absent — with full route-level test coverage.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | POST + PATCH deliverToHeadIds validation/persistence in routes/schedules.ts | b7d6899 | src/dashboard/routes/schedules.ts |
| 2 | Route-level tests for deliverToHeadIds (create/reject/404/patch add-remove-clear) | 7333ccb | src/dashboard/routes/schedules.test.ts |

## What Was Built

### Task 1 — POST + PATCH validation in routes/schedules.ts

**POST handler** (after `kind` determination, ~line 87):

Validation block declares `let deliverToHeadIds: string[] | undefined` before the task-name check. Inside the `kind === 'task'` branch:
- `!Array.isArray` → 400 "deliverToHeadIds must be an array of head id strings"
- Any element not a non-empty trimmed string → 400 "deliverToHeadIds must contain non-empty strings"
- Each id validated against `resolveCurrentHeads()` → first unknown → 404 `deliverToHeadIds: head "<hid>" not found` (D-11 admin-404, no silent fallback)
- Deduped via `[...new Set(ids)]`; assigned to `deliverToHeadIds` only if `deduped.length > 0` (empty = absent)

In the `else` branch (`kind !== 'task'`): if `deliverToHeadIds` field is present in body → 400 "deliverToHeadIds is only valid for task schedules" (T-44-07).

In `createOpts` construction: `if (deliverToHeadIds !== undefined) createOpts.deliverToHeadIds = deliverToHeadIds`.

**PATCH handler** (after ack/nag block, before `scheduleStore.update`):

Uses `bodyObj['deliverToHeadIds'] !== undefined` check (mirrors D-13 rationale — not key-presence). When present:
- `scheduleStore.get(id)` — 404 if not found
- `existing.kind !== 'task'` → 400 "deliverToHeadIds is only valid for task schedules"
- Shape check (array + non-empty strings) → 400
- Each id against `resolveCurrentHeads()` → 404 on unknown
- `patch.deliverToHeadIds = [...new Set(ids)]` — empty array = cleared (store.update handles delete-on-empty per Plan 01 D-DELETE-ON-EMPTY)

D-13 `bodyObj['headId'] !== undefined` guard is completely unchanged.

### Task 2 — Route-level tests

New `describe('deliverToHeadIds validation ...')` block with two known heads (`'a'` and `'b'`). Seven test cases:

1. POST task with `deliverToHeadIds: ['b']` → 200, set persisted
2. POST task with `['b', 'b']` → 200, deduped to `['b']`
3. POST task with `[]` → 200, key absent on returned schedule (empty-as-absent)
4. POST reminder with `deliverToHeadIds` → 400 (task-only, T-44-07)
5. POST task with unknown head `'zzz'` → 404 (admin-404, T-44-06/D-11)
6. PATCH add `['b']` → 200 with set; PATCH clear `[]` → 200 with key absent (D-08 editable)
7. PATCH `headId: 'b'` still → 400 (D-13 ban intact, T-44-08)

Total: 46/46 tests passing (40 pre-existing + 6 new). `grep -c "deliverToHeadIds" src/dashboard/routes/schedules.test.ts` = 27.

## Verification

- `npx tsc --noEmit` GREEN
- `npx vitest run src/dashboard/routes/schedules.test.ts` → 46/46 passing
- `grep -q "createOpts.deliverToHeadIds = deliverToHeadIds"` → found
- `grep -q 'patch.deliverToHeadIds = \[...new Set'` → found
- `grep -q "deliverToHeadIds is only valid for task schedules"` → found
- `grep -c "headId cannot be reassigned"` → 1 (D-13 ban unchanged)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All validation is live and wired through to the store.

## Threat Flags

None — no new network endpoints or auth paths introduced. This plan adds input validation only to existing POST/PATCH routes already behind `requireAuth`. All T-44-06/T-44-07/T-44-08 mitigations implemented as specified.

## Self-Check: PASSED

Files modified exist:
- src/dashboard/routes/schedules.ts: FOUND (58 lines added — POST validation block + createOpts assignment + PATCH validation block)
- src/dashboard/routes/schedules.test.ts: FOUND (165 lines added — new describe block with 7 tests)

Commits exist:
- b7d6899 (Task 1): FOUND
- 7333ccb (Task 2): FOUND
