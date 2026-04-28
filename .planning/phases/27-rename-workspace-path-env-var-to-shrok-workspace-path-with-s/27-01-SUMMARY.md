---
phase: 27
plan: 01
subsystem: config
tags: [env-var, rename, soft-fallback, workspace-path]
dependency_graph:
  requires: []
  provides: [SHROK_WORKSPACE_PATH soft-fallback read sites, doctor hint update, test coverage for 3 fallback branches]
  affects: [src/config.ts, src/index.ts, src/doctor/index.ts, src/dashboard/routes/evals.ts, src/llm/openai-oauth.ts, src/doctor/checks/config.ts, scripts/set-config.ts, scripts/setup/index.ts, src/config.test.ts, src/doctor/checks/config.test.ts]
tech_stack:
  added: []
  patterns: [soft-fallback env var chain (SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH ?? default)]
key_files:
  created: []
  modified:
    - src/config.ts
    - src/index.ts
    - src/doctor/index.ts
    - src/dashboard/routes/evals.ts
    - src/llm/openai-oauth.ts
    - src/doctor/checks/config.ts
    - scripts/set-config.ts
    - scripts/setup/index.ts
    - src/config.test.ts
    - src/doctor/checks/config.test.ts
decisions:
  - Local constant WORKSPACE_PATH in scripts/setup/index.ts kept as-is — renaming it would touch unneeded lines; soft-fallback at resolution site is sufficient
  - Phase 17 describe block beforeEach switched to SHROK_WORKSPACE_PATH to future-proof the test
metrics:
  duration: ~5 minutes
  completed: "2026-04-28"
  tasks_completed: 4
  tasks_total: 4
  files_modified: 10
---

# Phase 27 Plan 01: Soft-fallback SHROK_WORKSPACE_PATH Read Sites Summary

**One-liner:** Replace all bare `WORKSPACE_PATH` reads with `SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH` soft-fallback across 5 runtime files, 2 operator-tooling scripts, 1 doctor hint, and 2 test files.

## What Was Built

Seven read sites in the runtime and operator-tooling codebase now use the canonical soft-fallback expression `process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH']` (with `?? default` where applicable). New installs that set only `SHROK_WORKSPACE_PATH` resolve the workspace correctly; existing installs using only `WORKSPACE_PATH` continue to work unchanged. When both are set, `SHROK_WORKSPACE_PATH` wins.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Soft-fallback all read sites (5 runtime files) | 3dc0b4d | src/config.ts, src/index.ts, src/doctor/index.ts, src/dashboard/routes/evals.ts, src/llm/openai-oauth.ts |
| 2 | Update doctor hint text in checks/config.ts | 1c67705 | src/doctor/checks/config.ts |
| 3 | Update tests to drive new name + pin soft-fallback | 255bb5a | src/config.test.ts, src/doctor/checks/config.test.ts |
| 4 | Soft-fallback operator-tooling read sites | 9f4060d | scripts/set-config.ts, scripts/setup/index.ts |

## Changes Made

### src/config.ts
- `rawWorkspace` chain: `SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH ?? json ?? default`
- `secrets.workspacePath`: `SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH`
- Comment on ENV_KEY_ALLOWLIST block updated to reference `SHROK_WORKSPACE_PATH`

### src/index.ts + src/doctor/index.ts
- `loadEnvFile` `ws` resolution: `SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH ?? default`

### src/dashboard/routes/evals.ts
- `buildEvalEnv` `ws` resolution: `SHROK_WORKSPACE_PATH ?? WORKSPACE_PATH ?? default`

### src/llm/openai-oauth.ts
- `persistOAuthTokens` `ws` resolution: same soft-fallback
- JSDoc updated: `$WORKSPACE_PATH/.env` → `$SHROK_WORKSPACE_PATH/.env`

### src/doctor/checks/config.ts
- Hint text: `'create the workspace dir or set WORKSPACE_PATH'` → `'create the workspace dir or set SHROK_WORKSPACE_PATH'`

### scripts/set-config.ts + scripts/setup/index.ts
- Both operator-tooling scripts: ws/WORKSPACE_PATH constant now uses full soft-fallback chain

### src/config.test.ts
- `'applies default paths'`: deletes both env vars before asserting defaults
- Replaced `'WORKSPACE_PATH env overrides workspacePath'` with 3 tests covering new-only, legacy-only, and both-set-prefers-new branches
- Phase 17 `beforeEach`: sets `SHROK_WORKSPACE_PATH` instead of `WORKSPACE_PATH`

### src/doctor/checks/config.test.ts
- Hint regex updated to `/SHROK_WORKSPACE_PATH/`

## Verification Results

- `npx tsc --noEmit`: exits 0 (no type errors)
- `npx vitest run src/config.test.ts src/doctor/checks/config.test.ts`: 42/42 tests passing
- All 7 target read sites use canonical soft-fallback expression
- All legacy `WORKSPACE_PATH` reads are on the right-hand side of `??` (none are bare primary reads)
- Doctor files contain no `set WORKSPACE_PATH` or `/WORKSPACE_PATH/` regex

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. The soft-fallback resolves to the same downstream path operations as before (both names pass through the same `replace(/^~/, os.homedir())` / `path.join` operations).

## Self-Check: PASSED
