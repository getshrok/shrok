# Command reference

This doc covers the `shrok` CLI — a small wrapper around the platform's service supervisor, plus a health-check and an updater.

## Where the CLI comes from

The `shrok` command is a symlink (macOS/Linux) or a `.ps1` + `.cmd` pair (Windows) installed into `~/.local/bin/` at first boot. See [auto-start.md](./auto-start.md) for how it gets there. The wrapper source lives at `bin/shrok` and `bin/shrok.ps1` in the repo.

None of the commands talk to Shrok over HTTP. They talk to the platform service supervisor (launchd, systemd, Task Scheduler) and to files in `~/.shrok/`.

## Commands

```
shrok <start|stop|restart|status|doctor|logs|update>
```

### `shrok start`

Tells the supervisor to start the Shrok service. On macOS this is `launchctl start com.shrok.agent`. On Linux it's `systemctl --user start shrok`. On Windows it's `schtasks /run /tn Shrok`.

If Shrok is already running, this is a no-op on macOS/Linux and a harmless re-run on Windows.

### `shrok stop`

Stops the service. `launchctl stop` on macOS, `systemctl --user stop` on Linux, `schtasks /end /tn Shrok` on Windows. The Windows wrapper also force-kills any lingering `node` processes whose command line looks like Shrok's, because Task Scheduler's `end` doesn't always reach the child.

This is the only way to stop Shrok cleanly. A plain `kill <pid>` gets reversed by the supervisor within seconds.

### `shrok restart`

Restarts the service. On macOS, `launchctl kickstart -k gui/$UID/com.shrok.agent` (falls back to `start` if the agent isn't loaded). On Linux, `systemctl --user restart`. On Windows, writes the restart sentinel file (`~/.shrok/.restart-requested`) and lets the daemon wrapper notice it and relaunch on the next loop iteration — softer than tearing down the Task Scheduler task.

The in-app restart tool (the one Shrok uses to reload after config changes) also writes that sentinel on every platform, which is why `shrok restart` on Windows uses the same path.

### `shrok status`

Asks the supervisor whether Shrok is running. On macOS it's `launchctl list | grep shrok`. On Linux it's `systemctl --user status shrok`. On Windows it's `schtasks /query /tn Shrok /fo LIST` filtered to the status, last-run, and next-run lines.

Status is deliberately thin. It answers the narrow question "does the supervisor think the service is up." For anything more — config problems, missing API keys, unreachable channels, failed migrations — use `shrok doctor`.

### `shrok doctor`

A layered health check that prints a readable report with a hint on every failure. Four layers:

- **process** — PID file, dashboard port reachable
- **config** — `config.json` parses, paths exist and are writable
- **creds** — API keys and channel configs are present and well-shaped (offline)
- **live** — with `--deep`, hits each provider and each channel's list/auth endpoint to confirm the key actually works

Every row is `status  duration  title` with optional `detail:` and `hint:` lines beneath. A final `verdict:` line sums it up.

```
shrok doctor                  # offline, all layers
shrok doctor --deep           # also run live probes (still zero token cost)
shrok doctor --json           # machine-readable (stable schemaVersion:1)
shrok doctor --only creds     # one layer — process | config | creds | live
shrok doctor --help           # flag reference
```

Exit codes: `0` if everything's ok or skipped, `1` if any check failed, `2` if only warnings (or if you passed a bad flag). Scripts can check `shrok doctor --json | jq '.summary'` or gate on the exit code directly.

Live probes use each provider's list-models endpoint — Anthropic's `/v1/models`, OpenAI's `/v1/models`, Gemini's `/v1beta/models`. These cost zero tokens. Channel probes hit `/users/@me` (Discord), `/getMe` (Telegram), `/auth.test` (Slack). WhatsApp has no cheap offline-capable probe (Baileys needs a paired session), so it always reports `skip`.

The doctor source is under `src/doctor/` — one file per layer of checks.

### `shrok logs`

Tails the log stream. On macOS, `tail -f ~/.shrok/shrok.log`. On Linux, `journalctl --user -u shrok -f` (systemd captures stdout/stderr into its journal). On Windows, `Get-Content -Wait -Tail 50` on `%USERPROFILE%\.shrok\shrok.log`.

What you'll see: identity-assembly notes, steward dispatches, channel events, and anything Shrok's internal logger writes at the configured level (default `info`). For deeper traces, use the Logs page in the dashboard with developer mode on — see [developer-mode.md](../development/developer-mode.md).

### `shrok update`

Pulls the latest Shrok, reinstalls dependencies, and restarts the service. Equivalent to:

```bash
git -C ~/shrok pull --ff-only
npm --prefix ~/shrok install --quiet
shrok restart
```

The fast-forward-only pull means local edits to the repo will block the update rather than being silently overwritten. If you've been editing Shrok itself, resolve that first (commit, stash, or move your changes to a branch).

## What the CLI doesn't do

- **No config editing from the CLI.** Use the dashboard's Settings page or edit `~/.shrok/workspace/config.json` directly. Run `npm run setup` for the interactive wizard (required before first `npm start` on a manual install).
- **No skill or task management from the CLI.** Those live in the dashboard, or as plain files under `~/.shrok/workspace/skills/` and `~/.shrok/workspace/tasks/`.
- **No send-message-to-Shrok command.** The dashboard or a connected channel is the way in.

The CLI is deliberately small. It manages the service and nothing else.

## Related docs

- [auto-start.md](./auto-start.md) — how the service registered itself in the first place
- [developer-mode.md](../development/developer-mode.md) — the richer dashboard surface (logs, tests, evals)
- [architecture.md](./architecture.md) — what the daemon actually runs once it's up
