# Shrok Roadmap

## Milestones

- ✅ **v1.0 Tool-call Legibility** — Phase 1 et al. (shipped 2026-04-11)
- ✅ **v1.1 Jobs Awareness** — Phase 10 (shipped 2026-04-20)
- ✅ **v1.2 Voice Mode & Feature Enhancements** — Phases 19–28 (shipped 2026-05-12)
- ✅ **v1.3 Multi-Head Support** — Phases 29–36 (shipped 2026-05-14)
- ✅ **v1.4 Unmissable Reminders** — Phases 37–39 (shipped 2026-05-24)
- ✅ **v1.5 Home Assistant Voice** — Phases 40–43 (shipped 2026-05-24)
- ✅ **v1.6 Multi-Head Task Delivery** — Phase 44 (shipped 2026-05-24)
- ✅ **v1.7 Voice Alarms & Timers** — Phase 45 (shipped 2026-06-07)
- [ ] **v1.8 Tool Access Control** — Phase 46 (in progress)

Full per-phase detail for shipped milestones lives in `.planning/milestones/` and `.planning/MILESTONES.md`.

## Phases

<details>
<summary>✅ v1.0 Tool-call legibility (Shipped: 2026-04-11)</summary>

### Phase 1: Tool-call legibility

**Goal:** Add description field to all tool schemas so model emits one-sentence intent per call.

</details>

<details>
<summary>✅ v1.1 Jobs Awareness (Shipped: 2026-04-20)</summary>

### Phase 10: Jobs Awareness

**Goal:** Surface jobs system to agents via system prompt and auto-injection.

</details>

<details>
<summary>✅ v1.2 Voice Mode & Feature Enhancements (Shipped: 2026-05-12)</summary>

### Phase 19: Backend voice pipeline

**Goal:** STT/TTS server endpoints and WebSocket voice session handling.

### Phase 20: Vite build configuration

**Goal:** Configure Vite to include VAD WASM/ONNX assets in production build.

### Phase 21: React voice UI state machine

**Goal:** useReducer FSM with four mutually exclusive voice states.

### Phase 22: Error handling & accessibility

**Goal:** Mic permission errors, API failures, and ARIA labels for voice controls.

### Phase 23: Timezone-aware scheduling

**Goal:** Bootstrap timezone collection and apply to schedule triggers.

### Phase 24: Message agent mid-loop delivery

**Goal:** Deliver head messages to long-running agents mid-execution.

### Phase 25: Migrate agent history from JSON blob to agent messages rows

**Goal:** Replace JSON blob storage with per-row agent message table.

### Phase 26: Validate skill md and task md frontmatter on write-file

**Goal:** Frontmatter validation when writing SKILL.md and TASK.md files.

### Phase 27: Rename workspace-path env var to shrok-workspace-path

**Goal:** Rename $WORKSPACE_PATH to $SHROK_WORKSPACE_PATH across all sub-agent SYSTEM.md files.

### Phase 28: Add optional prompt parameter to memory functions

**Goal:** Expose ICW PromptOverrides to end users via editable MEMORY-*.md files; ship defaults, workspace overrides win.

</details>

<details>
<summary>✅ v1.3 Multi-Head Support (Phases 29–36) — SHIPPED 2026-05-14</summary>

One Shrok process runs several independent heads (own activation loop, adapters, schedules, agents) sharing one identity + memory + SQLite DB, via a `head_id` column with a backward-compatible implicit `default` head. Plus `[Name]:` inbound sender attribution.

- [x] Phase 29: Data Layer (3/3) — completed 2026-05-12
- [x] Phase 30: Core Activation (3/3) — completed 2026-05-12
- [x] Phase 31: Adapter Registry & Config & Startup (3/3) — completed 2026-05-12
- [x] Phase 32: Dashboard Head Selector (3/3) — completed 2026-05-12
- [x] Phase 33: Multi-head Management UI (7/7) — completed 2026-05-13
- [x] Phase 34: Multi-Head Agent Lifecycle (5/5) — completed 2026-05-14
- [x] Phase 35: Per-Head Scheduling (4/4) — completed 2026-05-14
- [x] Phase 36: Inbound Sender Attribution (3/3) — completed 2026-05-14

📄 Full detail: [`milestones/v1.3-ROADMAP.md`](milestones/v1.3-ROADMAP.md)

</details>

<details>
<summary>✅ v1.4 Unmissable Reminders (Phases 37–39) — SHIPPED 2026-05-24</summary>

Opt-in acknowledgment-required reminders that re-nag on a configurable interval until explicitly acked (system-native re-arm before delivery; type-scoped ack semantics), plus dashboard ack/nag + recurring start-date controls.

- [x] Phase 37: Schema & Tool Params (2/2) — completed 2026-05-23
- [x] Phase 38: Nag Mechanism & Ack Semantics (4/4) — completed 2026-05-23
- [x] Phase 39: Dashboard Reminder UI (3/3) — completed 2026-05-24

📄 Full detail: [`milestones/v1.4-ROADMAP.md`](milestones/v1.4-ROADMAP.md)

</details>

<details>
<summary>✅ v1.5 Home Assistant Voice (Phases 40–43) — SHIPPED 2026-05-24</summary>

A `home-assistant` channel adapter bridging Shrok's async, delegating head to Home Assistant's Assist pipeline — an OpenAI-compatible `/v1/chat/completions` inbound endpoint (in-turn reply within a ~3s deadline, else lapse to the announce path) and unprompted `assist_satellite.announce` / `start_conversation` callbacks for async sub-agent results, reminders, and scheduled fires. Converse-only. Validated end-to-end on the real Voice PE.

- [x] Phase 40: Config & Adapter Skeleton (2/2) — completed 2026-05-24
- [x] Phase 41: Inbound Synchronous Reply Endpoint (4/4) — completed 2026-05-24
- [x] Phase 42: Outbound HA REST Announce (2/2) — completed 2026-05-24
- [x] Phase 43: End-to-End Smoke Test & Setup Docs (3/3) — completed 2026-05-24

📄 Full detail: [`milestones/v1.5-ROADMAP.md`](milestones/v1.5-ROADMAP.md)

</details>

<details>
<summary>✅ v1.6 Multi-Head Task Delivery (Phase 44) — SHIPPED 2026-05-24</summary>

A scheduled **task** runs once but fans out its `agent_completed` to every head in the deduped delivery set `[headId, ...deliverToHeadIds]` (the work runs once, the report reaches N heads), via an optional `Schedule.deliverToHeadIds` threaded through spawn → agent record → both completion sites. Scheduled agents force-complete instead of suspending-as-question (no human in the loop). Reminders unchanged. Dashboard task form gained a "deliver to" multi-select with N colored head chips.

- [x] Phase 44: Multi-head task delivery (5/5) — completed 2026-05-24

📄 Full detail: [`milestones/v1.6-ROADMAP.md`](milestones/v1.6-ROADMAP.md)

</details>

<details>
<summary>✅ v1.7 Voice Alarms & Timers (Phase 45) — SHIPPED 2026-06-07</summary>

- [x] **Phase 45: Ring Delivery Layer + Timer Ring + Alarm** — Sustained, dismiss-until-stopped audible alerts on Home Assistant voice channels for both timers and alarms, via a shared headless ring runner, `ring_device(start|stop)` tool, auto-derived entities, shrok-served beep, and a new `set-alarm` skill (completed 2026-05-26)

</details>

## v1.8 Tool Access Control

- [x] **Phase 46: Tool Access Control** — Config-driven tool allowlists (global + per-head, two-state inherit/subset) enforced at runtime for both the head's own tool surface and the tools given to the agents it spawns, each restricted to that layer's currently-executable tools, with dashboard UI for editing both layers (completed 2026-06-07)

## Phase Details

### Phase 45: Ring Delivery Layer + Timer Ring + Alarm
**Goal**: Users on Home Assistant voice channels hear a sustained, repeating alert when a timer elapses or alarm fires, and can dismiss it by voice — the alert runs headless (no per-beep LLM activation), the beep is served from shrok itself, entities are auto-derived from the existing satellite config, and the alarm is a persisted non-ack reminder that survives restart
**Depends on**: Phase 44 (v1.6 shipped — existing HA channel adapter, `assist_satellite` announce, reminder system, timer skill)
**Requirements**: RING-01, RING-02, RING-03, RING-04, RING-05, RING-06, RING-07, RING-08, RING-09, RING-10, RING-11, TIMER-01, TIMER-02, ALARM-01, ALARM-02, ALARM-03
**Success Criteria** (what must be TRUE):
  1. A voice-set timer that elapses keeps beeping on the Voice PE until the user says "stop" — the sound cuts promptly and does not resume
  2. A voice-set alarm set for a specific time rings at that time and keeps beeping until the user says "stop", and the alarm persists across a shrok restart (fires at the correct time after restart)
  3. A "stop" or "turn it off" voice command — spoken while the beep is playing — reaches shrok as a normal turn, calls `ring_device(stop)`, and silences the device within one polling cycle; the LED ring clears at the same time
  4. The ring loop generates no LLM API calls between start and dismiss; only the start turn and the dismiss turn touch the model
  5. Calling `ring_device` on a non-HA channel (Telegram, Discord, etc.) silently no-ops — timers and alarms work on all channels with no error
**Plans**: 6 plans
  - [x] 45-01-PLAN.md — Shared contracts: ring config fields, AgentContext.headId, HA adapter base-URL cache + config getters (Wave 1)
  - [x] 45-02-PLAN.md — Ring-state store + headless RingRunner (poll/replay, entity derive+cache, LED, volume, 24h cap) (Wave 2)
  - [x] 45-03-PLAN.md — Bundled beep + unauthenticated /media/ring.mp3 route + Host-header base-URL capture (Wave 2)
  - [x] 45-04-PLAN.md — ring_device(start|stop) dual-surface tool (HEAD_TOOLS + OPTIONAL_TOOLS), no-op on non-HA (Wave 3)
  - [x] 45-05-PLAN.md — Startup wiring: RingRunner instantiation, initRingTool, ringRunner threading, restart cleanup (Wave 4)
  - [x] 45-06-PLAN.md — Timer skill ring hook + new set-alarm non-ack reminder skill + content tests (Wave 4)
**UI hint**: no

### Phase 46: Tool Access Control
**Goal**: Operator has config-driven, dashboard-editable control over which tools each head may use and which tools each head's sub-agents may use — globally as a default and overridable per-head, each layer restricted to the tools it can currently execute — enforced at runtime with pre-feature defaults so no existing deployment is silently broken
**Depends on**: Phase 45 (v1.7 shipped — existing HEAD_TOOLS surface at activation.ts:844, OPTIONAL_TOOL_NAMES registry, worker_defaults.allowedTools + assembleTools() enforcement path, /api/tools endpoint, head management UI)
**Requirements**: TOOLCFG-01, TOOLCFG-02, TOOLCFG-03, TOOLCFG-04, TOOLCFG-05, TOOLCFG-06, TOOLCFG-07, TOOLCFG-08, TOOLCFG-09
**Mode**: re-plan (assignment-only; reshape scaffolding on main — TOOLCFG-10/11 cross-context executors deferred; see 46-CONTEXT.md)
**Success Criteria** (what must be TRUE):
  1. A head with an explicit head-tool allowlist is offered only those tools at runtime — tools not in the allowlist do not appear in the model's tool surface for that head, including core orchestration tools if deliberately omitted (within the head-executable set)
  2. Sub-agents spawned by a head with an agent-tool allowlist receive only the tools from that head's resolved agent allowlist — the restriction threads from the spawning head through into assembleTools()
  3. A head with no tool configuration reproduces the pre-feature head default set (the 10 head-executable tools incl. spawn_agent, message_agent, cancel_agent) — no existing or newly-created head is silently broken on upgrade
  4. The Settings page shows pickers for the global head-tool and global agent-tool allowlists (surfacing the existing worker_defaults.allowedTools), each populated from the single tagged /api/tools registry filtered to its layer, and changes persist to config
  5. The per-head management UI shows each head's head-tool and agent-tool overrides as a two-state control — an explicit "inherit global" state visually distinct from a chosen tool subset — chosen independently for head tools and agent tools
  6. Resolution correctly honors the two-state two-layer rule: per-head override (if set) wins over the global default, which is the pre-feature default fallback — verified for both head tools and agent tools across inherit and subset states
**Plans**: 3 plans (re-plan; assignment-only reshape over scaffolding on main)
  - [x] 46-05-PLAN.md — Resolver two-state + explicit pre-feature head/agent defaults + runtime enforcement at both layers (Wave 1)
  - [x] 46-06-PLAN.md — Single tagged /api/tools registry + two-state settings/heads API with per-layer name validation + DTOs/client (Wave 2)
  - [ ] 46-07-PLAN.md — Two-state dashboard controls (Inherit/Custom subset) fed per-layer-filtered registry + CHANGELOG wording + human-verify (Wave 3)
**UI hint**: yes

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1. Tool-call legibility | v1.0 | — | Complete | 2026-04-11 |
| 10. Jobs Awareness | v1.1 | — | Complete | 2026-04-20 |
| 19–28. Voice Mode & Enhancements | v1.2 | — | Complete | 2026-05-12 |
| 29. Data Layer | v1.3 | 3/3 | Complete | 2026-05-12 |
| 30. Core Activation | v1.3 | 3/3 | Complete | 2026-05-12 |
| 31. Adapter Registry & Config & Startup | v1.3 | 3/3 | Complete | 2026-05-12 |
| 32. Dashboard Head Selector | v1.3 | 3/3 | Complete | 2026-05-12 |
| 33. Multi-head Management UI | v1.3 | 7/7 | Complete | 2026-05-13 |
| 34. Multi-Head Agent Lifecycle | v1.3 | 5/5 | Complete | 2026-05-14 |
| 35. Per-Head Scheduling | v1.3 | 4/4 | Complete | 2026-05-14 |
| 36. Inbound Sender Attribution | v1.3 | 3/3 | Complete | 2026-05-14 |
| 37. Schema & Tool Params | v1.4 | 2/2 | Complete | 2026-05-23 |
| 38. Nag Mechanism & Ack Semantics | v1.4 | 4/4 | Complete | 2026-05-23 |
| 39. Dashboard Reminder UI | v1.4 | 3/3 | Complete | 2026-05-24 |
| 40. Config & Adapter Skeleton | v1.5 | 2/2 | Complete | 2026-05-24 |
| 41. Inbound Synchronous Reply Endpoint | v1.5 | 4/4 | Complete | 2026-05-24 |
| 42. Outbound HA REST Announce | v1.5 | 2/2 | Complete | 2026-05-24 |
| 43. End-to-End Smoke Test & Setup Docs | v1.5 | 3/3 | Complete | 2026-05-24 |
| 44. Multi-head task delivery | v1.6 | 5/5 | Complete | 2026-05-24 |
| 45. Ring Delivery Layer + Timer Ring + Alarm | v1.7 | 6/6 | Complete   | 2026-05-26 |
| 46. Tool Access Control | v1.8 | 5/3 | Complete   | 2026-06-07 |
