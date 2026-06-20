# Phase 52: Sensor sub-agent sink — third sink that spawns a steward-gated sub-agent - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a **third sink** to the sensor output contract (Phase 51 gave it the dual-sink `{ ambient?, event? }`) so one sensor's structured JSON payload can also dispatch a **sub-agent** — silently, through the existing proactive-decision steward and `kind:'task'` spawn path, **without ever activating/waking the conversational head**. A cheap, deterministic sensor (no LLM in its own detection) thus triggers an LLM sub-agent only when there's something to act on, with the steward as the should-it-run gate.

**In scope:** the new `subAgentEvent` sink; renaming the Phase-51 `event` sink → `headEvent`; the queue-event + activation wiring for a schedule-less sensor-originated dispatch; a non-schedule-shaped steward prompt variant; migrating the existing workspace sensors (relay, example) and the sensor authoring docs (SKILL.md); CHANGELOG + minor version bump.

**Out of scope:** the motivating calendar→pre-meeting-nag-reminder sensor (a SEPARATE later deliverable — its meeting-dedup lives in that sensor's own `state.json`, not in this framework). No runner-level dedup/cooldown. No new scheduling primitives (reuse the `kind:'task'` spawn machinery as-is). The steward stays a "should this run now?" gate, NOT an exactly-once/dedup mechanism.

</domain>

<decisions>
## Implementation Decisions

### Sink key names + payload shape
- **D-01:** The payload contract becomes `{ ambient?: string, headEvent?: { text: string }, subAgentEvent?: { prompt: string } }`. `ambient` is unchanged.
- **D-02:** The Phase-51 `event` sink (the head-waking `sensor_event`) is **renamed `headEvent`**, inner shape unchanged (`{ text }`). No back-compat for the old `event` key — sensors have no external users.
- **D-03:** The new `subAgentEvent` is an **object `{ prompt: string }`, not a bare string** — keeps both active sinks symmetric (both objects) and leaves room for a future optional field (`label`, `model`) without another breaking rename. Inner keys stay semantically distinct: `text` = an observation to react to; `prompt` = an instruction to execute.
- **D-04:** Any combination of the three sinks in one payload is valid. `ambient` + `subAgentEvent` together is the expected common case (refresh the snapshot AND quietly dispatch). Emitting none remains a valid quiet/no-op tick.

### Steward gating policy
- **D-05:** The sub-agent dispatch is **always gated by the steward — no per-sensor bypass flag.** The silent path's whole value is that judgment; an unconditional-dispatch flag would be a runaway-cost footgun. A sensor wanting near-unconditional dispatch writes its prompt so the steward virtually always runs.
- **D-06:** **Honor the existing global proactive config** (`proactiveEnabled` / `proactiveShadow`). The sensor path REUSES the same gate the task path uses — if proactive is disabled globally, the sub-agent spawns directly exactly as scheduled tasks do today. Do not invent a parallel gate.
- **D-07:** **On steward LLM failure → default RUN**, matching the task path's `RUN_DEFAULT` (`src/scheduler/proactive.ts`). The sensor has already deterministically decided something happened; the steward is a refinement, so fail-open is correct and consistent.

### Sub-agent observability + output
- **D-08:** Label the spawned agent by the **sensor slug** so the dashboard xray shows which sensor dispatched it (e.g. `skillName: sensor:<slug>` — exact format a plan detail). Prefer a distinct **`trigger: 'sensor'`** if adding the enum value is cheap; otherwise reuse `'scheduled'`.
- **D-09:** **Reuse the existing `agent_completed` → relay/output-steward path; build NO new suppression machinery.** A "create a reminder" sub-agent produces no user-worthy output, so the existing steward already keeps it silent; a *failure* can still surface. The trigger itself never touches the head — only the eventual completion does, exactly like a scheduled task (so: no head chatter from the dispatch).

### Sensor-author contract + migration
- **D-10:** Sensor SKILL.md documents all three sinks with explicit "which do I pick" guidance: `ambient` = passive snapshot (pull); `headEvent` = wake the head for conversational judgment / to talk to the user; `subAgentEvent` = get work done quietly, no message.
- **D-11:** Migration blast radius (verify each during execution): **calendar is `ambient`-only → untouched** by the rename; **relay** uses `event:{text}` to wake the head on inbound peer messages (genuine head-wake) → becomes `headEvent`; **example-sensor** → `headEvent` + add a `subAgentEvent` demo.

### Claude's Discretion (plan-time architecture calls — leans noted, not forced)
- **D-12:** Queue wiring — **lean: a dedicated queue event type** for the sensor→sub-agent dispatch rather than overloading `schedule_trigger` (which is task-name-centric and loads a task row). A distinct type keeps the schedule-less, prompt-carrying path clean. The planner settles the exact mechanism (new type vs. extended `schedule_trigger` with null scheduleId + inline prompt) and the priority (10–15 band, alongside `schedule_trigger`=10 / `sensor_event`=15).
- **D-13:** Steward reuse — **lean: a new non-schedule prompt template** (e.g. `src/scheduler/prompts/sensor-dispatch.md`) fed the sensor slug + the prompt + ambient/USER.md/recent history, **dropping `SCHEDULE`/`LAST_RUN`/`lastSkipped`** placeholders. Likely a sibling decision function to `runProactiveDecision` (or a parameterized variant) in `src/scheduler/proactive.ts`. The prompt carried by `subAgentEvent` flows into the spawned agent's prompt the same way the steward's returned `context` already does today.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` §"v1.10.2 Requirements — Sensor Sub-Agent Sink (Phase 52)" — SENSOR-17/18/19 + Phase-52 non-goals. Read before planning.
- `.planning/REQUIREMENTS.md` §"v1.10.1 Requirements — Sensor Dual-Sink Rework (Phase 51)" — SENSOR-13–16, the contract this phase extends/renames.
- `.planning/ROADMAP.md` §"Phase 52" — goal statement + dependency on Phase 51.

### Prior-phase context (the dual-sink this builds on)
- `.planning/phases/51-sensor-dual-sink/51-CONTEXT.md` — Phase-51 decisions (if present; the dual-sink rework's locked choices).

### Implementation surface (read to ground the plan)
- `src/sensors/runner.ts` — current `{ ambient, event:{text} }` parse + `sensor_event` enqueue; where the third sink + rename land.
- `src/types/core.ts` — `QueueEvent` union + `PRIORITY` map (`SENSOR_EVENT`=15, `SCHEDULE_TRIGGER`=10); where a sensor-originated dispatch event type/priority is added.
- `src/head/activation.ts` — `handleScheduleTrigger()` runs the steward then `agentRunner.spawn()` silently (bypasses head); currently assumes a schedule row exists (`scheduleStore.get(event.scheduleId)`) — must accept a schedule-less synthetic trigger.
- `src/scheduler/proactive.ts` — `runProactiveDecision` + the `prompts/tasks.md` template (schedule-shaped); the non-schedule variant is added here.
- `src/sub-agents/local.ts` — `agentRunner.spawn(SpawnOptions)` (the `trigger`/`skillName` fields, `agent_completed`/`agent_failed` enqueue).

### Sensor authoring docs + workspace sensors to migrate
- The bundled sensor SKILL.md (Phase 51-04 rewrote it — locate under `skills/` in-repo and/or the served copy) — documents the sink contract; add the third sink + "which sink" guidance.
- `~/.shrok/workspace/sensors/relay/sensor.mjs` (uses `event:{text}` → `headEvent`), `~/.shrok/workspace/sensors/example-sensor/sensor.mjs` (→ `headEvent` + `subAgentEvent` demo), `~/.shrok/workspace/sensors/calendar/sensor.mjs` (ambient-only → verify untouched).

### Conventions
- `AGENTS.md` (repo root) — trunk-based (commit to `main`, no PRs); CI is sole writer of `dashboard/dist/`; versioning (bump both `package.json` files in lockstep + tag); CHANGELOG rules; model-facing-time invariant; `node:sqlite` + file-store conventions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`handleScheduleTrigger` → `agentRunner.spawn` path** (`src/head/activation.ts` + `src/sub-agents/local.ts`): the silent, head-bypassing spawn machinery already exists for scheduled tasks — the sensor dispatch reuses it, only needing a schedule-less entry and a prompt instead of a task body.
- **`runProactiveDecision`'s returned `context` string** (`src/scheduler/proactive.ts:189-197`): already the channel by which the steward injects extra prompt context into the spawned agent — the `subAgentEvent.prompt` rides the same mechanism.
- **`SensorEventSink` narrow interface + dual-sink dispatch block** (`src/sensors/runner.ts:130-166`): the third sink is an additive branch alongside the existing `ambient`/`event` parsing.

### Established Patterns
- **Steward = pre-spawn LLM gate that can `skip`, fails open to `run`** — the sensor path mirrors this exactly (D-05/D-06/D-07), reusing not duplicating.
- **Sensors self-watermark; the runner is stateless about "new"** (Phase-51 non-goal, carried forward) — no dedup added here.
- **Sink presence/shape guards are silent skips, not errors** (an absent/malformed `event` is skipped, only unparseable/non-object stdout is a failure) — `subAgentEvent` follows the same "present + well-typed → act, else skip" rule.

### Integration Points
- `src/sensors/runner.ts` (parse + enqueue new sink + rename) → `src/types/core.ts` (event type/priority) → `src/head/activation.ts` (schedule-less dispatch handler + steward call) → `src/scheduler/proactive.ts` (non-schedule prompt) → `src/sub-agents/local.ts` (spawn label/trigger).

</code_context>

<specifics>
## Specific Ideas

- User's framing of the win: a deterministic sensor does cheap detection every tick; the LLM sub-agent fires **only on a real hit**, gated by the steward, so the head never sends an "unnecessary message." This is the explicit motivation for routing through the task/steward path instead of the `headEvent` (wake-the-head) sink.
- Naming was a deliberate user call: **`headEvent` vs `subAgentEvent`** so a sensor author explicitly chooses head-wake-and-converse vs. silent-do-work.
- Prompt-as-universal-interface (no task-name field) was a deliberate composability call: a `subAgentEvent` prompt that wants a specific workspace task simply names it in the prompt.

</specifics>

<deferred>
## Deferred Ideas

- **Calendar pre-meeting nag-reminder sensor** — the motivating consumer of this feature. A sensor that polls Zoho calendar (reusing the existing `calendar` sensor's `_shared.mjs` helpers + skill credential store), detects meetings starting within a generous lookahead window (≥ the run cadence, e.g. next ~25–30 min), dedups on event `uid:startTime` via its own `state.json`, and emits a `subAgentEvent` whose prompt creates a 10-min-before, acknowledgment-required, 60s-nag reminder (`create_reminder` already supports `requiresAck` + `nagMinutes:1`). Past-trigger guard: if `start − 10min` is already past, fire immediately. Its own phase/deliverable — NOT this framework phase.
- **Optional `subAgentEvent` fields** (`label`, `model`) — the object shape (D-03) leaves room; add only when a concrete need appears.

</deferred>

---

*Phase: 52-Sensor sub-agent sink — third sink that spawns a steward-gated sub-agent*
*Context gathered: 2026-06-20*
