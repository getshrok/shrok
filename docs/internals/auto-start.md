# Auto-start

This doc covers how Shrok gets itself registered as a background service that runs at login.

## When it happens

Not at install time. The installer (`install.sh` on macOS/Linux, `install.ps1` on Windows) just clones the repo, installs dependencies, runs the setup wizard, and does an initial `npm start`.

The auto-start registration happens on that first `npm start`. On every startup, `src/first-boot.ts` checks whether Shrok is already registered with the platform's service supervisor. If it isn't, it writes the service definition, registers it, and logs a one-line note. If it already is, it returns immediately. Every failure is non-fatal — Shrok runs fine without a supervisor, it just won't come back on its own after a reboot.

So the flow is: install → first run registers the service → from then on the service supervisor handles starting Shrok at every login.

## What it does on each OS

| Platform | Supervisor | Identifier | Definition file |
|---|---|---|---|
| macOS | `launchd` | `com.shrok.agent` | `~/Library/LaunchAgents/com.shrok.agent.plist` |
| Linux | `systemd --user` | `shrok.service` | `~/.config/systemd/user/shrok.service` |
| Windows | Task Scheduler | `Shrok` | registered in-memory via `schtasks /create /xml` |

All three point at a small daemon wrapper (`bin/shrok-daemon` on macOS/Linux, `bin/shrok-daemon.vbs` → `bin/shrok-daemon.ps1` on Windows) rather than invoking Node directly. The wrapper does three things before launching the Node process:

1. Rotates `~/.shrok/shrok.log` (or `%USERPROFILE%\.shrok\shrok.log`) if it's over 10 MB. The supervisors don't rotate for us.
2. Loads `$WORKSPACE_PATH/.env` into the process environment.
3. Runs Shrok in a while-loop that watches for a sentinel file at `~/.shrok/.restart-requested`. When Shrok's own restart tool writes that file and exits, the wrapper loops and relaunches — a graceful in-app restart that doesn't show up to the supervisor as a crash.

### macOS — launchd

The plist sets `RunAtLoad=true` so the agent starts at login, and `KeepAlive=true` so launchd relaunches it on crash. `EnvironmentVariables` explicitly sets `PATH` because GUI-launched launchd agents don't inherit the shell's `PATH` — without it, the daemon can't find `node`.

Bootstrapping happens via `launchctl bootstrap gui/<uid>`. At next login the plist's `RunAtLoad` does the rest.

Starts when: the user logs in to the Mac account.

### Linux — systemd user unit

A user-level systemd unit (not system-level). `Type=simple`, `Restart=on-failure`, `RestartSec=5`. Registered with `systemctl --user enable shrok`.

Starts when: the user's systemd session starts. For most people that's at graphical login or first SSH.

There's one gotcha worth knowing: user services **stop when the user logs out**. To make Shrok survive logout and start at boot without anyone logging in, run:

```bash
sudo loginctl enable-linger $USER
```

We don't do this automatically because it requires sudo and changes system-level behavior.

### Windows — Task Scheduler

A task named `Shrok` with a `LogonTrigger` scoped to the current user. `RestartOnFailure` at one-minute intervals for up to 999 retries. `ExecutionTimeLimit=PT0S` so it can run forever.

The task runs `wscript.exe "bin\shrok-daemon.vbs"`. The VBS exists purely to launch `powershell.exe -WindowStyle Hidden` without a visible console — if Task Scheduler ran PowerShell directly, logging in would flash a terminal window.

Starts when: the current Windows user logs in. Not at cold boot before login.

## CLI wrappers

`src/first-boot.ts` also installs a small `shrok` command on your `PATH`. On macOS/Linux it symlinks `~/.local/bin/shrok` at the repo's `bin/shrok` and appends `~/.local/bin` to `~/.zshrc` or `~/.bashrc` if it isn't there. On Windows it copies `bin/shrok.ps1` to `%USERPROFILE%\.local\bin`, drops a `shrok.cmd` shim next to it, and adds that directory to the user's `PATH`.

That's what lets `shrok start`, `shrok doctor`, and the rest work from anywhere. See [command-reference.md](./command-reference.md) for the full list.

## When this matters

- **After a reboot.** Shrok should be running already — if it isn't, the supervisor didn't start it. `shrok status` and `shrok doctor` will tell you why.
- **After a manual kill.** `kill <pid>` or closing the console won't stop Shrok for long — the supervisor will relaunch it within seconds. Use `shrok stop` to stop it for real.
- **After a first-boot registration failure.** The error is logged as `[first-boot] Daemon setup failed (non-fatal): …` in `~/.shrok/shrok.log`. Common causes: running in Docker (skipped on purpose), a system where `systemctl --user` isn't available, or a macOS account where `launchctl bootstrap` is blocked by configuration profiles. In those environments you'll need to start Shrok manually.

## Uninstalling the service

Every platform ships an uninstaller that tears down the service definition, removes the CLI wrapper, and optionally deletes the workspace.

- **macOS / Linux** — `bash ~/shrok/uninstall.sh`. On macOS it runs `launchctl bootout gui/<uid>/com.shrok.agent` and deletes the plist (plus the two legacy labels `com.shrok.shrok` and `local.shrok` from earlier versions). On Linux it does `systemctl --user stop shrok && disable shrok`, deletes `shrok.service`, and runs `daemon-reload`.
- **Windows** — `powershell -File "$env:USERPROFILE\shrok\uninstall.ps1"`. Ends the task, runs `schtasks /delete /tn Shrok /f`, removes the `shrok.ps1` + `shrok.cmd` shims from `~/.local/bin`, and strips that directory from the user `PATH`.

Each uninstaller prompts before deleting `~/.shrok/` (or `%USERPROFILE%\.shrok\`) so your memories, credentials, and conversation history aren't lost by accident.

## Related docs

- [command-reference.md](./command-reference.md) — the `shrok` CLI commands that drive the supervisor
- [architecture.md](./architecture.md) — what the daemon actually runs once it's up
