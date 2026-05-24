# Shrok Roadmap

## Milestones

- ✅ **v1.0 Tool-call Legibility** — Phase 1 et al. (shipped 2026-04-11)
- ✅ **v1.1 Jobs Awareness** — Phase 10 (shipped 2026-04-20)
- ✅ **v1.2 Voice Mode & Feature Enhancements** — Phases 19–28 (shipped 2026-05-12)
- ✅ **v1.3 Multi-Head Support** — Phases 29–36 (shipped 2026-05-14)
- ✅ **v1.4 Unmissable Reminders** — Phases 37–39 (shipped 2026-05-24)
- 📋 **v1.5 Home Assistant Voice** — Phases 40–43

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

### 📋 v1.5 Home Assistant Voice (Phases 40–43)

A new `home-assistant` channel adapter that bridges Shrok's async, delegating head to Home Assistant's Assist pipeline — synchronous in-turn acknowledgment reply for the live voice turn (<3s, hard 5s device timeout budget), and unprompted `assist_satellite.announce` / `start_conversation` callbacks for async sub-agent results, reminders, and scheduled fires.

- [ ] **Phase 40: Config & Adapter Skeleton** — `vendor: 'home-assistant'` Zod config, adapter stub registered, token in `.env`, lastActiveChannel routing live
- [ ] **Phase 41: Inbound Synchronous Reply Endpoint** — `/v1/chat/completions` on Express, bearer auth, CSRF exclusion, pendingReply promise slot, <3s ACK, Apache auth bypass
- [ ] **Phase 42: Outbound HA REST Announce** — `assist_satellite.announce`/`start_conversation` via Node fetch, fire-and-forget with 30s timeout, invoked from `adapter.send()` when no live turn is open
- [ ] **Phase 43: End-to-End Smoke Test & Setup Docs** — live VPE validation, resolves all open research questions, HADOC-01 setup guide

## Phase Details

### Phase 40: Config & Adapter Skeleton

**Goal**: The `home-assistant` channel vendor is wired into Shrok's config and adapter registry — operators can configure the adapter and it registers at boot with no HTTP or HA REST calls yet
**Depends on**: Nothing (first v1.5 phase)
**Requirements**: HACF-01, HACF-02
**Success Criteria** (what must be TRUE):

  1. A `{ vendor: 'home-assistant', haBaseUrl, haVoiceSatelliteEntityId }` channel config block parses without error and `haAccessToken` in `.env` is picked up via `ENV_KEY_ALLOWLIST`
  2. An invalid entity ID (wrong domain prefix) or missing required field causes a clear startup error rather than a silent failure at first use
  3. `HomeAssistantChannelAdapter` instantiates, registers as a named adapter in the head's channel map, and sets `lastActiveChannel` on receipt of a manually-injected test message — the full routing path is exercised without any HTTP
  4. Existing single-head deployments with no `home-assistant` channel are unaffected — zero-config backward compatibility preserved

**Plans**: 2 plans
Plans:
**Wave 1**

- [x] 40-01-PLAN.md — home-assistant Zod config member + entity-id/URL validation + HA_ACCESS_TOKEN in ENV_KEY_ALLOWLIST

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 40-02-PLAN.md — HomeAssistantChannelAdapter stub + index.ts boot wiring + SC3 lastActiveChannel routing test

### Phase 41: Inbound Synchronous Reply Endpoint

**Goal**: Home Assistant can send a conversation turn to Shrok via `/v1/chat/completions` and receive an OpenAI-compatible acknowledgment reply within the 5-second device timeout — the held-connection contract is fully established
**Depends on**: Phase 40
**Requirements**: HACV-01, HACV-02, HACV-03, HACV-04, HACV-05, HACV-06
**Success Criteria** (what must be TRUE):

  1. A `POST /v1/chat/completions` request with a valid bearer token enqueues a `user_message` on the `home-assistant` channel extracting only the last user turn (HA's full `messages[]` history is discarded)
  2. The endpoint returns a well-formed OpenAI Chat Completions JSON response (`choices[0].message.content` non-empty, `finish_reason: "stop"`, `conversation_id` echoed) within 3 seconds — regardless of how long the head's actual processing takes
  3. A request with a missing or invalid bearer token receives a JSON 401 from Shrok (not an Apache `WWW-Authenticate: Basic` 401) — confirmed via `curl -v` against `https://jarvis.gigaashley.click/v1/chat/completions`
  4. If the HTTP client closes the connection before the reply is sent, the pending promise slot is cleaned up and no dangling timer or memory leak remains
  5. The CSRF / same-origin middleware in `src/dashboard/server.ts` is explicitly excluded for the `/v1/*` path so HA's cross-origin requests are not rejected

**Plans**: TBD
**UI hint**: yes

### Phase 42: Outbound HA REST Announce

**Goal**: Shrok speaks on the configured Home Assistant satellite device for background events — when `home-assistant` is the active channel and no live turn is open, async results are delivered via `assist_satellite.announce` or `start_conversation`
**Depends on**: Phase 41
**Requirements**: HAAN-01, HAAN-02, HAAN-03
**Success Criteria** (what must be TRUE):

  1. When a sub-agent completes and `lastActiveChannel === 'home-assistant'` with no pending live turn, the result text is sent to the configured satellite via `assist_satellite.announce` — the device speaks it unprompted
  2. When a reminder or scheduled fire targets the `home-assistant` channel and no live turn is open, it is likewise spoken on the satellite via the same announce mechanism
  3. An announce call that takes longer than 30 seconds (stuck-in-RESPONDING satellite bug) times out and is logged — the activation loop is unblocked and no retry loop is started
  4. The head can choose `assist_satellite.start_conversation` instead of `announce` (one parameterized mechanism), causing the satellite to keep its mic open for a follow-up reply that arrives through the `/v1/chat/completions` endpoint

**Plans**: TBD

### Phase 43: End-to-End Smoke Test & Setup Docs

**Goal**: The full two-leg voice flow is validated against a live VPE device — user speaks, Shrok acknowledges synchronously and delivers the real answer via announce — and a self-hosting operator can wire up the complete HA side from the setup docs
**Depends on**: Phase 42
**Requirements**: HADOC-01
**Research flag**: HIGH — live VPE smoke test required; several open questions (exact timeout headroom under real network conditions, `continue_conversation` pipeline behavior, `start_conversation` end-to-end round-trip, `device_id` availability, correct satellite entity slug) can only be resolved against real hardware
**Success Criteria** (what must be TRUE):

  1. A user speaks to the VPE device, Shrok acknowledges within the 5s timeout ("on it"), and the actual answer is spoken on the device unprompted via announce — the full async two-leg flow confirmed on real hardware
  2. Apache `/v1` auth bypass is verified in the production vhost — `curl` from the HA server's network perspective shows Shrok's JSON 401, not Apache's `WWW-Authenticate: Basic` 401
  3. A self-hosting operator following HADOC-01 can install Extended OpenAI Conversation (HACS), point its base URL at Shrok with the API key, select Shrok as the VPE conversation agent, and wire up the satellite entity — all from the docs with no guesswork
  4. All live-VPE open questions from the research SUMMARY are resolved and the outcomes are recorded (conversation_id stitching, start_conversation round-trip behavior, exact safe reply window)

**Plans**: TBD

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
| 40. Config & Adapter Skeleton | v1.5 | 1/2 | In Progress|  |
| 41. Inbound Synchronous Reply Endpoint | v1.5 | 0/? | Not started | — |
| 42. Outbound HA REST Announce | v1.5 | 0/? | Not started | — |
| 43. End-to-End Smoke Test & Setup Docs | v1.5 | 0/? | Not started | — |
