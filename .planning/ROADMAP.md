# Shrok Roadmap

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
**Plans:** See phase directory.

### Phase 20: Vite build configuration
**Goal:** Configure Vite to include VAD WASM/ONNX assets in production build.
**Plans:** See phase directory.

### Phase 21: React voice UI state machine
**Goal:** useReducer FSM with four mutually exclusive voice states.
**Plans:** See phase directory.

### Phase 22: Error handling & accessibility
**Goal:** Mic permission errors, API failures, and ARIA labels for voice controls.
**Plans:** See phase directory.

### Phase 23: Timezone-aware scheduling
**Goal:** Bootstrap timezone collection and apply to schedule triggers.
**Plans:** See phase directory.

### Phase 24: Message agent mid-loop delivery
**Goal:** Deliver head messages to long-running agents mid-execution.
**Plans:** See phase directory.

### Phase 25: Migrate agent history from JSON blob to agent messages rows
**Goal:** Replace JSON blob storage with per-row agent message table.
**Plans:** See phase directory.

### Phase 26: Validate skill md and task md frontmatter on write-file
**Goal:** Frontmatter validation when writing SKILL.md and TASK.md files.
**Plans:** See phase directory.

### Phase 27: Rename workspace-path env var to shrok-workspace-path
**Goal:** Rename $WORKSPACE_PATH to $SHROK_WORKSPACE_PATH across all sub-agent SYSTEM.md files.
**Plans:** See phase directory.

### Phase 28: Add optional prompt parameter to memory functions

**Goal:** Expose ICW PromptOverrides (chunker, router, archiver, summaryUpdate) to end users via editable MEMORY-*.md files in the dashboard identity page. Shrok ships defaults at src/identity/memory-prompts/, workspace overrides win, files read fresh on every memory call. Includes spec for the upstream ICW per-call prompts parameter and wires loadMemoryPromptOverrides() into the chunk() and retrieve() call sites.
**Requirements**: TBD
**Depends on:** Phase 27
**Plans:** 3/3 plans complete

Plans:
- [x] 28-01-PLAN.md — ICW spec, default memory prompt files, src/memory/prompts.ts loader, startup wiring
- [x] 28-02-PLAN.md — Dashboard identity route memory section + IdentityPage UI integration
- [x] 28-03-PLAN.md — Wire loadMemoryPromptOverrides into archival.ts chunk() and assembler.ts retrieve()

</details>

## 🚧 v1.3 Multi-Head Support

## Phases

- [x] **Phase 29: Data Layer** — Migrations add `head_id` to queue and message tables; store queries filter by head (completed 2026-05-12)
- [x] **Phase 30: Core Activation** — ActivationLoop parameterized by headId; AppStateStore namespaced; per-head ChannelRouter (completed 2026-05-12)
- [x] **Phase 31: Adapter Registry & Config & Startup** — Multi-instance adapters with headId stamping; heads[] config schema; startup creates one loop and router per head (completed 2026-05-12)
- [x] **Phase 32: Dashboard Head Selector** — Head selector UI; conversation view scoped to selected head (completed 2026-05-12)
- [x] **Phase 33: Multi-head Management UI** — Dashboard UI for creating/renaming/deleting heads, managing channel adapters (incl. multiple instances per provider), and per-head Send routing (completed 2026-05-13)
- [x] **Phase 34: Multi-Head Agent Lifecycle** — Plumb head_id through the agent spawn/run/complete lifecycle so non-default heads receive their own agent completion events (currently they default-route to the default head) (completed 2026-05-14)
- [x] **Phase 35: per-head-scheduling** — Each head owns its own schedules and reminders end-to-end; per-head schedule_trigger events, agent-created schedules inherit spawning head, reminder first-channel fallback, head deletion cascades (completed 2026-05-14)
- [ ] **Phase 36: Inbound Sender Attribution** — Adapter-side `[Name]:` prefix on inbound messages so the head can tell who is speaking in multi-user channels; generalize the timestamp prefix stripper to strip any leading bracketed segments from head responses; identity disambiguation handled via user.md username mapping

## Phase Details

### Phase 29: Data Layer
**Goal**: The database isolates queue events and message history by head so each head sees only its own data
**Depends on**: Phase 28 (prior milestone)
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):
  1. All existing `queue_events` rows have `head_id = 'default'` after migration runs — no data loss
  2. All existing `messages` rows have `head_id = 'default'` after migration runs — no data loss
  3. `QueueStore.claimNext('personal')` never returns an event that belongs to a different head
  4. `MessageStore.getRecent('work', budget)` returns only messages stamped with `head_id = 'work'`
**Plans:** 3/3 plans complete

Plans:
- [x] 29-01-PLAN.md — Migration sql/005_multi_head.sql + db.test.ts schema/backfill cases (DATA-01, DATA-02)
- [x] 29-02-PLAN.md — QueueStore + MessageStore signature updates with head_id filtering + isolation tests (DATA-03, DATA-04)
- [x] 29-03-PLAN.md — Caller updates across src/, tests/, scripts/ to pass 'default' literal so tsc and vitest stay green

### Phase 30: Core Activation
**Goal**: Each head runs its own independent activation loop with isolated state and routing
**Depends on**: Phase 29
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04
**Success Criteria** (what must be TRUE):
  1. Two heads running concurrently each process only their own queue events — no cross-head claim
  2. Last-active-channel for head `personal` does not overwrite or read the value for head `work`
  3. Archival triggered on head `personal` cannot be blocked by an archival lock held on head `work`
  4. A message sent via a Telegram adapter assigned to head `work` is routed only through that head's ChannelRouter
**Plans:** 3/3 plans complete

Plans:
- [x] 30-01-PLAN.md — AppStateStore head-scoped signatures + sql/006 key-rename migration + db.test.ts per-head isolation tests (CORE-02, CORE-03)
- [x] 30-02-PLAN.md — ActivationLoop parameterized by headId; replace ~33 'default' literals in activation.ts; update test mocks + per-head isolation scenario test (CORE-01)
- [x] 30-03-PLAN.md — Wire 'default' literal through src/system.ts, src/index.ts, eval harness/scenarios, tests/integration/helpers.ts; CORE-04 architectural regression test; full tsc + vitest gate (CORE-01, CORE-04)

### Phase 31: Adapter Registry & Config & Startup
**Goal**: Users can configure multiple named heads with distinct adapter assignments and the system starts them all
**Depends on**: Phase 30
**Requirements**: ADPT-01, ADPT-02, CONF-01, CONF-02, CONF-03
**Success Criteria** (what must be TRUE):
  1. A `config.json` with two Telegram adapter entries (`telegram-personal`, `telegram-work`) starts without error and registers both adapters
  2. Every event enqueued by an adapter carries the `head_id` the adapter is configured for
  3. A `config.json` with no `heads` array starts a single implicit `default` head — existing deployments unchanged
  4. Startup creates exactly one `ActivationLoop` and one `ChannelRouter` per entry in the `heads` array
**Plans:** 3/3 plans complete

Plans:
- [x] 31-01-PLAN.md — ConfigSchema heads[] discriminated union + resolveHeads() helper + config.test.ts coverage (CONF-01, CONF-02)
- [x] 31-02-PLAN.md — All 7 adapters gain headId+id constructor params; QueueStore.enqueue threads head_id; SystemDeps.headId; src/index.ts call-site updates + ADPT unit tests (ADPT-01, ADPT-02)
- [x] 31-03-PLAN.md — src/index.ts multi-head startup loop (one ChannelRouter+ActivationLoop per resolved head); extractSecretValues walks heads[]; multi-head-startup integration test (CONF-03, ADPT-01, ADPT-02, CONF-02)

### Phase 32: Dashboard Head Selector
**Goal**: Users can switch between heads in the dashboard and see only that head's conversation history
**Depends on**: Phase 31
**Requirements**: DASH-01, DASH-02
**Success Criteria** (what must be TRUE):
  1. Dashboard renders a head selector listing all configured heads by name
  2. Selecting a head updates the conversation view to show only messages from that head
  3. After switching heads, messages from the previously selected head are no longer visible in the conversation list
**Plans:** 3/3 plans complete
**UI hint**: yes

Plans:
- [x] 32-01-PLAN.md — Wave 0 RED tests: src/dashboard/routes/heads.test.ts + messages.test.ts (DASH-01, DASH-02)
- [x] 32-02-PLAN.md — Backend: createHeadsRouter + ?head= filtering on /api/messages + DashboardServerOptions.resolvedHeads wiring (DASH-01, DASH-02)
- [x] 32-03-PLAN.md — Frontend: api.heads + scoped messagesQuery + useStream(currentHeadId) + ConversationsPage head pill row + manual verify (DASH-01, DASH-02)

### Phase 33: Multi-head Management UI
**Goal**: Users can create, rename, and delete heads from the dashboard, manage each head's channel adapters (including multiple instances of the same provider), and have dashboard-sent messages route to the currently selected head
**Depends on**: Phase 32
**Requirements**: DASH-03, DASH-04, DASH-05
**Success Criteria** (what must be TRUE):
  1. A user can create a new head from the dashboard settings, give it a name, and the new head appears in the selector without restarting the server
  2. A user can add a second Telegram bot (or any second-of-same-provider channel) to a head from the UI; both instances start and route correctly
  3. A user can rename or delete a head from the UI; conversation history for a deleted head is handled per a defined deletion policy
  4. Sending a message from the dashboard with head `personal` selected routes through that head's outbound channel — not the default head
**Plans:** 7/7 plans complete
**UI hint**: yes

Plans:
- [x] 33-01-append-headid-ripple-PLAN.md — MessageStore.append(msg, headId) ripple + QueueStore.deleteAllForHead (DASH-05 foundation)
- [x] 33-02-per-head-dashboard-adapter-PLAN.md — Per-head DashboardChannelAdapter map + POST /send routes by body.headId (DASH-05)
- [x] 33-03-per-head-sse-filter-PLAN.md — SSE events carry headId + useStream() per-head filter (DASH-05)
- [x] 33-04-heads-crud-router-PLAN.md — POST/PATCH/DELETE /api/heads + lazy migration + rename UPDATE + delete wipe transaction (DASH-03)
- [x] 33-05-heads-channels-subresource-PLAN.md — POST/PATCH/DELETE /api/heads/:id/channels[/:channelId] + cred masking + cross-head uniqueness (DASH-04)
- [x] 33-06-heads-tab-frontend-PLAN.md — HeadsTab + HeadCard + ChannelRow + api.heads.* + hide legacy Channels tab (DASH-03, DASH-04)
- [x] 33-07-typed-confirmation-delete-PLAN.md — DeleteHeadModal with typed-confirmation + counts endpoint + confirmId guard (DASH-03)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 29. Data Layer | 3/3 | Complete    | 2026-05-12 |
| 30. Core Activation | 3/3 | Complete    | 2026-05-12 |
| 31. Adapter Registry & Config & Startup | 3/3 | Complete    | 2026-05-12 |
| 32. Dashboard Head Selector | 3/3 | Complete    | 2026-05-12 |
| 33. Multi-head Management UI | 7/7 | Complete    | 2026-05-13 |

### Phase 34: Multi-Head Agent Lifecycle

Plumb `head_id` through the agent spawn/run/complete lifecycle so non-default heads receive their own agent completion events instead of having them default-routed to the default head.

**Root cause:** Phase 29 added `head_id` to `queue_events` and `messages` but not to the `agents` table. `HeadToolExecutor` doesn't know its own headId, `SpawnOptions` has no headId field, and all six `queueStore.enqueue()` callsites in `src/sub-agents/local.ts` (lines ~208, ~615, ~970, ~989, ~1014, ~1092 — agent_failed×2 / agent_completed×2 / agent_question / agent_response) omit the headId argument so events default to `head_id='default'`. Activation loops correctly filter by their own headId — so completion events from non-default heads are claimed by the default head's loop.

**Scope:**
1. SQL migration: add `head_id TEXT NOT NULL DEFAULT 'default'` column + head-scoped index to the `agents` table
2. `HeadToolExecutorOptions.headId` required option field; `SpawnOptions.headId` required field; `LocalAgentRunnerOptions.headId` required field; `AgentState.headId` required field — type-enforced (no silent default)
3. `LocalAgentRunner` gains `private readonly headId` ctor field; ctor reads `opts.headId`
4. `AgentStore.create(id, options)` persists `options.headId` on the agents row at creation; `rowToState()` returns it
5. All **six** `queueStore.enqueue()` callsites in `src/sub-agents/local.ts` thread `this.headId` as the 3rd positional argument
6. `buildSystem()` threads `headId: deps.headId ?? 'default'` into `LocalAgentRunner` and `toolExecutorOpts`; `HeadToolExecutor`'s `spawn_agent` dispatch injects `headId: this.opts.headId` into SpawnOptions; `resumeSuspended` and `handleSpawnAgent` thread headId; scheduler spawn at `activation.ts:1247` threads `this.opts.headId`
7. Tests: architectural regression test (`tests/integration/multi-head-agent-lifecycle.test.ts`) with two-head spawn/complete/claim assertion; new schema + round-trip tests in `src/db/db.test.ts`; all ~14 existing test/script SpawnOptions construction sites supply `headId: 'default'`

**Goal**: Each head's activation loop claims only its own agents' completion events; head identity is type-required at every spawn/run/complete site so silent cross-head leakage is a compile error
**Requirements**: TBD (no tracked REQ-IDs — closes implicit corollary of CORE-01/CORE-04 left half-built by Phase 29's table-coverage gap)
**Depends on:** Phase 33
**Plans:** 5/5 plans complete

Plans:
- [x] 34-01-PLAN.md — sql/007_agents_head_id.sql migration + AgentStore.create/rowToState head_id round-trip + db.test.ts schema pin (Wave 1)
- [x] 34-02-PLAN.md — Required headId on SpawnOptions, AgentState, LocalAgentRunnerOptions, HeadToolExecutorOptions (Wave 1)
- [x] 34-03-PLAN.md — LocalAgentRunner.headId ctor field + 6 queueStore.enqueue callsites thread this.headId + resumeSuspended/handleSpawnAgent SpawnOptions threading (Wave 2)
- [x] 34-04-PLAN.md — HeadToolExecutor spawn_agent dispatch injects headId; buildSystem threads headId into LocalAgentRunner ctor and toolExecutorOpts (Wave 2)
- [x] 34-05-PLAN.md — tests/integration/multi-head-agent-lifecycle.test.ts (architectural regression) + ~14 existing test/script callers supply headId + scheduler spawn threads this.opts.headId + full tsc/vitest green (Wave 3)

### Phase 35: per-head-scheduling

**Goal:** Each head owns its own schedules and reminders end-to-end — schedule rows carry `headId`, the ScheduleEvaluator emits per-head schedule_trigger events (closing the WR-03 NOTE), agent-created schedules inherit the spawning head's id, reminders fall back to a head's first configured channel when last-active is null, and head deletion cascades to schedules+reminders. Closes the scheduling counterpart to Phase 34's agent-lifecycle work.

**Requirements**: TBD (XH-F-02 in REQUIREMENTS.md is the closest mapped item — schedules and reminders assigned to a specific head)
**Depends on:** Phase 34
**Plans:** 4/4 plans complete

Plans:
- [x] 35-01-PLAN.md — Schedule.headId field + ScheduleStore filter API + lazy JSON migration + ScheduleEvaluator passes schedule.headId on enqueue + WR-03 NOTE removed (D-01, D-02, D-03, D-04, D-05) [Wave 1]
- [x] 35-02-PLAN.md — buildScheduleTools/buildReminderTools require headId, ToolSurfaceDeps.headId, update_schedule rejects reassignment, reminder fire first-channel fallback (D-06, D-07, D-08, D-09, D-10) [Wave 2]
- [x] 35-03-PLAN.md — Dashboard schedules API: POST requires headId, GET cross-head, PATCH rejects headId; heads DELETE cascade + counts; ScheduleStore.deleteAllForHead helper (D-11, D-12, D-13, D-16, D-17) [Wave 2]
- [x] 35-04-PLAN.md — Dashboard UI: head picker on create forms, Head column on lists; architectural regression test tests/integration/multi-head-scheduling.test.ts (D-14, D-15) [Wave 3]

### Phase 36: Inbound Sender Attribution

**Goal:** Inbound messages from every channel adapter are prefixed with a `[Name]:` segment carrying the sender's adapter-side username/display name, so the head can attribute messages to specific humans in multi-user channels. The existing timestamp prefix stripper generalizes to strip any leading bracketed segments (e.g., `[5m ago] [Ashley]:` or `[Ashley]:`) from head responses so the head never mimics the prefix back. Identity disambiguation across multiple usernames per person is handled in user.md (e.g., "Ashley's usernames are CoolChick123 and AwesomeAshley2"), not a stable DB id — v1 keeps the data path purely string-based.

**Requirements**: TBD (no tracked REQ-IDs — Phase 36 adds a new attribution capability layer on top of multi-head infra; no v1.3 requirement maps directly)
**Depends on:** Phase 35
**Plans:** 2/3 plans executed

Plans:
- [x] 36-01-type-contract-central-prefix-PLAN.md — InboundMessage.senderName field + central buildPrefixedText in headRouteMessage + normalizeSenderName helper + threat model (D-01, D-02, D-04, D-07) [Wave 1]
- [x] 36-02-stripper-generalization-PLAN.md — stripTimestampEcho → stripLeadingBracketPrefixes rename + generalized D-11 regex + sole-importer update + regression/anti-regression tests (D-11, D-12) [Wave 1]
- [ ] 36-03-adapter-sender-extraction-PLAN.md — 5 adapters populate senderName: Discord (member.displayName chain), Telegram (first_name+last_name chain), Slack (TTL-cached users.info), WhatsApp (pushName), Cliq (sender.name); dashboard/voice/webhook NOT modified (D-05, D-06) [Wave 2]
