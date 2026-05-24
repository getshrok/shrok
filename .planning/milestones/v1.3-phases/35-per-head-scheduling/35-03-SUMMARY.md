---
phase: 35-per-head-scheduling
plan: 03
subsystem: dashboard-api+head-deletion-cascade
tags: [scheduling, multi-head, dashboard-api, head-cascade, schedule-store]

# Dependency graph
requires:
  - phase: 35-per-head-scheduling
    provides: Plan 35-01 — Schedule.headId required field, CreateScheduleOptions.headId required, ScheduleStore.list({ headId }) filter, lazy migration
  - phase: 33-multi-head-management-ui
    provides: HeadsRouterDeps + DELETE /api/heads cascade pattern (D-07 single-transaction wipe across messages + queue_events + app_state), DashboardServerOptions.resolveCurrentHeads callback
provides:
  - POST /api/schedules requires headId in body, validates against live heads list (D-11)
  - GET /api/schedules returns schedules cross-head, each row tagged with headId (D-12)
  - PATCH /api/schedules rejects headId in body with 400 (D-13)
  - DELETE /api/heads/:id cascades to schedules + reminders (D-16)
  - DELETE response shape includes deletedSchedules + deletedReminders counts (D-17)
  - ScheduleStore.deleteAllForHead(headId) helper with split-count return
affects: [35-04-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Admin-surface 404 over fallback (D-11): unknown headId on POST /api/schedules returns 404 with the head id in the message — explicitly rejects the Phase 33 D-FALLBACK-FIRST policy used by POST /send. Schedules are administrative; silent fallback would hide a real config error from the user."
    - "Defense-in-depth headId reject at PATCH (D-13): server-side mirror of the agent-side D-10 update_schedule reject from Plan 35-02. The schema doesn't see headId as a valid PATCH field (no such field declared at the API level) AND the handler explicitly rejects it at the top before any patch construction so on-disk row is provably untouched."
    - "SQL-before-FS cascade ordering (T-35-12): DELETE /api/heads/:id runs the SQL transaction first (messages + queue_events + app_state), then the file-store cascade. SQL failure rolls back; FS never runs. Reverse order would risk losing schedule data on SQL rollback. FS-first → SQL-failure → lost reminders is the worse failure mode; SQL-first → FS-failure → orphaned files is recoverable (the head is gone from config so list() filtered by headId returns nothing)."
    - "Minimal structural callback type (D-08 in plan): createSchedulesRouter takes resolveCurrentHeads as `() => Array<{ id: string }>` rather than `() => ResolvedHead[]`. The POST validator only needs `.id` for existence-check; importing the full ResolvedHead would couple the schedules surface to future Phase 36+ channel/identity additions for no reading-side benefit. Matches Phase 33 D-SCOPE-MIN-CORRECT and Plan 35-02 D-08-STRUCTURAL-CALLBACK precedents."

key-files:
  created:
    - .planning/phases/35-per-head-scheduling/35-03-SUMMARY.md
  modified:
    - src/dashboard/routes/schedules.ts
    - src/dashboard/routes/schedules.test.ts
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - src/dashboard/server.ts
    - src/db/schedules.ts
    - src/db/schedules.test.ts

key-decisions:
  - "D-11-ADMIN-404 (Plan 35-03): POST /api/schedules with unknown headId returns 404 with the head id in the message. Explicitly rejects Phase 33 D-FALLBACK-FIRST (POST /send) precedent because schedules are administrative — a silent fallback to the first head would hide a real config bug. Documented inline in the route handler so a future refactor doesn't quietly switch policy."
  - "D-12-NO-FILTER-PARAM (Plan 35-03): GET /api/schedules returns ALL schedules cross-head with no `?headId=` filter param. The default cross-head list is the only behavior wired in this plan — `ScheduleStore.list({ headId })` filter exists (Plan 35-01) but the dashboard renders all schedules in one table tagged by Head column (Plan 35-04 D-15). Single-call API matches the UX."
  - "D-13-EXPLICIT-REJECT-NO-STRIP (Plan 35-03): PATCH with headId in body returns 400 explicitly — no silent strip. The 400 error message says 'To move a schedule to a different head, delete and recreate' so the user understands the reassignment semantics rather than discovering the request 'worked' but didn't change the head. Mirrors agent-side D-10 update_schedule reject from Plan 35-02 verbatim."
  - "D-16-SPLIT-COUNTS-IN-STORE (Plan 35-03): ScheduleStore.deleteAllForHead returns `{ schedules: number; reminders: number }` rather than total count. The two are user-meaningful (different vendor surface: schedules run tasks, reminders fire to a channel), so the DELETE /api/heads/:id response can render them separately in the typed-confirmation modal — Plan 04 UI work is data-driven from this shape."
  - "D-17-LIST-IS-MIGRATION-FUNNEL (Plan 35-03): deleteAllForHead iterates this.list() (not this.store.list()) so lazy migration runs on any pre-Phase-35 legacy JSON files first. Without this funnel, a legacy reminder file without `kind` field would never match headId='default' (its raw kind would be undefined) and the cascade would miss it. Reuses the D-03 migration funnel pattern from Plan 35-01."
  - "D-17-CASCADE-AFTER-SQL (Plan 35-03): scheduleStore.deleteAllForHead runs AFTER the SQL transaction inside the DELETE handler. SQL transaction first → if SQL fails, FS untouched; FS deletes are idempotent so partial-failure recovery is 're-run the DELETE call'. T-35-12 mitigation. The reverse order would lose schedule data on SQL rollback."

patterns-established:
  - "Pre-handler header gate for required body fields: POST /api/schedules validates headId presence + head-list membership at the TOP of the handler, BEFORE any other body parsing. Same shape as Phase 33 POST /api/heads's HEAD_ID_REGEX gate. Fail-fast minimizes wasted work and makes the 400/404 distinction crisp."
  - "Lifecycle-additive response shape widening: DELETE /api/heads/:id response was `{ ok: true }` (Phase 33); now `{ ok: true, deletedSchedules: N, deletedReminders: M }`. The legacy `ok: true` field is preserved so curl/scripts that only check the success bit still work. Mirrors Phase 33 D-WIDEN precedent for DashboardEvent."

requirements-completed: []

# Metrics
duration: 8min
completed: 2026-05-14
---

# Phase 35 Plan 03: Dashboard API + Head-Deletion Cascade Summary

**`POST /api/schedules` requires headId in body and validates against the live heads list; `GET /api/schedules` returns cross-head; `PATCH /api/schedules` rejects headId reassignment; `DELETE /api/heads/:id` cascades to schedules + reminders and surfaces the counts in the response body. `ScheduleStore.deleteAllForHead` is the new cascade primitive.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-05-14T07:03:27Z
- **Completed:** 2026-05-14T07:12:24Z
- **Tasks:** 2 (both TDD; 4 commits total — 2 test + 2 feat)
- **Files modified:** 7 (1 created — 35-03-SUMMARY.md)

## Accomplishments

- **D-11 implemented**: `POST /api/schedules` parses `headId` from req.body at the TOP of the handler, returns 400 if missing/empty and 404 if not in `resolveCurrentHeads()`. `createOpts.headId` is set from the validated value (replaces the Plan 35-01 `'default'` placeholder). `grep -c "headId is required" src/dashboard/routes/schedules.ts` = 2 (error message + comment), `grep -c 'head ".*" not found' src/dashboard/routes/schedules.ts` = 1 (404 message)
- **D-12 implemented**: `GET /api/schedules` returns `scheduleStore.list()` unchanged — Plan 35-01 made the no-arg call cross-head, and each row already carries `headId`. Verified via Test 4: schedules under `default` and `work` both come back tagged
- **D-13 implemented**: `PATCH /api/schedules/:id` checks `'headId' in req.body` at the top, returns 400 with "headId cannot be reassigned via PATCH" before any patch construction. The row on disk is provably untouched (Test 5 reads `updatedAt` before + after)
- **D-16 implemented**: `ScheduleStore.deleteAllForHead(headId)` iterates `this.list()` (lazy-migration funnel per Plan 35-01 D-03), deletes matching rows via `this.store.delete()`, returns `{ schedules: N, reminders: M }` split counts discriminated by the `kind` field
- **D-17 implemented**: `DELETE /api/heads/:id` invokes `deps.scheduleStore.deleteAllForHead(id)` AFTER the SQL transaction (T-35-12 ordering), surfaces counts in the response body as `{ ok: true, deletedSchedules: N, deletedReminders: M }`. Legacy `ok: true` preserved (additive widening)
- **createSchedulesRouter signature widened**: `(scheduleStore, timezone, resolveCurrentHeads, unifiedLoader?)` — 3rd positional is the new required `() => Array<{ id: string }>` callback; `unifiedLoader` stays optional at the 4th slot (required-before-optional preserved)
- **HeadsRouterDeps extended**: `scheduleStore: ScheduleStore` required field; server.ts wires it at both branches (production assert paired with db+queue, GET-only `null as unknown as ScheduleStore` cast matching existing db/queue precedent)
- **8 new tests** (6 in `schedules.test.ts` + 3 in `db/schedules.test.ts` for deleteAllForHead + 2 in `heads.test.ts` for cascade):
  - schedules.test.ts: Test 1 (POST happy + persisted headId), Test 2 (POST missing headId → 400), Test 3 (POST unknown headId → 404), Test 4 (GET cross-head), Test 5 (PATCH headId reject + row untouched), Test 6 (PATCH non-headId still works)
  - db/schedules.test.ts: deleteAllForHead split counts, unknown head zeros, idempotent on repeated call
  - heads.test.ts: DELETE cascades to schedules/reminders with counts, DELETE for head-with-zero-schedules returns zeros
- **1445/1445 tests pass** across the full repo (was 1434 — +11 new tests); `npx tsc --noEmit` exits 0

## Task Commits

1. **Task 1 RED — failing tests for headId-required POST, cross-head GET, headId-rejected PATCH** — `e4344b0` (test)
2. **Task 1 GREEN — schedules router validates headId on POST, rejects headId on PATCH** — `c818d5e` (feat)
3. **Task 2 RED — failing tests for deleteAllForHead helper + DELETE /api/heads cascade** — `490e8a6` (test)
4. **Task 2 GREEN — ScheduleStore.deleteAllForHead + DELETE /api/heads cascade with split counts** — `5e6c011` (feat)

## Files Created/Modified

### Created
- `.planning/phases/35-per-head-scheduling/35-03-SUMMARY.md` — this file

### Modified
- `src/dashboard/routes/schedules.ts` — createSchedulesRouter signature widened with `resolveCurrentHeads: () => Array<{ id: string }>` as 3rd required arg; POST handler gets a top-of-function headId presence + head-list validation block (400/404); `createOpts` now uses the validated headId (replaces the Plan 35-01 'default' stamp); PATCH handler gets an explicit `'headId' in body` reject (400) at the top
- `src/dashboard/routes/schedules.test.ts` — 2 existing `createSchedulesRouter(store, 'UTC', unified)` callsites updated to 4-arg form with a `() => [{ id: 'default' }]` heads resolver; 13 existing POST tests updated to include `headId: 'default'` in their bodies; new `describe('headId routing (Plan 35-03 D-11/D-12/D-13)')` block with the 6 contract tests
- `src/dashboard/routes/heads.ts` — `ScheduleStore` type imported; `HeadsRouterDeps` extended with required `scheduleStore` field with JSDoc; DELETE handler invokes `deps.scheduleStore.deleteAllForHead(id)` after the SQL transaction and surfaces split counts in the 200 response body
- `src/dashboard/routes/heads.test.ts` — `ScheduleStore` imported; `MutFixture` interface extended with `scheduleStore` field; all 6 `createHeadsRouter({...})` callsite test fixtures get `scheduleStore: new ScheduleStore(path.join(workspace, 'schedules'))` added; 2 new it() blocks in the POST/DELETE describe pin the cascade contract
- `src/dashboard/server.ts` — `createSchedulesRouter` call updated to pass `resolveCurrentHeads` as the new 3rd arg; both `createHeadsRouter` branches (production + GET-only fallback) get `scheduleStore` — production asserts `this.opts.schedules!` (paired with db/queue presence), fallback uses `null as unknown as ScheduleStore` cast matching the existing db/queue pattern
- `src/db/schedules.ts` — `ScheduleStore.deleteAllForHead(headId): { schedules: number; reminders: number }` added; iterates `this.list()` (lazy-migration funnel), deletes matching rows, returns split counts discriminated by kind
- `src/db/schedules.test.ts` — 3 new it() blocks: split-count return, zeros for unknown head, idempotent on repeated call

## Decisions Made

See key-decisions in frontmatter. Summary:

- **D-11-ADMIN-404**: POST /api/schedules with unknown headId returns 404 with the head id in the error message — explicitly NOT the Phase 33 D-FALLBACK-FIRST policy used by POST /send. Schedules are administrative; silent fallback would hide a real config bug.
- **D-12-NO-FILTER-PARAM**: GET /api/schedules returns ALL schedules cross-head with no `?headId=` filter param. `ScheduleStore.list({ headId })` filter exists from Plan 35-01 but the dashboard renders cross-head in one table; single-call API matches the UX. Future plans can add the filter param if a per-head sub-view is requested.
- **D-13-EXPLICIT-REJECT-NO-STRIP**: PATCH with headId in body returns 400 explicitly with "To move a schedule to a different head, delete and recreate". No silent strip — the user must understand the reassignment semantics. Mirrors the agent-side D-10 reject from Plan 35-02.
- **D-16-SPLIT-COUNTS-IN-STORE**: ScheduleStore.deleteAllForHead returns split `{ schedules, reminders }` rather than a flat total. Reminders and tasks are user-meaningful as different surfaces (tasks run TASK.md; reminders fire to a channel), so the response can render them separately in the Plan 04 confirmation modal.
- **D-17-LIST-IS-MIGRATION-FUNNEL**: deleteAllForHead iterates `this.list()` not `this.store.list()` so the D-03 migration funnel runs on legacy files first. Without this, a pre-Phase-35 reminder JSON with no `kind` field would never match `s.kind === 'reminder'` and the cascade would mis-classify. Reuses the Plan 35-01 pattern.
- **D-17-CASCADE-AFTER-SQL**: SQL transaction first, file-store cascade second. T-35-12 mitigation — SQL failure → FS untouched; SQL success → FS partial failure is recoverable (orphan files are harmless because the head is gone from config). Reverse order would lose schedule data on SQL rollback.

## Deviations from Plan

**None — plan executed exactly as written.**

The only work beyond the literal Action steps was mechanical test-fixture maintenance:
- 13 existing POST tests in `schedules.test.ts` already had POST bodies WITHOUT headId. After the D-11 validation lands they would 400 with "headId is required", so each was updated to include `headId: 'default'`. Documented in the test commit message.
- All 6 `createHeadsRouter({...})` callsite fixtures in `heads.test.ts` got `scheduleStore: new ScheduleStore(path.join(workspace, 'schedules'))` added. This is the inverse of the Plan 35-02 mechanical maintenance pattern — Wave 2 plans land the interface change; the same plan's test commit updates all fixtures.

Both classes of update are pinned by the acceptance criteria (`tsc --noEmit` exit 0; vitest exit 0 with all tests green) — without them the build would not compile.

## Structural Type for resolveCurrentHeads — Per Plan Output Spec

Per Plan output, documenting the chosen structural type:

`createSchedulesRouter` takes `resolveCurrentHeads: () => Array<{ id: string }>` — the **minimal** shape. The POST validator only needs `.id` for the `.some(h => h.id === headId)` existence check. This explicitly diverges from `HeadsRouterDeps.resolveCurrentHeads: () => ResolvedHead[]` (the full Phase 31 type) used by the heads router.

Rationale (mirrors Plan 35-02 D-08-STRUCTURAL-CALLBACK):
- The schedules router never reads channels, vendor secrets, or identity. Importing ResolvedHead would couple the route to fields it never reads.
- Future Phase 36+ additions to ResolvedHead (per-head identity overrides, etc.) don't ripple into this route.
- The server.ts wiring passes the same `resolveCurrentHeads` callback to both routers — TypeScript structurally widens the ResolvedHead return to the minimal shape at the call site automatically. Zero runtime overhead.

## Order of Operations in DELETE Handler — Per Plan Output Spec

Per Plan output, documenting DELETE /api/heads/:id ordering:

1. **confirmId guard** (Phase 33 D-06): if body has `confirmId`, it must match URL `:id` — otherwise 400 with no DB or FS touch
2. **Reserved-id guard**: `default` head cannot be deleted (400)
3. **Existence check**: head must be in `resolveCurrentHeads()` (404)
4. **SQL transaction** (Phase 33 D-07): atomic wipe of messages + queue_events + app_state. Throws → rolls back, response 500
5. **FS cascade** (Plan 35-03 D-16): `scheduleStore.deleteAllForHead(id)` — runs AFTER SQL succeeds. Non-transactional but idempotent
6. **Lazy migration** (Phase 33 D-04): `materializeLazyMigrationIfNeeded` — usually a no-op here since the system is already past migration
7. **config.json rewrite**: drop the head from `heads[]`, write atomically
8. **Response**: `{ ok: true, deletedSchedules: N, deletedReminders: M }` (D-17)

Rationale per T-35-12: SQL-first ensures rollback recovers cleanly. FS-first → SQL-failure would leave the SQL state intact but lose schedule data with no rollback. The chosen ordering's worst case is orphan FS files when SQL succeeds + FS partial-fails; those files are harmless because the head is gone from config (subsequent `list({ headId: id })` returns nothing).

## Unexpected Callsites of createSchedulesRouter / createHeadsRouter — Per Plan Output Spec

Per Plan output, documenting callsite scan results:

`grep -rn "createSchedulesRouter\b" --include="*.ts" /home/ubuntu/shrok/src /home/ubuntu/shrok/tests` returns 4 hits — all in `src/dashboard/`:
- `src/dashboard/server.ts:33` (import)
- `src/dashboard/server.ts:254` (call — updated by this plan)
- `src/dashboard/routes/schedules.ts:10` (definition — updated)
- `src/dashboard/routes/schedules.test.ts` (3 callsites in tests — updated)

`grep -rn "createHeadsRouter\b"` returns 9 hits — all in `src/dashboard/`:
- `src/dashboard/server.ts` (import + 2 calls — both updated)
- `src/dashboard/routes/heads.ts` (definition — updated)
- `src/dashboard/routes/heads.test.ts` (6 callsites — all updated)

**No unexpected callsites in tests/ or scripts/eval/.** Phase 33's dashboard-only contract is preserved — the heads router and schedules router are dashboard-server-only by design.

## Notes for Plan 35-04 (dashboard UI)

- **D-14 (head picker on create form)**: The new POST body shape is `{ headId, kind, taskName?, cron?, runAt?, ... }`. The UI must add a head dropdown sourced from `GET /api/heads`. The form's submit handler should send `headId: selectedHead` — server returns 400 with "headId is required" if omitted, 404 with `head "${id}" not found` if invalid.
- **D-15 (Head column on list view)**: Each schedule from `GET /api/schedules` already carries `headId`. Render a `Head` column in the schedules table sourced directly from `schedule.headId`. No new API plumbing.
- **D-17 (delete confirmation UI)**: `DELETE /api/heads/:id` response now includes `deletedSchedules` + `deletedReminders` counts. The typed-confirmation DeleteHeadModal can surface these counts in the post-delete confirmation toast (e.g., "Deleted head 'work' — wiped 3 messages, 2 schedules, 1 reminder"). Use `GET /api/heads/:id/counts` (Phase 33 D-06) for the pre-delete preview; the response counts are the post-delete actuals.
- **PATCH UX**: If a user tries to edit a schedule's head via the row inline editor, the server returns 400 with "headId cannot be reassigned via PATCH. To move a schedule to a different head, delete and recreate." The UI should ideally not expose a head edit control — Plan 04 reads-only the head column. If a "move schedule" workflow is desired in the future, it's delete-then-recreate.

## Threat Surface Scan

No new threat surface introduced beyond what the plan's `<threat_model>` (T-35-09 through T-35-13) already enumerates:

- **T-35-09** (Spoofing — POST headId): mitigated via D-11 validation against `resolveCurrentHeads()`. Test 3 pins the 404 path.
- **T-35-10** (Elevation — PATCH headId reassignment): mitigated via D-13 explicit 400 reject. Test 5 pins on-disk row untouched.
- **T-35-11** (Info disclosure — GET cross-head): accepted per plan. All schedule endpoints require `requireAuth`; cross-head visibility is the intended admin UX.
- **T-35-12** (Tampering — cascade partial-failure): mitigated via SQL-first/FS-second ordering. The handler's comment documents this for future maintainers.
- **T-35-13** (DoS — deleteAllForHead O(N)): accepted; N bounded by user-created schedules (<1000 in practice).

## Self-Check: PASSED

Verified before writing this section:
- `.planning/phases/35-per-head-scheduling/35-03-SUMMARY.md` exists (FOUND after Write)
- `src/dashboard/routes/schedules.ts` contains `resolveCurrentHeads: () => Array<{ id: string }>` (FOUND at line 13)
- `src/dashboard/routes/schedules.ts` contains "headId is required" (FOUND, 2 matches — error + comment)
- `src/dashboard/routes/schedules.ts` contains `head "${headId}" not found` (FOUND at line 39)
- `src/dashboard/routes/schedules.ts` contains "headId cannot be reassigned" (FOUND at line 116)
- `src/dashboard/routes/schedules.ts` contains `headId, kind` in createOpts (FOUND at line 96)
- `src/db/schedules.ts` contains `deleteAllForHead(headId: string)` (FOUND at line 193)
- `src/dashboard/routes/heads.ts` contains `scheduleStore: ScheduleStore` (FOUND, 1 match in HeadsRouterDeps)
- `src/dashboard/routes/heads.ts` contains `deps.scheduleStore.deleteAllForHead` (FOUND, 1 match in DELETE)
- `src/dashboard/routes/heads.ts` contains `deletedSchedules` and `deletedReminders` (FOUND, 1 match each)
- `src/dashboard/server.ts` contains `scheduleStore` (FOUND, 3 matches — import + 2 createHeadsRouter branches)
- Commit hashes exist in `git log`: e4344b0, c818d5e, 490e8a6, 5e6c011 (FOUND)
- `npx tsc --noEmit` exits 0 (PASSED)
- `npx vitest run` 1445/1445 passing (PASSED)

---
*Phase: 35-per-head-scheduling*
*Completed: 2026-05-14*
