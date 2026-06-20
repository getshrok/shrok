---
phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
verified: 2026-06-20T12:00:00Z
status: human_needed
score: 7/7 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Confirm sensor sub-agent completion does not produce head chatter in a live run"
    expected: "A sensor that emits subAgentEvent (e.g. the example-sensor on a short cron) spawns a background sub-agent that completes silently — no message appears in the dashboard conversation thread"
    why_human: "The relay steward at activation.ts:670 now correctly gates sensor completions via isBackgroundTrigger, but no integration test in activation.test.ts was added for the completion-path bypass (the fix commit 32872bc modified only source files, no test files). The 4 dispatch-path tests (spawns with trigger:sensor, skip, proactiveEnabled:false, head-not-woken) cover the dispatch fork; coverage of the agent_completed relay-steward fork for trigger:'sensor' exists only at the unit level (isBackgroundTrigger function itself) not as a scenario test. A live run confirms the end-to-end behavior."
---

# Phase 52: Sensor Sub-Agent Sink (Third Sink) Verification Report

**Phase Goal:** Extend the sensor primitive with a third sink (`subAgentEvent: { prompt }`) that spawns a sub-agent silently through the proactive-decision steward, bypassing the head, with the Phase-51 `event` sink renamed `headEvent`. Includes migration of workspace sensors, SKILL.md docs, CHANGELOG, and a `0.5.0` version bump.
**Verified:** 2026-06-20
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | `subAgentEvent: { prompt }` enqueues `sensor_sub_agent_trigger`; `headEvent: { text }` enqueues `sensor_event`; old `event` key enqueues nothing (SENSOR-17/18, D-01/D-02) | VERIFIED | `runner.ts:136-196` — triple-sink dispatch; `PRIORITY.SENSOR_SUB_AGENT_TRIGGER: 10` in `core.ts:207`; 5 runner tests cover rename, dead old key, new sink, malformed-skip, all-three-active |
| 2 | `sensor_sub_agent_trigger` spawns a sub-agent silently through the steward without waking the head (SENSOR-19, D-05/D-09) | VERIFIED | `activation.ts:527-530` early-return before `let typingInterval`; `handleSensorSubAgentTrigger` method at `activation.ts:1104`; 4 activation tests including `assembler.assemble` never-called test; fix commit 32872bc |
| 3 | Steward uses non-schedule-shaped prompt — no SCHEDULE/LAST_RUN/lastSkipped tokens (D-13) | VERIFIED | `sensor-dispatch.md` has no `{SCHEDULE}` or `{LAST_RUN}` tokens; `SensorDispatchContext` has no `scheduleCron`/`lastRun`/`lastSkipped`/`conditions` fields; prompt carries `{SLUG}/{SENSOR_PROMPT}/{USER_MD}/{AMBIENT}/{HISTORY}` |
| 4 | On steward LLM failure, defaults to RUN (`RUN_DEFAULT`), D-07 fail-open | VERIFIED | `proactive.ts:200-202`: catch block returns `RUN_DEFAULT`; logged as `[proactive:sensor] decision failed, defaulting to run`; test: "defaults to RUN on LLM error" in `proactive.test.ts` |
| 5 | Global proactive config honored: proactive disabled → spawn without steward; proactive enabled + skip → no spawn, no schedule-store mutation (D-05/D-06) | VERIFIED | `activation.ts:1109-1141`: proactive gate reuses same `proactiveShadow || proactiveEnabled` flags; no `markSkipped`/`advanceNextRun`/`scheduleStore.get` calls; proactive.test.ts + 2 activation tests pin this |
| 6 | Spawned agent carries `trigger:'sensor'` and `skillName:'sensor:<slug>'` (D-08); completion goes through relay steward via `isBackgroundTrigger` (CR-01 fix) | VERIFIED | `activation.ts:1153-1155`: spawn call; `isBackgroundTrigger` predicate at `agent.ts:78-80`; applied at relay steward gate `activation.ts:670`, `suspendAsQuestion` `local.ts:1044`, usage attribution `usage.ts:349` |
| 7 | Workspace sensors migrated (relay→headEvent, example-sensor→headEvent+subAgentEvent demo, calendar ambient-only), SKILL.md documents three sinks, version 0.5.0 cut (lockstep), CHANGELOG entry, tag (SENSOR-18, D-10/D-11) | VERIFIED | relay sensor: `headEvent` at line 55; example-sensor: `headEvent` at line 76, `subAgentEvent` at line 82; calendar: ambient-only confirmed; disk-space migrated (was not in plan but found and fixed per SUMMARY note); SKILL.md has `subAgentEvent` docs + which-sink table; `package.json` + `dashboard/package.json` both `"0.5.0"`; CHANGELOG `## [0.5.0] — 2026-06-20` dated; `git tag v0.5.0` confirmed |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/core.ts` | `sensor_sub_agent_trigger` QueueEvent + `PRIORITY.SENSOR_SUB_AGENT_TRIGGER: 10` | VERIFIED | Lines 173-187 (event type), line 207 (priority) |
| `src/types/agent.ts` | `'sensor'` in AgentState.trigger union; `isBackgroundTrigger` predicate | VERIFIED | Line 48 (trigger union), lines 71-80 (isBackgroundTrigger with JSDoc) |
| `src/sensors/runner.ts` | triple-sink dispatch with headEvent + subAgentEvent, no bare `event` key | VERIFIED | Lines 136-196; no `const { ambient, event }` destructure |
| `src/sensors/runner.test.ts` | 5 Phase-52 sink unit tests | VERIFIED | Lines 23-139: describe 'runSensor — triple-sink (Phase 52)' with 5 tests |
| `src/scheduler/proactive.ts` | `runSensorDispatchDecision` + `SensorDispatchContext` (no schedule-shaped fields) | VERIFIED | Lines 157-203; `SensorDispatchContext` has no scheduleCron/lastRun/lastSkipped |
| `src/scheduler/prompts/sensor-dispatch.md` | non-schedule prompt with {SLUG} and {SENSOR_PROMPT}; no {SCHEDULE}/{LAST_RUN} | VERIFIED | File present; contains both tokens; no schedule-shaped tokens |
| `src/head/activation.ts` | `handleSensorSubAgentTrigger` + early-return dispatcher branch before head-activation | VERIFIED | Lines 527-530 (early-return); lines 1104-1157 (handler) |
| `src/sub-agents/local.ts` | `suspendAsQuestion` force-completes sensor agents via `isBackgroundTrigger` | VERIFIED | Line 1044; comment correctly notes D-06 rationale |
| `src/db/usage.ts` | sensor agents routed to per-target attribution bucket via `isBackgroundTrigger` | VERIFIED | Line 349; sensor rows with `target_name:'sensor:<slug>'` go to `scheduledBySkill` map |
| `skills/sensors/SKILL.md` | three-sink contract + which-sink table + subAgentEvent docs | VERIFIED | Lines 29, 68-83; which-sink table at lines 77-82 |
| `package.json` | version 0.5.0 | VERIFIED | Line 3 |
| `dashboard/package.json` | version 0.5.0 (lockstep) | VERIFIED | Line 3 |
| `CHANGELOG.md` | `## [0.5.0] — 2026-06-20` dated + `## [next]` + subAgentEvent entry | VERIFIED | Lines 7-21; dated correctly; entry uses user language only |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `runner.ts` | `core.ts` | `PRIORITY.SENSOR_SUB_AGENT_TRIGGER` + `type:'sensor_sub_agent_trigger'` | VERIFIED | `runner.ts:182-189` enqueues with correct type and priority |
| `activation.ts (handleEvent)` | `handleSensorSubAgentTrigger` | early-return on `event.type === 'sensor_sub_agent_trigger'` before head activation | VERIFIED | `activation.ts:527-530` — branch precedes `let typingInterval` |
| `activation.ts (handleSensorSubAgentTrigger)` | `proactive.ts (runSensorDispatchDecision)` | steward gate reusing `proactiveShadow\|\|proactiveEnabled` | VERIFIED | `activation.ts:1109-1129` |
| `activation.ts (handleSensorSubAgentTrigger)` | `agentRunner.spawn` | `trigger:'sensor'`, `skillName:'sensor:${slug}'` | VERIFIED | `activation.ts:1150-1156` |
| `activation.ts (relay steward loop)` | `isBackgroundTrigger` | `!a \|\| !isBackgroundTrigger(a.trigger)` guards relay gate for sensor completions | VERIFIED | `activation.ts:670` — CR-01 fix confirmed |
| `local.ts (suspendAsQuestion)` | `isBackgroundTrigger` | force-completes sensor agents instead of suspending | VERIFIED | `local.ts:1044` — WR-01 fix confirmed |
| `usage.ts (agent attribution)` | `isBackgroundTrigger` | routes sensor rows to per-target bucket | VERIFIED | `usage.ts:349` — WR-02 fix confirmed |

### Data-Flow Trace (Level 4)

Not applicable — this phase adds a dispatch/wiring primitive, not a data-rendering component. The sensor runner and activation handler are the data producers; correctness is verifiable through code inspection and unit tests.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `sensor_sub_agent_trigger` QueueEvent type exists | `grep -q "sensor_sub_agent_trigger" src/types/core.ts` | found | PASS |
| `isBackgroundTrigger` predicate exported | `grep -q "isBackgroundTrigger" src/types/agent.ts` | found | PASS |
| No bare `event` key destructure in runner | `grep -E "const \{ ambient, event \}" src/sensors/runner.ts` | no output | PASS |
| Both package.json files at 0.5.0 | `grep "version.*0.5.0" package.json dashboard/package.json` | both match | PASS |
| git tag v0.5.0 | `git tag -l v0.5.0` | `v0.5.0` | PASS |
| sensor-dispatch.md has no schedule tokens | `grep "{SCHEDULE}\|{LAST_RUN}" src/scheduler/prompts/sensor-dispatch.md` | no output | PASS |
| relay sensor uses headEvent | `grep "headEvent" ~/.shrok/workspace/sensors/relay/sensor.mjs` | found at line 55 | PASS |

### Probe Execution

No probes declared or found — step skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SENSOR-17 | 52-01, 52-02 | Third sink (`subAgentEvent: { prompt }`) dispatches sub-agent without waking head | VERIFIED | runner.ts triple-sink; activation.ts handler; 5+4 tests |
| SENSOR-18 | 52-01, 52-03 | Phase-51 `event` renamed `headEvent`; no back-compat; workspace sensors migrated | VERIFIED | runner.ts headEvent; relay/example-sensor migrated; no old `event` key anywhere |
| SENSOR-19 | 52-02 | Routes through existing proactive steward with non-schedule prompt; schedule-less synthetic trigger; head learns result via `agent_completed` only | VERIFIED | `runSensorDispatchDecision`; `sensor-dispatch.md`; handleSensorSubAgentTrigger; relay steward gate via isBackgroundTrigger |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/db/usage.ts:375` | 375 | `trigger: 'scheduled'` hardcoded on `BySourceRow` output for all background agents | Info | Sensor spend appears in dashboard with `trigger:'scheduled'` label instead of `'sensor'`. The attribution itself is correct (per-target row with `name:'sensor:<slug>'`); only the display trigger label on the output struct is wrong. WR-02 core issue (mis-bucketing) is fixed; this is a cosmetic display residual. Does not affect goal. |

No TBD/FIXME/XXX markers found in phase-modified files.

### Human Verification Required

#### 1. End-to-end completion-path bypass (live run)

**Test:** Schedule the example-sensor on a 1-minute cron (or trigger it manually). Let it fire once so it emits a `subAgentEvent`. Observe the dashboard — specifically: does the conversation thread remain silent? Does the sub-agent appear in the agent history pane and complete without producing a head response?

**Expected:** The sub-agent appears in the agents panel (trigger: sensor, skillName: sensor:example-sensor), completes, and NO message appears in the conversation thread from the head. The relay steward suppresses it silently.

**Why human:** The fix commit 32872bc correctly updated `activation.ts:670` to use `isBackgroundTrigger` instead of `=== 'scheduled'`, and all three fix sites (relay steward, suspendAsQuestion, usage attribution) are confirmed via code inspection. However, no regression test was added in the fix commit for the `agent_completed` relay-steward fork when `trigger === 'sensor'`. The `handleSensorSubAgentTrigger` tests cover the dispatch path (spawn is called, head not woken at dispatch time), but there is no automated test asserting that a sensor sub-agent's *completion event* passes through the relay steward gate and is suppressed rather than injected. The code path is correct by inspection, but the critical finding (CR-01) that motivated the fix slipped past the original test suite — a live confirmation closes the remaining gap.

### Gaps Summary

All 7 must-haves are verified. The code for all three CR-01/WR-01/WR-02 fixes from the code review is present and correct via inspection. The one item requiring human verification is the live end-to-end confirmation of the completion-path relay steward behavior for sensor sub-agents — the fix is structurally correct but lacks a regression test that would have caught the original bug if it had existed before the review.

---

_Verified: 2026-06-20_
_Verifier: Claude (gsd-verifier)_
