---
phase: 35-per-head-scheduling
plan: 02
subsystem: agent-tools+activation
tags: [scheduling, multi-head, agent-tools, reminder-fire, fallback-channel]

# Dependency graph
requires:
  - phase: 35-per-head-scheduling
    provides: Plan 35-01 — Schedule.headId required field on CreateScheduleOptions; ScheduleStore.list({ headId }) filter; lazy migration; ScheduleEvaluator per-event headId stamping
  - phase: 34-multi-head-agent-lifecycle
    provides: D-EXEC-OPTION (option-field pattern for required head identity), D-RUNNER-HEADID (LocalAgentRunner.headId is private readonly ctor field)
  - phase: 33-multi-head-management-ui
    provides: DashboardServerOptions.resolveCurrentHeads callback pattern (mirrored verbatim here for D-08)
provides:
  - buildScheduleTools / buildReminderTools require headId as factory arg; closure-captured into create_schedule / create_reminder createOpts
  - update_schedule explicit runtime reject when 'headId' is in input (D-10)
  - ToolSurfaceDeps.headId required field; threaded through LocalAgentRunner.toolSurfaceDeps()
  - ActivationLoopOptions.resolveCurrentHeads callback (Phase 35 D-08) — first-channel fallback dependency
  - Reminder fire path: last_active → head.channels[0] → skip+log (D-06 unchanged + D-07 new)
affects: [35-03-dashboard, 35-04-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory closure-capture for required head identity at agent-tool surface: buildScheduleTools/buildReminderTools take headId as a required factory arg; closure captures it; each head's tool registry binds its own copy. Mirrors Phase 34 D-EXEC-OPTION shape."
    - "Schema-level absence + runtime reject defense-in-depth: update_schedule omits headId from inputSchema.properties (primary defense) AND explicitly rejects 'headId' in input at runtime (defense-in-depth for clients that ignore schema)."
    - "Structural callback dependency over imported type: ActivationLoopOptions.resolveCurrentHeads uses `() => Array<{ id; channels: [{ id }] }>` rather than `() => ResolvedHead[]` — keeps the activation surface stable when ResolvedHead grows fields, and the reminder-fire site only needs .id and .channels[].id."

key-files:
  created:
    - .planning/phases/35-per-head-scheduling/35-02-SUMMARY.md
  modified:
    - src/sub-agents/registry.ts
    - src/sub-agents/tool-surface.ts
    - src/sub-agents/local.ts
    - src/sub-agents/agents.test.ts
    - src/sub-agents/tool-surface.test.ts
    - src/head/activation.ts
    - src/head/activation.test.ts
    - src/head/head.test.ts
    - src/system.ts
    - src/index.ts
    - tests/integration/head.test.ts
    - tests/scenarios/multi-message-batching.test.ts
    - tests/unit/activation.test.ts

key-decisions:
  - "D-09-FACTORY-CLOSURE-NO-DEFAULT (Plan 35-02): buildScheduleTools/buildReminderTools take headId as a REQUIRED factory arg with no default value. To preserve TypeScript's 'required after optional' rule, the existing default on `unifiedLoader: UnifiedLoader | null = null` was removed (`unifiedLoader: UnifiedLoader | null` — explicit pass required); both known callers (tool-surface.ts and 10 agents.test.ts call sites) supply it explicitly. Defaulting headId to 'default' would defeat the type-required safety net."
  - "D-10-SCHEMA-ABSENCE-PLUS-RUNTIME (Plan 35-02): update_schedule defends against headId reassignment in two layers — (a) absent from inputSchema.properties (primary; agents won't see it as a valid field), (b) explicit `if ('headId' in input)` runtime reject (defense-in-depth for clients that ignore schema). The check runs at the TOP of execute() before patch construction so no partial work happens."
  - "D-08-STRUCTURAL-CALLBACK (Plan 35-02): ActivationLoopOptions.resolveCurrentHeads uses a minimal structural type `() => Array<{ id; channels: [{ id }] }>` rather than importing ResolvedHead. Rationale: the reminder fire site only needs .id and .channels[].id; importing ResolvedHead would couple the activation interface to future ResolvedHead fields (e.g., Phase 36 may add per-head identity overrides) for no reading-side benefit. Matches the 'minimal contract' pattern used in DashboardEvent (Phase 33 D-SCOPE-MIN-CORRECT)."
  - "D-08-DEFAULT-CALLBACK (Plan 35-02): buildSystem supplies a default `() => [{ id: deps.headId ?? 'default', channels: [] }]` callback when SystemDeps.resolveCurrentHeads is omitted. The empty-channels return exercises the skip+log path (D-07 edge), preserving backward-compatible behavior for single-head hosts and tests that don't care about the fallback. The host (src/index.ts) supplies the real `() => resolveHeads(loadConfig())` for production multi-head."
  - "D-08-FRESH-PER-CALL (Plan 35-02): resolveCurrentHeads is called per-fire (not per-startup), so a dashboard edit between scheduler ticks lands without a process restart. Mirrors DashboardServerOptions.resolveCurrentHeads pattern verbatim. The 60s scheduler tick is coarse enough that re-reading config.json has no measurable cost."

patterns-established:
  - "Identity-first ordering in options interfaces: ToolSurfaceDeps.headId placed directly after skillLoader (the first field). Matches Phase 34 D-RUNNER-HEADID precedent. The convention is 'identity fields live at the top so spread-into-options doesn't bury them in grab-bag of behavioral toggles'."
  - "Fallback-before-proactive ordering in reminder fire branch: `let channel` is widened from const, the fallback resolves it BEFORE the proactive-decision block (lines 1090-1115). Proactive runs on the resolved channel regardless of which lookup path produced it — otherwise a head's first-channel fallback would never reach the proactive steward."

requirements-completed: []

# Metrics
duration: 13min
completed: 2026-05-14
---

# Phase 35 Plan 02: Agent Tool Surface + Reminder Fire Channel-Fallback Summary

**`buildScheduleTools` / `buildReminderTools` now require a `headId` factory arg; agent-created schedules and reminders inherit the spawning head's identity end-to-end. Reminder fire path falls back from `last_active_channel` to `head.channels[0].id` when last_active is null. `update_schedule` rejects headId reassignment.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-05-14T06:44:49Z
- **Completed:** 2026-05-14T06:57:31Z
- **Tasks:** 2 (both TDD; 4 commits total — 2 test + 2 feat)
- **Files modified:** 13 (1 created — 35-02-SUMMARY.md)

## Accomplishments

- **D-09 implemented**: `buildScheduleTools(scheduleStore, timezone, unifiedLoader, headId)` — 4th positional arg, required, no default. `buildReminderTools(scheduleStore, timezone, headId)` — 3rd positional, required, no default. Both inject `headId` from the factory closure into `CreateScheduleOptions` at `create_schedule` and `create_reminder` execute sites. `grep -c "headId" src/sub-agents/registry.ts` = 9 (signatures + comments + createOpts stamps + update_schedule check).
- **D-10 implemented**: `update_schedule` explicit runtime reject when `'headId' in input` returns `{ error: true, message: 'headId cannot be reassigned via update_schedule...' }`. Check runs at the TOP of execute() before patch construction. `inputSchema.properties` does NOT declare a `headId` key (primary defense). `grep -c "headId cannot be reassigned" src/sub-agents/registry.ts` = 1.
- **ToolSurfaceDeps.headId**: required `string` field added directly after `skillLoader` (identity-first ordering per Phase 34 D-RUNNER-HEADID convention). LocalAgentRunner.toolSurfaceDeps() threads `this.headId` into the deps object.
- **assembleTools wiring**: `buildScheduleTools(deps.scheduleStore, deps.timezone, deps.unifiedLoader ?? null, deps.headId)` and `buildReminderTools(deps.scheduleStore, deps.timezone, deps.headId)` — every agent's tool registry now binds its own head's identity.
- **D-06 verified unchanged**: src/head/activation.ts:1082 happy path `this.opts.appState.getLastActiveChannel(this.opts.headId)` is preserved. `let channel` widened from const so the fallback can assign.
- **D-07 implemented**: When `getLastActiveChannel` returns null, the fallback looks up `this.opts.resolveCurrentHeads().find(h => h.id === this.opts.headId)?.channels[0]?.id`. If found, `channel = firstChannelId` and the reminder fires there. If null/zero-channels, the existing skip+log behavior is preserved (one-time reminders still deleted, cron reminders stay enabled). Fallback runs BEFORE the proactive-decision block (D-13 + REM-XX uniform treatment).
- **D-08 implemented**: `ActivationLoopOptions.resolveCurrentHeads: () => Array<{ id; channels: [{ id }] }>` required field. `buildSystem` default callback returns single-head with empty channels (backward-compatible). src/index.ts production wiring: `() => resolveHeads(loadConfig())` so dashboard edits between scheduler ticks land without restart.
- **7 new tests** (3 in agents.test.ts + 4 in activation.test.ts):
  - `create_schedule injects the factory headId into ScheduleStore.create options` (headId: 'work')
  - `create_reminder injects the factory headId into ScheduleStore.create options` (headId: 'personal')
  - `update_schedule rejects headId reassignment with a clear error and does NOT call scheduleStore.update`
  - `update_schedule inputSchema does NOT declare a headId property`
  - Test A: happy path — last_active returns, enqueue uses it, resolveCurrentHeads NOT called
  - Test B: fallback fires — last_active null, falls back to head.channels[0].id
  - Test C: skip+log — last_active null AND head has zero channels, one-time reminder deleted
  - Test D: head not found — last_active null AND resolveCurrentHeads returns [], same skip+log
- **1434/1434 tests pass** across the full repo (was 1426 — +8 net new tests including the new schema-absence test); `npx tsc --noEmit` exits 0.

## Task Commits

1. **Task 1 RED — failing tests for headId factory injection + update_schedule reject** — `b759ba7` (test)
2. **Task 1 GREEN — buildScheduleTools/buildReminderTools require headId, update_schedule reject, ToolSurfaceDeps.headId, LocalAgentRunner threading** — `797b621` (feat)
3. **Task 2 RED — failing tests for D-07 reminder fire first-channel fallback** — `25f3f68` (test)
4. **Task 2 GREEN — ActivationLoopOptions.resolveCurrentHeads, fallback logic in handleScheduleTrigger, host wiring** — `fb3dfd4` (feat)

## Files Created/Modified

### Created
- `.planning/phases/35-per-head-scheduling/35-02-SUMMARY.md` — this file

### Modified
- `src/sub-agents/registry.ts` — `buildScheduleTools` signature gets 4th required `headId: string` arg (default removed from `unifiedLoader` to preserve required-after-optional ordering); `buildReminderTools` signature gets 3rd required `headId: string` arg; both `createOpts` literals stamp `headId` from closure; `update_schedule` execute() gets explicit `'headId' in input` reject at the top of the function
- `src/sub-agents/tool-surface.ts` — `ToolSurfaceDeps.headId: string` required field after `skillLoader`; `assembleTools` passes `deps.headId` into both factory calls
- `src/sub-agents/local.ts` — `toolSurfaceDeps()` threads `headId: this.headId` directly after `skillLoader`
- `src/sub-agents/agents.test.ts` — 10 existing `buildScheduleTools` call sites stamped with trailing `'default'`; 4 existing `buildReminderTools` call sites stamped with trailing `'default'`; `ToolSurfaceDeps` fixture stamped with `headId: 'default'`; 4 new it() blocks: factory headId injection on create_schedule (headId='work'), factory headId injection on create_reminder (headId='personal'), update_schedule reject with regex match + spy assertion that update NOT called, inputSchema absence assertion
- `src/sub-agents/tool-surface.test.ts` — `ToolSurfaceDeps` fixture stamped with `headId: 'default'`
- `src/head/activation.ts` — `ActivationLoopOptions.resolveCurrentHeads` required callback added with JSDoc explaining D-08 fresh-per-call pattern; reminder branch widens `channel` from const to let; fallback lookup with optional-chain `head?.channels[0]?.id` (noUncheckedIndexedAccess-safe); two log lines — info on fallback success, warn on no-configured-channels
- `src/head/activation.test.ts` — Fixture interface extended with `queueStore`, `appState`, `resolveCurrentHeads`; `makeFixture` accepts optional `lastActiveChannel` (default 'discord', pass null to exercise fallback) and `resolveCurrentHeads`; 4 new it() blocks under `describe('handleScheduleTrigger reminder branch — D-07 fallback', ...)`
- `src/head/head.test.ts` — ActivationLoop construction site passes `resolveCurrentHeads: () => []` (empty — preserves existing skip+log behavior in tests that don't care about the fallback)
- `src/system.ts` — `SystemDeps.resolveCurrentHeads?: () => Array<{ id; channels: [{ id }] }>` optional field; ActivationLoop construction passes `deps.resolveCurrentHeads ?? (() => [{ id: deps.headId ?? 'default', channels: [] }])` — the default keeps single-head/test hosts on the skip+log path
- `src/index.ts` — multi-head startup loop passes `() => resolveHeads(loadConfig())` so dashboard config edits between scheduler ticks land without restart
- `tests/integration/head.test.ts`, `tests/scenarios/multi-message-batching.test.ts`, `tests/unit/activation.test.ts` — ActivationLoop construction sites pass `resolveCurrentHeads: () => []` (mechanical update — these tests don't exercise the reminder branch with null last_active)

## Decisions Made

See key-decisions in frontmatter. Summary:

- **D-09-FACTORY-CLOSURE-NO-DEFAULT**: `headId` is a required factory arg with no default value. To preserve TypeScript's "required after optional" rule, removed the existing `= null` default on `unifiedLoader`. Both callers (tool-surface.ts and 10 agents.test.ts sites) supply `null` explicitly. Defaulting `headId` to `'default'` would defeat the type-required safety net.
- **D-10-SCHEMA-ABSENCE-PLUS-RUNTIME**: Two-layer defense — schema-level absence (primary; agents don't see `headId` as a valid field in update_schedule) + explicit runtime `if ('headId' in input)` check (defense-in-depth for clients that ignore schema). Check runs at the TOP of execute() before patch construction.
- **D-08-STRUCTURAL-CALLBACK**: `resolveCurrentHeads: () => Array<{ id; channels: [{ id }] }>` (minimal structural type) over `() => ResolvedHead[]` (full Phase 31 type). The reminder fire site only needs `.id` and `.channels[].id`; the minimal contract keeps the activation interface stable when ResolvedHead grows fields.
- **D-08-DEFAULT-CALLBACK**: `buildSystem` supplies a default callback returning `[{ id: deps.headId ?? 'default', channels: [] }]` when SystemDeps.resolveCurrentHeads is omitted. Single-head hosts and tests that don't care about the fallback land on the existing skip+log path. The host (src/index.ts) supplies the production `() => resolveHeads(loadConfig())`.
- **D-08-FRESH-PER-CALL**: Callback re-resolves per-fire (not per-startup) so dashboard edits between ticks land without restart. Mirrors DashboardServerOptions.resolveCurrentHeads pattern verbatim.

## Deviations from Plan

**None — plan executed exactly as written.**

The only work beyond the literal Action steps was mechanical fixture maintenance:
- `src/sub-agents/agents.test.ts:478` — top-level `getToolSurfaceDeps()` helper fixture needed `headId: 'default'` after the ToolSurfaceDeps interface change (Action step 5)
- `src/sub-agents/tool-surface.test.ts:80` — analogous top-level helper in the tool-surface dedicated test file
- `tests/unit/activation.test.ts:282` — second ActivationLoop construction site at line 256-283 (Action step 4 only mentioned line 71's site; this one is in the resume-path helper)
- `tests/scenarios/multi-message-batching.test.ts:131` — ActivationLoop construction site
- `tests/integration/head.test.ts:131` — ActivationLoop construction site

All are mechanical "add `resolveCurrentHeads: () => []`" or "add `headId: 'default'`" type-fillers. The `tests/` directory is excluded from `tsconfig.json` so these additions are runtime-only — vitest needs them only because the new option is required. Documented to keep the audit trail clean.

## Issues Encountered

None. The TDD cycle landed clean on both tasks:
- Task 1 RED: 3 failing tests as expected (factory headId not yet captured → headId === 'default'; update_schedule reject not yet implemented → returns 'not found' error)
- Task 1 GREEN: 81/81 tests pass; tsc reported 2 fixture errors that were resolved by adding `headId: 'default'` to the two top-level ToolSurfaceDeps fixtures
- Task 2 RED: 1 failing test (Test B — fallback fires); Tests A/C/D passed already because the current behavior happens to match (no fallback yet, so skip+log + happy path were both correct without changes); tsc reported the expected `resolveCurrentHeads does not exist in type ActivationLoopOptions` error
- Task 2 GREEN: all 14 activation tests pass; full 1434/1434 vitest passing

## Notes for Plan 35-03 (dashboard API)

- The storage layer (Plan 01) provides `ScheduleStore.list({ headId })` for cross-head filtering on `GET /api/schedules?headId=...` (D-12 future addition). The default cross-head list-all behavior is already correct.
- `POST /api/schedules` route at `src/dashboard/routes/schedules.ts:69` still has the `headId: 'default'` placeholder from Plan 01 with the inline comment pointing to Plan 03. Plan 03 needs to:
  - Validate `req.body.headId` against the heads loader (404 if unknown — mirrors POST `/send` from Phase 33 D-MAP-REQUIRED)
  - Replace the placeholder with `headId: req.body.headId`
  - Reject `headId` field on `PATCH /api/schedules/:id` (D-13 — mirrors agent-side D-10 reject pattern; the activation-side reject is at the agent tool surface, the dashboard-side reject is at the route handler)
- The new `resolveCurrentHeads` callback shape established here (D-08 structural) is the same shape `routes/schedules.ts` will need for headId validation. Consider re-using `DashboardServerOptions.resolveCurrentHeads` (it already exists per Phase 33) — no new wiring needed.

## Notes for Plan 35-04 (dashboard UI)

- D-14 (picker on create form): the existing head pill row from Phase 33 has the head list cached in the UI state; the create-schedule form just needs to expose the current selection as `body.headId` on POST.
- D-15 (Head column on list view): `ScheduleStore.list()` returns each row tagged with `headId` (Plan 01). The list-view table can render the `Head` column directly from `schedule.headId` with no new API plumbing.
- The fallback behavior (D-07) is invisible to the UI — reminders fire to a channel; the UI doesn't render which lookup-path produced the channel. No UI changes required for D-07/D-08.

## Threat Surface Scan

No new threat surface introduced beyond what the plan's `<threat_model>` (T-35-05 through T-35-08) already enumerates. All four threats have the mitigations specified by the plan in place:

- **T-35-05** (update_schedule headId reassignment): runtime reject + schema absence — both pinned by tests
- **T-35-06** (Spoofing — agent claiming headId='admin-head'): closure captures the spawning head's id; inputSchema for create_schedule/create_reminder do NOT declare a headId property; agent-provided headId in input is structurally ignored
- **T-35-07** (Information Disclosure via first-channel fallback): accept — user configured channels[0] knowing it would receive reminders for this head
- **T-35-08** (resolveCurrentHeads reads config.json each call): mitigate — user owns config.json; freshness prevents stale-cache attacks; reads within user's trust boundary

## Self-Check: PASSED

Verified before writing this section:
- `.planning/phases/35-per-head-scheduling/35-02-SUMMARY.md` exists (about to be written — FOUND after this Write completes)
- `src/sub-agents/registry.ts` contains `headId: string,` in both factory signatures (FOUND at lines 743 and 906)
- `src/sub-agents/registry.ts` contains "headId cannot be reassigned" message (FOUND at line 848)
- `src/sub-agents/tool-surface.ts` contains `headId: string` field (FOUND, 1 match)
- `src/sub-agents/local.ts` contains `headId: this.headId` (FOUND, 2 matches — toolSurfaceDeps + handleSpawnAgent)
- `src/head/activation.ts` contains `resolveCurrentHeads: () =>` (FOUND at line 99)
- `src/head/activation.ts` contains `this.opts.resolveCurrentHeads` (FOUND, 1 match in reminder branch)
- `src/head/activation.ts` contains `let channel` (FOUND, 1 match — widened from const)
- `src/head/activation.ts` contains `head?.channels[0]?.id` (FOUND at line 1094)
- `src/head/activation.ts` contains "head has no configured channels" log line (FOUND, 1 match)
- `src/system.ts` contains `resolveCurrentHeads` (FOUND, 2 matches — SystemDeps field + ActivationLoop construction)
- `src/index.ts` contains `resolveCurrentHeads` (FOUND, 2 matches — buildSystem call + existing DashboardServer call)
- `src/head/activation.test.ts` contains `resolveCurrentHeads: () =>` (FOUND, 4 matches — one per new test)
- Commit hashes exist in `git log`: b759ba7, 797b621, 25f3f68, fb3dfd4 (FOUND)
- `npx tsc --noEmit` exits 0 (PASSED)
- `npx vitest run` 1434/1434 passing (PASSED)

---
*Phase: 35-per-head-scheduling*
*Completed: 2026-05-14*
