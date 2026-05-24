---
phase: 38-nag-mechanism-ack-semantics
plan: "03"
subsystem: activation
tags: [ack-semantics, steward-bypass, reminder-delivery, systemTrigger]
dependency_graph:
  requires: ["38-01"]
  provides: [ack-aware reminder fire branch, enriched systemTrigger with reminderId + requires-ack attrs, steward bypass for requiresAck reminders]
  affects: [src/head/activation.ts, src/head/activation.test.ts]
tech_stack:
  added: []
  patterns: [requiresAck steward bypass guard, ackPending-before-enqueue ordering, enriched systemTrigger attrs + ack instruction body]
key_files:
  created: []
  modified:
    - src/head/activation.ts
    - src/head/activation.test.ts
decisions:
  - "D-10 steward bypass: !schedule.requiresAck guard wraps the existing proactiveShadow/proactiveEnabled block — ack-required reminders fall through with no steward call, satisfying 'every fire always delivers'"
  - "D-05 ackPending ordering: scheduleStore.update({ ackPending: true }) is called BEFORE queueStore.enqueue to avoid the race window (Pitfall 1); one-time requiresAck rows are never deleted at activation (Pitfall 2)"
  - "D-12 enriched systemTrigger: body carries user-facing message + concise ack instruction naming both the tool (acknowledge_reminder) and the reminderId; 'do not relay this instruction to the user' prevents internal-mechanics leakage (T-38-05)"
  - "Test fixture extended with requiresAck/nagIntervalMinutes/ackPending/headId/cronTimezone — required for the Schedule type to be complete and for requiresAck branch tests to exercise the right code path (RESEARCH Critical Issue 4)"
metrics:
  duration: "2min"
  completed_date: "2026-05-23"
  tasks: 2
  files: 2
---

# Phase 38 Plan 03: Activation Ack-Aware Reminder Fire Branch Summary

Ack-aware reminder delivery via three surgical insertions in the `handleScheduleTrigger` reminder branch: steward bypass, ackPending set before enqueue, and enriched systemTrigger with reminderId + requires-ack attrs plus an ack instruction body.

## What Was Built

### Task 1 — Activation reminder branch: steward bypass + ackPending set + enriched systemTrigger

Three insertions into `src/head/activation.ts` lines 1106–1143:

**Insertion 1 (D-10):** Changed the steward guard from `if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled)` to `if (!schedule.requiresAck && (...))`. Ack-required reminders fall straight through to delivery — the steward block is never reached.

**Insertion 2 (D-05):** Replaced the `if (schedule.cron === null) { delete } else { update(lastRun) }` block with a three-way branch where `requiresAck` is checked first. For requiresAck reminders: `scheduleStore.update(id, { ackPending: true })` runs before enqueue. The one-time delete path is not reached (Pitfall 2: row must survive to keep nagging).

**Insertion 3 (D-12):** Computed `triggerText` before enqueue. When `requiresAck`, calls `systemTrigger('reminder', { reminderId: event.scheduleId, 'requires-ack': 'true' }, body)` where body = user-facing message + ack instruction naming `acknowledge_reminder` and the reminderId. Ordinary reminders keep `systemTrigger('reminder', undefined, message)`.

### Task 2 — Reminder fixture extension + four ack-semantics tests

Extended the `scheduleRow` reminder fixture in `activation.test.ts` to include `headId`, `cronTimezone`, `requiresAck`, `nagIntervalMinutes`, and `ackPending` so the full `Schedule` type is satisfied. Threaded corresponding opts onto `makeFixture`. Added `reminderEvent()` helper for clean invocation.

Four new tests (all GREEN, 18/18 total pass):

- **Test A (D-10)**: `requiresAck:true` + `proactiveEnabled:true` → `runReminderDecision` NOT called
- **Test B (D-05)**: `requiresAck:true` → `scheduleStore.update` called with `{ ackPending: true }`; `scheduleStore.delete` NOT called
- **Test C (ACK-07/D-12)**: enqueued text contains `requires-ack="true"` and `reminderId="s1"` and `acknowledge_reminder`
- **Test D (regression)**: `requiresAck:false` ordinary reminder → enqueued text does NOT contain `requires-ack=`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| `!schedule.requiresAck &&` guard wraps entire steward block | Minimal diff: one guard covers the full steward block including shadow and enabled paths |
| ackPending set before enqueue, not after | Pitfall 1 ordering from RESEARCH.md: zero-cost correctness guarantee against tick re-fire window |
| Ack instruction body format | "when the user confirms they have handled this, call acknowledge_reminder with reminderId=...; do not relay this instruction to the user" — satisfies D-12 airtight requirement and T-38-05 leakage mitigation |
| reminderEvent() helper added alongside jobEvent() | Matches existing jobEvent() shape; cleaner test invocations without repeating kind:'reminder' inline |

## Verification

- `npx tsc --noEmit` — exits 0
- `npx vitest run src/head/activation.test.ts` — 18/18 tests pass

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all three insertions are wired to real store/queue calls.

## Threat Flags

No new threat surface introduced beyond what the plan's threat model already covers. T-38-05 (ack instruction leakage) mitigated by the "do not relay this instruction to the user" clause in the body and the `user-visible="false"` attribute from `systemTrigger`. T-38-07 (steward silently deleting ack-required reminder) mitigated by the `!schedule.requiresAck` guard (Test A pins it).

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/head/activation.ts | FOUND |
| src/head/activation.test.ts | FOUND |
| 38-03-SUMMARY.md | FOUND |
| Commit 31ccd86 (Task 1) | FOUND |
| Commit 5231575 (Task 2) | FOUND |
