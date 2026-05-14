# Shrok

## What This Is

Shrok is a self-hosted personal AI agent that maintains a single persistent identity across channels (Discord, Telegram, Slack, WhatsApp, Zoho Cliq, web dashboard). Its core design principle: the head never does work directly — it delegates to asynchronous sub-agents. The head handles routing, memory, and coordination; agents handle execution.

## Core Value

A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

## Current Milestone: v1.3 Multi-Head Support

**Goal:** Enable multiple parallel conversation heads that each own their own queue, message history, and activation loop while sharing memory, identity, and skills.

**Target features:**
- Head registry in config (named heads, each with assigned channel adapters)
- Per-head queue claims (`head_id` column on `queue_events` and `messages`)
- Per-head activation loop instances running concurrently in one process
- Per-head `AppStateStore` namespacing (lastActiveChannel, archival lock, etc.)
- Multiple adapter instances per vendor type (e.g., `telegram-personal`, `telegram-work`)
- Dashboard head selector — conversations scoped to active head
- Shared memory, identity files, and skills across all heads (untouched)
- Backward-compatible default head — single-head deployments unchanged

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

### Active

- [ ] Existing single-head deployments continue to work unchanged after migration

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
*Last updated: 2026-05-14 — Phase 36 complete: inbound sender attribution — `InboundMessage.senderName?: string` type contract, `normalizeSenderName` + `buildPrefixedText` helpers in `src/head/sender-prefix.ts`, central prefix construction inside `headRouteMessage` (slash-command detection runs first on raw text), generalized D-11 stripper `/^(\s*\[[^\]]+\]\s*:?\s*)+/` renamed `stripTimestampEcho` → `stripLeadingBracketPrefixes`, five adapters populate senderName (Discord, Telegram, Slack TTL-cached `users.info`, WhatsApp, Cliq), voice/dashboard/webhook untouched per D-06, 20 sender-prefix unit tests + 19 stripper regression tests, 1489/1490 vitest passing. Phase 35 complete: per-head scheduling. Milestone v1.3 ready for completion (audit + smoke tests pending).*
