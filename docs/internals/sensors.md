# Sensors

A **sensor** is a small, model-free script that runs on a schedule and feeds its output
straight into a head's context — no tool call, no agent, no LLM. Sensors are how Shrok carries
live, always-present situational state (the weather, your calendar, host health, who's home)
into reasoning without anyone having to ask, and can optionally wake a head when something
noteworthy happens.

This is the under-the-hood companion to the bundled `sensors` skill (which is the authoritative
contract the assistant reads when it creates or edits a sensor). If you just want the assistant
to set one up, ask it — this doc is for understanding how they work.

## What a sensor is (and isn't)

A sensor is a directory under the workspace containing a single script:

```
~/.shrok/workspace/sensors/<slug>/sensor.mjs
```

- The **slug** is the directory name: lowercase letters, digits, and hyphens only
  (`^[a-z0-9][a-z0-9-]*$`) — e.g. `weather`, `home-status`, `disk`.
- The script is always named **`sensor.mjs`** (the protected marker file, like `TASK.md` is for
  a task) and runs as a **Node ESM process**, inheriting the daemon's environment.
- A sensor is **not** an agent or a task. It doesn't call the model, doesn't get a prompt, and
  can't use tools. It's plain code that runs and prints a result. That's what makes it cheap
  enough to run every few minutes.
- A sensor is bound to **exactly one head** — the head that scheduled it. Its output lands only
  in that head's context; other heads never see it.

## The output contract

The script must print **exactly one JSON object** to stdout, on a single line:

```json
{ "ambient"?: string, "event"?: { "text": string } }
```

Both keys are optional. Emitting neither is a valid quiet/no-op tick. The runtime rules:

| Constraint | Value |
|---|---|
| Runtime | Node ESM process (`node sensor.mjs`) |
| Timeout | **30 seconds** — a sensor that hangs is killed |
| `ambient` output cap | **2000 bytes** (truncated) — it costs tokens every turn, keep it short |
| Anything other than one JSON object on stdout | Treated as a **failure** (see below) |

There is no plain-text fallback: malformed JSON, a JSON array, a bare number/string, or empty
output are all treated as a sensor error. On any error — bad output, a thrown exception, a
non-zero exit, or a timeout — the runner overwrites the head's ambient block with
`⚠ Sensor failed on last run: <reason>` so the failure is **visible in the prompt** instead of
silently going stale. Fail loudly: write the reason to stderr and `process.exit(1)`.

## The two sinks

A sensor's payload is routed to one or both of two head-scoped sinks.

### Ambient — pull, passive

The `"ambient"` string is written to `ambient/<headId>/<slug>.md`. On **every** head turn (and
every sub-agent prompt), Shrok scans that head's ambient directory and injects each file into the
**uncached** region of the system prompt, under a heading derived from the slug
(`home-status` → `## Home Status`). This is the default sink: current state the head should
always be able to see.

- A quiet tick that **omits** the `"ambient"` key leaves the previous value in place — "nothing
  new to say" is not "forget what I said."
- To explicitly retract the block, emit `{ "ambient": "" }`.

### Event — push, active

A well-formed `"event": { "text": "..." }` enqueues a `sensor_event` for the bound head's
activation loop (priority 15), which **wakes the head** and frames it as:

> Sensor `<slug>` reported: \<text\>

The head then decides whether to surface it, act, or stay quiet. Reserve events for genuinely
noteworthy transitions — firing one every tick defeats the passive-ambient design and burns model
turns.

## What makes a sensor run

**Creating or saving a sensor never runs it. Scheduling it is what runs it.** Writing
`sensor.mjs` only puts the script on disk — no ambient output exists until a schedule fires it.
This is consistent across every path (file tools, the dashboard Sensors page, and
`create_schedule`).

Put the sensor on a cadence from the **Schedules** page, or have the assistant do it:

```
create_schedule({ taskName: "<slug>", kind: "script", cron: "*/15 * * * *" })
```

- `kind: "script"` is what distinguishes a sensor schedule from a task (`"task"`) or reminder.
- `taskName` is the sensor's **slug**.
- The schedule's head becomes the sensor's bound head.
- On a cron, the first run fires almost immediately (`nextRun` is set to now), so output appears
  within ~a minute; then it follows the cadence. Allowed cron shapes are the same as any
  schedule (every N minutes where N ∈ {5,10,15,30,45,60}, hourly, daily, weekly, etc.).

Pick a cadence that matches how fast the data changes — frequent for volatile state, hourly/daily
for slow-moving data.

## Self-watermarking — no built-in dedup

The runner does **no** deduplication, cooldown, or edge-detection. A sensor on a 5-minute cron
fires every 5 minutes regardless of whether anything changed. A sensor that should emit an
`event` only on a **transition** (a new alert, a value crossing a threshold, a new unread message)
must track its own state.

The pattern is a `state.json` inside the sensor's own directory: read it at the start of each
tick, compare to the current observation, emit `event` only on a real change, and write the new
state before returning.

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state.json')
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8')

const state = loadState()
const payload = { ambient: `${temp}°F, ${cond}` }
if (alertId && alertId !== state.lastAlertId) {
  payload.event = { text: 'Storm warning issued through 9pm.' }
  saveState({ ...state, lastAlertId: alertId })
}
console.log(JSON.stringify(payload))
```

## A worked example ships with Shrok

A runnable, heavily-commented **`example-sensor`** is seeded into the workspace on first run (the
same way `example-task` is) at `~/.shrok/workspace/sensors/example-sensor/sensor.mjs`. It
demonstrates the JSON contract, an ambient snapshot, and the self-watermarking pattern (it pushes
an `event` only every 5th run). Read it, schedule it to watch it work, then delete it. The
source lives in the repo at [`sensors/example-sensor/`](../../sensors/example-sensor/sensor.mjs).

## Editing and managing sensors

- **Edit:** the dashboard **Sensors** page is the GUI editor; or edit
  `sensors/<slug>/sensor.mjs` (and any helper files) with file tools. Changes take effect on the
  next scheduled run; run the script directly with `node` to preview the JSON.
- **See what's scheduled:** `list_schedules` — sensor schedules have `kind:"script"`.
- **Change cadence / pause:** `update_schedule` (new `cron`, or `enabled:false`).
- **Stop / remove:** `delete_schedule` stops it (leaves the script); delete the
  `sensors/<slug>/` directory and its `ambient/<headId>/<slug>.md` to remove it entirely.

## Best practices

- **Keep output short** — it's injected every turn. Report a snapshot, not a log. (Hard cap is
  2000 bytes; aim well under.)
- **Fail loudly** — exit non-zero with a clear stderr message so the prompt shows the failure
  instead of stale data.
- **Be fast** — finish well under the 30s timeout.
- **No secrets in output** — whatever you print ends up in the prompt.
- **Watermark transition events** — don't emit an `event` every tick; only on a real change.

## Related docs

- [tasks-and-scheduling.md](./tasks-and-scheduling.md) — how scheduling works (sensors use the same scheduler)
- [architecture.md](./architecture.md) — the queue/activation loop the `sensor_event` push feeds into
- [memory.md](./memory.md)
