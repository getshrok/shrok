---
phase: 15-re-enable-preference-steward-with-dashboard-toggle
plan: "01"
subsystem: config, steward-registry, activation-loop
tags: [stewards, config, activation, preference-steward, tdd]
dependency_graph:
  requires: []
  provides: [preferenceStewardEnabled-config-flag, spawnStewardEnabled-config-flag, actionComplianceStewardEnabled-config-flag, DEFAULT_STEWARDS-four-entries, activation-filter-four-clauses]
  affects: [src/config.ts, src/head/steward.ts, src/head/activation.ts]
tech_stack:
  added: []
  patterns: [z.coerce.boolean() config flag, activation filter s.name clause, TDD red-green]
key_files:
  created: []
  modified:
    - src/config.ts
    - src/head/steward.ts
    - src/head/activation.ts
    - src/config.test.ts
    - src/head/steward.test.ts
decisions:
  - "preferenceStewardEnabled defaults to true (user wants preference steward back on by default)"
  - "spawnStewardEnabled and actionComplianceStewardEnabled default to false (observe before enabling)"
  - "spawnStewardEnabled is distinct from existing spawnAgentStewardEnabled — both coexist in config"
  - "DEFAULT_STEWARDS order is fixed: [bootstrapSteward, preferenceSteward, spawnSteward, actionComplianceSteward]"
  - "preferenceSteward/spawnSteward/actionComplianceSteward remain module-local (not individually exported)"
metrics:
  duration_minutes: 8
  completed_date: "2026-04-21"
  tasks_completed: 2
  files_modified: 5
---

# Phase 15 Plan 01: Re-enable Preference Steward with Config Flags Summary

Backend wiring for three scaffolded-but-off stewards: preferenceStewardEnabled (default true), spawnStewardEnabled and actionComplianceStewardEnabled (both default false) added to ConfigSchema; DEFAULT_STEWARDS expanded to four entries; activation.ts filter extended with one clause per steward.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add three boolean steward toggles to ConfigSchema | cae7e01 | src/config.ts, src/config.test.ts |
| 2 | Add three stewards to DEFAULT_STEWARDS and filter clauses | 5db81c4 | src/head/steward.ts, src/head/steward.test.ts, src/head/activation.ts |

## What Was Built

### Three New Config Flags (src/config.ts)

Inserted immediately after `bootstrapStewardEnabled` in the `*StewardEnabled` cluster (lines 134-148):

- `preferenceStewardEnabled: z.coerce.boolean().default(true)` — nudges head to call `write_identity` when user stated a fact/preference; on by default per user's explicit request
- `spawnStewardEnabled: z.coerce.boolean().default(false)` — checks for missed spawn commitments; off by default pending observation
- `actionComplianceStewardEnabled: z.coerce.boolean().default(false)` — checks for missed spawns, hallucinated facts, computed answers; off by default (noisier)

`spawnStewardEnabled` is entirely distinct from existing `spawnAgentStewardEnabled` — both remain present and independent.

### DEFAULT_STEWARDS Final Order (src/head/steward.ts)

```typescript
export const DEFAULT_STEWARDS: Steward[] = [
  bootstrapSteward,
  preferenceSteward,
  spawnSteward,
  actionComplianceSteward,
]
```

Stale comment "deliberately left out of the default registry" removed and replaced with accurate description of the new reality.

### Four Filter Clauses in activation.ts (lines 972-981)

```typescript
const stewards = rawStewards.filter(s => {
  if (s.name === 'bootstrapSteward' && !this.opts.config.bootstrapStewardEnabled) return false
  if (s.name === 'preferenceSteward' && !this.opts.config.preferenceStewardEnabled) return false
  if (s.name === 'spawnSteward' && !this.opts.config.spawnStewardEnabled) return false
  if (s.name === 'actionComplianceSteward' && !this.opts.config.actionComplianceStewardEnabled) return false
  return true
})
```

### Prompt Files

No prompt files were modified. `preference.md`, `spawn.md`, and `action-compliance.md` are byte-identical to before this plan. (D-02 satisfied.)

### spawnStewardEnabled vs spawnAgentStewardEnabled

Both flags coexist in `src/config.ts`:
- `spawnAgentStewardEnabled` (line 128): gates depth-1 `spawn_agent` calls from sub-agents (existing, unchanged)
- `spawnStewardEnabled` (line 140): post-activation steward checking head for missed spawn commitments (new)

## Verification

- `npx tsc --noEmit` exits 0
- `npx vitest run src/head/ src/config.test.ts` — 102 tests pass (77 head/ + 25 config)
- All grep acceptance criteria satisfied (each returns count 1 where expected)
- `grep -c "deliberately left out" src/head/steward.ts` returns 0

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/config.ts modified: FOUND
- src/head/steward.ts modified: FOUND
- src/head/activation.ts modified: FOUND
- Commit cae7e01: FOUND
- Commit 5db81c4: FOUND
