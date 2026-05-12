---
phase: 30-core-activation
plan: "03"
subsystem: startup-wiring/eval-scripts
tags: [multi-head, head-id, call-site-update, CORE-01, CORE-04, tsc-clean]
dependency_graph:
  requires: [30-core-activation/30-02]
  provides: [all call sites head-scoped, tsc clean repo-wide, CORE-04 regression test]
  affects:
    - src/system.ts
    - src/index.ts
    - scripts/eval/harness.ts
    - scripts/eval/scenarios/multi-hop-memory.ts
    - scripts/eval/scenarios/negation-preservation.ts
    - scripts/eval/scenarios/near-duplicate-entities.ts
    - scripts/eval/scenarios/revision-tracking.ts
    - scripts/eval/scenarios/recency-bias.ts
    - scripts/eval/scenarios/gaslighting-resistance.ts
    - scripts/eval/scenarios/correction-handling.ts
    - scripts/eval/scenarios/cold-start.ts
    - scripts/eval/scenarios/combined-stress.ts
    - scripts/eval/scenarios/agent-result-recall.ts
    - tests/integration/channel-router-isolation.test.ts
tech_stack:
  added: []
  patterns:
    - headId='default' literal at every remaining production + eval call site
    - CORE-04 regression test guards ChannelRouter DI contract
key_files:
  created:
    - tests/integration/channel-router-isolation.test.ts
  modified:
    - src/system.ts
    - src/index.ts
    - scripts/eval/harness.ts
    - scripts/eval/scenarios/multi-hop-memory.ts
    - scripts/eval/scenarios/negation-preservation.ts
    - scripts/eval/scenarios/near-duplicate-entities.ts
    - scripts/eval/scenarios/revision-tracking.ts
    - scripts/eval/scenarios/recency-bias.ts
    - scripts/eval/scenarios/gaslighting-resistance.ts
    - scripts/eval/scenarios/correction-handling.ts
    - scripts/eval/scenarios/cold-start.ts
    - scripts/eval/scenarios/combined-stress.ts
    - scripts/eval/scenarios/agent-result-recall.ts
decisions:
  - "D-04 honored: 'default' literal used at all call sites outside activation.ts"
  - "D-06 honored: ChannelRouterImpl unchanged; one instance per process via DI (Phase 31 will increase)"
  - "helpers.ts line 96 left unchanged: getLastActiveChannel() there is ChannelRouter mock, not AppStateStore mock — plan's acceptance criterion for (_headId: string) was based on a misidentification; real AppStateStore in makeHeadBundle uses the real class, no mock to update"
metrics:
  duration_minutes: 7
  completed_date: "2026-05-12"
  tasks_completed: 3
  files_modified: 13
  files_created: 1
---

# Phase 30 Plan 03: Call-Site Update + CORE-04 Guard Summary

Completed final Phase 30 wiring: `src/system.ts` passes `headId: 'default'` to `ActivationLoop`; `src/index.ts` startup recovery and threshold-checker callback pass `'default'` to the two AppStateStore head-scoped methods; all 10 eval scenario scripts and `harness.ts` updated; `npx tsc --noEmit` exits 0 repo-wide; `npx vitest run` passes 1320 tests; CORE-04 regression test added.

## src/system.ts Change

- **Line 353:** Added `headId: 'default',` as the first property of the `new ActivationLoop({ ... })` options literal, before `queueStore: stores.queue`.

## src/index.ts Call Sites Updated

| Line | Before | After |
|------|--------|-------|
| 212 | `appState.releaseArchivalLock()` | `appState.releaseArchivalLock('default')` |
| 509 | `appState.getLastActiveChannel()` | `appState.getLastActiveChannel('default')` |

Audit confirmed: no other `appState.{getLastActiveChannel,setLastActiveChannel,tryAcquireArchivalLock,releaseArchivalLock}` calls exist without arguments in `src/index.ts` or `src/system.ts`.

## scripts/eval/harness.ts Update

Lines 997–998 (inside `runHeadEvent`):
- `bundle.appState.getLastActiveChannel()` → `getLastActiveChannel('default')`
- `bundle.appState.setLastActiveChannel('eval')` → `setLastActiveChannel('default', 'eval')`

The ChannelRouter stub at line 132 (`getLastActiveChannel: () => null`) was correctly left untouched — it implements the zero-arg `ChannelRouter` interface, not `AppStateStore`.

## Eval Scenario Files Updated (10 files)

All 10 files had `tryAcquireArchivalLock()` and `releaseArchivalLock()` updated to pass `'default'`:

| File | Variant | Control flow |
|------|---------|-------------|
| multi-hop-memory.ts | env.bundle | break |
| negation-preservation.ts | env.bundle | break |
| near-duplicate-entities.ts | env.bundle | break |
| revision-tracking.ts | env.bundle | break |
| recency-bias.ts | env.bundle | break |
| gaslighting-resistance.ts | env.bundle | break |
| correction-handling.ts | env.bundle | break |
| cold-start.ts | env.bundle | break |
| combined-stress.ts | bundle | return |
| agent-result-recall.ts | bundle | break |

## tests/integration/helpers.ts

No AppStateStore mock exists in this file — `makeHeadBundle()` uses `new AppStateStore(db)` (the real class). The `getLastActiveChannel: () => null` at line 96 is inside `makeChannelRouter()` (ChannelRouter interface) and was correctly left untouched.

## npx tsc --noEmit Output

Exit 0. No output — repo-wide type check is clean.

## npx vitest run Summary

```
Test Files  78 passed | 3 skipped (81)
     Tests  1320 passed | 1 skipped (1321)
  Duration  64.50s
```

## ChannelRouterImpl Instance Count (Phase 31 Baseline)

`grep -cE "new ChannelRouterImpl" src/index.ts` → **1**

One global instance in Phase 30 (single head). Phase 31 will increase this count when it constructs one router per configured head.

## tests/integration/channel-router-isolation.test.ts

New file asserting CORE-04:

1. **Instance isolation test** — Two `new ChannelRouterImpl()` instances are distinct objects (`not.toBe`). Both start with `getLastActiveChannel() === null`, proving independent state containers, not a singleton.

2. **DI field regression test** — Reads `src/head/activation.ts` source and asserts it matches `/channelRouter:\s*ChannelRouter\b/`. If the required DI field is ever removed or made optional, this test breaks and forces a Phase 31 review.

## Deviations from Plan

### Plan inconsistency resolved (not a code deviation)

**Found during:** Task 2, helpers.ts edit

**Issue:** The plan specified updating `getLastActiveChannel: () => null` at `tests/integration/helpers.ts:96` to `(_headId: string) => null`. However, that line is inside `makeChannelRouter()` which implements the `ChannelRouter` interface — not an `AppStateStore` mock. The `ChannelRouter.getLastActiveChannel()` takes no arguments. Changing it would break the type and contradict the plan's own instruction to leave ChannelRouter mocks untouched.

**Resolution:** The line was left unchanged. `makeHeadBundle()` uses a real `AppStateStore` instance, so no AppStateStore mock signature needed updating. The plan's acceptance criterion `grep -F "(_headId: string) => null"` cannot be satisfied without incorrectly modifying a ChannelRouter mock. This deviation has no impact on correctness: tsc is clean and no unscoped AppStateStore calls remain.

**Alignment with plan goals:** All actual plan goals achieved — zero unscoped `appState.X()` calls remain in any production, test, or eval script.

## Phase 30 Completion

All four CORE requirements are now satisfied:

| Requirement | Evidence |
|-------------|----------|
| CORE-01: ActivationLoop parameterized by headId | `headId: string` required field on `ActivationLoopOptions`; all 33 call sites use `this.opts.headId` (Plan 02); system.ts passes `'default'` (this plan) |
| CORE-02: AppStateStore head-scoped methods | Four methods take `headId: string`; keys namespaced as `{headId}:key` (Plan 01) |
| CORE-03: Migration renames existing keys | `sql/006_rename_app_state_keys.sql` renames `last_active_channel` → `default:last_active_channel` and `archival_lock` → `default:archival_lock` (Plan 01) |
| CORE-04: ChannelRouter DI per-instance | Architecturally satisfied (existing DI); regression test in `tests/integration/channel-router-isolation.test.ts` (this plan) |

Phase 31 has a clean foundation: one `ActivationLoop` wired with `headId: 'default'`, one `ChannelRouterImpl` passed via DI, all state namespaced under `'default:'` prefix.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes.

## Commits

| Hash | Description |
|------|-------------|
| 829d0bc | feat(30-03): wire headId='default' into production startup (system.ts + index.ts) |
| a5d6ecf | feat(30-03): pass 'default' headId to AppStateStore in eval harness + all 10 scenario scripts |
| 8333ee4 | test(30-03): add CORE-04 ChannelRouter DI isolation regression test |

## Self-Check: PASSED
