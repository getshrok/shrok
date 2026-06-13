# Changelog

All notable user-facing changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- **Head can run agent tools directly** — optionally grant a head direct access to file, web, bash, notes, reminders, and schedule tools (off by default; configured per head in Settings). When assigned, these tools execute in the head loop itself with no sub-agent spawned. Reminder ownership is stamped to the head's ID; notes use the shared global pool; bash runs in the daemon's working directory. Every tool is opt-in through the existing Settings → Behavior / per-head allowlist controls — out-of-box behavior is byte-identical.
- **Config-driven tool access control** — operators can assign exactly which tools each head may use and which tools that head's sub-agents may use, via two independent allowlists (head tools, agent tools). Settings → Behavior sets a global default for each layer; each head card can inherit that default or pin its own subset. Defaults reproduce prior behavior — nothing changes until you edit it. (closes #7)
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
- **New "dynamic" agent model — let the head pick the worker tier per task** — set Agent model to `dynamic` in Settings → Models and the head must choose dumb / smart / genius for each agent it spawns, matched to that task's difficulty. Leave it on a fixed tier (or a specific model ID) and that choice is authoritative for every agent — the head can't override it, and the per-task model control disappears from its toolset entirely. (closes #37)
- **Sub-agents are now told the truth about their situation** — a spawned agent's framing used to imply it was talking to you directly. It now knows it's a sub-agent working a delegated task, that its reply goes back to the head (not shown to you verbatim), and that a clarifying question pauses it and is relayed to you through the head. This makes agent reports read as reports rather than as chat, and stops agents from guessing when they should ask. (closes #32)
- **The head relays your words instead of writing its own prompts when delegating** — the `spawn_agent` tool now takes a `task` (the ask, in your own words) plus a separate `context` field where the head pastes relevant conversation excerpts verbatim, rather than one freeform prompt the head authored from scratch. This keeps the agent working from what you actually said — preserving constraints, names, and details that paraphrasing used to drop. (closes #30)
- **Model tiers renamed to dumb / smart / genius** (capability-framed: dumb for trivial single-fact lookups / web searches, smart for everyday work — the default, genius for heavy multi-step reasoning). The head's spawn-agent tool gained a `model` control so it can pick the tier per task. Existing `config.json` files using the old key names (`anthropicModelCapable`, etc.) or old tier values (`headModel: "capable"`, etc.) keep working unchanged. (closes #31)
- **No UTC ever reaches the model.** Every model-facing time surface — `create_reminder.triggerAt`, `create_schedule.runAt`, `update_schedule.runAt`, `get_usage.since`, and the output of `list_reminders` / `list_schedules` / `get_file_info` — now uses workspace-local `YYYY-MM-DD HH:MM` format (24-hour, no `Z`, no offset, no IANA suffix). New `src/util/model-time.ts` helpers (`parseModelTime`, `formatModelTime`, `formatPastTimeError`) sit at every tool boundary; `parseModelTime` rejects `Z`/offset/IANA input with a clear error. `create_reminder` and `create_schedule` also enforce a 30-second past-time guard that returns a structured error in workspace-local format so the model self-corrects. Documented as a project invariant in `AGENTS.md`. (closes #18)
- **Dashboard conversation-view voice mode** now resolves the correct head per connection — per-turn live MSE, head-aware WebSocket URL, upgrade guard, multi-router registration. (closes #16)
- **Task/skill rename** cascades through all references (loader frontmatter, schedule store, usage store, body-text mentions surfaced as warnings).
- **Only the first head greets on startup** — with multiple heads configured, a restart no longer fires an "online" greeting from every head (which spoke on voice devices and pinged secondary chats unsolicited). Secondary heads still start their activation loops and remain fully responsive to inbound messages.
- **Only the final message of a turn is delivered to chat channels** — the assistant no longer sends its running narration ("let me check…", "now I'll…") before each tool call. Models recap what they did at the end of a turn anyway, so the intermediate text was redundant noise; only the last message reaches the user now. The full transcript is still kept for the model's own context and the dashboard view. (closes #21)

### Fixed
- **Long Telegram replies that exceeded Telegram's 4096-character limit are now split into multiple messages** instead of being silently dropped — long agent replies with code blocks, tables, or multi-section text now reach the user in full. (closes #20)
- **Long Slack and WhatsApp replies are now split into multiple messages** instead of being silently dropped — the same fix as Telegram (#20). Slack replies are normalized against all three of Slack's block limits (section text ≤3000 chars, fields ≤10, ≤50 blocks per message) and delivered across sequential posts. WhatsApp replies exceeding the platform limit are split at message boundaries and sent sequentially. Normal short replies are unchanged — still exactly one API call.
- **Timer and alarm rings are now loud and use a stronger alert tone** — the default ring volume was raised from 50% to 100% (it's an alarm; lower it via `ringVolume` in config if you want it softer), and the bundled beep was replaced with a more attention-grabbing triple-beep alarm tone. (closes #19)
- **The reminder message box is now a multi-line textarea when creating a reminder** (it already was when editing), so long reminder text fits and wraps. (closes #15)
- **Dashboard conversation view now shows only the selected head's sub-agent pills**; switching heads no longer leaves stale pills from other heads. (closes #10)
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
