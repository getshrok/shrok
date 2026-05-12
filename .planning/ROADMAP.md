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

---

## 🚧 v1.3 Multi-Head Support

## Phases

- [x] **Phase 29: Data Layer** — Migrations add `head_id` to queue and message tables; store queries filter by head (completed 2026-05-12)
- [x] **Phase 30: Core Activation** — ActivationLoop parameterized by headId; AppStateStore namespaced; per-head ChannelRouter (completed 2026-05-12)
- [ ] **Phase 31: Adapter Registry & Config & Startup** — Multi-instance adapters with headId stamping; heads[] config schema; startup creates one loop and router per head
- [ ] **Phase 32: Dashboard Head Selector** — Head selector UI; conversation view scoped to selected head

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
**Plans**: TBD

### Phase 32: Dashboard Head Selector
**Goal**: Users can switch between heads in the dashboard and see only that head's conversation history
**Depends on**: Phase 31
**Requirements**: DASH-01, DASH-02
**Success Criteria** (what must be TRUE):
  1. Dashboard renders a head selector listing all configured heads by name
  2. Selecting a head updates the conversation view to show only messages from that head
  3. After switching heads, messages from the previously selected head are no longer visible in the conversation list
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 29. Data Layer | 3/3 | Complete    | 2026-05-12 |
| 30. Core Activation | 3/3 | Complete   | 2026-05-12 |
| 31. Adapter Registry & Config & Startup | 0/? | Not started | - |
| 32. Dashboard Head Selector | 0/? | Not started | - |
