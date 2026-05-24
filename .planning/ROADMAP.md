# Shrok Roadmap

## Milestones

- ✅ **v1.0 Tool-call Legibility** — Phase 1 et al. (shipped 2026-04-11)
- ✅ **v1.1 Jobs Awareness** — Phase 10 (shipped 2026-04-20)
- ✅ **v1.2 Voice Mode & Feature Enhancements** — Phases 19–28 (shipped 2026-05-12)
- ✅ **v1.3 Multi-Head Support** — Phases 29–36 (shipped 2026-05-14)
- ✅ **v1.4 Unmissable Reminders** — Phases 37–39 (shipped 2026-05-24)
- ✅ **v1.5 Home Assistant Voice** — Phases 40–43 (shipped 2026-05-24)
- 📋 **v1.6 Multi-Head Task Delivery** — Phase 44 (in progress)

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

### Phase 44: Multi-head task delivery

**Milestone:** v1.6 Multi-Head Task Delivery (in progress)

**Depends on:** Phase 34 (Multi-Head Agent Lifecycle), Phase 35 (Per-Head Scheduling)

**Goal:** A scheduled **task** runs once but delivers its result to every head in an opt-in delivery set. Add optional `Schedule.deliverToHeadIds`; thread the delivery set through spawn → agent record → completion so `completeAgent` fans out `agent_completed` to each head in `[headId, ...deliverToHeadIds]` (deduped) — the work is done once, the report reaches N heads. Also stop scheduled agents from ever suspending-as-question (no human in the loop). Tasks only — **reminders are unchanged** (no multi-select, no schema change). Dashboard task form gains a "deliver to" multi-select; reminder form untouched.

**Plans:** 4/5 plans executed

Plans:
**Wave 1**

- [x] 44-01-PLAN.md — Data model: deliver_to_head_ids migration + agents-row persistence + Schedule/SpawnOptions/AgentState fields (tsc GREEN)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 44-02-PLAN.md — Spawn/complete path: agent_completed fan-out at both top-level sites + scheduled question-suppression + resume/spawn pass-through

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 44-03-PLAN.md — API: POST/PATCH deliverToHeadIds validation (task-only, known-head 404, dedupe, editable) + route tests

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 44-04-PLAN.md — Dashboard: task-form 'deliver to' multi-select + N-chip task rows + type/api plumbing (reminder form untouched)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 44-05-PLAN.md — Integration regression: fan-out (x2 sites) + dedup + no-set regression + question-suppression + agent_failed owner-only; phase gate

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
| 44. Multi-head task delivery | v1.6 | 4/5 | In Progress|  |
