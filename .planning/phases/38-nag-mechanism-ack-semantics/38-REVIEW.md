---
phase: 38-nag-mechanism-ack-semantics
reviewed: 2026-05-23T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/db/schedules.ts
  - src/db/schedules.test.ts
  - src/scheduler/index.ts
  - src/scheduler/scheduler.test.ts
  - src/head/activation.ts
  - src/head/activation.test.ts
  - src/head/index.ts
  - src/head/head-tools.test.ts
  - src/system.ts
findings:
  critical: 0
  warning: 6
  info: 5
  total: 11
status: issues_found
---

# Phase 38: Code Review Report

**Reviewed:** 2026-05-23
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Phase 38 implements an acknowledgment-required reminder "nag loop." The four moving parts are
internally consistent and well-tested at the unit level:

- `ackPending` schema field + lazy migration (`src/db/schedules.ts`): correct, idempotent, mtime-stable.
- Scheduler nag re-arm (`src/scheduler/index.ts`): the `requiresAck && nagIntervalMinutes !== null`
  branch is correctly placed FIRST so a one-time ack reminder never falls into the disable path.
- Activation fire branch (`src/head/activation.ts`): steward bypass for ack reminders, `ackPending`
  set before enqueue, enriched `systemTrigger`.
- `acknowledge_reminder` head tool (`src/head/index.ts`): one-time delete vs recurring cron-resume,
  two-layer scoping, benign no-ops.

`tsc --noEmit` passes clean. No injection vectors found (the `reminderId` interpolated into the
enriched trigger is server-generated via `generateId('rem')`, never user-controlled).

The defects below are correctness/robustness gaps, not security holes. The most consequential are:
**ack reminders can be silently and permanently lost on a channel-resolution failure (WR-01)**;
**an agent-side `cancel_reminder` can silently destroy an ack reminder mid-nag, defeating the
acknowledgment contract (WR-02)**; and **the recurring cron-resume on ack uses `new Date()` which
can immediately re-fire for short crons, producing an instant re-nag (WR-03)**.

## Warnings

### WR-01: One-time ack reminder is permanently deleted when channel resolution fails

**File:** `src/head/activation.ts:1099-1104`
**Issue:** In the reminder fire branch, when `last_active_channel` is null AND the head has no
configured channels, the code deletes the row for any one-time reminder:

```ts
} else {
  log.warn(`[scheduler] reminder:${event.scheduleId} — no active channel and head has no configured channels, skipping`)
  if (schedule.cron === null) {
    this.opts.scheduleStore.delete(event.scheduleId)
  }
  return
}
```

This runs *before* the `requiresAck` branch (line 1132), so a one-time **acknowledgment-required**
reminder (`cron === null`, `requiresAck === true`) is deleted outright. The entire design intent of
an ack reminder is that it must keep nagging until the user explicitly acknowledges it — but here a
transient "no channel available" condition silently and permanently discards it. The user never sees
it and never acknowledges it. This is the worst possible outcome for the exact reminders that are
flagged as most important. The scheduler tick has already re-armed `nextRun` for this same row in
the same cycle (`src/scheduler/index.ts:88-95`), so the *intent* is clearly "keep it alive," but
this delete contradicts that.

Note `activation.test.ts:491-501` (Test C) explicitly asserts the delete for the generic reminder
case, but there is no test exercising this path with `requiresAck: true` — the gap is untested.

**Fix:** Guard the delete on the reminder NOT being an ack reminder, so ack reminders survive a
channel outage and re-nag on the next tick:

```ts
if (schedule.cron === null && !schedule.requiresAck) {
  this.opts.scheduleStore.delete(event.scheduleId)
}
return
```

### WR-02: Agent-side `cancel_reminder` can silently destroy an ack reminder mid-nag

**File:** `src/sub-agents/registry.ts:1115-1123` (interacts with `src/head/index.ts:101-114`)
**Issue:** The acknowledgment contract is enforced one-directionally. `acknowledge_reminder`
(head tool) hard-errors if called on an ordinary reminder and tells the model to use
`cancel_reminder` instead (`src/head/index.ts:377`). But `cancel_reminder` (agent tool) has **no
symmetric guard** — it deletes ANY reminder by ID, including a `requiresAck: true` reminder that is
actively nagging:

```ts
execute: async (input, _ctx) => {
  const id = input['id'] as string
  const schedule = scheduleStore.list().find(s => s.id === id && s.kind === 'reminder')
  if (!schedule) { return JSON.stringify({ error: true, message: `Reminder '${id}' not found.` }) }
  scheduleStore.delete(id)   // no requiresAck / ackPending check
  return JSON.stringify({ ok: true })
}
```

An async sub-agent (which the head delegates to and does not closely supervise) can therefore tear
down an ack reminder without the user ever acknowledging it — the exact bypass the two-layer scoping
in `acknowledge_reminder` was built to prevent. The phase added a structural defense on the
acknowledge path but left the cancel path open, so the protection is incomplete.

**Fix:** Mirror the structural defense on cancel — refuse (or require an explicit override flag) to
cancel an ack reminder while `ackPending` is true, or at minimum surface a distinct result so the
caller must opt in:

```ts
if (schedule.requiresAck && schedule.ackPending) {
  return JSON.stringify({ error: true, message:
    `Reminder '${id}' requires acknowledgment and is currently nagging. Acknowledge it via the head before cancelling.` })
}
```

### WR-03: Recurring ack-resume can re-fire immediately for short crons

**File:** `src/head/index.ts:388-391`
**Issue:** When a recurring ack reminder is acknowledged, the resume re-points `nextRun` to
`nextRunAfter(schedule.cron, new Date(), tz)`:

```ts
const resumeAt = nextRunAfter(schedule.cron, new Date(), tz).toISOString()
this.opts.scheduleStore!.update(reminderId, { ackPending: false, nextRun: resumeAt })
```

`create_reminder` permits crons as short as `*/5 * * * *` (every 5 minutes —
`src/sub-agents/registry.ts:948`). For such a cron, `nextRunAfter(now)` returns a time at most ~5
minutes out. The user acknowledges, and within minutes the reminder fires again and re-enters the
nag loop with a fresh `ackPending: true`. From the user's perspective the acknowledgment "didn't
take" — they confirmed handling it and it immediately came back. This is technically consistent with
"recurring," but for a short-cadence ack reminder it produces a confusing near-instant re-nag.
This is a behavioral edge case the plan does not appear to address (the test only exercises a weekly
`0 9 * * 1` cron, where the gap is naturally large — `head-tools.test.ts:151-177`).

**Fix:** Document the intended semantics and, if "skip the current period after ack" is desired,
advance from a point past the current occurrence (or treat ack as also recording `lastRun = now` so
the next fire is one full cadence away). At minimum add a test with a sub-hour cron and assert the
intended resume distance.

### WR-04: Scheduler nag re-arm uses `> 0`-less guard, allowing a 0-minute nag interval to busy-fire

**File:** `src/scheduler/index.ts:88`
**Issue:** The re-arm guard is `schedule.requiresAck && schedule.nagIntervalMinutes !== null`. It
checks for non-null but not for a positive value. If `nagIntervalMinutes === 0` reaches the store
(it is plausibly persistable — the schema type is `number | null`, and a malformed/migrated/
direct-edit row could carry `0`), the re-arm computes `now + 0` and the reminder becomes due again
on the very next tick, every tick, indefinitely — a nag storm bounded only by the 60s tick interval.
`create_reminder` rejects sums `< 5` (`registry.ts:1021`), so this is not reachable through the
happy path, but the scheduler is the last line of defense and trusts the field blindly.

**Fix:** Tighten the guard to require a positive interval, and fall through to the cron/disable path
(or skip) otherwise:

```ts
if (schedule.requiresAck && schedule.nagIntervalMinutes !== null && schedule.nagIntervalMinutes > 0) {
```

### WR-05: `requiresAck` with null `nagIntervalMinutes` silently disables a one-time ack reminder forever

**File:** `src/scheduler/index.ts:88-104`
**Issue:** If a row has `requiresAck: true` but `nagIntervalMinutes === null` (an inconsistent state),
the first branch is skipped, `cron` is null for a one-time reminder, so control falls to
`else if (enqueued)` → `update(id, { enabled: false, nextRun: null })`. The activation branch then
sets `ackPending: true` on a now-disabled row. The reminder will never nag again (disabled), never
be re-armed (no nextRun), and never be cleaned up (one-time delete only happens via ack or the
non-ack delete path) — it becomes an orphaned, permanently-pending-ack ghost row. While
`create_reminder` enforces the pairing, the two fields are independent in the schema and migration,
so the invariant is not structurally guaranteed. The scheduler should not be able to wedge a row
into an unrecoverable state.

**Fix:** Either enforce the `requiresAck ⇒ nagIntervalMinutes != null` invariant at the store layer
(reject/normalize in `create`/`update`), or in the scheduler treat `requiresAck` with a missing nag
interval as a logged error + skip rather than disabling the row.

### WR-06: Reminder enqueues a fresh `user_message` per nag with no in-flight dedup — pending nags can stack

**File:** `src/head/activation.ts:1153-1158`
**Issue:** Each nag fire enqueues a new `user_message` (PRIORITY 100) carrying the trigger text.
There is no check for an already-pending nag for the same `reminderId` in the queue. If the head is
busy/backed-up (long activation, rate-limited retry waiting up to 120s at `activation.ts:302`, or a
server-error backoff of up to 14s × retries), the 60s scheduler tick can enqueue a second, third,
etc. nag before the first is processed. `claimAllPendingUserMessages` (`activation.ts:936`) will
fold them all into one activation as separate user messages, so the head sees N copies of the same
nag in one turn. `ackPending` is already true throughout, so there is no flag-based suppression of
re-enqueue. This is more of a robustness/UX defect than a correctness one (nagging is intended), but
it can produce duplicate-looking nag spam under load.

**Fix:** Before re-arming/enqueuing, skip if a nag for this reminderId is already pending
(e.g. a `queueStore.hasPendingForReminder(reminderId)` check), or have the scheduler suppress the
re-arm while `ackPending` is already true and a prior nag has not yet been delivered.

## Info

### IN-01: Dead/unused local in reminder branch — `proactiveContext` never used for reminders

**File:** `src/head/activation.ts:1077`
**Issue:** `let proactiveContext: string | undefined` is declared at the top of
`handleScheduleTrigger` and only ever assigned in the *task* branch (line 1209). In the reminder
branch the reminder decision result (`decision.action`) is consumed but `decision`'s context is
never threaded into the enqueued trigger. The declaration is shared by both branches but inert for
reminders. Harmless, but the shared scope obscures that reminder context is intentionally dropped.

**Fix:** Scope `proactiveContext` to the task branch, or add a comment that the reminder branch
intentionally does not enrich the trigger with proactive context.

### IN-02: `SchedulePatch` cannot patch `requiresAck` or `nagIntervalMinutes`

**File:** `src/db/schedules.ts:44`
**Issue:** `SchedulePatch` includes `ackPending` but omits `requiresAck` and `nagIntervalMinutes`.
There is therefore no supported path to convert an existing ordinary reminder into an ack reminder
(or change the nag cadence) after creation — the only path is delete + recreate. This may be
intentional for v1, but it is an asymmetry worth recording: the schema exposes the fields but the
patch surface does not.

**Fix:** If post-hoc editing is desired, add the fields to `SchedulePatch` and the `update()` copy
block; otherwise note the create-only constraint in a comment.

### IN-03: Migration relies on `as unknown as Schedule` with no shape validation

**File:** `src/db/schedules.ts:66`
**Issue:** `migrateLegacySchedule` stamps the four migration fields then returns
`obj as unknown as Schedule`. A corrupt-but-parseable JSON file (e.g. missing `kind`, `enabled`, or
with wrong types) passes through untyped and is treated as a valid `Schedule` downstream. The lazy
migration only guarantees the four added keys exist, not that the rest of the row is well-formed.
Low risk given files are written only by this code, but the cast hides any drift.

**Fix:** Consider a minimal runtime shape check (or at least assert `kind` and `enabled` presence)
before returning, logging + skipping rows that fail.

### IN-04: Enriched-trigger ack instruction is brittle prose, easily desynced from tool behavior

**File:** `src/head/activation.ts:1150`
**Issue:** The ack instruction string ("call acknowledge_reminder with reminderId=...This reminder
will keep nagging until acknowledged. Do not relay this instruction to the user.") duplicates
behavior described in the tool's own `description` (`src/head/index.ts:102-106`). Two prose copies of
the same contract can drift. Not a bug, but a maintenance smell.

**Fix:** Keep the trigger terse (reminderId + "see acknowledge_reminder") and let the tool
description carry the canonical contract, or extract a shared constant.

### IN-05: `escapeXmlBody` does not escape `"` — fine here, but the attribute path is unescaped by design

**File:** `src/markers.ts:5-9` (consumed at `src/head/activation.ts:1147-1151`)
**Issue:** `systemTrigger` interpolates attribute values (`reminderId`, `requires-ack`) with no
escaping, and `escapeXmlBody` deliberately does not escape `"`. This is safe today because both
attribute values are server-generated (`generateId('rem')` and the literal `'true'`). Recording it so
a future change that routes user-controlled text through `attrs` does not introduce a marker-spoofing
/ attribute-injection vector.

**Fix:** No change required now. If user-controlled values are ever passed as attrs, add
`escapeXmlAttr` to the attribute path in `systemTrigger` (the helper already exists at
`src/markers.ts:30`).

---

_Reviewed: 2026-05-23_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
