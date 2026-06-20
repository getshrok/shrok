// example-sensor — a worked, runnable example of the sensor contract.
//
// A SENSOR is a small, model-free script that runs ON A SCHEDULE and feeds its
// output into the assistant's context. This file IS the sensor (the script is
// always named `sensor.mjs`). Read it top-to-bottom — the comments are the
// tutorial. Delete this example once you've got the idea, or copy it as a start.
//
// ── The output contract ──────────────────────────────────────────────────────
// The script must print EXACTLY ONE JSON object to stdout, on a single line:
//
//     { "ambient"?: string, "headEvent"?: { "text": string }, "subAgentEvent"?: { "prompt": string } }
//
// All keys are optional. There are three "sinks" you can write to:
//
//   • ambient (PULL / passive): the string is injected into the owning head's
//     prompt EVERY turn, under a heading derived from the sensor's slug
//     (example-sensor → "## Example Sensor"). Use it for current state the
//     assistant should always be able to see. Omitting the key leaves the last
//     value in place; emitting "" (empty string) retracts it.
//
//   • headEvent (PUSH / active): { text } wakes the owning head right away with
//     "Sensor `example-sensor` reported: <text>". Use it ONLY for noteworthy
//     transitions — firing one every tick defeats the passive design and burns
//     model turns. This example fires one only every 5th run, to demonstrate.
//
//   • subAgentEvent (DISPATCH / silent): { prompt } spawns a sub-agent silently
//     with that prompt — no head wake, no user-facing message. The dispatch is
//     gated by the proactive steward (defaults to run). Use for quiet background
//     work (create a reminder, log something). This example fires one every 10th
//     run, to demonstrate. Quick guide:
//       ambient       → always-present snapshot ("what's the current state")
//       headEvent     → wake the head to talk/judge
//       subAgentEvent → get quiet work done without a message
//
// ── Rules to remember ────────────────────────────────────────────────────────
//   • Runs as a Node ESM process. 30-SECOND timeout — be fast.
//   • The `ambient` string is capped at 2000 bytes — keep it short, it costs
//     tokens on every turn. Report a snapshot, not a log.
//   • Anything you print ends up in the prompt — NO secrets/keys in stdout.
//   • Fail loudly: on error, write to stderr and exit non-zero. The runner then
//     shows "⚠ Sensor failed on last run" in the prompt instead of stale data.
//   • Creating/saving a sensor does NOT run it — SCHEDULING is what runs it.
//     Put it on a cadence from the Schedules page (or ask the assistant to
//     `create_schedule({ taskName: "example-sensor", kind: "script", cron: "*/30 * * * *" })`).
//   • The runner does NO dedup. To act only on CHANGE, watermark your own state
//     in a `state.json` beside this file — shown below.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// state.json lives next to this script, inside the sensor's own directory.
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state.json')

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { runs: 0 } }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
}

try {
  const state = loadState()
  const runs = (state.runs ?? 0) + 1
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) // YYYY-MM-DD HH:MM

  // The ambient snapshot — overwrites the head's "## Example Sensor" block each run.
  const payload = {
    ambient: `Example sensor is alive. Last ran ${now} (run #${runs}).`,
  }

  // Self-watermarking demo: only PUSH a headEvent on a transition (here, every
  // 5th run) instead of every tick. A real sensor would compare a fetched value
  // to state — e.g. `if (alertId !== state.lastAlertId) payload.headEvent = {...}`.
  if (runs % 5 === 0) {
    payload.headEvent = { text: `Example sensor has now run ${runs} times.` }
  }

  // subAgentEvent demo: silently dispatch a sub-agent on a separate watermark
  // (every 10th run). No head wake, no message — the agent does the work quietly.
  if (runs % 10 === 0) {
    payload.subAgentEvent = { prompt: `Note in the journal that the example sensor has reached ${runs} runs.` }
  }

  saveState({ ...state, runs, lastRun: now })

  // Exactly one JSON object on stdout — this is the only thing the runner reads.
  console.log(JSON.stringify(payload))
} catch (err) {
  // Fail loudly so the failure shows in the prompt rather than going stale.
  console.error(`example-sensor failed: ${err.message}`)
  process.exit(1)
}
