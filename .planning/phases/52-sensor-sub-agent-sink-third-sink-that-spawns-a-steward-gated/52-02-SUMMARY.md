---
phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
plan: 02
subsystem: sensors
tags: [sensors, proactive, activation, steward, typescript, tdd]

# Dependency graph
requires:
  - phase: 52-01
    provides: "sensor_sub_agent_trigger QueueEvent type + 'sensor' trigger enum"
provides:
  - "runSensorDispatchDecision + SensorDispatchContext in proactive.ts (non-schedule steward decision)"
  - "src/scheduler/prompts/sensor-dispatch.md (non-schedule steward prompt with {SLUG}/{SENSOR_PROMPT})"
  - "handleSensorSubAgentTrigger private method in activation.ts (slim steward-gated spawn handler)"
  - "early-return dispatcher branch in handleEvent for sensor_sub_agent_trigger"
affects:
  - "52-03 (skill docs + workspace sensor migration — handleSensorSubAgentTrigger is now wired)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-schedule steward decision: loadPrompt('sensor-dispatch') + same proactive_decision tool schema, fail-open RUN_DEFAULT"
    - "Slim activation handler: steward gate (same proactiveEnabled/proactiveShadow flags) + spawn (trigger:'sensor', skillName:'sensor:<slug>') — no scheduleStore lifecycle"
    - "Early-return dispatcher branch BEFORE head activation path — head never woken by sensor_sub_agent_trigger"

key-files:
  created:
    - src/scheduler/prompts/sensor-dispatch.md
  modified:
    - src/scheduler/proactive.ts
    - src/scheduler/proactive.test.ts
    - src/head/activation.ts
    - src/head/activation.test.ts

key-decisions:
  - "D-06 honored: same proactiveEnabled/proactiveShadow flags as task path — no parallel gate invented"
  - "D-07 honored: RUN_DEFAULT in catch block — fail-open on steward LLM failure"
  - "D-08 honored: skillName is 'sensor:<slug>' — dashboard xray shows which sensor dispatched"
  - "D-09 honored: early-return before head activation path — reuses agent_completed path, no new suppression machinery"
  - "No markSkipped on steward skip: no schedule row exists for sensor_sub_agent_trigger; just log and return"

patterns-established:
  - "SensorDispatchContext has NO schedule-shaped fields (slug/prompt/userMd/recentHistory/ambientContext/currentTime only)"
  - "handleSensorSubAgentTrigger is a verbatim slim of handleScheduleTrigger: proactive gate block reused, spawn block reused, all schedule-store lifecycle omitted"

requirements-completed: [SENSOR-19]

# Metrics
duration: 3min
completed: 2026-06-20
---

# Phase 52 Plan 02: Steward Wiring + Activation Handler Summary

**`runSensorDispatchDecision` + `sensor-dispatch.md` steward prompt + `handleSensorSubAgentTrigger` early-return handler — sensor_sub_agent_trigger events are now steward-gated and spawn `trigger:'sensor'` agents without ever waking the head, pinned by 45 passing unit tests**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-20T11:02:54Z
- **Completed:** 2026-06-20T11:06:13Z
- **Tasks:** 2
- **Files modified:** 4 (+ 1 created)

## Accomplishments

- Added `SensorDispatchContext` interface to `src/scheduler/proactive.ts` (no schedule-shaped fields: slug + prompt + userMd + recentHistory + ambientContext + currentTime)
- Added `runSensorDispatchDecision` function: mirrors `runProactiveDecision` body exactly, uses `loadPrompt('sensor-dispatch')` with `{CURRENT_TIME,SLUG,SENSOR_PROMPT,USER_MD,AMBIENT,HISTORY}` tokens, same `proactive_decision` tool schema, returns `RUN_DEFAULT` on catch (D-07 fail-open)
- Created `src/scheduler/prompts/sensor-dispatch.md`: non-schedule steward template with `{SLUG}` + `{SENSOR_PROMPT}` tokens; no `{SCHEDULE}`/`{LAST_RUN}` tokens; default-to-run guidance (sensor already deterministically decided something happened)
- Added early-return branch in `handleEvent` for `sensor_sub_agent_trigger` BEFORE `let typingInterval` (head activation path) — Pitfall 1 guard
- Added `handleSensorSubAgentTrigger` private method: slim `handleScheduleTrigger` — same proactive gate (`proactiveEnabled`/`proactiveShadow` D-06), calls `runSensorDispatchDecision`, on skip logs and returns with NO schedule-store call, spawns with `trigger:'sensor'` + `skillName:'sensor:<slug>'` (D-08)
- Added `runSensorDispatchDecision: vi.fn()` to activation.test.ts proactive mock; wired default `{ action: 'run', reason: 'ok' }` in `makeFixture`
- 5 new proactive tests + 4 new activation tests; all 45 tests green; `npx tsc --noEmit` clean throughout

## Task Commits

Each task was committed atomically:

1. **Task 1: runSensorDispatchDecision + SensorDispatchContext + sensor-dispatch.md** - `4397157` (feat)
2. **Task 2: handleSensorSubAgentTrigger handler + early-return dispatcher branch** - `55f84c5` (feat)

## Files Created/Modified

- `src/scheduler/proactive.ts` — Added `SensorDispatchContext` interface + `runSensorDispatchDecision` function (sibling to `runProactiveDecision`, reuses `ProactiveDecision` return type and `RUN_DEFAULT`)
- `src/scheduler/prompts/sensor-dispatch.md` — New non-schedule steward prompt template (CREATED)
- `src/scheduler/proactive.test.ts` — 5 new `runSensorDispatchDecision` tests: run/skip/LLM-error/malformed-JSON/context-thread
- `src/head/activation.ts` — Early-return `sensor_sub_agent_trigger` branch in `handleEvent`; new `handleSensorSubAgentTrigger` private method; import updated
- `src/head/activation.test.ts` — Added `runSensorDispatchDecision: vi.fn()` to proactive mock; wired in `makeFixture`; 4 new tests: spawn/skip-no-spawn/no-steward-when-disabled/head-not-woken

## Decisions Made

- `handleSensorSubAgentTrigger` calls no schedule-store methods: no `scheduleStore.get`, no `tasksLoader.load`, no `markSkipped`, no `advanceNextRun`, no `delete`. On steward skip, just log and return — no dedup/cooldown row exists for sensor triggers.
- `SensorDispatchContext.prompt` field name matches the `sensor_sub_agent_trigger` QueueEvent's `prompt` field (from Plan 01) — no translation layer needed.
- `stewardComplete` call uses label `'steward-sensor-dispatch'` (distinct from `'steward-proactive'` and `'steward-reminder'`) for steward run tracking/visibility.

## Deviations from Plan

None — plan executed exactly as written. All interfaces, function signatures, and test patterns matched the PATTERNS.md analogs verbatim. No new imports were needed in activation.ts (all helpers — `os`, `scanAmbient`, `estimateTokens`, `generateAgentId`, `formatIanaTimeLine`, `TextMessage` — were already imported).

## Known Stubs

None — all code paths are fully wired. The handler calls `runSensorDispatchDecision` which calls the real steward LLM via `stewardComplete`. Tests mock the steward via `vi.mock('../scheduler/proactive.js')` as expected.

## Threat Flags

None — no new network endpoints, no new auth paths, no new file access patterns beyond what was in the threat model.

## Self-Check: PASSED

- `src/scheduler/prompts/sensor-dispatch.md` FOUND
- `src/scheduler/proactive.ts` exports `runSensorDispatchDecision` FOUND
- `src/head/activation.ts` contains `handleSensorSubAgentTrigger` FOUND
- Commits `4397157` and `55f84c5` FOUND
- `npx vitest run src/scheduler/proactive.test.ts src/head/activation.test.ts` → 45/45 passed
- `npx tsc --noEmit` → clean
