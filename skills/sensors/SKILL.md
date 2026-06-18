---
name: sensors
description: How Shrok sensors work — the sensor.mjs contract, ambient injection, and creating/editing/scheduling sensors. Read this when creating, editing, scheduling, or reasoning about sensors.
---

## What sensors are

A sensor is a small script that runs on a schedule; its short output is injected into **every**
head and agent system prompt as ambient context. Sensors are how Shrok carries live,
always-present situational state — the current weather, calendar, host health, who's home — into
its reasoning without anyone having to ask.

Each sensor's latest output appears in the prompt under a heading derived from its slug
(`home-status` → `## Home Status`).

## The contract

- A sensor is a directory: `$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs`. Resolve
  `$SHROK_WORKSPACE_PATH` via `bash` before using it in file tools.
- **Slug** = the directory name. Lowercase letters, digits, and hyphens only
  (`^[a-z0-9][a-z0-9-]*$`), e.g. `home-status`, `weather`, `disk`.
- The script is run as a **Node ESM process** (`sensor.mjs`) inheriting the daemon's environment
  (so `process.env`, `$SHROK_*`, and workspace files are reachable).
- **Timeout: 30 seconds.** A sensor that hangs is killed.
- **stdout is the output**, captured and **truncated to 2000 bytes**, written verbatim to
  `ambient/<slug>.md`. That file is what lands in the prompt.
- On a non-zero exit, a thrown error, or a timeout, the ambient file instead gets
  `⚠ Sensor failed on last run: <message>` — so a broken sensor surfaces rather than silently
  going stale.

## What makes a sensor run

**Creating a sensor never runs it. Scheduling a sensor is what runs it.** Writing (or editing)
`sensor.mjs` — whether with file tools, the dashboard Sensors page, or by hand — only puts the
script on disk; no ambient output is produced until a schedule fires it. So a brand-new sensor's
`ambient/<slug>.md` stays empty until you schedule it (or you run the script manually to preview).

This is deliberate and consistent across every path: file tools, dashboard, and the
`create_schedule` tool all behave the same way — the sensor runs when, and only when, a schedule
fires. Scheduling a sensor on a **cron** sets its first `nextRun` to *now*, so it produces ambient
output on the next scheduler tick (within ~a minute) rather than waiting for the first cron
boundary — that's how you get output "right away" after a fresh sensor: schedule it.

## Creating a sensor

1. **Write the script** with file tools at `$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs`.
   Print a concise current snapshot to stdout.
2. **Test it** by running it directly and eyeballing the output:
   `node "$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs"`. (This is the only way to see output
   before it's scheduled — creating the sensor does not run it.)
3. **Schedule it** — this is what actually makes it run. Use `create_schedule` with `kind:"script"`
   and the slug as `taskName`:

   ```
   create_schedule({ taskName: "home-status", kind: "script", cron: "*/15 * * * *" })
   ```

   On a cron, the first run fires almost immediately (`nextRun` is set to now, so ambient output
   appears within ~a minute), then it follows the cron cadence. Allowed cron shapes are the same as any schedule: every N minutes
   (`*/N * * * *`, N ∈ {5,10,15,30,45,60}), hourly (`M * * * *`), daily (`M H * * *`), weekdays
   (`M H * * 1-5`), weekly (`M H * * D`), every N days (`0 H */N * *`, N ∈ {1..7}), monthly
   (`M H D * *`), yearly (`M H D Mo *`).

A sensor with no schedule never runs — pick a cadence that matches how fast the data changes
(frequent for volatile state, hourly/daily for slow-moving data).

## Editing a sensor

Read and edit `sensors/<slug>/sensor.mjs` with file tools. The change takes effect on the sensor's
next scheduled run; to refresh the ambient output immediately for inspection, just run the script
again with `node`.

## Managing sensors

- **See which sensors are scheduled:** `list_schedules` — sensor schedules have `kind:"script"`
  and `taskName` set to the slug.
- **Change the cadence / pause:** `update_schedule` with the schedule's `id` (set a new `cron`, or
  `enabled:false` to pause).
- **Stop a sensor:** `delete_schedule` with the schedule's `id` (leaves the script in place).
- **Remove it entirely:** delete the `sensors/<slug>/` directory and the `ambient/<slug>.md` file,
  and `delete_schedule` its schedule.

The dashboard **Sensors** page is the GUI equivalent for editing the script.

## Best practices

- **Keep output short.** It's injected into *every* prompt, so it costs tokens on every turn. A
  few lines of current state, not a dump. (Hard cap is 2000 bytes; aim well under.)
- **A snapshot, not a log.** Report the current state; don't accumulate history.
- **Fail loudly.** On an error, exit non-zero (or throw) with a clear message to stderr so the
  ambient file shows the failure instead of stale data.
- **Be fast.** Finish well under the 30s timeout; a sensor shouldn't do heavy work on the critical
  path.
- **No secrets in output.** Whatever the sensor prints ends up in the prompt — keep API keys and
  tokens out of stdout.

## Example

```js
// sensors/disk/sensor.mjs
import { execSync } from 'node:child_process'

try {
  const line = execSync("df -h / | tail -1", { encoding: 'utf8' }).trim().split(/\s+/)
  console.log(`Root filesystem: ${line[4]} used (${line[2]} of ${line[1]}, ${line[3]} free)`)
} catch (err) {
  console.error(`could not read disk usage: ${err.message}`)
  process.exit(1)
}
```

Scheduled hourly (`create_schedule({ taskName: "disk", kind: "script", cron: "0 * * * *" })`), this
keeps a one-line disk summary in every prompt under `## Disk`.
