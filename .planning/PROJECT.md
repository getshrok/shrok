# Shrok

## What This Is

Shrok is a self-hosted personal AI agent that maintains a single persistent identity across channels (Discord, Telegram, Slack, WhatsApp, Zoho Cliq, web dashboard). Its core design principle: the head never does work directly — it delegates to asynchronous sub-agents. The head handles routing, memory, and coordination; agents handle execution.

## Core Value

A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

## Current Milestone: v1.4 Unmissable Reminders

**Goal:** Add an opt-in reminder severity that nags on a configurable interval until the user explicitly acknowledges it — so high-stakes reminders (appointments, meds) can't fire into the void — and surface dashboard start-date controls for recurring schedules.

**Target features:**
- `requiresAck` + `nagInterval` fields on the reminder schedule schema (lazy JSON/SQL migration, mirroring Phase 35's `headId` addition)
- `create_reminder` tool gains `requiresAck` + `nagInterval` params
- A new, narrowly-scoped ack tool/agent — description airtight so the model never fires it on ordinary reminders
- System-native nag re-arm: the scheduler/activation layer arms the next nag in code *before* delivering the current one (nagging never depends on the head doing work each cycle)
- Ack semantics by type: one-time → delete; recurring → mark this occurrence acked + stop the nag sub-loop while base cron continues; ack also cancels the already-armed in-flight nag
- Injected reminder event carries the reminder ID + ack instructions (no system-prompt entry)
- Dashboard reminder forms expose `requiresAck` + `nagInterval` toggles
- Dashboard start-date inputs for recurring schedules/reminders/tasks (backlog 999.1 — maps to `triggerAt` + `cron`)

## Requirements

### Validated

- ✓ Tool-call descriptions on all agent tool schemas — v1.0 Phase 1–4
- ✓ Dashboard renders tool-call intent summaries with collapsible raw JSON — v1.0 Phase 2
- ✓ Channel adapters include tool-call descriptions in message text — v1.0 Phase 3
- ✓ Jobs system surfaced to agents via system prompt and auto-injection — v1.1 Phase 10
- ✓ Voice mode: STT/TTS pipeline with VAD gating and barge-in — v1.2 Phases 19–22
- ✓ Timezone-aware scheduling — v1.2 Phase 23
- ✓ `message_agent` mid-loop delivery — v1.2 Phase 24
- ✓ Agent history migrated from JSON blob to per-row table — v1.2 Phase 25
- ✓ Frontmatter validation on SKILL.md / TASK.md writes — v1.2 Phase 26
- ✓ `$WORKSPACE_PATH` → `$SHROK_WORKSPACE_PATH` rename — v1.2 Phase 27
- ✓ Memory prompt overrides via MEMORY-*.md files — v1.2 Phase 28
- ✓ `head_id` isolation column on `queue_events` and `messages`; QueueStore and MessageStore read methods scoped by headId — v1.3 Phase 29
- ✓ `AppStateStore` and `ActivationLoop` fully head-scoped; per-head `lastActiveChannel` and archival lock namespaced; all call sites wired; CORE-01–CORE-04 verified — v1.3 Phase 30
- ✓ `heads[]` config schema (Zod discriminated union); `resolveHeads()`; all 7 adapters carry `headId`; `QueueStore.enqueue` threads `head_id`; `src/index.ts` startup loop instantiates one `ChannelRouter` + `ActivationLoop` per head; backward-compatible default head — v1.3 Phase 31
- ✓ Dashboard head selector: GET /api/heads, ?head= scoped message filtering, head pill row (hidden in single-head), localStorage persistence with stale-id fallback, SSE routing via ref pattern — v1.3 Phase 32
- ✓ Multi-head management UI: POST/PATCH/DELETE /api/heads + channel sub-resource with multi-of-same-vendor support, lazy migration on first save, atomic 3-table rename UPDATE, single-transaction delete wipe, default non-deletable, typed-confirmation DeleteHeadModal, per-head SSE event filter, per-head DashboardChannelAdapter map — v1.3 Phase 33 (UAT pending)
- ✓ Multi-head agent lifecycle: `head_id` column on `agents` table; required `headId: string` on `SpawnOptions` / `AgentState` / `LocalAgentRunnerOptions` / `HeadToolExecutorOptions`; `LocalAgentRunner.headId` ctor field threaded through all 6 `queueStore.enqueue` callsites; `buildSystem` / `HeadToolExecutor.spawn_agent` / `activation.ts:1251` all supply `headId`; architectural regression test pins per-event head_id stamping + cross-head claim isolation — v1.3 Phase 34 (live multi-head smoke test pending)
- ✓ Per-head scheduling: `Schedule.headId` required field at storage type; lazy JSON migration stamps legacy files; `ScheduleEvaluator` passes `schedule.headId` as 3rd enqueue arg (per-event, not constructor-fixed); `buildScheduleTools`/`buildReminderTools` factories require headId; `update_schedule` rejects headId reassignment (schema-absent + runtime reject); reminder fire first-channel fallback when last-active null; `POST /api/schedules` validates head-list membership (400/404); `DELETE /api/heads/:id` cascades to `ScheduleStore.deleteAllForHead` after SQL txn with `{deletedSchedules, deletedReminders}` count; dashboard UI head picker + Head column with deterministic palette; architectural regression test `tests/integration/multi-head-scheduling.test.ts` pins cross-head schedule isolation — v1.3 Phase 35
- ✓ Inbound sender attribution: `InboundMessage.senderName?: string` optional field on the channel type contract; `normalizeSenderName` (strips `[`, `]`, `:`; collapses whitespace; trims; truncates >40 codepoints with `…`) and `buildPrefixedText` (sole producer of `[Name]: body` shape) in `src/head/sender-prefix.ts`; `headRouteMessage` enqueues prefixed text once at the central choke point (slash-command detection runs on raw `msg.text` first); leading-bracket-prefix stripper generalized from three pattern-specific regexes to one D-11 regex `/^(\s*\[[^\]]+\]\s*:?\s*)+/` and renamed `stripTimestampEcho` → `stripLeadingBracketPrefixes`; five adapters populate `senderName` (Discord member/author fallback chain, Telegram `first_name`+`last_name`/`username`, Slack TTL-cached `users.info`, WhatsApp `pushName`, Cliq `sender.name`/`id`); voice / dashboard / webhook adapters intentionally untouched (D-06); threat register T-36-01/02/03/06/07 mitigated — v1.3 Phase 36
- ✓ Reminder ack schema + tool-param foundation: `requiresAck: boolean` + `nagIntervalMinutes: number | null` on the `Schedule` type and optional counterparts on `CreateScheduleOptions`, defaulted (`?? false` / `?? null`) in `ScheduleStore.create()`; lazy JSON migration (`migrateLegacyHeadId` → `migrateLegacySchedule`) stamps both fields on first read via idempotent `'field' in obj` guards (mtime-stable, wired into get/list/getDue); `create_reminder` declares `requiresAck`/`nagMinutes`/`nagHours`/`nagDays` with boundary validation (per-slot integer guard, ack↔nag coupling, 5-min floor / 30-day ceiling, slot-sum → `nagIntervalMinutes`, all returning `{error,message}` not throwing); description reworded so `triggerAt`+`cron` reads start-then-repeat (SCHED-04); `SchedulePatch`/`update()` deliberately untouched (creation-only). **Runtime nag consumption (scheduler re-arm, ack tool/agent) deferred to Phase 38.** — v1.4 Phase 37
- ✓ Runtime nag mechanism + ack semantics: `ackPending: boolean` added to the `Schedule` type / `CreateScheduleOptions` / `SchedulePatch` / `create()` defaults / `update()` apply-block / lazy migration; scheduler `requiresAck && nagIntervalMinutes!==null` re-arm branch placed first in `tick()`'s advance block (`advanceNextRun` to now+nagInterval, stays `enabled`, never hits the one-time disable path); activation fire branch made ack-aware (steward bypass, `ackPending=true` before enqueue, no one-time self-delete, enriched `systemTrigger` carrying `reminderId` + `requires-ack` + ack instruction body); head-direct `acknowledge_reminder` tool (one-time `delete` vs recurring `nextRunAfter` cron-resume, two-layer scoping with server-side `requiresAck===false||kind!=='reminder'` hard error, benign no-ops) threaded via `HeadToolExecutorOptions.scheduleStore`/`timezone` and wired through `buildSystem`'s `toolExecutorOpts`; WR-01 hardening — channel-outage delete guarded with `!requiresAck` so ack reminders survive outages and re-nag; ACK-03–ACK-08 verified (5/5) — v1.4 Phase 38
- ✓ Dashboard reminder ack/nag UI + start-date controls (SCHED-01/02/03): frontend `Schedule` type fixed to carry `requiresAck`/`nagIntervalMinutes`/`ackPending`; `SchedulePatch`+`update()` extended to **edit** ack/nag post-create (D-11, supersedes D-09's creation-only stance); dashboard POST/PATCH routes validate ack↔nag coupling, 1-min floor / 30-day ceiling, `Number.isInteger` guard, `startAt`→`nextRun` mapping (cron retained), and the D-12 ack-off-while-nagging transition (recompute uses schedule `cronTimezone`; one-time already-fired → `nextRun=null` so it goes quiet); `create_reminder` nag floor corrected 5→1 min (D-03); React UI — amber **NAGS** badge gated on `requiresAck` + "· nags every Xh" sub-label on ack rows, reveal-when-on ack/nag editing in the edit modal (ack/nag-only edits now persist — WR-01 fix) and create form, optional Start date/time on both create forms in repeating mode with future-only enforcement and backward-compatible empty-start behavior; both rendered-UI checkpoints user-approved; code review 0 critical / 4 warning (all fixed) / 4 info; 1544 tests green — v1.4 Phase 39

### Active

- _(none — all v1.4 Unmissable Reminders requirements validated; milestone feature work complete)_

### Out of Scope

- **Cross-head message passing** — heads are independent; no inter-head routing (keeps architecture simple)
- **Per-head identity or skills** — all heads share the same identity files and skills (by design)
- **Per-head memory** — memory is shared across all heads (by design)
- **Multi-process isolation** — heads run in the same process sharing the SQLite DB (simpler ops)

## Context

- Built on Node 22+ using `node:sqlite` (synchronous `DatabaseSync`) — SQLite WAL mode handles concurrent readers/writers safely for multi-head
- ICW (infinite-context-window) is a vendored sibling dependency — never edit `src/icw/` directly
- Channel adapters are currently keyed by a single string ID per vendor (e.g., `'telegram'`) — multi-head requires extending this to support multiple instances per vendor
- `AppStateStore` uses flat K-V pairs (e.g., `lastActiveChannel`) that need namespacing (e.g., `personal:lastActiveChannel`) for multi-head
- The archival lock (`archivalLock`) is currently global — needs per-head lock in `AppStateStore`
- All existing `queue_events` and `messages` rows will be assigned `head_id = 'default'` via migration
- Reminders are `kind:'reminder'` schedule rows (NOT workspace tasks), stored as JSON files via `src/db/file-store.ts`; tools `create_reminder`/`list_reminders`/`cancel_reminder` are built in `src/sub-agents/registry.ts`
- Start-date for recurring reminders is **already a backend capability**: `create_reminder` accepts `triggerAt` + `cron` together (first fire at `triggerAt`, then `scheduler` advances `nextRun` from cron). 999.1 is UI-only — verify + document/loosen, do not rebuild
- Reminder fire path lives in `src/head/activation.ts` (channel resolve → steward skip check → one-time self-delete → `systemTrigger('reminder', …)` inject); no ack/nag/escalation concept exists today

## Constraints

- **Compatibility**: Single-head deployments must work unchanged — the `default` head is implicit when no `heads` config is present
- **DB**: SQLite only — no external queue broker; per-head isolation via `head_id` column filter
- **Process**: All heads run in one Node process — no multiprocessing, no IPC
- **Memory/Identity**: Shared across heads — not configurable per-head in this milestone

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Head namespace via `head_id` column (not separate DBs) | Shared memory + simple ops; WAL handles concurrency | Validated in Phase 29 |
| Heads run as concurrent loops in one process | Simpler than multi-process; SQLite WAL sufficient | Validated in Phase 31 |
| Default head = `'default'` for backward compat | Zero-config migration for existing deployments | Validated in Phase 29 |
| Channel adapters extended to support multiple instances per vendor | Needed for multiple Telegram/Discord bots per head | Validated in Phase 31 |
| Memory and identity shared across all heads | Core design principle — single identity, shared context | — Pending |
| Head identity is type-required at every spawn/run/complete site | Compile-time enforcement closes the silent-default-routing class of bug | Validated in Phase 34 |
| Sender attribution via `[Name]:` prefix constructed at the head's central choke point (not per-adapter) | Single producer + single stripper means adapters cannot forge or skip the prefix; normalization defends shape integrity | Validated in Phase 36 |
| `create_reminder` description pre-advertises nag-until-acknowledged behavior before the runtime exists (D-10b) | Foundation phase ships the schema + params; description becomes fully true when Phase 38 lands. Ratified over REVIEW CR-01's soften recommendation | Ratified in Phase 37 |
| Nag fields are creation-only (`SchedulePatch`/`update()` exclude them) (D-09) | No edit path keeps the preservation invariant simple; toggling ack post-create is out of scope | Validated in Phase 37 — **superseded by D-11 in Phase 39** |
| Ack/nag fields are editable post-create via `SchedulePatch`/`update()`; toggling ack off while nagging cleans up the in-flight nag (D-11/D-12) | The dashboard edit UI needs a real edit path; preservation invariant kept by validating coupling/bounds on every PATCH | Validated in Phase 39 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-24 — Phase 39 complete (Dashboard Reminder UI), the FINAL phase of milestone v1.4 Unmissable Reminders. Backend+type contract (39-01): frontend `Schedule` type carries `requiresAck`/`nagIntervalMinutes`/`ackPending`; `SchedulePatch`+`update()` now edit ack/nag (D-11 supersedes D-09 creation-only); POST/PATCH validate coupling + 1-min floor / 30-day ceiling + `Number.isInteger` + `startAt`→`nextRun` (cron retained) + D-12 ack-off transition (schedule-`cronTimezone` recompute; one-time already-fired → `nextRun=null`); `create_reminder` floor 5→1 (D-03). UI (39-02 list/edit, 39-03 create): amber NAGS badge (gated on `requiresAck`) + nag-cadence sub-label; reveal-when-on ack/nag editing in edit modal + create form (ack/nag-only edits persist — WR-01 fix); optional Start date/time on both create forms (repeating mode, future-only, empty-start backward-compatible). SCHED-01/02/03 verified 3/3; both rendered-UI human-verify checkpoints user-approved. Code review standard depth: 0 critical / 4 warning (WR-01..WR-04 all fixed: 64ea29f/2dcc2cc/86f87fd/d3a42ee, +5 tests) / 4 info (deferred). 1544 vitest tests + tsc clean + dashboard build green. **Milestone v1.4 feature work complete — not yet formally closed via /gsd-complete-milestone (audit + live smoke tests pending; note v1.3 also never formally closed).** Prior: Phase 38 complete (Nag Mechanism & Ack Semantics): `ackPending` schema field + lazy migration; scheduler `requiresAck` nag re-arm branch (re-arms to now+nagInterval, stays enabled, first in `tick()` advance block); ack-aware activation fire branch (steward bypass, `ackPending=true` before enqueue, enriched `systemTrigger` with `reminderId`+`requires-ack`+ack instruction); head-direct `acknowledge_reminder` tool (one-time delete vs recurring cron-resume, two-layer scoping, benign no-ops) threaded via `HeadToolExecutorOptions`. ACK-03–ACK-08 verified (5/5); 71 phase + 414 regression tests green, tsc clean. Code review: 0 critical / 6 warning / 5 info — WR-01 (one-time ack reminder deleted on channel outage) fixed in this phase (commit 510aab3, +Test E); WR-02..WR-06 tracked in 38-REVIEW.md for a later polish pass. Note: Phase 38 hit a cwd-drift deviation during parallel worktree execution (38-03 committed to main directly, 38-04 leaked a partial edit to the primary tree) — reconciled by merging authoritative branch versions; final tree verified clean. Next: Phase 39 Dashboard Reminder UI. Milestone v1.4 Unmissable Reminders in progress; v1.3 never formally closed via /gsd-complete-milestone (audit + live smoke tests pending). Prior: Phase 37 complete — `requiresAck`/`nagIntervalMinutes` schema + `create_reminder` tool params (8/8). Phase 36: inbound sender attribution.*
