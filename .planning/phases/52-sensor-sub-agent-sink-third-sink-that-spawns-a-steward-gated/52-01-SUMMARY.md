---
phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
plan: 01
subsystem: sensors
tags: [sensors, queue, types, runner, typescript]

# Dependency graph
requires:
  - phase: 51-sensor-dual-sink
    provides: "sensor_event queue type + dual-sink runner ({ ambient?, event? }) this plan renames and extends"
provides:
  - "sensor_sub_agent_trigger QueueEvent member with slug + prompt fields"
  - "PRIORITY.SENSOR_SUB_AGENT_TRIGGER: 10 (background-work tier)"
  - "'sensor' trigger enum value on AgentState.trigger (and SpawnOptions, ToolLoopOptions, UsageEntry)"
  - "runner.ts triple-sink dispatch: headEvent (renamed from event) + new subAgentEvent branch"
  - "31 runner unit tests covering all five Phase-52 sink behaviors"
affects:
  - "52-02 (steward wiring + activation handler — consumes sensor_sub_agent_trigger from queue)"
  - "52-03 (skill docs + workspace sensor migration — headEvent rename affects relay/example sensors)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Triple-sink dispatch: ambient (passive) + headEvent (active push) + subAgentEvent (silent dispatch)"
    - "Guard pattern: present + well-typed → act, else skip (not an error) — applied to headEvent and subAgentEvent"

key-files:
  created: []
  modified:
    - src/types/core.ts
    - src/types/agent.ts
    - src/sensors/runner.ts
    - src/sensors/runner.test.ts
    - src/llm/tool-loop.ts
    - src/db/usage.ts
    - src/head/assembler.ts

key-decisions:
  - "D-02 honored: no back-compat for old event key — all existing tests updated to headEvent"
  - "D-03 honored: subAgentEvent shape is { prompt: string } (object, not bare string) — symmetric with headEvent"
  - "D-04 honored: any combination of three sinks (or none) is valid"
  - "D-12 honored: dedicated queue type sensor_sub_agent_trigger, not an overloaded schedule_trigger"
  - "PRIORITY.SENSOR_SUB_AGENT_TRIGGER = 10: matches SCHEDULE_TRIGGER (background work, no live user waiting)"
  - "Rule 1 auto-fix: propagated 'sensor' to ToolLoopOptions.trigger, UsageEntry.trigger, and deriveQueryText switch in assembler.ts"

patterns-established:
  - "New QueueEvent union members follow the sensor_event JSDoc style (purpose comment + field JSDoc)"
  - "Sink guards are always try/catch with writeFailure on enqueue throw — never unguarded throws in the dispatch block"

requirements-completed: [SENSOR-17, SENSOR-18]

# Metrics
duration: 8min
completed: 2026-06-20
---

# Phase 52 Plan 01: Sensor Sub-Agent Sink Foundation Summary

**`sensor_sub_agent_trigger` queue type + PRIORITY + `'sensor'` trigger + runner triple-sink (headEvent rename + subAgentEvent sink) with 31 passing unit tests**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-20T10:50:00Z
- **Completed:** 2026-06-20T10:57:43Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added `sensor_sub_agent_trigger` QueueEvent union member with `slug` + `prompt` fields (SENSOR-17/19)
- Added `PRIORITY.SENSOR_SUB_AGENT_TRIGGER: 10` to the PRIORITY map (background-work tier, matches SCHEDULE_TRIGGER)
- Added `'sensor'` to `AgentState.trigger` union (SpawnOptions inherits automatically via `AgentState['trigger']`)
- Renamed Phase-51 `event` sink → `headEvent` in runner.ts (D-02: no back-compat)
- Added `subAgentEvent` guard/enqueue branch as an additive parallel sink (D-04: any combination valid)
- Updated all 31 runner unit tests: 5 new Phase-52 cases + existing tests updated to use `headEvent` key
- Full suite 2211/2211 green, `tsc` clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Types + priority + trigger enum** - `3b9f9e2` (feat)
   - TDD RED for Task 2 - `e8c80d9` (test)
2. **Task 2: headEvent rename + subAgentEvent sink in runner.ts** - `098e234` (feat)

## Files Created/Modified

- `src/types/core.ts` — Added `sensor_sub_agent_trigger` QueueEvent member + `SENSOR_SUB_AGENT_TRIGGER: 10` to PRIORITY; updated sensor_event JSDoc comment to reference `headEvent`
- `src/types/agent.ts` — Added `'sensor'` to `AgentState.trigger` string-literal union
- `src/sensors/runner.ts` — Renamed `event` → `headEvent` in destructure + guard block; added parallel `subAgentEvent` sink; updated JSDoc to document all three sinks
- `src/sensors/runner.test.ts` — 5 new Phase-52 test cases (headEvent rename, dead event key, subAgentEvent enqueue, malformed-skip, all-three-active); updated existing tests to use `headEvent`
- `src/llm/tool-loop.ts` — Added `'sensor'` to `ToolLoopOptions.trigger` union (Rule 1 auto-fix)
- `src/db/usage.ts` — Added `'sensor'` to `UsageEntry.trigger` union (Rule 1 auto-fix)
- `src/head/assembler.ts` — Added `sensor_sub_agent_trigger` case to `deriveQueryText` switch (Rule 1 auto-fix: exhaustiveness)

## Decisions Made

- `SENSOR_SUB_AGENT_TRIGGER: 10` matches `SCHEDULE_TRIGGER` priority — both are background work dispatches with no live user waiting. Rationale: the sensor dispatch is a schedule-less analog to a scheduled task trigger.
- `suspendAsQuestion` at `local.ts:1040` checks `trigger === 'scheduled'` — using `'sensor'` means sensor-dispatched agents that reach a question state will SUSPEND rather than auto-complete. Sensor prompts (e.g. create_reminder) should be self-contained; documented in PATTERNS.md.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Propagated 'sensor' trigger to ToolLoopOptions, UsageEntry, and assembler switch**
- **Found during:** Task 1 (types + trigger enum)
- **Issue:** Adding `'sensor'` to `AgentState.trigger` cascaded to three other types: `ToolLoopOptions.trigger` (tool-loop.ts:77), `UsageEntry.trigger` (usage.ts:23), and `deriveQueryText` switch exhaustiveness (assembler.ts:41). tsc caught all three as errors.
- **Fix:** Added `'sensor'` to both usage type definitions; added `sensor_sub_agent_trigger` case returning `trigger.slug` to the switch (unreachable in practice but required for exhaustiveness).
- **Files modified:** `src/llm/tool-loop.ts`, `src/db/usage.ts`, `src/head/assembler.ts`
- **Verification:** `npx tsc --noEmit` exits 0; full suite 2211/2211 green
- **Committed in:** `3b9f9e2` (Task 1 commit)

**2. [Rule 1 - Bug] Updated existing runner tests from event: → headEvent: key**
- **Found during:** Task 2 TDD GREEN (implementing the rename)
- **Issue:** The 7 existing dual-sink tests in runner.test.ts used `event:` key which is now dead per D-02. They correctly failed after the implementation rename (RED → implementation → existing tests now also fail because the event key is gone).
- **Fix:** Updated 7 existing tests to use `headEvent:` key; updated test names to match (event-only → headEvent-only, etc.)
- **Files modified:** `src/sensors/runner.test.ts`
- **Verification:** All 31 tests pass GREEN
- **Committed in:** `098e234` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2× Rule 1 type-cascade + test-update)
**Impact on plan:** Both fixes necessary for correctness. No scope creep — the type cascade is an inherent consequence of adding a new enum value to a discriminated union.

## Issues Encountered

None — plan executed as designed. Type cascades from adding `'sensor'` to the trigger union were expected and resolved cleanly via Rule 1.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `sensor_sub_agent_trigger` events are now enqueued by the runner and typed correctly
- Plan 02 (activation + steward wiring) can consume them: `handleSensorSubAgentTrigger` early-return in `handleEvent`, `runSensorDispatchDecision` in proactive.ts, and `sensor-dispatch.md` prompt template
- Plan 03 (skill docs + workspace sensor migration) can update `skills/sensors/SKILL.md` and the relay/example sensors to use `headEvent`

---
*Phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated*
*Completed: 2026-06-20*
