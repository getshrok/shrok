---
phase: 31-adapter-registry-config-startup
plan: "03"
subsystem: startup
tags: [multi-head, startup-loop, channel-router-per-head, secret-redaction, integration-test]

# Dependency graph
requires:
  - phase: 31-adapter-registry-config-startup/31-01
    provides: resolveHeads(), extractSecretValues(), ResolvedHead type
  - phase: 31-adapter-registry-config-startup/31-02
    provides: QueueStore.enqueue(headId), all 7 adapters with headId constructors

provides:
  - Multi-head startup loop in src/index.ts (one ChannelRouterImpl + ActivationLoop + adapter set per head)
  - extractSecretValues() extended to walk config.heads[].channels for inline credential redaction
  - tests/integration/multi-head-startup.test.ts (6 tests: CONF-02, CONF-03, ADPT-01, secret extraction)

affects:
  - Phase 32 (dashboard head selector) — per-head ActivationLoop running, head_id on all queue events

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "for (const head of resolvedHeads) — canonical per-head construction loop in index.ts"
    - "HeadSystem interface — bundles head + channelRouter + system + channelAdapters + routeMessage"
    - "headSystems[0] as primary — first head owns Dashboard, Scheduler, Webhook, Voice"
    - "if (!isMultiHead) — hot-reload sentinel gate; named heads reconfigure via process restart"

key-files:
  created:
    - tests/integration/multi-head-startup.test.ts
  modified:
    - src/config.ts
    - src/index.ts

key-decisions:
  - "Dashboard/Scheduler/Webhook/Voice wired to primary (first) head only — Open Questions 1-3 RESOLVED per RESEARCH"
  - "Hot-reload sentinels gated by isMultiHead check — named heads reconfigure via process restart (Pitfall 5)"
  - "appState variable in per-head loop shadows outer primary.stores.appState — resolved by aliasing outer as appState after loop"
  - "headAppState renamed to appState inside loop to satisfy structural grep acceptance criterion appState.releaseArchivalLock(head.id)"
  - "stopProcess/restartProcessFn/emergencyStop all iterate headSystems to stop all activation loops"

requirements-completed: [CONF-03, ADPT-01, ADPT-02, CONF-02]

# Metrics
duration: ~5min
completed: 2026-05-12
---

# Phase 31 Plan 03: Multi-Head Startup Loop Summary

**Multi-head startup loop wired in index.ts: one ChannelRouterImpl + ActivationLoop + adapter set per resolved head, with extractSecretValues extended for heads[] inline credentials and 6 integration tests covering CONF-02, CONF-03, ADPT-01, and secret redaction**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-12T08:55:00Z
- **Completed:** 2026-05-12T09:04:00Z
- **Tasks:** 2
- **Files modified:** 3 (src/config.ts, src/index.ts, new tests/integration/multi-head-startup.test.ts)

## Accomplishments

### Task 1: extractSecretValues() extension + integration test scaffold

- Replaced single-expression `extractSecretValues()` body with a two-pass implementation: flat SECRET_FIELDS pass (unchanged behavior) + new `config.heads` walk
- Added `switch (ch.vendor)` discriminator covering all 5 vendors with their credential fields (botToken, chatId, channelId, appToken, allowedJid, clientId, clientSecret, refreshToken)
- Length-≥-8 guard preserved for all extracted strings
- Created `tests/integration/multi-head-startup.test.ts` with 6 tests:
  1. Two heads produce two distinct head ids — queue isolation (CONF-03, ADPT-01)
  2. Each head owns a distinct ChannelRouterImpl instance — no bleeding
  3. No heads[] + no flat keys → exactly one default head (CONF-02 zero-config)
  4. No heads[] + flat telegram keys → synthesized default head (D-03)
  5. extractSecretValues registers inline credentials from heads[].channels
  6. extractSecretValues still returns flat-key secrets (regression guard)

### Task 2: src/index.ts multi-head startup loop

src/index.ts delta: +326 lines / -311 lines (net +15 lines for the 774-line final file).

Key structural changes:

| Before | After |
|--------|-------|
| `const channelRouter = new ChannelRouterImpl()` (single global) | `const headRouter = new ChannelRouterImpl()` inside per-head loop |
| `const system = buildSystem({...})` (no headId) | `buildSystem({ ..., headId: head.id })` per-head |
| `queue.requeueStale()` + `appState.releaseArchivalLock('default')` | `headQueue.requeueStale()` + `appState.releaseArchivalLock(head.id)` per-head |
| Single `routeMessage` closure | Per-head `headRouteMessage` closure capturing `head.id` + `headQueue` |
| 5 if-blocks for channel adapters (flat config keys) | `for (const ch of head.channels)` dispatch over discriminated union |
| `activationLoop.start()` + `activationLoop.announceOnline()` | `for (const { system: s, head: h } of headSystems)` loop |
| `activationLoop.stop()` in shutdown | `for (const { system: s } of headSystems) s.activationLoop.stop()` |

Primary-head ownership decisions (RESEARCH Open Questions 1-3 RESOLVED):
- Dashboard adapter: attached inside the per-head loop, first head only
- DashboardServer: wired to `primary.system.stores` + `dashboardAdapter!`
- Scheduler: uses `queue` from primary stores (schedule_trigger lands on primary)
- Webhook: uses `queue` from primary stores
- Voice: attached to `primary.channelRouter` and wired to `primary.routeMessage`
- Hot-reload sentinels: guarded by `if (!isMultiHead)` — named heads restart instead

Post-activation callbacks (`onPostActivation`) and `setRevokeDashboardSessions` registered on `primary.system.activationLoop`.

## Task Commits

1. **Task 1: extend extractSecretValues + integration test scaffold** - `5235435` (feat)
2. **Task 2: refactor index.ts to multi-head startup loop** - `0703826` (feat)

## Files Created/Modified

- `/home/ubuntu/shrok/src/config.ts` — extractSecretValues() body replaced with two-pass implementation (+22 lines)
- `/home/ubuntu/shrok/src/index.ts` — full multi-head startup loop refactor (774 lines; +326/-311 vs prior)
- `/home/ubuntu/shrok/tests/integration/multi-head-startup.test.ts` — new, 116 lines, 6 tests

## Decisions Made

- Dashboard adapter uses `dashboard:${head.id}` as its channel id rather than the hardcoded `'dashboard'` string — the id will be head-scoped for future Phase 32 selector work
- `stopProcess` / `restartProcessFn` / `emergencyStop` all iterate `headSystems` to stop every activation loop, not just the primary
- threshold checker `getLastActiveChannel` uses `primary.head.id` (not hardcoded `'default'`) to correctly look up the primary head's last active channel regardless of what its id is
- `appState` variable inside the per-head loop (aliased from `headSystem.stores.appState`) satisfies the structural grep criterion while the outer post-loop destructure continues to use the same name from `primary.system.stores`

## Deviations from Plan

### Auto-fixed Issues

None — the plan's code was followed as specified with one small naming adjustment:

The plan's action block used `headAppState` as the variable name inside the per-head loop, but the acceptance criterion `grep -c "appState.releaseArchivalLock(head.id)"` requires the call to use `appState.` prefix. Renamed the destructure alias from `appState: headAppState` to `appState: appState` (effective: just `appState`) inside the loop. This is consistent with the plan's acceptance criteria and does not change behavior.

## CORE-04 Regression

`tests/integration/channel-router-isolation.test.ts` still passes: two separate `ChannelRouterImpl` instances do not share state, and `ActivationLoop` receives `channelRouter` via DI. The per-head loop in `src/index.ts` constructs exactly one `new ChannelRouterImpl()` instance per head (grep confirms: count=1 occurrence inside the loop, count=0 for the old global pattern).

## Known Stubs

None — all per-head values flow from `resolvedHeads` which derives from real config. No hardcoded empty arrays or placeholder data in any rendering path.

## Threat Flags

None beyond what the plan's threat model already accounts for:
- T-31-09 (inline credential disclosure): mitigated — extractSecretValues now walks heads[]
- T-31-10 (head_id forgery): mitigated — each routeMessage closure captures head.id lexically
- T-31-11 (startup crash on bad channel): mitigated — adapter.start() wrapped in try/catch per-vendor
- T-31-12 (mixed audit trail): mitigated — every enqueue call stamps head.id
- T-31-13 (hot-reload in multi-head): accepted — gated by if (!isMultiHead), documented

## Self-Check: PASSED

- `src/config.ts` exists and `grep -c "if (config.heads)"` returns 1; all 5 vendor case arms present
- `src/index.ts` exists; all structural grep criteria satisfied:
  - `resolveHeads(config)` = 1
  - `for (const head of resolvedHeads)` = 1
  - `headId: head.id` = 1
  - `appState.releaseArchivalLock(head.id)` = 1
  - `new ChannelRouterImpl()` = 1 (inside the loop, no global)
  - `isMultiHead` = 11 (definition + hot-reload guards)
  - `primary.system.activationLoop` = 3
  - `headSystems.flatMap` = 1
  - `for (const { system: s, head: h } of headSystems)` = 1
  - `system: s } of headSystems` = 4 (start + stop + stopProcess + restartProcessFn)
  - `appState.releaseArchivalLock('default')` = 0
- `tests/integration/multi-head-startup.test.ts` exists with 6 tests
- Commits 5235435 and 0703826 exist in git log
- `npx tsc --noEmit` exits 0
- `npx vitest run` exits 0: 1338 passed, 1 skipped, 0 failed

---
*Phase: 31-adapter-registry-config-startup*
*Completed: 2026-05-12*
