---
phase: 46
plan: "01"
subsystem: config
tags: [tool-access-control, config-schema, tri-state, resolveAllowlist]
dependency_graph:
  requires: []
  provides: [resolveAllowlist, HeadConfigSchema.headToolsOverride, HeadConfigSchema.agentToolsOverride, ConfigSchema.headToolDefaults, ResolvedHead.headToolsOverride, ResolvedHead.agentToolsOverride]
  affects: [src/config.ts, src/sub-agents/tool-access.ts]
tech_stack:
  added: []
  patterns: [tri-state-optional-null-array, key-present-spread, exactOptionalPropertyTypes-safe-zod]
key_files:
  created:
    - src/sub-agents/tool-access.ts
    - src/sub-agents/tool-access.test.ts
  modified:
    - src/config.ts
    - src/config.test.ts
decisions:
  - "resolveAllowlist encodes tri-state as undefined=inherit, null=all, string[]=subset; returns null|string[]"
  - "HeadConfigSchema uses .nullable().optional() for both override fields — preserves absent/null/array distinction under exactOptionalPropertyTypes"
  - "resolveHeads() uses key-present spread for both override fields, mirroring the existing customPrompt pattern"
  - "headToolDefaults mirrors WorkerDefaultsSchema shape (allowedTools: nullable, default null)"
metrics:
  duration: "~2 min"
  completed: "2026-06-07"
  tasks_completed: 3
  files_changed: 4
---

# Phase 46 Plan 01: Config Schema + resolveAllowlist Foundation Summary

**One-liner:** Pure `resolveAllowlist` tri-state helper + Zod schema extensions for global head-tools default and per-head tool allowlist overrides, with inherit-state-as-absent-key regression lock.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create resolveAllowlist helper + 10 tri-state tests | abfe80e | tool-access.ts, tool-access.test.ts |
| 2 | Extend config schema + resolveHeads | 749ad31 | src/config.ts |
| 3 | Add config-level tri-state + resolveHeads threading tests | f4d19f0 | src/config.test.ts |

## What Was Delivered

### `src/sub-agents/tool-access.ts`

Exports a single pure function:

```typescript
export function resolveAllowlist(
  perHeadOverride: string[] | null | undefined,
  globalDefault: string[] | null | undefined,
): string[] | null
```

Resolution order: per-head override (if key present, including null) → global default → `null` (all tools).

### `src/config.ts` changes

- **`HeadConfigSchema`** extended with two optional-nullable fields (TOOLCFG-03, TOOLCFG-04):
  - `headToolsOverride: z.array(z.string()).nullable().optional()`
  - `agentToolsOverride: z.array(z.string()).nullable().optional()`
- **`ResolvedHead`** interface extended with `headToolsOverride?: string[] | null` and `agentToolsOverride?: string[] | null`
- **`ConfigSchema`** extended with `headToolDefaults` (TOOLCFG-01):
  - `headToolDefaults: z.object({ allowedTools: z.array(z.string()).nullable().default(null) }).default({})`
- **`resolveHeads()`** carries both override fields forward using key-present spread (same pattern as `customPrompt`)

### Test coverage

- 10 tri-state unit tests covering all 9 override×default combinations + empty-array edge case
- 5 config-level tests: null parse, array parse, **inherit-state regression lock** (key absent NOT undefined-valued), headToolDefaults parse, headToolDefaults default

## Inherit-State Regression Lock (key test)

The critical test (c) confirms that omitting `headToolsOverride`/`agentToolsOverride` from a HeadConfig entry results in those keys being **absent** (not present-as-undefined) in the ResolvedHead object. This is the load-bearing invariant for the whole phase: `'headToolsOverride' in head === false` for an entry that didn't specify it.

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx tsc --noEmit` — clean (no errors)
- `npx vitest run src/sub-agents/tool-access.test.ts src/config.test.ts` — 75/75 passing
- Inherit-state regression lock test passing: `'headToolsOverride' in resolvedHead === false` confirmed

## Known Stubs

None — this plan is purely schema + pure function; no enforcement or UI yet.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes. The new Zod fields reject malformed types at parse time (T-46-01-T mitigated as planned).

## Self-Check: PASSED

- `src/sub-agents/tool-access.ts` — confirmed created (abfe80e)
- `src/sub-agents/tool-access.test.ts` — confirmed created (abfe80e)
- `src/config.ts` — confirmed modified (749ad31)
- `src/config.test.ts` — confirmed modified (f4d19f0)
- All commits exist in git log
