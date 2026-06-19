---
phase: 45
plan: 05
subsystem: ring-delivery-wiring
tags: [ring, startup, wiring, index, system]
dependency_graph:
  requires: [45-02, 45-04]
  provides: [RING-02, RING-10, RING-11]
  affects: [src/index.ts, src/system.ts]
tech_stack:
  added: []
  patterns:
    - exactOptionalPropertyTypes-safe conditional spread for optional dep threading
    - Fire-and-forget cleanup with .catch() + unconditional state delete (Pitfall 5)
    - Lazy resolver closure over haAdapters (populated after construction, read at call-time)
    - Narrowed config object to satisfy exactOptionalPropertyTypes for optional RingConfig fields
key_files:
  created: []
  modified:
    - src/system.ts
    - src/index.ts
decisions:
  - "RingRunner ctor takes 2 args (store + config) — resolver is not stored at construction; passed separately to initRingTool and dispatchForHead"
  - "exactOptionalPropertyTypes fix: publicBaseUrl spread using conditional spread rather than passing full Config directly to RingRunner"
  - "Cleanup is fire-and-forget: callHaMediaStop(...).catch(...) with no await; ringStore.delete runs unconditionally so a crashed HA boot does not stall startup"
metrics:
  duration: 8min
  completed: "2026-05-26"
  tasks: 2
  files: 2
---

# Phase 45 Plan 05: Wire Ring Delivery Layer into Running Process Summary

**One-liner:** RingRunner + ring-state store instantiated at startup, initRingTool wired with haAdapters resolver, ringRunner threaded through SystemDeps → toolExecutorOpts → HeadToolExecutor, and restart cleanup stops only persisted-ringing players fire-and-forget.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Thread ringRunner through SystemDeps → toolExecutorOpts | aa55062 | src/system.ts |
| 2 | Instantiate RingRunner, initRingTool, restart cleanup, pass to buildSystem | 78389b0 | src/index.ts |

## What Was Built

**Task 1 — src/system.ts:**
- Added optional `ringRunner?: import('./ring/runner.js').RingRunner` to `SystemDeps` interface (after `customPrompt?`, Phase 45 comment, mirrors `scheduleStore?` pattern)
- Added conditional spread `...(deps.ringRunner ? { ringRunner: deps.ringRunner } : {})` in `toolExecutorOpts` (after the `spawnAgentNote` spread, exactOptionalPropertyTypes-safe — no `ringRunner: undefined` literal)
- The spread flows automatically into `HeadToolExecutor` via the existing `activationLoop` `toolExecutorOpts` spread, closing the `ring_device(stop)` dismiss path (RING-02)

**Task 2 — src/index.ts:**
- Added imports: `createRingStateStore` from `./ring/store.js`; `RingRunner`, `callHaMediaStop` from `./ring/runner.js`; `initRingTool` from `./ring/tool.js`
- After `haAdapters` declaration, before per-head loop: constructs `ringStore`, builds a narrowed `ringConfig` object (conditional spread for `publicBaseUrl` to satisfy `exactOptionalPropertyTypes`), instantiates `ringRunner = new RingRunner(ringStore, ringConfig)`, calls `initRingTool(ringRunner, resolver)` where resolver is a lazy closure over `haAdapters`
- Passes `ringRunner` to `buildSystem({...})` so each head's executor gets it
- Per-head restart cleanup loop after `requeueStale`, before channel/adapter build: iterates `ringStore.list().filter(r => r.headId === head.id)`, resolves `haBaseUrl` from the head's HA channel config, fire-and-forgets `callHaMediaStop(haBaseUrl, staleRing.mediaPlayerEntityId).catch(...)`, then deletes the record unconditionally (RING-11)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RingRunner constructor takes 2 args, not 3**
- **Found during:** Task 2 — tsc error `Expected 2 arguments, but got 3` on line 254
- **Issue:** Plan scope reminder listed `new RingRunner(ringStore, config, (headId) => ...)` but the actual Plan 02 implementation stores the adapter resolver in `initRingTool` / `dispatchForHead`, not the constructor
- **Fix:** `new RingRunner(ringStore, ringConfig)` (2 args); resolver passed only to `initRingTool`
- **Files modified:** src/index.ts
- **Commit:** 78389b0

**2. [Rule 1 - Bug] exactOptionalPropertyTypes: full Config not assignable to RingConfig**
- **Found during:** Task 2 — tsc error on `new RingRunner(ringStore, config)` because `Config.publicBaseUrl: string | undefined` (key always present) is not assignable to `RingConfig.publicBaseUrl?: string` (key may be absent) under `exactOptionalPropertyTypes`
- **Fix:** Construct a narrowed `ringConfig` object with conditional spread `...(config.publicBaseUrl !== undefined ? { publicBaseUrl: config.publicBaseUrl } : {})` so the key is absent when not set
- **Files modified:** src/index.ts
- **Commit:** 78389b0

## Verification

All grep acceptance criteria pass:
- `grep -c "createRingStateStore\|new RingRunner\|initRingTool" src/index.ts` → 5 (>= 3)
- `grep -c "ringStore.list()" src/index.ts` → 1
- `grep -c "ringStore.delete" src/index.ts` → 1
- `grep -c "callHaMediaStop" src/index.ts` → 2
- `grep -c "await callHaMediaStop\|await ringRunner.*stop" src/index.ts` → 0 (fire-and-forget confirmed)
- `grep -c "ringRunner," src/index.ts` → 2 (passed to buildSystem)
- `grep -c "ringRunner: undefined" src/system.ts` → 0 (conditional spread only)
- `grep -c "ringRunner" src/system.ts` → 2 (SystemDeps field + toolExecutorOpts spread)

`npx tsc --noEmit` — clean.
`npx vitest run src/ring/ src/system.test.ts src/head/` — 193 tests, all passing.

## Self-Check: PASSED

Files exist:
- src/system.ts — FOUND
- src/index.ts — FOUND

Commits exist:
- aa55062 — FOUND (Task 1: system.ts)
- 78389b0 — FOUND (Task 2: index.ts)
