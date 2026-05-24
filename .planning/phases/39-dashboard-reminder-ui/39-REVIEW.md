---
phase: 39-dashboard-reminder-ui
reviewed: 2026-05-24T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - dashboard/src/lib/api.ts
  - dashboard/src/pages/SchedulesPage.tsx
  - dashboard/src/types/api.ts
  - src/dashboard/routes/schedules.test.ts
  - src/dashboard/routes/schedules.ts
  - src/db/schedules.test.ts
  - src/db/schedules.ts
  - src/sub-agents/agents.test.ts
  - src/sub-agents/registry.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: resolved
resolution:
  warnings_fixed: 4
  fix_commits:
    - "64ea29f WR-01 persist ack/nag-only edits in reminder modal"
    - "2dcc2cc WR-02 use schedule cronTimezone in ack-off nextRun recompute"
    - "86f87fd WR-04 clear nextRun on ack-off for already-fired one-time reminder"
    - "d3a42ee WR-03 reject non-integer nagIntervalMinutes on POST and PATCH"
  info_deferred: 4
  resolved: 2026-05-24
---

# Phase 39: Code Review Report

**Reviewed:** 2026-05-24
**Depth:** standard
**Files Reviewed:** 9
**Status:** resolved — all 4 warnings fixed (see resolution frontmatter); 4 info findings deferred

> **Resolution (2026-05-24):** All 4 Warning findings fixed and committed atomically; +5 tests added; full suite (1544) green; `tsc --noEmit` clean. WR-03's integer guard makes IN-01's floor branch provably dead (left as harmless defense-in-depth). The 4 Info findings (IN-01..IN-04) were intentionally deferred.

## Summary

Reviewed the Phase 39 (dashboard reminder UI) implementation: the frontend `Schedule`
type extension, the dashboard route ack/nag/startAt validation, the store
`SchedulePatch`/`update()` extension, the `create_reminder` nag-floor correction, and the
React reminder list/edit/create UI. The backend validation layer (POST + PATCH coupling,
floor, ceiling, startAt→nextRun, D-12 ack-off transition, standalone-nag coupling guard) is
well-tested and the server-side source-of-truth model from D-04 is correctly implemented.
The store and type changes are clean and faithful to the backend ground truth.

The most consequential finding is a **frontend dirty-check bug** in `ReminderRow.commitEdit`:
editing *only* the ack/nag fields on a reminder (without changing message/cron/conditions)
is silently discarded — the user's change never reaches the server. There are also two
timezone-correctness gaps in nextRun recomputation (one pre-existing pattern, one in the new
D-12 path), a missing-integer-validation gap on the dashboard route relative to the tool, and
several quality/dead-code observations.

No security vulnerabilities found: all handlers stay behind `requireAuth`, the JSON body is
type-guarded (`typeof === 'string'`, `=== true`, `typeof === 'number'`) before use, and no
injection/secret/eval surface was introduced.

## Warnings

### WR-01: Editing only the ack/nag fields on a reminder is silently dropped

**File:** `dashboard/src/pages/SchedulesPage.tsx:545-555`
**Issue:** In `ReminderRow.commitEdit`, the early-return "nothing changed" guards check only
`trimmedValue` (cron/runAt), `conditionsUnchanged`, and `messageUnchanged` — they do **not**
consider whether `editRequiresAck` or the nag interval changed. `ackFields` is computed but
the guard can return before it is ever sent:

```js
const ackFields = {
  requiresAck: editRequiresAck,
  nagIntervalMinutes: editRequiresAck && editNagSum > 0 ? editNagSum : null,
}
if (schedule.cron !== null) {
  if (trimmedValue === schedule.cron && conditionsUnchanged && messageUnchanged) { setEditing(false); return }  // ← returns even if requiresAck/nag changed
  ...
}
// one-time path:
if (runAtUnchanged && conditionsUnchanged && messageUnchanged) { setEditing(false); return }  // ← same
```

Repro: open a recurring reminder's edit modal, leave message/cron/conditions untouched,
flip "Requires acknowledgment" or change the nag interval (60→120), click Save. The modal
closes and **no PATCH is sent** — the change is lost. This defeats the primary purpose of the
ack/nag edit UI for the common case where the user only wants to tweak nagging.

**Fix:** Include ack/nag dirtiness in both early-return guards. Compute the stored ack state
and compare:
```js
const ackUnchanged =
  editRequiresAck === schedule.requiresAck &&
  (editRequiresAck && editNagSum > 0 ? editNagSum : null) === schedule.nagIntervalMinutes

if (schedule.cron !== null) {
  if (trimmedValue === schedule.cron && conditionsUnchanged && messageUnchanged && ackUnchanged) { setEditing(false); return }
  ...
}
// and in the one-time path:
if (runAtUnchanged && conditionsUnchanged && messageUnchanged && ackUnchanged) { setEditing(false); return }
```

### WR-02: D-12 nextRun recompute ignores the reminder's `cronTimezone` override

**File:** `src/dashboard/routes/schedules.ts:235`
**Issue:** In the PATCH ack-off-while-nagging (D-12) path, the recomputed nextRun uses the
workspace `timezone` closure value rather than the schedule's own `cronTimezone` override:
```js
patch.nextRun = nextRunAfter(existing.cron, new Date(), timezone).toISOString()
```
A reminder created with a per-schedule `cronTimezone` (e.g. `America/New_York` while the
workspace default is UTC) will, on ack-off, have its nextRun recomputed in the wrong
timezone, shifting the first post-ack fire by the UTC offset. The store schema explicitly
supports `cronTimezone` as a per-schedule override (`src/db/schedules.ts:17`).

Note: the existing cron-change recompute at line 199 has the same omission, so this is a
consistency issue with a pre-existing pattern — but the D-12 path is new code in this phase
and should use the override.

**Fix:**
```js
patch.nextRun = nextRunAfter(existing.cron, new Date(), existing.cronTimezone ?? timezone).toISOString()
```
(Consider fixing the line-199 cron-change recompute the same way for consistency.)

### WR-03: Dashboard route does not validate that `nagIntervalMinutes` is an integer

**File:** `src/dashboard/routes/schedules.ts:50, 212`
**Issue:** The `create_reminder` tool validates each nag slot is a non-negative **integer**
(`Number.isInteger(...)`, registry.ts:997-1005), but the dashboard POST/PATCH routes only
check `typeof nagIntervalMinutes === 'number'`. A direct API client can POST/PATCH
`nagIntervalMinutes: 60.7` (or any fractional value ≥ 1) and it will be persisted verbatim —
the `< 1` floor branch only catches fractional values *below* 1. A non-integer nag cadence
then flows into nextRun/nag scheduling math. The plan's belt-and-suspenders floor branch
(`nagNum > 0 && nagNum < 1`) was clearly intended to catch fractional inputs but only covers
the `(0,1)` range, leaving `1.x`, `2.x`, … unguarded.

**Fix:** Reject non-integer nag values explicitly on both POST and PATCH:
```js
if (typeof nagIntervalMinutes === 'number' && !Number.isInteger(nagIntervalMinutes)) {
  res.status(400).json({ error: 'nagIntervalMinutes must be an integer number of minutes' })
  return
}
```

### WR-04: One-time reminder ack-off leaves a past `nextRun` (no re-arm)

**File:** `src/dashboard/routes/schedules.ts:236-238`
**Issue:** In the D-12 ack-off path for a one-time reminder, when `existing.ackPending` is
true the code sets `patch.nextRun = existing.runAt`. For a one-time reminder that already
fired and is now nagging, `existing.runAt` is in the **past**, so writing it back to
`nextRun` makes the schedule immediately "due" again (`getDue` returns rows where
`nextRun <= now`). Turning off acknowledgment on a one-time nagging reminder can therefore
cause it to re-fire on the next scheduler poll instead of going quiet. The recurring branch
recomputes a future nextRun via `nextRunAfter`; the one-time branch has no equivalent
"already-delivered, stop firing" handling.

**Fix:** For a one-time reminder whose ack is being turned off after it has already fired,
either disable it (`patch.enabled = false`) or clear `nextRun` (`patch.nextRun = null`)
rather than restoring a past `runAt`. Confirm the intended semantics against the scheduler's
one-time-fire handling before choosing.

## Info

### IN-01: Floor branch is dead code for integer inputs

**File:** `src/dashboard/routes/schedules.ts:63, 217` and `src/sub-agents/registry.ts:1021`
**Issue:** `nagNum > 0 && nagNum < 1` (and the registry's `nagSum > 0 && nagSum < 1`) can
never be true for an integer. In the tool, the per-slot `Number.isInteger` guards run first,
so `nagSum` is always an integer and the floor branch is unreachable. The route branch is the
only place it can ever fire — and only if WR-03 (non-integer validation) is left unfixed. The
plan documents this as deliberate belt-and-suspenders; flagging for awareness that, combined
with WR-03's fix, this branch becomes provably dead and could be removed.
**Fix:** After adding the integer guard (WR-03), drop the `< 1` floor branch, or keep it with
a comment that it is intentionally defensive/unreachable.

### IN-02: `AddReminderForm` resets only ack/startAt state on success, not the core fields

**File:** `dashboard/src/pages/SchedulesPage.tsx:805-813`
**Issue:** On successful create, `onSuccess` resets `requiresAck`, the nag inputs, and
`startAt`, but leaves `message`, `runAt`, `cron`, and `conditions` populated. Because `onDone`
closes the form, this is mostly cosmetic, but if the form is reopened without remount the
stale message/time persist. Compare with `AddScheduleForm` which also does not fully reset.
Minor inconsistency.
**Fix:** Either reset all create fields on success or rely on unmount-on-close consistently.

### IN-03: `formatNagInterval` returns `'?'` for a 0/null interval shown in a NAGS tooltip

**File:** `dashboard/src/pages/SchedulesPage.tsx:84-94, 593`
**Issue:** The NAGS badge tooltip calls `formatNagInterval(schedule.nagIntervalMinutes)`. The
badge only renders when `schedule.requiresAck` is true, but the title is built independently
of `nagIntervalMinutes` being non-null. If a row ever has `requiresAck:true` with
`nagIntervalMinutes:null` (which the backend now prevents on create/update, but legacy/forged
rows could carry), the tooltip reads "Nags every ? until acknowledged". Cosmetic only; the
list-line label at line 573 already guards with `&& schedule.nagIntervalMinutes`.
**Fix:** Optionally guard the badge title the same way the list label is guarded.

### IN-04: Type-name shadowing of `requiresAck`/`nagIntervalMinutes` between body and patch destructuring

**File:** `src/dashboard/routes/schedules.ts:48 vs 207`
**Issue:** POST destructures `{ requiresAck, nagIntervalMinutes }` from the body; PATCH
destructures the same logical fields but renames them (`patchRequiresAck`, `patchNagInterval`)
to avoid clashing with `patch`. This is fine and intentional, but the two handlers use
different local names for the same concept, which slightly hurts readability when scanning the
file. No functional impact.
**Fix:** Optional — none required; noting for maintainability.

---

_Reviewed: 2026-05-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
