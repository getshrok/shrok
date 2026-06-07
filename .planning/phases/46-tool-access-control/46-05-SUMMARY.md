---
phase: 46
plan: "05"
subsystem: tool-access-resolution
tags: [tool-access-control, resolveAllowlist, two-state, head-tools, agent-tools, config-defaults]
dependency_graph:
  requires: [resolveAllowlist, HEAD_TOOLS, HeadConfigSchema.headToolsOverride, HeadConfigSchema.agentToolsOverride, ConfigSchema.headToolDefaults, WorkerDefaultsSchema.allowedTools]
  provides: [two-state-resolveAllowlist, HEAD_TOOL_NAMES, headToolDefaults-explicit-default, enforcement-two-state]
  affects: [src/sub-agents/tool-access.ts, src/sub-agents/tool-access.test.ts, src/config.ts, src/config.test.ts, src/head/index.ts, src/head/enforcement.test.ts, src/system.ts]
tech_stack:
  added: []
  patterns: [two-state-optional-array, HEAD_TOOL_NAMES-derived-constant, resolveAllowlist-no-null-return, filter-expression-always-array]
key_files:
  created: []
  modified:
    - src/sub-agents/tool-access.ts
    - src/sub-agents/tool-access.test.ts
    - src/head/index.ts
    - src/config.ts
    - src/config.test.ts
    - src/head/enforcement.test.ts
    - src/system.ts
decisions:
  - "HEAD_TOOL_NAMES exported from src/head/index.ts as HEAD_TOOLS.map(t=>t.name) — single source of truth for the 10-name default; cannot drift"
  - "resolveAllowlist return type changed from string[]|null to string[]; legacy null in either param treated as absent (fall-through), never as all-tools"
  - "headToolDefaults.allowedTools schema default changed from null to HEAD_TOOL_NAMES (10 names); empty config resolves to exactly the 10 head tools"
  - "system.ts: headDefaultPool computed as Array.isArray(config.headToolDefaults.allowedTools) ? config.headToolDefaults.allowedTools : HEAD_TOOL_NAMES for legacy-null resilience"
  - "effectiveHeadTools uses HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name)) always — no null/HEAD_TOOLS short-circuit branch"
  - "enforcement.test.ts reshaped: removed two null=all-tools tests; added no-config-head=10-tools, subset-removes-spawn_agent, no-config-agent=25-tools-array, legacy-null-normalizes tests"
metrics:
  duration: "8 min"
  completed: "2026-06-07"
  tasks: 3
  files: 7
---

# Phase 46 Plan 05: Two-State Resolver + Explicit Defaults Summary

Two-state resolver, explicit head defaults, and enforcement tests that prove no-config behavior is identical to pre-feature.

## What Was Built

### Task 1: resolveAllowlist simplified to two-state (cfb5583)

Rewrote `resolveAllowlist` in `src/sub-agents/tool-access.ts`:

- **Return type**: `string[]` (never `null`). Downstream callers need no null branch.
- **Two-state logic**: `Array.isArray(perHeadOverride)` wins; else `Array.isArray(globalDefault)` wins; else `[]`.
- **Legacy tolerance (D-05)**: `null` in either argument falls through (treated same as absent). Never encodes "all tools."
- **Tests** (11 total): override-array-wins, global-fallback, both-absent→[], legacy-null-override→fallthrough, legacy-null-global→[], empty-array-override, return-type-never-null.

### Task 2: headToolDefaults defaults to HEAD_TOOL_NAMES (9d067bc)

- Added `export const HEAD_TOOL_NAMES: string[]` to `src/head/index.ts` (derived: `HEAD_TOOLS.map(t => t.name)` — cannot drift from source of truth).
- Imported `HEAD_TOOL_NAMES` into `src/config.ts`; changed `headToolDefaults.allowedTools` Zod default from `null` to `HEAD_TOOL_NAMES`.
- Empty config now resolves head layer to the 10 head-executable tool names (TOOLCFG-07 / D-06).
- **Tests** added to `src/config.test.ts`: empty config → 10 names, every default name is in HEAD_TOOL_NAMES, count matches HEAD_TOOLS.length, inherit-state regression lock.

### Task 3: system.ts enforcement reshaped; enforcement tests reshaped (e0ff653)

- Imported `HEAD_TOOL_NAMES` into `src/system.ts`.
- Added `headDefaultPool` computation (handles legacy null on the schema field for resilience).
- Removed `resolvedHeadTools === null ? HEAD_TOOLS :` branch — `effectiveHeadTools` is now always `HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name))`.
- Updated JSDoc for `headToolsOverride`/`agentToolsOverride` (drop "null = all tools" language).
- `src/head/enforcement.test.ts` reshaped: removed the two tests asserting null=all-tools; added 7 tests covering the two-state model across both layers.

## HEAD_TOOL_NAMES Location

The derived constant for the 10 head-tool names lives at:

```
src/head/index.ts — export const HEAD_TOOL_NAMES: string[]
```

This is the canonical location consumed by:
- `src/config.ts` — as `headToolDefaults.allowedTools` Zod default
- `src/system.ts` — as the `headDefaultPool` fallback in `buildSystem`
- `src/dashboard/routes/tools.ts` (46-06) — for per-layer tag registry filtering

## Verification Results

- `npx vitest run src/sub-agents/tool-access.test.ts` — 11/11 passed
- `npx vitest run src/config.test.ts` — 67/67 passed
- `npx vitest run src/head/enforcement.test.ts` — 7/7 passed
- `npx vitest run src/system.test.ts` — 6/6 passed
- `npx tsc --noEmit` — clean

## Deviations from Plan

None. Plan executed exactly as written.

## Known Stubs

None. All resolution logic is wired end-to-end.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries introduced. This plan is purely internal resolver logic and schema defaults — no new surface.

## Self-Check: PASSED

- `src/sub-agents/tool-access.ts` — exists and exports `resolveAllowlist` returning `string[]`
- `src/head/index.ts` — exports `HEAD_TOOL_NAMES`
- `src/config.ts` — imports `HEAD_TOOL_NAMES`, uses as headToolDefaults default
- `src/system.ts` — no `resolvedHeadTools === null` branch
- Commits cfb5583, 9d067bc, e0ff653 — all present in git log
