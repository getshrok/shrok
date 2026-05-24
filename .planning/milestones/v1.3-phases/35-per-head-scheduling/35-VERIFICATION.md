---
phase: 35-per-head-scheduling
verified: 2026-05-14T07:42:00Z
status: passed
score: 17/17 must-haves verified
overrides_applied: 0
---

# Phase 35: per-head-scheduling Verification Report

**Phase Goal:** Each head owns its own schedules and reminders end-to-end — schedule rows carry `headId`, the ScheduleEvaluator emits per-head schedule_trigger events (closing the WR-03 NOTE), agent-created schedules inherit the spawning head's id, reminders fall back to a head's first configured channel when last-active is null, and head deletion cascades to schedules+reminders.

**Verified:** 2026-05-14T07:42:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                            | Status     | Evidence                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Schedule type carries `headId: string` required field                                            | ✓ VERIFIED | src/db/schedules.ts:5,24 — both Schedule and CreateScheduleOptions interfaces declare headId: string                  |
| 2   | ScheduleStore.create binds `headId: options.headId` with no `?? 'default'` fallback              | ✓ VERIFIED | src/db/schedules.ts:69 `headId: options.headId,` — grep for `options.headId ?? 'default'` returns 0                   |
| 3   | ScheduleEvaluator passes `schedule.headId` as 3rd positional arg to enqueue                      | ✓ VERIFIED | src/scheduler/index.ts:69-79 — enqueue called with schedule.headId as 3rd arg                                         |
| 4   | Lazy JSON migration stamps `headId='default'` on first read; idempotent on subsequent reads      | ✓ VERIFIED | src/db/schedules.ts:48-56 migrateLegacyHeadId; 11 unit tests in schedules.test.ts including mtime-equality assertion  |
| 5   | buildScheduleTools / buildReminderTools require headId as factory argument                       | ✓ VERIFIED | src/sub-agents/registry.ts:739-744 (buildScheduleTools), :903+ (buildReminderTools) — required positional arg         |
| 6   | update_schedule rejects `headId` in input (schema-absence + runtime-reject)                      | ✓ VERIFIED | src/sub-agents/registry.ts:827-841 (no headId in inputSchema.properties); :847-849 runtime reject                     |
| 7   | Reminder fire falls back to first configured channel when getLastActiveChannel returns null      | ✓ VERIFIED | src/head/activation.ts:1087-1106 — let channel + resolveCurrentHeads + head.channels[0].id fallback                   |
| 8   | POST /api/schedules validates headId presence + head-list membership (400/404)                   | ✓ VERIFIED | src/dashboard/routes/schedules.ts:26-40 — 400 missing, 404 unknown; tests in schedules.test.ts                        |
| 9   | GET /api/schedules returns cross-head with headId tags                                           | ✓ VERIFIED | src/dashboard/routes/schedules.ts:22 `scheduleStore.list()` no filter; Schedule entries carry headId                  |
| 10  | PATCH /api/schedules/:id rejects headId in body with 400                                         | ✓ VERIFIED | src/dashboard/routes/schedules.ts:115-118 — `'headId' in req.body` returns 400 before patch construction              |
| 11  | DELETE /api/heads/:id cascades to ScheduleStore.deleteAllForHead AFTER SQL transaction           | ✓ VERIFIED | src/dashboard/routes/heads.ts:289-301 — transaction(db) executes first, then deps.scheduleStore.deleteAllForHead(id)  |
| 12  | DELETE response includes { deletedSchedules, deletedReminders }                                  | ✓ VERIFIED | src/dashboard/routes/heads.ts:312-316 — `{ ok: true, deletedSchedules, deletedReminders }`                            |
| 13  | Dashboard Schedule type has headId; api.schedules.create body type requires it                   | ✓ VERIFIED | dashboard/src/types/api.ts:254 `headId: string`; dashboard/src/lib/api.ts:267 body requires headId (no `?`)           |
| 14  | AddScheduleForm + AddReminderForm have a required Head dropdown                                  | ✓ VERIFIED | SchedulesPage.tsx:338-350 (AddScheduleForm), :681-693 (AddReminderForm) — both `<select>` have `required` attribute   |
| 15  | ScheduleRow + ReminderRow show Head column with deterministic color band                         | ✓ VERIFIED | SchedulesPage.tsx:152-155 ScheduleRow head chip; :517-520 ReminderRow head chip; HEAD_COLORS palette + hashHeadId()   |
| 16  | tests/integration/multi-head-scheduling.test.ts exists with 4+ architectural regression tests   | ✓ VERIFIED | File exists; 5 it() blocks (head_id stamping, single-event guard, cross-head claim isolation, two-head fan-out, lazy migration)  |
| 17  | WR-03 NOTE removed from src/scheduler/index.ts                                                   | ✓ VERIFIED | `grep -rn WR-03 src/` returns 0 matches                                                                               |

**Score:** 17/17 truths verified

### Required Artifacts

| Artifact                                              | Expected                                                                                  | Status      | Details                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `src/db/schedules.ts`                                 | Schedule.headId + CreateScheduleOptions.headId + filtered list + lazy migration + deleteAllForHead | ✓ VERIFIED  | All present; 11 unit tests in schedules.test.ts cover migration contracts |
| `src/db/schedules.test.ts`                            | Unit tests for filter + migration mtime contract + deleteAllForHead                       | ✓ VERIFIED  | File exists; deleteAllForHead tests at line 271+                          |
| `src/scheduler/index.ts`                              | ScheduleEvaluator passes schedule.headId; WR-03 NOTE removed                              | ✓ VERIFIED  | WR-03 gone; schedule.headId at line 79                                    |
| `src/scheduler/scheduler.test.ts`                     | Tests asserting enqueue receives schedule.headId as 3rd arg                               | ✓ VERIFIED  | 22 tests pass; per-head fan-out + headId assertions present              |
| `src/sub-agents/registry.ts`                          | buildScheduleTools/buildReminderTools require headId; update_schedule rejects headId      | ✓ VERIFIED  | Signatures + closure capture + reject all present                         |
| `src/sub-agents/tool-surface.ts`                      | ToolSurfaceDeps.headId required field                                                     | ✓ VERIFIED  | Field present (grep confirms)                                            |
| `src/sub-agents/local.ts`                             | toolSurfaceDeps() threads this.headId                                                     | ✓ VERIFIED  | `headId: this.headId` present (grep confirms 2 matches)                  |
| `src/head/activation.ts`                              | Reminder fire fallback to head.channels[0].id when last_active null                       | ✓ VERIFIED  | Lines 1087-1106 implement the fallback                                    |
| `src/head/activation.test.ts`                         | 4 reminder fallback tests (D-06, D-07 fallback, skip+log edges)                           | ✓ VERIFIED  | describe block at line 371; 4 test scenarios with resolveCurrentHeads     |
| `src/dashboard/routes/schedules.ts`                   | POST/PATCH require/reject headId; GET cross-head                                          | ✓ VERIFIED  | All three validations present at lines 33, 39, 117                       |
| `src/dashboard/routes/schedules.test.ts`              | 6 contract tests for headId routing                                                       | ✓ VERIFIED  | Tests run and pass                                                       |
| `src/dashboard/routes/heads.ts`                       | DELETE cascade + response with counts                                                     | ✓ VERIFIED  | Lines 289-316 — SQL txn → FS cascade → response with counts              |
| `src/dashboard/routes/heads.test.ts`                  | Cascade tests with counts                                                                  | ✓ VERIFIED  | Lines 379, 392 — `{ ok, deletedSchedules, deletedReminders }` assertions  |
| `src/dashboard/server.ts`                             | createSchedulesRouter receives resolveCurrentHeads; createHeadsRouter receives scheduleStore | ✓ VERIFIED | Both wirings present                                                      |
| `dashboard/src/types/api.ts`                          | Schedule.headId field                                                                     | ✓ VERIFIED  | Line 254 `headId: string`                                                |
| `dashboard/src/lib/api.ts`                            | api.schedules.create body type requires headId                                            | ✓ VERIFIED  | Line 267 — `body: { headId: string; ... }`                                |
| `dashboard/src/pages/SchedulesPage.tsx`               | Head picker on create forms; Head column on lists                                         | ✓ VERIFIED  | Both forms + both row components have head UI                            |
| `tests/integration/multi-head-scheduling.test.ts`     | Architectural regression — schedule on head A produces head_id='A'                        | ✓ VERIFIED  | 5 it() blocks; no helpers.ts import; all pass                            |

### Key Link Verification

| From                                          | To                                                                | Via                                                            | Status   | Details                                                   |
| --------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| ScheduleEvaluatorImpl.tick                    | QueueStore.enqueue(event, priority, schedule.headId)              | Per-event headId from row, not constructor field                | ✓ WIRED  | src/scheduler/index.ts:69-79 — schedule.headId at arg 3   |
| buildScheduleTools closure                    | ScheduleStore.create({ headId, ... })                             | Factory closure capture (D-EXEC-OPTION precedent)               | ✓ WIRED  | src/sub-agents/registry.ts:815 — createOpts includes headId from closure |
| handleScheduleTrigger reminder branch         | this.opts.resolveCurrentHeads() lookup                            | First-channel fallback when last_active null                   | ✓ WIRED  | src/head/activation.ts:1092-1094 — resolveCurrentHeads + head.channels[0]?.id |
| createFileStore.get/list/getDue               | migrateLegacyHeadId + write-file-atomic save                       | ScheduleStore migration funnel                                  | ✓ WIRED  | src/db/schedules.ts:92, 101, 143 — three call sites      |
| POST /api/schedules                           | resolveCurrentHeads().find validation                              | 404 on unknown head (D-11)                                      | ✓ WIRED  | src/dashboard/routes/schedules.ts:38-41                  |
| DELETE /api/heads/:id transaction             | scheduleStore.deleteAllForHead(id)                                | After SQL transaction succeeds (D-17)                           | ✓ WIRED  | src/dashboard/routes/heads.ts:301                        |
| AddScheduleForm/AddReminderForm               | api.heads.list() useQuery                                          | Head dropdown options sourcing                                  | ✓ WIRED  | SchedulesPage.tsx:285-287, 639-641                       |

### Data-Flow Trace (Level 4)

| Artifact                              | Data Variable                  | Source                                          | Produces Real Data | Status     |
| ------------------------------------- | ------------------------------ | ----------------------------------------------- | ------------------ | ---------- |
| AddScheduleForm head dropdown         | `headsQuery.data?.heads`       | `api.heads.list()` → GET /api/heads             | Yes — live heads config | ✓ FLOWING |
| AddReminderForm head dropdown         | `headsQuery.data?.heads`       | `api.heads.list()` → GET /api/heads             | Yes — live heads config | ✓ FLOWING |
| ScheduleRow head chip                 | `schedule.headId`              | Schedule entries from GET /api/schedules        | Yes — backend reads tagged Schedule rows from JSON store | ✓ FLOWING |
| ReminderRow head chip                 | `schedule.headId`              | Schedule entries from GET /api/schedules        | Yes — backend reads tagged Schedule rows from JSON store | ✓ FLOWING |
| ScheduleEvaluator enqueue             | `schedule.headId`              | ScheduleStore.getDue() reads from JSON files     | Yes — files now stamped with headId on create/migration | ✓ FLOWING |
| handleScheduleTrigger fallback channel | `head.channels[0]?.id`         | `this.opts.resolveCurrentHeads()` reads fresh config | Yes — fresh-per-call config.json read | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior                                                                | Command                                                          | Result                       | Status |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- | ------ |
| Integration test suite passes                                           | `npx vitest run tests/integration/multi-head-scheduling.test.ts` | 5/5 tests pass               | ✓ PASS |
| Full repo type-check passes                                             | `npx tsc --noEmit`                                               | Exit 0                       | ✓ PASS |
| Full vitest suite passes                                                | `npx vitest run`                                                 | 1450/1450 passed, 1 skipped  | ✓ PASS |
| Dashboard builds cleanly                                                | `cd dashboard && npm run build`                                  | Exit 0, 9.96s                | ✓ PASS |
| Targeted unit tests for Phase 35 components pass                        | `npx vitest run src/db/schedules.test.ts src/scheduler/scheduler.test.ts src/sub-agents/agents.test.ts src/head/activation.test.ts src/dashboard/routes/schedules.test.ts src/dashboard/routes/heads.test.ts` | 204/204 tests pass | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description                                                          | Status      | Evidence                                                                            |
| ----------- | ----------- | -------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| XH-F-02     | informal in ROADMAP goal | Schedules and reminders can be assigned to a specific head | ✓ SATISFIED | Schedule.headId enforced end-to-end: storage, evaluator, agent tools, dashboard API, dashboard UI all carry and respect headId. 11 unit + 7 router + 4 activation + 5 integration tests cover the contract. |

**Note:** Phase 35 plans all have `requirements: []` (empty) in frontmatter. ROADMAP narrative identifies XH-F-02 as the closest mapped requirement; the goal text and all 17 must-haves implement it directly. No orphaned REQUIREMENTS.md IDs map to Phase 35.

### Anti-Patterns Found

| File                                              | Line       | Pattern                | Severity   | Impact                                                       |
| ------------------------------------------------- | ---------- | ---------------------- | ---------- | ------------------------------------------------------------ |
| src/sub-agents/registry.ts                        | 642, 1210-1212 | `BUILTIN_PLACEHOLDER` | ℹ️ Info     | Pre-existing Phase 34 placeholder shapes for spawn_agent/message_agent/cancel_agent — not introduced by Phase 35 |

No blocker or warning anti-patterns introduced by Phase 35. All `headId: 'default'` placeholders mechanically stamped by Plan 35-01 have been replaced with real values by Plans 35-02 (closure) and 35-03 (req body).

### Human Verification Required

None. The user already approved the UI flow during Plan 35-04 Task 3 checkpoint (per task description, the human-verification was accepted by the user). The only items that required human testing — Head dropdown visibility, Head column color banding, persisted JSON files on disk — were covered by that approved checkpoint.

### Gaps Summary

No gaps. All 17 must-haves verified end-to-end:

- **Storage layer (Plan 01):** Schedule type + ScheduleStore + lazy migration + per-event headId stamping at the evaluator. 11 unit tests pin the contract. WR-03 NOTE removed.
- **Agent tool surface + reminder fire (Plan 02):** Factory headId injection + update_schedule reject + ToolSurfaceDeps + first-channel fallback with resolveCurrentHeads callback. 7 new tests added.
- **Dashboard API + cascade (Plan 03):** POST validates headId, PATCH rejects, GET cross-head, DELETE cascades with counts. 10+ new tests added.
- **Dashboard UI + architectural regression (Plan 04):** Required Head dropdowns + Head column + 5-test integration regression. User-approved human verification.

**Data flow verified at all 4 levels:**

1. Artifacts exist (all 18 expected files present)
2. Artifacts substantive (all contain expected patterns, no stubs)
3. Artifacts wired (closure capture + key links all traced)
4. Real data flows (api.heads.list → headsQuery; ScheduleStore JSON → evaluator → queue_events; cascade SQL → FS)

**Behavioral evidence:**
- 1450/1450 full vitest suite passing (executor's claim confirmed)
- `npx tsc --noEmit` exits 0 across whole repo
- Dashboard builds clean (no type errors)
- Integration regression test passes (5/5)

---

_Verified: 2026-05-14T07:42:00Z_
_Verifier: Claude (gsd-verifier)_
