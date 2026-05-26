---
phase: 45-ring-delivery-layer-timer-ring-alarm
plan: 02
subsystem: ring
tags: [home-assistant, ring-runner, file-store, tdd, polling, led, entity-derive, fake-timers]

# Dependency graph
requires:
  - phase: 45
    plan: 01
    provides: ringVolume/ringCapHours config, AgentContext.headId, adapter getConfig/getDeviceReachableBaseUrl
provides:
  - createRingStateStore(workspacePath) returning FileStore<RingState> rooted at data/rings/
  - RingState interface keyed by `${headId}:${channelId}` (collision-safe)
  - RingRunner class: start/stop/dispatchForHead, entity derive+cache, poll loop, 24h cap
  - callHaMediaStop(haBaseUrl, entityId) standalone export for Plan 05 restart cleanup
affects:
  - 45-05 (startup wiring: instantiates RingRunner, callHaMediaStop for restart cleanup)
  - 45-04 (ring_device tool calls runner.start/stop/dispatchForHead)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "createFileStore<T> wrapper pattern (mirrors src/db/schedules.ts)"
    - "Module-level entity cache (Map<satelliteEntityId, DerivedEntities>) for /api/template derive"
    - "setInterval idempotent-guard with per-key Map<string, RingSlot> (mirrors ScheduleEvaluatorImpl)"
    - "justPlayed debounce flag per slot (Pitfall 1 — prevents rapid-fire replay on HA state lag)"
    - "callHaMediaStop standalone export — adapter-less media_stop for startup cleanup"
    - "vi.stubGlobal('fetch', mockFetch) + vi.useFakeTimers() per adapter.test.ts pattern"

key-files:
  created:
    - src/ring/store.ts
    - src/ring/store.test.ts
    - src/ring/runner.ts
    - src/ring/runner.test.ts

key-decisions:
  - "Module-level entityCache Map (vs class field) — survives singleton stop/restart cycles; cache persists across start/stop on same satellite"
  - "Per-key RingSlot Map<string, RingSlot> on class instance — supports multiple concurrent rings on different adapters from one singleton"
  - "stop() reads entity IDs from ringStore record (not from class state) so stop after restart cleanup path works identically"
  - "callHaMediaStop is a module-level standalone export (not a method) — Plan 05 imports it directly before any RingRunner instance exists"
  - "runner.stop() delegates the media_stop step to callHaMediaStop — single implementation, zero duplication"
  - "justPlayed=true set on initial play in start() — first poll tick is always a debounce skip, not a state check"

requirements-completed: [RING-01, RING-05, RING-06, RING-07, RING-09, RING-10, RING-11]

# Metrics
duration: 8min
completed: 2026-05-26
---

# Phase 45 Plan 02: Ring Delivery Layer — Ring-state store + headless RingRunner Summary

**Per-channel persisted RingState (keyed headId:channelId) + RingRunner class with entity derive/cache, poll/replay loop (zero queue activation), LED, volume, 24h cap, and standalone callHaMediaStop for restart cleanup — all proven with mock fetch + fake timers**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-26T13:00:00Z
- **Completed:** 2026-05-26T13:08:00Z
- **Tasks:** 2 (TDD RED + GREEN for each)
- **Files created:** 4

## Accomplishments

- Created `src/ring/store.ts`: `RingState` interface (id, headId, channelId, mediaPlayerEntityId, ledEntityId, startedAt, source) + `createRingStateStore(workspacePath)` wrapping `createFileStore<RingState>` at `data/rings/`; id keyed `${headId}:${channelId}` (collision-safe per Pitfall 4); no migration, no update()
- Created `src/ring/runner.ts`: `RingRunner` class with start/stop/dispatchForHead; module-level `entityCache` Map; per-key `RingSlot` Map; D-05-safe HA REST helpers; `callHaMediaStop` standalone export; RING-05-clean poll loop (zero enqueue/activate)
- `start()`: derive via two `/api/template` calls (cached), volume_set, play_media (`/media/ring.mp3`, `media_content_type:'music'`), light.turn_on; saves RingState record; starts setInterval poll + setTimeout 24h cap
- Poll loop: `justPlayed` debounce prevents replay on first tick; idle state → replay + set justPlayed; playing → skip
- `stop()`: clears both timers, media_stop via callHaMediaStop, light.turn_off (if LED), deletes record
- 36 tests passing: store (12) + runner (24 including fake-timer 24h cap + cap-cleared-on-explicit-stop)

## Task Commits

1. **Task 1 GREEN: RingState store + tests** — `d2977e0` (feat)
2. **Task 2 RED: failing runner tests** — `9bcac6f` (test)
3. **Task 2 GREEN: RingRunner + callHaMediaStop** — `ad9159a` (feat)

## Files Created

- `/home/thenasty/shrok/src/ring/store.ts` — RingState interface + createRingStateStore factory
- `/home/thenasty/shrok/src/ring/store.test.ts` — 12 tests: round-trip, list, delete, null ledEntityId, collision-avoidance
- `/home/thenasty/shrok/src/ring/runner.ts` — RingRunner class + callHaMediaStop standalone export
- `/home/thenasty/shrok/src/ring/runner.test.ts` — 24 tests: derive+cache, volume, play, LED, poll/replay, cap, restart-safe stop

## Grep Gates (All Pass)

- `grep -c "queueStore\|\.enqueue(\|activationLoop\|notify()" src/ring/runner.ts` → **0** (RING-05)
- `grep -c "assist_satellite" src/ring/runner.ts` → **0** (never announce the beep)
- `grep -c "export async function callHaMediaStop" src/ring/runner.ts` → **1**
- `grep -c "play_media\|media_stop\|volume_set\|/api/template\|/api/states" src/ring/runner.ts` → **10** (all five HA REST surfaces present)
- HA_ACCESS_TOKEN: only appears in `process.env['HA_ACCESS_TOKEN']` reads and "not set" error messages — never in log.* or throw strings containing token value (D-05)

## Decisions Made

- Module-level `entityCache` Map (vs class field) survives singleton stop/restart cycles; entities cached permanently per satellite across start/stop calls
- Per-key `RingSlot` Map on the class instance supports multiple concurrent rings on different adapters from one singleton (CONTEXT.md: one global singleton with keyed state)
- `stop()` reads entity IDs from the ring store record (not from in-memory state) — makes the stop path work identically whether called live or after a restart reconstruction
- `callHaMediaStop` is a module-level standalone function (not a method) — Plan 05 imports it before any RingRunner instance exists (startup cleanup path, RESEARCH Pitfall 5)
- `justPlayed=true` set on the initial play in `start()` — the first poll tick is always a debounce skip; the second tick performs the first real state check

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written, including the TDD RED→GREEN cadence.

The only runtime adjustment was in the idle-replay test: the plan's pseudocode implied the first poll tick would check state (making the idle→replay test advance 1 tick). In the implementation, `justPlayed=true` is set at start so the first tick is the debounce skip and the second tick does the real check. The test was corrected to advance 2 ticks — this is the correct behavior per Pitfall 1 and the RESEARCH pseudocode's `justPlayed` debounce spec.

## Known Stubs

None — all behavior is fully implemented and exercised by the test suite. `callHaMediaStop` is a complete standalone implementation; the entity cache is live. The runner is ready to be wired in Plan 05.

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. All three STRIDE mitigations implemented:
- **T-45-02-TOK**: token read via `process.env['HA_ACCESS_TOKEN']` at call time; not stored; not in any log.* arg or thrown Error message; grep gate confirmed (D-05)
- **T-45-02-LOOP**: poll loop body contains ONLY HA REST fetch calls; grep gate `queueStore|.enqueue(|activationLoop|notify()` = 0 (RING-05)
- **T-45-02-CAP**: 24h cap setTimeout stored in RingSlot; cleared in `stop()` before issuing media_stop (Pitfall 7); fake-timer test confirms cap fires AND that advancing past cap after explicit stop issues no extra media_stop

## Next Phase Readiness

- Plan 03 (beep route + Host-header capture): independent of runner; can proceed
- Plan 04 (ring_device tool): imports `RingRunner` from `./runner.js`; `start/stop/dispatchForHead` are all ready
- Plan 05 (startup wiring): instantiates `RingRunner(ringStore, config)` and imports `callHaMediaStop` for restart cleanup loop

---
*Phase: 45-ring-delivery-layer-timer-ring-alarm*
*Completed: 2026-05-26*
