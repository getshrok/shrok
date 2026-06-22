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
**Plans:** 3/3 plans complete

Plans:
**Wave 1**
- [x] 52-01-PLAN.md — contract foundation: sensor_sub_agent_trigger queue type + PRIORITY, 'sensor' trigger enum, runner event→headEvent rename + subAgentEvent sink (SENSOR-17/18) + Wave-0 runner tests

**Wave 2**
- [x] 52-02-PLAN.md — runSensorDispatchDecision + sensor-dispatch.md prompt + handleSensorSubAgentTrigger (steward-gated, head-bypassing spawn) (SENSOR-19) + proactive/activation tests

**Wave 3**
- [x] 52-03-PLAN.md — SKILL.md three-sink docs + workspace-sensor migration + CHANGELOG entry + cut v0.5.0 (SENSOR-18)

### Phase 53: Persist sub-agent inbound messages — make the DB a complete record of every sub-agent turn

**Goal:** Persist every *inbound* message a sub-agent receives to `agent_messages` at the moment it enters the conversation, with the `injected` flag — mirroring how the head persists both sides to its `messages` table (`src/head/activation.ts:555`, `src/head/injector.ts`). Today sub-agents persist only LLM-*generated* output (assistant turns, tool calls/results) via the `runToolLoop` `appendMessage` callback; the inbound half lives only in the in-memory `history` array and is never written to the DB. Inject points to cover in `src/sub-agents/local.ts`: the initial **task** user-message (`runLoop`, ~497–504), **`message_agent` updates** (inbox `update`, top-of-loop ~660–665 and the `onRoundComplete` path ~875 — unify to one idempotent persist guarded by `markProcessed`), **resume/`signal` answers** (~672–677), **sub-agent completion/question/failure notices** (~715–721), and the **synthetic skill/MEMORY reads** (~557–564, persisted as `injected` tool messages). **Additive — no change to loop control flow** (the in-memory array stays as the working buffer; it's removed in Phase 54). Delivers: (1) the dashboard agent-stream view (`dashboard/src/pages/ConversationsPage.tsx`, `AgentStreamView`) renders the full inbound+outbound back-and-forth for free — `MessageBubble` already handles `role:user` and `injected` messages; and (2) fixes the suspended-agent **resume divergence** where the in-memory resume path (live emitter, `update()` ~262–264) and the DB resume path (`resumeSuspended` ~409, loads `state.history`) see *different* histories, so an agent resumed via the DB path can forget an inbound instruction it received. Open decision for planning: retire `work_start`'s index role in favor of the `injected` filter now, or defer to Phase 54.
**Requirements**: No REQ-IDs mapped — must-haves derived from the ROADMAP goal + 53-CONTEXT.md LOCKED decisions. (Open decision RESOLVED in CONTEXT.md: `work_start` index is DEFERRED to Phase 54 — left untouched here.)
**Depends on:** Phase 52
**Plans:** 1/1 plans complete

Plans:
- [x] 53-01-PLAN.md — persistInbound helper + persist every inbound inject point (initial task as a separate message, message_agent unified+idempotent, resume answers, sub-agent notices, injected skill reads) + tests (persistence, single-store, no-duplicate-first-turn, injected skill reads) + CHANGELOG

### Phase 54: Single source of truth for sub-agent history — DB-backed loop, no long-lived in-memory array

**Goal:** Eliminate the long-lived in-memory `history` array as a second source of truth for sub-agents, collapsing them onto the head's model where the DB is canonical. After Phase 53 every message is persisted at inject time, so the in-memory array can become a **transient per-invocation buffer** (rebuilt from the DB on each entry) instead of state carried across idle gaps. Changes in `src/sub-agents/local.ts`: (1) **load history from the DB on each loop entry/wake** — mirroring the head's `assembler.ts:201` `messages.getRecent(...)` with `historyBudget` windowing — and drop the array when the loop parks (suspend / inbox wait); sub-agents routinely sit idle for minutes (waiting on a bash call, finished prior work, or suspended on a question awaiting a `message_agent` answer), so idle agents should hold zero conversation in memory. (2) **Collapse the two `update()` resume paths into one DB-sourced path** — the live-emitter in-memory path (~262–264) and the `resumeSuspended` DB path (~266 / 409) currently diverge; unify the *history source* to the DB (still wake a parked poller vs. start a fresh loop, but read history uniformly). (3) **Retire the `work_start` index** in favor of the `injected`-flag filter (it's already out of step with the persisted array). `runToolLoop` keeps its transient working buffer and round-by-round `appendMessage` persistence — no change there; the head holds an in-memory buffer mid-loop too. Performance is a non-issue (synchronous local SQLite reads at loop-entry/wake, not per round — the head already does this every turn); memory strictly improves for idle agents. Restart behavior unchanged: running agents are still reaped on boot (`src/index.ts:349–358`), not resumed. Core-loop refactor of `loopIteration` — needs thorough tests (resume-after-idle, mid-loop `message_agent`, compaction interaction, suspend→answer→continue).
**Requirements**: No REQ-IDs mapped — internal refactor; must-haves derived from the ROADMAP goal + 54-CONTEXT.md LOCKED decisions (DB-sourced loop entry, two-`update()`-path unification, `work_start` retirement, anti-double-injection). Behaviors covered by tests T1–T7 (54-VALIDATION.md).
**Depends on:** Phase 53
**Plans:** 3 plans

Plans:
**Wave 1**
- [ ] 54-01-PLAN.md — Author T1–T7 RED tests in agents.test.ts (DB-sourced history, anti-double-injection, restart-reaping regression); Phase 53 tests A–D stay green

**Wave 2** *(blocked on Wave 1)*
- [ ] 54-02-PLAN.md — AgentStore.getHistoryWithinBudget + stmtGetMessagesDesc (mirror MessageStore.getRecent); budget-windowed chronological DB read

**Wave 3** *(blocked on Waves 1+2)*
- [ ] 54-03-PLAN.md — DB-reload restructure of loopIteration + nudge ordering + work_start retirement + update() path unification + resumeSuspended no-re-inject; turns T1–T7 green; full-suite regression gate
