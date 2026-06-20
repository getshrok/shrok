| 47. Head Runs Agent Tools | v1.9 | 3/3 | Complete | 2026-06-07 |
| 48. Sensor Backend | v1.10 | 3/3 | Complete    | 2026-06-17 |
| 49. Sensors Dashboard | v1.10 | 3/3 | Complete    | 2026-06-18 |

### Phase 50: Per-head xray isolation — eliminate cross-head agent-activity bleed in the dashboard timeline

**Goal:** When a head is selected, the dashboard shows only that head's agent activity, steward runs, memory retrievals, and agent pills — and nothing from any other head — on both initial backfill and live streaming, including across head switches. Closes the four documented "accepted cross-head leakage" surfaces (T-33-09): `agent_message_added`, `agent_status_changed`, `memory_retrieval`, `steward_run_added`. Single-head deployments see zero behavior change.
**Requirements**: D-01, D-02, D-03, D-04 (CONTEXT.md locked decisions; no REQ-IDs mapped in roadmap)
**Depends on:** Phase 49
**Plans:** 4/4 plans complete

Plans:
**Wave 1**

- [x] 50-01-PLAN.md — steward_runs head_id migration + StewardRunStore threading + head-scoping test (Wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 50-02-PLAN.md — tag the 4 leaky SSE events with headId at emit + dual DashboardEvent union lockstep (Wave 1)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 50-03-PLAN.md — head-scope the backfill REST routes (?head=) + client api wrappers (Wave 2)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 50-04-PLAN.md — expand SSE filter drop set + head-key caches + reset-on-switch effects + tests (Wave 2)

### Phase 51: Sensor dual-sink rework — structured JSON payload, per-head ambient, activation-loop event

**Goal:** Rework the `sensor` primitive (shipped in Phases 48–49) so each scheduled run emits exactly one structured JSON payload `{ ambient?, event? }` that routes to either/both of two **head-scoped** sinks: (1) a passive per-head ambient block written to `ambient/<headId>/<slug>.md` and injected only into that head's turns (pull), and (2) an active `sensor_event` enqueued into the priority queue that wakes the bound head through the activation loop (push). The target head is mandatory and taken from the sensor's schedule `headId`. Malformed stdout is a sensor error. Scripts self-watermark; the runner adds no dedup/cooldown. No back-compat with the Phase-48 stdout-is-body contract (sensors have no external users yet).

**Requirements**: SENSOR-13, SENSOR-14 (implements SENSOR-F-01), SENSOR-15, SENSOR-16
**Depends on:** Phase 48 (Sensor Backend), Phase 49 (Sensors Dashboard)
**Plans:** 4/4 plans complete
- [x] 51-01-PLAN.md — Contract layer: sensor_event QueueEvent type + PRIORITY.SENSOR_EVENT(15) + head-scoped scanAmbient signature
- [x] 51-02-PLAN.md — Runner dual-sink (JSON parse, ambient/<headId>/<slug>.md write, sensor_event enqueue) + scheduler/index headId threading
- [x] 51-03-PLAN.md — injectSensorEvent push injection + activation/assembler/deriveQueryText cases + all four scanAmbient call sites head-scoped
- [x] 51-04-PLAN.md — SKILL.md rewrite + create_schedule description + per-head dashboard DELETE + live weather sensor migration

### Phase 52: Sensor sub-agent sink — third sink that spawns a steward-gated sub-agent

**Goal:** Extend the sensor primitive (Phase 51's dual-sink `{ ambient?, event? }`) with a **third sink** so one sensor's structured JSON payload can also route to a **sub-agent event** carrying a prompt string. When emitted, it spawns a sub-agent **silently through the existing proactive-decision steward** (`src/scheduler/proactive.ts`) — bypassing the conversational head entirely (no head chatter) — by reusing the existing `kind:'task'` → `handleScheduleTrigger` (`src/head/activation.ts`) → `agentRunner.spawn` path with a synthetic, **schedule-less** trigger (no schedule row) carrying the prompt as its context. The steward gets a rephrased, **non-schedule-shaped** prompt variant for sensor-originated triggers (cron/lastRun/lastSkipped don't apply). The prompt is the universal interface — **no task-name field**; if a specific workspace task should run, the prompt itself says so. The two active sinks are **renamed for clarity**: the Phase-51 `event` (head-waking) sink becomes the **head event** sink, the new one the **sub-agent event** sink. **No back-compat** — the three workspace sensors (relay, calendar, example) are migrated. User-facing → CHANGELOG (Added) + minor version bump (both `package.json` files in lockstep).
**Requirements**: SENSOR-17, SENSOR-18, SENSOR-19
**Depends on:** Phase 51 (Sensor dual-sink rework)
**Plans:** 3 plans

Plans:
**Wave 1**
- [ ] 52-01-PLAN.md — contract foundation: sensor_sub_agent_trigger queue type + PRIORITY, 'sensor' trigger enum, runner event→headEvent rename + subAgentEvent sink (SENSOR-17/18) + Wave-0 runner tests

**Wave 2**
- [ ] 52-02-PLAN.md — runSensorDispatchDecision + sensor-dispatch.md prompt + handleSensorSubAgentTrigger (steward-gated, head-bypassing spawn) (SENSOR-19) + proactive/activation tests

**Wave 3**
- [ ] 52-03-PLAN.md — SKILL.md three-sink docs + workspace-sensor migration + CHANGELOG entry + cut v0.5.0 (SENSOR-18)
