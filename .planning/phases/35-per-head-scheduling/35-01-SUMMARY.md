---
phase: 35-per-head-scheduling
plan: 01
subsystem: database
tags: [scheduling, multi-head, lazy-migration, file-store, queue-events]

# Dependency graph
requires:
  - phase: 29-data-layer
    provides: QueueStore.enqueue(event, priority, headId?) — 3rd-positional headId arg with 'default' fallback at the SQL layer
  - phase: 33-multi-head-management-ui
    provides: D-MIGRATION-IDEMPOTENT — lazy migration with idempotent guard and mtime-stable second read
  - phase: 34-multi-head-agent-lifecycle
    provides: D-ROW-WRITE-FROM-OPTIONS (no '?? default' at row-write site) + D-ALL-SIX (3rd-positional headId pattern at enqueue callsites)
provides:
  - Schedule.headId required field on the storage type
  - CreateScheduleOptions.headId required field at the API boundary
  - ScheduleStore.list(filter?: { headId?: string }) optional headId filter
  - migrateLegacyHeadId() inline helper: stamps headId='default' on first read of legacy JSON, idempotent guard on subsequent reads (mtime-stable)
  - ScheduleEvaluatorImpl per-event headId stamping — schedule.headId is passed as the 3rd positional arg to queueStore.enqueue for schedule_trigger events
  - WR-03 NOTE removed from src/scheduler/index.ts
affects: [35-02-tools, 35-03-dashboard, 35-04-ui, future-cascade-on-head-delete]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy-migration inline-helper pattern: in-place mutate-then-save once-guarded migration runs on every read path (get/list/getDue); skipped via 'in' check on subsequent reads; mtime-stable second read"
    - "Per-event head identity at enqueue boundary: scheduler reads each row's headId at fire time and passes it as enqueue's 3rd positional arg — no per-head clock, one global ticker (D-04)"

key-files:
  created:
    - src/db/schedules.test.ts
    - .planning/phases/35-per-head-scheduling/35-01-SUMMARY.md
  modified:
    - src/db/schedules.ts
    - src/scheduler/index.ts
    - src/scheduler/scheduler.test.ts
    - src/db/db.test.ts
    - src/sub-agents/agents.test.ts
    - src/sub-agents/registry.ts
    - src/dashboard/routes/schedules.ts
    - scripts/eval/scenarios/proactive-decision.ts
    - scripts/eval/scenarios/proactive-decision-realistic.ts
    - scripts/eval/scenarios/schedule-management.ts

key-decisions:
  - "D-01-LIST-FILTER-OBJECT-SHAPE (Plan 35-01): list filter is `list(filter?: { headId?: string })` (object-shape, optional inner field) over `list(headId?: string)` positional. Matches AgentStore.list() multi-field-filter shape; lets future filter fields (kind, enabled) ride along without a breaking signature change"
  - "D-02-MIGRATION-INLINE (Plan 35-01): migrateLegacyHeadId() lives inline in src/db/schedules.ts (not generalized into file-store.ts). Reminder has a different legacy shape (kind:'reminder' default vs 'task') and Phase 33 .env migration is unrelated — generalization has no payoff"
  - "D-03-GET-IS-MIGRATION-FUNNEL (Plan 35-01): markFired/advanceNextRun/markSkipped refactored to route through this.get(id) rather than this.store.get(id), so they pick up the migration hook without duplicating the wrap. Single funnel through get() — smaller diff than per-method migration calls"
  - "D-04-ENQUEUE-3RD-ARG-PER-EVENT (Plan 35-01): scheduler.tick() passes schedule.headId (per-row, per-event) — NOT this.headId (no constructor field). One global evaluator per D-04 in 35-CONTEXT.md; per-head clocks explicitly rejected"

patterns-established:
  - "Lazy-migration via inline helper that returns { migrated: boolean; data: T | null }: idempotent guard + in-place save() on migrated entries. Used by get/list/getDue. Mirrors Phase 33 D-MIGRATION-IDEMPOTENT in shape (idempotent, write-file-atomic, mtime-stable on subsequent reads) but inlined per Plan 35-01 D-02-MIGRATION-INLINE"
  - "Cross-head data with optional same-shape filter: list() and getDue() default to cross-head reads; list({ headId }) opt-in narrows. getDue() stays cross-head intentionally — the global evaluator iterates all heads per tick and reads each row's headId at the enqueue site (D-04)"

requirements-completed: []

# Metrics
duration: 8min
completed: 2026-05-14
---

# Phase 35 Plan 01: Per-Head Scheduling Storage Foundation Summary

**Schedule type now carries required `headId: string`; legacy JSON files self-migrate to `headId='default'` on first read; ScheduleEvaluatorImpl stamps `schedule.headId` per-event on enqueue.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-14T06:32:34Z
- **Completed:** 2026-05-14T06:40:14Z
- **Tasks:** 2 (both TDD; 4 commits total — 2 test + 2 feat)
- **Files modified:** 10 (1 created — src/db/schedules.test.ts)

## Accomplishments

- **D-01 implemented**: `Schedule.headId: string` required field at the storage type level (`grep -c "headId: string" src/db/schedules.ts` = 2: Schedule + CreateScheduleOptions)
- **D-02 implemented**: `ScheduleStore.create()` binds `headId: options.headId` with NO `?? 'default'` fallback (`grep -c "options.headId ?? 'default'" src/db/schedules.ts` = 0; row-write site delegates safety to the type-required API boundary, mirrors Phase 34 D-ROW-WRITE-FROM-OPTIONS)
- **D-03 implemented**: lazy `migrateLegacyHeadId()` helper stamps `headId='default'` on first read of legacy JSON files via the existing `createFileStore.save()` → `writeJsonFile` → `write-file-atomic` chain. Idempotent guard (`'headId' in raw` check) makes the second read a no-op; test pins contract via `fs.statSync(file).mtimeMs` equality + byte-equality of file contents across 2nd and 3rd reads
- **D-04 implemented**: `ScheduleEvaluatorImpl.tick()` passes `schedule.headId` as the 3rd positional arg to `queueStore.enqueue()` for `schedule_trigger` events; constructor signature unchanged (no headId field — one global ticker per D-04 in 35-CONTEXT.md)
- **D-05 verified**: `src/head/activation.ts` not modified by this plan (consumer side already filters claims by `this.opts.headId` per Phase 29/30, no changes required)
- **WR-03 NOTE removed**: 5-line block at `src/scheduler/index.ts:69-73` deleted (the constructor-headId guidance was obsolete — the fix is per-event from `schedule.headId`)
- **11 new ScheduleStore tests** pin the storage contracts (persist headId, round-trip, filtered list, cross-head getDue, idempotent migration with mtime stability, list() migrating ALL legacy files, getDue+markFired migration funnels)
- **2 new ScheduleEvaluator tests** pin per-event headId stamping (single-head + 2-head fan-out); existing "enqueues a schedule_trigger" test extended to also assert `headId === 'default'` as 3rd arg
- **1426/1426 tests pass** across the full repo (was 1413 — +13 new tests added by this plan); `npx tsc --noEmit` exits 0

## Task Commits

1. **Task 1 RED — failing ScheduleStore tests** — `6517645` (test)
2. **Task 1 GREEN — Schedule.headId + filter + lazy migration** — `4821f18` (feat)
3. **Task 2 RED — failing ScheduleEvaluator headId tests** — `b22b113` (test)
4. **Task 2 GREEN — ScheduleEvaluator passes schedule.headId + WR-03 NOTE removed** — `fe38e6b` (feat)

## Files Created/Modified

### Created
- `src/db/schedules.test.ts` — 11 it() blocks covering: persist headId on create, round-trip through get(), filtered/unfiltered list, cross-head getDue, idempotent lazy migration with mtime + byte equality, list() migrating all legacy files in a directory, getDue+markFired migration funnels

### Modified
- `src/db/schedules.ts` — added `headId: string` to Schedule + CreateScheduleOptions; added `migrateLegacyHeadId()` inline helper; rewrapped get/list/getDue to run migration; routed markFired/advanceNextRun/markSkipped through `this.get(id)` (migration funnel); changed `list()` to `list(filter?: { headId?: string })`
- `src/scheduler/index.ts` — removed 5-line WR-03 NOTE block; added `schedule.headId` as 3rd positional arg to the enqueue call inside `tick()`
- `src/scheduler/scheduler.test.ts` — `makeSchedule()` helper gets `headId: 'default'`; existing "enqueues a schedule_trigger" test extended to destructure and assert the 3rd arg; 2 new it() blocks: Test A (single 'work' head), Test B (fan-out with 2 distinct headIds)
- `src/db/db.test.ts` — 12 existing ScheduleStore.create({...}) callsites stamped with `headId: 'default'` (the existing test contracts are head-agnostic; explicit stamp keeps tsc green)
- `src/sub-agents/agents.test.ts` — 1 callsite stamped (`s-task-x` reminder-tools fixture)
- `src/sub-agents/registry.ts` — `buildScheduleTools` and `buildReminderTools` createOpts stamped with `headId: 'default'` PLUS comment noting Plan 35-02 will wire from tool factory closure (per D-09)
- `src/dashboard/routes/schedules.ts` — POST /api/schedules createOpts stamped with `headId: 'default'` PLUS comment noting Plan 35-03 will wire from req body (per D-11)
- `scripts/eval/scenarios/proactive-decision.ts`, `proactive-decision-realistic.ts`, `schedule-management.ts` — eval scenario fixtures stamped with `headId: 'default'` (these scenarios are single-head by design — they exercise scheduler behavior, not multi-head fan-out)

## Decisions Made

See key-decisions in frontmatter. Summary:

- **D-01-LIST-FILTER-OBJECT-SHAPE**: chose `list(filter?: { headId?: string })` over positional `list(headId?: string)` so future filter fields (kind, enabled) can land additively without a breaking signature change. Matches the `Partial<>`/options-object shape used elsewhere in the codebase.
- **D-02-MIGRATION-INLINE**: kept `migrateLegacyHeadId()` inline in `src/db/schedules.ts` rather than generalizing into `file-store.ts`. Reminder JSON has a different legacy shape (no `kind` field defaults to 'task') and Phase 33's `.env` migration is unrelated — there is no shared abstraction worth extracting.
- **D-03-GET-IS-MIGRATION-FUNNEL**: refactored `markFired/advanceNextRun/markSkipped` to route their internal read through `this.get(id)` (rather than `this.store.get(id)`), so the migration runs on every public read path with zero duplication. Smaller diff than per-method migration calls.
- **D-04-ENQUEUE-3RD-ARG-PER-EVENT**: per-event `schedule.headId` at the enqueue call site — explicitly NOT a constructor field on `ScheduleEvaluatorImpl`. One global ticker per D-04 in 35-CONTEXT.md; per-head clocks rejected as no-benefit complexity.

## Deviations from Plan

**None — plan executed exactly as written.**

The only work beyond the literal Action steps was the mechanical `headId: 'default'` stamp at 15 existing call sites (db.test.ts ×12, agents.test.ts ×1, registry.ts ×2, schedules.ts route ×1, 3 eval scenarios). These were necessary to keep `npx tsc --noEmit` exit 0 — the acceptance criteria explicitly require tsc-green and the makeSchedule helper update mentioned in Action step 10 only covers scheduler.test.ts. The other stamps are mechanical type-fillers; Plan 02 (tool factories) and Plan 03 (dashboard route) will replace them with the real per-head value from closure/req-body.

This is consistent with Phase 34 D-WAVE-1-RED → D-WAVE-2-GREEN cadence: storage plan adds the type-required field; consumer plans wire it. The mechanical stamps are documented in code with `// headId: stamped as 'default' here; Plan 35-0X wires per-head from ...` comments at the registry.ts and schedules.ts route sites.

## Issues Encountered

None.

## Notes for Plan 35-02 (tool factories)

The following call sites in `src/sub-agents/registry.ts` have `headId: 'default'` placeholders that Plan 02 will replace with the closure-captured `headId` factory arg (per D-09):

- `buildScheduleTools` line ~815: `const createOpts: CreateScheduleOptions = { id, headId: 'default', taskName, kind: 'task' }` → replace `'default'` with the closure-captured `headId`
- `buildReminderTools` line ~1013: `const createOpts: CreateScheduleOptions = { id, headId: 'default', kind: 'reminder', ... }` → same closure swap

Both lines are marked with `// headId: stamped as 'default' here; Plan 35-02 wires per-head from tool factory closure` so the find target is easy.

`src/sub-agents/agents.test.ts:1301` directly stamps `headId: 'default'` on a bare ScheduleStore.create() — that test is exercising the reminder-tools filter logic, not multi-head, so the stamp is correct as-is. Plan 02 only needs to add headId-fan-out tests if it adds new fixtures; existing reminder-tools tests don't need rework.

## Notes for Plan 35-03 (dashboard API)

- `src/dashboard/routes/schedules.ts:69` (POST /api/schedules): `const createOpts: CreateScheduleOptions = { id: generateId('sched'), headId: 'default', kind }` → Plan 03 replaces with `req.body.headId` after validating the head exists in the heads loader (D-11). Marked with `// headId: stamped as 'default' here; Plan 35-03 wires per-head from req body`.
- `src/dashboard/routes/schedules.test.ts` has no schedules.create() calls (only constructs the store), so no test fixture stamps are needed there.
- The new `ScheduleStore.list({ headId })` filter API is available for Plan 03's optional `?headId=` query param (D-12 noted this as a future addition; the filter is already in place).

## Notes for Plan 35-04 (dashboard UI)

- `ScheduleStore.list()` (no args) returns cross-head schedules with each row tagged by `headId` — matches D-12-LIST-CROSS-HEAD. The list view in Plan 04 can render the `Head` column (D-15) directly from `schedule.headId` with no additional API plumbing.
- The new schedule create form (D-14) sends `headId` in the POST body — Plan 03 validates it server-side. Plan 04 just needs to expose the head picker in the UI.

## Next Phase Readiness

- Storage layer end-to-end multi-head correct: type required, migration idempotent, evaluator stamps per-event. Ready for Plan 02 (agent tool surface).
- `src/head/activation.ts:1070-1130` (the reminder fire branch — D-05/D-06/D-07/D-08 territory) is untouched, as planned. Plan 02 will modify it for the first-channel fallback.
- Cascade on head delete (D-16, D-17) is a Plan 03 concern — `ScheduleStore.list({ headId })` is the right primitive for the cascade `.forEach(s => store.delete(s.id))` loop.

## Self-Check: PASSED

Verified before writing this section:
- `src/db/schedules.test.ts` exists and contains 11 it() blocks (FOUND)
- `src/scheduler/scheduler.test.ts` contains `headId: 'work'` (2 matches; FOUND)
- `grep -c "schedule.headId" src/scheduler/index.ts` = 1 (FOUND)
- `grep -c "NOTE (WR-03)" src/scheduler/index.ts` = 0 (REMOVED as expected)
- `grep -c "headId: string" src/db/schedules.ts` = 2 (FOUND on Schedule + CreateScheduleOptions)
- Commit hashes exist in `git log`: 6517645, 4821f18, b22b113, fe38e6b (FOUND)
- `npx tsc --noEmit` exits 0 (PASSED)
- `npx vitest run` 1426/1426 passing (PASSED)

---
*Phase: 35-per-head-scheduling*
*Completed: 2026-05-14*
