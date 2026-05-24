---
phase: 30-core-activation
plan: "02"
subsystem: head/activation
tags: [multi-head, activation-loop, head-id, parameterization]
dependency_graph:
  requires: [30-core-activation/30-01]
  provides: [ActivationLoop fully parameterized by headId]
  affects: [src/head/activation.ts, src/head/activation.test.ts, src/head/head.test.ts, tests/unit/activation.test.ts, tests/unit/commands.test.ts, tests/integration/head.test.ts, tests/scenarios/multi-message-batching.test.ts]
tech_stack:
  added: []
  patterns: [headId required field on ActivationLoopOptions, this.opts.headId at every head-scoped call site]
key_files:
  created: []
  modified:
    - src/head/activation.ts
    - src/head/activation.test.ts
    - src/head/head.test.ts
    - tests/unit/activation.test.ts
    - tests/unit/commands.test.ts
    - tests/integration/head.test.ts
    - tests/scenarios/multi-message-batching.test.ts
decisions:
  - "D-01: headId: string is required (not optional) on ActivationLoopOptions — omitting it fails tsc loudly"
  - "D-04: this.opts.headId used at every call site (no private field) for grep-ability and traceability"
metrics:
  duration_minutes: 25
  completed_date: "2026-05-12"
  tasks_completed: 3
  files_modified: 7
---

# Phase 30 Plan 02: ActivationLoop headId Parameterization Summary

ActivationLoop parameterized with required `headId: string` field; all 33 hardcoded `'default'` queue/message/appState call sites replaced with `this.opts.headId`; all 6 test files updated; per-head isolation regression test added covering queue claim isolation, channel isolation, and archival lock independence.

## Final ActivationLoopOptions.headId Declaration

- **Line:** 80 in `src/head/activation.ts`
- **Type:** `headId: string` (required, no default)
- **Position:** First field in the interface (above `queueStore`) per plan spec

## this.opts.headId Reference Count

**33 total references** in `src/head/activation.ts`:
- 3 `queueStore` calls: `claimNext`, `claimAllPendingBackground`, `claimAllPendingUserMessages` (×2)
- 16 `messages` calls: `getRecent` (×4), `getAll` (×3), `getSince` (×3), `getRecentBefore` (×1), `getRecentTextByTokens` (×2), `getRecentText` (×0 — not present)
- 9 `appState.getLastActiveChannel` calls
- 3 `appState.setLastActiveChannel` calls
- 2 `appState.tryAcquireArchivalLock` calls
- 2 `appState.releaseArchivalLock` calls

## grep Verification: Zero 'default' Literals in Routing Context

`grep -n "'default'" src/head/activation.ts` returns no output — all `'default'` literals in queue/message/appState routing contexts have been replaced.

## Test Files Updated

| File | Construction Line | Change |
|------|-------------------|--------|
| `src/head/activation.test.ts` | 183 | `headId: 'default'` added |
| `src/head/head.test.ts` | 607 | `headId: 'default'` added |
| `tests/unit/activation.test.ts` | 72 | `headId: 'default'` added to makeLoop |
| `tests/unit/commands.test.ts` | N/A | AppStateStore mock signatures updated with `_headId: string` params (no ActivationLoop constructor here) |
| `tests/integration/head.test.ts` | 105 | `headId: 'default'` added |
| `tests/scenarios/multi-message-batching.test.ts` | 107 | `headId: 'default'` added |

## Per-Head Isolation Test

**Location:** `tests/unit/activation.test.ts` — describe block `"ActivationLoop — per-head isolation (Phase 30 CORE-01)"`

**3 tests added:**

1. **Queue claim isolation** — Two ActivationLoop instances on the same DB (headId='personal' and headId='work'). Two `queue_events` rows inserted via raw SQL with explicit `head_id`. Asserts `queue.claimNext('personal')` returns only `ev-personal-1` and `queue.claimNext('work')` returns only `ev-work-1`. Proves T-30-08 mitigation.

2. **lastActiveChannel isolation** — Sets `appState.setLastActiveChannel('personal', 'discord-personal')` and `appState.setLastActiveChannel('work', 'telegram-work')` on the same AppStateStore. Asserts each head reads back its own value. Proves T-30-09 mitigation.

3. **Archival lock independence** — Acquires lock for 'personal', asserts 'work' can still acquire its own lock independently. Releases 'personal', asserts it can be re-acquired. 'work' still held. Proves T-30-09 mitigation.

## Stale Phase 29 Interim Comment Removed

The comment `// Phase 29 interim: pass 'default' headId until Phase 30 parameterizes ActivationLoop by head.` at line 227 has been removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing test calling AppStateStore.setLastActiveChannel with old signature**
- **Found during:** Task 2 verification (test run)
- **Issue:** `tests/unit/activation.test.ts` line 181 called `appState.setLastActiveChannel('test-channel')` without headId — broken by Plan 01's AppStateStore signature change, previously undetected
- **Fix:** Changed to `appState.setLastActiveChannel('default', 'test-channel')`
- **Files modified:** `tests/unit/activation.test.ts`
- **Commit:** 65ecb83

## Remaining tsc Errors (Plan 03 Scope)

After these changes, `npx tsc --noEmit` has errors ONLY in:
- `src/system.ts` — `new ActivationLoop({...})` missing `headId` field
- `src/index.ts` — `appState.releaseArchivalLock()` / `getLastActiveChannel()` missing headId args
- `scripts/eval/harness.ts` and `scripts/eval/scenarios/*.ts` — pre-existing from Plan 01 (AppStateStore signatures not yet updated in eval layer)

No errors in `src/head/activation.ts` or any test file in this plan's scope.

## Commits

| Hash | Description |
|------|-------------|
| 699bbed | feat(30-02): add headId to ActivationLoopOptions; replace all 'default' literals |
| 65ecb83 | feat(30-02): update ActivationLoop constructor sites in tests with headId: 'default' |
| eb1ca8e | test(30-02): add per-head isolation scenario tests to activation.test.ts |

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan's threat model covers.

## Self-Check: PASSED
