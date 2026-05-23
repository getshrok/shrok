---
phase: 38-nag-mechanism-ack-semantics
verified: 2026-05-23T00:00:00Z
status: passed
score: 5/5
overrides_applied: 0
resolution:
  - item: "REQUIREMENTS.md ACK-03 through ACK-08 checkboxes"
    outcome: "Reconciled to [x] / Complete during phase completion (update_roadmap)."
  - item: "WR-01 (code review) — one-time ack reminder deleted on channel outage"
    outcome: "Fixed in commit 510aab3: delete guarded with !schedule.requiresAck; activation.test.ts Test E added. WR-02..WR-06 remain tracked in 38-REVIEW.md for a later polish pass."
---

# Phase 38: Nag Mechanism & Ack Semantics — Verification Report

**Phase Goal:** An ack-required reminder keeps nagging the user via system-native re-arm until the user explicitly acknowledges it, at which point the nag stops and type-appropriate cleanup runs
**Verified:** 2026-05-23
**Status:** human_needed (all code verified; one documentation gap requires human update)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | An ack-required reminder fires, arms the next nag before delivery, and keeps re-firing on the nag interval without any head action between cycles | VERIFIED | `src/scheduler/index.ts:88-95`: `requiresAck && nagIntervalMinutes !== null` branch placed FIRST in `tick()` advance block; calls `advanceNextRun(id, now + nagIntervalMinutes*60_000)`, leaving `enabled=true`. One-time ack reminders never fall into the `update({enabled:false})` disable path. Three unit tests pin this (ACK-03 one-time re-arm, ACK-06 recurring-while-nagging re-arm, regression). |
| 2 | Acknowledging a one-time ack-required reminder removes it entirely — no further nags fire | VERIFIED | `src/head/index.ts:383-385`: `cron === null` branch calls `this.opts.scheduleStore!.delete(reminderId)`. `head-tools.test.ts` Test 1 asserts `scheduleStore.delete` called with `rem-1` and result `{ ok: true }`, `update` NOT called. |
| 3 | Acknowledging a recurring ack-required reminder stops the current nag loop while the base cron continues to schedule future occurrences | VERIFIED | `src/head/index.ts:386-392`: recurring branch computes `resumeAt = nextRunAfter(schedule.cron, new Date(), tz)` and calls `scheduleStore.update(reminderId, { ackPending: false, nextRun: resumeAt })`. `nextRunAfter` (cron-based resume, NOT `now+nagInterval`) ensures base cadence resumes. `head-tools.test.ts` Test 2 asserts `update` called with `expect.objectContaining({ ackPending: false })` and a valid future ISO `nextRun`; `delete` NOT called. |
| 4 | When ack is received, the already-armed in-flight nag is cancelled rather than allowed to fire | VERIFIED | One-time path: `delete(reminderId)` removes the row entirely — no armed nag can fire without a row. Recurring path: `update({ ackPending: false, nextRun: resumeAt })` re-points `nextRun` to the cron occurrence, overwriting the nag `nextRun` set by the scheduler tick. The scheduler tick's `getDue` only returns rows where `nextRun <= now && enabled=true` — with `nextRun` pointed to a future cron occurrence, the previously-armed nag time is gone. Tests 1 and 2 in `head-tools.test.ts` pin both paths. |
| 5 | The injected fire event includes the reminder ID and ack instructions; the ack tool's description is scoped so it is never applied to an ordinary (non-ack-required) reminder | VERIFIED | `src/head/activation.ts:1146-1152`: `triggerText` for `requiresAck` uses `systemTrigger('reminder', { reminderId: event.scheduleId, 'requires-ack': 'true' }, body)` where body includes `acknowledge_reminder` tool name and reminderId. `src/head/index.ts:101-114`: `acknowledge_reminder` HEAD_TOOLS entry description contains four scoping clauses: requiresAck-only, NEVER ordinary, explicitly confirmed, ID from event. Server-side guard: `requiresAck === false \|\| kind !== 'reminder'` hard errors (D-08 layer b). `activation.test.ts` Test C asserts enqueued text contains `requires-ack="true"`, `reminderId="s1"`, and `acknowledge_reminder`. `head-tools.test.ts` Test 3 and Test 4 assert `{ error: true }` for ordinary reminder and task cases. |

**Score: 5/5 truths verified**

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schedules.ts` | `ackPending` on Schedule, CreateScheduleOptions, SchedulePatch; migration + create + update apply-block | VERIFIED | 6 occurrences of `ackPending`. `SchedulePatch` Pick union includes `'ackPending'`. Migration guard: `if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }`. create default: `ackPending: options.ackPending ?? false`. update apply-block: `if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending`. |
| `src/db/schedules.test.ts` | Migration + round-trip test coverage for ackPending | VERIFIED | 26 occurrences of `ackPending`. Four test cases: legacy migration stamps `ackPending:false`, mtime-stable idempotency (second read does NOT rewrite), create default returns `false`, update round-trip (`true` then `false`). |
| `src/scheduler/index.ts` | requiresAck nag re-arm branch in tick() advance block | VERIFIED | Lines 88-95: requiresAck-first branch calls `advanceNextRun(schedule.id, nagNext.toISOString())`, leaves `enabled=true`. Comment cites ACK-03 and Pitfall 2. |
| `src/scheduler/scheduler.test.ts` | Nag re-arm unit tests; `ackPending: false` in makeSchedule helper | VERIFIED | 4 occurrences of `ackPending`. Three new unit tests at lines 279-348 covering ACK-03 one-time, ACK-06 recurring-while-nagging, cron regression. `makeSchedule` helper carries `ackPending: false`. |
| `src/head/activation.ts` | Steward bypass, ackPending set before enqueue, enriched systemTrigger in reminder fire branch | VERIFIED | Line 1106: `!schedule.requiresAck && (...)` steward bypass guard. Line 1132-1135: requiresAck branch sets `ackPending: true` BEFORE enqueue (line 1153). Lines 1146-1152: enriched `systemTrigger` with `requires-ack:'true'`, `reminderId`, and ack instruction body naming `acknowledge_reminder`. |
| `src/head/activation.test.ts` | Reminder fixture extended; steward-bypass/ackPending/enriched-trigger tests | VERIFIED | Fixture extended with `requiresAck`, `nagIntervalMinutes`, `ackPending`, `headId`, `cronTimezone`. Four new tests: Test A (steward NOT called), Test B (ackPending:true set, delete NOT called), Test C (text contains `requires-ack="true"`, `reminderId="s1"`, `acknowledge_reminder`), Test D (ordinary reminder regression). |
| `src/head/index.ts` | scheduleStore+timezone options, HEAD_TOOLS acknowledge_reminder entry, dispatch case | VERIFIED | `HeadToolExecutorOptions`: `scheduleStore?: import('../db/schedules.js').ScheduleStore` (line 162) and `timezone?: string` (line 165). `HEAD_TOOLS` entry at lines 100-114 with four-clause description. `dispatch` case at lines 368-394 implementing all five branches (not-found no-op, requiresAck-false hard error, ackPending-false no-op, one-time delete, recurring cron-resume). Static `import { nextRunAfter } from '../scheduler/cron.js'` at line 19. |
| `src/system.ts` | scheduleStore + timezone threaded into toolExecutorOpts | VERIFIED | Lines 358-359 of `toolExecutorOpts`: `scheduleStore: stores.schedules` and `timezone: config.timezone`. These flow to production `HeadToolExecutor` via `{...this.opts.toolExecutorOpts}` spread at `activation.ts:772`. |
| `src/head/head-tools.test.ts` | acknowledge_reminder unit coverage (delete/resume/hard-error/no-op) | VERIFIED | File exists, 251 lines, 6 `it()` blocks covering: one-time delete (ACK-04/ACK-06), recurring cron-resume (ACK-05/ACK-06), requiresAck:false hard error (ACK-08), task hard error (Pitfall 5), not-found no-op (D-09), already-acked no-op (D-09). |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `ScheduleEvaluatorImpl.tick` | `ScheduleStore.advanceNextRun` | `requiresAck && nagIntervalMinutes !== null` branch with `now + nagIntervalMinutes*60_000` | VERIFIED | `src/scheduler/index.ts:88-95`: pattern matches `grep -F "schedule.requiresAck && schedule.nagIntervalMinutes !== null"` |
| `migrateLegacySchedule` | `ackPending default` | `'ackPending' in obj` idempotent guard | VERIFIED | `src/db/schedules.ts:65`: exact `'ackPending' in obj` guard form |
| `ScheduleStore.update` | `SchedulePatch` | `patch.ackPending` apply-block | VERIFIED | `src/db/schedules.ts:142`: `if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending` |
| `handleScheduleTrigger` reminder branch | `ScheduleStore.update` | `ackPending:true` set BEFORE enqueue | VERIFIED | Line 1135 (`ackPending: true` update) precedes line 1153 (`queueStore.enqueue`) |
| `handleScheduleTrigger` reminder branch | `systemTrigger` | `reminderId + requires-ack attrs` | VERIFIED | Lines 1146-1152: `systemTrigger('reminder', { reminderId: event.scheduleId, 'requires-ack': 'true' }, body)` |
| `HeadToolExecutor.dispatch acknowledge_reminder` | `ScheduleStore.delete / ScheduleStore.update` | one-time delete vs recurring `ackPending:false + nextRunAfter` resume | VERIFIED | `src/head/index.ts:383-392`: `cron===null` → delete; else → `update(reminderId, { ackPending: false, nextRun: resumeAt })` |
| `buildSystem toolExecutorOpts` | `HeadToolExecutorOptions` | `scheduleStore + timezone fields` | VERIFIED | `src/system.ts:358-359`: `scheduleStore: stores.schedules` and `timezone: config.timezone` in `toolExecutorOpts` |

---

### Data-Flow Trace (Level 4)

All artifacts that render or mutate dynamic data are wired to live store operations:

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `src/head/index.ts` acknowledge_reminder | `schedule` from `scheduleStore.get(reminderId)` | `ScheduleStore.get()` (file-store backed) | Yes — reads live JSON row | FLOWING |
| `src/head/activation.ts` reminder fire branch | `schedule` from `handleScheduleTrigger` (passed in) | Schedule row fetched upstream in activation | Yes — live schedule row | FLOWING |
| `src/scheduler/index.ts` tick() | `schedule.requiresAck`, `schedule.nagIntervalMinutes` | `scheduleStore.getDue()` (file-store backed) | Yes — reads live schedule rows | FLOWING |

No hardcoded empty state or static returns found in any of the phase-modified files.

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — verification performed via grep/static analysis only per instruction to avoid running the app. Tests pass per post-merge gate confirmation (71 phase tests + 414 regression tests green).

---

### Probe Execution

Step 7c: No `scripts/*/tests/probe-*.sh` files declared or found for Phase 38.

---

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| ACK-03 | 38-02 | Scheduler arms next nag in code before delivering the current one | SATISFIED | `src/scheduler/index.ts:88-95`: requiresAck-first branch in `tick()` advance block calls `advanceNextRun` with `now+nagInterval`, keeping `enabled=true`. Three unit tests pin this. |
| ACK-04 | 38-04 | Acknowledging one-time ack reminder deletes it | SATISFIED | `src/head/index.ts:383-385`: `cron===null` path deletes the row. `head-tools.test.ts` Test 1 pins this. |
| ACK-05 | 38-03, 38-04 | Acknowledging recurring ack reminder stops nag loop, base recurrence continues | SATISFIED | `src/head/index.ts:386-392`: `cron present` path updates `{ ackPending: false, nextRun: nextRunAfter(cron, now, tz) }`. `head-tools.test.ts` Test 2 pins this. |
| ACK-06 | 38-02, 38-04 | Ack cancels already-armed in-flight nag (not just a flag flip) | SATISFIED | One-time: row deleted entirely — no armed nag can fire. Recurring: `nextRun` overwritten to future cron occurrence — armed nag time discarded. Both paths wired and tested. |
| ACK-07 | 38-03 | Injected fire event carries reminder ID + ack instructions | SATISFIED | `src/head/activation.ts:1146-1152`: `systemTrigger` with `reminderId`, `requires-ack:'true'` attrs, and ack instruction body naming `acknowledge_reminder`. `activation.test.ts` Test C asserts presence of all three. |
| ACK-08 | 38-03, 38-04 | Ack capability scoped — never applied to ordinary reminders | SATISFIED | Two-layer defense: (a) HEAD_TOOLS description four-clause scoping (`src/head/index.ts:102-106`); (b) server-side hard error when `requiresAck===false || kind!=='reminder'` (`src/head/index.ts:375-378`). `head-tools.test.ts` Tests 3 and 4 pin the structural defense. `activation.test.ts` Test A pins steward bypass so ack-required reminders always deliver. |

**Note:** REQUIREMENTS.md traceability table still shows ACK-03..ACK-08 as `Pending` and all six requirement checkboxes remain `[ ]`. The implementation is complete but the documentation has not been updated. This is the single item requiring human action.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | No `TBD`, `FIXME`, or `XXX` markers found in any phase-modified file | — | No impact |

No debt-marker blockers found. The `TODO` reference at `src/head/index.ts:258` is a user-facing error message string ("placeholder" is used in context "ask the user for the information…not a placeholder response") — not a code stub.

---

### Robustness Gaps (from code review — quality concerns, not goal blockers)

The following issues were identified in the code review (38-REVIEW.md). None block the phase goal because the core ack-semantics contract (ACK-03 through ACK-08) is implemented and tested. They are documented here for awareness.

| Issue | Severity | Description |
|-------|----------|-------------|
| WR-01 | WARNING | One-time ack reminder is permanently deleted at `activation.ts:1100-1102` when channel resolution fails — this runs before the `requiresAck` branch at line 1132, so a channel outage silently destroys an ack reminder. Fix: add `&& !schedule.requiresAck` guard to that delete. |
| WR-02 | WARNING | Agent-side `cancel_reminder` in `registry.ts` has no `requiresAck/ackPending` guard — an agent can silently destroy a nagging ack reminder, bypassing the two-layer scoping built into `acknowledge_reminder`. Fix: mirror the structural defense on the cancel path. |
| WR-03 | WARNING | Recurring ack-resume computes `nextRunAfter(cron, new Date(), tz)` which can return a time very soon for short crons (e.g. `*/5 * * * *`), making acknowledgment feel ineffective with a near-instant re-nag. |
| WR-04 | WARNING | Nag re-arm guard checks `nagIntervalMinutes !== null` but not `> 0` — a zero-value nag interval would cause a nag storm. Reachable only via direct store edit or schema bug; `create_reminder` rejects values < 5. |
| WR-05 | WARNING | A `requiresAck:true, nagIntervalMinutes:null` row (inconsistent state, not reachable via happy path) causes the scheduler to silently disable the one-time ack reminder forever, creating an orphaned ghost row. |
| WR-06 | WARNING | No in-flight dedup check on enqueue — if the head is busy, the 60s tick can enqueue multiple nag messages for the same reminder before any is processed, producing duplicate nag spam under load. |

These are quality/robustness concerns for future phases, not failures of ACK-03..ACK-08.

---

### Human Verification Required

#### 1. Update REQUIREMENTS.md completion status

**Test:** Open `.planning/REQUIREMENTS.md` and update ACK-03 through ACK-08 checkboxes from `[ ]` to `[x]`, and update the traceability table Status column for those six requirements from `Pending` to `Complete`.
**Expected:** REQUIREMENTS.md reflects that Phase 38 completed all six requirements, consistent with the ROADMAP.md entry which already reads `completed 2026-05-23`.
**Why human:** This is a documentation edit decision — the code is implemented and tested, but whether to update the requirements doc is a human choice. The ROADMAP.md already marks Phase 38 as complete; the REQUIREMENTS.md was not updated to match during execution.

---

### Gaps Summary

No implementation gaps. The phase goal is fully achieved in code: all 5 ROADMAP success criteria are verifiably true in the codebase, and all 6 requirements (ACK-03 through ACK-08) have implementation evidence across 4 source files and 3 test files. The single blocking item is a documentation inconsistency — REQUIREMENTS.md still shows ACK-03..ACK-08 as unchecked/pending — which requires a human decision to correct.

---

_Verified: 2026-05-23_
_Verifier: Claude (gsd-verifier)_
