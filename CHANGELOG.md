# Changelog

All notable user-facing changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- **Config-driven tool access control** — operators can now restrict which tools each head may use, and which tools each head's sub-agents may use, via two independent allowlists (head tools, agent tools). Each layer has a global default and a per-head override with explicit tri-state semantics: key-absent = inherit global, `null` = all tools, `[array]` = only those tools. Everything-on by default — existing heads are never silently broken. Core orchestration tools (`spawn_agent`, `message_agent`, `cancel_agent`) are fully togglable with no guardrails. (closes #7)
- **Multi-head support** — one shrok process can run several independent "heads" sharing identity, memory, and the SQLite DB, each with its own activation loop, channel adapters, schedules, and agent lifecycle.
- **Dashboard head selector + per-head management UI** — pick a head, create/edit/delete heads and their channel adapters from the dashboard.
- **`[Name]:` inbound sender attribution** — messages from group chats arrive prefixed with the sender's name so the head knows who's talking.
- **Per-head custom system prompt** — each head can carry its own additional prompt segment surfaced to the assembler. (closes #12)
- **Inbound voice/audio pre-transcribed at ingestion** — voice messages from chat channels are STT'd at the ingestion boundary so the head sees text, not raw audio. (closes #9)
- **`config.timezone` exported as `TZ`** to spawned processes (bash tool calls, workers, scheduled task agents) so `date`/cron-style work in local time. (closes #13)
- **Unmissable reminders** — opt-in `requiresAck` + nag-interval on reminders; the reminder re-nags on the configured interval until the user explicitly acknowledges it. Includes the head-direct `acknowledge_reminder` tool, type-scoped ack semantics (one-time → delete, recurring → stop this occurrence's nag), and a dashboard NAGS badge + start-date controls.
- **Home Assistant voice channel** — shrok is now a Home Assistant conversation agent. HA's Voice Preview Edition talks to it over an OpenAI-compatible `POST /v1/chat/completions` endpoint and speaks shrok's replies, with asynchronous sub-agent results delivered unprompted via `assist_satellite.announce`. Validated end-to-end on real hardware. Operator setup guide at `docs/user-guide/home-assistant.md`.
- **Multi-head task delivery** — a scheduled *task* runs once but fans out its `agent_completed` event to every head in an opt-in delivery set, so the work runs once and the report reaches N heads. Dashboard task forms gained a "deliver to" multi-select with colored head chips. Reminders are unchanged.
- **Voice alarms and timers** — sustained, dismiss-until-stopped audible alerts on the HA Voice PE for both timers and alarms. A headless ring runner loops a bundled beep via `media_player.play_media`, polling the player and replaying on idle, with no LLM activation in the loop. Voice dismiss ("Hey Jarvis, stop") silences the device within one poll cycle. Includes the `ring_device(start|stop)` tool on both head and sub-agent surfaces (silent no-op on non-HA channels), auto-derived `media_player` + LED entities via HA's template API, an unauthenticated `GET /media/ring.mp3` route serving the bundled asset, persisted per-channel ring state for precise restart cleanup, and a 24h auto-dismiss cap. (closes #14)
- **`timer` skill** — bash-sleep countdown (second-precise, no scheduler), now ends with a `ring_device(start)` so an elapsed timer keeps beeping until dismissed on voice channels.
- **`set-alarm` skill** — sets a persisted reminder that rings the HA voice device at the alarm time. Survives restart.

### Changed
- **No UTC ever reaches the model.** Every model-facing time surface — `create_reminder.triggerAt`, `create_schedule.runAt`, `update_schedule.runAt`, `get_usage.since`, and the output of `list_reminders` / `list_schedules` / `get_file_info` — now uses workspace-local `YYYY-MM-DD HH:MM` format (24-hour, no `Z`, no offset, no IANA suffix). New `src/util/model-time.ts` helpers (`parseModelTime`, `formatModelTime`, `formatPastTimeError`) sit at every tool boundary; `parseModelTime` rejects `Z`/offset/IANA input with a clear error. `create_reminder` and `create_schedule` also enforce a 30-second past-time guard that returns a structured error in workspace-local format so the model self-corrects. Documented as a project invariant in `AGENTS.md`. (closes #18)
- **Dashboard conversation-view voice mode** now resolves the correct head per connection — per-turn live MSE, head-aware WebSocket URL, upgrade guard, multi-router registration. (closes #16)
- **Task/skill rename** cascades through all references (loader frontmatter, schedule store, usage store, body-text mentions surfaced as warnings).
- **Only the first head greets on startup** — with multiple heads configured, a restart no longer fires an "online" greeting from every head (which spoke on voice devices and pinged secondary chats unsolicited). Secondary heads still start their activation loops and remain fully responsive to inbound messages.

### Fixed
- **Editing a one-time reminder or schedule now correctly pre-fills the date/time field**, and all reminder/schedule date pickers use your configured workspace timezone. (closes #5)
- **Usage costs no longer go negative for prompt-cache-heavy calls** — the cost estimator incorrectly subtracted Anthropic cache-read and cache-creation tokens from the input-token count, but Anthropic already reports `input_tokens` exclusive of cached tokens. Cache-heavy calls (notably scheduled tasks reusing a large cached prompt) were priced as negative dollars in the usage dashboard. The three token buckets are now priced additively, so estimated cost can never be negative.
- **Dashboard voice mode now plays replies on iOS Safari** — on iPhone the assistant's spoken reply was silent (the text bubble appeared but no audio). iOS Safari exposes `ManagedMediaSource` instead of the standard `MediaSource`, so the MP3 streaming-playback path silently failed there; it now falls back to buffered `<audio>` playback on those browsers. The mic is also paused while a reply plays on that path, so the phone speaker isn't picked up as speech and used to cut the reply short. Desktop streaming playback and barge-in are unchanged.
- **Dashboard now lists every file in a skill or task** — data files like `.jsonl`, dotfiles, and internal state files were silently hidden by a hardcoded extension allowlist, so JSONL-backed skills (shopping-list, cookbook, random-tip) looked empty. The dashboard now shows every file in the directory, matching what you'd see in the folder itself. Binary files and files over 2 MB are listed but show a "can't display" / "too large" notice when opened instead of loading into the editor. (closes #4)

## [0.2.0] — 2026-05-13

### Added
- **Browser voice mode** — STT/TTS pipeline with VAD gating and barge-in, backend WebSocket session, Vite WASM/ONNX build config, React voice state machine, error handling and accessibility.
- **Timezone-aware scheduling** — schedule/reminder cron expressions are interpreted in the workspace timezone (or per-schedule `cronTimezone` override).
- **`message_agent` mid-loop delivery** — messages to running agents are delivered without waiting for them to suspend.
- **`SKILL.md` / `TASK.md` frontmatter validation** at write time so malformed skills are caught at the boundary.
- **Memory prompt overrides via `MEMORY-*.md`** — per-area memory files folded into the assembler's system prompt.

### Changed
- **Agent history storage** migrated from a JSON blob column to a per-row `agent_messages` table.
- **`$WORKSPACE_PATH` → `$SHROK_WORKSPACE_PATH`** environment variable rename.

## [0.1.0] — 2026-04-22

First public release. Core agent loop, memory system, multi-channel support (Discord, Telegram, Slack, WhatsApp, Zoho Cliq), skill system, MCP integration, web dashboard. Includes early enhancements (tool-call legibility on agent tool schemas; jobs system surfaced to agents via system prompt).
