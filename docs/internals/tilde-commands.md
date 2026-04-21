# Tilde commands

Tilde commands are in-chat control commands you send directly in any connected channel. They start with `~` rather than a slash because most platforms intercept `/` for their own autocomplete. The command registry is built in `src/head/commands.ts`.

These are distinct from the `shrok` CLI, which manages the service process. Tilde commands talk to a running Shrok instance over whatever channel you're in.

## Quick reference

| Command | What it does |
|---------|-------------|
| `~help` | List all commands with descriptions |
| `~status` | Uptime, today's spend, active agents, debug/xray state |
| `~context` | Head conversation token usage |
| `~usage [off\|tokens\|cost\|full]` | Show spend summary, or set per-message usage footer |
| `~debug [on\|off]` | Toggle full debug visibility |
| `~xray [on\|off]` | Toggle agent work visibility |
| `~archive` | Force-archive conversation history to topic memory now |
| `~reset` | Stop agents, clear conversation and queue |
| `~restart` | Restart Shrok immediately |
| `~stop` | Shut down Shrok (no auto-restart) |
| `~changedashboardpassword <pw> <pw>` | Set a new dashboard password |
| `~feedback [--diagnostics] <text>` | Generate a pre-filled GitHub issue link |
| `~resetthedatabaseimsupersureandnotmakingamistake` | Nuclear reset |

## Commands

### `~help`

Lists all available tilde commands with their one-line descriptions. No args.

### `~status`

Shows a snapshot of the running instance: uptime, estimated spend for today, number of active agents, and current debug/xray mode. No args.

### `~context`

Shows the head conversation's current token usage: message count, tokens consumed, percentage of the context budget used, and how old the oldest live message is. No args.

### `~usage [off|tokens|cost|full]`

With no argument, prints a spend summary table for the last 24 hours, 7 days, 30 days, and all time, with token counts and costs.

With an argument, sets the per-message usage footer mode:

- `off` — no footer (default)
- `tokens` — show token count after each response
- `cost` — show cost after each response
- `full` — show both

### `~debug [on|off]`

Toggles full debug visibility: agent work, head tool calls and results, system events, steward runs. With no argument the current state is flipped. Pass `on` or `off` to set it explicitly.

### `~xray [on|off]`

Toggles agent work visibility only (tool calls and their results). A subset of `~debug`. Same argument semantics.

### `~archive`

Forces archival of the current conversation history into topic memory right now, without waiting for the normal archival threshold to trigger. Returns the count of messages archived. No args.

This is useful when you want to clear head context before starting a different topic, or to verify that archival is working correctly.

### `~reset`

Stops all running agents and clears the conversation history and agent queue. Schedules, reminders, usage data, and archived topic memory are all preserved. No args.

### `~restart`

Restarts Shrok immediately. Warns you if there are running or suspended agents before restarting. No args.

The restart writes a sentinel file that the supervisor picks up, so the service comes back up under the same supervisor entry.

### `~stop`

Shuts down Shrok without an automatic restart. Warns about running agents. No args.

Unlike `~restart`, this does not write the sentinel file; the supervisor won't restart the process. Use `shrok start` from the CLI when you want to bring it back.

### `~changedashboardpassword <password> <password>`

Sets a new dashboard password. The new password must be typed twice to confirm and must be at least 8 characters. The password is hashed with bcrypt (12 rounds), written to `.env`, and all existing dashboard sessions are revoked immediately.

### `~feedback [--diagnostics] <feedback text>`

Generates a GitHub issue URL pre-filled with your feedback text so you can file it with one click. With `--diagnostics` the URL also includes system information: Shrok version, LLM provider, Node version, OS, context settings, active agent counts, configured channels, and MCP capabilities. The body is truncated to 7 500 characters to stay within URL length limits.

### `~resetthedatabaseimsupersureandnotmakingamistake`

Nuclear option. Deletes conversation history, agents, the message queue, steward run records, and reminders. Schedules, usage data, and archived topic memory survive. The intentionally long name is there to prevent accidents.

## Related docs

- [command-reference.md](./command-reference.md) — the `shrok` CLI (service management)
- [tasks-and-scheduling.md](./tasks-and-scheduling.md) — schedules and reminders that `~reset` preserves
- [memory.md](./memory.md) — topic memory that `~archive` writes to
