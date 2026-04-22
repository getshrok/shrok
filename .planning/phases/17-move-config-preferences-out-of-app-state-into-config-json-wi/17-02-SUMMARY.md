---
phase: 17
plan: "02"
subsystem: config,activation,dashboard
tags: [config, activation, dashboard, migration]
dependency_graph:
  requires: [17-01]
  provides: [per-event loadConfig in handleEvent, flat vis* fields in SettingsData/DraftState, updateUserConfig in ~debug/~xray]
  affects: [src/head/activation.ts, src/head/commands.ts, src/db/app_state.ts, src/dashboard/routes/settings.ts, dashboard/src/types/api.ts, dashboard/src/pages/settings/draft.tsx, dashboard/src/pages/settings/GeneralTab.tsx, dashboard/src/pages/settings/SettingsModal.tsx, dashboard/src/pages/ConversationsPage.tsx]
tech_stack:
  added: []
  patterns: [per-event loadConfig(), updateUserConfig for slash command persistence, flat vis* fields in SettingsData]
key_files:
  created: []
  modified:
    - src/head/activation.ts
    - src/head/commands.ts
    - src/db/app_state.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/settings.test.ts
    - src/head/activation.test.ts
    - src/head/head.test.ts
    - tests/unit/commands.test.ts
    - dashboard/src/types/api.ts
    - dashboard/src/pages/settings/draft.tsx
    - dashboard/src/pages/settings/GeneralTab.tsx
    - dashboard/src/pages/settings/SettingsModal.tsx
    - dashboard/src/pages/ConversationsPage.tsx
decisions:
  - "Visibility adaptor object pattern used at activation.ts line ~706 — keeps downstream visibility.X consumer lines unchanged while sourcing from config.vis*"
  - "this.opts.config.workspacePath kept as-is inside handleEvent — path fields do not mutate per event"
  - "Third PUT roundtrip test in settings.test.ts skipped — existing CONFIG_JSON_FIELDS loop coverage for other fields provides sufficient indirect coverage; the two mandatory tests (GET defaults + override) were added"
  - "handleScheduleTrigger's this.opts.config.* references left unchanged — that method has its own lifecycle and was not in scope"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-22"
  tasks_completed: 6
  files_modified: 13
---

# Phase 17 Plan 02: Atomic Cut-over — Visibility/Footers from app_state to config.json

Complete atomic migration of all ConversationVisibility and usageFootersEnabled reads/writes from SQLite app_state to config.json, with per-event loadConfig() in ActivationLoop so dashboard toggles take effect without restart.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Per-event loadConfig in ActivationLoop; swap visibility source | af6057a | src/head/activation.ts, activation.test.ts, head.test.ts |
| 2 | Delete visibility/footers methods from AppStateStore and db.test.ts | 851b7de | src/db/app_state.ts, src/db/db.test.ts |
| 3 | Rewire dashboard settings router | 059d961 | src/dashboard/routes/settings.ts, settings.test.ts |
| 4 | Rewrite ~debug and ~xray slash commands | 2618570 | src/head/commands.ts, tests/unit/commands.test.ts |
| 5 | Flatten dashboard SettingsData type and update UI consumers | f5fc142 | dashboard/src/types/api.ts, draft.tsx, GeneralTab.tsx, SettingsModal.tsx, ConversationsPage.tsx |
| 6 | Full repo verification — tsc, vitest, dashboard build | 8a90327 | dashboard/dist/ (rebuilt) |

## What Was Built

### Task 1 — Per-event loadConfig in ActivationLoop

Added `const config = loadConfig()` as the first statement after `timingMark` in `handleEvent`, before the `schedule_trigger` early return. Changed import from `import type { Config }` to `import { loadConfig, type Config }`.

Swapped all behavioral `this.opts.config.*` references inside `handleEvent` to the local `config` variable:
- `routingStewardEnabled`, `agentContinuationEnabled`, `stewardModel` (routing steward path)
- `scheduledRelayStewardEnabled`, `timezone`, `stewardModel` (relay steward path)
- `relaySummary`, `stewardModel` (work-summary steward)
- `contextRelevanceStewardEnabled`, `stewardModel` (context-relevance steward)
- `headModel`, `stewardModel`, `headRelaySteward`, `headRelayStewardContextTokens` (tool loop opts)
- `loopSameArgsTrigger`, `loopErrorTrigger`, `loopPostNudgeErrorTrigger`, `loopSteward*` (loop controls)
- `stewardContextTokenBudget`, `bootstrapStewardEnabled`, `preferenceStewardEnabled`, `spawnStewardEnabled`, `actionComplianceStewardEnabled` (post-loop stewards)

Visibility adaptor at line ~706:
```typescript
const visibility = {
  agentWork:        config.visAgentWork,
  headTools:        config.visHeadTools,
  systemEvents:     config.visSystemEvents,
  stewardRuns:      config.visStewardRuns,
  agentPills:       config.visAgentPills,
  memoryRetrievals: config.visMemoryRetrievals,
}
```

This keeps all downstream `visibility.X` consumer lines unchanged.

`this.opts.config.workspacePath` kept unchanged inside `handleEvent` (path field, does not mutate per event). `handleScheduleTrigger` left entirely unchanged — uses `this.opts.config.*` which is correct for that method's lifecycle.

Removed `getConversationVisibility` mocks from both `activation.test.ts` (line 162) and `head.test.ts` (line 562).

### Task 2 — AppStateStore deletions

Removed from `src/db/app_state.ts`:
- `export interface ConversationVisibility { ... }` (lines 6-13)
- `getConversationVisibility()` method with xray migration logic
- `setConversationVisibility()` method
- `getUsageFootersEnabled()` method
- `setUsageFootersEnabled()` method

Removed `describe('conversation visibility defaults', ...)` block (4 tests) from `src/db/db.test.ts`.

SQLite rows for `vis_agent_work`, `vis_head_tools`, etc. remain in the DB untouched — D-04 clean cut, no migration.

### Task 3 — Settings router rewired

Added 7 keys to `CONFIG_JSON_FIELDS`:
```typescript
'visAgentWork', 'visHeadTools', 'visSystemEvents', 'visStewardRuns',
'visAgentPills', 'visMemoryRetrievals', 'usageFootersEnabled',
```

GET handler now returns flat fields sourced from `bool('visAgentWork', config.visAgentWork)` etc. Deleted the entire `if (body['conversationVisibility'] || 'usageFootersEnabled' in body)` PUT block — the existing CONFIG_JSON_FIELDS loop handles the new flat fields automatically.

Two new regression tests added:
1. GET returns all 7 as false on fresh workspace; `conversationVisibility` is undefined
2. Workspace config.json override wins for `visAgentWork` and `usageFootersEnabled`

Third PUT roundtrip test skipped — existing CONFIG_JSON_FIELDS coverage for other fields is sufficient indirect coverage without new harness plumbing.

### Task 4 — Slash commands rewritten

`~debug` now reads `cfg.visAgentWork || cfg.visHeadTools || cfg.visSystemEvents || cfg.visStewardRuns` from `ctx.config` and writes via `updateUserConfig({ visAgentWork, visHeadTools, visSystemEvents, visStewardRuns }, cfg.workspacePath)`. `visAgentPills` intentionally not touched.

`~xray` reads `ctx.config.visAgentWork` and writes `{ visAgentWork: turnOn }` via `updateUserConfig`.

`~status` reads `c.vis*` from `ctx.config` directly for debug mode display.

`commands.test.ts` fully rewritten:
- Removed `makeAppState` and `ConversationVisibility` import
- Added `makeFakeConfig(overrides)` helper with 7 vis fields + workspacePath
- `~xray` and `~debug` tests use `beforeEach` tmpdir workspace and read `config.json` file to assert persistence
- `~status` tests pass vis flags via `config: makeFakeConfig({ visAgentWork: true, ... })`

### Task 5 — Dashboard types and UI flattened

`dashboard/src/types/api.ts`: Replaced `conversationVisibility: { agentWork, headTools, systemEvents, stewardRuns, agentPills, memoryRetrievals }` with 7 flat booleans `visAgentWork`, `visHeadTools`, `visSystemEvents`, `visStewardRuns`, `visAgentPills`, `visMemoryRetrievals`, `usageFootersEnabled`.

`draft.tsx`: DraftState, initDraft, isDirty, buildBody all updated for the 7 flat fields. `isDirty` now does 7 individual boolean comparisons instead of `JSON.stringify` on the nested object.

`GeneralTab.tsx`: categories array now directly maps `key: 'visAgentWork'` etc. to DraftState; `d[c.key]` replaces `vis[c.key]`; `set(c.key, ...)` replaces `setVis(c.key, ...)`.

`SettingsModal.tsx`: Dev-mode "turn all on" branch sets 6 flat fields directly instead of the nested object.

`ConversationsPage.tsx`: `const s = settings as SettingsData | undefined` + local `visibility` adaptor object reading `s?.visAgentWork` etc. Downstream `visibility.X` consumer lines (line ~819) unchanged.

### Task 6 — Full repo verification

- `npx tsc --noEmit` exits 0
- `npx vitest run` exits 0 — 1156 tests pass, 1 skipped (integration/tool-description)
- `npm --workspace dashboard run build` exits 0
- Zero grep hits for `ConversationVisibility|getConversationVisibility|setConversationVisibility|getUsageFootersEnabled|setUsageFootersEnabled|conversationVisibility` across src/, dashboard/src/, tests/unit/ (only hit: string literal in a test assertion)
- `grep -c "VIS_|USAGE_FOOTERS" src/config.ts` = 0 (vis fields not in ENV_KEY_ALLOWLIST)

## Deviations from Plan

### Auto-handled: Third PUT roundtrip test not added

**Found during:** Task 3
**Issue:** The existing test harness in `settings.test.ts` requires a `startWithConfig` helper that binds a single config at startup. Writing a PUT test that also verifies config.json on disk after the PUT would require either a second `startWithConfig` call or checking the workspace file directly — the harness supports this pattern but would add plumbing beyond the two mandatory tests.
**Fix:** Skipped the third test per the plan's guidance ("SKIP it and document the skip in SUMMARY.md — the behavior is covered by the CONFIG_JSON_FIELDS loop which already has coverage for other fields").
**Impact:** The PUT path for vis fields is covered indirectly by the existing channel sentinel tests that exercise the same CONFIG_JSON_FIELDS loop for other fields.

## Known Stubs

None — all seven vis* fields are wired end-to-end from config.json through the API, through SettingsData/DraftState, through the UI toggles, and back via PUT to config.json. No placeholder data.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns beyond what the plan's threat model covers (T-17-05 through T-17-11).

## Self-Check: PASSED

- FOUND: src/head/activation.ts (contains `const config = loadConfig()`)
- FOUND: src/db/app_state.ts (zero ConversationVisibility references)
- FOUND: src/dashboard/routes/settings.ts (contains visAgentWork in CONFIG_JSON_FIELDS and GET response)
- FOUND: src/head/commands.ts (contains updateUserConfig calls)
- FOUND: dashboard/src/types/api.ts (contains visAgentWork: boolean)
- FOUND: af6057a (Task 1 commit)
- FOUND: 851b7de (Task 2 commit)
- FOUND: 059d961 (Task 3 commit)
- FOUND: 2618570 (Task 4 commit)
- FOUND: f5fc142 (Task 5 commit)
- FOUND: 8a90327 (Task 6 dashboard dist rebuild)
