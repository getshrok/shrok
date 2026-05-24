---
phase: 37-schema-tool-params
reviewed: 2026-05-23T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/db/schedules.ts
  - src/db/schedules.test.ts
  - src/scheduler/scheduler.test.ts
  - src/sub-agents/registry.ts
  - src/sub-agents/agents.test.ts
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
status: issues_found
---

# Phase 37: Code Review Report

**Reviewed:** 2026-05-23
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Phase 37 adds two acknowledgment fields (`requiresAck`, `nagIntervalMinutes`) to the
`Schedule` schema with a lazy migrator (Plan 01: `src/db/schedules.ts`) and wires four
boundary-validated nag params (`requiresAck`, `nagMinutes`, `nagHours`, `nagDays`) into the
`create_reminder` tool (Plan 02: `src/sub-agents/registry.ts`).

The schema work, migrator idempotency, and boundary validators are largely well-built:
validators return structured `{ error: true, message }` objects (never throw), the migrator
uses the `'field' in obj` guard for mtime stability, and `create()` defaults the new fields
correctly. The test suite is thorough for what it covers.

However, the headline finding is a **correctness/data-integrity gap**: the two new fields are
*written* to disk by `create_reminder` and surfaced by `list_reminders`, but **no code path
anywhere in `src/` ever reads them to drive behavior** — the entire premise advertised in the
tool description ("keeps nagging on the nag interval until the user explicitly acknowledges
it") is unimplemented. An agent calling this tool with `requiresAck:true` produces a reminder
that fires exactly once like any other and never nags, with no way to acknowledge it. This is
a user-facing promise the code does not keep.

Secondary concerns: the `update` path silently drops the new fields from its allowlist (no way
to toggle ack on an existing reminder, and no test guards this), a validator ordering quirk
emits a confusing error message, and the ceiling check contains unreachable defensive code.

## Critical Issues

### CR-01: `requiresAck` / `nagIntervalMinutes` are written but never consumed — advertised nagging behavior is unimplemented

**File:** `src/sub-agents/registry.ts:954-957` (description) + `src/scheduler/index.ts:46-101` (firing loop)
**Issue:**
The `create_reminder` tool description (registry.ts:929-930, 954-957) tells the LLM:

> "An acknowledgment-required reminder keeps nagging on the nag interval until the user
> explicitly acknowledges it."

and the schema-level `requiresAck` description (line 956):

> "it keeps nagging every nag interval until the user explicitly acknowledges it."

But a full-tree search (`grep -rn 'requiresAck|nagInterval' src/ --include='*.ts'` excluding
the two reviewed source files and tests) returns **zero** consumers. The scheduler firing loop
(`src/scheduler/index.ts`) treats every reminder identically: one-time reminders are disabled
after a single fire (`scheduler/index.ts:92-96`), cron reminders advance on their cron, and
neither path inspects `requiresAck` or `nagIntervalMinutes`. There is no `acknowledge_reminder`
tool, no nag re-scheduling, and no acknowledgment state field.

Consequences for the agent and end user:
- An agent that follows the tool's documentation and sets `requiresAck:true, nagMinutes:60`
  for a critical "take your meds" reminder gets a reminder that fires **once** and is then
  disabled — the opposite of the documented contract. This is a silent, user-trusting failure
  in exactly the high-stakes case the feature exists for.
- There is no acknowledgment mechanism, so even if nagging were wired, the loop could never be
  broken.

If Phase 37 is *intended* to be schema-and-tool-plumbing only (with the firing/nagging behavior
deferred to a later phase), then the tool **must not advertise behavior it does not deliver**.
Shipping a tool description that promises nagging-until-acknowledged, while the runtime fires
once and forgets, is a correctness defect: the LLM will make decisions (e.g. choosing
`requiresAck` over a recurring cron) based on a false guarantee.

**Fix:** Pick one:

1. (Preferred if behavior is deferred) Soften the description so it does not promise runtime
   behavior that isn't implemented yet. For example:
```typescript
description: 'Create a reminder that fires a notification to the user at a specified time. ' +
  'Use triggerAt alone for a one-time reminder. Use cron alone for a recurring reminder ' +
  '(first fire computed from the cron expression). Use triggerAt together with cron for ' +
  'start-then-repeat: the first fire is at triggerAt, then the reminder repeats on the cron schedule. ' +
  'The reminder message should be written as if it is being delivered to the user at fire time.',
  // NOTE: requiresAck/nag* are recorded for a future acknowledgment feature and do not yet
  // change firing behavior — do not document them as nagging-until-acknowledged until wired.
```
   and correspondingly drop or down-scope the `requiresAck`/`nag*` param descriptions so they
   don't claim runtime nagging.

2. (If behavior is in scope) Wire `src/scheduler/index.ts` to re-arm a `requiresAck` reminder
   on `nagIntervalMinutes` instead of disabling it after one fire, and add an
   `acknowledge_reminder` tool that clears the ack requirement / deletes the reminder. Add a
   firing-loop test asserting a `requiresAck` reminder re-arms rather than disables.

Either way, the ship-blocking issue is the gap between the documented contract and the
implemented behavior.

## Warnings

### WR-01: `update_schedule` cannot modify the new ack fields, and `SchedulePatch` silently omits them

**File:** `src/db/schedules.ts:41` (`SchedulePatch`), `src/db/schedules.ts:125-141` (`update`)
**Issue:**
`SchedulePatch` is `Partial<Pick<Schedule, 'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone'>>` — it does **not** include `requiresAck` or `nagIntervalMinutes`, and `update()` has no branch for them. Once a reminder is created, there is no API to turn acknowledgment on/off or change the nag interval. This is the natural place an "acknowledge" or "snooze the nag" operation would live, and its absence both reinforces CR-01 and leaves an obvious gap.

There is also no test asserting whether `update()` preserves the ack fields on an existing
reminder. Because `update()` reads via `this.get()` (which migrates and returns the full
object) and then re-saves the whole object, the fields *are* preserved in practice — but that
invariant is untested, so a future refactor to `update()` could silently drop them.

**Fix:** If post-create mutation of these fields is in scope, extend `SchedulePatch` and add
the corresponding `if (patch.requiresAck !== undefined) ...` branches. At minimum, add a test
asserting that calling `update()` (e.g. `{ enabled: false }`) on a `requiresAck:true` reminder
leaves `requiresAck`/`nagIntervalMinutes` intact, to lock the preservation invariant.

### WR-02: Per-slot integer guards run before the requiresAck-pairing check, producing a misleading error

**File:** `src/sub-agents/registry.ts:997-1013`
**Issue:**
Validation order is: (1) per-slot integer guards (lines 997-1005), then (2) the
"`nagSum > 0 && requiresAck !== true`" rejection (line 1011). So a call like
`{ message, triggerAt, nagMinutes: 1.5 }` (no `requiresAck`) is rejected with
`"nagMinutes must be a non-negative integer"` — a true-but-misleading message, since the
*primary* problem the agent must fix is that nag slots require `requiresAck:true`. The agent
may "fix" the decimal, resubmit `{ nagMinutes: 2 }`, and only then learn it also needed
`requiresAck`. Two round-trips where one would do.

This is not a data-corruption bug (the call is correctly rejected either way), but it degrades
the self-correcting-error contract the validators are designed for.

**Fix:** Either run the `requiresAck`-pairing check first, or only apply per-slot integer
guards to slots that are actually being considered. Simplest: move the
"nag slots only apply when requiresAck is true" check (lines 1010-1013) above the per-slot
integer guards (lines 997-1005).

### WR-03: Ceiling check (`nagSum > 43200`) is unguarded but unreachable except via the requiresAck path — dead defensive branch with an inconsistent guard

**File:** `src/sub-agents/registry.ts:1020-1028`
**Issue:**
The floor check (line 1021) is guarded by `requiresAckArg === true && nagSum > 0`, but the
ceiling check (line 1026) is `if (nagSum > 43200)` with no `requiresAck` guard. In practice the
only way to reach line 1026 with `nagSum > 0` is the `requiresAck === true` path, because the
earlier check at line 1011 already rejects any `nagSum > 0` when `requiresAck !== true`. So the
unguarded ceiling can never fire for a non-`requiresAck` call — the asymmetry with the floor
check is dead/confusing rather than wrong.

The inconsistency invites a future bug: if someone later moves or removes the line-1011 check,
the floor would still be guarded but the ceiling would start firing for non-ack calls,
silently changing behavior.

**Fix:** Make the two boundary checks symmetric — guard the ceiling the same way as the floor:
```typescript
if (requiresAckArg === true && nagSum > 43200) {
  return JSON.stringify({ error: true, message: 'nag interval must be at most 30 days (43200 minutes)' })
}
```

### WR-04: `nagMinutes`/`nagHours`/`nagDays` accept `0` individually, so a single explicit `0` slot with `requiresAck:true` is rejected only by the floor check with a generic message

**File:** `src/sub-agents/registry.ts:997-1023`
**Issue:**
A call `{ message, triggerAt, requiresAck: true, nagMinutes: 0 }` passes the per-slot integer
guard (`0` is a non-negative integer), yields `nagSum === 0`, and is then caught by the
"requiresAck requires a nag interval" check (line 1016) with the message
`"requiresAck requires a nag interval: set nagMinutes, nagHours, or nagDays (minimum 5 minutes
total)"`. That message says "set nagMinutes" even though the caller *did* set it (to 0). The
agent already provided the parameter and may loop trying to satisfy a check it thinks it's
already satisfying.

Edge case, low frequency, but it's a confusing-error path that the test suite does not cover
(the D-04 test at agents.test.ts:1370 passes no slots at all, not an explicit `0`).

**Fix:** Either accept the current behavior and add a test documenting that an all-zero slot
set is treated identically to "no slots" (so the contract is intentional), or special-case the
message when slots were present but summed to zero, e.g.
`"nag interval is 0 — provide a positive nagMinutes/nagHours/nagDays (minimum 5 minutes total)"`.

## Info

### IN-01: Tool description duplicates the nag-pairing rule in three places, risking drift

**File:** `src/sub-agents/registry.ts:929-930, 956, 958-968`
**Issue:** The "requiresAck must be paired with at least one of nagMinutes/nagHours/nagDays
(minimum 5 minutes, maximum 30 days)" rule is stated in the top-level description (929-930), the
`requiresAck` param description (956), and implied across the three slot descriptions
(958-968). The numeric bounds (5 / 30 days / 43200) are also hardcoded as prose in multiple
places and again as literals in the validators (lines 1021-1027). If the bounds change, four+
sites must be updated in lockstep.
**Fix:** Extract the bounds to named constants (e.g. `NAG_MIN_MINUTES = 5`,
`NAG_MAX_MINUTES = 43200`) and reference them in both the validator messages and (where
practical) the description, to keep prose and logic from drifting.

### IN-02: Magic numbers `60`, `1440`, `43200`, `5` in the nag-sum math and bounds

**File:** `src/sub-agents/registry.ts:1008, 1021, 1022, 1026, 1027`
**Issue:** `nagHoursArg * 60`, `nagDaysArg * 1440`, the floor `< 5`, and the ceiling `> 43200`
are bare literals. `1440` (minutes/day) and `43200` (30 days) in particular are easy to
mistype and hard to verify at a glance.
**Fix:** Introduce `MINUTES_PER_HOUR = 60`, `MINUTES_PER_DAY = 1440`, `NAG_MIN_MINUTES = 5`,
`NAG_MAX_MINUTES = 30 * MINUTES_PER_DAY` and use them in the arithmetic and the bound checks.

### IN-03: Migrator type-launders through `as unknown as Schedule` without validating field types

**File:** `src/db/schedules.ts:62`
**Issue:** `migrateLegacySchedule` stamps missing keys with defaults and returns
`obj as unknown as Schedule`. It only checks key *presence* (`'requiresAck' in obj`), never the
*type* of an existing value. A hand-edited or corrupt schedule JSON with, say,
`"requiresAck": "yes"` or `"nagIntervalMinutes": "60"` passes through untouched and is treated
as a valid `Schedule` downstream, defeating the `noUncheckedIndexedAccess`/strict-typing posture
the project otherwise maintains. This matches the pre-existing `headId` migration behavior, so
it's consistent, not a regression — flagged as a latent robustness gap.
**Fix:** If defense against malformed-on-disk data is desired, coerce/validate types during
migration (e.g. `if (typeof obj['requiresAck'] !== 'boolean') obj['requiresAck'] = false`).
Otherwise, accept as out of scope and leave as-is.

### IN-04: `list_reminders` projection exposes `requiresAck`/`nagIntervalMinutes` that have no runtime effect

**File:** `src/sub-agents/registry.ts:918`
**Issue:** `list_reminders` now projects `requiresAck` and `nagIntervalMinutes` into its output
(and a test asserts this at agents.test.ts:1310-1317). Until CR-01 is resolved, this surfaces
two fields to the agent that look meaningful but change nothing about how the reminder behaves,
which can mislead the agent into believing acknowledgment is active. Harmless once CR-01 is
fixed; noted so the projection and the behavior land together.
**Fix:** No change needed if CR-01 is resolved by wiring the behavior. If CR-01 is resolved by
softening the description (behavior deferred), consider omitting these two fields from the
`list_reminders` projection until they do something.

---

_Reviewed: 2026-05-23_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
