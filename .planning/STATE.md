---
gsd_state_version: 1.0
milestone: v1.10
milestone_name: Ambient Context (Sensors)
status: milestone_complete
last_updated: 2026-06-20T12:02:19.555Z
last_activity: 2026-06-20
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 11
  completed_plans: 17
  percent: 100
stopped_at: Milestone complete (Phase 52 was final phase)
---

# Project State

## Current Position

Phase: 52
Plan: Not started
Status: Milestone complete
Last activity: 2026-06-21 - Completed quick task 260621-r73: simplify spawn_agent/message_agent to all-in-one task/message, remove #45 verbatim composer (v0.7.0)

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260524-me4 | Pre-transcribe inbound voice/audio messages from chat channels at the ingestion boundary (issue #9) | 2026-05-24 | ddacc75 |  | [260524-me4-pre-transcribe-inbound-voice-audio-messa](./quick/260524-me4-pre-transcribe-inbound-voice-audio-messa/) |
| 260525-4zu | Export config.timezone as TZ to spawned processes (workers, tasks, tool calls) (issue #13) | 2026-05-25 | 5f648aa |  | [260525-4zu-export-config-timezone-as-tz-to-spawned-](./quick/260525-4zu-export-config-timezone-as-tz-to-spawned-/) |
| 260525-5m2 | Per-head custom prompt addition + head-aware context assembler (issue #12) | 2026-05-25 | eb7cb0d | Verified | [260525-5m2-per-head-custom-prompt-addition-make-con](./quick/260525-5m2-per-head-custom-prompt-addition-make-con/) |
| 260525-6d5 | Cascade task/skill rename across all references (frontmatter, schedules, cross-kind skill-deps, usage) | 2026-05-25 | 9059548 | Verified (targeted tests; full suite deferred to CI) | [260525-6d5-cascade-task-skill-rename-across-all-ref](./quick/260525-6d5-cascade-task-skill-rename-across-all-ref/) |
| 260525-fgc | Fix dashboard convo-view voice mode: per-turn live MSE, head-aware WS URL, query-tolerant upgrade guard, per-connection head routing + multi-router registration | 2026-05-25 | 29c50de | Verified (tsc + dashboard 73/73 + root 1707/1708 green) | [260525-fgc-fix-dashboard-convo-view-voice-mode-turn](./quick/260525-fgc-fix-dashboard-convo-view-voice-mode-turn/) |
| 260526-mdd | Stop exposing models to UTC — enforce YYYY-MM-DD HH:MM invariant at all model↔tool time boundaries, close issue #18 | 2026-05-26 | 02c1dba |  | [260526-mdd-stop-exposing-models-to-utc-issue-18](./quick/260526-mdd-stop-exposing-models-to-utc-issue-18/) |
| 260606-vof | Dashboard skill/task file listing shows all files; gate binary/large at view time (issue #4) | 2026-06-07 | 3067758 |  | [260606-vof-fix-issue-4-dashboard-skill-task-file-li](./quick/260606-vof-fix-issue-4-dashboard-skill-task-file-li/) |
| 260606-wh1 | Reminder/schedule edit modal datetime pre-fills; all datetime fields use workspace tz (issue #5) | 2026-06-07 | f04ed5d |  | [260606-wh1-fix-issue-5-reminder-schedule-edit-modal](./quick/260606-wh1-fix-issue-5-reminder-schedule-edit-modal/) |
| 260607-lwy | Head-scope dashboard convo-view sub-agent pills (backend getRecent head filter + head-keyed query + reset accumulator) (issue #10) | 2026-06-07 | 352b9dd |  | [260607-lwy-fix-issue-10-head-scope-the-dashboard-co](./quick/260607-lwy-fix-issue-10-head-scope-the-dashboard-co/) |
| fast | Create-reminder Message field → multi-line textarea (issue #15) | 2026-06-07 | 096741d |  | (gsd-fast, no dir) |
| fast | Louder ring default (0.5→1.0) + stronger triple-beep alarm tone (issue #19) | 2026-06-07 | 022fcda |  | (gsd-fast, no dir) |
| 260607-mp4 | Chunk long Telegram messages under the 4096-char limit (source-split, per-chunk HTML, sequential send) (issue #20) | 2026-06-07 | db4da23 |  | [260607-mp4-fix-issue-20-chunk-long-telegram-message](./quick/260607-mp4-fix-issue-20-chunk-long-telegram-message/) |
| 260607-mz8 | Fix long-message silent-drop in Slack (block-aware: 3000/2000/10-field/50-block) + WhatsApp (chunker @65k) adapters — audit sibling of #20 | 2026-06-07 | 616d04e | Verified (plan-check + 255 channel tests + tsc; commits clean) | [260607-mz8-fix-long-message-silent-drop-in-slack-bl](./quick/260607-mz8-fix-long-message-silent-drop-in-slack-bl/) |
| 260608-6ny | Rename model-tier vocabulary to dumb/smart/genius + expose model arg on head spawn_agent (issue #31) | 2026-06-08 | 7d5915c | Verified (tsc clean + 242 targeted tests green; backward-compat shim tested) | [260608-6ny-rename-model-tier-vocabulary-to-dumb-sma](./quick/260608-6ny-rename-model-tier-vocabulary-to-dumb-sma/) |
| 260618-aqe | Configurable self-hosted STT endpoint (sttBaseUrl) mirroring ttsBaseUrl; single voiceOpenaiFallback toggle governs OpenAI fallback for both STT+TTS; voice runs with no OpenAI key | 2026-06-18 | 533d4e4 | Verified (tsc clean + 171 voice/config/ingestion tests green; dashboard/dist untouched) | [260618-aqe-add-configurable-self-hosted-stt-endpoin](./quick/260618-aqe-add-configurable-self-hosted-stt-endpoin/) |
| 260620-fdc | Apply the #45 relay-not-author treatment to the message_agent head tool: required verbatim `context` (delivered, wrapped, uniform across running/completed/suspended), `message` reframed as a non-delivered intent label, both stewards judge `context`, SYSTEM.md reworded | 2026-06-20 | b75b47e | Verified (tsc clean + 151 head/agents tests green incl. 3 new parity cases; `message` kept required for strict #45 parity; dashboard/dist untouched) | [260620-fdc-apply-45-relay-not-author-treatment-to-t](./quick/260620-fdc-apply-45-relay-not-author-treatment-to-t/) |
| 260620-wl2 | Add optional endDate to schedules — a recurring schedule auto-disables once its next computed fire lands on/after the cutoff. Threaded model→scheduler→agent tools (create/update_schedule, parseModelTime past-guard)→dashboard API+UI; lazy migration for legacy files | 2026-06-21 | 6ba5fed | Verified (root+dashboard tsc clean + 116 schedule/scheduler/registry tests green incl. 2 new endDate cutoff cases; dashboard/dist untouched) | [260620-wl2-add-optional-end-date-to-schedules-so-re](./quick/260620-wl2-add-optional-end-date-to-schedules-so-re/) |
| 260621-dom | Sensor schedules multi-head delivery — a kind:script schedule runs its sensor ONCE then fans all three sinks (ambient/headEvent/subAgent) out to dedupe([headId, ...deliverToHeadIds]), matching the Phase-44 task fan-out. Identical ambient per head; one sensor_event per head; ONE sub-agent trigger carrying deliverToHeadIds → existing completeAgent fan-out. Backend+types+activation+route+dashboard head-picker | 2026-06-21 | ec574a8 | Verified (root tsc clean + 95 sensor-runner/schedules-route tests green incl. 11 new fan-out/route cases; dashboard/dist untouched) | [260621-dom-sensor-schedules-multi-head-delivery-del](./quick/260621-dom-sensor-schedules-multi-head-delivery-del/) |
| 260621-r73 | Simplify spawn_agent/message_agent to an all-in-one task/message param; remove the #45 verbatim-context machinery entirely. Collapse task+context→task and message+context→message (delivered directly to the sub-agent), SOFT verbatim encouragement in the param descriptions; delete composeVerbatimContext + classifier modules; strip dead agentContextComposer + snapshotTokenBudget knobs (backend + dashboard); behavioral stewards kept intact. Partially reverses 260620-fdc. Bump to v0.7.0 | 2026-06-21 | b7182da | Verified (root+dashboard tsc clean + full vitest 2276 passed/0 failed; 0 dead refs; dashboard/dist untouched; 3 atomic commits + v0.7.0 tag) | [260621-r73-simplify-spawn-agent-message-agent-to-al](./quick/260621-r73-simplify-spawn-agent-message-agent-to-al/) |

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-25)

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Milestone complete

## v1.10 Phase Map

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 48. Sensor Backend | Sensor scripts run on `kind:'script'` schedules, output lands in `ambient/<slug>.md`, every model turn sees a fresh uncached ambient scan, legacy `AMBIENT.md` path deleted | SENSOR-06, SENSOR-07, SENSOR-08, SENSOR-09, SENSOR-10, SENSOR-11, SENSOR-12 | Not started |
| 49. Sensors Dashboard | Dedicated "Sensors" sidebar section with full CRUD, run-on-save wiring, Schedules UI support for `kind:'script'` | SENSOR-01, SENSOR-02, SENSOR-03, SENSOR-04, SENSOR-05 | Not started |

## v1.8 Phase Map

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 46. Tool Access Control | Operator has config-driven, dashboard-editable control over which tools each head may use and which tools each head's sub-agents may use — globally and per-head — enforced at runtime with everything-on defaults | TOOLCFG-01, TOOLCFG-02, TOOLCFG-03, TOOLCFG-04, TOOLCFG-05, TOOLCFG-06, TOOLCFG-07, TOOLCFG-08, TOOLCFG-09 | Not started |

## v1.7 Phase Map (archived)

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 45. Ring Delivery Layer + Timer Ring + Alarm | Sustained dismiss-until-stopped voice alerts: headless ring runner, `ring_device(start\|stop)` tool, auto-derived media_player/LED entities, shrok-served beep, timer skill integration, `set-alarm` skill, non-ack alarm reminders, 24h cap, persisted ring state | RING-01..11, TIMER-01/02, ALARM-01..03 | Shipped 2026-06-07 (closed without verification) |

## Accumulated Context

### Roadmap Evolution

- Phase 19–27 added during v1.2 milestone (voice pipeline, scheduling, agent history migration, frontmatter validation, env var rename)
- Phase 28 added: Add optional prompt parameter to memory functions
- Phase 29–32 added: v1.3 Multi-Head Support (data layer, core activation, adapter registry + config + startup, dashboard)
- Phase 33 added: Multi-head management UI — promoted DASH-F-01/F-03 from Future Requirements into active scope as DASH-03/04/05 (create/rename/delete heads from UI, manage channels per head incl. multiple-of-same-vendor, per-head Send routing)
- Phase 34 added: Multi-Head Agent Lifecycle — fix head_id routing through agent spawn/run/complete so non-default heads receive their own agent completion events (currently default-route to default head; root cause: agents table missing head_id column and all 4 enqueue() callsites in src/sub-agents/local.ts omit headId)
- Phase 35 added: Per-head scheduling — schedules and reminders are currently single-shared (one ScheduleStore at {workspacePath}/schedules/, Schedule type has no headId field, ScheduleEvaluator enqueues triggers with default headId). Non-default heads can never receive their own schedule fires. Closes the scheduling counterpart to Phase 34's agent-lifecycle work
- Phase 36 added: Inbound sender attribution — InboundMessage.senderName field, normalizeSenderName + buildPrefixedText helpers, central prefix construction at headRouteMessage choke point, generalized D-11 stripper, 5 adapters populate senderName
- Phases 37–39 added: v1.4 Unmissable Reminders — schema + tool params (Phase 37), nag mechanism + ack semantics (Phase 38), dashboard UI (Phase 39). Backlog 999.1 promoted into Phase 39 (SCHED-03).
- Phases 40–43 added: v1.5 Home Assistant Voice — config + adapter skeleton (Phase 40), inbound sync reply endpoint (Phase 41), outbound HA REST announce (Phase 42), e2e smoke test + setup docs (Phase 43).
- Phase 44 added: v1.6 Multi-Head Task Delivery — single phase; fan-out of agent_completed to multiple heads, force-complete for scheduled agents, dashboard task delivery multi-select.
- Phase 45 added: v1.7 Voice Alarms & Timers — single phase covering the entire milestone; shared ring delivery layer (ring runner, ring_device tool, auto-derived entities, shrok-served beep, LED control, persisted ring state, 24h cap) + timer skill integration (ring on elapse) + set-alarm skill (non-ack reminder fires ring).
- Phase 46 added: v1.8 Tool Access Control — single phase covering the entire milestone; config schema extensions (global + per-head tool allowlists, tri-state), head-tool enforcement at activation.ts:844, agent-tool threading from spawning head into assembleTools(), dashboard Settings UI (global allowlists) + per-head management UI (per-head overrides with explicit inherit-global state).
- Phase 47 added: v1.9 Head Runs Agent Tools — single phase; dispatch fallthrough from HeadToolExecutor into agent registry executors, candidate-def widening, '/api/tools' retag, AGENTS.md delegation reframe.
- Phases 48–49 added: v1.10 Ambient Context (Sensors) — Phase 48 is the backend vertical slice (sensor entity, `kind:'script'` schedule, child-process runner, ambient/<slug>.md output, ambient folder scan replacing old AMBIENT.md, cache-split injection fix); Phase 49 is the dashboard Sensors section CRUD + Schedules UI wiring.
- Phase 50 added: Per-head xray isolation — eliminate cross-head agent-activity bleed in the dashboard timeline. Reverses the deferred "accepted cross-head leakage (T-33-09)" decision. Two paths: (1) backfill — `/api/agents/xray-history` scoped via `?head=` → `getRecent(50, head)`, frontend passes `selectedHead` + keys `['xray-backfill', selectedHead]`; (2) live — add `head_id` to the `agent_message_added` SSE event payload (`src/dashboard/events.ts` + emit site `src/db/agents.ts`), `useStream` filters live xray accumulation by current head, `['xray-messages']` buffer reset/keyed on head switch. Plus removal of the T-33-09 deferral language in `streamFilter.ts` and tests on all three behaviors. Motivation: Ashley opened the dashboard and saw Zoey's overnight agent activity in Ashley's head view (data is correctly per-head in the DB; leak is purely in the dashboard xray timeline).
- Phase 51 added: v1.10.1 Sensor dual-sink rework — one scheduled sensor run emits a structured `{ ambient?, event? }` JSON payload routing to two head-scoped sinks (passive per-head `ambient/<headId>/<slug>.md` pull + active `sensor_event` priority-queue push that wakes the bound head). SENSOR-13–16. (Complete.)
- Phase 52 added: v1.10.2 Sensor sub-agent sink — third sink on the sensor payload (a sub-agent event carrying a prompt string) that spawns a sub-agent SILENTLY through the existing proactive-decision steward + `kind:'task'` spawn path (schedule-less synthetic trigger), bypassing the conversational head (no head chatter). Renames the Phase-51 `event` sink → "head event", new one → "sub-agent event" (no back-compat; relay/calendar/example sensors migrated). Steward gets a non-schedule-shaped prompt variant. SENSOR-17/18/19. Motivating (separate, later) use case: a calendar sensor that fires a 10-min-before ack-required 60s-nag reminder for upcoming meetings — its dedup lives in the sensor's own state.json, not the framework.

### Key Architecture Decisions (v1.10 — locked in design session)

- A sensor is pure code (no LLM, no agent). Contrast: a task is a prompt run by an agent.
- Scheduling reuses the existing schedules system: `Schedule.kind` gains a third value `'script'` alongside `'task'`/'reminder'`. A `kind:'script'` schedule bypasses the activation loop — the scheduler runs the script directly in its tick via a child process (no queue event, no context assembly, no model call).
- Runner: child process per run, timeout + max-output cap. Success writes stdout (truncated) to `{workspace}/ambient/<slug>.md`. Failure (throw/nonzero/timeout) overwrites that file with trimmed error text. No last-good, no freshness stamps.
- Injection uses a FRESH scan of `ambient/*.md` each turn (not reusing identityLoader). Filename-derived heading: `weather.md` → `## Weather`. Concatenated into the UNCACHED region — AFTER the `\n\nCurrent time:` marker that `toAnthropicSystem` (`src/llm/anthropic.ts`) splits on for `cache_control`.
- Two consumers repointed: `src/head/assembler.ts` (currently injects AMBIENT.md ABOVE the marker = a cache bug) and `readAmbientContext()` in `src/head/activation.ts` → `src/scheduler/proactive.ts`.
- Legacy single-file AMBIENT.md path deleted entirely (both injection points removed).
- Run-once-on-save/enable: a sensor runs immediately when created or re-enabled, not only at the next scheduled tick.
- Heading is owned by the scanner, not the file. Scripts emit pure body text; the scan derives `## <Label>` from the slug. Files stay clean and hand-editable.
- No last-good: failure → overwrite with error. Stale block means genuinely broken, which the error already signals. This avoids forcing a strict parsable schema.

### Key Architecture Decisions (v1.8 — locked in design session)

- Tri-state semantics: `undefined` = inherit global, `null` = all tools, `[array]` = only those tools. Resolution: per-head override (if set) → global default → all tools.
- Everything-on defaults: absent/null means all tools. No existing or newly-created head is ever silently broken. Must be explicitly narrowed.
- No guardrails on core head tools: `spawn_agent`/`message_agent`/`cancel_agent` are fully toggleable — disabling them breaks delegation, but that is the operator's choice.
- Head-tool enforcement point: `src/head/activation.ts:844` (where `HEAD_TOOLS` is currently assigned with no filtering) — add filtering here against the resolved head-tool allowlist.
- Agent-tool enforcement path: reuse existing `worker_defaults.allowedTools` + `assembleTools()` in `src/sub-agents/tool-surface.ts`. Per-head agent allowlist threads from the spawning head's resolved config into `assembleTools()` as the effective `allowedTools`.
- Config schema: `HeadConfigSchema` (`src/config.ts:66-72`) gains two optional per-head tool fields; global allowlists live in `worker_defaults` (head tools as a new sibling to `worker_defaults.allowedTools`).
- Tool picker population: `/api/tools` → `OPTIONAL_TOOL_NAMES` from `src/sub-agents/registry.ts:1362` (already exists, consumed by the dashboard).
- Settings write path: `src/dashboard/routes/settings.ts` PUT + `CONFIG_JSON_FIELDS` (existing mechanism for global settings); per-head overrides go through the head management PATCH route.
- Old per-task `trigger-tools` filtering was deliberately dropped — agent gating flows solely through `agentDefaults`. Do not reintroduce.

### Key Architecture Decisions (v1.7 — locked in design session)

- Hard constraint: no LLM activation per beep. The ring runner loops headless; only start (one activation) and dismiss (one activation) touch the model.
- Dismiss-by-voice is proven on the real Voice PE: "stop" reaches shrok as a normal turn over the playing beep; `media_stop` cuts it instantly (hardware echo-cancel + HA media ducking handle the barge-in).
- `media_player` and LED `light` entities are auto-derived from `haVoiceSatelliteEntityId` via the HA template API (`device_entities(device_id(...))`) — cached per channel, with an optional explicit config override.
- The beep is a bundled static mp3 served at `GET /media/ring.mp3` on shrok's existing server (same host/port as `/v1/chat/completions`). Device-reachable URL is auto-derived from the inbound HA request's `Host` header (cached; scheme from `X-Forwarded-Proto`). `publicBaseUrl` is an optional override only for the loopback/authenticated-proxy edge cases. The route is unauthenticated.
- `ring_device` is a no-op on non-HA channels — safe to call from timers/alarms running on any channel.
- Alarm reminders are non-ack (no nag/escalation). The continuous ring is the entire alert. Silent failure if the device is offline at fire time — accepted trade-off.
- Active ring state is persisted per channel. On restart: stale state is cleared and only players that were actively ringing are stopped — no blind stop-all of unrelated playback.
- 24h auto-dismiss cap is the safety backstop for an undismissed ring.
- The existing `timer` skill is additive-only: step 3 appends `ring_device(start)`; the rest of the skill is unchanged.
- Out of scope (v1.7): physical button-press dismiss (`event.*_button_press` entity requires HA event subscription), concurrent multiple rings on one device, per-alarm custom sounds.

### Key Architecture Decisions (v1.5)

- The ESPHome nabu HTTP client timeout of 5,000 ms is the headline constraint — the synchronous reply must be pre-computed and sent before the `user_message` is even enqueued. Never await head processing before responding.
- `pendingReply` promise slot in the adapter mirrors `VoiceChannelAdapter.activeSocket` — stores resolve/reject functions (not the Express Response object) for testability.
- Apache `/v1/*` must have `AuthType None Require all granted` before the vhost's catch-all basic-auth block — HA's Bearer token otherwise hits a 401 it cannot distinguish from Shrok's own auth rejection.
- HA's ChatLog sends the full `messages[]` array on every turn — adapter extracts only the last user turn; Shrok's own ContextAssembler owns history via a thread ID keyed to `ha-${conversation_id}`.
- `haAccessToken` in `.env` via `ENV_KEY_ALLOWLIST`, never in `config.json` — long-lived HA tokens inherit full user permission level.
- `assist_satellite.announce` fire-and-forget with 30s timeout (`Promise.race`) — known HA bug: satellites regularly get stuck in RESPONDING forever; never retry in a loop.
- `/v1/chat/completions` mounted on the existing dashboard Express server (port 8888), not a new port — Apache already proxies `:8888`, so all paths register automatically.
- `announce` vs `start_conversation` is one parameterized mechanism in `adapter.send()` — the head's intent determines which HA service call is made when no live turn is open.

### Key Architecture Decisions (v1.3)

- Head isolation via `head_id` column on `queue_events` and `messages` — not separate DBs
- All heads run in one Node process; SQLite WAL handles concurrency
- Default head = `'default'` for zero-config backward compatibility
- Memory, identity, and skills are shared across all heads by design
- Channel adapters extended to support multiple instances per vendor (keyed by distinct string IDs)
- `AppStateStore` keys namespaced as `{headId}:keyName` for per-head state isolation
- Phase 30 D-04: `'default'` literal at all remaining call sites (system.ts, index.ts, eval scripts)
- Phase 30 D-06: one `ChannelRouterImpl` per process via DI; CORE-04 regression test guards this contract
- Phase 33 D-WIDEN: `DashboardEvent.message_added` widened with required `headId` field in Plan 33-01 so Plan 03 only needs to widen the remaining per-head event types
- Phase 33 D-INJECTOR-HEADID: `InjectorImpl.headId` is a `private readonly` 2nd positional ctor arg — encodes the lifetime contract that head identity is fixed at construction
- Phase 33 D-TEST-RENAME: Renamed db.test.ts DATA-02 test to reflect that explicit headId is now required at the type level; the SQL DEFAULT path is unreachable from TypeScript callers

## Decisions (Phase 33)

- D-WIDEN: `DashboardEvent.message_added` widened with required headId in Plan 33-01
- D-INJECTOR-HEADID: `InjectorImpl.headId` is `private readonly` 2nd ctor arg
- D-TEST-RENAME: db.test.ts DATA-02 test renamed (explicit headId now required at type level)
- D-MAP-REQUIRED (Plan 33-02): `DashboardServerOptions.dashboardAdapters` is required (not optional) — empty map is a startup bug, not a valid state; defensive 503 kept for tests
- D-FALLBACK-FIRST (Plan 33-02): POST /send falls back to `dashboardAdapters.values().next().value` when body.headId is missing or unknown — preserves single-head behavior and avoids leaking the head list via 404
- D-FILTER-PURE-FN (Plan 33-03): `shouldDeliverStreamEvent` extracted as a pure function in `dashboard/src/hooks/streamFilter.ts` — testable under existing `environment: 'node'` vitest config (no jsdom, no @testing-library, no new devDependency); `useStream()` composes it as a one-line early-return gate at the top of the SSE callback
- D-SCOPE-MIN-CORRECT (Plan 33-03): per RESEARCH § A4 minimum-correct scope, only `message_added` and `typing` carry `headId` in `DashboardEvent` (grep -c "headId: string" src/dashboard/events.ts returns 2); `agent_*`/`steward_run_added`/`memory_retrieval` are explicitly NOT widened — their emit sites live in process-wide stores with no per-head context, and T-33-09 accepts the cross-head leakage
- D-HEADID-FROM-EVENT (Plan 33-03): inside `useStream`'s `message_added` handler, switched from `currentHeadIdRef.current` to `event.headId` for the cache key — the filter gate above guarantees they're equal for delivered events, making the ref a pure filter input rather than a head-identity resolver
- D-MIGRATION-IDEMPOTENT (Plan 33-04): `materializeLazyMigrationIfNeeded` runs before every mutating handler (POST/DELETE/PATCH); early-return guard makes it safe to call repeatedly. Test pins contract via .env byte-equality + fs.statSync().mtimeMs equality so a future refactor that drops the guard fails
- D-EXPORT-ENV-HELPERS (Plan 33-04): exported `parseEnvFile` + `writeEnvFile` from `src/dashboard/routes/settings.ts` rather than inlining a copy in heads.ts — keeps env file format handling (quoting, escape sequences, mode 0o600) in one place
- D-SUBSTR-ANCHORED (Plan 33-04): rename uses `UPDATE app_state SET key = ? || substr(key, oldId.length + 2) WHERE key LIKE 'old:%'` — anchored to the prefix so substrings of the old id later in the key are not mis-edited (vs REPLACE which would)
- D-PATCH-DEFAULT-REJECTED (Plan 33-04): PATCH on `default` returns 400 (mirrors DELETE policy per D-08). Rationale: rename of `default` would leave `heads[]` without a default entry, which `resolveHeads()` would re-synthesize on next restart — silent recovery is worse than rejecting
- D-CHANNEL-UNIQUENESS-HELPER (Plan 33-05): `collectAllChannelIds(heads, excludeChannelId?)` is the single point that enforces D-15 cross-head channel id uniqueness. Zod schema does not refine for uniqueness and `ChannelRouter.set` silently overwrites — without this helper, duplicate channel ids would silently clobber state across heads
- D-PATCH-MERGE-PRESERVATION (Plan 33-05): PATCH channel uses `for (const key of Object.keys(patch)) merged[key] = patch[key]` so only client-sent keys overwrite; absent keys preserve existing on-disk values (D-17 secret preservation). Empty-string secret falls through to Zod `min(1)` rejection — clearing is documented as delete-and-re-add for v1.3
- D-PATCH-VENDOR-INVARIANT (Plan 33-05): PATCH that changes vendor returns 400 'channel vendor cannot change — delete and re-add' BEFORE the Zod re-parse. Vendor change would break the discriminated-union shape (different required fields per vendor); explicit gate produces a clearer error than letting the merge fail Zod
- D-RENAME-IN-PATCH (Plan 33-05): Channel rename is handled inside PATCH (no separate `/rename` route). The body merge treats `{ id }` like any other field; cross-head uniqueness with self excluded runs only when `patch.id !== current channelId`. Keeps API surface minimal — Plan 06 UI can do everything via PATCH
- D-VENDOR-INLINE-STYLE (Plan 33-06): vendor color bands use inline `React.CSSProperties` objects (hex+alpha codes like `#5865F20d` / `#5865F2b3`) rather than Tailwind arbitrary classes — sidesteps purge without touching `tailwind.config.js` safelist; visually identical to ChannelsTab.tsx
- D-HEADS-NO-DRAFT (Plan 33-06): the Heads tab opts out of SettingsModal's draft + Save flow — each per-card mutation calls `onSaved()` directly so the RestartModal triggers after every change; multi-head changes are mandatory-restart per D-05 so batching has no value
- D-COMPONENT-SPLIT (Plan 33-06): three-component split (HeadsTab + HeadCard + ChannelRow) over a monolithic file — per Claude's Discretion in plan; isolates the per-channel pending-state machine (5 vendor variants) from head-level concerns
- D-LEGACY-CHANNELS-PRESERVED (Plan 33-06): `ChannelsTab.tsx` is unmounted from SettingsModal (D-03) but kept on disk as visual reference per CONTEXT.md; vendor color hex codes lifted into `vendor-theme.ts` as the canonical source
- D-OPTIONAL-CONFIRM-ID (Plan 33-07): confirmId on DELETE /api/heads/:id is OPTIONAL — checked only when present in body. Frontend modal always sends it; curl/scripts/no-body tests still work. Backward-compat preserved while giving the UI an audit-trail field
- D-CONFIRM-BEFORE-RESERVED (Plan 33-07): the confirmId mismatch check runs BEFORE the reserved-id check in DELETE /api/heads/:id. A malformed `DELETE /api/heads/default {confirmId: 'work'}` returns 'confirmId does not match' (the more specific error) rather than 'default cannot be deleted'
- D-MODAL-OWNS-QUERY (Plan 33-07): DeleteHeadModal holds its own useQuery(['heads', id, 'counts']) + useMutation rather than receiving counts via props. Counts must be fresh every time the modal opens; 1:1 mount-lifecycle matches data-lifecycle

## Decisions (Phase 34)

- D-MIGRATION-DEFAULT-ONLY (Plan 34-01): sql/007_agents_head_id.sql uses `ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'` and relies on SQLite's constant-DEFAULT semantics to populate existing rows in one shot; no UPDATE backfill. Mirrors Phase 29 sql/005_multi_head.sql verbatim
- D-ROW-WRITE-FROM-OPTIONS (Plan 34-01): head_id rides along on the existing SpawnOptions parameter; AgentStore.create() binds @head_id from options.headId with no `?? 'default'` fallback — the type-required headId on SpawnOptions (Plan 02) is the safety net, SQL DEFAULT is defense-in-depth
- D-INDEX-SHAPE (Plan 34-01): idx_agents_head_status on (head_id, status) mirrors idx_queue_head_status_priority and idx_messages_head_created — consistent head-scoped compound shape across all multi-head tables
- D-WAVE-1-RED (Plan 34-01): tsc --noEmit RED is expected and intentional after Plan 01 alone — SpawnOptions.headId and AgentState.headId are added by Plan 02; vitest passes today because esbuild's transpile-only path tolerates the excess-property issue at runtime
- D-SPAWN-REQUIRED honored (Plan 34-02): SpawnOptions.headId and AgentState.headId added as required `string` fields in `src/types/agent.ts`; no optional variant; matches Phase 33 D-12 (MessageStore.append required-at-type-level) precedent
- D-RUNNER-HEADID Wave 1 (Plan 34-02): `LocalAgentRunnerOptions.headId` added as required string field at the TOP of the interface (identity, not grab-bag); class body deliberately untouched — `private readonly headId` + ctor read + 6 enqueue callsite edits land in Plan 03 (Wave 2)
- D-EXEC-OPTION Wave 1 (Plan 34-02): `HeadToolExecutorOptions.headId` added as a required OPTION field (NOT a 2nd positional ctor arg); JSDoc records the explicit rejection of InjectorImpl's positional pattern — option-field is the natural extension because the interface is already a 15+-field options grab-bag
- D-WAVE-1-GREEN (Plan 34-02): all 5 tsc errors documented in Plan 01's SUMMARY are resolved; new tsc errors land at exactly the construction sites Plans 03/04 will mechanically wire (activation.ts:1247, head/index.ts:171, runner test fixtures, eval scenarios) — Wave 1 contract → Wave 2 implementation cadence working as designed
- D-RUNNER-HEADID Wave 2 honored (Plan 34-03): LocalAgentRunner.headId is `private readonly`, assigned from opts.headId on the very first line of the ctor body; mirrors ActivationLoop's identity-fixed-at-construction precedent
- D-ALL-SIX honored (Plan 34-03): all six queueStore.enqueue() callsites in src/sub-agents/local.ts append `, this.headId` as the 3rd positional argument — closes T-34-09 cross-head info leak at the call site; QueueStore default 'default' remains as defense-in-depth
- D-RESUME-VS-SUBSPAWN (Plan 34-03): resumeSuspended uses `state.headId` (agent's persisted head, matches SpawnOptions contract under any future runner/agent head divergence); handleSpawnAgent uses `this.headId` (sub-agents structurally inherit parent's head, encodes T-34-10 'accept' disposition as compile-time invariant)
- D-RED-SKIPPED (Plan 34-03): TDD-RED cadence intentionally skipped — existing src/sub-agents/agents.test.ts fixtures are already runtime-RED from Plan 01's AgentStore.create binding (Plan 02's documented Wave 1 RED state); Plan 05's fixture wiring is the formal GREEN. Plan 03 lands implementation only — verification via grep + per-callsite priority match + tsc-clean-in-local.ts
- D-EXEC-OPTION Wave 2 honored (Plan 34-04): HeadToolExecutor.dispatch() spawn_agent case injects `headId: this.opts.headId` into the constructed SpawnOptions (src/head/index.ts:175); type-required, no `?? 'default'` fallback at this site
- D-WIRING-IN-SYSTEM honored (Plan 34-04): buildSystem() supplies `headId: deps.headId ?? 'default'` to the LocalAgentRunner ctor options (system.ts:248) and the toolExecutorOpts object (system.ts:335); the activation.ts:766 `{...toolExecutorOpts}` spread carries headId through to HeadToolExecutor without a construction-site edit
- D-RULE-3-ACTIVATION-1247 (Plan 34-04): Rule-3 deviation added `headId: this.opts.headId` at src/head/activation.ts:1251 (scheduled-trigger SpawnOptions). Plan 04 plan text omitted this site but Plans 02 and 03 SUMMARYs both forecast it as a Plan 04 fix; without it `npx tsc --noEmit` fails in production code because Plan 02 made SpawnOptions.headId required
- D-WAVE-2-GREEN (Plans 34-03 + 34-04): production code is tsc-clean for head_id routing through spawn → run → complete; remaining ~40 tsc errors are all at test fixtures (head.test.ts, activation.test.ts, agents.test.ts, cancel.test.ts, archival.test.ts) and eval scripts (scripts/eval/*) that Plan 05 wires
- D-TESTS-BOTH closed (Plan 34-05): tests/integration/multi-head-agent-lifecycle.test.ts has 6 it() blocks pinning persistence (Test 1) + queue stamping for all 6 D-ALL-SIX paths (Tests 2/4/5/6) + cross-head claim isolation (Test 3). Every D-ALL-SIX enqueue path has a runtime head_id-stamping assertion — no path is covered by static tsc alone
- D-SELF-CONTAINED-REGRESSION-TEST (Plan 34-05): the new architectural regression test builds its own minimal LocalAgentRunner via inline makeRunnerForHead() helper rather than sharing tests/integration/helpers.ts — mirrors Phase 30 D-CORE-04 channel-router-isolation.test.ts framing so a future change to the shared helper that misconfigures headId cannot silently mask a regression
- D-WAVE-3-GREEN (Plan 34-05): every test fixture / integration test / eval scenario / harness construction site that took SpawnOptions / LocalAgentRunnerOptions / HeadToolExecutorOptions now supplies headId: 'default' explicitly — 82 occurrences across 15 files. Full repo `npx tsc --noEmit` GREEN; `npx vitest run` 1413/1413 passing. Phase 34 is end-to-end complete

## Decisions (Phase 35)

- D-01-LIST-FILTER-OBJECT-SHAPE (Plan 35-01): list filter is `list(filter?: { headId?: string })` (object-shape, optional inner field) over positional `list(headId?: string)`. Matches the options-object shape used elsewhere; lets future filter fields (kind, enabled) ride along without a breaking signature change
- D-02-MIGRATION-INLINE (Plan 35-01): `migrateLegacyHeadId()` lives inline in `src/db/schedules.ts` (not generalized into file-store.ts). Reminder has a different legacy shape (no `kind` field defaults to 'task') and Phase 33's `.env` migration is unrelated — generalization has no payoff
- D-03-GET-IS-MIGRATION-FUNNEL (Plan 35-01): `markFired/advanceNextRun/markSkipped` refactored to route their internal read through `this.get(id)` rather than `this.store.get(id)`, so the migration runs on every public read path with zero duplication. Smaller diff than per-method migration calls
- D-04-ENQUEUE-3RD-ARG-PER-EVENT (Plan 35-01): `scheduler.tick()` passes `schedule.headId` (per-row, per-event) NOT `this.headId` — no constructor field on `ScheduleEvaluatorImpl`. One global ticker per D-04 in 35-CONTEXT.md; per-head clocks rejected as no-benefit complexity. WR-03 NOTE block at `src/scheduler/index.ts:69-73` removed
- D-09-FACTORY-CLOSURE-NO-DEFAULT (Plan 35-02): `buildScheduleTools(scheduleStore, timezone, unifiedLoader, headId)` and `buildReminderTools(scheduleStore, timezone, headId)` both take `headId` as a required factory arg with no default value. To preserve TypeScript's required-after-optional rule, the existing `unifiedLoader: UnifiedLoader | null = null` default was removed (`unifiedLoader: UnifiedLoader | null` — explicit pass required). Both known callers (tool-surface.ts + 10 agents.test.ts sites) supply it explicitly. Defaulting headId to 'default' would defeat the type-required safety net
- D-10-SCHEMA-ABSENCE-PLUS-RUNTIME (Plan 35-02): `update_schedule` defends against headId reassignment via two layers — (a) absent from `inputSchema.properties` (primary defense: agents don't see headId as a valid field), (b) explicit runtime `if ('headId' in input)` reject at the TOP of execute() before patch construction (defense-in-depth for clients that ignore schema). Both contracts pinned by tests
- D-08-STRUCTURAL-CALLBACK (Plan 35-02): `ActivationLoopOptions.resolveCurrentHeads` typed as minimal structural `() => Array<{ id; channels: Array<{ id }> }>` rather than `() => ResolvedHead[]`. The reminder fire site only needs `.id` and `.channels[].id`; importing ResolvedHead would couple the activation interface to future ResolvedHead fields for no reading-side benefit. Matches Phase 33 D-SCOPE-MIN-CORRECT minimal-contract pattern
- D-08-DEFAULT-CALLBACK (Plan 35-02): `buildSystem` supplies a default `() => [{ id: deps.headId ?? 'default', channels: [] }]` callback when `SystemDeps.resolveCurrentHeads` is omitted. Empty-channels return exercises the D-07 skip+log path (backward-compatible for single-head hosts and test fixtures). The host (`src/index.ts`) supplies the production `() => resolveHeads(loadConfig())` so dashboard edits between scheduler ticks land without restart. Mirrors `DashboardServerOptions.resolveCurrentHeads` pattern verbatim
- D-11-ADMIN-404 (Plan 35-03): POST /api/schedules with unknown headId returns 404 with the head id in the error message — explicitly NOT the Phase 33 D-FALLBACK-FIRST policy used by POST /send. Schedules are administrative; silent fallback would hide a real config bug
- D-12-NO-FILTER-PARAM (Plan 35-03): GET /api/schedules returns ALL schedules cross-head with no `?headId=` filter param. `ScheduleStore.list({ headId })` filter exists but dashboard renders cross-head in one table tagged by headId column
- D-13-EXPLICIT-REJECT-NO-STRIP (Plan 35-03): PATCH with headId in body returns 400 explicitly with "To move a schedule to a different head, delete and recreate". No silent strip — mirrors agent-side D-10 reject from Plan 35-02
- D-16-SPLIT-COUNTS-IN-STORE (Plan 35-03): `ScheduleStore.deleteAllForHead` returns split `{ schedules, reminders }` rather than flat total — different vendor surfaces (tasks run TASK.md vs reminders fire to a channel) so UI renders separately. Iterates `this.list()` so lazy-migration funnel runs first
- D-17-CASCADE-AFTER-SQL (Plan 35-03): DELETE /api/heads/:id runs SQL transaction FIRST, then file-store cascade (T-35-12 mitigation). SQL failure → FS untouched; SQL success → FS partial-fail is recoverable (orphan files harmless because head is gone from config). Response widens to `{ ok, deletedSchedules, deletedReminders }`

## Decisions (Phase 36)

- D-CHARCLASS (Plan 36-01): forbidden-char strip is a single character-class regex `/[\[\]:]/g` (locked by `<action>` Step B code block in 36-01-PLAN.md). Functionally identical to alternate spellings and runs in one V8 regex pass — chosen over three sequential `replace()` calls
- D-STRICT-TRUNCATE (Plan 36-01): `normalizeSenderName` truncate predicate is strict-greater-than 40 (`out.length > MAX_SENDER_NAME_LEN`). Test 11 pins that an exactly-40-char input passes through unchanged with NO ellipsis — future refactorers must not tighten to `>=`
- D-NO-BODY-TRIM (Plan 36-01): `buildPrefixedText` does NOT trim `rawText` before append. Test 20 pins `'[Ashley]:    '` (1 separator space + 3 body spaces = 4 trailing spaces) as the locked output for body `'   '` — user-typed body whitespace is preserved verbatim, only senderName side normalizes whitespace
- AC4-GREP-TYPO (Plan 36-01): Plan 01 acceptance criterion AC4 grep pattern decodes (under bash double-escape) to a regex source spelling that no canonical implementation of the locked `<action>` Step B code block produces. Documented as a planner-text typo; implementation follows the code block byte-identically and all 13 normalizeSenderName tests (covering Tests 4/5/6/18 which functionally pin forbidden-char strip behavior) are GREEN. NOT a code deviation
- D-HARD-RENAME (Plan 36-02): stripTimestampEcho → stripLeadingBracketPrefixes is a hard rename — no shim/alias. Orphan-reference grep across src/tests/scripts clean. Rationale: keeping a shim would invite future code to use the stale name and dilute D-12 intent that the function name match its broader behavior
- D-FIRST-LINE-ONLY-PRESERVED (Plan 36-02): stripLeadingBracketPrefixes regex uses single-line `^` anchor (no `/m` flag); line-2+ usage of `[...]` passes through unchanged. Pinned by "leaves line-2 bracket unchanged" anti-regression test. Future regex tightening cannot silently break head responses that legitimately use brackets after a newline
- D-EMPTY-BRACKETS-DISALLOWED (Plan 36-02): regex uses `[^\]]+` (≥1 non-`]` char inside) rather than `[^\]]*`, so a literal `[]` at start passes through unchanged. Matches locked D-11 spec byte-identically and pinned by "leaves empty brackets unchanged" anti-regression test
- D-SLACK-TTL-PER-INSTANCE (Plan 36-03): senderNameCache is a per-SlackAdapter `Map<userId, {name, fetchedAt}>` with 10-min TTL (`SENDER_NAME_TTL_MS = 10 * 60 * 1000`). Multi-head isolation is automatic because each head constructs its own adapter. API failures fall back to the raw user id and are NOT cached, allowing retry on the next inbound message from the same user
- D-CLIQ-INLINE-HELPER (Plan 36-03): `senderNameOf` is defined inline inside `poll()` rather than as a top-level helper. Used only at two call sites inside the same loop body. File-message background closure synchronously captures `senderName` before the void IIFE, matching how `handler` and `channel` are already captured at the same spot
- D-WHATSAPP-DIRECT-FIELD (Plan 36-03): WhatsApp's chain always resolves to a non-empty string (`'unknown'` fallback per D-05) so the handler object literal writes `senderName,` directly without the conditional-spread guard used in Discord/Slack/Cliq. Telegram keeps the spread as defensive shape-consistency despite also always-resolving

## Decisions (Phase 39)

- D-03-FLOOR-1 (Plan 39-01): nag floor corrected 5→1 in registry.ts (`nagSum < 1`) and route handler; error strings say "minimum 1 minute"; old `nagSum < 5` condition fully removed
- D-10-STARTAT (Plan 39-01): startAt override implemented in POST route — when cron + future startAt provided, `nextRun = startAt.toISOString()` while cron is retained in createOpts (Pitfall 4 avoided)
- D-12-ROUTE-COMPUTE (Plan 39-01): D-12 ack-off-while-nagging transition computed in PATCH route (option b from RESEARCH): resets `nagIntervalMinutes=null`, conditionally clears `ackPending` and recomputes `nextRun` via `nextRunAfter(cron, now, timezone)`; `update()` signature unchanged
- D-04-STANDALONE-NAG (Plan 39-01): PATCH bare `{ nagIntervalMinutes: 0 }` on a stored `requiresAck:true` reminder reads existing row via `scheduleStore.get(id)` and rejects with 400 — prevents stranding an ack-required reminder with no nag interval (T-39-09 mitigated)

## Decisions (Phase 40)

- D-04 (Plan 40-01): HA_ACCESS_TOKEN added to ENV_KEY_ALLOWLIST only — no per-channel `haAccessToken` field on ChannelConfigSchema, no flat ConfigSchema key; adapter reads `process.env['HA_ACCESS_TOKEN']` directly at call-time in Phase 42; token never in git-tracked config.json (T-40-01 mitigated)
- D-06 (Plan 40-01): `id: z.string().min(1)` kept on home-assistant union member for consistency with all other vendors; adapter routing id is fixed to 'home-assistant' regardless
- Rule-2-heads-ts (Plan 40-01): `ChannelConfigMasked` type and `maskChannel()` switch in `src/dashboard/routes/heads.ts` extended to cover the new 'home-assistant' union member — exhaustiveness enforcement (tsc TS2366)
- D-05 (Plan 40-02): send() emits log.warn with text.length only, never throws, never logs token — loud-but-safe stub until Phase 42
- D-06-adapter (Plan 40-02): adapter registered under fixed id 'home-assistant'; headId stored for Phase 41+ use; no singleton tracking per single-instance decision
- SC3-corrected (Plan 40-02): lastActiveChannel is OUTBOUND-ONLY (router.ts:21); injectMessage alone does NOT stamp it; only outbound router.send() stamps it — pinned by the corrected-assumption guard in adapter.test.ts Block B step 4

## Decisions (Phase 44)

- D-AGENTS-DELIVER-JSON (Plan 44-01): deliver_to_head_ids is a JSON TEXT column on agents with DEFAULT '[]'; rowToState always JSON.parse it (no conditional spread — always present from DEFAULT); create() always JSON.stringify(options.deliverToHeadIds ?? []) — mirrors tools/capabilities pattern
- D-SCHEDULE-ABSENT-NOT-EMPTY (Plan 44-01): deliverToHeadIds is ABSENT on legacy and reminder rows (no migrateLegacySchedule guard added); absent = owner-only behavior; adding a guard would mark files migrated and update mtime with no semantic gain (D-02)
- D-CONDITIONAL-SPREAD-CREATE (Plan 44-01): create() uses ...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {}) — NOT ?? [] — to avoid writing empty-array key noise onto every task/reminder row
- D-DELETE-ON-EMPTY-UPDATE (Plan 44-01): update() deletes the key when patch.deliverToHeadIds === [] rather than setting to [] or undefined — exactOptionalPropertyTypes compliance + clean JSON (key-absent = owner-only)
- D-13-PRESERVED (Plan 44-01): headId stays excluded from SchedulePatch Pick<> union (Phase 35 D-13 ban intact); deliverToHeadIds IS in the union (editable per D-08)
- D-FAN-OUT-BOTH-SITES (Plan 44-02): both completeAgent and ctx.complete closure receive identical fan-out loops over dedupe([headId,...deliverToHeadIds]) — missing the closure site silently delivers tool-driven early-exits to owner only
- D-DEDUP-OWNER (Plan 44-02): deliverySet uses new Set([this.headId, ...]) so owner is never double-enqueued even if listed in deliverToHeadIds
- D-TRIGGER-GATE (Plan 44-02): options.trigger === 'scheduled' predicate in suspendAsQuestion is narrow — manual agents keep suspending; sub-agent parentAgentId branch unchanged
- D-ACTIVATION-SINGLE-SITE (Plan 44-02): only handleScheduleTrigger touched (D-07: multi-head is scheduled path only); manual spawn_agent and sub-agent spawns byte-identical to before
- D-44-03-POST-BLOCK-PLACEMENT (Plan 44-03): deliverToHeadIds validation block placed after kind determination and before task-name check — kind is the gate for task-only enforcement
- D-44-03-PATCH-BLOCK-PLACEMENT (Plan 44-03): deliverToHeadIds PATCH block placed after ack/nag block and before scheduleStore.update; uses existing bodyObj variable (constructed for D-13 guard)
- D-44-03-EMPTY-ARRAY-PATCH (Plan 44-03): empty array on PATCH passes through to patch.deliverToHeadIds = [] so store.update delete-on-empty reverts to owner-only; returned schedule body has key absent
- D-WAIT-ALL (Plan 44-05): waitForAllQueueEvents helper inlined in test file for multi-row fan-out assertions — polls until minCount rows appear; waitForQueueEvent(LIMIT 1) is insufficient for fan-out/dedup tests
- D-TEST-TRIGGER-SCHEDULED (Plan 44-05): fan-out, dedup, and regression tests use trigger:'scheduled' to exercise the production handleScheduleTrigger spawn path through activation.ts
- D-DASHBOARD-OWNER-EXCLUDED (Plan 44-04): owner head filtered from "deliver to" multi-select options; owner is always implicitly included via chip-render dedup — offering owner as selectable would be redundant and confusing
- D-DASHBOARD-EMPTY-PATCH (Plan 44-04): clearing the multi-select sends `deliverToHeadIds: []` on PATCH; `store.update` delete-on-empty (Plan 44-01) reverts to owner-only — no special UI affordance needed

## Decisions (Phase 45 Plan 04)

- D-45-04-SINGLETON: executeRingDevice uses module-level singletons set by initRingTool so OPTIONAL_TOOLS Map entry can be static — matches all existing OPTIONAL_TOOLS entries, no factory needed
- D-45-04-DISPATCH-NOOP: head dispatch case 'ring_device' returns {ok:true,note:'ring runner not configured'} when ringRunner is absent — safe degradation for heads without HA wiring
- D-45-04-SOURCE-COERCE: source input outside 'alarm'/'timer' coerces to 'timer' as safe default; schema enum is primary guard (T-45-04-ENUM mitigated)
- D-45-04-PREINIT-NOOP: executeRingDevice before initRingTool returns {ok:true,note:'ring not configured'} — never throws (RING-04 extension to uninitialized state)

## Decisions (Phase 45)

- D-45-01-ALLOWLIST (Plan 45-01): publicBaseUrl/ringVolume/ringCapHours NOT added to ENV_KEY_ALLOWLIST — behavioral config.json fields, not secrets; only HA_ACCESS_TOKEN and HA_INBOUND_API_KEY belong there per D-04 (T-45-01-CFG mitigated)
- D-45-01-HEADID-REQUIRED (Plan 45-01): AgentContext.headId added as required string with no default — mirrors Phase 34 D-SPAWN-REQUIRED; compiler errors at inline ctx construction sites are the safety net
- D-45-01-HEADID-PUBLIC (Plan 45-01): HomeAssistantChannelAdapter.headId promoted from private readonly to public readonly directly — simpler than adding a getter over a renamed backing field; no behavior change; enables ring tool startup wiring (haAdapters.find(a => a.headId === headId))
- D-45-01-URL-CACHE-MEMORY-ONLY (Plan 45-01): deviceReachableBaseUrl cached in-memory only in Plan 01; Plan 03 gates caching to non-loopback Host headers from authenticated HA turns (T-45-01-URL mitigated)
- D-45-01-GETCONFIG-NO-TOKEN (Plan 45-01): getConfig() returns only haBaseUrl/haVoiceSatelliteEntityId; D-05 token safety preserved; no new HA_ACCESS_TOKEN references in any of the three new adapter methods
- D-45-05-CTOR-2ARGS (Plan 45-05): RingRunner ctor takes 2 args (store + config); haAdapters resolver is NOT stored at construction — passed only to initRingTool and used by dispatchForHead; plan scope note was aspirational, not the real signature
- D-45-05-RINGCONFIG-SPREAD (Plan 45-05): exactOptionalPropertyTypes fix — narrowed ringConfig object with conditional publicBaseUrl spread so key is absent (not present-as-undefined) when config.publicBaseUrl is not set; passing full Config directly fails tsc
- D-45-06-TIMER-ADDITIVE (Plan 45-06): timer step 3 ring_device call is purely additive — no competing path, no structure change (TIMER-02 locked)
- D-45-06-ALARM-IMPERATIVE (Plan 45-06): set-alarm fire-time message uses 'MUST call ring_device' phrasing to prevent Pitfall 6 (LLM narrating instead of tool-calling)
- D-45-06-NO-ACK (Plan 45-06): set-alarm never sets requiresAck/nag — continuous ring + 24h cap is the entire alert mechanism
- D-45-06-TEST-SCOPE (Plan 45-06): TIMER-02 test checks numbered steps section only (not guidance text); ALARM-03 test checks code-block examples only (not constraint text) — avoids false positives from advisory references

## Decisions (Phase 48)

- D-48-03-THREE-CALL-SITES (Plan 48-03): activation.ts had THREE readAmbientContext() call sites (lines ~1136, ~1213, plus one at different indentation); all three replaced with scanAmbient() via workspacePath ternary guard. The plan named two; the third was caught by test failures and fixed as Rule 1 auto-fix.
- D-48-03-WORKSPACEPATH-FIXTURE (Plan 48-03): activation.test.ts makeFixture config lacked workspacePath, so scanAmbient call site was unreachable (ternary returned '' before calling scanAmbient). Added workspacePath: tmpDir to the config. Existing tests unaffected (tmpDir has no ambient/ directory — scanAmbient returns '' for all legacy tests).

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 45    | 06   | 4min     | 3     | 3     |
| 45    | 01   | 4min     | 3     | 7     |
| 44    | 03   | 2min     | 2     | 2     |
| 44    | 02   | 5min     | 2     | 2     |
| 44    | 01   | 3min     | 2     | 5     |
| 33    | 01   | 14min    | 3     | 26    |
| 33    | 02   | 5min     | 3     | 4     |
| 33    | 03   | 3min     | 2     | 6     |
| 33    | 04   | 6min     | 3     | 3     |
| 33    | 05   | 4min     | 2     | 2     |
| 33    | 06   | 6min     | 3     | 7     |
| 33    | 07   | 5min     | 2     | 5     |
| 34    | 01   | 3min     | 2     | 3     |
| 34    | 02   | 2min     | 3     | 3     |
| Phase 34 P03 | 4min | 2 tasks | 1 files |
| Phase 34 P04 | 3min | 2 tasks | 3 files |
| Phase 34 P05 | 14min | 2 tasks | 16 files |
| Phase 35 P01 | 8min | 2 tasks | 10 files |
| Phase 35 P02 | 13min | 2 tasks | 13 files |
| Phase 35-per-head-scheduling P03 | 9min | 2 tasks | 7 files |
| Phase 36 P01 | 4min | 2 tasks | 4 files |
| Phase 36 P02 | 4min | 2 tasks | 3 files |
| Phase 36 P03 | 7min | 5 tasks | 5 files |
| Phase 39 P01 | 6min | 3 tasks | 7 files |
| Phase 40 P01 | 4min | 2 tasks | 3 files |
| Phase 40 P02 | 3min | 3 tasks | 3 files |
| Phase 44 P05 | 3min | 2 tasks | 1 files |
| Phase 44 P04 | 20min | 3 tasks | 3 files |
| Phase 45 P01 | 4min | 3 tasks | 7 files |
| Phase 45 P02 | 8min | 2 tasks | 4 files |
| Phase 45 P04 | 8min | 2 tasks | 4 files |
| Phase 45 P05 | 8min | 2 tasks | 2 files |
| Phase 46 P01 | 2min | 3 tasks | 4 files |
| Phase 46 P02 | 5min | 2 tasks | 4 files |
| Phase 46 P03 | 3min | 3 tasks | 6 files |
| Phase 48-sensor-backend P02 | 8min | 2 tasks | 4 files |
| Phase 48-sensor-backend P03 | 5min | 2 tasks | 6 files |
| Phase 49-sensors-dashboard P02 | continuation | 3 tasks | 4 files |
| Phase 51 P01 | 8min | 2 tasks | 3 files |
| Phase 51-sensor-dual-sink P03 | 4min | 2 tasks | 7 files |
| Phase 51-sensor-dual-sink P04 | 12min | 3 tasks | 7 files |
| Phase 52 P02 | 3min | 2 tasks | 5 files |
| Phase 52 P03 | 15min | 2 tasks | 5 files |

## Operator Next Steps

- Phase 49-02 COMPLETE (human-verify APPROVED) — proceed to Phase 49-03 (Schedules UI kind:'script' support)
