---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Multi-Head Support
status: verifying
stopped_at: Completed 33-07-typed-confirmation-delete-PLAN.md (phase 33 complete)
last_updated: "2026-05-13T21:21:04.377Z"
last_activity: 2026-05-13
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 19
  completed_plans: 19
  percent: 100
---

# Project State

## Current Position

Phase: 33 (multi-head-management-ui) — COMPLETE
Plan: 7 of 7 (complete)
Status: Phase complete — ready for verification
Last activity: 2026-05-13
Stopped at: Completed 33-07-typed-confirmation-delete-PLAN.md (phase 33 complete)

Progress: [██████████] 100% (19/19 plans complete; phase 33 done)

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-12)

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Phase 33 — multi-head-management-ui

## Accumulated Context

### Roadmap Evolution

- Phase 19–27 added during v1.2 milestone (voice pipeline, scheduling, agent history migration, frontmatter validation, env var rename)
- Phase 28 added: Add optional prompt parameter to memory functions
- Phase 29–32 added: v1.3 Multi-Head Support (data layer, core activation, adapter registry + config + startup, dashboard)
- Phase 33 added: Multi-head management UI — promoted DASH-F-01/F-03 from Future Requirements into active scope as DASH-03/04/05 (create/rename/delete heads from UI, manage channels per head incl. multiple-of-same-vendor, per-head Send routing)

### Key Architecture Decisions (v1.3)

- Head isolation via `head_id` column on `queue_events` and `messages` — not separate DBs
- All heads run in one Node process; SQLite WAL handles concurrency
- Default head = `'default'` for zero-config backward compatibility
- Memory, identity, and skills are shared across all heads by design
- Channel adapters extended to support multiple instances per vendor (keyed by distinct string IDs)
- `AppStateStore` keys namespaced as `{headId}:keyName` for per-head state isolation
- Phase 30 D-04: `'default'` literal at all remaining call sites (system.ts, index.ts, eval scripts)
- Phase 30 D-06: one `ChannelRouterImpl` per process via DI; CORE-04 regression test guards this contract
- Phase 33 D-WIDEN: `DashboardEvent.message_added` widened with required `headId` field in Plan 33-01 so Plan 03 only needs to widen the remaining per-head event types
- Phase 33 D-INJECTOR-HEADID: `InjectorImpl.headId` is a `private readonly` 2nd positional ctor arg — encodes the lifetime contract that head identity is fixed at construction
- Phase 33 D-TEST-RENAME: Renamed db.test.ts DATA-02 test to reflect that explicit headId is now required at the type level; the SQL DEFAULT path is unreachable from TypeScript callers

## Decisions (Phase 33)

- D-WIDEN: `DashboardEvent.message_added` widened with required headId in Plan 33-01
- D-INJECTOR-HEADID: `InjectorImpl.headId` is `private readonly` 2nd ctor arg
- D-TEST-RENAME: db.test.ts DATA-02 test renamed (explicit headId now required at type level)
- D-MAP-REQUIRED (Plan 33-02): `DashboardServerOptions.dashboardAdapters` is required (not optional) — empty map is a startup bug, not a valid state; defensive 503 kept for tests
- D-FALLBACK-FIRST (Plan 33-02): POST /send falls back to `dashboardAdapters.values().next().value` when body.headId is missing or unknown — preserves single-head behavior and avoids leaking the head list via 404
- D-FILTER-PURE-FN (Plan 33-03): `shouldDeliverStreamEvent` extracted as a pure function in `dashboard/src/hooks/streamFilter.ts` — testable under existing `environment: 'node'` vitest config (no jsdom, no @testing-library, no new devDependency); `useStream()` composes it as a one-line early-return gate at the top of the SSE callback
- D-SCOPE-MIN-CORRECT (Plan 33-03): per RESEARCH § A4 minimum-correct scope, only `message_added` and `typing` carry `headId` in `DashboardEvent` (grep -c "headId: string" src/dashboard/events.ts returns 2); `agent_*`/`steward_run_added`/`memory_retrieval` are explicitly NOT widened — their emit sites live in process-wide stores with no per-head context, and T-33-09 accepts the cross-head leakage
- D-HEADID-FROM-EVENT (Plan 33-03): inside `useStream`'s `message_added` handler, switched from `currentHeadIdRef.current` to `event.headId` for the cache key — the filter gate above guarantees they're equal for delivered events, making the ref a pure filter input rather than a head-identity resolver
- D-MIGRATION-IDEMPOTENT (Plan 33-04): `materializeLazyMigrationIfNeeded` runs before every mutating handler (POST/DELETE/PATCH); early-return guard makes it safe to call repeatedly. Test pins contract via .env byte-equality + fs.statSync().mtimeMs equality so a future refactor that drops the guard fails
- D-EXPORT-ENV-HELPERS (Plan 33-04): exported `parseEnvFile` + `writeEnvFile` from `src/dashboard/routes/settings.ts` rather than inlining a copy in heads.ts — keeps env file format handling (quoting, escape sequences, mode 0o600) in one place
- D-SUBSTR-ANCHORED (Plan 33-04): rename uses `UPDATE app_state SET key = ? || substr(key, oldId.length + 2) WHERE key LIKE 'old:%'` — anchored to the prefix so substrings of the old id later in the key are not mis-edited (vs REPLACE which would)
- D-PATCH-DEFAULT-REJECTED (Plan 33-04): PATCH on `default` returns 400 (mirrors DELETE policy per D-08). Rationale: rename of `default` would leave `heads[]` without a default entry, which `resolveHeads()` would re-synthesize on next restart — silent recovery is worse than rejecting
- D-CHANNEL-UNIQUENESS-HELPER (Plan 33-05): `collectAllChannelIds(heads, excludeChannelId?)` is the single point that enforces D-15 cross-head channel id uniqueness. Zod schema does not refine for uniqueness and `ChannelRouter.set` silently overwrites — without this helper, duplicate channel ids would silently clobber state across heads
- D-PATCH-MERGE-PRESERVATION (Plan 33-05): PATCH channel uses `for (const key of Object.keys(patch)) merged[key] = patch[key]` so only client-sent keys overwrite; absent keys preserve existing on-disk values (D-17 secret preservation). Empty-string secret falls through to Zod `min(1)` rejection — clearing is documented as delete-and-re-add for v1.3
- D-PATCH-VENDOR-INVARIANT (Plan 33-05): PATCH that changes vendor returns 400 'channel vendor cannot change — delete and re-add' BEFORE the Zod re-parse. Vendor change would break the discriminated-union shape (different required fields per vendor); explicit gate produces a clearer error than letting the merge fail Zod
- D-RENAME-IN-PATCH (Plan 33-05): Channel rename is handled inside PATCH (no separate `/rename` route). The body merge treats `{ id }` like any other field; cross-head uniqueness with self excluded runs only when `patch.id !== current channelId`. Keeps API surface minimal — Plan 06 UI can do everything via PATCH
- D-VENDOR-INLINE-STYLE (Plan 33-06): vendor color bands use inline `React.CSSProperties` objects (hex+alpha codes like `#5865F20d` / `#5865F2b3`) rather than Tailwind arbitrary classes — sidesteps purge without touching `tailwind.config.js` safelist; visually identical to ChannelsTab.tsx
- D-HEADS-NO-DRAFT (Plan 33-06): the Heads tab opts out of SettingsModal's draft + Save flow — each per-card mutation calls `onSaved()` directly so the RestartModal triggers after every change; multi-head changes are mandatory-restart per D-05 so batching has no value
- D-COMPONENT-SPLIT (Plan 33-06): three-component split (HeadsTab + HeadCard + ChannelRow) over a monolithic file — per Claude's Discretion in plan; isolates the per-channel pending-state machine (5 vendor variants) from head-level concerns
- D-LEGACY-CHANNELS-PRESERVED (Plan 33-06): `ChannelsTab.tsx` is unmounted from SettingsModal (D-03) but kept on disk as visual reference per CONTEXT.md; vendor color hex codes lifted into `vendor-theme.ts` as the canonical source
- D-OPTIONAL-CONFIRM-ID (Plan 33-07): confirmId on DELETE /api/heads/:id is OPTIONAL — checked only when present in body. Frontend modal always sends it; curl/scripts/no-body tests still work. Backward-compat preserved while giving the UI an audit-trail field
- D-CONFIRM-BEFORE-RESERVED (Plan 33-07): the confirmId mismatch check runs BEFORE the reserved-id check in DELETE /api/heads/:id. A malformed `DELETE /api/heads/default {confirmId: 'work'}` returns 'confirmId does not match' (the more specific error) rather than 'default cannot be deleted'
- D-MODAL-OWNS-QUERY (Plan 33-07): DeleteHeadModal holds its own useQuery(['heads', id, 'counts']) + useMutation rather than receiving counts via props. Counts must be fresh every time the modal opens; 1:1 mount-lifecycle matches data-lifecycle

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 33    | 01   | 14min    | 3     | 26    |
| 33    | 02   | 5min     | 3     | 4     |
| 33    | 03   | 3min     | 2     | 6     |
| 33    | 04   | 6min     | 3     | 3     |
| 33    | 05   | 4min     | 2     | 2     |
| 33    | 06   | 6min     | 3     | 7     |
| 33    | 07   | 5min     | 2     | 5     |
