# Project Milestones: Shrok

*Entries in reverse chronological order — newest first.*

> Created 2026-05-24 during the v1.3 + v1.4 formal close-out. v1.0–v1.2 entries are
> reconstructed in brief from the ROADMAP; v1.3 and v1.4 are detailed. Note: the GSD
> milestone versioning (v1.x) is a **planning** scheme and is intentionally separate from
> the repo's git release tags (`v0.x`). No git tags are created at milestone close.

## v1.4 Unmissable Reminders (Shipped: 2026-05-24)

**Delivered:** An opt-in "acknowledgment-required" reminder severity that re-nags on a configurable interval until the user explicitly acks it, plus dashboard controls for ack/nag and recurring start dates.

**Phases completed:** 37-39 (9 plans total)

**Key accomplishments:**
- `requiresAck` + `nagIntervalMinutes` reminder schema fields with lazy JSON migration and `create_reminder` tool params (Phase 37)
- System-native nag re-arm in the scheduler `tick()` advance block — nagging never depends on the head doing work between fires (Phase 38)
- Type-scoped ack semantics: one-time → delete, recurring → stop this occurrence's nag while base cron continues; ack cancels the in-flight nag; `acknowledge_reminder` head tool with two-layer scoping (Phase 38)
- Dashboard NAGS badge + ack/nag editing + start-date/time picker (mapping to `triggerAt`+`cron`), folding in backlog 999.1 (Phase 39)

**Stats:**
- 3 phases, 9 plans
- 13/13 v1.4 requirements shipped (ACK-01..09, SCHED-01..04)
- 1544 vitest tests green, tsc clean, dashboard build green at close
- 2 days from milestone start (2026-05-23) to ship (2026-05-24)

**Git range:** `feat(37-01)` → `feat(39-03)`

**Archives:** `milestones/v1.4-ROADMAP.md`, `milestones/v1.4-REQUIREMENTS.md`, `milestones/v1.4-phases/`

**What's next:** Home Assistant Voice integration (a `home-assistant` channel that bridges Shrok's async head to HA's Assist pipeline, including unprompted `assist_satellite.announce` for async sub-agent results).

---

## v1.3 Multi-Head Support (Shipped: 2026-05-14)

**Delivered:** One Shrok process can run several independent "heads" — each with its own activation loop, channel adapters, schedules, reminders, and agent lifecycle — sharing a single identity, memory, and SQLite DB. Plus inbound sender attribution.

**Phases completed:** 29-36 (31 plans total)

**Key accomplishments:**
- `head_id` isolation column threaded through queue events, messages, agents, and schedules; backward-compatible implicit `default` head (Phases 29–31, 34–35)
- Per-head `ActivationLoop` + `ChannelRouter`; `heads[]` config schema; multi-instance-per-vendor channel adapters (Phases 30–31)
- Dashboard head selector + full CRUD management UI for heads and their channel adapters (Phases 32–33)
- Type-required `headId` at every spawn/run/complete site, closing the silent cross-head agent-completion leak (Phase 34)
- `[Name]:` inbound sender attribution built at the head's central choke point with a generalized leading-bracket stripper (Phase 36)

**Stats:**
- 8 phases, 31 plans
- Requirement families: DATA, CORE, ADPT, CONF, DASH (Phases 29–33); Phases 34–36 added capability layers
- 3 days (2026-05-12 → 2026-05-14)
- Known-at-the-time deferrals: Phase 33 UAT + Phase 34 live multi-head smoke test (non-blocking)

**Git range:** `feat(29-01)` → `feat(36-03)`

**Archives:** `milestones/v1.3-ROADMAP.md`, `milestones/v1.3-phases/` (no standalone requirements file existed)

**What's next:** v1.4 Unmissable Reminders.

---

## v1.2 Voice Mode & Feature Enhancements (Shipped: 2026-05-12)

**Delivered:** Browser voice mode (STT/TTS pipeline with VAD gating and barge-in) plus a batch of platform enhancements.

**Phases completed:** 19-28

**Key accomplishments:**
- Voice pipeline: backend STT/TTS WebSocket session, Vite WASM/ONNX build config, React voice FSM, error handling + accessibility (Phases 19–22)
- Timezone-aware scheduling (Phase 23) and `message_agent` mid-loop delivery (Phase 24)
- Agent history migrated from JSON blob to per-row table (Phase 25); SKILL.md/TASK.md frontmatter validation (Phase 26)
- `$WORKSPACE_PATH` → `$SHROK_WORKSPACE_PATH` rename (Phase 27); memory prompt overrides via MEMORY-*.md (Phase 28)

**What's next:** v1.3 Multi-Head Support.

---

## v1.1 Jobs Awareness (Shipped: 2026-04-20)

**Delivered:** The jobs system surfaced to agents via system prompt and auto-injection.

**Phases completed:** 10

**What's next:** v1.2 Voice Mode & Feature Enhancements.

---

## v1.0 Tool-call Legibility (Shipped: 2026-04-11)

**Delivered:** A `description` field on all tool schemas so the model emits a one-sentence intent per call; dashboard renders tool-call intent summaries with collapsible raw JSON; channel adapters include tool-call descriptions in message text.

**Phases completed:** 1 (et al.)

**What's next:** v1.1 Jobs Awareness.

---
