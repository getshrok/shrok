---
phase: 33-multi-head-management-ui
plan: 05
subsystem: dashboard
tags: [multi-head, dashboard, channels, sub-resource, rest-api, tdd, DASH-04, secret-preservation, cross-head-uniqueness]

requires:
  - phase: 33-multi-head-management-ui
    plan: 04
    provides: "deps-object heads router pattern; HEAD_ID_REGEX; maskChannel(); loadConfigJsonInline(); materializeLazyMigrationIfNeeded()"
provides:
  - "POST /api/heads/:id/channels — add channel; kebab regex + cross-head uniqueness (D-15) + ChannelConfigSchema; returns masked channel (D-17); persists inline in config.json heads[].channels[] (D-18)"
  - "PATCH /api/heads/:id/channels/:channelId — edit channel; secret-preservation via key-presence merge (D-17); vendor invariant; rename triggers exclude-self uniqueness; final Zod safeParse on merged shape (T-33-06 mass-assignment mitigation)"
  - "DELETE /api/heads/:id/channels/:channelId — remove from heads[].channels[]; no DB cleanup needed (channels have no SQL rows of their own)"
  - "collectAllChannelIds(heads, excludeChannelId?) helper — sole D-15 enforcement point since Zod doesn't refine for uniqueness and ChannelRouter.set silently overwrites"
  - "20 new tests in heads.test.ts (8 POST channel + 9 PATCH channel + 3 DELETE channel) — total 45 in the file"
affects: [plan-06-heads-tab-frontend, plan-07-typed-confirmation-delete]

tech-stack:
  added: []
  patterns:
    - "Sub-resource handlers follow the Plan 04 writer pattern verbatim: validate -> materializeLazyMigrationIfNeeded -> loadConfigJsonInline -> mutate -> writeFileAtomic. Only the path into config.json is deeper (heads[idx].channels[]) — no new infrastructure"
    - "Secret-preservation via the settings.ts body-diff pattern: omitted fields preserve existing on-disk values. The `for (const key of Object.keys(patch)) merged[key] = patch[key]` loop only overwrites keys the client explicitly sent; absent keys (`!(field in body)`) keep their previous value"
    - "Vendor invariant enforced BEFORE the Zod re-parse — `if ('vendor' in patch && patch.vendor !== existing.vendor) return 400`. Without this gate, the merge would produce a malformed shape (wrong required fields for the new vendor) and Zod would reject with a less-clear error"
    - "T-33-06 mass-assignment defense-in-depth: the merge loop can copy arbitrary unknown keys, but the subsequent ChannelConfigSchema.safeParse(merged) narrows back to the discriminated-union shape — unknown keys are stripped from `parsed.data` before we write to disk"
    - "DELETE has no DB cleanup path — channels have no SQLite rows of their own (messages and queue_events are head-scoped, not channel-scoped; AppStateStore uses headId prefixes, not channel ids). Only config.json needs rewriting, so DELETE is materializeLazyMigrationIfNeeded + load + filter + writeFileAtomic"

key-files:
  created: []
  modified:
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts

key-decisions:
  - "Channel rename support added in PATCH (not deferred): the plan's Test 9 + Test 10 require exclude-self uniqueness behaviour and cross-head collision rejection. Rather than a separate route, the existing PATCH body merge handles `{ id }` as just another field; the cross-head uniqueness gate runs only when `patch.id !== channelId`. This keeps the API surface minimal — Plan 06's UI can do everything via PATCH with no special-case rename endpoint"
  - "Empty-string body field (e.g., `{ chatId: '' }`) falls through to Zod's `z.string().min(1)` which rejects 400 — explicit clear is documented as 'delete and re-add' in the plan. This matches the v1.3 silence on clearing secrets (CONTEXT.md does not call out a 'clear' path); a future Phase could add a literal null sentinel if users complain"
  - "DELETE does NOT require the head to be in resolveCurrentHeads() (skips that lookup) — it goes straight to materialize + load + filter. The 404 fires from the findIndex on config.json's heads[]. Rationale: the lazy migration path is idempotent and produces an authoritative on-disk heads[]; checking against resolveCurrentHeads() would be redundant. POST and PATCH still check resolveCurrentHeads() first because they pass `targetHead.channels` to the uniqueness check; DELETE has no such pre-write read"
  - "All three handlers use the same nested route shape from D-16: `/:id/channels` for the collection and `/:id/channels/:channelId` for the single item. The mount under `/api/heads` in DashboardServer means full paths are `/api/heads/:id/channels[/:channelId]` — matches the D-16 spec verbatim"
  - "No new helper exports — collectAllChannelIds is a module-private function. The cross-head uniqueness check is the only consumer; exposing it would invite premature reuse before a second caller exists"

patterns-established:
  - "Sub-resource handlers as continuation of the parent router's deps-object pattern: same factory function, same deps interface, same materialize + load + mutate + write contract. Future per-head sub-resources (e.g., per-head schedules in a hypothetical future phase) follow the same shape"
  - "Discriminated-union edit via merge-then-revalidate: the PATCH handler merges first (preserving omitted fields), then runs Zod's safeParse on the merged shape. This pattern works for ANY discriminated union where the discriminant field is immutable — copy-paste to future tagged-union editors (e.g., editing a skill's frontmatter where `kind: 'skill' | 'task'` is fixed)"

requirements-completed: [DASH-04]

duration: 4min
completed: 2026-05-13
---

# Phase 33 Plan 05: Heads Channels Sub-resource Summary

**The channel sub-resource ships — POST/PATCH/DELETE under `/api/heads/:id/channels[/:channelId]` complete the DASH-04 backend. Cross-head uniqueness (D-15) is enforced by the single new `collectAllChannelIds` helper; secret-preservation (D-17) is enforced by the key-presence merge pattern; inline persistence (D-18) reuses Plan 04's writer chain. Multi-of-same-vendor verified: two telegram channels with distinct kebab ids round-trip cleanly through POST and persist to `heads[].channels[]`. 45/45 heads.test.ts tests pass; 125/125 dashboard tests pass; tsc green.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-13T20:54:56Z
- **Completed:** 2026-05-13T20:58:53Z
- **Tasks:** 2 (POST channel; PATCH+DELETE channel)
- **Files modified:** 2 (heads.ts, heads.test.ts)
- **New tests:** 20 (8 POST + 9 PATCH + 3 DELETE) — total 45 in heads.test.ts

## Accomplishments

- **POST /api/heads/:id/channels** validates in order: head exists (404), `body.id` matches `HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/` (400), cross-head uniqueness via `collectAllChannelIds(current)` (400 'already in use'), full `ChannelConfigSchema.safeParse` (400 with Zod error). On success: lazy migration runs, fresh config.json is read, channel pushed to `heads[idx].channels[]`, `writeFileAtomic` persists, response is `{ ok: true, channel: maskChannel(channel) }`.
- **PATCH /api/heads/:id/channels/:channelId** preserves omitted secrets via the merge loop `for (const key of Object.keys(patch)) merged[key] = patch[key]` — only keys the client explicitly sent overwrite. Vendor change is rejected with 400 'channel vendor cannot change — delete and re-add'. Channel-id rename triggers `HEAD_ID_REGEX` validation + `collectAllChannelIds(current, channelId)` (exclude-self). Final `ChannelConfigSchema.safeParse(merged)` runs the discriminated-union narrowing, which strips unknown keys (T-33-06 mass-assignment defense-in-depth).
- **DELETE /api/heads/:id/channels/:channelId** runs `materializeLazyMigrationIfNeeded` then filters `heads[idx].channels` by `c.id !== channelId`. If the length is unchanged, 404. Otherwise `writeFileAtomic` persists. No DB cleanup — channels have no SQLite rows; only config.json needs rewriting.
- **`collectAllChannelIds(heads, excludeChannelId?)` helper** is the single point that enforces D-15. The Zod schema doesn't refine for uniqueness, and `ChannelRouter.set` silently overwrites — without this helper, duplicate channel ids would silently clobber state across heads.
- **Multi-of-same-vendor (DASH-04) is structural** — the schema, route handlers, and tests all treat two telegram channels with distinct kebab ids as a first-class case. Verified by the 'POST adds a SECOND telegram channel to the same head' test which round-trips through POST and asserts `heads[0].channels` has both entries.
- **Secrets never appear in HTTP responses.** Every test asserts `expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN')` against the server's response body. The plaintext IS persisted to `config.json` (D-18 inline channels), but `maskChannel()` converts every secret to `{ isSet: bool }` before the response leaves the server.

## Task Commits

Two TDD task pairs, each committed RED → GREEN:

1. **Task 1 RED:** `88b3168` (test) — `test(33-05): add failing tests for POST /api/heads/:id/channels (DASH-04)` — 8 failing tests
2. **Task 1 GREEN:** `fe527c9` (feat) — `feat(33-05): implement POST /api/heads/:id/channels with D-15 cross-head uniqueness` — 33/33 pass
3. **Task 2 RED:** `e0eb62a` (test) — `test(33-05): add failing tests for PATCH + DELETE /api/heads/:id/channels/:channelId` — 12 failing tests
4. **Task 2 GREEN:** `aad5fa8` (feat) — `feat(33-05): implement PATCH + DELETE /api/heads/:id/channels/:channelId` — 45/45 pass

## Files Created/Modified

### Modified
- `src/dashboard/routes/heads.ts` — Added `ChannelConfigSchema` import from `../../config.js`; added `collectAllChannelIds(heads, excludeChannelId?)` module-private helper; added three new route handlers (POST `/:id/channels`, PATCH `/:id/channels/:channelId`, DELETE `/:id/channels/:channelId`) — ~140 new lines. No changes to existing handlers or helpers.
- `src/dashboard/routes/heads.test.ts` — Added two new `describe` blocks: `POST /api/heads/:id/channels (DASH-04 add channel)` (8 tests) and `PATCH/DELETE /api/heads/:id/channels/:channelId (DASH-04 edit + remove)` (12 tests). Each block has its own start/afterEach scaffold (mirroring the existing Plan 04 pattern) plus block-local `telegramFixture` and `seedWork` helpers.

## Decisions Made

- **Rename support is folded into PATCH** (not a separate `/rename` endpoint): the body merge handles `{ id }` like any other field, and the exclude-self uniqueness gate runs only when the new id differs from the current one. Keeps the route surface minimal.
- **Empty-string secret clearing falls through to Zod's `min(1)` rejection** — explicit clearing is documented as "delete and re-add" per the plan; v1.3 doesn't need a null-sentinel path.
- **DELETE skips the `resolveCurrentHeads()` pre-check** — the on-disk `findIndex` is the authoritative existence check after `materializeLazyMigrationIfNeeded`. POST and PATCH still pre-check because they consume `targetHead.channels` for uniqueness; DELETE doesn't need that data.
- **No new helper exports** — `collectAllChannelIds` is module-private. Only one caller per route handler.
- **Final `safeParse(merged)` after the body merge in PATCH** — this is the T-33-06 mass-assignment defense. The merge could copy unknown keys, but Zod narrows them away before `writeFileAtomic`.

## Deviations from Plan

### Auto-fixed Issues

**None.** Plan executed exactly as written. All `<action>` snippets in the plan transferred verbatim with only cosmetic JSDoc-comment additions. No surprises from prior plans — the Plan 04 deps-object refactor made every helper (`HEAD_ID_REGEX`, `maskChannel`, `loadConfigJsonInline`, `materializeLazyMigrationIfNeeded`) available with no additional plumbing.

### Threat-flag scan

No new security-relevant surface beyond the plan's `<threat_model>` already enumerated. Verified:
- All three handlers use `requireAuth` (T-33-01 mitigated)
- Every response goes through `maskChannel()` (T-33-02 mitigated; `grep -q maskChannel src/dashboard/routes/heads.ts` → match)
- `HEAD_ID_REGEX` validates ids; `ChannelConfigSchema.safeParse` validates the full shape (T-33-03 mitigated)
- `parsed.data` after the merge strips unknown keys (T-33-06 mitigated)
- Per-handler race protection: `materializeLazyMigrationIfNeeded + loadConfigJsonInline + findIndex` re-checks before write; if the head or channel disappeared mid-request, the handler 404s instead of writing stale data (T-33-12 mitigated)

No SQL-string interpolation introduced (channel routes don't touch the DB at all — T-33-05 accepted per the plan).

## Issues Encountered

- **None.** Both task pairs went from RED to GREEN on the first GREEN attempt. The 8 POST tests and the 12 PATCH/DELETE tests all passed after the handler implementations were added with no debugging cycle.

## User Setup Required

None — sub-resource is purely additive over Plan 04's writer chain. No new env vars, no new SQL migrations, no new external services. Existing deployments see no behavior change until they call the new endpoints.

## Next Phase Readiness

- **Plan 06 (heads tab frontend):** READY — the backend write surface for `add/edit/remove channel` is complete and matches the D-16 nested-REST spec. Frontend can call:
  - `POST /api/heads/:id/channels` with `{ id, vendor, ...credFields }` — returns `{ channel: { ..., <secret>: { isSet: true } } }`
  - `PATCH /api/heads/:id/channels/:channelId` with partial body — omitted secrets preserved
  - `DELETE /api/heads/:id/channels/:channelId` — returns `{ ok: true }`
- **Plan 07 (typed confirmation delete):** unblocked — Plan 07 is about the React typed-confirm modal for head deletion; this plan doesn't touch that surface.

No blockers.

## Self-Check: PASSED

Verified the following commits exist:
- `88b3168` (Task 1 RED) — FOUND
- `fe527c9` (Task 1 GREEN) — FOUND
- `e0eb62a` (Task 2 RED) — FOUND
- `aad5fa8` (Task 2 GREEN) — FOUND

Verified plan acceptance criteria (all grep checks):
- `grep -q "router.post('/:id/channels', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "collectAllChannelIds" src/dashboard/routes/heads.ts` — PASS
- `grep -q "ChannelConfigSchema.safeParse" src/dashboard/routes/heads.ts` — PASS
- `grep -q "maskChannel(channel)" src/dashboard/routes/heads.ts` — PASS
- `grep -q "router.patch('/:id/channels/:channelId', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "router.delete('/:id/channels/:channelId', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "channel vendor cannot change" src/dashboard/routes/heads.ts` — PASS
- `grep -q "for (const key of Object.keys(patch))" src/dashboard/routes/heads.ts` — PASS
- `grep -q "collectAllChannelIds(current, channelId)" src/dashboard/routes/heads.ts` — PASS
- `grep -q "maskChannel" src/dashboard/routes/heads.ts` — PASS

Verified test counts:
- 8 new POST channel `it(...)` blocks in heads.test.ts (≥ 8 required)
- 12 new PATCH/DELETE channel `it(...)` blocks in heads.test.ts (≥ 10 required)

Verified the test suite:
- `npx tsc --noEmit` — exit 0 (whole-tree green)
- `npx vitest run src/dashboard/routes/heads.test.ts` — 45/45 tests pass (33 + 12 new minus zero failures)
- `npx vitest run src/dashboard/` — 125/125 tests pass across 8 test files

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
