---
phase: 15-re-enable-preference-steward-with-dashboard-toggle
plan: "02"
subsystem: dashboard-settings
tags: [stewards, settings-api, dashboard, config]
dependency_graph:
  requires: [15-01]
  provides: [dashboard-steward-toggles, settings-api-flags]
  affects: [dashboard/src/pages/settings, src/dashboard/routes/settings.ts]
tech_stack:
  added: []
  patterns: [registry-iteration, diff-only-PUT-body, bool-helper-GET-pattern]
key_files:
  created: []
  modified:
    - src/head/steward-registry.ts
    - dashboard/src/pages/settings/stewards-registry.ts
    - dashboard/src/pages/settings/draft.tsx
    - dashboard/src/types/api.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/settings.test.ts
    - docs/internals/stewards.md
decisions:
  - "preferenceSteward placed in stable section (no experimental flag), defaultOn: true"
  - "spawnSteward and actionComplianceSteward placed in experimental section, defaultOn: false"
  - "Three new keys added to CONFIG_JSON_FIELDS (not ENV_KEY_ALLOWLIST — they are config.json flags)"
  - "StewardsTab.tsx and ExperimentalTab.tsx not modified — registry iteration auto-populates cards (D-12)"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-21"
  tasks_completed: 3
  files_modified: 7
---

# Phase 15 Plan 02: Dashboard Steward Toggles Summary

Surface three stewards wired in Plan 01 (preferenceSteward, spawnSteward, actionComplianceSteward) through the dashboard Settings UI and GET/PUT /api/settings API by updating five lockstep layers: server registry, dashboard registry, draft state, API types, and settings router.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Mirror three StewardDescriptor entries in both registries | 6e524fc | src/head/steward-registry.ts, dashboard/src/pages/settings/stewards-registry.ts |
| 2 | Wire new flags through DraftState and SettingsData types | 7fee639 | dashboard/src/pages/settings/draft.tsx, dashboard/src/types/api.ts |
| 3 | Extend settings.ts CONFIG_JSON_FIELDS + GET handler; update test factory and docs | 88f838c | src/dashboard/routes/settings.ts, src/dashboard/routes/settings.test.ts, docs/internals/stewards.md |

## What Was Built

### Six descriptor blocks added (three per registry)

**Stable section** (in both `src/head/steward-registry.ts` and `dashboard/src/pages/settings/stewards-registry.ts`), after the `bootstrap` entry:
- `id: 'preference'`, `configKey: 'preferenceStewardEnabled'`, `defaultOn: true`, no `experimental` flag

**Experimental section** (in both registries), after `messageAgent`:
- `id: 'spawn'`, `configKey: 'spawnStewardEnabled'`, `defaultOn: false`, `experimental: true`
- `id: 'actionCompliance'`, `configKey: 'actionComplianceStewardEnabled'`, `defaultOn: false`, `experimental: true`

All six descriptors are byte-identical on `id`, `configKey`, `label`, `description`, `defaultOn`, and `experimental` fields. Neither has `contextTokensKey` or `contextTokensRange`.

### Five dashboard-side layers updated

1. **SettingsData interface** (`dashboard/src/types/api.ts`): three new `boolean` fields after `bootstrapStewardEnabled`
2. **DraftState interface** (`dashboard/src/pages/settings/draft.tsx`): three new `boolean` fields after `bootstrapStewardEnabled`
3. **initDraft()**: copies all three from `s` to draft
4. **isDirty()**: returns `true` when any of the three differs between draft and saved state
5. **buildBody()**: includes each in the PUT body only when it differs from saved state (diff-only pattern)

### Three settings.ts changes

1. **CONFIG_JSON_FIELDS Set**: `'preferenceStewardEnabled'`, `'spawnStewardEnabled'`, `'actionComplianceStewardEnabled'` inserted after `'bootstrapStewardEnabled'` — governs which keys PUT /api/settings writes to workspace config.json
2. **GET handler**: three `bool('<field>', config.<field>)` lines after `bootstrapStewardEnabled` — returns correct defaults from Config, workspace override wins
3. **makeTestConfig() factory**: three defaults added (`preferenceStewardEnabled: true`, `spawnStewardEnabled: false`, `actionComplianceStewardEnabled: false`) to keep `as Config` cast accurate

### Two new vitest cases

- `'returns the three Phase 15 steward flags with config-derived defaults'` — asserts GET returns `preferenceStewardEnabled: true`, `spawnStewardEnabled: false`, `actionComplianceStewardEnabled: false` with empty workspace config.json
- `'workspace config.json override wins for preferenceStewardEnabled (regression: Phase 13 pattern)'` — writes `{preferenceStewardEnabled: false}` to workspace config.json and asserts GET reflects it

### docs/internals/stewards.md sentence update

Line 24 changed from:
> Only `bootstrapSteward` is enabled by default today; the others are scaffolded and currently commented out of the default set.

To:
> `bootstrapSteward` and `preferenceSteward` are on by default; `spawnSteward` and `actionComplianceSteward` are in the default set but gated off — each has its own toggle in Settings → Stewards (or Experimental for the latter two).

## Confirmed NOT Modified

- `dashboard/src/pages/settings/StewardsTab.tsx` — 0 lines changed (D-12: registry iteration auto-populates)
- `dashboard/src/pages/settings/ExperimentalTab.tsx` — 0 lines changed (D-12: registry iteration auto-populates)
- `ENV_KEY_ALLOWLIST` in `src/config.ts` — 0 lines changed (D-10 correctly interpreted as CONFIG_JSON_FIELDS, not env allowlist)

## Verification Results

- `npx tsc --noEmit` (root): PASS
- `cd dashboard && npx tsc --noEmit`: PASS
- `npx vitest run src/dashboard/routes/settings.test.ts`: 14/14 tests PASS (including 2 new Phase 15 cases)
- All grep acceptance criteria met (2 occurrences each of the three field names in settings.ts)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All three flags are fully wired: server registry → dashboard registry → DraftState → SettingsData → initDraft → isDirty → buildBody → CONFIG_JSON_FIELDS → GET handler → workspace config.json persistence.

## Threat Flags

None. No new network endpoints, auth paths, or file access patterns beyond those covered in the plan's threat model (T-15-06 through T-15-10). CONFIG_JSON_FIELDS gate and `requireAuth` middleware unchanged.

## Self-Check: PASSED

- `src/head/steward-registry.ts` — FOUND (modified)
- `dashboard/src/pages/settings/stewards-registry.ts` — FOUND (modified)
- `dashboard/src/pages/settings/draft.tsx` — FOUND (modified)
- `dashboard/src/types/api.ts` — FOUND (modified)
- `src/dashboard/routes/settings.ts` — FOUND (modified)
- `src/dashboard/routes/settings.test.ts` — FOUND (modified)
- `docs/internals/stewards.md` — FOUND (modified)
- Commit 6e524fc — FOUND
- Commit 7fee639 — FOUND
- Commit 88f838c — FOUND
