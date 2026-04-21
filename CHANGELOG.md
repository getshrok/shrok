# Changelog

## [Unreleased]

### Changed
- **Timezone (`config.timezone`) now drives cron, LLM prompts, and the dashboard.**
  Previously `config.timezone` only affected usage-billing period boundaries and
  the daily-spend circuit breaker. It now also controls:
  - **Cron schedule firing** — e.g. `0 9 * * *` now fires at 09:00 in your
    configured zone, not UTC. **Existing schedules will reinterpret.** If you
    set up `0 9 * * *` expecting UTC, it will now fire at 09:00 local. Review
    your schedules on the Schedules page after upgrading.
  - **LLM current-time injection** — head, agent, and steward prompts now see
    a localized string like `Thursday, April 16, 2026, 9:55 AM EDT
    (America/New_York)` instead of a raw UTC ISO.
  - **Dashboard timestamps** — Conversations, Schedules, Logs, Memory, and
    Evals pages now render times in `config.timezone` with a short zone label.
  - Logs (`src/logger.ts`) and tracer (`src/tracer.ts`) files keep their
    UTC ISO format — unchanged, for machine-parseability.

  No schema changes; no migration needed beyond reviewing existing cron
  schedules if you'd previously assumed UTC interpretation.

## [0.4.0] — 2026-04-05

### New
- **`buildSystem()` factory** (`src/system.ts`) — production and evals now use the same code path for all internal wiring (stores, loaders, runners, assembler, injector, activation loop). Eliminates silent divergence where evals missed new fields or judges.
- **Agent messaging pipeline** — agents can respond to mid-task messages from Head via `respond_to_message`. Responses flow back through `agent_response` queue events that activate Head for relay to the user. Enables real progress updates.
- **Knowledge graph for memory** — topic memory extracts entity-to-entity relations during archival and uses graph traversal as retrieval hints. Improves multi-hop recall across archived sessions.
- **Memory query rewriter** — rewrites vague user queries ("what were those exactly?") into self-contained retrieval queries using recent conversation context. Configurable via `memoryQueryContextMessages` setting (default 6, 0 to disable).
- **Proactive scheduling** — scheduled skills can make autonomous run/skip decisions based on conversation context (vacation, recently completed, etc.).
- **LLM provider priority** — configure fallback providers via `LLM_PROVIDER_PRIORITY`. If the primary fails, the system tries the next in the list.
- **Notes tools** — agents can save, search, and recall notes (`write_note`, `read_note`, `list_notes`, `search_notes`, `delete_note`).
- **Work summary judge** — summarizes verbose agent work before it reaches the head, reducing context waste.
- **Completion judge** — replaces `ask_question` tool. Agent output classified as "done" or "question" by a judge.
- **XML-style injected message markers** — `[SYSTEM: ...]` brackets migrated to XML tags (`<system-trigger>`, `<agent-result>`, etc.).
- **`~changedashboardpassword` command** — change dashboard password from any channel.
- **Centralized markers module** (`src/markers.ts`) — single source of truth for injected message tag formatting.
- **Eval: anaphoric-reference** — tests query rewriter with pronoun, implicit, and explicit variants.
- **Eval: 26 scenarios** with task variants, LLM-as-judge, and dashboard timeline view. Rubrics improved based on detailed walkthrough analysis.

### Fixed
- **Message_agent judge gate** was disabled in all evals — `llmRouter` and `judgeModel` were missing from eval `toolExecutorOpts`. Fixed by `buildSystem` refactor.
- **Agent `envOverrides`** — agents in evals wrote files to the real workspace instead of the temp dir. Fixed in `buildSystem`.
- **Bootstrap judge** never ran during onboarding — was using workspace path instead of identity loader's defaults fallback.
- **Skill model override** — system skills had `model: capable` hardcoded, overriding cost profile. Removed.
- **Em dash replacement** moved before message storage for consistent text across consumers.
- **Suppressed heartbeat messages** accumulating unboundedly. Relay judge now cleans up.
- **Restart env propagation** — now passes only system-level vars so child reads `.env` fresh.
- **Relay judge** suppresses transient API errors (429, 529, overloaded).
- **Setup wizard tests** updated to match current prompt flow.

### Changed
- **Archival threshold** default changed from 0.45 to 0.80 (fires later, preserving more live context).
- **Memory budget** — new `memoryBudgetPercent` setting (default 40%) controls memory vs history allocation.
- **Head system prompt** — significantly trimmed. Memory section removed, channel preferences removed.
- **Skill system** — rewritten with flattened frontmatter, instructions in tool call history.
- **Head tools** — slimmed down; `get_usage` and web tools removed from head.
- **Agent capabilities** updated with note, reminder, schedule, and `respond_to_message` tools.

## [0.3.1] — 2026-03-30

### Changes

- **Cost profile simplification** — Tier assignments are now consistent: standard = haiku/flash-lite/nano, capable = sonnet/flash/mini, expert = opus/pro/pro. Role assignments follow the profile cleanly: Budget gets standard across the board, Balanced gets capable (except judge/composer which stay standard), Full gets expert (except judge/composer). All three profiles share the same model tier table — only token budgets and role tiers differ.
- **Snapshot token budget wired up** — `snapshotTokenBudget` was previously written to config but never read. It now controls how much head conversation history is passed to spawned agents. All profiles set it equal to `contextAssemblyTokenBudget` so agents see as much context as the head does.

---

## [0.3.0] — 2026-03-30

### New features

- **Configurable model roles** — Five new config fields (`headModel`, `agentModel`, `composerModel`, `judgeModel`, `memoryModel`) replace hardcoded tier strings throughout the codebase. Each accepts a tier name (`standard`, `capable`, `expert`) or a direct model ID. Defaults match prior behaviour.
- **Cost profiles** — Setup wizard and settings both offer Budget / Balanced / Full profiles that set appropriate model tiers and token budgets for each LLM provider. Profile model names are updated for Anthropic (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`), Google Gemini, and OpenAI.
- **Settings modal** — Settings moved from a standalone page to a modal opened from the bottom of the sidebar. Includes Save / Discard buttons, immediate visual feedback for mode changes, and a "Restart required" prompt after saving.
- **Process log file** — All `log.*` output is now tee'd to `<workspace>/data/trace/process-latest.log` alongside stdout. The file survives dashboard-initiated restarts (which previously used `stdio: ignore`) and appears in the dashboard Logs page in green. Rotates automatically at 500 KB.
- **Deeper trace history** — Head and agent trace files now show the last 10 messages of conversation history instead of 3.

### Fixes

- Settings modal right margin was obscured by the `<main>` scrollbar; fixed by hiding overflow on the main pane while the modal is open.
- Settings modal reopened after "Later" now reflects the saved values rather than stale pre-save cache.
- Horizontal scrollbar in the conversation view eliminated.
- Removed the `openai-oauth` provider (ChatGPT Codex endpoint) which was causing config validation errors on startup for affected workspaces.

---

## [0.2.0] — 2026-03-30

### New features

- **Judge layer** — LLM-as-judge runs alongside every head activation, scoring preference adherence, spawn decisions, hallucination risk, and more. Judges use per-model prompt sets and write structured trace files. A bootstrap judge fires on the first interaction to seed identity files.
- **Relay judge** — Before a scheduled agent's completion wakes the head, a pre-activation judge decides whether it's worth surfacing to the user. Benign "all clear" outputs are silently suppressed; errors and anomalies are relayed. Context includes skill instructions, USER.md, recent history, and current time.
- **Dashboard: Schedules page** — View, enable/disable, delete, and create scheduled skill runs. Cron expressions are shown in human-readable form. Next/last run times refresh every 30 seconds.
- **Dashboard: Reminders page** — View and delete active reminders set by the assistant. Shows message, channel, repeat schedule, and next fire time.
- **Sub-agent tool isolation** — Child agents no longer receive `message_agent`, `answer_agent`, or `cancel_agent`. These are parent-only tools; sub-agents can never have children.
- **Skill frontmatter rename** — Skill metadata fields renamed for clarity (`only_tools` → `trigger-tools`). See migration notes below.
- **Eval system** — Comprehensive scenario-based eval runner covering memory, archival, routing, reliability, and stress. 30+ scenarios with LLM-as-judge scoring and a dashboard view.
- **OpenAI OAuth provider** — Use a ChatGPT subscription (Codex endpoint) as an LLM backend without a paid API key.
- **`~clearconvo` command** — Full reset of conversation history and agent state.
- **Instant `~commands`** — Status and control commands bypass the LLM and respond immediately.
- **Judge tracing** — All judge calls write structured JSON traces to `data/trace/` for debugging.

### Fixes

- Agents that complete without calling any tools are now nudged once; if they still don't call tools, the agent fails cleanly rather than silently succeeding.
- Preference persistence is now mandatory and immediate — preferences are written to USER.md synchronously, not deferred.
- Heartbeat skill no longer includes web tools (reduces unnecessary network calls).
- Relay judge errors fail open — if the judge call fails, the completion is always relayed to the head.

### Breaking changes

- **`[PASS]` convention removed** — Skills and agents should no longer return `[PASS]` to signal silent completion. The relay judge handles suppression decisions automatically.
- **Skill frontmatter fields renamed** — Update any custom skills:
  - `only_tools` → `trigger-tools`
  - `visible-to-head-subagents` removed (no longer used)
- **`skillName` removed from `spawn_agent`** — The skill to run is determined by the agent's task prompt, not a separate field.

---

## [0.1.0] — initial release

First public release. Core agent loop, memory system, multi-channel support (Discord, Telegram, Slack, WhatsApp), skill system, MCP integration, dashboard.
