---
phase: quick-260608-6ny
plan: "01"
subsystem: llm-routing,config,head,sub-agents
tags: [tier-rename, backward-compat, head-spawn-agent]
key-decisions:
  - "Normalization happens on userJson before merge so user legacy keys override base defaults correctly"
  - "LEGACY_TIER_ALIAS exported from config.ts so router can reuse the same map at call time"
  - "Head spawn_agent model enum is optional with no default; runner agentModel ('smart') applies on omission"
  - "normalizeLegacyModelConfig is exported and pure to enable direct test coverage without filesystem coupling"
metrics:
  duration: "~20 minutes"
  completed: "2026-06-08"
  tasks_completed: 3
  tasks_total: 3
key-files:
  created: []
  modified:
    - src/types/llm.ts
    - src/config.ts
    - src/llm/router.ts
    - src/llm/index.ts
    - src/llm/tool-loop.ts
    - src/sub-agents/local.ts
    - src/sub-agents/registry.ts
    - src/db/agents.ts
    - src/types/agent.ts
    - src/head/index.ts
    - src/head/assembler.ts
    - src/system.ts
    - src/dashboard/routes/settings.ts
    - config.json
    - CHANGELOG.md
    - src/config.test.ts
    - src/llm/llm.test.ts
    - src/llm/tool-loop.test.ts
    - src/sub-agents/agents.test.ts
    - src/dashboard/routes/settings.test.ts
    - src/db/db.test.ts
    - src/head/assembler.test.ts
    - src/head/head.test.ts
    - src/head/steward.test.ts
    - src/skills/skills.test.ts
    - src/scheduler/proactive.test.ts
    - scripts/eval/scenarios/agent-relay.ts
---

# Phase quick-260608-6ny Plan 01: Rename Model-Tier Vocabulary to dumb/smart/genius Summary

Renamed internal model-tier vocabulary standard/capable/expert → dumb/smart/genius end-to-end, with read-time backward-compat normalizer for existing configs, and exposed an optional `model` enum on the head's spawn_agent tool.

## Tasks Completed

| Task | Name | Commit |
|------|------|--------|
| 1 | Rename Tier vocabulary + backward-compat normalizer | 0190f7d, af841ec |
| 2 | Expose model arg on head spawn_agent + align registry | 0494310 |
| 3 | Full sweep, settings test update, CHANGELOG | 7d5915c |

## What Was Done

**Task 1 — Vocabulary rename + backward-compat:**
- `Tier` type and `TierModels` interface fields renamed: standard→dumb, capable→smart, expert→genius
- All 9 provider model config keys renamed in `ConfigSchema` and `config.json` (base repo)
- Role-model defaults updated: headModel/agentModel→'smart', all steward/memory→'dumb'
- `LEGACY_TIER_ALIAS` and `normalizeLegacyModelConfig()` exported from `src/config.ts`
- `loadConfig` normalizes `userJson` before the base merge so user legacy keys win over base defaults
- Both `SingleProviderRouter` and `MultiProviderRouter` accept legacy tier names at call time via the same alias map
- `getCapableModel` renamed to `getSmartModel` in `src/head/assembler.ts`
- `src/config.test.ts` expanded with 18 new normalizer tests (pure function + loadConfig integration)

**Task 2 — Head spawn_agent model param:**
- Added optional `model` enum `['dumb','smart','genius']` to head spawn_agent `inputSchema.properties`
- Handler conditionally spreads `model` into `SpawnOptions` only when supplied (`input['model'] ? { model } : {}`)
- Top-level description updated with tier heuristic
- `src/sub-agents/registry.ts` SPAWN_AGENT_DEF model description updated to new vocabulary

**Task 3 — Full sweep + CHANGELOG:**
- All remaining stray old tier literals in production code fixed (db/agents.ts, sub-agents/local.ts, tool-loop.ts)
- All affected test suites updated to new vocabulary (42+ occurrences across 10 test files)
- `CHANGELOG.md` updated with #31 entry under `## [0.3.0] ### Changed`
- `npx tsc --noEmit` clean; all 242 targeted tests pass

## Deviations from Plan

**1. [Rule 1 - Bug] Normalization placement**
- **Found during:** Task 1 - integration test failure
- **Issue:** Normalizing the merged object (after base+user merge) caused base config's new keys to silently shadow user's legacy keys — the user's old `anthropicModelCapable` was never promoted because `anthropicModelSmart` already existed from base.
- **Fix:** Normalize `userJson` before the merge so legacy user keys are promoted to new keys first, then override the base defaults correctly via the spread.
- **Files modified:** `src/config.ts`

**2. [Rule 2 - Missing] Additional files with stray tier literals**
- **Found during:** Task 3 grep
- **Issue:** Plan listed settings.ts/settings.test.ts but several other files also had old tier literals: `db/agents.ts`, `tool-loop.ts`, `sub-agents/local.ts`, steward/assembler/head test fixtures, `skills.test.ts`, `proactive.test.ts`, `db.test.ts`, eval scripts.
- **Fix:** Updated all of them as part of Task 3 sweep.

## Verification Results

- `npx tsc --noEmit`: CLEAN
- `npx vitest run src/config.test.ts src/llm/llm.test.ts src/sub-agents/agents.test.ts src/dashboard/routes/settings.test.ts`: 242 tests, 4 files, all passed
- Grep: `grep -rn "'standard'\|'capable'\|'expert'" src/ --include="*.ts" | grep -v test | grep -v config.ts | grep -v router.ts` returns 0 results

## Self-Check: PASSED

- All modified source files exist on disk and are committed
- 4 commits recorded: 0190f7d, af841ec, 0494310, 7d5915c
- tsc clean, all targeted tests green
- No dashboard/dist committed
- Work stayed on main branch
