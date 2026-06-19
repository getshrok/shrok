---
phase: quick-260525-4zu
plan: 01
subsystem: startup, sub-agents, skills
tags: [timezone, env, bash-allowlist, tdd]
dependency_graph:
  requires: []
  provides: [TZ propagation at startup, TZ in BASELINE_ENV_KEYS]
  affects: [src/index.ts, src/sub-agents/env.ts, skills/scheduling/SKILL.md, skills/tasks/SKILL.md]
tech_stack:
  added: []
  patterns: [startup-once env mutation, exported helper for unit testing]
key_files:
  created:
    - src/timezone-env.ts
    - src/sub-agents/env.test.ts
  modified:
    - src/sub-agents/env.ts
    - src/index.ts
    - skills/scheduling/SKILL.md
    - skills/tasks/SKILL.md
decisions:
  - applyTimezoneEnv accepts Pick<Config,'timezone'> so tests pass a minimal literal without constructing a full Config
  - TZ appended to BASELINE_ENV_KEYS; buildScopedEnv filter-undefined behavior unchanged
  - beforeEach/afterEach TZ save-restore in env.test.ts prevents cross-shard leakage (T-4zu-02)
metrics:
  duration: 8min
  completed: 2026-05-25
---

# Phase quick-260525-4zu Plan 01: Export config.timezone as TZ to spawned processes Summary

**One-liner:** Propagates config.timezone to all subprocess environments by setting process.env.TZ once at startup via a typed, unit-tested applyTimezoneEnv helper.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Create applyTimezoneEnv helper and add TZ to bash allowlist | c6b3013 | src/timezone-env.ts, src/sub-agents/env.ts, src/sub-agents/env.test.ts |
| 2 | Wire applyTimezoneEnv into startup | 2b8e419 | src/index.ts |
| 3 | Update skill docs (scheduling, tasks) for TZ source | 5f648aa | skills/scheduling/SKILL.md, skills/tasks/SKILL.md |

## What Was Built

- **`src/timezone-env.ts`**: Exports `applyTimezoneEnv(config: Pick<Config, 'timezone'>): void`. Sets `process.env['TZ'] = config.timezone`. One-line body, typed via `Pick<Config, 'timezone'>` for minimal coupling and easy unit testing.
- **`src/sub-agents/env.ts`**: Added `'TZ'` to `BASELINE_ENV_KEYS`. The existing `buildScopedEnv` filter-undefined guard (`if (envDict[key] !== undefined)`) is unchanged, so TZ only appears in scoped bash env when it is actually present in `process.env`.
- **`src/index.ts`**: Added `import { applyTimezoneEnv } from './timezone-env.js'` and `applyTimezoneEnv(config)` call immediately after `const config = loadConfig()` (line 97), before `registerSecrets` / `setLogLevel`.
- **`src/sub-agents/env.test.ts`**: 4 unit tests covering: BASELINE_ENV_KEYS includes 'TZ'; buildScopedEnv includes TZ when present; buildScopedEnv omits TZ when absent; applyTimezoneEnv sets process.env.TZ. beforeEach/afterEach save/restore original TZ to prevent cross-shard leakage.
- **`skills/scheduling/SKILL.md`**: Added paragraph after watermark code fence explaining the offset reflects config.timezone propagated via TZ env var.
- **`skills/tasks/SKILL.md`**: Augmented Watermarks bullet with note that timestamps follow config.timezone via TZ; do not assume host OS zone.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## TDD Gate Compliance

- RED: tests failed (module not found) before `src/timezone-env.ts` existed — confirmed.
- GREEN: all 4 tests passed after creating `src/timezone-env.ts` and adding TZ to `BASELINE_ENV_KEYS` — confirmed.
- REFACTOR: not needed; implementation is minimal.

## Self-Check: PASSED

- src/timezone-env.ts: exists
- src/sub-agents/env.test.ts: exists
- src/sub-agents/env.ts: 'TZ' present in BASELINE_ENV_KEYS
- src/index.ts: applyTimezoneEnv(config) at line 97
- Commits c6b3013, 2b8e419, 5f648aa: exist
- tsc --noEmit: clean
- vitest run: 1657 passed, 1 skipped, 0 failed
- No .map files staged
- dashboard/dist/ not touched
- src/dashboard/routes/settings.ts not touched
- src/icw/* not touched
