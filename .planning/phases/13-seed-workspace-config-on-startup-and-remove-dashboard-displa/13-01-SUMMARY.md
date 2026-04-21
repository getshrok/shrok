---
phase: 13
plan: 01
subsystem: dashboard/settings
tags: [config, refactor, tdd, drift-fix]
dependency_graph:
  requires: []
  provides: [config-derived-settings-defaults]
  affects: [src/dashboard/routes/settings.ts, src/dashboard/server.ts]
tech_stack:
  added: []
  patterns: [config-threading, tdd-red-green]
key_files:
  created: []
  modified:
    - src/dashboard/routes/settings.ts
    - src/dashboard/server.ts
    - src/dashboard/routes/settings.test.ts
decisions:
  - assistantName and accentColor/logoPath keep literal defaults (not in ConfigSchema)
  - Legacy memoryModel fallback chain removed; single-source derivation from config
metrics:
  duration_minutes: 10
  completed_date: "2026-04-21T11:52:32Z"
  tasks_completed: 2
  files_modified: 3
  tests_added: 5
requirements_satisfied: [D-03, D-04, D-05]
---

# Phase 13 Plan 01: Thread Config into createSettingsRouter Summary

**One-liner:** Eliminated all hardcoded GET /api/settings default literals by threading `Config` as a required third parameter into `createSettingsRouter`, with `src/config.ts` ConfigSchema as the single source of truth.

## What Was Done

### Task 1 — RED: Add failing GET /api/settings regression tests

Added 5 new tests in `src/dashboard/routes/settings.test.ts` under `describe('GET /api/settings — config-derived defaults')`:

- Test A: `anthropicModelStandard` returns `'claude-haiku-4-5-20251001'` (not old `'claude-haiku-4-5'`)
- Test B: Gemini model defaults return correct values (not fabricated `'gemini-3-flash'`, `'gemini-3.1-pro'`)
- Test C: OpenAI model defaults return correct values (not fabricated `'gpt-5.4-nano'`, `'gpt-5.4-mini'`, `'gpt-5.4'`)
- Test D: `memoryBudgetPercent === 45` (not 40) and `contextRelevanceStewardEnabled === false` (not true)
- Test E: Workspace `config.json` override wins over config-derived default

Also added `makeTestConfig()` helper mirroring ConfigSchema defaults, and updated the existing PUT test `beforeEach` to pass `makeTestConfig()` as the third arg.

All 5 new tests failed on current code (RED phase confirmed).

**Commit:** `27b265a`

### Task 2 — GREEN: Refactor createSettingsRouter + update call site

**Edit 1 — `src/dashboard/routes/settings.ts` signature:**
- Added `config: Config` as required third parameter (before optional `appState` and `events`)

**Edit 2 — `src/dashboard/routes/settings.ts` GET handler:**
- Replaced all ~30 hardcoded fallback literals with `config.<fieldName>` references
- Removed legacy `memoryModel` fallback chain (`str('memoryChunkingModel', '') || str('memoryArchivalModel', '') || str('memoryModel', 'capable')`) — replaced with single `str('memoryChunkingModel', config.memoryChunkingModel)`
- `assistantName`, `accentColor`, `logoPath` keep literal defaults (not in ConfigSchema)

**Edit 3 — `src/dashboard/server.ts:148`:**
- Updated call site from `createSettingsRouter(workspacePath, envFilePath, this.opts.appState, this.opts.events)` to `createSettingsRouter(workspacePath, envFilePath, config, this.opts.appState, this.opts.events)`
- `config` was already in scope at line 99 via `const { config, ... } = this.opts`

All 12 tests pass (7 existing PUT + 5 new GET defaults). `tsc --noEmit` clean.

**Commit:** `27c8bc9`

## Drift Corrections Applied

| Field | Before | After | Source |
|-------|--------|-------|--------|
| `anthropicModelStandard` default | `'claude-haiku-4-5'` | `'claude-haiku-4-5-20251001'` | config.ts |
| `geminiModelStandard` default | `'gemini-2.5-flash'` | `'gemini-2.0-flash'` | config.ts |
| `geminiModelCapable` default | `'gemini-3-flash'` (fabricated) | `'gemini-2.5-pro'` | config.ts |
| `geminiModelExpert` default | `'gemini-3.1-pro'` (fabricated) | `'gemini-2.5-pro'` | config.ts |
| `openaiModelStandard` default | `'gpt-5.4-nano'` (fabricated) | `'gpt-4o-mini'` | config.ts |
| `openaiModelCapable` default | `'gpt-5.4-mini'` (fabricated) | `'gpt-4o'` | config.ts |
| `openaiModelExpert` default | `'gpt-5.4'` (fabricated) | `'gpt-4o'` | config.ts |
| `memoryBudgetPercent` default | `40` | `45` | config.ts |
| `contextRelevanceStewardEnabled` default | `true` | `false` | config.ts |

## Tests Added

5 new tests in `src/dashboard/routes/settings.test.ts`:
1. `returns anthropic model defaults from config (not old literals)`
2. `returns corrected gemini model defaults from config`
3. `returns corrected openai model defaults from config`
4. `returns drift-corrected numeric and boolean defaults from config`
5. `workspace config.json override wins over config-derived default`

Total settings tests: 12 (7 PUT + 5 GET).

## Deviations from Plan

None — plan executed exactly as written.

## Requirements Satisfied

- **D-01**: `src/config.ts` ConfigSchema is now single source of truth for all GET /api/settings defaults
- **D-03**: `createSettingsRouter` accepts `config: Config` as required 3rd parameter
- **D-04**: All fabricated/drifted model IDs corrected
- **D-05**: `memoryBudgetPercent` and `contextRelevanceStewardEnabled` drift corrections landed

## Self-Check: PASSED

- `src/dashboard/routes/settings.ts` modified: confirmed (contains `config: Config`)
- `src/dashboard/server.ts` modified: confirmed (line 148 passes `config`)
- `src/dashboard/routes/settings.test.ts` modified: confirmed (5 new tests)
- Commits exist: `27b265a` (test RED), `27c8bc9` (feat GREEN)
- `tsc --noEmit`: exits 0
- `npx vitest run src/dashboard/routes/settings.test.ts`: 12/12 pass
