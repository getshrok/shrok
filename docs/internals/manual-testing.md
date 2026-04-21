# Manual testing

## 1. Install

Run a clean install on each platform before testing anything else.

### macOS

- [ ] Installer runs to completion without errors
- [ ] `shrok` command is on PATH
- [ ] `shrok status` reports running
- [ ] Dashboard opens at http://localhost:8888 and login works
- [ ] `launchctl list | grep shrok` shows the service registered
- [ ] After a reboot, `shrok status` still reports running (auto-start works)

### Linux

- [ ] Installer runs to completion without errors
- [ ] `shrok` command is on PATH
- [ ] `shrok status` reports running
- [ ] Dashboard opens at http://localhost:8888 and login works
- [ ] `systemctl --user status shrok` shows active
- [ ] After a reboot, `shrok status` still reports running

### Windows

- [ ] Installer runs to completion without errors
- [ ] `shrok` command works in a new PowerShell session
- [ ] `shrok status` reports running
- [ ] Dashboard opens at http://localhost:8888 and login works
- [ ] Task Scheduler shows the `Shrok` task registered
- [ ] After a reboot, `shrok status` still reports running

### Docker

- [ ] Container starts without errors (`docker compose ps` shows healthy)
- [ ] Dashboard opens at http://localhost:8888 and login works
- [ ] Stopping and restarting the container (`docker compose restart`) preserves conversation history

---

## 2. CLI commands

Run these after install. They don't need a specific provider configured — except `doctor --deep`.

- [ ] `shrok status` — reports running
- [ ] `shrok stop` — service stops; dashboard becomes unreachable
- [ ] `shrok start` — service starts again; dashboard comes back
- [ ] `shrok restart` — service cycles; dashboard comes back within ~10 seconds
- [ ] `shrok logs` — prints a live log stream; Ctrl-C exits cleanly
- [ ] `shrok doctor` — all layers pass (or only expected warnings for unconfigured channels)
- [ ] `shrok doctor --deep` — live probes pass for configured providers and channels
- [ ] `shrok doctor --json` — valid JSON with `summary` key
- [ ] `shrok update` — pulls latest, reinstalls deps, restarts; `shrok status` still running after

---

## 3. Providers

Test each provider independently. Set `LLM_PROVIDER` in `.env` (or `llmProviderPriority` in `config.json`) to isolate them. Send a plain conversational message through the dashboard for each.

### Anthropic

Configure `ANTHROPIC_API_KEY`. Test each model tier.

- [ ] Standard (`claude-haiku-4-5-20251001`) — responds; usage footer shows token counts
- [ ] Capable (`claude-sonnet-4-6`) — responds
- [ ] Expert (`claude-opus-4-6`) — responds
- [ ] `shrok doctor --deep` passes the Anthropic live probe

### Google Gemini

Configure `GEMINI_API_KEY`. Test each tier.

- [ ] Standard (`gemini-2.0-flash`) — responds
- [ ] Capable (`gemini-2.5-pro`) — responds
- [ ] `shrok doctor --deep` passes the Gemini live probe

### OpenAI (API key)

Configure `OPENAI_API_KEY`.

- [ ] Standard (`gpt-4o-mini`) — responds
- [ ] Capable (`gpt-4o`) — responds
- [ ] `shrok doctor --deep` passes the OpenAI live probe

### OpenAI (OAuth / ChatGPT subscription)

Configure `OPENAI_OAUTH_ACCESS_TOKEN`, `OPENAI_OAUTH_REFRESH_TOKEN`, `OPENAI_OAUTH_EXPIRES_AT`.

- [ ] Responds via the Codex endpoint

### Multi-provider fallback

Set `LLM_PROVIDER_PRIORITY=anthropic,gemini` with both keys configured. Then temporarily provide a bad Anthropic key.

- [ ] Falls back to Gemini transparently; response arrives without manual intervention

---

## 4. Channels

For each channel, send a message through it, confirm the reply arrives in the same channel, then also confirm the conversation appears in the dashboard.

### Web dashboard

- [ ] Login with correct password — succeeds
- [ ] Login with wrong password — rejected
- [ ] Send a message — Shrok replies in the conversation thread
- [ ] Conversation history persists after a `shrok restart`

### Discord

Configure `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID`.

- [ ] Bot appears online in the server
- [ ] Message in the configured channel gets a reply from the bot
- [ ] Reply appears in dashboard conversation history
- [ ] `shrok doctor --deep` passes the Discord probe

### Telegram

Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

- [ ] Message sent to the bot gets a reply
- [ ] Reply appears in dashboard conversation history
- [ ] `shrok doctor --deep` passes the Telegram probe

### Slack

Configure `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`.

- [ ] Message in the configured channel gets a reply from the bot
- [ ] Reply appears in dashboard conversation history
- [ ] `shrok doctor --deep` passes the Slack probe

### WhatsApp

Configure `WHATSAPP_ALLOWED_JID`.

- [ ] QR code pairing completes (check Logs page if no QR appears)
- [ ] Message from the allowed number gets a reply
- [ ] Reply appears in dashboard conversation history

### Zoho Cliq

Configure `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIQ_CHAT_ID`.

- [ ] Message in the configured chat gets a reply
- [ ] Reply appears in dashboard conversation history

### Webhooks

Configure `WEBHOOK_SECRET`. Use a tool like `curl` or Postman.

- [ ] POST to `http://localhost:8766/webhook/<event>` with correct HMAC signature returns 200
- [ ] POST with a bad signature returns 4xx
- [ ] Rate limit triggers after the configured `webhookRateLimitPerMinute`

---

## 5. Core agent features

These tests send messages through the dashboard. Use whichever provider is configured.

### Basic conversation

- [ ] Send a multi-turn conversation — context from earlier turns is used in replies
- [ ] Send a message after `shrok restart` — history is intact

### Agent spawning

Ask Shrok to do something that would typically spawn an agent, like: *"Search the web for the current Node.js LTS version, read the result, and summarise it in one sentence."*

- [ ] Shrok spawns an agent (visible in Logs or Conversations as a child trace)
- [ ] Agent completes and Shrok delivers a summary reply
- [ ] Dashboard Conversations page shows both the head and agent traces

### File operations

Ask Shrok: *"Create a file at /tmp/shrok-test.txt with the content 'hello', then read it back and tell me what it says."*

- [ ] File is created
- [ ] File is read and contents reported correctly

### Bash

Ask Shrok: *"Run `echo $((2+2))` in a shell and tell me the result."*

- [ ] Returns `4`

### Web search

Ask Shrok: *"Search the web for 'shrok agent' and list the top 3 results."*

- [ ] Returns actual search results (not a refusal or error)
- [ ] Results match the configured search provider (Tavily or Brave)

### Web fetch

Ask Shrok: *"Fetch the content of https://example.com and summarise what it says."*

- [ ] Returns a summary of the example.com page

### Image viewing

Send a message with an image attachment (PNG or JPEG, under 5MB).

- [ ] Shrok describes the image content

---

## 6. Memory

### Notes

- [ ] Ask Shrok to save a note: *"Save a note: 'the release password is hunter2'"*
- [ ] In a new conversation, ask: *"What was the release password?"* — Shrok recalls it
- [ ] Ask Shrok to list notes — the note appears
- [ ] Ask Shrok to delete the note — it disappears from the list

### Memory archival

This requires enough conversation history to trigger archival (configured at 80% of context window by default — most practical way is to use a small model and send many long messages, or lower `archivalThresholdFraction` temporarily).

- [ ] After archival triggers, subsequent conversations still reference facts from archived turns

### Reminders

- [ ] Ask Shrok to remind you of something in 2 minutes: *"Remind me to check the oven in 2 minutes."*
- [ ] Wait 2 minutes — reminder fires and appears in the dashboard
- [ ] Ask Shrok to list reminders — it shows the reminder
- [ ] Ask Shrok to cancel the reminder — it disappears from the list

---

## 7. Scheduling

### One-shot task

- [ ] Ask Shrok: *"In 1 minute, run a task: say 'scheduled task fired'."*
- [ ] After ~1 minute, the message appears in the conversation
- [ ] Dashboard Tasks and Schedules pages show the task (and then its completion)

### Recurring task

- [ ] Create a task via the dashboard Tasks page with a cron like `* * * * *` (every minute)
- [ ] Confirm it fires within a minute
- [ ] Disable the schedule — confirm it stops firing
- [ ] Delete the schedule — it disappears from the list

### Proactive filtering

- [ ] Create a recurring task with a plain-language condition that should currently be false (e.g., *"only run if it is a weekend"* on a weekday)
- [ ] Confirm the task is skipped (Logs will show the steward's decision)

---

## 8. Dashboard pages

Walk through each page and confirm it loads and shows data.

- [ ] **Conversations** — shows conversation history; sending a message works
- [ ] **Skills** — shows installed skills; installing a skill from the repo works
- [ ] **Tasks** — shows tasks; creating and deleting a task works
- [ ] **Schedules** — shows schedules; editing a cron expression saves correctly
- [ ] **Reminders** — shows reminders; cancelling a reminder works
- [ ] **Memory** — shows archived topics; browsing the knowledge graph loads entries
- [ ] **Identity** — SOUL.md, USER.md, AMBIENT.md, SYSTEM.md are editable and save correctly
- [ ] **Usage** — shows token counts and estimated cost with a breakdown by model and source
- [ ] **Logs** — shows a live log stream; toggling developer mode adds/removes trace lines
- [ ] **Settings** — config changes (e.g., toggling a steward flag) persist after page reload

---

## 9. Identity files

- [ ] Edit `SOUL.md` via the dashboard — personality change reflected in next reply
- [ ] Edit `USER.md` with a preference (e.g., *"always reply in bullet points"*) — next reply reflects it
- [ ] Edit `AMBIENT.md` with temporary context (e.g., *"I am traveling this week"*) — Shrok references it

---

## 10. MCP

Configure an MCP server in `mcp.json` (either HTTP or stdio).

- [ ] Tools from the MCP server appear in the agent's tool surface (visible in Logs)
- [ ] Ask Shrok to use one of the MCP tools — it calls the tool and uses the result

---

## 11. Skills

- [ ] Install a skill from the curated repo via the Skills dashboard page
- [ ] Invoke the skill by name in a message — it runs and returns a result
- [ ] Edit the skill's `SKILL.md` via the dashboard — change reflected on next invocation
- [ ] Uninstall the skill — it no longer appears in the list or responds to invocation

---

## 12. Update

- [ ] `shrok update` pulls the latest version and restarts cleanly
- [ ] After update, `shrok doctor` still passes
- [ ] Conversation history and settings are intact post-update

---

## 13. Uninstall

### macOS / Linux

- [ ] Script completes without errors
- [ ] `shrok` command is no longer on PATH (or gives "not found")
- [ ] Service is removed from launchd / systemd
- [ ] `~/.shrok/` is removed (or left if the user chose to keep data)

### Windows

- [ ] Script completes without errors
- [ ] `shrok` command no longer works
- [ ] Task Scheduler task is removed
