---
name: sensors
description: How Shrok sensors work — the sensor.mjs JSON-payload contract, the two head-scoped sinks (ambient pull + event push), the mandatory target head, self-watermarking, and creating/editing/scheduling sensors. Read this when creating, editing, scheduling, or reasoning about sensors.
---

## What sensors are

A sensor is a small, model-free script that runs on a schedule and produces a single structured
JSON payload routed to one or both of two head-scoped sinks. It is bound to exactly one head —
the head that owns its `create_schedule` call. Sensors are how Shrok carries live, always-present
situational state — the current weather, calendar, host health, who's home — into reasoning
without anyone having to ask (ambient/pull), and can optionally wake that head when something
noteworthy happens (event/push).

Each sensor's latest ambient output appears in the owning head's prompt under a heading derived
from its slug (`home-status` → `## Home Status`). Other heads never see it.

## The contract

- A sensor is a directory: `$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs`. Resolve
  `$SHROK_WORKSPACE_PATH` via `bash` before using it in file tools.
- **Slug** = the directory name. Lowercase letters, digits, and hyphens only
  (`^[a-z0-9][a-z0-9-]*$`), e.g. `home-status`, `weather`, `disk`.
- The script is run as a **Node ESM process** (`sensor.mjs`) inheriting the daemon's environment
  (so `process.env`, `$SHROK_*`, and workspace files are reachable).
- **Timeout: 30 seconds.** A sensor that hangs is killed.
- **stdout MUST be exactly one JSON object** on a single line:
  `{ "ambient"?: string, "event"?: { "text": string } }`
  Both fields are optional. Emitting neither is a valid quiet/no-op tick (nothing happens on
  either sink). The object may carry only `ambient`, only `event`, or both.
- **Any stdout that is not a parseable JSON object** (malformed JSON, a JSON array, a number, a
  plain string, empty output) is treated as a **sensor error** — the runner overwrites the
  head-scoped ambient file with `⚠ Sensor failed on last run: <reason>` so the failure is
  visible in the head's prompt rather than silently going stale. There is no plain-text
  stdout fallback.
- On a non-zero exit, a thrown error, or a timeout, the same failure marker is written. Fail
  loudly by exiting with code 1 and writing the reason to `stderr`.
- **Output cap:** the `ambient` string is truncated to 2000 bytes before writing. Keep output
  concise — it costs tokens on every turn.

## The two sinks

### Ambient (pull, passive)

The `"ambient"` string is written to `ambient/<headId>/<slug>.md` — a file scoped to the
sensor's bound head. On every head turn (and every sub-agent prompt), Shrok scans that head's
`ambient/<headId>/` directory and injects each file into the **uncached** region of the system
prompt under a heading derived from the slug. Only the owning head sees it; other heads have
their own directories and never receive cross-head ambient output.

A quiet tick that **omits** the `"ambient"` key leaves the existing file stale (it is not
cleared). "Nothing new to say" is different from "forget what I last reported." To explicitly
retract a sensor's ambient block, emit `{ "ambient": "" }` (an empty string writes an empty
file that the scanner skips).

### Event (push, active)

A well-formed `"event": { "text": "..." }` entry enqueues a `sensor_event` for the bound
head's activation loop, which wakes the head and frames the observation:

> Sensor `<slug>` reported: \<text\>

The head then decides whether to surface the observation to the user, take an action, or stay
quiet. Omit the `"event"` key on quiet ticks — sending an event every tick defeats the
passive-ambient design and burns model turns needlessly.

## Target head — mandatory

A sensor is bound to exactly one head: the head that called `create_schedule` to schedule it
(the schedule's `headId`). The event fires to that head, and the ambient file lands under it.
There is no per-tick or per-event head override. One sensor → one head.

## Self-watermarking — no built-in dedup

The runner does **no** deduplication, cooldown, or edge-detection. If you call `create_schedule`
for a weather sensor on a 5-minute cron, the runner fires every 5 minutes regardless of whether
conditions changed. A sensor that should fire an `event` only on a **transition** (new alert,
new value crossing a threshold, new unread message) must manage its own state.

The pattern is: keep a `state.json` (or a timestamp file) inside the sensor's own directory
(`$SHROK_WORKSPACE_PATH/sensors/<slug>/`), read it at the start of each tick, compare to the
current observation, and only emit `event` when something actually changed. Write the new state
before returning.

```js
// sensors/weather/sensor.mjs — watermark example
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state.json')

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8')
}

// … fetch weather …
const state = loadState()
const payload = { ambient: `${temp}°F, ${cond}` }

// Only fire an event if the alert id is new
if (alertId && alertId !== state.lastAlertId) {
  payload.event = { text: `Storm warning issued through 9pm.` }
  saveState({ ...state, lastAlertId: alertId })
}

console.log(JSON.stringify(payload))
```

## Worked example — weather sensor

A weather sensor bound to head `ashley` fires on a 5-minute cron. On a tick where a storm
warning is active:

```json
{ "ambient": "72°F, clear, wind 5mph", "event": { "text": "Storm warning issued for your area through 9pm." } }
```

Ambient sink → `ambient/ashley/weather.md` is overwritten with `72°F, clear, wind 5mph`. On
head `ashley`'s next turn, the system prompt contains `## Weather\n72°F, clear, wind 5mph`.

Event sink → a `sensor_event` is enqueued for head `ashley`. The activation loop wakes Ashley
with: "Sensor `weather` reported: Storm warning issued for your area through 9pm." Ashley
decides whether to notify the user or stay quiet.

A later quiet tick where conditions changed but no new alert is active:

```json
{ "ambient": "68°F, light rain" }
```

The ambient file updates to `68°F, light rain`. No event is fired. The sensor self-watermarks
the last alert id so the storm-warning event does not re-fire every 5 minutes.

## What makes a sensor run

**Creating a sensor never runs it. Scheduling a sensor is what runs it.** Writing (or editing)
`sensor.mjs` only puts the script on disk; no ambient output is produced until a schedule fires
it. So a brand-new sensor's `ambient/<headId>/<slug>.md` stays absent until you schedule it (or
run the script manually to preview).

This is consistent across every path: file tools, dashboard, and `create_schedule` all behave
the same way. Scheduling a sensor on a **cron** sets its first `nextRun` to *now*, so it
produces ambient output on the next scheduler tick (within ~a minute) rather than waiting for
the first cron boundary.

## Creating a sensor

1. **Write the script** with file tools at `$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs`.
   Emit a single JSON object `{ "ambient": "..." }` (and optionally `"event"`) to stdout.
2. **Test it** by running it directly and eyeballing the output:
   `node "$SHROK_WORKSPACE_PATH/sensors/<slug>/sensor.mjs"` — the output must be valid JSON.
3. **Schedule it** — this is what actually makes it run. Use `create_schedule` with `kind:"script"`
   and the slug as `taskName`. The schedule's `headId` (the head you are currently in) becomes
   the sensor's mandatory target head:

   ```
   create_schedule({ taskName: "home-status", kind: "script", cron: "*/15 * * * *" })
   ```

   On a cron, the first run fires almost immediately (`nextRun` is set to now, so ambient output
   appears within ~a minute), then it follows the cron cadence. Allowed cron shapes are the same
   as any schedule: every N minutes (`*/N * * * *`, N ∈ {5,10,15,30,45,60}), hourly
   (`M * * * *`), daily (`M H * * *`), weekdays (`M H * * 1-5`), weekly (`M H * * D`), every N
   days (`0 H */N * *`, N ∈ {1..7}), monthly (`M H D * *`), yearly (`M H D Mo *`).

A sensor with no schedule never runs — pick a cadence that matches how fast the data changes
(frequent for volatile state, hourly/daily for slow-moving data).

## Editing a sensor

Read and edit `sensors/<slug>/sensor.mjs` with file tools. The change takes effect on the
sensor's next scheduled run; to refresh the ambient output immediately for inspection, run the
script with `node` and inspect the JSON output.

## Managing sensors

- **See which sensors are scheduled:** `list_schedules` — sensor schedules have `kind:"script"`
  and `taskName` set to the slug.
- **Change the cadence / pause:** `update_schedule` with the schedule's `id` (set a new `cron`, or
  `enabled:false` to pause).
- **Stop a sensor:** `delete_schedule` with the schedule's `id` (leaves the script in place).
- **Remove it entirely:** delete the `sensors/<slug>/` directory and the
  `ambient/<headId>/<slug>.md` file, and `delete_schedule` its schedule.

The dashboard **Sensors** page is the GUI equivalent for editing the script.

## Best practices

- **Keep output short.** The ambient string is injected into every head turn — keep it to a
  few lines of current state, not a dump. (Hard cap is 2000 bytes; aim well under.)
- **A snapshot, not a log.** Report current state; don't accumulate history.
- **Fail loudly.** On an error, exit non-zero (or throw) with a clear message to stderr so the
  ambient file shows the failure instead of stale data.
- **Be fast.** Finish well under the 30s timeout.
- **No secrets in output.** Whatever the sensor emits ends up in the prompt — keep API keys and
  tokens out of `stdout`.
- **Self-watermark transition events.** Don't emit `event` on every tick — only when something
  genuinely changed. Use `state.json` inside the sensor dir to track the last known state.

## Example

```js
// sensors/disk/sensor.mjs
import { execSync } from 'node:child_process'

try {
  const line = execSync("df -h / | tail -1", { encoding: 'utf8' }).trim().split(/\s+/)
  console.log(JSON.stringify({
    ambient: `Root filesystem: ${line[4]} used (${line[2]} of ${line[1]}, ${line[3]} free)`
  }))
} catch (err) {
  console.error(`could not read disk usage: ${err.message}`)
  process.exit(1)
}
```

Scheduled hourly (`create_schedule({ taskName: "disk", kind: "script", cron: "0 * * * *" })`),
this keeps a one-line disk summary in the owning head's prompt under `## Disk`.
