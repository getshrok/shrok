---
phase: 33-multi-head-management-ui
plan: 04
subsystem: dashboard
tags: [multi-head, dashboard, heads-crud, rest-api, sqlite-transaction, lazy-migration, tdd, DASH-03]

requires:
  - phase: 33-multi-head-management-ui
    plan: 01
    provides: "QueueStore.deleteAllForHead(headId) symmetric helper; MessageStore.deleteAllForHead already existed"
  - phase: 33-multi-head-management-ui
    plan: 02
    provides: "Per-head adapter map; DashboardServerOptions threading pattern"
provides:
  - "POST /api/heads — create head with HEAD_ID_REGEX + reserved-id validation, returns 200 / 400"
  - "DELETE /api/heads/:id — single-transaction wipe across messages + queue_events + app_state, then config.json rewrite; default non-deletable (D-08)"
  - "PATCH /api/heads/:id — atomic UPDATE migration across 3 tables (substr-anchored prefix strip), then config.json rewrite; default non-renamable (D-08 mirror)"
  - "GET /api/heads still extended (Task 1) with masked channels (D-17)"
  - "materializeLazyMigrationIfNeeded — D-04 lazy first-save migration: synthesizes default head into config.json heads[], strips 5 flat channel-id config keys and 12 channel env vars; idempotent (preserves mtime when already migrated)"
  - "parseEnvFile + writeEnvFile exported from src/dashboard/routes/settings.ts so the heads router can reuse them without duplication"
  - "20 new tests in src/dashboard/routes/heads.test.ts (11 POST/DELETE/lazy-migration + 9 PATCH) — total 25 tests in the file"
affects: [plan-05-heads-channels-subresource, plan-06-heads-tab-frontend, plan-07-typed-confirmation-delete]

tech-stack:
  added: []
  patterns:
    - "Fresh-read-on-every-mutation: loadConfigJsonInline reads config.json from disk inside each handler so concurrent saves cannot race against a stale in-memory snapshot — last writer wins (T-33-11 accepted)"
    - "Lazy migration as a single idempotent helper called BEFORE every mutating handler — the if-already-migrated early-return makes the helper safe to invoke from POST/DELETE/PATCH without re-checking from each caller"
    - "Substr-anchored prefix strip for app_state rename — `key = ? || substr(key, oldId.length + 2) WHERE key LIKE 'old:%'` — anchored to the start so substrings of the old id later in the key cannot be mis-edited (vs REPLACE which would)"
    - "Three-table atomic UPDATE inside transaction() with rollback proven by monkey-patching db.prepare to throw on the third statement and asserting all three tables stay at the pre-rename state"
    - "Reused parseEnvFile/writeEnvFile from settings.ts (exported in this plan) — the only writer-router pattern is settings.ts, and heads.ts borrows its env tooling rather than diverging"

key-files:
  created: []
  modified:
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - src/dashboard/routes/settings.ts

key-decisions:
  - "Exported parseEnvFile and writeEnvFile from src/dashboard/routes/settings.ts rather than inlining a copy in heads.ts — keeps env file format handling (quoting, escape sequences, mode 0o600) in one place. The plan listed this as an explicit either/or; export was the cleaner choice and matches CONTEXT.md's 'one canonical writer' principle"
  - "materializeLazyMigrationIfNeeded called from POST and DELETE and PATCH (D-04). The early-return guard (heads[].length > 0) makes this safe — the test 'lazy migration is idempotent' pins the byte-identical-env contract"
  - "Used a 20ms setTimeout in the idempotency test before the second POST so a faulty refactor that re-writes .env would tick mtimeMs and fail the equality assertion. Without the wait, mtimeMs could be equal even on a real write at sub-millisecond filesystem resolution"
  - "Rollback test uses Object.assign-style monkey-patch on fx.db.prepare and restores it before any assertion runs. Routing the throw through deps.db.prepare (not throw-inside-the-callback) more closely mirrors a real SQLite error from the driver"
  - "The PATCH handler returns 500 on transaction failure (not 400) — the rename inputs were valid; the failure is server-side. The rollback test only asserts non-200, allowing future refinement of the exact status without churning the test"

patterns-established:
  - "Heads CRUD writer pattern: validate -> materializeLazyMigrationIfNeeded -> read config.json fresh -> mutate -> writeFileAtomic. Plan 05's channel sub-resource handlers follow the same pattern with a deeper config path"
  - "Atomic 3-table head-scoped UPDATE/DELETE inside transaction() — sets the precedent for any future per-head data migration (e.g., merge-heads or split-head features)"

requirements-completed: [DASH-03]

duration: 6min
completed: 2026-05-13
---

# Phase 33 Plan 04: Heads CRUD Router Summary

**POST/PATCH/DELETE /api/heads now ship — create, rename, and delete heads from the API with D-13 id validation, D-07 single-transaction wipe, D-14 atomic 3-table rename, and D-04 lazy migration on first save, all under D-16 nested-REST. The default head is non-deletable and non-renamable. 25/25 heads.test.ts tests pass; whole-tree tsc green; 105/105 dashboard tests pass.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-13T20:44:43Z
- **Completed:** 2026-05-13T20:50:58Z
- **Tasks:** 2 (Task 1 was already completed by a prior executor; this resume picked up Tasks 2 + 3)
- **Files modified:** 3 (heads.ts, heads.test.ts, settings.ts — no new files)

## Accomplishments

- POST /api/heads creates a head after validating id against `HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/` (D-13) and the reserved-list (D-08), rejecting duplicates against `resolveCurrentHeads()`.
- DELETE /api/heads/:id wipes `messages` + `queue_events` + `app_state` rows for that head inside one `transaction()` (D-07) using the existing `MessageStore.deleteAllForHead` and `QueueStore.deleteAllForHead` helpers plus a prepared `DELETE FROM app_state WHERE key LIKE ?`. Then rewrites `config.json` via `writeFileAtomic`.
- DELETE /api/heads/default returns 400 (D-08 server-side enforcement); DELETE on unknown id returns 404.
- PATCH /api/heads/:id renames atomically across 3 tables (D-14) using substr-anchored prefix-strip for `app_state.key` so substrings of the old id later in the key are not mis-edited:
  ```sql
  UPDATE messages    SET head_id = ? WHERE head_id = ?;
  UPDATE queue_events SET head_id = ? WHERE head_id = ?;
  UPDATE app_state    SET key = ? || substr(key, oldId.length + 2) WHERE key LIKE 'old:%';
  ```
- PATCH rejects: invalid newId (400), reserved 'default' as newId (400), renaming 'default' itself (400 — mirrors DELETE policy per D-08), newId === existing head (400), unknown oldId (404), missing/non-string newId (400). newId === oldId is a no-op success (200).
- `materializeLazyMigrationIfNeeded` (D-04) runs before every mutating handler. On a legacy config.json without `heads[]`, it snapshots `resolveCurrentHeads()` into `heads[]`, strips the 5 flat channel-id fields (`telegramChatId`, `discordChannelId`, `slackChannelId`, `whatsappAllowedJid`, `zohoCliqChatId`) from config.json, and removes the 12 channel env vars from .env. The early-return guard makes it idempotent — pinned by the test asserting .env contents and mtimeMs are unchanged on a second mutation.
- Exported `parseEnvFile` and `writeEnvFile` from `src/dashboard/routes/settings.ts` (the canonical writer-router) and imported them in heads.ts — no duplicate env tooling.
- 20 new tests in heads.test.ts (11 POST/DELETE/lazy-migration + 9 PATCH); total 25 pass.

## Task Commits

Each task pair committed atomically as RED then GREEN per the TDD discipline in the plan:

1. **Task 1 (already complete from prior executor session):** `af43269` (feat) — `feat(33-04): refactor heads router to deps-object + masked channels (D-16/D-17)`
2. **Task 2 RED:** `8a5e655` (test) — `test(33-04): add failing tests for POST /api/heads + DELETE + lazy migration`
3. **Task 2 GREEN:** `5e93915` (feat) — `feat(33-04): implement POST + DELETE /api/heads with D-04 lazy migration`
4. **Task 3 RED:** `152757b` (test) — `test(33-04): add failing tests for PATCH /api/heads/:id rename`
5. **Task 3 GREEN:** `35d568c` (feat) — `feat(33-04): implement PATCH /api/heads/:id rename with 3-table atomic UPDATE`

## Files Created/Modified

### Modified
- `src/dashboard/routes/heads.ts` — Added POST + DELETE + PATCH handlers (~150 new lines); added module-level constants `HEAD_ID_REGEX`, `RESERVED_HEAD_IDS`, `CHANNEL_ENV_KEYS`, `FLAT_CHANNEL_CONFIG_KEYS`; added private helpers `loadConfigJsonInline` and `materializeLazyMigrationIfNeeded`. Imports `transaction` from `db/index.js`, `parseEnvFile`+`writeEnvFile` from `./settings.js`, and `writeFileAtomic` from `write-file-atomic`.
- `src/dashboard/routes/heads.test.ts` — Added 2 new describe blocks: `POST/DELETE /api/heads (DASH-03)` (11 tests) and `PATCH /api/heads/:id (DASH-03 rename, D-14)` (9 tests). New `MutFixture` interface with `setHeads()` mutator for tests that need to flip the resolved-heads view mid-test. New seed helpers (`seedMessage`, `seedQueue`, `seedAppState`, `appStateValue`, `queueCount`) shared via copy-paste across the two describe blocks (single-file scope, no cross-test pollution).
- `src/dashboard/routes/settings.ts` — Added `export` keyword to `parseEnvFile` and `writeEnvFile` so heads.ts can import them. No behavior change.

## Decisions Made

- **Export parseEnvFile/writeEnvFile from settings.ts** (rather than inlining a copy in heads.ts): the plan offered both as valid options; export was cleaner and respects the codebase principle that env file format handling — quoting, escape sequences, mode 0o600 file permission — lives in exactly one place.
- **`materializeLazyMigrationIfNeeded` called from every mutating handler** (POST + DELETE + PATCH): the idempotency early-return guard (heads[].length > 0) makes this safe; the test `lazy migration is idempotent` pins the contract via `.env` byte-equality AND `fs.statSync().mtimeMs` equality, so any refactor that drops the early-return fails the test.
- **20ms `setTimeout` in the idempotency test**: forces enough real time between the first write and the second POST that a faulty refactor that re-writes .env would change mtimeMs. Without the wait, mtimeMs could appear equal even after a real write due to sub-millisecond filesystem resolution.
- **PATCH returns 500 on transaction failure** (not 400): the inputs were valid; the failure is server-side. The rollback test only asserts non-200, allowing future refinement of the exact status without churning the test.
- **Monkey-patch `db.prepare` for the rollback test** (not the inner callback): routing the throw through `deps.db.prepare()` more closely mirrors a real SQLite error from the driver — the transaction wrapper sees the failure exactly the way it would in production.

## Deviations from Plan

### Auto-fixed Issues

**None.** Plan executed exactly as written. The only optional optimization called out in the plan (Task 2 step 3: "export parseEnvFile from settings.ts and import here") was applied as the chosen path.

### Threat-flag scan

No new security-relevant surface beyond what the plan's `<threat_model>` already enumerated. All inputs use `HEAD_ID_REGEX` validation; all SQL goes through `db.prepare(...).run(param)` with bound parameters; config.json writes go through `writeFileAtomic`; every handler is wrapped with `requireAuth`. The `grep -E 'prepare\\(\`[^\`]*\\$\\{'` SQL-interpolation audit returns nothing (verified).

## Issues Encountered

- **Resume-from-mid-plan context:** The prior executor session crashed during Task 2 with an API Internal Server Error. Verified Task 1's commit (`af43269`) was intact and the working tree was clean against HEAD before resuming. No partial Task 2 scaffolding was present (it was stashed and discarded by the orchestrator before this session started).
- **None blocking** otherwise. The test fixture's `MutFixture` had to expose `setHeads()` to satisfy a future test that needs to flip the resolved-heads view mid-call — even though no current test in this plan uses it, it makes the fixture forward-compatible for Plan 05's channel sub-resource tests.

## User Setup Required

None — no external service configuration required. The lazy-migration path means existing single-head deployments continue to work; the first time a user creates/renames/deletes a head from the new UI, the migration runs transparently.

## Next Phase Readiness

- **Plan 05 (heads channels sub-resource):** ready — the writer pattern (`validate -> materializeLazyMigrationIfNeeded -> loadConfigJsonInline -> mutate -> writeFileAtomic`) is established. Plan 05 adds POST/PATCH/DELETE under `/api/heads/:id/channels` following the same shape with a deeper path into config.json.
- **Plan 06 (heads tab frontend):** ready — the backend write surface for create/rename/delete is functional end-to-end; the frontend can call these endpoints directly via the existing `api.*` pattern in `dashboard/src/lib/api.ts`.
- **Plan 07 (typed confirmation delete):** ready — DELETE /api/heads/:id is server-side-enforced (default non-deletable + transaction wipe); Plan 07 adds the typed-confirmation friction in the React modal but the actual destructive control is already correct at the server.

No blockers.

## Self-Check: PASSED

Verified the following commits exist:
- `af43269` (Task 1 — prior session) — FOUND
- `8a5e655` (Task 2 RED) — FOUND
- `5e93915` (Task 2 GREEN) — FOUND
- `152757b` (Task 3 RED) — FOUND
- `35d568c` (Task 3 GREEN) — FOUND

Verified plan acceptance criteria (all grep checks):
- `grep -q "router.post('/', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "router.delete('/:id', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "router.patch('/:id', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "HEAD_ID_REGEX" src/dashboard/routes/heads.ts` — PASS
- `grep -q "materializeLazyMigrationIfNeeded" src/dashboard/routes/heads.ts` — PASS
- `grep -q "transaction(deps.db, () =>" src/dashboard/routes/heads.ts` — PASS
- `grep -q "deleteAllForHead" src/dashboard/routes/heads.ts` — PASS (called for both messages and queue)
- `grep -q "DELETE FROM app_state WHERE key LIKE" src/dashboard/routes/heads.ts` — PASS
- `grep -q "the default head cannot be deleted" src/dashboard/routes/heads.ts` — PASS
- `grep -q "UPDATE messages SET head_id" src/dashboard/routes/heads.ts` — PASS
- `grep -q "UPDATE queue_events SET head_id" src/dashboard/routes/heads.ts` — PASS
- `grep -q "UPDATE app_state SET key" src/dashboard/routes/heads.ts` — PASS
- `grep -q "substr(key" src/dashboard/routes/heads.ts` — PASS
- `grep -q "idempotent" src/dashboard/routes/heads.test.ts` — PASS
- `grep -c "PATCH" src/dashboard/routes/heads.test.ts` — 12 (≥ 7 required)
- `grep -E 'prepare\\(\`[^\`]*\\$\\{' src/dashboard/routes/heads.ts` — returns nothing (no SQL string interpolation)

Verified the test suite:
- `npx tsc --noEmit` — exit 0 (whole-tree green)
- `npx vitest run src/dashboard/routes/heads.test.ts` — 25/25 tests pass
- `npx vitest run src/dashboard/` — 105/105 tests pass across 8 test files

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
