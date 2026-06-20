# Phase 52: Sensor sub-agent sink — third sink that spawns a steward-gated sub-agent - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 52-Sensor sub-agent sink
**Areas discussed:** Sink key names + payload shape, Steward gating policy, Sub-agent observability + output, Sensor-author contract + migration

---

## Format note

Three core decisions were settled BEFORE this phase was opened (in the conversation that motivated it) and were carried in as locked, not re-asked:
1. Rename the sink fields — distinct **head event** vs **sub-agent event** (no back-compat).
2. The sub-agent event carries a **prompt** only (no task-name field) — prompt is the universal, composable interface.
3. Route through the **existing steward** (reused, not duplicated), with a rephrased non-schedule-shaped prompt variant.

For the four remaining open areas, the user asked Claude to propose answers for each and correct as needed (rather than a per-question turn). Claude proposed; user replied **"approved"** with no corrections.

---

## Sink key names + payload shape

| Option | Description | Selected |
|--------|-------------|----------|
| `headEvent` / `subAgentEvent`, sub-agent = object `{ prompt }` | Literal self-documenting keys; both active sinks symmetric objects; room for future opts | ✓ |
| Sub-agent sink = bare prompt string | Simplest; asymmetric with `headEvent:{text}`; future opts would need a breaking change | |

**User's choice:** Approved Claude's proposal — `{ ambient?, headEvent?:{text}, subAgentEvent?:{prompt} }`; object not bare string for extensibility.
**Notes:** Inner keys deliberately distinct: `text` (observation) vs `prompt` (instruction). Any combination of sinks valid; `ambient`+`subAgentEvent` is the common case.

---

## Steward gating policy

| Option | Description | Selected |
|--------|-------------|----------|
| Always gated, honor global proactive config, fail-open to RUN | Mirrors scheduled-task semantics exactly; reuse not duplicate | ✓ |
| Per-sensor ungated/bypass flag | Guaranteed dispatch; rejected as a runaway-cost footgun | |
| Fail-closed to SKIP on steward error | Inconsistent with the task path's `RUN_DEFAULT` | |

**User's choice:** Approved — always gated, no bypass; honor `proactiveEnabled`/`proactiveShadow`; default RUN on steward LLM failure.
**Notes:** The sensor already deterministically decided something happened; the steward is a refinement, so fail-open is right.

---

## Sub-agent observability + output

| Option | Description | Selected |
|--------|-------------|----------|
| Label by sensor slug; reuse existing `agent_completed`/relay-steward path, no new suppression | Xray shows which sensor dispatched; silent-by-default via the existing gate; failures can still surface | ✓ |
| Build dedicated suppression so completion never surfaces | Extra machinery; would also hide genuine failures | |

**User's choice:** Approved — `skillName: sensor:<slug>`, prefer `trigger:'sensor'` if cheap else reuse `'scheduled'`; reuse completion+relay-steward, no new suppression.
**Notes:** The dispatch never touches the head; only the eventual completion does, exactly like a scheduled task.

---

## Sensor-author contract + migration

| Option | Description | Selected |
|--------|-------------|----------|
| SKILL.md documents all three sinks + "which do I pick"; migrate relay+example, verify calendar untouched | Clear authoring guidance; accurate blast radius | ✓ |

**User's choice:** Approved.
**Notes:** Migration reality: calendar is ambient-only → untouched; relay `event`→`headEvent` (genuine head-wake); example → `headEvent` + a `subAgentEvent` demo.

---

## Claude's Discretion

- **Queue wiring mechanism** — Claude leans toward a dedicated queue event type over overloading `schedule_trigger`; planner settles it (new type vs. extended trigger with null scheduleId + inline prompt), plus priority in the 10–15 band.
- **Steward prompt variant** — Claude leans toward a new `prompts/sensor-dispatch.md` fed sensor slug + prompt + ambient/USER.md/history (dropping `SCHEDULE`/`LAST_RUN`), likely a sibling decision function to `runProactiveDecision`.

## Deferred Ideas

- Calendar pre-meeting nag-reminder sensor (the motivating consumer) — its own later deliverable; dedup in its `state.json`, not the framework.
- Optional `subAgentEvent` fields (`label`, `model`) — the object shape leaves room; add on concrete need.
